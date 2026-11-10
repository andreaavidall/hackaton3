import { authFetch } from "../lib/auth";

/**
 * Piso compartido (WebSocket nativo) del CP5.
 *
 * El estado vive fuera de React (FloorClient) y se expone con subscribe(): así los cursores que
 * llegan solo re-renderizan la capa de cursores, no la grilla.
 */

const WS_BASE_URL: string = import.meta.env.VITE_WS_BASE_URL;
const PING_EVERY_MS = 10_000;
const RENEW_EVERY_MS = 5_000;
const CURSOR_MIN_INTERVAL_MS = 100; // 10 por segundo como máximo
const CLAIM_TIMEOUT_MS = 8_000;

export type FloorStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed" // cierre definitivo (ver finalMessage)
  | "unavailable";

export interface Member {
  userId: number | string;
  displayName: string;
}

export interface Claim {
  claimId: string;
  userId: number | string;
  displayName?: string;
  cells: { r: number; c: number }[];
  expiresAt: number; // ms epoch
}

export interface Cursor {
  userId: number | string;
  r: number;
  c: number;
}

export class ClaimDeniedError extends Error {
  constructor(readonly reason: string, readonly holder: string | null) {
    super(
      reason === "HELD"
        ? `Ese grupo lo tiene reservado ${holder ?? "otro refinador"}. Elige otro grupo o espera a que lo libere.`
        : reason === "NOT_A_GROUP"
          ? "Esa celda no pertenece a un grupo que se pueda reservar."
          : `No se pudo reservar el grupo (${reason}).`,
    );
  }
}

const FINAL_CODES: Record<number, string> = {
  4400: "El piso rechazó un mensaje inválido. Recarga la página.",
  4403: "Origen no verificado o sin permiso para el piso compartido.",
  4404: "El archivo no existe en el piso compartido.",
  4423: "El Piso de Pruebas no está abierto: el piso compartido no está disponible.",
};

type Json = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseTime(v: unknown): number {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return Date.now() + 15_000;
}

export function parseCells(v: unknown): { r: number; c: number }[] {
  if (!Array.isArray(v)) return [];
  const out: { r: number; c: number }[] = [];
  for (const item of v) {
    if (Array.isArray(item) && typeof item[0] === "number" && typeof item[1] === "number") {
      out.push({ r: item[0], c: item[1] });
    } else if (item && typeof item === "object") {
      const o = item as Json;
      const r = num(o["r"]) ?? num(o["row"]);
      const c = num(o["c"]) ?? num(o["col"]);
      if (r !== null && c !== null) out.push({ r, c });
    }
  }
  return out;
}

function nameOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Json;
    if (typeof o["displayName"] === "string") return o["displayName"];
    if (typeof o["name"] === "string") return o["name"];
  }
  return null;
}

function parseClaim(o: Json): Claim | null {
  const claimId = o["claimId"] ?? o["id"];
  const userId = o["userId"];
  if ((typeof claimId !== "string" && typeof claimId !== "number") || (typeof userId !== "string" && typeof userId !== "number")) {
    return null;
  }
  const claim: Claim = {
    claimId: String(claimId),
    userId,
    cells: parseCells(o["cells"]),
    expiresAt: parseTime(o["expiresAt"]),
  };
  const dn = nameOf(o["displayName"]) ?? nameOf(o["holder"]);
  if (dn) claim.displayName = dn;
  return claim;
}

interface PendingClaim {
  resolve: (c: Claim) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cell: { r: number; c: number };
}

export class FloorClient {
  readonly fileId: string;
  private readonly myUserId: number | string | null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private consecutive4401 = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private renewTimer: ReturnType<typeof setInterval> | undefined;
  private missedPongs = 0;
  private lastSeq: number | null = null;
  private awaitingSnapshot = false;
  private pending = new Map<string, PendingClaim>();
  private lastCursorSent = 0;
  private cursorTimer: ReturnType<typeof setTimeout> | undefined;
  private queuedCursor: { r: number; c: number } | null = null;
  /** Celda de la reserva propia, para volver a pedirla al reconectar. */
  private wantedClaimCell: { r: number; c: number } | null = null;

  status: FloorStatus = "connecting";
  finalMessage: string | null = null;
  notice: string | null = null;
  members = new Map<string, Member>();
  claims = new Map<string, Claim>();
  cursors = new Map<string, Cursor>();
  myClaimId: string | null = null;

  private stateListeners = new Set<() => void>();
  private cursorListeners = new Set<() => void>();
  private noticeListeners = new Set<(msg: string) => void>();

  constructor(fileId: string, myUserId: number | string | null) {
    this.fileId = fileId;
    this.myUserId = myUserId;
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.onOnline);
    void this.connect();
  }

  // ---------- suscripciones ----------
  subscribe(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
  subscribeCursors(fn: () => void): () => void {
    this.cursorListeners.add(fn);
    return () => this.cursorListeners.delete(fn);
  }
  onNotice(fn: (msg: string) => void): () => void {
    this.noticeListeners.add(fn);
    return () => this.noticeListeners.delete(fn);
  }
  private emit(): void {
    this.stateListeners.forEach((l) => l());
  }
  private emitCursors(): void {
    this.cursorListeners.forEach((l) => l());
  }
  private notify(msg: string): void {
    this.notice = msg;
    this.noticeListeners.forEach((l) => l(msg));
  }
  private setStatus(s: FloorStatus): void {
    this.status = s;
    this.emit();
  }

  isMine(userId: number | string): boolean {
    return this.myUserId !== null && String(userId) === String(this.myUserId);
  }

  /** Celdas reservadas por OTROS usuarios (claves "r,c") con el nombre de quien la tiene. */
  othersClaimedCells(): Map<string, string> {
    const out = new Map<string, string>();
    const now = Date.now();
    for (const claim of this.claims.values()) {
      if (claim.expiresAt < now || this.isMine(claim.userId) || claim.claimId === this.myClaimId) continue;
      const who = claim.displayName ?? this.members.get(String(claim.userId))?.displayName ?? "otro refinador";
      for (const cell of claim.cells) out.set(`${cell.r},${cell.c}`, who);
    }
    return out;
  }

  // ---------- conexión ----------
  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (typeof WebSocket === "undefined") {
      this.setStatus("unavailable");
      return;
    }
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let ticket: string;
    try {
      const res = await authFetch("/floor/tickets", {
        method: "POST",
        body: JSON.stringify({ fileId: Number.isFinite(Number(this.fileId)) ? Number(this.fileId) : this.fileId }),
      });
      if (res.status === 423) {
        this.finish(FINAL_CODES[4423] ?? "Piso cerrado");
        return;
      }
      if (res.status === 403 || res.status === 404) {
        this.finish(res.status === 403 ? (FINAL_CODES[4403] ?? "") : (FINAL_CODES[4404] ?? ""));
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Json;
      const t = json["ticket"] ?? json["id"] ?? json["ticketId"];
      if (typeof t !== "string") throw new Error("Respuesta sin ticket");
      ticket = t;
    } catch {
      this.scheduleReconnect(this.backoff());
      return;
    }
    if (this.stopped) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(`${WS_BASE_URL}/floor/ws?ticket=${encodeURIComponent(ticket)}`);
    } catch {
      this.setStatus("unavailable");
      this.scheduleReconnect(this.backoff());
      return;
    }
    this.ws = ws;
    this.lastSeq = null;
    this.awaitingSnapshot = true;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.missedPongs = 0;
      this.setStatus("open");
      this.startPing();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws || typeof ev.data !== "string") return;
      let msg: Json;
      try {
        msg = JSON.parse(ev.data) as Json;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.onClosed(ev.code, ev.reason);
    };
  }

  private backoff(): number {
    const base = Math.min(30_000, 1000 * 2 ** this.attempt++);
    return base / 2 + Math.random() * (base / 2);
  }

  private scheduleReconnect(ms: number): void {
    if (this.stopped) return;
    this.setStatus("reconnecting");
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), ms);
  }

  private finish(message: string): void {
    this.finalMessage = message;
    this.cleanupSocket();
    this.resetFloorState();
    this.setStatus("closed");
  }

  private cleanupSocket(): void {
    clearInterval(this.pingTimer);
    clearInterval(this.renewTimer);
    this.renewTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        ws.close(1000, "bye");
      } catch {
        /* ya cerrado */
      }
    }
  }

  /** Al cortarse la conexión, las reservas se liberan: no dejamos fantasmas. */
  private resetFloorState(): void {
    this.members.clear();
    this.claims.clear();
    this.cursors.clear();
    this.myClaimId = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Se perdió la conexión con el piso antes de confirmar la reserva."));
    }
    this.pending.clear();
    this.emitCursors();
  }

  private onClosed(code: number, reason: string): void {
    const hadClaim = this.myClaimId !== null;
    this.cleanupSocket();
    this.resetFloorState();
    if (this.stopped) return;
    if (hadClaim) this.notify("Se cortó el piso compartido: tu reserva se liberó. Al reconectar la vuelvo a pedir.");

    const final = FINAL_CODES[code];
    if (final) {
      this.finish(reason ? `${final} (${reason})` : final);
      return;
    }
    if (code === 4401) {
      this.consecutive4401++;
      if (this.consecutive4401 >= 2) {
        this.finish("El piso rechazó el ticket dos veces seguidas. Recarga la página para reintentar.");
        return;
      }
      this.scheduleReconnect(0);
      return;
    }
    this.consecutive4401 = 0;
    if (code === 4408) {
      this.scheduleReconnect(0);
      return;
    }
    if (code === 4429) {
      this.scheduleReconnect(10_000 + Math.random() * 2000);
      return;
    }
    // 1006, 1012, conexión muerta y otros: espera creciente.
    this.scheduleReconnect(this.backoff());
  }

  private startPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.missedPongs >= 2) {
        // Dos pong sin llegar: conexión muerta.
        const ws = this.ws;
        if (ws) {
          ws.onclose = null;
          this.onClosed(1006, "sin pong");
        }
        return;
      }
      this.missedPongs++;
      this.send({ type: "ping", t: Date.now() });
    }, PING_EVERY_MS);
  }

  private send(msg: Json): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  // ---------- mensajes del servidor ----------
  private checkSeq(msg: Json): boolean {
    const seq = num(msg["seq"]);
    if (seq === null) return true;
    if (this.awaitingSnapshot) return false;
    if (this.lastSeq !== null) {
      if (seq <= this.lastSeq) return false; // repetido
      if (seq !== this.lastSeq + 1) {
        // Se perdió algo: reconstruir desde snapshot.
        this.awaitingSnapshot = true;
        this.send({ type: "resync" });
        return false;
      }
    }
    this.lastSeq = seq;
    return true;
  }

  private handle(msg: Json): void {
    const type = msg["type"];
    switch (type) {
      case "pong":
        this.missedPongs = 0;
        return;
      case "snapshot": {
        this.lastSeq = num(msg["seq"]);
        this.awaitingSnapshot = false;
        this.members.clear();
        if (Array.isArray(msg["members"])) {
          for (const m of msg["members"] as Json[]) {
            const userId = m["userId"];
            if (typeof userId !== "string" && typeof userId !== "number") continue;
            this.members.set(String(userId), { userId, displayName: nameOf(m["displayName"]) ?? `Usuario ${userId}` });
          }
        }
        this.claims.clear();
        if (Array.isArray(msg["claims"])) {
          for (const c of msg["claims"] as Json[]) {
            const claim = parseClaim(c);
            if (claim) this.claims.set(claim.claimId, claim);
          }
        }
        // Cursores de quien ya no está: fuera.
        for (const key of [...this.cursors.keys()]) if (!this.members.has(key)) this.cursors.delete(key);
        // Nuestra reserva: si no figura en el snapshot, la perdimos.
        if (this.myClaimId && !this.claims.has(this.myClaimId)) this.myClaimId = null;
        this.emit();
        this.emitCursors();
        // Tras reconectar, volver a pedir la reserva que teníamos.
        if (this.wantedClaimCell && !this.myClaimId && this.pending.size === 0) {
          const cell = this.wantedClaimCell;
          this.claim(cell.r, cell.c).catch((e: unknown) => {
            this.wantedClaimCell = null;
            this.notify(e instanceof Error ? `Al reconectar no pude recuperar tu reserva: ${e.message}` : "Perdiste la reserva.");
          });
        }
        return;
      }
      case "member.joined":
      case "member.left": {
        if (!this.checkSeq(msg)) return;
        const userId = msg["userId"];
        if (typeof userId !== "string" && typeof userId !== "number") return;
        if (type === "member.joined") {
          this.members.set(String(userId), { userId, displayName: nameOf(msg["displayName"]) ?? `Usuario ${userId}` });
        } else {
          this.members.delete(String(userId));
          this.cursors.delete(String(userId));
          this.emitCursors();
        }
        this.emit();
        return;
      }
      case "cursor": {
        const userId = msg["userId"];
        const r = num(msg["r"]);
        const c = num(msg["c"]);
        if ((typeof userId !== "string" && typeof userId !== "number") || r === null || c === null) return;
        if (this.isMine(userId)) return;
        this.cursors.set(String(userId), { userId, r, c });
        this.emitCursors();
        return;
      }
      case "claim.granted": {
        if (!this.checkSeq(msg)) return;
        const requestId = String(msg["requestId"] ?? "");
        const claim = parseClaim({ ...msg, userId: msg["userId"] ?? this.myUserId ?? "me" });
        if (!claim) return;
        // Cada conexión tiene una sola reserva: la anterior se libera sola.
        if (this.myClaimId && this.myClaimId !== claim.claimId) this.claims.delete(this.myClaimId);
        this.claims.set(claim.claimId, claim);
        const p = this.pending.get(requestId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(requestId);
          this.myClaimId = claim.claimId;
          this.wantedClaimCell = p.cell;
          this.startRenew();
          p.resolve(claim);
        }
        this.emit();
        return;
      }
      case "claim.denied": {
        const requestId = String(msg["requestId"] ?? "");
        const p = this.pending.get(requestId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(requestId);
          p.reject(new ClaimDeniedError(String(msg["reason"] ?? "DENIED"), nameOf(msg["holder"])));
        }
        return;
      }
      case "claim.updated":
      case "claim.released": {
        if (!this.checkSeq(msg)) return;
        const claimId = String(msg["claimId"] ?? "");
        if (type === "claim.released") {
          this.claims.delete(claimId);
          if (claimId === this.myClaimId) {
            this.myClaimId = null;
            clearInterval(this.renewTimer);
          }
        } else {
          const claim = parseClaim(msg);
          if (claim) this.claims.set(claim.claimId, claim);
        }
        this.emit();
        return;
      }
      default:
        return;
    }
  }

  // ---------- acciones ----------
  private onVisibility = () => {
    if (document.hidden) {
      clearTimeout(this.cursorTimer);
      this.queuedCursor = null;
    }
  };

  private onOnline = () => {
    if (this.status === "reconnecting") {
      clearTimeout(this.reconnectTimer);
      void this.connect();
    }
  };

  /** Mueve el cursor propio: como máximo 10 mensajes por segundo y nada si la pestaña está oculta. */
  moveCursor(r: number, c: number): void {
    if (document.hidden) return;
    this.queuedCursor = { r, c };
    const elapsed = Date.now() - this.lastCursorSent;
    if (elapsed >= CURSOR_MIN_INTERVAL_MS) {
      this.flushCursor();
    } else if (this.cursorTimer === undefined) {
      this.cursorTimer = setTimeout(() => this.flushCursor(), CURSOR_MIN_INTERVAL_MS - elapsed);
    }
  }

  private flushCursor(): void {
    clearTimeout(this.cursorTimer);
    this.cursorTimer = undefined;
    const cur = this.queuedCursor;
    this.queuedCursor = null;
    if (!cur || document.hidden) return;
    if (this.send({ type: "cursor", r: cur.r, c: cur.c })) this.lastCursorSent = Date.now();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !this.awaitingSnapshot;
  }

  /** Reserva el grupo de la celda. Resuelve con la reserva o rechaza con ClaimDeniedError. */
  claim(r: number, c: number): Promise<Claim> {
    return new Promise<Claim>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      if (!this.send({ type: "claim", requestId, r, c })) {
        reject(new Error("Piso compartido sin conexión"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("El piso no respondió a la reserva."));
      }, CLAIM_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer, cell: { r, c } });
    });
  }

  private startRenew(): void {
    clearInterval(this.renewTimer);
    this.renewTimer = setInterval(() => {
      if (this.myClaimId) this.send({ type: "renew", claimId: this.myClaimId });
    }, RENEW_EVERY_MS);
  }

  release(): void {
    this.wantedClaimCell = null;
    clearInterval(this.renewTimer);
    const id = this.myClaimId;
    if (!id) return;
    this.send({ type: "release", claimId: id });
    this.claims.delete(id);
    this.myClaimId = null;
    this.emit();
  }

  /** Cierra todo al salir de la grilla. */
  close(): void {
    this.release();
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.cursorTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("online", this.onOnline);
    this.cleanupSocket();
    this.resetFloorState();
  }
}
