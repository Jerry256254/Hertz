import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 flex-shrink-0 items-center justify-between border-b border-border bg-bg-raised px-4">
        <Link to="/" className="font-mono text-sm font-semibold tracking-tight text-fg">
          kuclab hertz
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link to="/" className="text-fg-muted hover:text-fg">
            Projects
          </Link>
          <Link to="/providers" className="text-fg-muted hover:text-fg">
            Providers
          </Link>
          <span className="text-fg-muted">{user?.email}</span>
          <button
            onClick={() => void logout()}
            className="rounded border border-border px-2 py-1 text-xs text-fg-muted hover:text-fg"
          >
            Log out
          </button>
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
