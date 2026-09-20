import { Lightbulb, MessageCircle, Monitor, Newspaper, Search, Settings, ShieldCheck } from "lucide-react";
import type { Agent } from "../lib/types";
import { AgentAvatar } from "../components/AgentAvatar";

export type Module = "chat" | "feed" | "memory" | "approvals" | "computer" | "soul" | "channel";

export function IconRail({
  module,
  agent,
  pendingApprovals,
  onModule,
  onSearch,
  onSettings,
  onIdentity,
}: {
  module: Module;
  agent: Agent;
  pendingApprovals: number;
  onModule: (m: Module) => void;
  onSearch: () => void;
  onSettings: () => void;
  onIdentity: () => void;
}) {
  return (
    <nav className="flex w-[64px] shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border bg-bg-sidebar py-3">
      <RailButton active={module === "chat"} onClick={() => onModule("chat")} title="Chat">
        <MessageCircle size={19} />
      </RailButton>
      <RailButton active={false} onClick={onSearch} title="Hledat">
        <Search size={19} />
      </RailButton>
      <RailButton active={module === "feed"} onClick={() => onModule("feed")} title="Kanál příspěvků">
        <Newspaper size={19} />
      </RailButton>
      <RailButton active={module === "memory"} onClick={() => onModule("memory")} title="Paměť">
        <Lightbulb size={19} />
      </RailButton>
      <RailButton active={module === "approvals"} onClick={() => onModule("approvals")} title="Schválení" badge={pendingApprovals}>
        <ShieldCheck size={19} />
      </RailButton>
      <RailButton active={module === "computer"} onClick={() => onModule("computer")} title="Počítač">
        <Monitor size={19} />
      </RailButton>

      <span className="flex-1" />

      <button onClick={onIdentity} title={agent.name} className="pressable mb-1 rounded-[12px] border-2 border-transparent hover:border-accent">
        <AgentAvatar seed={agent.id} size={34} />
      </button>
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
      className={`pressable relative flex h-11 w-11 items-center justify-center rounded-full ${active ? "bg-bg-sunken text-fg" : "text-fg-subtle hover:bg-bg-sunken/60 hover:text-fg-muted"}`}
    >
      {children}
      {!!badge && badge > 0 && (
        <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-[700] text-white">
          {badge}
        </span>
      )}
    </button>
  );
}
