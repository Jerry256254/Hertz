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
      <div className="fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-bg/85 backdrop-blur-[12px] md:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className="ml-3 flex h-9 w-9 items-center justify-center rounded-[10px] text-fg-muted hover:bg-bg-hover hover:text-fg active:scale-[0.97]"
          aria-label="Open menu"
        >
          <Menu size={18} strokeWidth={1.9} />
        </button>
        <span className="text-[15px] font-[650] tracking-[-0.02em] text-fg">Hertz</span>
        <span className="text-[11px] font-medium tracking-wide text-fg-subtle">workspace</span>
      </div>
      <div className="h-14 shrink-0 md:hidden" aria-hidden="true" />

      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[2px] md:hidden" onClick={() => setMobileOpen(false)} aria-hidden="true" />
      )}
      <div
        className={`fixed inset-y-0 left-0 z-40 w-[288px] transform border-r border-border bg-bg-sidebar transition-transform duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] will-change-transform md:static md:translate-x-0 md:shadow-none ${
          mobileOpen ? "translate-x-0 shadow-[8px_0_32px_rgba(0,0,0,0.18)]" : "-translate-x-full"
        }`}
      >
        <Sidebar onClose={() => setMobileOpen(false)} />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-bg">{children}</div>
    </div>
  );
}
