import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Menu } from "lucide-react";
import { Sidebar } from "./Sidebar";

export function AppLayout({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Close the drawer on every navigation instead of requiring an explicit close tap.
  useEffect(() => setMobileOpen(false), [location.pathname]);

  return (
    <div className="flex h-full flex-col md:flex-row">
      <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-bg-hover hover:text-fg"
          aria-label="Open menu"
        >
          <Menu size={17} />
        </button>
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-xs font-bold text-accent-fg">H</span>
        <span className="text-sm font-semibold tracking-tight text-fg">Hertz</span>
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setMobileOpen(false)} aria-hidden="true" />
      )}
      <div
        className={`fixed inset-y-0 left-0 z-40 transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar />
      </div>

      <div className="min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  );
}
