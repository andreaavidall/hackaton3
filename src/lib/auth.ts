import { BUILD_SHA } from "./api";

const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL;
const RT_KEY = "lumon.refreshToken";
const LOCK_NAME = "lumon-refresh";

export interface ApiErrorBody {
  error: string;
  message: string;
  details: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.code = body.error;
    this.details = body.details;
  }
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type RevokeReason = "REFRESH_REUSED" | "SESSION_REVOKED" | "TOKEN_INVALID" | "LOGOUT";

type Listener = (reason: RevokeReason | null) => void;

// El access token vive SOLO en memoria.
let accessToken: string | null = null;
const listeners = new Set<Listener>();
const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("lumon-auth") : null;

function readRefresh(): string | null {
  try {
    return localStorage.getItem(RT_KEY);
  } catch {
    return null;
  }
}

function writeRefresh(rt: string | null): void {
  try {
    if (rt) localStorage.setItem(RT_KEY, rt);
    else localStorage.removeItem(RT_KEY);
  } catch {
    /* almacenamiento no disponible */
  }
}

export function hasStoredSession(): boolean {
  return readRefresh() !== null;
}

export function setSession(tokens: SessionTokens): void {
  accessToken = tokens.accessToken;
  writeRefresh(tokens.refreshToken);
  channel?.postMessage({ type: "tokens", accessToken: tokens.accessToken });
}

function notify(reason: RevokeReason | null): void {
  listeners.forEach((l) => l(reason));
}

/** Limpia la sesion local y avisa a la app (y a las otras pestanas). */
export function clearSession(reason: RevokeReason, broadcast = true): void {
  accessToken = null;
  writeRefresh(null);
  if (broadcast) channel?.postMessage({ type: "logout", reason });
  notify(reason);
}

export function onSessionEnd(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Sincronizacion entre pestanas.
channel?.addEventListener("message", (ev: MessageEvent) => {
  const data = ev.data as { type?: string; accessToken?: string; reason?: RevokeReason };
  if (data.type === "tokens" && data.accessToken) accessToken = data.accessToken;
  if (data.type === "logout") {
    accessToken = null;
    notify(data.reason ?? "LOGOUT");
  }
});
window.addEventListener("storage", (ev) => {
  if (ev.key === RT_KEY && ev.newValue === null && accessToken !== null) {
    accessToken = null;
    notify("LOGOUT");
  }
});

async function parseError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody = { error: `HTTP_${res.status}`, message: res.statusText, details: null };
  try {
    const json = (await res.json()) as Partial<ApiErrorBody>;
    if (typeof json.error === "string") {
      body = { error: json.error, message: json.message ?? "", details: json.details ?? null };
    }
  } catch {
    /* sin cuerpo JSON */
  }
  return new ApiError(res.status, body);
}

function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Lumon-Build", BUILD_SHA);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${API_BASE_URL}${path}`, { ...init, headers });
}

async function doRefresh(): Promise<void> {
  const rt = readRefresh();
  if (!rt) throw new ApiError(401, { error: "SESSION_REVOKED", message: "Sin sesion", details: null });
  const res = await rawFetch("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: rt }),
  });
  if (!res.ok) throw await parseError(res);
  setSession((await res.json()) as SessionTokens);
}

let inflight: Promise<void> | null = null;

/**
 * Refresh coordinado: un solo POST /auth/refresh por pestana a la vez, y
 * serializado entre pestanas con Web Locks para que nunca se reuse un refresh token.
 */
export function refreshSession(tokenBefore: string | null = accessToken): Promise<void> {
  if (inflight) return inflight;
  const run = async (): Promise<void> => {
    // Si otra pestana ya refresco mientras esperabamos el lock, usamos su token.
    if (accessToken && accessToken !== tokenBefore) return;
    await doRefresh();
  };
  const locked: Promise<void> =
    typeof navigator !== "undefined" && "locks" in navigator
      ? (navigator.locks.request(LOCK_NAME, run) as Promise<void>)
      : run();
  inflight = locked
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        const reason: RevokeReason =
          err.code === "REFRESH_REUSED" ? "REFRESH_REUSED" : "SESSION_REVOKED";
        clearSession(reason);
      }
      throw err;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** fetch autenticado: agrega Bearer y reintenta UNA vez tras TOKEN_EXPIRED. */
export async function authFetch(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const headers = new Headers(init.headers);
  const used = accessToken;
  if (used) headers.set("Authorization", `Bearer ${used}`);
  const res = await rawFetch(path, { ...init, headers });
  if (res.status !== 401) return res;
  const err = await parseError(res.clone());
  if (err.code === "TOKEN_EXPIRED" && !retried) {
    // Si ya hay un token nuevo (otra request refresco), solo reintentamos.
    if (accessToken === used) await refreshSession(used);
    return authFetch(path, init, true);
  }
  if (err.code === "SESSION_REVOKED" || err.code === "TOKEN_INVALID" || err.code === "REFRESH_REUSED") {
    clearSession(err.code);
  }
  return res;
}

export async function authJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authFetch(path, init);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export async function publicJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await rawFetch(path, init);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export async function logoutRequest(): Promise<void> {
  const rt = readRefresh();
  try {
    await authFetch("/auth/logout", {
      method: "POST",
      body: JSON.stringify({ refreshToken: rt }),
    });
  } catch {
    /* aunque falle la red, cerramos la sesion local */
  }
  clearSession("LOGOUT");
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await rawFetch("/meta/health");
    return res.ok;
  } catch {
    return false;
  }
}
