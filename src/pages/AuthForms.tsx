import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { safeNext } from "../auth/guards";
import { ApiError } from "../lib/auth";

type FieldErrors = Partial<Record<"teamName" | "email" | "password" | "form", string>>;

const REASON_TEXT: Record<string, string> = {
  REFRESH_REUSED: "Tu sesión se cerró por seguridad: se detectó un token reutilizado. Inicia sesión de nuevo.",
  SESSION_REVOKED: "Tu sesión fue revocada. Inicia sesión de nuevo.",
  TOKEN_INVALID: "Tu sesión no es válida. Inicia sesión de nuevo.",
  LOGOUT: "Cerraste sesión.",
};

/** Traduce el error del servidor a errores por campo. */
function toFieldErrors(err: unknown): FieldErrors {
  if (!(err instanceof ApiError)) return { form: "No se pudo conectar con Lumon. Intenta de nuevo." };
  const out: FieldErrors = {};
  const fields = ["teamName", "email", "password"] as const;
  const d = err.details;
  if (Array.isArray(d)) {
    for (const item of d as Array<{ field?: string; path?: string; message?: string }>) {
      const f = (item.field ?? item.path ?? "").split(".").pop() ?? "";
      if ((fields as readonly string[]).includes(f)) out[f as (typeof fields)[number]] = item.message ?? err.message;
    }
  } else if (d && typeof d === "object") {
    const rec = d as Record<string, unknown>;
    for (const f of fields) {
      const v = rec[f];
      if (typeof v === "string") out[f] = v;
      else if (Array.isArray(v) && typeof v[0] === "string") out[f] = v[0];
    }
    if (typeof rec.field === "string" && (fields as readonly string[]).includes(rec.field)) {
      out[rec.field as (typeof fields)[number]] = err.message;
    }
  }
  if (Object.keys(out).length === 0) {
    const code = err.code.toUpperCase();
    if (code.includes("EMAIL")) out.email = err.message;
    else if (code.includes("TEAM") || code.includes("NAME")) out.teamName = err.message;
    else if (code.includes("PASSWORD")) out.password = err.message;
    else out.form = err.message || err.code;
  }
  return out;
}

function Field(props: {
  label: string;
  name: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  error: string | undefined;
  autoComplete: string;
}) {
  return (
    <label className="block">
      <span className="text-sm text-neutral-300">{props.label}</span>
      <input
        name={props.name}
        type={props.type}
        value={props.value}
        autoComplete={props.autoComplete}
        onChange={(e) => props.onChange(e.target.value)}
        aria-invalid={props.error ? true : undefined}
        className={`mt-1 w-full rounded border bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-cyan-400 ${
          props.error ? "border-red-500" : "border-neutral-700"
        }`}
        required
      />
      {props.error && <span className="mt-1 block text-sm text-red-400">{props.error}</span>}
    </label>
  );
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <p className="text-xs uppercase tracking-[0.3em] text-cyan-400">Lumon Industries</p>
        <h1 className="mt-2 text-2xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function LoginPage() {
  const { login, endReason } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const next = safeNext(new URLSearchParams(location.search).get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await login(email, password);
      navigate(next, { replace: true });
    } catch (err) {
      setErrors(toFieldErrors(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="Ingresar al piso">
      {endReason && (
        <p role="alert" className="mt-4 rounded border border-amber-600 bg-amber-950/40 p-3 text-sm text-amber-200">
          {REASON_TEXT[endReason]}
        </p>
      )}
      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <Field label="Email" name="email" type="email" value={email} onChange={setEmail} error={errors.email} autoComplete="email" />
        <Field label="Contraseña" name="password" type="password" value={password} onChange={setPassword} error={errors.password} autoComplete="current-password" />
        {errors.form && <p role="alert" className="text-sm text-red-400">{errors.form}</p>}
        <button disabled={busy} className="w-full rounded bg-cyan-500 px-4 py-2 font-medium text-neutral-950 disabled:opacity-50">
          {busy ? "Ingresando…" : "Ingresar"}
        </button>
      </form>
      <p className="mt-6 text-sm text-neutral-400">
        ¿Cuadrilla nueva?{" "}
        <Link to={`/register${location.search}`} className="text-cyan-400 hover:underline">
          Registrarla
        </Link>
      </p>
    </Shell>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const next = safeNext(new URLSearchParams(location.search).get("next"));
  const [teamName, setTeamName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await register(teamName, email, password);
      navigate(next, { replace: true });
    } catch (err) {
      setErrors(toFieldErrors(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="Registrar cuadrilla">
      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <Field label="Nombre del equipo" name="teamName" type="text" value={teamName} onChange={setTeamName} error={errors.teamName} autoComplete="organization" />
        <Field label="Email" name="email" type="email" value={email} onChange={setEmail} error={errors.email} autoComplete="email" />
        <Field label="Contraseña" name="password" type="password" value={password} onChange={setPassword} error={errors.password} autoComplete="new-password" />
        {errors.form && <p role="alert" className="text-sm text-red-400">{errors.form}</p>}
        <button disabled={busy} className="w-full rounded bg-cyan-500 px-4 py-2 font-medium text-neutral-950 disabled:opacity-50">
          {busy ? "Registrando…" : "Registrar"}
        </button>
      </form>
      <p className="mt-6 text-sm text-neutral-400">
        ¿Ya tienen cuenta?{" "}
        <Link to={`/login${location.search}`} className="text-cyan-400 hover:underline">
          Ingresar
        </Link>
      </p>
    </Shell>
  );
}
