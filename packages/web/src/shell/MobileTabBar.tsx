import { MessageCircle, Search, Settings, ShieldCheck } from "lucide-react";
import type { Module } from "./IconRail";

/**
 * Spodní lišta pro telefony — nahrazuje desktopový IconRail.
 * Čtyři popsané záložky na dosah palce, s respektem k safe-area.
 */
export function MobileTabBar({
  module,
  pendingApprovals,
  onModule,
  onSearch,
  onSettings,
}: {
  module: Module;
  pendingApprovals: number;
  onModule: (m: Module) => void;
  onSearch: () => void;
  onSettings: () => void;
}) {
  return (
    <nav aria-label="Hlavní navigace" className="safe-bottom flex shrink-0 items-stretch border-t border-border bg-bg-sidebar md:hidden">
      <Tab active={module === "chat"} onClick={() => onModule("chat")} label="Chat">
        <MessageCircle size={21} />
      </Tab>
      <Tab active={false} onClick={onSearch} label="Hledat">
        <Search size={21} />
      </Tab>
      <Tab active={module === "approvals"} onClick={() => onModule("approvals")} label="Schválení" badge={pendingApprovals}>
        <ShieldCheck size={21} />
      </Tab>
      <Tab active={false} onClick={onSettings} label="Nastavení">
        <Settings size={21} />
      </Tab>
    </nav>
  );
}

function Tab({ active, onClick, label, badge, children }: { active: boolean; onClick: () => void; label: string; badge?: number; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`relative flex min-h-[60px] flex-1 flex-col items-center justify-center gap-1 text-[10.5px] font-[600] transition-colors ${
        active ? "text-accent" : "text-fg-muted"
      }`}
    >
      {children}
      {label}
      {!!badge && badge > 0 && (
        <span className="absolute right-[calc(50%-20px)] top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-[700] text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
