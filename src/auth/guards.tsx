import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";

export function FullScreenMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="min-h-dvh bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** Ruta privada: sin sesion manda al login recordando ruta + query string. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") {
    return <FullScreenMessage title="Verificando sesión…" />;
  }
  if (status === "anon") {
    const next = location.pathname + location.search + location.hash;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}

/** Ruta que exige un permiso concreto: sin el permiso muestra "sin permiso". */
export function RequirePermission({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <FullScreenMessage title="Sin permiso">
        <p className="mt-3 text-neutral-400">
          Tu rol no tiene el permiso <code className="text-cyan-400">{permission}</code>.
        </p>
        <Link to="/" className="mt-6 inline-block text-sm text-cyan-400 hover:underline">
          ← Volver al inicio
        </Link>
      </FullScreenMessage>
    );
  }
  return <>{children}</>;
}

/** Login/registro: si ya hay sesion, no tiene sentido mostrarlos. */
export function GuestOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <FullScreenMessage title="Verificando sesión…" />;
  if (status === "authed") {
    const next = new URLSearchParams(location.search).get("next");
    return <Navigate to={safeNext(next)} replace />;
  }
  return <>{children}</>;
}

export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
