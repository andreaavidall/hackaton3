import { lazy, Suspense } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import Home from "./pages/Home";
import Estado from "./pages/Estado";
import Equipo from "./pages/Equipo";
import NotFound from "./pages/NotFound";
import { LoginPage, RegisterPage } from "./pages/AuthForms";
import { AuthProvider } from "./auth/AuthContext";
import { GuestOnly, RequireAuth, RequirePermission } from "./auth/guards";
import HealthGate from "./components/HealthGate";
import ErrorBoundary from "./components/ErrorBoundary";

const Files = lazy(() => import("./pages/Files"));
const Refine = lazy(() => import("./pages/Refine"));

export default function App() {
  const location = useLocation();
  return (
    <HealthGate>
      <AuthProvider>
        <ErrorBoundary resetKey={location.pathname}>
        <Suspense fallback={<p className="p-6 text-neutral-400">Cargando…</p>}>
        <Routes>
          <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
          <Route path="/register" element={<GuestOnly><RegisterPage /></GuestOnly>} />
          <Route path="/" element={<RequireAuth><Home /></RequireAuth>} />
          <Route path="/estado" element={<RequireAuth><Estado /></RequireAuth>} />
          <Route
            path="/equipo"
            element={
              <RequireAuth>
                <RequirePermission permission="team:manage">
                  <Equipo />
                </RequirePermission>
              </RequireAuth>
            }
          />
          <Route path="/files" element={<RequireAuth><RequirePermission permission="files:read"><Files /></RequirePermission></RequireAuth>} />
          <Route path="/files/:id/refine" element={<RequireAuth><RequirePermission permission="files:read"><Refine /></RequirePermission></RequireAuth>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
        </ErrorBoundary>
      </AuthProvider>
    </HealthGate>
  );
}
