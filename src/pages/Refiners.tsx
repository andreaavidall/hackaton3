import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { authJson } from "../lib/auth";
import { errorText } from "../lib/media";
import { useLumonEvent } from "../realtime/EventsProvider";
import { acceptVersion } from "../realtime/versions";

export interface Refiner {
  id: number | string;
  name?: string;
  fullName?: string;
  displayName?: string;
  title?: string;
  bio?: string;
  notes?: string;
  department?: { id?: number | string; name?: string } | string | null;
  badgeUrl?: string | null;
  badge?: { url?: string } | null;
  badgeMediaId?: string | number | null;
  version?: number;
}

interface Department { id: number | string; name: string }

export function refinerName(r: Refiner): string {
  return r.fullName ?? r.name ?? r.displayName ?? `Refinador ${r.id}`;
}
export function badgeOf(r: Refiner): string | null {
  return r.badgeUrl ?? r.badge?.url ?? null;
}
function deptName(r: Refiner): string {
  return typeof r.department === "string" ? r.department : (r.department?.name ?? "—");
}
function listOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const d = data as Record<string, unknown>;
  return ((d.items ?? d.data ?? d.refiners ?? d.departments ?? []) as T[]);
}

export default function Refiners() {
  const [sp, setSp] = useSearchParams();
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const department = sp.get("department") ?? "";
  const q = (sp.get("q") ?? "").slice(0, 100);
  const [search, setSearch] = useState(q);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [items, setItems] = useState<Refiner[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const req = useRef(0);
  const pageSize = 20;

  const update = (patch: Record<string, string>, resetPage = true) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (resetPage) next.delete("page");
    setSp(next);
  };

  useEffect(() => {
    authJson<unknown>("/departments").then((d) => setDepartments(listOf<Department>(d))).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (search === q) return;
    const t = setTimeout(() => update({ q: search.trim() }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    const id = ++req.current;
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (department) qs.set("departmentId", department);
    if (q) qs.set("q", q);
    setError(null);
    authJson<unknown>(`/refiners?${qs.toString()}`)
      .then((d) => {
        if (id !== req.current) return;
        const list = listOf<Refiner>(d);
        list.forEach((r) => acceptVersion(String(r.id), r.version));
        setItems(list);
        const t = (d as Record<string, unknown>).total;
        setTotal(typeof t === "number" ? t : null);
      })
      .catch((e: unknown) => id === req.current && setError(errorText(e)));
  }, [page, department, q, reload]);

  // CP5: el directorio refleja los eventos sin recargar; una version vieja nunca pisa a una nueva.
  useLumonEvent((ev) => {
    if (ev.type === "stream.reset") {
      setReload((n) => n + 1);
      return;
    }
    if (ev.type !== "refiner.updated") return;
    const evId = ev.data["id"] ?? ev.data["refinerId"];
    if (evId === undefined || !acceptVersion(String(evId), ev.data["version"])) return;
    setItems((list) => list?.map((r) => (String(r.id) === String(evId) ? ({ ...r, ...ev.data, id: r.id } as Refiner) : r)) ?? list);
  });

  const pages = total !== null ? Math.max(1, Math.ceil(total / pageSize)) : null;

  return (
    <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Expedientes</h1>
          <Link to="/" className="text-sm text-cyan-400 hover:underline">← Inicio</Link>
        </div>
        <div className="mt-6 flex flex-wrap gap-3 text-sm">
          <label className="flex flex-col">
            <span className="text-neutral-400">Buscar</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} className="mt-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2" />
          </label>
          <label className="flex flex-col">
            <span className="text-neutral-400">Departamento</span>
            <select value={department} onChange={(e) => update({ department: e.target.value })} className="mt-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2">
              <option value="">Todos</option>
              {departments.map((d) => <option key={d.id} value={String(d.id)}>{d.name}</option>)}
            </select>
          </label>
        </div>
        {error && <p role="alert" className="mt-4 text-red-400">{error}</p>}
        {!items && !error && <p className="mt-4 text-neutral-400">Cargando…</p>}
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {items?.map((r) => {
            const badge = badgeOf(r);
            return (
              <li key={r.id} className="flex gap-4 rounded border border-neutral-800 p-3">
                {badge ? (
                  <img src={badge} alt={`Fotocheck de ${refinerName(r)}`} width={64} height={64} loading="lazy" decoding="async" className="h-16 w-16 rounded object-cover" />
                ) : (
                  <div aria-hidden="true" className="flex h-16 w-16 items-center justify-center rounded bg-neutral-800 text-neutral-500">?</div>
                )}
                <div className="min-w-0">
                  {/* Textos del exterior: se muestran como texto, nunca como HTML. */}
                  <p className="font-medium break-words">{refinerName(r)}</p>
                  <p className="text-sm text-neutral-400 break-words">{r.title ?? ""} · {deptName(r)}</p>
                  <Link to={`/refiners/${r.id}/badge`} className="mt-1 inline-block text-sm text-cyan-400 hover:underline">Editar fotocheck</Link>
                  <Link to={`/refiners/${r.id}/edit`} className="ml-3 mt-1 inline-block text-sm text-cyan-400 hover:underline">Editar expediente</Link>
                </div>
              </li>
            );
          })}
        </ul>
        <nav aria-label="Paginación" className="mt-4 flex items-center gap-3 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => update({ page: String(page - 1) }, false)} className="rounded border border-neutral-700 px-3 py-1 disabled:opacity-40">Anterior</button>
          <span>Página {page}{pages ? ` de ${pages}` : ""}</span>
          <button type="button" disabled={pages !== null && page >= pages} onClick={() => update({ page: String(page + 1) }, false)} className="rounded border border-neutral-700 px-3 py-1 disabled:opacity-40">Siguiente</button>
        </nav>
      </div>
    </main>
  );
}
