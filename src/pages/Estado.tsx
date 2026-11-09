import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, BUILD_SHA, type HealthStatus } from "../lib/api";

export default function Estado() {
  const [health, setHealth] = useState<HealthStatus>("checking");

  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/meta/health", { signal: controller.signal })
      .then((res) => setHealth(res.ok ? "ok" : "down"))
      .catch(() => {
        if (!controller.signal.aborted) setHealth("down");
      });
    return () => controller.abort();
  }, []);

  const label: Record<HealthStatus, string> = {
    checking: "Consultando…",
    ok: "Responde",
    down: "Sin respuesta",
  };

  return (
    <main className="min-h-dvh bg-neutral-950 text-neutral-100 p-6">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold">Estado</h1>
        <dl className="mt-6 divide-y divide-neutral-800 border-y border-neutral-800 text-sm">
          <div className="flex justify-between py-3">
            <dt className="text-neutral-400">Build desplegado</dt>
            <dd className="font-mono">{BUILD_SHA}</dd>
          </div>
          <div className="flex justify-between py-3">
            <dt className="text-neutral-400">API de Lumon</dt>
            <dd>{label[health]}</dd>
          </div>
          <div className="flex justify-between py-3">
            <dt className="text-neutral-400">Integraciones</dt>
            <dd className="text-neutral-500">pendiente</dd>
          </div>
          <div className="flex justify-between py-3">
            <dt className="text-neutral-400">Piso de Pruebas</dt>
            <dd className="text-neutral-500">pendiente</dd>
          </div>
        </dl>
        <Link to="/" className="mt-6 inline-block text-sm text-cyan-400 hover:underline">
          ← Volver
        </Link>
      </div>
    </main>
  );
}
