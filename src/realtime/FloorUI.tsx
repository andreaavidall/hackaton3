import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { FloorClient, type FloorStatus } from "./floor";

/** Abre el WebSocket del piso mientras la grilla está montada; lo cierra al salir. */
export function useFloor(fileId: string, myUserId: string | null): FloorClient | null {
  const [client, setClient] = useState<FloorClient | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!fileId) return;
    const c = new FloorClient(fileId, myUserId);
    setClient(c);
    const unsub = c.subscribe(bump);
    return () => {
      unsub();
      c.close();
      setClient(null);
    };
  }, [fileId, myUserId]);
  return client;
}

function useCursorTick(client: FloorClient | null): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!client) return;
    return client.subscribeCursors(() => setTick((t) => t + 1));
  }, [client]);
  return tick;
}

const STATUS: Record<FloorStatus, { label: string; color: string }> = {
  connecting: { label: "Piso: conectando…", color: "bg-amber-400" },
  open: { label: "Piso: conectado", color: "bg-emerald-400" },
  reconnecting: { label: "Piso: reconectando…", color: "bg-amber-400" },
  closed: { label: "Piso: desconectado", color: "bg-red-500" },
  unavailable: { label: "Piso: no disponible", color: "bg-neutral-500" },
};

const COLORS = ["#f472b6", "#a78bfa", "#fbbf24", "#34d399", "#60a5fa", "#f87171"];
function colorFor(userId: string | number): string {
  const s = String(userId);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length] ?? "#f472b6";
}

interface Bounds {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/**
 * Cursores de los demás sobre las celdas visibles. Es una capa aparte: los cursores que llegan
 * re-renderizan solo esta capa, no la grilla.
 */
export function CursorLayer({ client, bounds, cell }: { client: FloorClient | null; bounds: Bounds; cell: number }) {
  useCursorTick(client);
  if (!client) return null;
  const items = [];
  for (const cur of client.cursors.values()) {
    if (cur.r < bounds.r0 || cur.r >= bounds.r1 || cur.c < bounds.c0 || cur.c >= bounds.c1) continue;
    const name = client.members.get(String(cur.userId))?.displayName ?? `Usuario ${cur.userId}`;
    const color = colorFor(cur.userId);
    items.push(
      <div
        key={String(cur.userId)}
        aria-hidden="true"
        className="pointer-events-none absolute z-20"
        style={{ top: cur.r * cell, left: cur.c * cell, width: cell, height: cell, outline: `2px solid ${color}` }}
      >
        <span className="absolute -top-4 left-0 whitespace-nowrap rounded px-1 text-[10px] text-black" style={{ background: color }}>
          {name}
        </span>
      </div>,
    );
  }
  return <>{items}</>;
}

/** Estado de la conexión, presentes (sin duplicados) y acceso a quien está fuera de la vista. */
export function FloorPanel({
  client,
  bounds,
  onGoTo,
}: {
  client: FloorClient | null;
  bounds: Bounds;
  onGoTo: (r: number, c: number) => void;
}) {
  useCursorTick(client);
  const status = useSyncExternalStore(
    (fn) => client?.subscribe(fn) ?? (() => undefined),
    () => client?.status ?? "connecting",
  );
  if (!client) return null;
  const s = STATUS[status];
  const members = [...client.members.values()];
  return (
    <section aria-labelledby="floor-title" className="space-y-2">
      <h2 id="floor-title" className="font-medium">Piso compartido</h2>
      <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-neutral-300">
        <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${s.color}`} />
        {s.label}
      </p>
      {client.finalMessage && status === "closed" && (
        <p role="alert" className="text-xs text-red-400">
          {client.finalMessage} Puedes seguir refinando sin el piso compartido.
        </p>
      )}
      {status !== "open" && !client.finalMessage && (
        <p className="text-xs text-neutral-500">Mientras tanto puedes seguir refinando con normalidad.</p>
      )}
      {members.length > 0 && (
        <ul className="space-y-1 text-xs">
          {members.map((m) => {
            const mine = client.isMine(m.userId);
            const cur = client.cursors.get(String(m.userId));
            const outside =
              cur && (cur.r < bounds.r0 || cur.r >= bounds.r1 || cur.c < bounds.c0 || cur.c >= bounds.c1);
            return (
              <li key={String(m.userId)} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ background: colorFor(m.userId) }} />
                  {m.displayName}
                  {mine && <span className="text-neutral-500">(tú)</span>}
                </span>
                {!mine && cur && outside && (
                  <button
                    type="button"
                    onClick={() => onGoTo(cur.r, cur.c)}
                    className="text-cyan-400 hover:underline"
                    aria-label={`Ir a la posición de ${m.displayName}, fila ${cur.r}, columna ${cur.c}`}
                  >
                    fuera de vista · ir
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
