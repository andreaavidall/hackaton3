import { Link } from "react-router-dom";
import { BUILD_SHA } from "../lib/api";
import { useAuth } from "../auth/AuthContext";

export default function Home() {
  const { me, logout, can } = useAuth();
  return (
    <main className="min-h-dvh bg-neutral-950 text-neutral-100 p-6">
      <div className="mx-auto max-w-2xl">
        <header className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-cyan-400">Lumon Industries</p>
            <h1 className="mt-1 text-2xl font-semibold">Macrodata Refinement</h1>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:border-red-400 hover:text-red-400"
          >
            Cerrar sesión
          </button>
        </header>

        <dl className="mt-8 divide-y divide-neutral-800 border-y border-neutral-800 text-sm">
          <div className="flex justify-between py-3">
            <dt className="text-neutral-400">Cuadrilla</dt>
            <dd>
              {me?.team?.name ?? "—"} · {me?.team?.code ?? "—"}
            </dd>
          </div>
          <div className="flex justify-between py-3">
            <dt className="text-neutral-400">Rol</dt>
            <dd>{me?.role?.name ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-6 py-3">
            <dt className="text-neutral-400">Permisos</dt>
            <dd className="text-right font-mono text-xs">{me?.permissions.join(", ") || "—"}</dd>
          </div>
          <div className="flex justify-between py-3">
            <dt className="text-neutral-400">Clearance</dt>
            <dd>{me?.clearance?.granted ? "Concedido" : "Pendiente"}</dd>
          </div>
        </dl>

        <nav className="mt-8 flex flex-wrap gap-3 text-sm">
          <Link to="/files" className="rounded border border-cyan-700 px-4 py-2 text-cyan-300 hover:border-cyan-400">
            Archivos de datos
          </Link>
          <Link to="/refiners" className="rounded border border-neutral-700 px-4 py-2 hover:border-cyan-400 hover:text-cyan-400">
            Expedientes
          </Link>
          <Link to="/incidents" className="rounded border border-neutral-700 px-4 py-2 hover:border-cyan-400 hover:text-cyan-400">
            Incidencias
          </Link>
          <Link to="/estado" className="rounded border border-neutral-700 px-4 py-2 hover:border-cyan-400 hover:text-cyan-400">
            Estado del piso
          </Link>
          {can("team:manage") ? (
            <Link to="/equipo" className="rounded border border-neutral-700 px-4 py-2 hover:border-cyan-400 hover:text-cyan-400">
              Gestionar equipo
            </Link>
          ) : (
            <span className="rounded border border-neutral-800 px-4 py-2 text-neutral-600" title="Requiere team:manage">
              Gestionar equipo
            </span>
          )}
        </nav>

        <p className="mt-10 text-xs text-neutral-600">build {BUILD_SHA}</p>
      </div>
    </main>
  );
}
