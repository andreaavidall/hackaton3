import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * X-Lumon-Build se inyecta en TIEMPO DE BUILD, nunca a mano.
 * - en dev vale "dev"
 * - en produccion es el SHA corto (7) del commit desplegado
 * El contrato exige que matchee ^([0-9a-f]{7,40}|dev)$
 */
function resolveBuildSha(isDev: boolean): string {
  if (isDev) return "dev";
  const fromVercel = process.env["VERCEL_GIT_COMMIT_SHA"];
  if (fromVercel && /^[0-9a-f]{7,40}$/.test(fromVercel)) return fromVercel.slice(0, 7);
  try {
    const sha = execSync("git rev-parse --short=7 HEAD", { encoding: "utf8" }).trim();
    if (/^[0-9a-f]{7,40}$/.test(sha)) return sha;
  } catch {
    // sin git disponible
  }
  return "dev";
}

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_SHA__: JSON.stringify(resolveBuildSha(command === "serve")),
  },
}));
