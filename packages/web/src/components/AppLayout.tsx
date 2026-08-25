import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Menu } from "lucide-react";
import { Sidebar } from "./Sidebar";

export function AppLayout({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  return (
    <div className="flex h-full min-h-0 bg-bg">
      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-20 flex h-[52px] items-center gap-3 border-b border-border bg-bg-raised/90 px-3 backdrop-blur-[10px] md:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-border text-fg hover:bg-bg-hover active:scale-[0.97]"
          aria-label="Otevřít menu"
        >
          <Menu size={16} strokeWidth={1.9} />
        </button>
        <span className="mono text-[12px] font-[600] tracking-[0.14em] text-fg">HERTZ</span>
        <span className="h-3 w-px bg-border" />
        <span className="text-[12.5px] font-[500] tracking-[-0.01em] text-fg-muted">workspace</span>
      </div>
      <div className="h-[52px] shrink-0 md:hidden" aria-hidden />

      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-[#11110E]/20 backdrop-blur-[2px] md:hidden" onClick={() => setMobileOpen(false)} aria-hidden />
      )}

      <div
        className={`fixed inset-y-0 left-0 z-40 w-[288px] overflow-hidden border-r border-border bg-bg-sidebar transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)] will-change-transform md:static md:translate-x-0 md:shadow-none ${mobileOpen ? "translate-x-0 shadow-lg" : "-translate-x-full"}`}
      >
        <Sidebar onClose={() => setMobileOpen(false)} />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-bg">
        {children}
      </div>
    </div>
  );
}
