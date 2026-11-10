import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ApiError, authFetch, authJson } from "../lib/auth";
import { TileStore } from "../lib/tiles";
import { useAuth } from "../auth/AuthContext";
import { useLumonEvent } from "../realtime/EventsProvider";
import { CursorLayer, FloorPanel, useFloor } from "../realtime/FloorUI";
import { ClaimDeniedError, parseCells } from "../realtime/floor";

type Bin = "WO" | "FC" | "DR" | "MA";
const BINS: Bin[] = ["WO", "FC", "DR", "MA"];
const BIN_LETTER: Record<Bin, string> = { WO: "W", FC: "F", DR: "D", MA: "M" };
const LETTER_COLOR: Record<string, string> = { W: "bg-emerald-900", F: "bg-sky-900", D: "bg-violet-900", M: "bg-rose-900" };

interface Rules {
  tremorThreshold: number;
  connectivity: 4 | 8;
  minGroupSize: number;
  maxGroupSize: number;
  binning: { strategy: "DIGIT_SUM_MOD" | "MAX_DIGIT_MOD"; order: Bin[] };
}

type Progress = Partial<Record<Bin | "overall", number>>;

interface FileDetail {
  id: number | string;
  name?: string;
  rows: number;
  cols: number;
  tileSize: number;
  progress?: Progress;
  status?: string;
}

interface Cell { r: number; c: number }
interface Group { cells: Cell[]; noise: boolean; bin: Bin | null; tiles: Set<string> }

const CELL = 28;
const MAX_SPAN = 48; // 48 x 48 = 2304 celdas como maximo en el DOM

function pctValue(v: number | undefined): number {
  if (typeof v !== "number") return 0;
  return Math.max(0, Math.min(100, v <= 1 ? v * 100 : v));
}

function uuid(): string {
  return crypto.randomUUID();
}

export default function Refine() {
  const { id = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const [file, setFile] = useState<FileDetail | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>({});
  const [, force] = useState(0);
  const store = useMemo(() => new TileStore(id), [id]);
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, w: 800, h: 600 });
  const [focus, setFocus] = useState<Cell>({ r: 0, c: 0 });
  const [group, setGroup] = useState<Group | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const intent = useRef<{ key: string; sig: string } | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const { me } = useAuth();
  const myId = useMemo(() => {
    const o = (me ?? {}) as Record<string, unknown>;
    const u = o["user"] as Record<string, unknown> | undefined;
    const v = u?.["id"] ?? o["id"] ?? o["userId"];
    return typeof v === "number" || typeof v === "string" ? String(v) : null;
  }, [me]);
  // CP5: piso compartido (WebSocket) mientras la grilla esta abierta.
  const floor = useFloor(id, myId);
  const [claimState, setClaimState] = useState<"none" | "pending" | "granted">("none");
  const othersClaimed = floor ? floor.othersClaimedCells() : new Map<string, string>();

  function releaseClaim() {
    floor?.release();
    setClaimState("none");
  }

  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);

  // Carga inicial: detalle + reglas (las reglas cambian por archivo).
  useEffect(() => {
    let alive = true;
    Promise.all([authJson<FileDetail>(`/files/${id}`), authJson<Rules>(`/files/${id}/rules`)])
      .then(([f, r]) => {
        if (!alive) return;
        setFile(f);
        setRules(r);
        setProgress(f.progress ?? {});
      })
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : "Error al cargar"));
    return () => {
      alive = false;
    };
  }, [id]);

  // CP5: eventos en tiempo real sobre este archivo.
  useLumonEvent((ev) => {
    const evFile = ev.data["fileId"] ?? (ev.data["file"] as Record<string, unknown> | undefined)?.["id"];
    if (ev.type === "stream.reset") {
      store.clear();
      authJson<FileDetail>(`/files/${id}`)
        .then((f) => {
          setFile(f);
          setProgress(f.progress ?? {});
        })
        .catch(() => undefined);
      return;
    }
    if (evFile === undefined || String(evFile) !== id) return;
    if (ev.type === "refinement.created") {
      const bin = ev.data["bin"];
      const letter = typeof bin === "string" ? (BIN_LETTER[bin as Bin] ?? bin.charAt(0).toUpperCase()) : null;
      if (letter) {
        for (const cell of parseCells(ev.data["cells"])) {
          const tile = store.get(Math.floor(cell.r / ts), Math.floor(cell.c / ts));
          if (tile) tile.bins[(cell.r - tile.originRow) * tile.cols + (cell.c - tile.originCol)] = letter;
        }
      }
      const p = (ev.data["progress"] ?? (ev.data["file"] as Record<string, unknown> | undefined)?.["progress"]) as Progress | undefined;
      if (p && typeof p === "object") setProgress(p);
      force((n) => n + 1);
    } else if (ev.type === "file.completed") {
      setProgress((p) => ({ ...p, overall: 100 }));
    }
  });

  // Posicion inicial desde ?r=&c=.
  useEffect(() => {
    if (!file || !viewport.current) return;
    const r = Math.min(file.rows - 1, Math.max(0, Number(sp.get("r") ?? 0) || 0));
    const c = Math.min(file.cols - 1, Math.max(0, Number(sp.get("c") ?? 0) || 0));
    viewport.current.scrollTop = r * CELL;
    viewport.current.scrollLeft = c * CELL;
    setFocus({ r, c });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const onScroll = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    setView({ top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight });
  }, []);

  useEffect(() => {
    onScroll();
    window.addEventListener("resize", onScroll);
    return () => window.removeEventListener("resize", onScroll);
  }, [onScroll, file]);

  // La URL indica la posicion, sin llenar el historial (replace + debounce).
  useEffect(() => {
    const t = setTimeout(() => {
      const r = String(Math.floor(view.top / CELL));
      const c = String(Math.floor(view.left / CELL));
      if (sp.get("r") !== r || sp.get("c") !== c) {
        const next = new URLSearchParams(sp);
        next.set("r", r);
        next.set("c", c);
        setSp(next, { replace: true });
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.top, view.left]);

  const rows = file?.rows ?? 0;
  const cols = file?.cols ?? 0;
  const ts = file?.tileSize ?? 32;
  const r0 = Math.max(0, Math.floor(view.top / CELL) - 1);
  const c0 = Math.max(0, Math.floor(view.left / CELL) - 1);
  const r1 = Math.min(rows, r0 + Math.min(MAX_SPAN, Math.ceil(view.h / CELL) + 3));
  const c1 = Math.min(cols, c0 + Math.min(MAX_SPAN, Math.ceil(view.w / CELL) + 3));

  // Pedir solo los bloques visibles y cancelar los que salieron de la vista.
  useEffect(() => {
    if (!file) return;
    const needed = new Set<string>();
    for (let tr = Math.floor(r0 / ts); tr <= Math.floor((r1 - 1) / ts); tr++) {
      for (let tc = Math.floor(c0 / ts); tc <= Math.floor((c1 - 1) / ts); tc++) {
        needed.add(TileStore.key(tr, tc));
        store.load(tr, tc).catch(() => undefined);
      }
    }
    store.retain(needed);
  }, [file, store, r0, r1, c0, c1, ts]);

  const cellAt = useCallback(
    (r: number, c: number) => {
      const tile = store.get(Math.floor(r / ts), Math.floor(c / ts));
      if (!tile) return null;
      const i = (r - tile.originRow) * tile.cols + (c - tile.originCol);
      return { digit: Number(tile.values[i]), tremor: tile.tremor[i] ?? 0, bin: tile.bins[i] ?? "." };
    },
    [store, ts],
  );

  const isScary = useCallback(
    (cell: { tremor: number; bin: string } | null) => !!cell && !!rules && cell.bin === "." && cell.tremor >= rules.tremorThreshold,
    [rules],
  );

  // Seleccionar el grupo completo (BFS), pidiendo los bloques que falten.
  async function selectGroup(start: Cell) {
    if (!rules || !file || selecting) return;
    releaseClaim();
    const holderAtStart = othersClaimed.get(`${start.r},${start.c}`);
    if (holderAtStart) {
      setGroup(null);
      setMessage({ kind: "error", text: `Ese grupo lo tiene reservado ${holderAtStart}. Elige otro grupo o espera a que lo libere.` });
      return;
    }
    const first = cellAt(start.r, start.c);
    if (first && !isScary(first)) {
      setGroup(null);
      return;
    }
    setSelecting(true);
    setMessage(null);
    try {
      const seen = new Set<string>([`${start.r},${start.c}`]);
      const queue: Cell[] = [start];
      const cells: Cell[] = [];
      const tiles = new Set<string>();
      let sum = 0;
      let max = 0;
      const dirs = rules.connectivity === 8
        ? [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]
        : [[-1, 0], [1, 0], [0, -1], [0, 1]];
      while (queue.length) {
        const cur = queue.shift() as Cell;
        const tr = Math.floor(cur.r / ts);
        const tc = Math.floor(cur.c / ts);
        tiles.add(TileStore.key(tr, tc));
        await store.load(tr, tc, true);
        const cell = cellAt(cur.r, cur.c);
        if (!isScary(cell) || !cell) continue;
        cells.push(cur);
        sum += cell.digit;
        max = Math.max(max, cell.digit);
        for (const [dr, dc] of dirs) {
          const nr = cur.r + (dr ?? 0);
          const nc = cur.c + (dc ?? 0);
          if (nr < 0 || nc < 0 || nr >= file.rows || nc >= file.cols) continue;
          const k = `${nr},${nc}`;
          if (seen.has(k)) continue;
          seen.add(k);
          queue.push({ r: nr, c: nc });
        }
      }
      if (cells.length === 0) {
        setGroup(null);
        return;
      }
      const noise = cells.length < rules.minGroupSize || cells.length > rules.maxGroupSize;
      const idx = (rules.binning.strategy === "MAX_DIGIT_MOD" ? max : sum) % 4;
      const bin = noise ? null : (rules.binning.order[idx] ?? null);
      const taken = cells.map((cl) => othersClaimed.get(`${cl.r},${cl.c}`)).find(Boolean);
      if (taken) {
        setGroup(null);
        setMessage({ kind: "error", text: `Ese grupo lo tiene reservado ${taken}. Elige otro grupo o espera a que lo libere.` });
        return;
      }
      setGroup({ cells, noise, bin, tiles });
      intent.current = null;
      // Antes de llevarlo a una caja, se reserva en el piso compartido.
      if (!noise && floor?.connected) {
        setClaimState("pending");
        floor
          .claim(start.r, start.c)
          .then(() => setClaimState("granted"))
          .catch((e: unknown) => {
            setClaimState("none");
            if (e instanceof ClaimDeniedError) {
              setGroup(null);
              setMessage({ kind: "error", text: e.message });
            } else {
              // Sin respuesta del piso: se puede refinar igual (el backend responde 409 si otro lo tiene).
              setMessage({ kind: "error", text: `${e instanceof Error ? e.message : "No se pudo reservar"} Puedes refinar igual.` });
            }
          });
      }
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : "No se pudo leer el grupo" });
    } finally {
      setSelecting(false);
    }
  }

  // Refinar: una Idempotency-Key por intencion; los reintentos reusan la misma key.
  async function refine(bin: Bin) {
    if (!group || group.noise || busy || claimState === "pending") return;
    const body = JSON.stringify({ bin, cells: group.cells });
    if (!intent.current || intent.current.sig !== body) intent.current = { key: uuid(), sig: body };
    const key = intent.current.key;
    setBusy(true);
    setMessage(null);
    try {
      let attempt = 0;
      for (;;) {
        let res: Response;
        try {
          res = await authFetch(`/files/${id}/refinements`, {
            method: "POST",
            headers: { "Idempotency-Key": key },
            body,
          });
        } catch {
          if (attempt++ < 4) {
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
            continue;
          }
          throw new Error("Sin conexión. Intenta de nuevo.");
        }
        if ((res.status === 503 || res.status === 429) && attempt < 5) {
          attempt++;
          const ra = Number(res.headers.get("Retry-After") ?? "0") * 1000;
          await new Promise((r) => setTimeout(r, Math.max(ra, 500 * 2 ** attempt)));
          continue;
        }
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.ok) {
          for (const cell of group.cells) {
            const tile = store.get(Math.floor(cell.r / ts), Math.floor(cell.c / ts));
            if (tile) tile.bins[(cell.r - tile.originRow) * tile.cols + (cell.c - tile.originCol)] = BIN_LETTER[bin];
          }
          const p = (json.progress ?? (json.file as Record<string, unknown> | undefined)?.progress) as Progress | undefined;
          if (p) setProgress(p);
          setGroup(null);
          releaseClaim();
          intent.current = null;
          setMessage({ kind: "ok", text: `Grupo de ${group.cells.length} celdas llevado a ${bin}.` });
          force((n) => n + 1);
          return;
        }
        const code = typeof json.error === "string" ? json.error : `HTTP_${res.status}`;
        const details = json.details as Record<string, unknown> | null | undefined;
        if (res.status === 409) {
          store.invalidate(group.tiles);
          setGroup(null);
          releaseClaim();
          intent.current = null;
          const holder = details?.holder as { displayName?: string } | undefined;
          setMessage({
            kind: "error",
            text: code === "GROUP_CLAIMED"
              ? `Ese grupo lo tiene reservado ${holder?.displayName ?? "otro refinador"}. Elige otro.`
              : "Algunas celdas ya estaban refinadas. Recargué esos bloques: vuelve a seleccionar el grupo.",
          });
          return;
        }
        if (res.status === 422) {
          intent.current = null;
          const reason = typeof details?.reason === "string" ? details.reason : "";
          setMessage({
            kind: "error",
            text: code === "WRONG_BIN" ? `Caja incorrecta. Según las reglas va en ${group.bin ?? "otra caja"}.` : `No se pudo refinar: ${reason || (json.message as string) || code}.`,
          });
          return;
        }
        throw new ApiError(res.status, { error: code, message: (json.message as string) ?? code, details: details ?? null });
      }
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : "Error al refinar" });
    } finally {
      setBusy(false);
    }
  }

  // Teclado: flechas, PageUp/PageDown, Home/End, Enter para seleccionar.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!file) return;
    const page = Math.max(1, Math.floor(view.h / CELL) - 1);
    let { r, c } = focus;
    switch (e.key) {
      case "ArrowUp": r--; break;
      case "ArrowDown": r++; break;
      case "ArrowLeft": c--; break;
      case "ArrowRight": c++; break;
      case "PageUp": r -= page; break;
      case "PageDown": r += page; break;
      case "Home": if (e.ctrlKey) r = 0; c = 0; break;
      case "End": if (e.ctrlKey) r = file.rows - 1; c = file.cols - 1; break;
      case "Enter":
      case " ":
        e.preventDefault();
        void selectGroup(focus);
        return;
      default: {
        const n = Number(e.key);
        if (n >= 1 && n <= 4 && group) {
          e.preventDefault();
          void refine(BINS[n - 1] as Bin);
        }
        return;
      }
    }
    e.preventDefault();
    r = Math.max(0, Math.min(file.rows - 1, r));
    c = Math.max(0, Math.min(file.cols - 1, c));
    setFocus({ r, c });
    const el = viewport.current;
    if (el) {
      if (r * CELL < el.scrollTop) el.scrollTop = r * CELL;
      if ((r + 1) * CELL > el.scrollTop + el.clientHeight) el.scrollTop = (r + 1) * CELL - el.clientHeight;
      if (c * CELL < el.scrollLeft) el.scrollLeft = c * CELL;
      if ((c + 1) * CELL > el.scrollLeft + el.clientWidth) el.scrollLeft = (c + 1) * CELL - el.clientWidth;
    }
  }

  // CP5: el cursor propio es la celda con foco (throttle de 10/s dentro de FloorClient).
  useEffect(() => {
    floor?.moveCursor(focus.r, focus.c);
  }, [floor, focus.r, focus.c]);

  function goTo(r: number, c: number) {
    const el = viewport.current;
    if (!el) return;
    el.scrollTop = Math.max(0, r * CELL - el.clientHeight / 2);
    el.scrollLeft = Math.max(0, c * CELL - el.clientWidth / 2);
    setFocus({ r, c });
  }

  // Foco real del DOM en la celda activa (siempre esta renderizada).
  useEffect(() => {
    const el = document.getElementById(`cell-${focus.r}-${focus.c}`);
    if (el && viewport.current?.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [focus, r0, c0]);

  // Arrastrar el grupo a una caja con Pointer Events.
  function onPointerDownGroup(e: RPointerEvent) {
    if (!group || group.noise) return;
    e.preventDefault();
    setDrag({ x: e.clientX, y: e.clientY });
    const move = (ev: PointerEvent) => setDrag({ x: ev.clientX, y: ev.clientY });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-bin]");
      const bin = target?.getAttribute("data-bin") as Bin | null;
      if (bin) void refine(bin);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const selected = useMemo(() => new Set(group?.cells.map((c) => `${c.r},${c.c}`) ?? []), [group]);

  if (loadError) {
    return (
      <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100">
        <p role="alert" className="text-red-400">{loadError}</p>
        <Link to="/files" className="mt-4 inline-block text-cyan-400 hover:underline">← Archivos</Link>
      </main>
    );
  }
  if (!file || !rules) {
    return <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-400">Cargando archivo…</main>;
  }

  if (pctValue(progress.overall) >= 100 || file.status === "COMPLETED") {
    return (
      <main className="min-h-dvh bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
        <div className="text-center">
          <h1 className="text-3xl font-semibold">Archivo completado</h1>
          <p className="mt-3 text-neutral-400">{file.name ?? `Archivo ${file.id}`} quedó refinado al 100 %. El trabajo es misterioso e importante.</p>
          <Link to="/files" className="mt-6 inline-block text-cyan-400 hover:underline">← Volver a los archivos</Link>
        </div>
      </main>
    );
  }

  const rowEls = [];
  for (let r = r0; r < r1; r++) {
    const cells = [];
    for (let c = c0; c < c1; c++) {
      const cell = cellAt(r, c);
      const scary = isScary(cell);
      const sel = selected.has(`${r},${c}`);
      const isFocus = focus.r === r && focus.c === c;
      const heldBy = othersClaimed.get(`${r},${c}`);
      const amp = cell && scary ? Math.max(0.5, (cell.tremor / 100) * 2.5) : 0;
      cells.push(
        <div
          key={c}
          id={`cell-${r}-${c}`}
          role="gridcell"
          aria-colindex={c + 1}
          aria-selected={sel}
          title={heldBy ? `Reservado por ${heldBy}` : undefined}
          aria-label={heldBy && cell ? `${cell.digit}, reservado por ${heldBy}` : undefined}
          tabIndex={isFocus ? 0 : -1}
          onClick={() => {
            setFocus({ r, c });
            void selectGroup({ r, c });
          }}
          onPointerDown={sel ? onPointerDownGroup : undefined}
          style={{ left: (c - c0) * CELL, width: CELL, height: CELL, ["--amp" as string]: `${amp}px` }}
          className={`absolute flex items-center justify-center font-mono text-sm select-none ${
            !cell ? "bg-neutral-900 text-transparent" : cell.bin !== "." ? `${LETTER_COLOR[cell.bin] ?? ""} text-neutral-400` : "text-neutral-300"
          } ${scary ? "tremble font-bold text-amber-300 underline decoration-dotted" : ""} ${sel ? "bg-cyan-700 text-white cursor-grab" : ""} ${
            isFocus ? "outline outline-2 outline-cyan-400 z-10" : ""
          } ${heldBy ? "bg-rose-950 text-rose-300 line-through" : ""}`}
        >
          {cell ? cell.digit : "·"}
        </div>,
      );
    }
    rowEls.push(
      <div key={r} role="row" aria-rowindex={r + 1} className="absolute" style={{ top: r * CELL, left: c0 * CELL, height: CELL }}>
        {cells}
      </div>,
    );
  }

  return (
    <main className="flex h-dvh flex-col bg-neutral-950 text-neutral-100">
      <header className="flex flex-wrap items-center gap-4 border-b border-neutral-800 p-3 text-sm">
        <Link to="/files" className="text-cyan-400 hover:underline">← Archivos</Link>
        <h1 className="font-semibold">{file.name ?? `Archivo ${file.id}`}</h1>
        <span className="text-neutral-500">{file.rows}×{file.cols} · umbral {rules.tremorThreshold} · conectividad {rules.connectivity}</span>
        <span className="ml-auto text-neutral-400">Progreso total {Math.round(pctValue(progress.overall))}%</span>
      </header>

      <div className="flex min-h-0 flex-1">
        <div
          ref={viewport}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          role="grid"
          aria-label="Grilla del archivo"
          aria-rowcount={file.rows}
          aria-colcount={file.cols}
          className="relative min-w-0 flex-1 overflow-auto"
        >
          <div style={{ height: file.rows * CELL, width: file.cols * CELL }} className="relative">
            {rowEls}
            <CursorLayer client={floor} bounds={{ r0, r1, c0, c1 }} cell={CELL} />
          </div>
        </div>

        <aside className="w-64 shrink-0 space-y-4 overflow-auto border-l border-neutral-800 p-4 text-sm">
          <section aria-live="polite">
            <h2 className="font-medium">Grupo</h2>
            {selecting && <p className="text-neutral-400">Leyendo grupo…</p>}
            {!selecting && !group && <p className="text-neutral-500">Elige una celda que da miedo (clic o Enter).</p>}
            {group && (
              <p className="mt-1">
                {group.cells.length} celdas ·{" "}
                {group.noise ? <strong className="text-amber-400">ruido (no se puede refinar)</strong> : <>caja <strong className="text-cyan-400">{group.bin}</strong></>}
              </p>
            )}
            {group && !group.noise && <p className="mt-1 text-xs text-neutral-500">Arrastra el grupo a una caja, o usa las teclas 1 a 4.</p>}
            {group && !group.noise && claimState === "pending" && <p className="mt-1 text-xs text-amber-300">Reservando el grupo…</p>}
            {group && !group.noise && claimState === "granted" && <p className="mt-1 text-xs text-emerald-400">Grupo reservado para ti.</p>}
            {group && (
              <button
                type="button"
                onClick={() => {
                  setGroup(null);
                  releaseClaim();
                }}
                className="mt-2 text-xs text-neutral-400 underline hover:text-neutral-200"
              >
                Cancelar selección
              </button>
            )}
          </section>

          <section className="space-y-2">
            {BINS.map((b, i) => (
              <button
                key={b}
                type="button"
                data-bin={b}
                disabled={!group || group.noise || busy || claimState === "pending"}
                onClick={() => void refine(b)}
                className={`block w-full rounded border px-3 py-2 text-left disabled:opacity-60 ${drag ? "border-cyan-400" : "border-neutral-700"}`}
              >
                <span className="flex justify-between"><span>{i + 1}. {b}</span><span>{Math.round(pctValue(progress[b]))}%</span></span>
                <span className="mt-1 block h-1.5 rounded bg-neutral-800" role="progressbar" aria-label={`Progreso ${b}`} aria-valuenow={Math.round(pctValue(progress[b]))} aria-valuemin={0} aria-valuemax={100}>
                  <span className="block h-full rounded bg-cyan-500" style={{ width: `${pctValue(progress[b])}%` }} />
                </span>
              </button>
            ))}
            {busy && <p className="text-neutral-400">Refinando…</p>}
          </section>

          <FloorPanel client={floor} bounds={{ r0, r1, c0, c1 }} onGoTo={goTo} />

          {message && (
            <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "text-red-400" : "text-emerald-400"}>
              {message.text}
            </p>
          )}
        </aside>
      </div>

      {drag && group && (
        <div className="pointer-events-none fixed z-50 rounded bg-cyan-600 px-2 py-1 text-xs" style={{ left: drag.x + 8, top: drag.y + 8 }}>
          {group.cells.length} celdas
        </div>
      )}
    </main>
  );
}
