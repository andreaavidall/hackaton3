import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type PointerEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { authFetch } from "../lib/auth";
import { canvasToWebp, errorText, loadImage, sha256Hex, type Processed } from "../lib/media";
import UploadSlot from "../components/UploadSlot";
import { badgeOf, refinerName, type Refiner } from "./Refiners";

const FRAME = 320; // tamano del recorte en pantalla
const OUT = 512; // BADGE: exactamente 512 x 512

export default function BadgeEditor() {
  const { id = "" } = useParams();
  const [refiner, setRefiner] = useState<Refiner | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [processed, setProcessed] = useState<Processed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingMedia, setPendingMedia] = useState<string | null>(null);
  const dragStart = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadRefiner = useCallback(async () => {
    const res = await authFetch(`/refiners/${id}`);
    if (!res.ok) throw new Error(`No se pudo cargar el expediente (HTTP ${res.status})`);
    setEtag(res.headers.get("ETag"));
    setRefiner((await res.json()) as Refiner);
  }, [id]);

  useEffect(() => {
    loadRefiner().catch((e: unknown) => setError(errorText(e)));
  }, [loadRefiner]);

  // Escala base: la imagen cubre el cuadro entero.
  const base = img ? FRAME / Math.min(img.naturalWidth, img.naturalHeight) : 1;
  const scale = base * zoom;

  const clamp = useCallback(
    (x: number, y: number) => {
      if (!img) return { x: 0, y: 0 };
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      return { x: Math.min(0, Math.max(FRAME - w, x)), y: Math.min(0, Math.max(FRAME - h, y)) };
    },
    [img, scale],
  );

  useEffect(() => setOffset((o) => clamp(o.x, o.y)), [clamp]);

  async function pick(file: File | null | undefined) {
    if (!file) return;
    setError(null);
    setProcessed(null);
    try {
      if (!file.type.startsWith("image/")) throw new Error("Elige un archivo de imagen.");
      const image = await loadImage(file);
      const b = FRAME / Math.min(image.naturalWidth, image.naturalHeight);
      setImg(image);
      setZoom(1);
      setOffset({ x: (FRAME - image.naturalWidth * b) / 2, y: (FRAME - image.naturalHeight * b) / 2 });
    } catch (e) {
      setError(errorText(e));
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    void pick(e.dataTransfer.files[0]);
  }
  function onPaste(e: ClipboardEvent) {
    const item = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
    if (item) void pick(item);
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = dragStart.current;
    if (!d) return;
    setOffset(clamp(d.ox + e.clientX - d.x, d.oy + e.clientY - d.y));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 20 : 5;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      setOffset((o) => clamp(o.x + m[0], o.y + m[1]));
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      setZoom((z) => Math.min(4, z + 0.1));
    } else if (e.key === "-") {
      e.preventDefault();
      setZoom((z) => Math.max(1, z - 0.1));
    }
  }

  async function generate() {
    if (!img) return;
    setError(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = OUT;
      canvas.height = OUT;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas no disponible");
      const k = OUT / FRAME;
      ctx.drawImage(img, offset.x * k, offset.y * k, img.naturalWidth * scale * k, img.naturalHeight * scale * k);
      // Re-codificar en canvas elimina EXIF/XMP/ubicacion.
      const blob = await canvasToWebp(canvas, 120 * 1024);
      setProcessed({ blob, width: OUT, height: OUT, sha256: await sha256Hex(blob) });
    } catch (e) {
      setError(errorText(e));
    }
  }

  const onUploaded = useCallback(
    async (mediaId: string) => {
      setBusy(true);
      setStatus("Actualizando el expediente…");
      try {
        // Regla de Milchick: PATCH con If-Match exacto; ante 412 se avisa y se relee.
        const res = await authFetch(`/refiners/${id}`, {
          method: "PATCH",
          headers: etag ? { "If-Match": etag } : {},
          body: JSON.stringify({ badgeMediaId: mediaId }),
        });
        if (res.status === 412) {
          setEtag(res.headers.get("ETag"));
          await loadRefiner();
          setStatus(null);
          setError("Alguien cambió el expediente mientras editabas. Ya cargué la versión nueva: aprieta “Asignar de nuevo”.");
          setPendingMedia(mediaId);
          return;
        }
        if (!res.ok) throw new Error(`No se pudo asignar el fotocheck (HTTP ${res.status})`);
        setEtag(res.headers.get("ETag"));
        setRefiner((await res.json()) as Refiner);
        setPendingMedia(null);
        setStatus("Fotocheck actualizado.");
      } catch (e) {
        setStatus(null);
        setError(errorText(e));
        setPendingMedia(mediaId);
      } finally {
        setBusy(false);
      }
    },
    [etag, id, loadRefiner],
  );
  const badge = refiner ? badgeOf(refiner) : null;

  return (
    <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100" onPaste={onPaste}>
      <div className="mx-auto max-w-3xl">
        <Link to="/refiners" className="text-sm text-cyan-400 hover:underline">← Expedientes</Link>
        <h1 className="mt-2 text-2xl font-semibold">Fotocheck {refiner ? `de ${refinerName(refiner)}` : ""}</h1>

        <div className="mt-4 flex items-center gap-4">
          {badge ? (
            <img src={badge} alt="Fotocheck actual" width={96} height={96} className="h-24 w-24 rounded object-cover" />
          ) : (
            <div aria-hidden="true" className="flex h-24 w-24 items-center justify-center rounded bg-neutral-800 text-neutral-500">?</div>
          )}
          <p className="text-sm text-neutral-400">Elige, arrastra o pega (Ctrl+V) una imagen. Recorte cuadrado 512×512, WebP, máx. 120 KB.</p>
        </div>

        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              onPointerDown={img ? onPointerDown : undefined}
              onPointerMove={img ? onPointerMove : undefined}
              onPointerUp={() => (dragStart.current = null)}
              onKeyDown={img ? onKeyDown : undefined}
              tabIndex={0}
              role={img ? "application" : "button"}
              aria-label={img ? "Recorte: flechas para mover, + y - para zoom" : "Zona para soltar una imagen"}
              onClick={img ? undefined : () => fileInput.current?.click()}
              style={{ width: FRAME, height: FRAME }}
              className="relative overflow-hidden rounded border-2 border-dashed border-neutral-700 bg-neutral-900 touch-none focus:border-cyan-400 focus:outline-none"
            >
              {img ? (
                <img
                  src={img.src}
                  alt="Imagen a recortar"
                  draggable={false}
                  className="pointer-events-none absolute max-w-none select-none"
                  style={{ left: offset.x, top: offset.y, width: img.naturalWidth * scale, height: img.naturalHeight * scale }}
                />
              ) : (
                <span className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500">Suelta una imagen aquí</span>
              )}
            </div>
            <input ref={fileInput} type="file" accept="image/*" onChange={(e) => void pick(e.target.files?.[0])} className="mt-3 block text-sm" aria-label="Elegir imagen" />
            {img && (
              <label className="mt-3 block text-sm">
                <span className="text-neutral-400">Zoom</span>
                <input type="range" min={1} max={4} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="ml-3 align-middle" />
              </label>
            )}
            <button type="button" disabled={!img} onClick={() => void generate()} className="mt-3 rounded bg-cyan-500 px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50">
              Generar fotocheck
            </button>
          </div>

          <div className="space-y-3">
            {processed && (
              <>
                <img src={URL.createObjectURL(processed.blob)} alt="Vista previa del fotocheck" width={160} height={160} className="h-40 w-40 rounded" />
                <p className="text-xs text-neutral-500">{Math.round(processed.blob.size / 1024)} KB · 512×512 · WebP</p>
                <UploadSlot key={processed.sha256} purpose="BADGE" processed={processed} label="Fotocheck" onDone={(m) => void onUploaded(m)} />
              </>
            )}
            {pendingMedia && !busy && (
              <button type="button" onClick={() => void onUploaded(pendingMedia)} className="rounded border border-neutral-700 px-3 py-1 text-sm hover:border-cyan-400">
                Asignar de nuevo
              </button>
            )}
            {status && <p role="status" className="text-sm text-emerald-400">{status}</p>}
            {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
          </div>
        </div>
      </div>
    </main>
  );
}
