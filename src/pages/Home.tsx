import { Link } from "react-router-dom";
import { BUILD_SHA } from "../lib/api";

export default function Home() {
  return (
    <main className="min-h-dvh bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      <div className="max-w-xl text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-cyan-400">Lumon Industries</p>
        <h1 className="mt-3 text-4xl font-semibold">Macrodata Refinement</h1>
        <p className="mt-4 text-neutral-400">
          Cuadrilla <span className="text-neutral-100">Tequeños</span> · TEAM-010
        </p>
        <p className="mt-8 text-sm text-neutral-500">
          El trabajo es misterioso e importante.
        </p>
        <Link
          to="/estado"
          className="mt-8 inline-block rounded border border-neutral-700 px-4 py-2 text-sm hover:border-cyan-400 hover:text-cyan-400"
        >
          Ver estado del piso
        </Link>
        <p className="mt-10 text-xs text-neutral-600">build {BUILD_SHA}</p>
      </div>
    </main>
  );
}
