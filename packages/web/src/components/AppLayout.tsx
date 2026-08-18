import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Menu } from "lucide-react";
import { Sidebar } from "./Sidebar";

export function AppLayout({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Close the drawer on every navigation instead of requiring an explicit close tap.
  useEffect(() => setMobileOpen(false), [location.pathname]);

  // Without this, the page behind the drawer/backdrop stays scrollable on touch devices —
  // scrolling "under" the menu instead of the menu blocking interaction with it.
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Fixed, not just sticky-in-flow: guarantees the menu toggle stays reachable no
          matter how far down a page's own content (e.g. a long chat) is scrolled. */}
      <div className="fixed inset-x-0 top-0 z-20 flex h-14 flex-shrink-0 items-center gap-3 border-b border-border bg-bg/80 backdrop-blur-lg md:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-bg-hover hover:text-accent transition-all"
          aria-label="Open menu"
        >
          <Menu size={18} />
        </button>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-accent text-sm font-bold text-accent-fg shadow-lg">
          H
        </span>
        <span className="text-base font-semibold tracking-tight text-fg">Hertz</span>
      </div>
      <div className="h-14 flex-shrink-0 md:hidden" aria-hidden="true" />

      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/60 md:hidden" onClick={() => setMobileOpen(false)} aria-hidden="true" />
      )}
      <div
        className={`fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 md:static md:z-auto md:translate-x-0 md:w-auto ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar onClose={() => setMobileOpen(false)} />
      </div>

      {/* Main content area */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-bg">{children}</div>
    </div>
  );
}
