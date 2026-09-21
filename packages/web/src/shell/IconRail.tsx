import { MessageCircle, Search, Settings, ShieldCheck } from "lucide-react";

export type Module = "chat" | "approvals" | "soul" | "user-profile" | "channel";

export function IconRail({
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
    <nav aria-label="Hlavní navigace" className="flex w-14 shrink-0 flex-col items-center gap-1.5 overflow-y-auto border-r border-border bg-bg-sidebar py-3">
      <RailButton active={module === "chat"} onClick={() => onModule("chat")} title="Chat">
        <MessageCircle size={19} />
      </RailButton>
      <RailButton active={false} onClick={onSearch} title="Hledat">
        <Search size={19} />
      </RailButton>
      <RailButton active={module === "approvals"} onClick={() => onModule("approvals")} title="Schválení" badge={pendingApprovals}>
        <ShieldCheck size={19} />
      </RailButton>

      <span className="flex-1" />

      <RailButton active={false} onClick={onSettings} title="Nastavení">
        <Settings size={19} />
      </RailButton>
    </nav>
  );
}

function RailButton({ active, onClick, title, children, badge }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode; badge?: number }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`pressable relative flex h-11 w-11 items-center justify-center rounded-2xl transition-colors ${
        active ? "bg-accent/[0.14] text-accent" : "text-fg-subtle hover:bg-bg-sunken/70 hover:text-fg"
      }`}
    >
      {children}
      {!!badge && badge > 0 && (
        <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-[700] text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
