import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  authJson,
  hasStoredSession,
  logoutRequest,
  onSessionEnd,
  publicJson,
  refreshSession,
  setSession,
  type RevokeReason,
  type SessionTokens,
} from "../lib/auth";

export interface Me {
  team?: { code: string; name: string };
  role?: { code: string; name: string };
  permissions: string[];
  clearance?: { granted: boolean; grantedAt: string | null };
  user?: { id: number; email: string; displayName: string };
}

type Status = "loading" | "authed" | "anon";

interface AuthValue {
  status: Status;
  me: Me | null;
  endReason: RevokeReason | null;
  can: (permission: string) => boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (teamName: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(hasStoredSession() ? "loading" : "anon");
  const [me, setMe] = useState<Me | null>(null);
  const [endReason, setEndReason] = useState<RevokeReason | null>(null);

  const loadMe = useCallback(async () => {
    const data = await authJson<Me>("/auth/me");
    setMe({ ...data, permissions: Array.isArray(data.permissions) ? data.permissions : [] });
    setStatus("authed");
  }, []);

  // Restaurar sesion al recargar (sin mostrar el login mientras se verifica).
  useEffect(() => {
    if (!hasStoredSession()) return;
    refreshSession(null)
      .then(loadMe)
      .catch(() => {
        setMe(null);
        setStatus("anon");
      });
  }, [loadMe]);

  // Cierre de sesion (logout en otra pestana, revocacion, robo de refresh).
  useEffect(
    () =>
      onSessionEnd((reason) => {
        setMe(null);
        setStatus("anon");
        setEndReason(reason);
      }),
    [],
  );

  const startSession = useCallback(
    async (tokens: SessionTokens) => {
      setSession(tokens);
      setEndReason(null);
      await loadMe();
    },
    [loadMe],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const tokens = await publicJson<SessionTokens>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      await startSession(tokens);
    },
    [startSession],
  );

  const register = useCallback(
    async (teamName: string, email: string, password: string) => {
      const tokens = await publicJson<SessionTokens>("/auth/register", {
        method: "POST",
        body: JSON.stringify({ teamName, email, password }),
      });
      await startSession(tokens);
    },
    [startSession],
  );

  const logout = useCallback(async () => {
    await logoutRequest();
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      me,
      endReason,
      can: (p: string) => me?.permissions.includes(p) ?? false,
      login,
      register,
      logout,
    }),
    [status, me, endReason, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de AuthProvider");
  return ctx;
}

