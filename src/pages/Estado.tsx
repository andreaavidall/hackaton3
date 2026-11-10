import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BUILD_SHA } from "../lib/api";
import { ApiError, authJson, checkHealth } from "../lib/auth";

type Json = Record<string, unknown>;

function Pre({ data }: { data: unknown }) {
  return (
    <pre className="mt-2 max-h-64 overflow-auto rounded bg-neutral-900 p-3 text-xs text-neutral-300">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

export default function Estado() {
  const [health, setHealth] = useState<"checking" | "ok" | "down">("checking");
  const [integrations, setIntegrations] = useState<Json | null>(null);
  const [clearance, setClearance] = useState<Json | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [check, setCheck] = useState<{ busy: boolean; result: unknown; error: string | null }>({
    busy: false,
    result: null,
    error: null,
  });

  const load = useCallback(async () => {
    setLoadError(null);
    setHealth("checking");
    setHealth((await checkHealth()) ? "ok" : "down");
    try {
      const [i, c] = await Promise.all([authJson<Json>("/integrations/status"), authJson<Json>("/clearance")]);
      setIntegrations(i);
      setClearance(c);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "No se pudo cargar el estado");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runCheck() {
    setCheck({ busy: true, result: null, error: null });
    try {
      const result = await authJson<unknown>("/clearance/check", { method: "POST" });
      setCheck({ busy: false, result, error: null });
      void load();
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.code}: ${e.message}` : "Error al correr la revisión";
      setCheck({ busy: false, result: e instanceof ApiError ? e.details : null, error: msg });
    }
  }

  const healthLabel = { checking: "Consultando…", ok: "Responde", down: "Sin respuesta" }[health];

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
            <dd aria-live="polite">{healthLabel}</dd>
          </div>
        </dl>

        {loadError && (
          <p role="alert" className="mt-4 text-sm text-red-400">
            {loadError}{" "}
            <button type="button" onClick={() => void load()} className="underline">
              Reintentar
            </button>
          </p>
        )}

        <section className="mt-6">
          <h2 className="font-medium">Integraciones</h2>
          {integrations ? <Pre data={integrations} /> : <p className="mt-2 text-sm text-neutral-500">Cargando…</p>}
        </section>

        <section className="mt-6">
          <h2 className="font-medium">Clearance</h2>
          {clearance ? <Pre data={clearance} /> : <p className="mt-2 text-sm text-neutral-500">Cargando…</p>}
        </section>

        <section className="mt-6">
          <button
            type="button"
            onClick={() => void runCheck()}
            disabled={check.busy}
            className="rounded bg-cyan-500 px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50"
          >
            {check.busy ? "Revisando…" : "Abrir el Piso de Pruebas"}
          </button>
          {check.error && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {check.error}
            </p>
          )}
          {check.result !== null && <Pre data={check.result} />}
        </section>

        <Link to="/" className="mt-6 inline-block text-sm text-cyan-400 hover:underline">
          ← Volver
        </Link>
      </div>
    </main>
  );
}
