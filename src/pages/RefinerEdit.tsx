import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { authFetch } from "../lib/auth";
import { useLumonEvent } from "../realtime/EventsProvider";
import { acceptVersion } from "../realtime/versions";

/**
 * CP5 · Regla de Milchick: nunca se sobrescribe lo que no se ha leído.
 * GET devuelve ETag; PATCH manda If-Match con ese valor exacto. Ante 412 se muestra el conflicto
 * campo por campo y el usuario elige antes de reintentar con el ETag nuevo.
 */

type Primitive = string | number | boolean | null;
type Record_ = Record<string, unknown>;

const NOT_EDITABLE = new Set([
  "id",
  "version",
  "createdAt",
  "updatedAt",
  "badgeMediaId",
  "badgeUrl",
  "badge",
  "teamCode",
  "etag",
]);

function isPrimitive(v: unknown): v is Primitive {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function editableKeys(data: Record_): string[] {
  return Object.keys(data).filter((k) => !NOT_EDITABLE.has(k) && isPrimitive(data[k]));
}

function same(a: unknown, b: unknown): boolean {
  return a === b || (a == null && b == null);
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(vacío)";
  return String(v);
}

async function errorText(res: Response): Promise<{ code: string; message: string; details: Record_ | null }> {
  try {
    const body = (await res.json()) as { error?: string; message?: string; details?: Record_ | null };
    return { code: body.error ?? `HTTP_${res.status}`, message: body.message ?? "", details: body.details ?? null };
  } catch {
    return { code: `HTTP_${res.status}`, message: res.statusText, details: null };
  }
}

interface Conflict {
  server: Record_;
  etag: string | null;
  choice: Record<string, "mine" | "server">;
}

export default function RefinerEdit() {
  const { id = "" } = useParams();
  const [original, setOriginal] = useState<Record_ | null>(null);
  const [draft, setDraft] = useState<Record_>({});
  const [etag, setEtag] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [remoteChange, setRemoteChange] = useState<number | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  const fetchCurrent = useCallback(async (): Promise<{ data: Record_; etag: string | null }> => {
    const res = await authFetch(`/refiners/${encodeURIComponent(id)}`);
    if (!res.ok) {
      const e = await errorText(res);
      throw new Error(e.code === "CLEARANCE_REQUIRED" ? "El Piso de Pruebas todavía no está abierto." : e.message || e.code);
    }
    const data = (await res.json()) as Record_;
    return { data, etag: res.headers.get("ETag") };
  }, [id]);

  useEffect(() => {
    let alive = true;
    fetchCurrent()
      .then(({ data, etag: tag }) => {
        if (!alive) return;
        acceptVersion(id, data["version"]);
        setOriginal(data);
        setDraft(data);
        setEtag(tag);
      })
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : "No se pudo cargar"));
    return () => {
      alive = false;
    };
  }, [fetchCurrent, id]);

  // Si alguien cambia este expediente mientras se edita, avisar antes de guardar.
  useLumonEvent((ev) => {
    if (ev.type === "stream.reset" && original) {
      setRemoteChange((v) => v ?? -1);
      return;
    }
    if (ev.type !== "refiner.updated") return;
    const evId = ev.data["id"] ?? ev.data["refinerId"];
    if (String(evId) !== id) return;
    const v = ev.data["version"];
    if (!acceptVersion(id, v)) return; // evento viejo: no pisa nada
    if (typeof v === "number" && typeof original?.["version"] === "number" && v <= original["version"]) return;
    setRemoteChange(typeof v === "number" ? v : -1);
  });

  const keys = original ? editableKeys(original) : [];
  const dirtyKeys = original ? keys.filter((k) => !same(draft[k], original[k])) : [];

  function openConflict(server: Record_, serverEtag: string | null) {
    const choice: Record<string, "mine" | "server"> = {};
    for (const k of editableKeys(server)) {
      if (!same(draft[k], server[k])) choice[k] = dirtyKeys.includes(k) ? "mine" : "server";
    }
    setConflict({ server, etag: serverEtag, choice });
  }

  async function reviewRemoteNow() {
    try {
      const { data, etag: tag } = await fetchCurrent();
      if (!acceptVersion(id, data["version"])) return;
      openConflict(data, tag);
      setRemoteChange(null);
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : "No se pudo leer la versión actual" });
    }
  }

  async function save(body: Record_, ifMatch: string | null, base: Record_) {
    if (!ifMatch) {
      setMessage({ kind: "error", text: "No tengo el ETag del expediente: recarga la página antes de guardar." });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await authFetch(`/refiners/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "If-Match": ifMatch },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        let data: Record_ = { ...base, ...body };
        try {
          data = (await res.json()) as Record_;
        } catch {
          /* sin cuerpo */
        }
        acceptVersion(id, data["version"]);
        setOriginal(data);
        setDraft(data);
        setEtag(res.headers.get("ETag") ?? null);
        setRemoteChange(null);
        setConflict(null);
        setMessage({ kind: "ok", text: "Expediente guardado." });
        if (!res.headers.get("ETag")) {
          // Sin ETag en la respuesta: lo leemos de nuevo para el próximo guardado.
          fetchCurrent()
            .then(({ data: d, etag: t }) => {
              if (acceptVersion(id, d["version"])) {
                setOriginal(d);
                setEtag(t);
              }
            })
            .catch(() => undefined);
        }
        return;
      }
      const err = await errorText(res);
      if (res.status === 412) {
        const current = (err.details?.["current"] as Record_ | undefined) ?? null;
        const newTag = res.headers.get("ETag");
        if (current && newTag) {
          openConflict(current, newTag);
        } else {
          const fresh = await fetchCurrent();
          openConflict(fresh.data, fresh.etag);
        }
        setMessage({ kind: "error", text: "Alguien cambió este expediente desde que lo abriste. Revisa las diferencias." });
        return;
      }
      if (res.status === 428) {
        setMessage({ kind: "error", text: "Falta If-Match: recarga el expediente e intenta de nuevo." });
        return;
      }
      setMessage({ kind: "error", text: err.message || err.code });
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : "Error de red al guardar" });
    } finally {
      setSaving(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!original || dirtyKeys.length === 0) return;
    if (remoteChange !== null) {
      void reviewRemoteNow();
      return;
    }
    const body: Record_ = {};
    for (const k of dirtyKeys) body[k] = draft[k];
    void save(body, etag, original);
  }

  function resolveConflict() {
    if (!conflict) return;
    const merged: Record_ = { ...conflict.server };
    const body: Record_ = {};
    for (const [k, pick] of Object.entries(conflict.choice)) {
      if (pick === "mine") {
        merged[k] = draft[k];
        body[k] = draft[k];
      }
    }
    setOriginal(conflict.server);
    setDraft(merged);
    setEtag(conflict.etag);
    if (Object.keys(body).length === 0) {
      setConflict(null);
      setMessage({ kind: "ok", text: "Te quedaste con la versión del servidor. No había nada que guardar." });
      return;
    }
    void save(body, conflict.etag, conflict.server);
  }

  if (loadError) {
    return (
      <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100">
        <p role="alert" className="text-red-400">{loadError}</p>
        <Link to="/" className="mt-4 inline-block text-cyan-400 hover:underline">← Inicio</Link>
      </main>
    );
  }
  if (!original) return <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-400">Cargando expediente…</main>;

  if (conflict) {
    const conflictKeys = Object.keys(conflict.choice);
    return (
      <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-2xl font-semibold text-amber-300">Conflicto de versiones</h1>
          <p className="mt-2 text-neutral-400">
            Alguien guardó cambios en este expediente mientras lo editabas. Elige, campo por campo, qué valor se queda.
            Nada se sobrescribe hasta que confirmes.
          </p>
          {conflictKeys.length === 0 ? (
            <p className="mt-6 text-neutral-300">Tus valores coinciden con los del servidor.</p>
          ) : (
            <table className="mt-6 w-full border-collapse text-sm">
              <caption className="sr-only">Diferencias entre tu edición y el servidor</caption>
              <thead>
                <tr className="border-b border-neutral-800 text-left text-neutral-400">
                  <th scope="col" className="py-2 pr-3">Campo</th>
                  <th scope="col" className="py-2 pr-3">Lo que escribiste</th>
                  <th scope="col" className="py-2">Lo que hay ahora</th>
                </tr>
              </thead>
              <tbody>
                {conflictKeys.map((k) => (
                  <tr key={k} className="border-b border-neutral-900 align-top">
                    <th scope="row" className="py-3 pr-3 text-left font-mono text-xs text-neutral-400">{k}</th>
                    {(["mine", "server"] as const).map((side) => (
                      <td key={side} className="py-3 pr-3">
                        <label className="flex cursor-pointer gap-2">
                          <input
                            type="radio"
                            name={`pick-${k}`}
                            checked={conflict.choice[k] === side}
                            onChange={() => setConflict({ ...conflict, choice: { ...conflict.choice, [k]: side } })}
                          />
                          <span className="whitespace-pre-wrap break-words">{show(side === "mine" ? draft[k] : conflict.server[k])}</span>
                        </label>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {message && <p role="alert" className="mt-4 text-sm text-amber-300">{message.text}</p>}
          <div className="mt-6 flex flex-wrap gap-3">
            <button type="button" disabled={saving} onClick={resolveConflict} className="rounded bg-cyan-700 px-4 py-2 hover:bg-cyan-600 disabled:opacity-60">
              {saving ? "Guardando…" : "Guardar con lo elegido"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                acceptVersion(id, conflict.server["version"]);
                setOriginal(conflict.server);
                setDraft(conflict.server);
                setEtag(conflict.etag);
                setConflict(null);
                setMessage(null);
              }}
              className="rounded border border-neutral-700 px-4 py-2 hover:border-neutral-500"
            >
              Descartar mis cambios
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100">
      <form onSubmit={onSubmit} className="mx-auto max-w-2xl" noValidate>
        <Link to="/" className="text-sm text-cyan-400 hover:underline">← Inicio</Link>
        <h1 className="mt-3 text-2xl font-semibold">
          Editar expediente <span className="text-neutral-400">#{id}</span>
        </h1>
        <p className="mt-1 text-xs text-neutral-500">Versión {show(original["version"])}</p>

        {remoteChange !== null && (
          <div role="alert" className="mt-4 rounded border border-amber-500 bg-amber-950/40 p-3 text-sm text-amber-200">
            Este expediente cambió en el servidor mientras lo editabas
            {remoteChange > 0 ? ` (versión ${remoteChange})` : ""}. Revisa las diferencias antes de guardar.
            <button type="button" onClick={() => void reviewRemoteNow()} className="ml-2 underline">
              Ver diferencias
            </button>
          </div>
        )}

        <div className="mt-6 space-y-4">
          {keys.map((k) => {
            const v = draft[k];
            const inputId = `f-${k}`;
            if (typeof original[k] === "boolean") {
              return (
                <label key={k} htmlFor={inputId} className="flex items-center gap-2 text-sm">
                  <input id={inputId} type="checkbox" checked={v === true} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} />
                  {k}
                </label>
              );
            }
            const isNum = typeof original[k] === "number";
            const long = typeof v === "string" && v.length > 80;
            return (
              <div key={k}>
                <label htmlFor={inputId} className="block text-sm text-neutral-400">{k}</label>
                {long ? (
                  <textarea
                    id={inputId}
                    value={String(v ?? "")}
                    rows={4}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                    className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
                  />
                ) : (
                  <input
                    id={inputId}
                    type={isNum ? "number" : "text"}
                    value={v === null || v === undefined ? "" : String(v)}
                    onChange={(e) =>
                      setDraft({ ...draft, [k]: isNum ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value })
                    }
                    className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
                  />
                )}
              </div>
            );
          })}
        </div>

        {message && (
          <p role={message.kind === "error" ? "alert" : "status"} className={`mt-4 text-sm ${message.kind === "error" ? "text-red-400" : "text-emerald-400"}`}>
            {message.text}
          </p>
        )}

        <button
          type="submit"
          disabled={saving || dirtyKeys.length === 0}
          className="mt-6 rounded bg-cyan-700 px-4 py-2 hover:bg-cyan-600 disabled:opacity-60"
        >
          {saving ? "Guardando…" : remoteChange !== null ? "Revisar cambios y guardar" : "Guardar"}
        </button>
      </form>
    </main>
  );
}
