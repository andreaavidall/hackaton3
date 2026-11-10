import { authFetch } from "./auth";

export interface RawTile {
  tileRow: number;
  tileCol: number;
  originRow: number;
  originCol: number;
  rows: number;
  cols: number;
  values: string;
  tremor: string;
  bins: string;
  version: number;
}

export interface Tile {
  originRow: number;
  originCol: number;
  rows: number;
  cols: number;
  values: string;
  tremor: Uint8Array;
  bins: string[];
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toTile(raw: RawTile): Tile {
  return {
    originRow: raw.originRow,
    originCol: raw.originCol,
    rows: raw.rows,
    cols: raw.cols,
    values: raw.values,
    tremor: decodeBase64(raw.tremor),
    bins: raw.bins.split(""),
  };
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

interface Inflight {
  promise: Promise<Tile>;
  controller: AbortController;
  pinned: boolean;
}

/**
 * Cache de bloques: pide solo los que hacen falta, nunca dos requests en vuelo para el
 * mismo bloque, cancela los que salieron de la vista, respeta 429 Retry-After y reintenta 503.
 */
export class TileStore {
  private tiles = new Map<string, Tile>();
  private inflight = new Map<string, Inflight>();
  private pausedUntil = 0;
  private listeners = new Set<() => void>();
  readonly fileId: string;

  constructor(fileId: string) {
    this.fileId = fileId;
  }

  static key(tr: number, tc: number): string {
    return `${tr},${tc}`;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  get(tr: number, tc: number): Tile | undefined {
    return this.tiles.get(TileStore.key(tr, tc));
  }

  /** Olvida todos los bloques (p. ej. tras stream.reset) para volver a pedirlos. */
  clear(): void {
    this.tiles.clear();
    this.emit();
  }

  invalidate(keys: Iterable<string>): void {
    for (const k of keys) this.tiles.delete(k);
    this.emit();
  }

  /** Pide un bloque (o reutiliza el que esta en vuelo). pinned = no se cancela por scroll. */
  load(tr: number, tc: number, pinned = false): Promise<Tile> {
    const key = TileStore.key(tr, tc);
    const cached = this.tiles.get(key);
    if (cached) return Promise.resolve(cached);
    const existing = this.inflight.get(key);
    if (existing) {
      if (pinned) existing.pinned = true;
      return existing.promise;
    }
    const controller = new AbortController();
    const entry: Inflight = { controller, pinned, promise: Promise.resolve(null as unknown as Tile) };
    entry.promise = this.fetchWithRetry(tr, tc, controller.signal)
      .then((tile) => {
        this.tiles.set(key, tile);
        this.emit();
        return tile;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, entry);
    return entry.promise;
  }

  /** Cancela los bloques en vuelo que ya no se necesitan. */
  retain(needed: Set<string>): void {
    for (const [key, entry] of this.inflight) {
      if (!needed.has(key) && !entry.pinned) entry.controller.abort();
    }
  }

  private async fetchWithRetry(tr: number, tc: number, signal: AbortSignal): Promise<Tile> {
    let attempt = 0;
    for (;;) {
      const wait = this.pausedUntil - Date.now();
      if (wait > 0) await sleep(wait);
      if (signal.aborted) throw new DOMException("Cancelado", "AbortError");
      const res = await authFetch(`/files/${this.fileId}/tiles/${tr}/${tc}`, { signal });
      if (res.ok) return toTile((await res.json()) as RawTile);
      const retryAfter = Number(res.headers.get("Retry-After") ?? "0");
      if (res.status === 429) {
        this.pausedUntil = Date.now() + Math.max(1, retryAfter) * 1000;
        continue;
      }
      if (res.status === 503 && attempt < 6) {
        attempt++;
        const backoff = Math.max(retryAfter * 1000, Math.min(500 * 2 ** attempt, 15000));
        await sleep(backoff);
        continue;
      }
      throw new Error(`No se pudo cargar el bloque ${tr},${tc} (HTTP ${res.status})`);
    }
  }
}
