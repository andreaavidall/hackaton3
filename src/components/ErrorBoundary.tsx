import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  resetKey: string;
}

interface State {
  error: Error | null;
}

/** Un error de render en una ruta no deja la app en blanco. */
export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Error de render:", error, info.componentStack);
  }

  override componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main role="alert" className="min-h-dvh bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold">Algo salió mal en esta pantalla</h1>
          <p className="mt-3 text-neutral-400">{this.state.error.message}</p>
          <div className="mt-6 flex justify-center gap-3 text-sm">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="rounded border border-neutral-700 px-4 py-2 hover:border-cyan-400 hover:text-cyan-400"
            >
              Reintentar
            </button>
            <a href="/" className="rounded border border-neutral-700 px-4 py-2 hover:border-cyan-400 hover:text-cyan-400">
              Volver al inicio
            </a>
          </div>
        </div>
      </main>
    );
  }
}
