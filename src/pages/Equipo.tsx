import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { authJson } from "../lib/auth";

interface Member {
  id?: number | string;
  email?: string;
  displayName?: string;
  role?: { code?: string; name?: string } | string;
}

export default function Equipo() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authJson<Member[] | { items?: Member[]; members?: Member[] }>("/team/members")
      .then((data) => setMembers(Array.isArray(data) ? data : (data.items ?? data.members ?? [])))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Error al cargar"));
  }, []);

  return (
    <main className="min-h-dvh bg-neutral-950 text-neutral-100 p-6">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold">Equipo</h1>
        {error && <p className="mt-4 text-red-400">{error}</p>}
        {!members && !error && <p className="mt-4 text-neutral-400">Cargando…</p>}
        <ul className="mt-6 divide-y divide-neutral-800 border-y border-neutral-800 text-sm">
          {members?.map((m, i) => (
            <li key={m.id ?? i} className="flex justify-between py-3">
              <span>{m.displayName ?? m.email ?? "—"}</span>
              <span className="text-neutral-400">{typeof m.role === "string" ? m.role : (m.role?.name ?? "")}</span>
            </li>
          ))}
        </ul>
        <Link to="/" className="mt-6 inline-block text-sm text-cyan-400 hover:underline">
          ← Volver
        </Link>
      </div>
    </main>
  );
}
