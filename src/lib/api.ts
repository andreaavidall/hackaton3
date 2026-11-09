/** SHA del commit con el que se construyo la app. Inyectado por Vite. */
export const BUILD_SHA: string = __BUILD_SHA__;

const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL;

/**
 * Toda request a Lumon lleva X-Lumon-Build, incluidas las de login.
 * Desde un origen que no es localhost, sin esta cabecera responde 400 BUILD_HEADER_REQUIRED.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Lumon-Build", BUILD_SHA);
  return fetch(`${API_BASE_URL}${path}`, { ...init, headers });
}

export type HealthStatus = "checking" | "ok" | "down";
