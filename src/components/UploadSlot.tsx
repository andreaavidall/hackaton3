import { useCallback, useEffect, useRef, useState } from "react";
import { confirmTicket, errorText, requestTicket, uploadToStorage, type Processed, type Purpose } from "../lib/media";

type Phase = "idle" | "ticket" | "uploading" | "confirming" | "done" | "error" | "cancelled";

/** Una subida con progreso real, cancelar y reintentar. Llama onDone con el mediaId confirmado. */
export default function UploadSlot(props: {
  purpose: Purpose;
  processed: Processed;
  label: string;
  onDone: (mediaId: string, previewUrl: string) => void;
  autoStart?: boolean;
}) {
  const { purpose, processed, onDone } = props;
  const [phase, setPhase] = useState<Phase>("idle");
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const started = useRef(false);

  const start = useCallback(async () => {
    setError(null);
    setPct(0);
    try {
      setPhase("ticket");
      const ticket = await requestTicket(purpose, processed);
      setPhase("uploading");
      const handle = uploadToStorage(processed.blob, ticket.path, setPct);
      abortRef.current = handle.abort;
      const url = await handle.promise;
      abortRef.current = null;
      setPhase("confirming");
      const mediaId = await confirmTicket(ticket.ticketId, url);
      setPhase("done");
      onDone(mediaId, url);
    } catch (e) {
      abortRef.current = null;
      if (e instanceof DOMException && e.name === "AbortError") {
        setPhase("cancelled");
        return;
      }
      setPhase("error");
      setError(errorText(e));
    }
  }, [purpose, processed, onDone]);

  useEffect(() => {
    if (props.autoStart && !started.current) {
      started.current = true;
      void start();
    }
  }, [props.autoStart, start]);

  const label = { idle: "Lista para subir", ticket: "Pidiendo permiso…", uploading: `Subiendo ${pct}%`, confirming: "Confirmando…", done: "Confirmada", error: "Error", cancelled: "Cancelada" }[phase];

  return (
    <div className="rounded border border-neutral-800 p-3 text-sm">
      <div className="flex justify-between">
        <span>{props.label}</span>
        <span aria-live="polite" className={phase === "done" ? "text-emerald-400" : phase === "error" ? "text-red-400" : "text-neutral-400"}>{label}</span>
      </div>
      <div className="mt-2 h-2 rounded bg-neutral-800" role="progressbar" aria-label={`Progreso de ${props.label}`} aria-valuenow={phase === "done" ? 100 : pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded bg-cyan-500 transition-[width] motion-reduce:transition-none" style={{ width: `${phase === "done" ? 100 : pct}%` }} />
      </div>
      {error && <p role="alert" className="mt-2 text-red-400">{error}</p>}
      <div className="mt-2 flex gap-2">
        {(phase === "idle" || phase === "error" || phase === "cancelled") && (
          <button type="button" onClick={() => void start()} className="rounded border border-neutral-700 px-3 py-1 hover:border-cyan-400">
            {phase === "idle" ? "Subir" : "Reintentar"}
          </button>
        )}
        {phase === "uploading" && (
          <button type="button" onClick={() => abortRef.current?.()} className="rounded border border-neutral-700 px-3 py-1 hover:border-red-400">
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}
