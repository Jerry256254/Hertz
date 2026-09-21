import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import type { Agent, ChannelBinding, Project, ProviderConfig } from "../lib/types";
import { Button, Input, Label } from "../components/ui";
import { AgentAvatar } from "../components/AgentAvatar";
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
import { SettingsModal, type Section as SettingsSection } from "../settings/SettingsModal";
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("agent");

  // OAuth round-trip: the provider redirects back to /?connected= / ?oauthError= —
  // open Nastavení → Integrace so the user sees the result immediately.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.has("connected") || q.has("oauthError")) {
      setSettingsSection("connectors");
      setSettingsOpen(true);
    }
  }, []);

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
          <aside className="fixed inset-y-0 left-0 z-40 flex w-[320px] max-w-[86vw] animate-slide-in flex-col border-r border-border bg-bg-sidebar md:static md:z-auto md:shrink-0">
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
        <SettingsModal agent={agent} projectId={projectId} initialSection={settingsSection} onClose={() => { setSettingsOpen(false); setSettingsSection("agent"); }} />
      )}
    </div>
  );
}

/** Průvodce prvním spuštěním: model → jména → hotovo s avatarem. Bez projektů. */
function SetupAgentView({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [providerId, setProviderId] = useState("");
  const [agentName, setAgentName] = useState("");
  const [userName, setUserName] = useState("");
  const [model, setModel] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [avatarNonce, setAvatarNonce] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: providersData } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers"),
  });
  const providers = providersData?.providers ?? [];

  useEffect(() => {
    if (!providerId && providers.length > 0) {
      setProviderId(providers[0]!.id);
      if (!model && providers[0]!.defaultModel) setModel(providers[0]!.defaultModel);
    }
  }, [providers, providerId, model]);

  /**
   * Pracovní prostor pro agenta se zajistí tiše na pozadí — uživatel
   * o žádném „projektu" neví. Existující se použije, jinak vznikne ~/Hertz.
   */
  async function resolveWorkspaceId(): Promise<string> {
    try {
      const { projects } = await api.get<{ projects: Project[] }>("/projects");
      if (projects[0]) return projects[0].id;
    } catch {
      /* spadneme k vytvoření nového */
    }
    const browse = await api.get<{ path: string; home: string; entries: Array<{ name: string; path: string }> }>(
      `/fs/browse?path=${encodeURIComponent("")}`,
    );
    let rootPath = browse.home;
    const existing = browse.entries.find((e) => e.name === "Hertz");
    if (existing) {
      rootPath = existing.path;
    } else {
      try {
        const created = await api.post<{ path: string }>("/fs/mkdir", { path: browse.home, name: "Hertz" });
        rootPath = created.path;
      } catch {
        rootPath = browse.home;
      }
    }
    const created = await api.post<{ id: string }>("/projects", { name: "Hertz", rootPath });
    return created.id;
  }

  function mintAvatarSeed(name: string): string {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const base = (name || "agent").trim().toLowerCase().slice(0, 40) || "agent";
    return `${base}:${hex}`;
  }

  async function rerollAvatar() {
    if (!agentId || busy) return;
    setErr(null);
    setBusy(true);
    try {
      const seed = mintAvatarSeed(agentName);
      await api.patch(`/agents/${agentId}`, { avatar: JSON.stringify({ version: 1, kind: "generative", seed }) });
      setAvatarNonce((n) => n + 1);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Avatar se nepodařilo vygenerovat.");
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setErr(null);
    if (!providerId) { setErr("Nejdřív přidej poskytovatele."); return; }
    if (!model.trim()) { setErr("Zadej model, např. claude-sonnet-4-5."); return; }
    setBusy(true);
    try {
      const projectId = await resolveWorkspaceId();
      const created = await api.post<{ id: string }>("/agent/ensure", {
        projectId,
        providerConfigId: providerId,
        model: model.trim(),
        name: agentName.trim() || "Orion",
      });
      const seed = mintAvatarSeed(agentName.trim() || "Orion");
      await api.patch(`/agents/${created.id}`, { avatar: JSON.stringify({ version: 1, kind: "generative", seed }) });
      const cleanUser = userName.trim();
      if (cleanUser) {
        try { localStorage.setItem("hertz.userName", cleanUser); } catch { /* private mode */ }
      }
      setAgentId(created.id);
      setAvatarNonce((n) => n + 1);
      setStep(2);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const selectCls =
    "h-11 w-full appearance-none rounded-full border border-border bg-bg-sunken px-4 text-[14px] text-fg outline-none focus:border-accent disabled:opacity-50";
  const finalAgentName = agentName.trim() || "Orion";
  const finalUserName = userName.trim();

  return (
    <div className="flex h-full overflow-y-auto bg-bg">
      <div className="mx-auto flex w-full max-w-[520px] flex-col justify-center px-6 py-12">
        {step < 2 && (
          <p className="text-[11px] font-[700] tracking-[0.18em] text-fg-subtle">
            HERTZ · KROK {step + 1} ZE 2
          </p>
        )}

        {step === 0 && (
          <>
            <h1 className="mt-4 text-[30px] font-[700] leading-[1.15] tracking-[-0.02em] text-fg">
              Jaký model mám používat?
            </h1>
            <p className="mt-3 max-w-[44ch] text-[14.5px] leading-relaxed text-fg-muted">
              Běžím jen u tebe — nic neposílám do cloudu. Vyber poskytovatele a model,
              později ho můžeš kdykoliv změnit v nastavení.
            </p>
            <div className="mt-9 space-y-6">
              <div>
                <Label>POSKYTOVATEL</Label>
                {providers.length === 0 ? (
                  <ProviderCreateForm
                    onCreated={(id, defaultModel) => {
                      setProviderId(id);
                      if (defaultModel) setModel(defaultModel);
                    }}
                  />
                ) : (
                  <select
                    value={providerId}
                    onChange={(e) => {
                      setProviderId(e.target.value);
                      const p = providers.find((x) => x.id === e.target.value);
                      setModel(p?.defaultModel ?? "");
                    }}
                    className={selectCls}
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>{p.label} ({p.provider})</option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <Label>MODEL</Label>
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="např. claude-sonnet-4-5"
                  className="mono"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1 className="mt-4 text-[30px] font-[700] leading-[1.15] tracking-[-0.02em] text-fg">
              Jak se budeme jmenovat?
            </h1>
            <p className="mt-3 max-w-[44ch] text-[14.5px] leading-relaxed text-fg-muted">
              Dej mi jméno — a řekni mi, jak ti mám říkat.
            </p>
            <div className="mt-9 space-y-6">
              <div>
                <Label>JMÉNO AGENTA</Label>
                <Input
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="Orion"
                  autoFocus
                  autoComplete="off"
                  maxLength={80}
                />
              </div>
              <div>
                <Label>TVOJE JMÉNO</Label>
                <Input
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="Jak ti mám říkat?"
                  autoComplete="given-name"
                  maxLength={80}
                />
              </div>
            </div>
          </>
        )}

        {step === 2 && agentId && (
          <div className="flex flex-col items-center text-center">
            <AgentAvatar key={avatarNonce} seed={agentId} size={104} />
            <h1 className="mt-7 text-[30px] font-[700] leading-[1.15] tracking-[-0.02em] text-fg">
              Těší mě{finalUserName ? `, ${finalUserName}` : ""}.
            </h1>
            <p className="mt-3 max-w-[40ch] text-[14.5px] leading-relaxed text-fg-muted">
              Jsem {finalAgentName} — tvůj osobní agent. Tady je můj vzhled,
              vygenerovaný jen pro tebe.
            </p>
            <button
              onClick={() => void rerollAvatar()}
              disabled={busy}
              className="pressable mt-5 rounded-full border border-border bg-bg-sunken px-5 py-2 text-[13px] font-[600] text-fg-muted hover:text-fg disabled:opacity-50"
            >
              {busy ? "Generuji…" : "Vygenerovat jiný vzhled"}
            </button>
          </div>
        )}

        {err && (
          <p className="mt-6 rounded-[14px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">
            {err}
          </p>
        )}

        <div className="mt-9 flex gap-2">
          {step === 1 && (
            <Button variant="secondary" size="lg" onClick={() => setStep(0)} disabled={busy}>
              Zpět
            </Button>
          )}
          {step === 0 && (
            <Button
              variant="primary"
              size="lg"
              className="flex-1"
              disabled={!providerId || busy}
              onClick={() => setStep(1)}
            >
              Pokračovat
            </Button>
          )}
          {step === 1 && (
            <Button variant="primary" size="lg" className="flex-1" disabled={busy} onClick={() => void finish()}>
              {busy ? "Chystám…" : "Vytvořit agenta"}
            </Button>
          )}
          {step === 2 && (
            <Button variant="primary" size="lg" className="flex-1" onClick={onDone}>
              Začít
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
