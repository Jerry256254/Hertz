import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import type { Agent, ChannelBinding, Project, ProviderConfig } from "../lib/types";
import { IconRail, type Module } from "./IconRail";
import { SideBar } from "./SideBar";
import { ChatView } from "../chat/ChatView";
import { AgentPanel, type AgentTab } from "../panels/AgentPanel";
import { BrowserPanel } from "../panels/BrowserPanel";
import { useApprovals } from "../panels/Approvals";
import { SoulEditor } from "../views/SoulEditor";
import { ChannelView } from "../views/ChannelView";
import { ApprovalsView } from "../views/ApprovalsView";
import { SearchOverlay } from "../overlays/SearchOverlay";
import { SettingsModal } from "../settings/SettingsModal";
import { DirectoryPicker } from "../components/DirectoryPicker";
import { ProviderCreateForm } from "../components/ProviderCreateForm";

export function HertzShell() {
  const queryClient = useQueryClient();
  const [module, setModule] = useState<Module>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [rightPanel, setRightPanel] = useState<"agent" | "browser" | null>(null);
  const [agentTab, setAgentTab] = useState<AgentTab>("activity");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeBinding, setActiveBinding] = useState<ChannelBinding | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const agentQuery = useQuery({
    queryKey: ["agent"],
    queryFn: () => api.get<Agent>("/agent"),
    retry: false,
  });
  const agent = agentQuery.data ?? null;

  const chatQuery = useQuery({
    queryKey: ["main-chat", agent?.id],
    queryFn: () => api.post<{ id: string }>(`/agents/${agent!.id}/ensure-chat`, { projectId: agent!.projectId }),
    enabled: !!agent,
    staleTime: Infinity,
  });
  const mainChatId = chatQuery.data?.id ?? null;

  const { data: approvalsData } = useApprovals();
  const pendingCount = (approvalsData?.approvals ?? []).filter((a) => a.status === "pending").length;

  useEffect(() => {
    if (mainChatId && !activeSessionId) setActiveSessionId(mainChatId);
  }, [mainChatId, activeSessionId]);

  const rename = useMutation({
    mutationFn: (name: string) => api.patch(`/agents/${agent!.id}`, { name }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agent"] }),
  });

  function openAgentPanel(tab: AgentTab = "activity") {
    setAgentTab(tab);
    setRightPanel("agent");
  }

  if (agentQuery.isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-fg-muted">Načítám…</div>;
  }

  if (agentQuery.isError) {
    const status = agentQuery.error instanceof ApiError ? agentQuery.error.status : 0;
    if (status === 404) return <SetupAgentView onDone={() => void queryClient.invalidateQueries({ queryKey: ["agent"] })} />;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-[15px] font-[600] text-fg">Agenta se nepodařilo načíst</p>
        <p className="text-[13px] text-fg-muted">{agentQuery.error instanceof Error ? agentQuery.error.message : "Neznámá chyba"}</p>
        <button onClick={() => void queryClient.invalidateQueries({ queryKey: ["agent"] })} className="pressable rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white">
          Zkusit znovu
        </button>
      </div>
    );
  }

  if (!agent) return null;
  const projectId = agent.projectId;

  const showSidebar = sidebarOpen && (module === "chat" || module === "channel");
  const browserOpen = rightPanel === "browser";

  function selectChat(id: string) {
    setActiveSessionId(id);
    setActiveBinding(null);
    setModule("chat");
  }
  function selectChannel(b: ChannelBinding) {
    setActiveBinding(b);
    setModule("channel");
  }

  return (
    <div className="flex h-full min-h-0 bg-bg">
      <IconRail
        module={module}
        pendingApprovals={pendingCount}
        onModule={(m) => {
          setModule(m);
          if (m === "chat" && mainChatId && !activeSessionId) setActiveSessionId(mainChatId);
        }}
        onSearch={() => setSearchOpen(true)}
        onSettings={() => setSettingsOpen(true)}
      />

      {showSidebar && (
        <>
          <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setSidebarOpen(false)} />
          <aside className="fixed inset-y-0 left-0 z-40 flex w-[300px] max-w-[86vw] animate-slide-in flex-col border-r border-border bg-bg-sidebar md:static md:z-auto md:shrink-0">
            <SideBar
            agent={agent}
            projectId={projectId}
            mainChatId={mainChatId}
            activeSessionId={module === "chat" ? activeSessionId : null}
            activeChannelBinding={module === "channel" ? activeBinding : null}
            onSelectChat={selectChat}
            onSelectChannel={selectChannel}
            onOpenSearch={() => setSearchOpen(true)}
            onClose={() => setSidebarOpen(false)}
          />
          </aside>
        </>
      )}

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {module === "chat" && activeSessionId && (
          <ChatView
            sessionId={activeSessionId}
            agent={agent}
            onOpenPreview={() => setRightPanel(browserOpen ? null : "browser")}
            previewActive={browserOpen}
            onDesktopActivity={() => setRightPanel("browser")}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            onOpenAgent={() => openAgentPanel("identity")}
          />
        )}
        {module === "chat" && !activeSessionId && (
          <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">Připravuji hlavní chat…</div>
        )}
        {module === "channel" && activeBinding && (
          <ChannelView
            agent={agent}
            binding={activeBinding}
            onOpenPreview={() => setRightPanel(browserOpen ? null : "browser")}
            previewActive={browserOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            onOpenAgent={() => openAgentPanel("identity")}
          />
        )}
        {module === "soul" && <SoulEditor agent={agent} onClose={() => setModule("chat")} />}
        {module === "approvals" && <ApprovalsView />}
      </main>

      {rightPanel && (
        <>
          <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setRightPanel(null)} />
          <aside className="fixed inset-y-0 right-0 z-40 flex w-[360px] max-w-[92vw] flex-col border-l border-border bg-bg-sidebar lg:static lg:z-auto lg:shrink-0">
            {rightPanel === "agent" ? (
            <AgentPanel
              agent={agent}
              projectId={projectId}
              tab={agentTab}
              onTabChange={setAgentTab}
              onClose={() => setRightPanel(null)}
              onOpenSoul={() => setModule("soul")}
              onOpenMemory={() => openAgentPanel("memory")}
              onRename={(n) => rename.mutate(n)}
            />
          ) : (
            <BrowserPanel agent={agent} onClose={() => setRightPanel(null)} />
          )}
          </aside>
        </>
      )}

      {searchOpen && (
        <SearchOverlay agent={agent} onClose={() => setSearchOpen(false)} onSelect={selectChat} />
      )}
      {settingsOpen && (
        <SettingsModal agent={agent} projectId={projectId} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

/** First-run wizard: provider → project → the single agent. Shown when GET /api/agent 404s. */
function SetupAgentView({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [providerId, setProviderId] = useState("");
  const [projectName, setProjectName] = useState("Můj projekt");
  const [rootPath, setRootPath] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [agentName, setAgentName] = useState("Orion");
  const [model, setModel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: providersData } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers"),
  });
  const { data: projectsData } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/projects"),
  });
  const providers = providersData?.providers ?? [];
  const projects = projectsData?.projects ?? [];
  const [projectId, setProjectId] = useState("");

  useEffect(() => {
    if (!providerId && providers.length > 0) {
      setProviderId(providers[0]!.id);
      if (!model && providers[0]!.defaultModel) setModel(providers[0]!.defaultModel);
    }
  }, [providers, providerId, model]);
  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  async function finish() {
    setErr(null);
    setBusy(true);
    try {
      let pid = projectId;
      if (!pid) {
        if (!rootPath) throw new Error("Vyber složku projektu.");
        const created = await api.post<{ id: string }>("/projects", { name: projectName.trim() || "Můj projekt", rootPath });
        pid = created.id;
      }
      if (!providerId) throw new Error("Přidej nejdřív poskytovatele v Nastavení › Poskytovatelé (nebo se vrať).");
      if (!model.trim()) throw new Error("Zadej model, např. claude-sonnet-4-5.");
      await api.post("/agent/ensure", { projectId: pid, providerConfigId: providerId, model: model.trim(), name: agentName.trim() || "Orion" });
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const inputCls = "h-11 w-full rounded-full border border-border bg-bg-sunken px-4 text-[14px] text-fg outline-none focus:border-accent disabled:opacity-50";

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg px-4 py-8">
      <div className="w-full max-w-[480px] rounded-[24px] border border-border bg-bg-raised p-6 md:p-8">
        <p className="text-[11px] font-[700] tracking-[0.14em] text-fg-subtle">HERTZ · DOKONČIT NASTAVENÍ</p>
        <h1 className="mt-1 text-[22px] font-[700] tracking-[-0.02em]">
          {step === 0 ? "Vyber poskytovatele" : step === 1 ? "Vyber projekt" : "Pojmenuj agenta"}
        </h1>

        {step === 0 && (
          <div className="mt-5">
            {providers.length === 0 ? (
              <>
                <p className="mb-3 text-[13px] leading-relaxed text-fg-muted">Zatím nemáš žádného poskytovatele — přidej prvního:</p>
                <ProviderCreateForm onCreated={(id, defaultModel) => { setProviderId(id); if (defaultModel) setModel(defaultModel); }} />
              </>
            ) : (
              <select value={providerId} onChange={(e) => { setProviderId(e.target.value); const p = providers.find((x) => x.id === e.target.value); setModel(p?.defaultModel ?? ""); }} className={inputCls}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.label} ({p.provider})</option>
                ))}
              </select>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="mt-5 space-y-3">
            {projects.length > 0 && (
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputCls}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
                <option value="">+ Nový projekt…</option>
              </select>
            )}
            {(projects.length === 0 || projectId === "") && (
              <>
                <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Název projektu" className={inputCls} />
                <div className="flex gap-2">
                  <input value={rootPath} readOnly placeholder="Složka projektu…" className={`${inputCls} mono`} />
                  <button onClick={() => setPickerOpen(true)} className="pressable shrink-0 rounded-full border border-border bg-bg-sunken px-4 text-[13px] font-[600]">Vybrat…</button>
                </div>
              </>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="mt-5 space-y-3">
            <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Jméno agenta" className={inputCls} />
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model, např. claude-sonnet-4-5" className={`${inputCls} mono`} />
          </div>
        )}

        {err && <p className="mt-4 rounded-[14px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">{err}</p>}

        <div className="mt-6 flex gap-2">
          {step > 0 && (
            <button onClick={() => setStep(step - 1)} className="pressable rounded-full border border-border bg-bg-sunken px-5 py-2.5 text-[13.5px] font-[600]">Zpět</button>
          )}
          {step < 2 ? (
            <button onClick={() => setStep(step + 1)} disabled={step === 0 && providers.length === 0} className="pressable flex-1 rounded-full bg-accent py-2.5 text-[13.5px] font-[600] text-white disabled:opacity-40">
              Pokračovat
            </button>
          ) : (
            <button onClick={() => void finish()} disabled={busy} className="pressable flex-1 rounded-full bg-accent py-2.5 text-[13.5px] font-[600] text-white disabled:opacity-40">
              {busy ? "Vytvářím…" : "Vytvořit agenta"}
            </button>
          )}
        </div>
      </div>
      <DirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} onSelect={setRootPath} />
    </div>
  );
}

