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
      <div className="fixed inset-x-0 top-0 z-20 flex h-12 flex-shrink-0 items-center gap-2 border-b border-border bg-bg px-3 md:hidden">
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
      <div className="h-12 flex-shrink-0 md:hidden" aria-hidden="true" />

      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setMobileOpen(false)} aria-hidden="true" />
      )}
      <div
        className={`fixed inset-y-0 left-0 z-40 transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar onClose={() => setMobileOpen(false)} />
      </div>

      {/* The one canonical scroll container for every page — some pages (Dashboard,
          Integrations, Providers) size to natural content height and previously relied
          on the whole body scrolling, which is exactly what let content scroll "under"
          the fixed mobile drawer/backdrop instead of being contained by it.
          It's a flex column so pages that need to pin their own header/input to the
          viewport (chat, employee detail) fill it with flex-1 min-h-0 instead of
          h-full — percentage heights against this stretched scroll wrapper don't
          resolve reliably, which let the whole page scroll and the chat input scroll
          out of view. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </div>
  );
}
