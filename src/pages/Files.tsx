import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { authFetch } from "../lib/auth";

interface FileItem {
  id: number | string;
  name?: string;
  status?: string;
  rows?: number;
  cols?: number;
  progress?: { overall?: number } | number;
}

interface Page {
  items: FileItem[];
  total: number | null;
}

const SIZES = [10, 20, 50];
const STATUSES = ["", "PENDING", "IN_PROGRESS", "COMPLETED"];
const SORTS = ["name", "-name", "createdAt", "-createdAt"];

function readParams(sp: URLSearchParams) {
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const sizeRaw = Number.parseInt(sp.get("pageSize") ?? "20", 10);
  const pageSize = SIZES.includes(sizeRaw) ? sizeRaw : 20;
  const statusRaw = sp.get("status") ?? "";
  const status = STATUSES.includes(statusRaw) ? statusRaw : "";
  const sortRaw = sp.get("sort") ?? "name";
  const sort = SORTS.includes(sortRaw) ? sortRaw : "name";
  const q = (sp.get("q") ?? "").slice(0, 100);
  return { page, pageSize, status, sort, q };
}

function pct(p: FileItem["progress"]): string {
  const v = typeof p === "number" ? p : p?.overall;
  if (typeof v !== "number") return "—";
  return `${Math.round(v <= 1 ? v * 100 : v)}%`;
}

export default function Files() {
  const [sp, setSp] = useSearchParams();
  const params = readParams(sp);
  const [search, setSearch] = useState(params.q);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  const update = (patch: Record<string, string>, resetPage = true) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (resetPage) next.delete("page");
    setSp(next);
  };

  // Busqueda sin una request por tecla (debounce).
  useEffect(() => {
    if (search === params.q) return;
    const t = setTimeout(() => update({ q: search.trim() }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => setSearch(params.q), [params.q]);

  const queryKey = `${params.page}|${params.pageSize}|${params.status}|${params.sort}|${params.q}`;
  useEffect(() => {
    const id = ++reqId.current;
    const controller = new AbortController();
    const qs = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize), sort: params.sort });
    if (params.status) qs.set("status", params.status);
    if (params.q) qs.set("q", params.q);
    setLoading(true);
    setError(null);
    authFetch(`/files?${qs.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        const json = (await res.json()) as Record<string, unknown>;
        if (!res.ok) throw new Error(typeof json.message === "string" ? json.message : `HTTP ${res.status}`);
        const items = (Array.isArray(json) ? json : (json.items ?? json.data ?? json.files ?? [])) as FileItem[];
        const total = typeof json.total === "number" ? json.total : typeof json.totalItems === "number" ? json.totalItems : null;
        // Una respuesta vieja nunca pisa a una nueva.
        if (id === reqId.current) setData({ items, total });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted || id !== reqId.current) return;
        setError(e instanceof Error ? e.message : "Error al cargar");
      })
      .finally(() => {
        if (id === reqId.current) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  const totalPages = data?.total != null ? Math.max(1, Math.ceil(data.total / params.pageSize)) : null;

  return (
    <main className="min-h-dvh bg-neutral-950 text-neutral-100 p-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Archivos de datos</h1>
          <Link to="/" className="text-sm text-cyan-400 hover:underline">← Inicio</Link>
        </div>

        <div className="mt-6 flex flex-wrap gap-3 text-sm">
          <label className="flex flex-col">
            <span className="text-neutral-400">Buscar</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} className="mt-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2" />
          </label>
          <label className="flex flex-col">
            <span className="text-neutral-400">Estado</span>
            <select value={params.status} onChange={(e) => update({ status: e.target.value })} className="mt-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2">
              {STATUSES.map((s) => <option key={s} value={s}>{s || "Todos"}</option>)}
            </select>
          </label>
          <label className="flex flex-col">
            <span className="text-neutral-400">Orden</span>
            <select value={params.sort} onChange={(e) => update({ sort: e.target.value })} className="mt-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2">
              {SORTS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="flex flex-col">
            <span className="text-neutral-400">Por página</span>
            <select value={params.pageSize} onChange={(e) => update({ pageSize: e.target.value })} className="mt-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2">
              {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>

        {error && <p role="alert" className="mt-4 text-red-400">{error}</p>}
        <p aria-live="polite" className="mt-4 h-5 text-sm text-neutral-500">{loading ? "Cargando…" : ""}</p>

        <table className="mt-2 w-full text-left text-sm">
          <thead className="text-neutral-400">
            <tr><th className="py-2">Nombre</th><th>Estado</th><th>Tamaño</th><th>Progreso</th></tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {data?.items.map((f) => (
              <tr key={f.id}>
                <td className="py-2">
                  <Link to={`/files/${f.id}/refine`} className="text-cyan-400 hover:underline">{f.name ?? `Archivo ${f.id}`}</Link>
                </td>
                <td>{f.status ?? "—"}</td>
                <td>{f.rows && f.cols ? `${f.rows}×${f.cols}` : "—"}</td>
                <td>{pct(f.progress)}</td>
              </tr>
            ))}
            {data && data.items.length === 0 && <tr><td colSpan={4} className="py-4 text-neutral-500">Sin resultados.</td></tr>}
          </tbody>
        </table>

        <nav aria-label="Paginación" className="mt-4 flex items-center gap-3 text-sm">
          <button type="button" disabled={params.page <= 1} onClick={() => update({ page: String(params.page - 1) }, false)} className="rounded border border-neutral-700 px-3 py-1 disabled:opacity-40">Anterior</button>
          <span>Página {params.page}{totalPages ? ` de ${totalPages}` : ""}</span>
          <button type="button" disabled={totalPages !== null && params.page >= totalPages} onClick={() => update({ page: String(params.page + 1) }, false)} className="rounded border border-neutral-700 px-3 py-1 disabled:opacity-40">Siguiente</button>
        </nav>
      </div>
    </main>
  );
}
