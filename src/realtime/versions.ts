/**
 * Regla del Tablero: una versión más vieja de un expediente nunca pisa a una más nueva,
 * llegue por el stream o por una respuesta HTTP.
 */
const latest = new Map<string, number>();

/** Devuelve true si `version` es igual o más nueva que la última conocida (y la registra). */
export function acceptVersion(id: string | number, version: unknown): boolean {
  if (typeof version !== "number" || !Number.isFinite(version)) return true;
  const key = String(id);
  const known = latest.get(key);
  if (known !== undefined && version < known) return false;
  latest.set(key, version);
  return true;
}

export function knownVersion(id: string | number): number | undefined {
  return latest.get(String(id));
}
