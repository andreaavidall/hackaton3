import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { authFetch } from "../lib/auth";
import {
  broadcastLocal,
  getStreamStatus,
  onLumonEvent,
  onStreamStatus,
  startEventStream,
  type LumonEvent,
  type StreamStatus,
} from "./events";

export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(onStreamStatus, getStreamStatus, getStreamStatus);
}

/** Suscribe un handler a los eventos del stream (el handler puede cambiar sin resuscribir). */
export function useLumonEvent(handler: (ev: LumonEvent) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => onLumonEvent((ev) => ref.current(ev)), []);
}

const STATUS_TEXT: Record<StreamStatus, { label: string; color: string }> = {
  idle: { label: "Eventos: inactivo", color: "bg-neutral-500" },
  connecting: { label: "Eventos: conectando…", color: "bg-amber-400" },
  open: { label: "Eventos: en vivo", color: "bg-emerald-400" },
  reconnecting: { label: "Eventos: reconectando…", color: "bg-amber-400" },
  locked: { label: "Eventos: Piso de Pruebas cerrado", color: "bg-neutral-500" },
  superseded: { label: "Eventos: otra conexión tomó el stream", color: "bg-amber-400" },
  offline: { label: "Eventos: sin red", color: "bg-red-500" },
};

export function StreamIndicator({ className = "" }: { className?: string }) {
  const status = useStreamStatus();
  const s = STATUS_TEXT[status];
  return (
    <span role="status" aria-live="polite" className={`inline-flex items-center gap-2 text-xs text-neutral-300 ${className}`}>
      <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${s.color}`} />
      {s.label}
    </span>
  );
}

interface Contingency {
  id: string;
  message: string;
}

function myUserId(me: unknown): string | null {
  if (!me || typeof me !== "object") return null;
  const o = me as Record<string, unknown>;
  const user = o["user"] as Record<string, unknown> | undefined;
  const id = user?.["id"] ?? o["id"] ?? o["userId"];
  return typeof id === "number" || typeof id === "string" ? String(id) : null;
}

function targetUserId(data: Record<string, unknown>): string | null {
  const user = data["user"] as Record<string, unknown> | undefined;
  const id = data["userId"] ?? data["targetUserId"] ?? user?.["id"];
  return typeof id === "number" || typeof id === "string" ? String(id) : null;
}

function ContingencyModal({ item, onDone }: { item: Contingency; onDone: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Foco atrapado dentro del modal; Escape no lo cierra.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    buttonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>("button, [href], [tabindex]:not([tabindex='-1'])");
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!dialogRef.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) buttonRef.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn);
      previous?.focus?.();
    };
  }, []);

  async function ack() {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(`/contingency/${encodeURIComponent(item.id)}/ack`, { method: "POST" });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { message?: string; error?: string };
          msg = body.message || body.error || msg;
        } catch {
          /* sin cuerpo */
        }
        throw new Error(msg);
      }
      broadcastLocal("contingency.acked", { id: item.id });
      onDone();
    } catch (e) {
      setError(`No se pudo confirmar: ${e instanceof Error ? e.message : "error de red"}. Vuelve a intentarlo.`);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="contingency-title"
        aria-describedby="contingency-desc"
        className="w-full max-w-md rounded-lg border border-red-500 bg-neutral-950 p-6 text-neutral-100 shadow-2xl"
      >
        <h2 id="contingency-title" className="text-xl font-semibold text-red-400">
          Contingencia de horas extra activada
        </h2>
        <p id="contingency-desc" className="mt-3 whitespace-pre-wrap text-neutral-300">
          {item.message}
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        )}
        <button
          ref={buttonRef}
          type="button"
          disabled={busy}
          onClick={() => void ack()}
          className="mt-6 w-full rounded bg-red-600 px-4 py-2 font-medium hover:bg-red-500 disabled:opacity-60"
        >
          {busy ? "Confirmando…" : "Confirmar contingencia"}
        </button>
      </div>
    </div>
  );
}

/** Arranca el stream mientras hay sesión y muestra el modal de contingencia en todas las pestañas. */
export function EventsProvider({ children }: { children: ReactNode }) {
  const { status, me } = useAuth();
  const [queue, setQueue] = useState<Contingency[]>([]);
  const meId = myUserId(me);

  useEffect(() => {
    if (status !== "authed") return;
    return startEventStream();
  }, [status]);

  useLumonEvent((ev) => {
    if (ev.type === "contingency.activated") {
      const target = targetUserId(ev.data);
      if (target !== null && meId !== null && target !== meId) return;
      const rawId = ev.data["contingencyId"] ?? ev.data["id"];
      if (typeof rawId !== "string" && typeof rawId !== "number") return;
      const id = String(rawId);
      const message =
        typeof ev.data["message"] === "string"
          ? ev.data["message"]
          : "Lumon activó la contingencia de horas extra para ti. Confirma para continuar.";
      setQueue((q) => (q.some((c) => c.id === id) ? q : [...q, { id, message }]));
    } else if (ev.type === "contingency.acked") {
      const id = String(ev.data["id"]);
      setQueue((q) => q.filter((c) => c.id !== id));
    }
  });

  useEffect(() => {
    if (status !== "authed") setQueue([]);
  }, [status]);

  const current = queue[0];
  return (
    <>
      {children}
      {status === "authed" && (
        <div className="pointer-events-none fixed bottom-2 left-2 z-40 rounded bg-neutral-900/90 px-2 py-1">
          <StreamIndicator />
        </div>
      )}
      {current && (
        <ContingencyModal key={current.id} item={current} onDone={() => setQueue((q) => q.filter((c) => c.id !== current.id))} />
      )}
    </>
  );
}
