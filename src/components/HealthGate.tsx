import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { checkHealth } from "../lib/auth";

/** Si /meta/health no responde: "Conectando con Lumon…" con reintento y espera creciente. */
export default function HealthGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [nextIn, setNextIn] = useState(0);
  const timer = useRef<number | null>(null);

  const probe = useCallback(async () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    const healthy = await checkHealth();
    if (healthy) {
      setOk(true);
      return;
    }
    setOk(false);
    setAttempt((a) => {
      const n = a + 1;
      let secs = Math.min(2 ** n, 30);
      setNextIn(secs);
      timer.current = window.setInterval(() => {
        secs -= 1;
        setNextIn(secs);
        if (secs <= 0) {
          if (timer.current !== null) window.clearInterval(timer.current);
          void probe();
        }
      }, 1000);
      return n;
    });
  }, []);

  useEffect(() => {
    void probe();
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [probe]);

  if (ok) return <>{children}</>;

  return (
    <main className="min-h-dvh bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      <div className="text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-cyan-400">Lumon Industries</p>
        <h1 className="mt-3 text-2xl font-semibold">Conectando con Lumon…</h1>
        {ok === false && (
          <>
            <p className="mt-3 text-sm text-neutral-400">
              Intento {attempt}. Reintentando en {nextIn}s.
            </p>
            <button
              type="button"
              onClick={() => void probe()}
              className="mt-6 rounded border border-neutral-700 px-4 py-2 text-sm hover:border-cyan-400 hover:text-cyan-400"
            >
              Reintentar ahora
            </button>
          </>
        )}
      </div>
    </main>
  );
}
