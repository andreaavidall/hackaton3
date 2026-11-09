import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <main className="min-h-dvh bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      <div className="text-center">
        <h1 className="text-5xl font-semibold">404</h1>
        <p className="mt-3 text-neutral-400">Este pasillo no existe en el piso separado.</p>
        <Link to="/" className="mt-6 inline-block text-sm text-cyan-400 hover:underline">
          ← Volver
        </Link>
      </div>
    </main>
  );
}
