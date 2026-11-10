import { authFetch, clearSession } from "../lib/auth";

/**
 * Stream de eventos (SSE) del CP5.
 *
 * - Una sola conexión por navegador: la pestaña "líder" (elegida con Web Locks) abre el stream y
 *   reparte cada evento a las demás por BroadcastChannel. Si la líder se cierra, el lock queda libre
 *   y otra pestaña lo toma y reconecta.
 * - El stream se autentica con un ticket de un solo uso (POST /events/tickets), nunca con el token.
 * - Se lee con fetch + ReadableStream (no EventSource) para ver los heartbeats y detectar una
 *   conexión muerta (45 s sin datos).
 * - Reconexión con espera creciente y lastEventId. Los eventos repetidos se descartan por id.
 */

const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL;
const LOCK_NAME = "lumon-events-leader";
const DEAD_AFTER_MS = 45_000;
const MAX_BACKOFF_MS = 30_000;

export type StreamStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "locked" // Piso de Pruebas sin abrir (423)
  | "superseded"
  | "offline";

export interface LumonEvent {
  id: number | null;
  type: string;
  data: Record<string, unknown>;
}

type EventListener = (ev: LumonEvent) => void;
type StatusListener = (s: StreamStatus) => void;

type ChannelMsg =
  | { kind: "event"; ev: LumonEvent }
  | { kind: "status"; status: StreamStatus }
  | { kind: "hello" }
  | { kind: "local"; ev: LumonEvent };

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("lumon-events") : null;

const eventListeners = new Set<EventListener>();
const statusListeners = new Set<StatusListener>();
let status: StreamStatus = "idle";
let isLeader = false;

/** Ids ya entregados (por si un evento llega dos veces, o por dos caminos). */
const seenIds = new Set<number>();
const seenOrder: number[] = [];

function markSeen(id: number): boolean {
  if (seenIds.has(id)) return false;
  seenIds.add(id);
  seenOrder.push(id);
  if (seenOrder.length > 500) {
    const old = seenOrder.shift();
    if (old !== undefined) seenIds.delete(old);
  }
  return true;
}

function setStatus(s: StreamStatus, broadcast = true): void {
  if (status === s) return;
  status = s;
  statusListeners.forEach((l) => l(s));
  if (broadcast && isLeader) channel?.postMessage({ kind: "status", status: s } satisfies ChannelMsg);
}

function deliver(ev: LumonEvent): void {
  if (ev.id !== null && !markSeen(ev.id)) return;
  eventListeners.forEach((l) => {
    try {
      l(ev);
    } catch (e) {
      console.error("Error en un listener de eventos", e);
    }
  });
}

channel?.addEventListener("message", (msg: MessageEvent) => {
  const data = msg.data as ChannelMsg;
  if (data.kind === "event" || data.kind === "local") deliver(data.ev);
  else if (data.kind === "status" && !isLeader) setStatus(data.status, false);
  else if (data.kind === "hello" && isLeader) channel?.postMessage({ kind: "status", status } satisfies ChannelMsg);
});

export function getStreamStatus(): StreamStatus {
  return status;
}

export function onStreamStatus(fn: StatusListener): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

export function onLumonEvent(fn: EventListener): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

/** Avisa a todas las pestañas (incluida esta) de un evento local, p. ej. una contingencia confirmada. */
export function broadcastLocal(type: string, data: Record<string, unknown>): void {
  const ev: LumonEvent = { id: null, type, data };
  channel?.postMessage({ kind: "local", ev } satisfies ChannelMsg);
  deliver(ev);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

function backoff(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

function pickTicket(json: Record<string, unknown>): string | null {
  for (const k of ["ticket", "id", "ticketId"]) {
    const v = json[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

class TicketError extends Error {
  constructor(readonly httpStatus: number, readonly retryAfterMs: number) {
    super(`No se pudo pedir el ticket (HTTP ${httpStatus})`);
  }
}

async function requestTicket(signal: AbortSignal): Promise<string> {
  const res = await authFetch("/events/tickets", { method: "POST", signal });
  if (!res.ok) {
    const ra = Number(res.headers.get("Retry-After") ?? "0") * 1000;
    throw new TicketError(res.status, ra);
  }
  const ticket = pickTicket((await res.json()) as Record<string, unknown>);
  if (!ticket) throw new TicketError(500, 0);
  return ticket;
}

let lastEventId: number | null = null;

/** Lee un stream SSE y llama a onEvent por cada evento. Resuelve cuando el stream termina. */
async function readStream(
  res: Response,
  signal: AbortSignal,
  onEvent: (ev: LumonEvent) => void,
  onAlive: () => void,
): Promise<void> {
  if (!res.body) throw new Error("Stream sin cuerpo");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let evType = "message";
  let evData: string[] = [];
  let evId: string | null = null;

  const dispatch = () => {
    if (evData.length === 0 && evId === null) {
      evType = "message";
      return;
    }
    const raw = evData.join("\n");
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
    } catch {
      data = { raw };
    }
    const type = evType !== "message" ? evType : typeof data["type"] === "string" ? (data["type"] as string) : "message";
    const idNum = evId !== null && evId !== "" ? Number(evId) : NaN;
    onEvent({ id: Number.isFinite(idNum) ? idNum : null, type, data });
    evType = "message";
    evData = [];
    evId = null;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      onAlive();
      buffer += value;
      let nl: number;
      while ((nl = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
        if (line === "") {
          dispatch();
          continue;
        }
        if (line.startsWith(":")) continue; // heartbeat / comentario
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let val = colon < 0 ? "" : line.slice(colon + 1);
        if (val.startsWith(" ")) val = val.slice(1);
        if (field === "event") evType = val;
        else if (field === "data") evData.push(val);
        else if (field === "id") evId = val;
      }
    }
  } finally {
    if (signal.aborted) reader.cancel().catch(() => undefined);
  }
}

/** Bucle de conexión de la pestaña líder. */
async function runLeader(signal: AbortSignal): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setStatus("offline");
      await sleep(3000, signal);
      continue;
    }
    setStatus(attempt === 0 ? "connecting" : "reconnecting");
    let wait = 0;
    const conn = new AbortController();
    const abortConn = () => conn.abort();
    signal.addEventListener("abort", abortConn);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => conn.abort(), DEAD_AFTER_MS);
    };
    try {
      const ticket = await requestTicket(conn.signal);
      const qs = new URLSearchParams({ ticket });
      if (lastEventId !== null) qs.set("lastEventId", String(lastEventId));
      alive();
      const res = await fetch(`${API_BASE_URL}/events/stream?${qs.toString()}`, {
        headers: { Accept: "text/event-stream" },
        signal: conn.signal,
        cache: "no-store",
      });
      if (!res.ok) throw new TicketError(res.status, Number(res.headers.get("Retry-After") ?? "0") * 1000);
      setStatus("open");
      attempt = 0;
      let superseded = false;
      await readStream(
        res,
        conn.signal,
        (ev) => {
          if (ev.id !== null) lastEventId = Math.max(lastEventId ?? 0, ev.id);
          if (ev.type === "stream.superseded") {
            superseded = true;
            return;
          }
          if (ev.type === "session.revoked") {
            channel?.postMessage({ kind: "event", ev } satisfies ChannelMsg);
            deliver(ev);
            clearSession("SESSION_REVOKED");
            return;
          }
          channel?.postMessage({ kind: "event", ev } satisfies ChannelMsg);
          deliver(ev);
        },
        alive,
      );
      if (superseded) {
        setStatus("superseded");
        wait = 15_000;
      } else {
        // El backend cierra a propósito cada tanto: reconectar rápido.
        wait = 500;
      }
    } catch (e) {
      if (signal.aborted) break;
      if (e instanceof TicketError) {
        if (e.httpStatus === 423) {
          setStatus("locked");
          wait = 30_000;
        } else if (e.httpStatus === 401) {
          // La sesión terminó (authFetch ya intentó el refresh).
          wait = backoff(attempt++);
          setStatus("reconnecting");
        } else {
          wait = Math.max(e.retryAfterMs, backoff(attempt++));
          setStatus("reconnecting");
        }
      } else {
        wait = backoff(attempt++);
        setStatus("reconnecting");
      }
    } finally {
      clearTimeout(watchdog);
      signal.removeEventListener("abort", abortConn);
      conn.abort();
    }
    if (wait > 0) await sleep(wait, signal);
  }
}

/**
 * Arranca el stream para esta pestaña. Devuelve la función que lo detiene (al cerrar sesión).
 */
export function startEventStream(): () => void {
  const stop = new AbortController();
  channel?.postMessage({ kind: "hello" } satisfies ChannelMsg);
  if (status === "idle") setStatus("connecting", false);

  const lead = async () => {
    isLeader = true;
    try {
      await runLeader(stop.signal);
    } finally {
      isLeader = false;
    }
  };

  if (typeof navigator !== "undefined" && "locks" in navigator) {
    navigator.locks
      .request(LOCK_NAME, { signal: stop.signal }, () => lead())
      .catch(() => undefined);
  } else {
    void lead();
  }

  return () => {
    stop.abort();
    setStatus("idle", false);
  };
}
