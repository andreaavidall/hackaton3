import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { authJson } from "../lib/auth";
import { errorText, processIncident, type Processed } from "../lib/media";
import UploadSlot from "../components/UploadSlot";

interface Incident {
  id: number | string;
  title?: string;
  description?: string;
  createdAt?: string;
  photos?: Array<{ url?: string } | string>;
  media?: Array<{ url?: string } | string>;
}

function photoUrls(i: Incident): string[] {
  return (i.photos ?? i.media ?? []).map((p) => (typeof p === "string" ? p : (p.url ?? ""))).filter(Boolean);
}

export function IncidentsList() {
  const [items, setItems] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    authJson<unknown>("/incidents")
      .then((d) => {
        const obj = d as Record<string, unknown>;
        setItems((Array.isArray(d) ? d : (obj.items ?? obj.data ?? obj.incidents ?? [])) as Incident[]);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  return (
    <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Incidencias</h1>
          <Link to="/incidents/new" className="rounded bg-cyan-500 px-3 py-1.5 text-sm font-medium text-neutral-950">Nuevo reporte</Link>
        </div>
        {error && <p role="alert" className="mt-4 text-red-400">{error}</p>}
        {!items && !error && <p className="mt-4 text-neutral-400">Cargando…</p>}
        {items?.length === 0 && <p className="mt-4 text-neutral-500">Sin reportes.</p>}
        <ul className="mt-6 space-y-4">
          {items?.map((i) => (
            <li key={i.id} className="rounded border border-neutral-800 p-4">
              <p className="font-medium break-words">{i.title ?? `Reporte ${i.id}`}</p>
              {i.description && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-neutral-400">{i.description}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {photoUrls(i).map((u) => (
                  <img key={u} src={u} alt="Foto de la incidencia" width={120} height={90} loading="lazy" decoding="async" className="h-[90px] w-[120px] rounded object-cover" />
                ))}
              </div>
            </li>
          ))}
        </ul>
        <Link to="/" className="mt-6 inline-block text-sm text-cyan-400 hover:underline">← Inicio</Link>
      </div>
    </main>
  );
}

interface Photo {
  key: string;
  processed: Processed;
  mediaId: string | null;
  preview: string;
}

export function IncidentNew() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function addFiles(files: FileList | null) {
    if (!files) return;
    setError(null);
    const room = 3 - photos.length;
    for (const file of Array.from(files).slice(0, room)) {
      try {
        const processed = await processIncident(file);
        setPhotos((p) => [...p, { key: crypto.randomUUID(), processed, mediaId: null, preview: URL.createObjectURL(processed.blob) }]);
      } catch (e) {
        setError(errorText(e));
      }
    }
  }

  const markDone = useCallback((key: string, mediaId: string) => {
    setPhotos((p) => p.map((ph) => (ph.key === key ? { ...ph, mediaId } : ph)));
  }, []);

  const allConfirmed = photos.length >= 1 && photos.every((p) => p.mediaId);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!allConfirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await authJson<unknown>("/incidents", {
        method: "POST",
        body: JSON.stringify({ title, description, mediaIds: photos.map((p) => p.mediaId) }),
      });
      setSent(true);
    } catch (err) {
      // El error no borra el formulario ni las fotos ya confirmadas.
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100">
        <p role="status" className="text-emerald-400">Reporte enviado.</p>
        <Link to="/incidents" className="mt-4 inline-block text-cyan-400 hover:underline">Ver incidencias</Link>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100">
      <form onSubmit={onSubmit} className="mx-auto max-w-2xl space-y-4">
        <Link to="/incidents" className="text-sm text-cyan-400 hover:underline">← Incidencias</Link>
        <h1 className="text-2xl font-semibold">Nuevo reporte de incidencia</h1>
        <label className="block">
          <span className="text-sm text-neutral-300">Título</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2" />
        </label>
        <label className="block">
          <span className="text-sm text-neutral-300">Descripción</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2" />
        </label>
        <label className="block text-sm">
          <span className="text-neutral-300">Fotos (1 a 3)</span>
          <input type="file" accept="image/*" multiple disabled={photos.length >= 3} onChange={(e) => void addFiles(e.target.files)} className="mt-1 block" />
        </label>
        <div className="space-y-3">
          {photos.map((p, i) => (
            <div key={p.key} className="flex gap-3">
              <img src={p.preview} alt={`Foto ${i + 1}`} width={96} height={72} className="h-[72px] w-24 rounded object-cover" />
              <div className="flex-1">
                <UploadSlot purpose="INCIDENT" processed={p.processed} label={`Foto ${i + 1}`} autoStart onDone={(m) => markDone(p.key, m)} />
                {!p.mediaId && (
                  <button type="button" onClick={() => setPhotos((ps) => ps.filter((x) => x.key !== p.key))} className="mt-1 text-xs text-neutral-400 hover:text-red-400">
                    Quitar
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <button type="submit" disabled={!allConfirmed || busy || !title.trim()} className="rounded bg-cyan-500 px-4 py-2 font-medium text-neutral-950 disabled:opacity-50">
          {busy ? "Enviando…" : allConfirmed ? "Enviar reporte" : "Esperando que se confirmen las fotos…"}
        </button>
      </form>
    </main>
  );
}
