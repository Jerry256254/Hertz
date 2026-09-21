import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Monitor, Terminal } from "lucide-react";
import { api } from "../lib/api";
import type { Agent } from "../lib/types";
import { FileExplorer } from "../components/FileExplorer";
import { ShellsPanel } from "../components/ShellsPanel";
import { BrowserPanel } from "../panels/BrowserPanel";

/** Počítač — files, shells and live desktop in one module. */
export function ComputerView({ agent, projectId, bare = false }: { agent: Agent; projectId: string; bare?: boolean }) {
  const [tab, setTab] = useState<"files" | "shells" | "desktop">("files");
  const { data: computer, isError: computerError, refetch: refetchComputer } = useQuery({
    queryKey: ["computer", agent.id],
    queryFn: () => api.get<{ backend: string; status: string; error?: string }>(`/agents/${agent.id}/computer`),
    refetchInterval: 15000,
  });

  function statusLine() {
    if (computer) return `${computer.backend} · ${computer.status}${computer.error ? ` · ${computer.error}` : ""}`;
    if (computerError) {
      return (
        <span>
          Stav se nepodařilo načíst.{" "}
          <button onClick={() => refetchComputer()} className="font-[600] text-accent hover:underline">
            Zkusit znovu
          </button>
        </span>
      );
    }
    return "Načítám stav…";
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!bare ? (
        <header className="safe-top flex h-14 shrink-0 items-center gap-2.5 px-3 sm:h-[60px] sm:gap-3 md:px-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success-wash text-success"><Monitor size={18} /></span>
          <div className="min-w-0">
            <p className="text-[16px] font-[700] tracking-[-0.02em] text-fg">Počítač</p>
            <p className="truncate text-[12px] text-fg-muted">{statusLine()}</p>
          </div>
          <span className="flex-1" />
          <div className="flex shrink-0 gap-1 rounded-full border border-border bg-bg-raised p-1">
            <ComputerTab active={tab === "files"} onClick={() => setTab("files")} icon={<FolderOpen size={14} />} label="Soubory" />
            <ComputerTab active={tab === "shells"} onClick={() => setTab("shells")} icon={<Terminal size={14} />} label="Terminály" />
            <ComputerTab active={tab === "desktop"} onClick={() => setTab("desktop")} icon={<Monitor size={14} />} label="Obrazovka" />
          </div>
        </header>
      ) : (
        <div className="shrink-0 pb-2">
          <p className="px-1 pb-1.5 text-[12px] text-fg-muted">
            {statusLine()}
          </p>
          <div className="flex gap-1 rounded-full border border-border bg-bg-raised p-1">
            <ComputerTab active={tab === "files"} onClick={() => setTab("files")} icon={<FolderOpen size={14} />} label="Soubory" />
            <ComputerTab active={tab === "shells"} onClick={() => setTab("shells")} icon={<Terminal size={14} />} label="Terminály" />
            <ComputerTab active={tab === "desktop"} onClick={() => setTab("desktop")} icon={<Monitor size={14} />} label="Obrazovka" />
          </div>
        </div>
      )}
      <div className={`min-h-0 flex-1 overflow-hidden ${bare ? "" : "px-3 pb-3 md:px-5"}`}>
        <div className={`overflow-hidden border border-border bg-bg-raised ${bare ? "h-[420px] rounded-[16px]" : "h-full rounded-[20px]"}`}>
          {tab === "files" && <FileExplorer projectId={projectId} />}
          {tab === "shells" && (
            <div className="h-full overflow-y-auto p-3">
              <ShellsPanel agentId={agent.id} />
            </div>
          )}
          {tab === "desktop" && <BrowserPanel agent={agent} onClose={() => setTab("files")} />}
        </div>
      </div>
    </div>
  );
}

function ComputerTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className={`pressable flex min-h-[44px] items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-[600] ${active ? "bg-bg-sunken text-fg" : "text-fg-subtle hover:text-fg-muted"}`}>
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
