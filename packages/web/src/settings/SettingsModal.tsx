import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell, Blocks, ChevronRight, FolderOpen, HeartHandshake, Landmark, LogOut,
  Pencil, Plus, Scale, Send, Server, ShieldCheck, Trash2, Wallet, X,
} from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Agent, ApprovalItem, ChannelConfig, McpServer, MountList, ProviderConfig, Routine, UsageRecord } from "../lib/types";
import { relTime } from "../lib/format";
import { DirectoryPicker } from "../components/DirectoryPicker";
import { ModelFields } from "../components/ModelFields";
import { ProviderCreateForm } from "../components/ProviderCreateForm";
import { AgentAvatar } from "../components/AgentAvatar";
import { ApprovalCard } from "../panels/Approvals";

type Section = "general" | "folders" | "providers" | "permissions" | "channels" | "connectors" | "wallet" | "data" | "help" | "legal";

const NAV: Array<{ id: Section; label: string; icon: React.ReactNode; admin?: boolean }> = [
  { id: "general", label: "Obecné", icon: <Bell size={15} /> },
  { id: "folders", label: "Složky", icon: <FolderOpen size={15} /> },
  { id: "providers", label: "Poskytovatelé", icon: <Server size={15} /> },
  { id: "permissions", label: "Oprávnění", icon: <ShieldCheck size={15} /> },
  { id: "channels", label: "Kanály zpráv", icon: <Send size={15} /> },
  { id: "connectors", label: "Konektory", icon: <Blocks size={15} /> },
  { id: "wallet", label: "Peněženka", icon: <Wallet size={15} /> },
  { id: "data", label: "Nastavení dat", icon: <Landmark size={15} /> },
  { id: "help", label: "Nápověda a podpora", icon: <HeartHandshake size={15} /> },
  { id: "legal", label: "Právní údaje", icon: <Scale size={15} /> },
];

export function SettingsModal({ agent, projectId, initialSection = "general", onClose }: { agent: Agent; projectId: string; initialSection?: Section; onClose: () => void }) {
  const [section, setSection] = useState<Section>(initialSection);
  const { logout, user } = useAuth();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" style={{ backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div className="flex max-h-[86vh] w-full max-w-[880px] overflow-hidden rounded-[24px] border border-border bg-bg-sidebar shadow-popover animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex w-[220px] shrink-0 flex-col border-r border-border bg-bg-sidebar p-2.5 max-sm:hidden">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {NAV.map((n) => (
              <button
                key={n.id}
                onClick={() => setSection(n.id)}
                className={`flex w-full items-center gap-2.5 rounded-[12px] px-3 py-2 text-left text-[13.5px] ${section === n.id ? "bg-bg-sunken font-[600] text-fg" : "text-fg-muted hover:bg-bg-sunken/50 hover:text-fg"}`}
              >
                <span className="shrink-0">{n.icon}</span>
                {n.label}
              </button>
            ))}
          </div>
          <button onClick={() => void logout()} className="mt-2 flex w-full items-center gap-2.5 rounded-[12px] px-3 py-2 text-left text-[13.5px] text-fg-muted hover:bg-bg-sunken/50 hover:text-danger">
            <LogOut size={15} /> Odhlásit se
          </button>
          <p className="truncate px-3 pb-1 pt-2 text-[11px] text-fg-subtle">{user?.email}</p>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
          <div className="flex shrink-0 items-center justify-between px-5 pb-1 pt-4">
            <p className="text-[16px] font-[700] tracking-[-0.02em] text-fg">{NAV.find((n) => n.id === section)?.label}</p>
            <button onClick={onClose} className="rounded-full p-2 text-fg-muted hover:bg-bg-sunken hover:text-fg"><X size={17} /></button>
          </div>
          <div className="flex gap-1 overflow-x-auto border-b border-border px-5 pb-2.5 sm:hidden">
            {NAV.map((n) => (
              <button key={n.id} onClick={() => setSection(n.id)} className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-[600] ${section === n.id ? "bg-bg-sunken text-fg" : "text-fg-subtle"}`}>
                {n.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-3">
            {section === "general" && <GeneralSection agent={agent} />}
            {section === "folders" && <FoldersSection projectId={projectId} />}
            {section === "providers" && <ProvidersSection agent={agent} />}
            {section === "permissions" && <PermissionsSection onNavigate={setSection} />}
            {section === "channels" && <ChannelsSection agent={agent} />}
            {section === "connectors" && <ConnectorsSection agent={agent} />}
            {section === "wallet" && <WalletSection />}
            {section === "data" && <DataSection agent={agent} projectId={projectId} />}
            {section === "help" && <HelpSection />}
            {section === "legal" && <LegalSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-4">
      <p className="mb-1.5 text-[12px] font-[600] text-fg-muted">{label}</p>
      {children}
      {hint && <p className="mt-1 text-[12px] leading-snug text-fg-subtle">{hint}</p>}
    </div>
  );
}

const inputCls = "h-10 w-full rounded-full border border-border bg-bg-raised px-4 text-[13.5px] text-fg outline-none focus:border-accent disabled:opacity-50";

/* ── Obecné ─────────────────────────────────────────────────────────── */

function GeneralSection({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState(agent.model);
  const [providerId, setProviderId] = useState(agent.providerConfigId);
  const [heartbeat, setHeartbeat] = useState(String(agent.heartbeatMinutes));
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // The server can correct the stored model mid-run (stale id → scanned
  // fallback); keep the form in sync so it never shows a dead value.
  useEffect(() => {
    setName(agent.name);
    setModel(agent.model);
    setProviderId(agent.providerConfigId);
    setHeartbeat(String(agent.heartbeatMinutes));
  }, [agent.id, agent.name, agent.model, agent.providerConfigId, agent.heartbeatMinutes]);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/agents/${agent.id}`, {
        name: name.trim() || agent.name,
        model: model.trim() || agent.model,
        providerConfigId: providerId,
        heartbeatMinutes: Math.max(0, Math.min(10080, Number.parseInt(heartbeat, 10) || 0)),
      }),
    onSuccess: () => {
      setMsg("Uloženo ✓");
      setErr(null);
      setTimeout(() => setMsg(null), 2000);
      void queryClient.invalidateQueries({ queryKey: ["agent"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Uložení selhalo"),
  });

  return (
    <div className="max-w-[520px]">
      <div className="mb-4 flex items-center gap-3 rounded-[16px] border border-border bg-bg-raised px-4 py-3">
        <AgentAvatar seed={agent.id} size={48} />
        <div className="min-w-0">
          <p className="truncate text-[14px] font-[700] tracking-[-0.01em] text-fg">{agent.name}</p>
          <p className="mono truncate text-[12px] text-fg-muted">{agent.model}</p>
        </div>
      </div>
      <Field label="Jméno agenta">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      </Field>
      <Field label="Poskytovatel a model" hint="Kde se platí za modely. Nového poskytovatele přidáš v záložce Poskytovatelé.">
        <div className="rounded-[16px] border border-border bg-bg-raised p-3">
          <ModelFields providerId={providerId} onProviderIdChange={setProviderId} model={model} onModelChange={setModel} idPrefix="settings" />
        </div>
      </Field>
      <Field label="Heartbeat (minut)" hint="Jak často se agent sám probudí a zkontroluje práci. 0 = vypnuto.">
        <input value={heartbeat} onChange={(e) => setHeartbeat(e.target.value)} inputMode="numeric" className={inputCls} />
      </Field>
      {err && <p className="mb-3 text-[13px] text-danger">{err}</p>}
      <button onClick={() => save.mutate()} disabled={save.isPending} className="pressable rounded-full bg-accent px-6 py-2.5 text-[13.5px] font-[600] text-white disabled:opacity-40">
        {save.isPending ? "Ukládám…" : msg ?? "Uložit změny"}
      </button>
    </div>
  );
}

/* ── Složky (mounts) ────────────────────────────────────────────────── */

function FoldersSection({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [hostPath, setHostPath] = useState("");
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string; purpose: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["mounts", projectId],
    queryFn: () => api.get<MountList>(`/projects/${projectId}/mounts`),
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["mounts", projectId] });
  }

  const create = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/mounts`, { name: name.trim(), hostPath, purpose: purpose.trim() || undefined }),
    onSuccess: () => {
      setShowAdd(false);
      setHostPath("");
      setName("");
      setPurpose("");
      setErr(null);
      refresh();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Přidání selhalo"),
  });
  const patch = useMutation({
    mutationFn: () => api.patch(`/mounts/${editing!.id}`, { name: editing!.name.trim(), purpose: editing!.purpose.trim() || null }),
    onSuccess: () => {
      setEditing(null);
      setErr(null);
      refresh();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Uložení selhalo"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/mounts/${id}`),
    onSuccess: () => {
      setErr(null);
      refresh();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Smazání selhalo"),
  });

  return (
    <div className="max-w-[560px]">
      <p className="mb-4 text-[13px] leading-relaxed text-fg-muted">
        Trvalé složky z tvého počítače, které agent vidí ve svém. Změny se projeví po restartu jeho kontejneru.
      </p>
      {isLoading && <p className="text-[13px] text-fg-subtle">Načítám…</p>}
      {err && <p className="mb-3 rounded-[14px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">{err}</p>}

      {data?.builtIn && (
        <div className="mb-2 flex items-center gap-3 rounded-[16px] border border-border bg-bg-raised px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success-wash text-success"><FolderOpen size={15} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-[600] text-fg">{data.builtIn.name} <span className="ml-1 rounded-full bg-bg-sunken px-2 py-0.5 text-[10.5px] font-[700] text-fg-muted">VESTAVĚNÁ</span></p>
            <p className="mono truncate text-[12px] text-fg-muted">{data.builtIn.hostPath}</p>
          </div>
        </div>
      )}

      {(data?.mounts ?? []).map((m) =>
        editing?.id === m.id ? (
          <div key={m.id} className="mb-2 space-y-2 rounded-[16px] border border-accent/40 bg-bg-raised p-3.5">
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Název viditelný agentovi" className={inputCls} />
            <input value={editing.purpose} onChange={(e) => setEditing({ ...editing, purpose: e.target.value })} placeholder="Účel (k čemu složka je)" className={inputCls} />
            <p className="mono truncate px-1 text-[11.5px] text-fg-subtle" title={m.hostPath}>{m.hostPath} (cestu nelze měnit — smaž a vytvoř znovu)</p>
            <div className="flex gap-2">
              <button onClick={() => patch.mutate()} disabled={patch.isPending || !editing.name.trim()} className="pressable rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40">Uložit</button>
              <button onClick={() => setEditing(null)} className="pressable rounded-full border border-border bg-bg-sunken px-5 py-2 text-[13px] font-[600] text-fg">Zrušit</button>
            </div>
          </div>
        ) : (
          <div key={m.id} className="mb-2 flex items-center gap-3 rounded-[16px] border border-border bg-bg-raised px-4 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-wash text-accent"><FolderOpen size={15} /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-[600] text-fg">{m.name}</p>
              <p className="mono truncate text-[12px] text-fg-muted">{m.hostPath}</p>
              {m.purpose && <p className="truncate text-[12px] text-fg-subtle">{m.purpose}</p>}
            </div>
            <button onClick={() => setEditing({ id: m.id, name: m.name, purpose: m.purpose ?? "" })} title="Přejmenovat / popsat" className="rounded-full p-2 text-fg-subtle hover:bg-bg-sunken hover:text-fg"><Pencil size={14} /></button>
            <button onClick={() => { if (window.confirm(`Opravdu smazat složku „${m.name}"? Agent ji přestane vidět (po restartu kontejneru).`)) remove.mutate(m.id); }} title="Smazat" className="rounded-full p-2 text-fg-subtle hover:bg-bg-sunken hover:text-danger"><Trash2 size={14} /></button>
          </div>
        ),
      )}

      {showAdd ? (
        <div className="mt-3 space-y-2.5 rounded-[16px] border border-accent/40 bg-bg-raised p-4">
          <Field label="Složka na tvém počítači">
            <div className="flex gap-2">
              <input value={hostPath} readOnly placeholder="Vyber tlačítkem…" className={`${inputCls} mono`} />
              <button onClick={() => setPickerOpen(true)} className="pressable shrink-0 rounded-full border border-border bg-bg-sunken px-4 text-[13px] font-[600] text-fg">Vybrat…</button>
            </div>
          </Field>
          <Field label="Název viditelný agentovi" hint="Krátký název bez mezer, např. fotky.">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="např. fotky" className={inputCls} />
          </Field>
          <Field label="Účel (nepovinné)">
            <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="K čemu agent složku má" className={inputCls} />
          </Field>
          <div className="flex gap-2">
            <button onClick={() => create.mutate()} disabled={create.isPending || !hostPath || !name.trim()} className="pressable rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40">Přidat složku</button>
            <button onClick={() => setShowAdd(false)} className="pressable rounded-full border border-border bg-bg-sunken px-5 py-2 text-[13px] font-[600] text-fg">Zrušit</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} className="pressable mt-3 flex items-center gap-2 rounded-full border border-border bg-bg-raised px-5 py-2.5 text-[13.5px] font-[600] text-fg hover:bg-bg-hover">
          <Plus size={15} /> Přidat složku
        </button>
      )}

      <DirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} onSelect={(p) => { setHostPath(p); if (!name) { const base = p.split("/").filter(Boolean).pop() ?? ""; setName(base.toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 32)); } }} />
    </div>
  );
}

/* ── Poskytovatelé ──────────────────────────────────────────────────── */

function ProvidersSection({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers"),
  });
  const providers = data?.providers ?? [];

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/providers/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["providers"] }),
  });
  const useForAgent = useMutation({
    mutationFn: (p: ProviderConfig) =>
      api.patch(`/agents/${agent.id}`, { providerConfigId: p.id, ...(p.defaultModel ? { model: p.defaultModel } : {}) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent"] });
      setErr(null);
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Přepnutí selhalo"),
  });

  return (
    <div className="max-w-[560px]">
      <p className="mb-4 text-[13px] leading-relaxed text-fg-muted">
        Kde agent bere modely. Agent právě používá model <span className="mono text-fg">{agent.model}</span>.
      </p>
      {err && <p className="mb-3 rounded-[14px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">{err}</p>}
      {providers.map((p) => (
        <div key={p.id} className={`mb-2 flex items-center gap-3 rounded-[16px] border bg-bg-raised px-4 py-3 ${p.id === agent.providerConfigId ? "border-accent/50" : "border-border"}`}>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-[600] text-fg">
              {p.label}
              {p.id === agent.providerConfigId && <span className="ml-2 rounded-full bg-accent-wash px-2 py-0.5 text-[10.5px] font-[700] text-accent">AKTIVNÍ</span>}
            </p>
            <p className="mono truncate text-[12px] text-fg-muted">{p.provider} · {p.keyHint} · {p.keyCount} {p.keyCount === 1 ? "klíč" : p.keyCount < 5 ? "klíče" : "klíčů"}{p.defaultModel ? ` · ${p.defaultModel}` : ""}</p>
          </div>
          {p.id !== agent.providerConfigId && (
            <button onClick={() => useForAgent.mutate(p)} title="Použít pro agenta" className="pressable shrink-0 rounded-full border border-border bg-bg-sunken px-3.5 py-1.5 text-[12px] font-[600] text-fg hover:bg-bg-hover">
              Použít
            </button>
          )}
          <button onClick={() => { if (window.confirm(`Smazat poskytovatele „${p.label}"?`)) remove.mutate(p.id); }} title="Smazat" className="rounded-full p-2 text-fg-subtle hover:bg-bg-sunken hover:text-danger"><Trash2 size={14} /></button>
        </div>
      ))}

      {showAdd ? (
        <div className="mt-3 rounded-[16px] border border-accent/40 bg-bg-raised p-4">
          <ProviderCreateForm
            submitLabel="Přidat"
            onCreated={() => {
              setShowAdd(false);
              setErr(null);
            }}
            onCancel={() => setShowAdd(false)}
          />
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} className="pressable mt-3 flex items-center gap-2 rounded-full border border-border bg-bg-raised px-5 py-2.5 text-[13.5px] font-[600] text-fg hover:bg-bg-hover">
          <Plus size={15} /> Přidat poskytovatele
        </button>
      )}
    </div>
  );
}

/* ── Oprávnění ──────────────────────────────────────────────────────── */

function PermissionsSection({ onNavigate }: { onNavigate: (s: Section) => void }) {
  const { data: approvalsData } = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<{ approvals: ApprovalItem[] }>("/approvals"),
  });
  const { data: mcpData } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api.get<{ servers: McpServer[] }>("/mcp-servers"),
  });
  const approvals = approvalsData?.approvals ?? [];
  const pending = approvals.filter((a) => a.status === "pending");

  return (
    <div className="max-w-[560px]">
      <p className="mb-4 text-[13px] leading-relaxed text-fg-muted">
        Agent se vždy zeptá, než udělá něco citlivého — napíše žádost a čeká na tvoje rozhodnutí. Zprávy z kanálů a naplánované úlohy běží samy.
      </p>

      {pending.length > 0 && (
        <div className="mb-4 space-y-2.5">
          <p className="text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">ČEKÁ NA ROZHODNUTÍ ({pending.length})</p>
          {pending.map((a) => <ApprovalCard key={a.id} approval={a} compact />)}
        </div>
      )}

      <p className="mb-2 text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">SPRAVOVAT OPRÁVNĚNÍ</p>
      <PermissionRow label="Konektory" count={mcpData?.servers.length ?? 0} onClick={() => onNavigate("connectors")} />
      <PermissionRow label="Schválené žádosti" count={approvals.filter((a) => a.status === "approved").length} />
      <PermissionRow label="Zamítnuté žádosti" count={approvals.filter((a) => a.status === "rejected").length} />
    </div>
  );
}

function PermissionRow({ label, count, onClick }: { label: string; count: number; onClick?: () => void }) {
  return (
    <button onClick={onClick} disabled={!onClick} className="mb-1.5 flex w-full items-center gap-3 rounded-[16px] border border-border bg-bg-raised px-4 py-3 text-left disabled:cursor-default">
      <span className="flex-1 text-[13.5px] font-[600] text-fg">{label}</span>
      <span className="mono text-[13px] text-fg-muted">{count}</span>
      {onClick && <ChevronRight size={16} className="text-fg-subtle" />}
    </button>
  );
}

/* ── Kanály zpráv ───────────────────────────────────────────────────── */

function ChannelsSection({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [kind, setKind] = useState<"telegram" | "discord">("telegram");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const { data, isError } = useQuery({
    queryKey: ["channels"],
    queryFn: () => api.get<{ channels: ChannelConfig[] }>("/channels"),
    retry: false,
  });
  const channels = data?.channels ?? [];

  const create = useMutation({
    mutationFn: () => api.post("/channels", { kind, label: label.trim(), token, defaultAgentId: agent.id }),
    onSuccess: () => {
      setShowAdd(false);
      setLabel("");
      setToken("");
      setErr(null);
      void queryClient.invalidateQueries({ queryKey: ["channels"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Připojení selhalo"),
  });
  const toggle = useMutation({
    mutationFn: (c: ChannelConfig) => api.patch(`/channels/${c.id}`, { enabled: !c.enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["channels"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/channels/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["channels"] }),
  });
  const test = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; botLabel: string }>(`/channels/${id}/test`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["channels"] }),
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Test selhal"),
  });
  const saveLists = useMutation({
    mutationFn: ({ id, allowedChats, allowedSenders }: { id: string; allowedChats: string[]; allowedSenders: string[] }) =>
      api.patch(`/channels/${id}`, { allowedChats, allowedSenders }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["channels"] }),
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Uložení selhalo"),
  });

  if (isError) {
    return <p className="max-w-[520px] text-[13px] leading-relaxed text-fg-muted">Kanály zpráv může spravovat jen administrátor.</p>;
  }

  return (
    <div className="max-w-[560px]">
      <p className="mb-4 text-[13px] leading-relaxed text-fg-muted">
        Chatujte s agentem v jiných aplikacích pro zprávy.
      </p>
      {err && <p className="mb-3 rounded-[14px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">{err}</p>}

      <p className="mb-2 text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">Připojeno</p>
      {channels.length === 0 && <p className="mb-2 text-[13px] text-fg-subtle">Zatím nic nepřipojeno.</p>}
      {channels.map((c) => (
        <ChannelCard
          key={c.id}
          channel={c}
          onToggle={() => toggle.mutate(c)}
          onTest={() => test.mutate(c.id)}
          testing={test.isPending}
          onRemove={() => { if (window.confirm(`Odpojit „${c.label}"?`)) remove.mutate(c.id); }}
          onSaveLists={(allowedChats, allowedSenders) => saveLists.mutate({ id: c.id, allowedChats, allowedSenders })}
          saving={saveLists.isPending}
        />
      ))}

      {showAdd ? (
        <div className="mt-3 space-y-2.5 rounded-[16px] border border-accent/40 bg-bg-raised p-4">
          <Field label="Služba">
            <select value={kind} onChange={(e) => setKind(e.target.value as "telegram" | "discord")} className={inputCls}>
              <option value="telegram">Telegram</option>
              <option value="discord">Discord</option>
            </select>
          </Field>
          <Field label="Název"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="např. Můj Telegram bot" className={inputCls} /></Field>
          <Field label="Token bota" hint="Telegram: od @BotFather. Discord: z developer portálu. Token se ověří hned při uložení.">
            <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="…" className={inputCls} />
          </Field>
          <div className="flex gap-2">
            <button onClick={() => create.mutate()} disabled={create.isPending || !label.trim() || token.length < 10} className="pressable rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40">Připojit</button>
            <button onClick={() => setShowAdd(false)} className="pressable rounded-full border border-border bg-bg-sunken px-5 py-2 text-[13px] font-[600] text-fg">Zrušit</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} className="pressable mt-3 flex items-center gap-2 rounded-full border border-border bg-bg-raised px-5 py-2.5 text-[13.5px] font-[600] text-fg hover:bg-bg-hover">
          <Plus size={15} /> Připojit kanál
        </button>
      )}
    </div>
  );
}

function ChannelCard({
  channel: c,
  onToggle,
  onTest,
  testing,
  onRemove,
  onSaveLists,
  saving,
}: {
  channel: ChannelConfig;
  onToggle: () => void;
  onTest: () => void;
  testing: boolean;
  onRemove: () => void;
  onSaveLists: (allowedChats: string[], allowedSenders: string[]) => void;
  saving: boolean;
}) {
  const [listsOpen, setListsOpen] = useState(false);
  const [chats, setChats] = useState(c.allowedChats.join(", "));
  const [senders, setSenders] = useState((c.allowedSenders ?? []).join(", "));

  const parseList = (raw: string) => raw.split(",").map((x) => x.trim()).filter(Boolean);
  const dirty = parseList(chats).join(",") !== [...c.allowedChats].sort().join(",") || parseList(senders).join(",") !== [...(c.allowedSenders ?? [])].sort().join(",");

  return (
    <div className="mb-2 rounded-[16px] border border-border bg-bg-raised px-4 py-3">
      <div className="flex items-center gap-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${c.kind === "telegram" ? "bg-[#229ed9]/15 text-[#229ed9]" : "bg-[#5865f2]/15 text-[#8b90ff]"}`}>
          <Send size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-[600] text-fg">{c.label}</p>
          <p className="truncate text-[12px] text-fg-muted">
            {c.kind} · {c.botLabel ?? c.tokenHint} · {c.running ? "běží" : c.enabled ? "zapnuto" : "vypnuto"}
          </p>
        </div>
        <button onClick={onToggle} className={`flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 ${c.enabled ? "justify-end bg-live" : "justify-start bg-bg-sunken"}`}>
          <span className="h-5 w-5 rounded-full bg-white shadow" />
        </button>
      </div>
      <div className="mt-2 flex gap-2 pl-12">
        <button onClick={onTest} disabled={testing} className="pressable rounded-full border border-border bg-bg-sunken px-3.5 py-1.5 text-[12px] font-[600] text-fg">Otestovat</button>
        <button onClick={() => setListsOpen((v) => !v)} className="pressable rounded-full border border-border bg-bg-sunken px-3.5 py-1.5 text-[12px] font-[600] text-fg">Kdo smí psát</button>
        <button onClick={onRemove} className="pressable rounded-full border border-border bg-bg-sunken px-3.5 py-1.5 text-[12px] font-[600] text-danger">Odpojit</button>
      </div>
      {listsOpen && (
        <div className="mt-3 space-y-2.5 border-t border-border pl-12 pr-1 pt-3">
          <Field label="Povolené chaty (ID, čárkou; prázdné = všechny)" hint="Telegram: ID chatu zobrazí např. @userinfobot. Discord: ID kanálu.">
            <input value={chats} onChange={(e) => setChats(e.target.value)} placeholder="123456789, -100123456" className={inputCls} />
          </Field>
          <Field label="Povolení odesílatelé (ID nebo @nick, čárkou; prázdné = všichni)" hint="Bot odpoví jen těmto lidem — ostatní dostanou zamítnutí.">
            <input value={senders} onChange={(e) => setSenders(e.target.value)} placeholder="@sefa, 123456789" className={inputCls} />
          </Field>
          <button onClick={() => onSaveLists(parseList(chats), parseList(senders))} disabled={saving || !dirty} className="pressable rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40">
            {saving ? "Ukládám…" : "Uložit seznamy"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Konektory (MCP) ────────────────────────────────────────────────── */

function ConnectorsSection({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api.get<{ servers: McpServer[] }>("/mcp-servers"),
  });
  const servers = data?.servers ?? [];

  const create = useMutation({
    mutationFn: () =>
      api.post("/mcp-servers", {
        name: name.trim(),
        agentId: agent.id,
        transport,
        ...(transport === "stdio" ? { command: command.trim() } : { url: url.trim() }),
      }),
    onSuccess: () => {
      setShowAdd(false);
      setName("");
      setCommand("");
      setUrl("");
      setErr(null);
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Přidání selhalo"),
  });
  const toggle = useMutation({
    mutationFn: (s: McpServer) => api.patch(`/mcp-servers/${s.id}`, { enabled: !s.enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/mcp-servers/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });

  return (
    <div className="max-w-[560px]">
      <p className="mb-4 text-[13px] leading-relaxed text-fg-muted">
        Nástroje, které agent umí použít (MCP servery). Přidej jednou — agent je hned umí.
      </p>
      {err && <p className="mb-3 rounded-[14px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">{err}</p>}
      {servers.map((s) => (
        <div key={s.id} className="mb-2 flex items-center gap-3 rounded-[16px] border border-border bg-bg-raised px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-fg-muted"><Blocks size={15} /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-[600] text-fg">{s.name}</p>
            <p className="mono truncate text-[12px] text-fg-muted">{s.transport}{s.command ? ` · ${s.command}` : ""}{s.url ? ` · ${s.url}` : ""}</p>
          </div>
          <button onClick={() => toggle.mutate(s)} className={`flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 ${s.enabled ? "justify-end bg-live" : "justify-start bg-bg-sunken"}`}>
            <span className="h-5 w-5 rounded-full bg-white shadow" />
          </button>
          <button onClick={() => { if (window.confirm(`Smazat konektor „${s.name}"?`)) remove.mutate(s.id); }} title="Smazat" className="rounded-full p-2 text-fg-subtle hover:bg-bg-sunken hover:text-danger"><Trash2 size={14} /></button>
        </div>
      ))}
      {showAdd ? (
        <div className="mt-3 space-y-2.5 rounded-[16px] border border-accent/40 bg-bg-raised p-4">
          <Field label="Název"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="např. GitHub" className={inputCls} /></Field>
          <Field label="Typ">
            <select value={transport} onChange={(e) => setTransport(e.target.value as "stdio" | "sse")} className={inputCls}>
              <option value="stdio">Příkaz (stdio)</option>
              <option value="sse">Adresa (sse)</option>
            </select>
          </Field>
          {transport === "stdio" ? (
            <Field label="Příkaz"><input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="např. npx -y @modelcontextprotocol/server-github" className={`${inputCls} mono`} /></Field>
          ) : (
            <Field label="URL"><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className={inputCls} /></Field>
          )}
          <div className="flex gap-2">
            <button onClick={() => create.mutate()} disabled={create.isPending || !name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())} className="pressable rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40">Přidat</button>
            <button onClick={() => setShowAdd(false)} className="pressable rounded-full border border-border bg-bg-sunken px-5 py-2 text-[13px] font-[600] text-fg">Zrušit</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} className="pressable mt-3 flex items-center gap-2 rounded-full border border-border bg-bg-raised px-5 py-2.5 text-[13.5px] font-[600] text-fg hover:bg-bg-hover">
          <Plus size={15} /> Přidat konektor
        </button>
      )}
    </div>
  );
}

/* ── Peněženka ──────────────────────────────────────────────────────── */

function WalletSection() {
  const { data: monthly } = useQuery({
    queryKey: ["usage-monthly"],
    queryFn: () => api.get<{ spend: number; budget: number | null; monthStart: string }>("/usage/monthly"),
  });
  const { data: usage } = useQuery({
    queryKey: ["usage"],
    queryFn: () => api.get<{ records: UsageRecord[]; totalCost: number }>("/usage"),
  });

  const pct = monthly?.budget ? Math.min(100, (monthly.spend / monthly.budget) * 100) : 0;

  return (
    <div className="max-w-[560px]">
      <div className="mb-4 rounded-[16px] border border-border bg-bg-raised p-4">
        <p className="text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">TENTO MĚSÍC</p>
        <p className="mt-1 text-[22px] font-[700] text-fg">
          ${monthly?.spend.toFixed(2) ?? "0.00"}
          {monthly?.budget != null && <span className="text-[14px] font-[500] text-fg-muted"> / ${monthly.budget.toFixed(2)}</span>}
        </p>
        {monthly?.budget != null && (
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg-sunken">
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        )}
        {monthly?.budget == null && <p className="mt-1 text-[12.5px] text-fg-subtle">Bez měsíčního limitu.</p>}
      </div>
      <p className="mb-2 text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">POSLEDNÍ ÚTRATY</p>
      {(usage?.records ?? []).slice(0, 20).map((r) => (
        <div key={r.id} className="mb-1.5 flex items-center gap-3 rounded-[14px] border border-border bg-bg-raised px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="mono truncate text-[12.5px] text-fg">{r.model}</p>
            <p className="truncate text-[11.5px] text-fg-subtle">{r.purpose} · {relTime(r.at)}</p>
          </div>
          <span className="mono shrink-0 text-[12.5px] text-fg-muted">${r.cost.toFixed(4)}</span>
        </div>
      ))}
      {(usage?.records.length ?? 0) === 0 && <p className="text-[13px] text-fg-subtle">Zatím žádná útrata.</p>}
    </div>
  );
}

/* ── Zařízení (počítač) ─────────────────────────────────────────────── */

/* ── Nastavení dat ──────────────────────────────────────────────────── */

function DataSection({ agent, projectId }: { agent: Agent; projectId: string }) {
  const queryClient = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  const [resetText, setResetText] = useState("");
  const { user } = useAuth();
  const { data: routinesData } = useQuery({
    queryKey: ["routines", projectId],
    queryFn: () => api.get<{ routines: Routine[] }>(`/projects/${projectId}/routines`),
  });

  const clearChat = useMutation({
    mutationFn: () => api.post(`/agents/${agent.id}/clear-chat`, { projectId }),
    onSuccess: () => {
      setMsg("Historie chatu smazána. Paměť a dovednosti zůstaly.");
      void queryClient.invalidateQueries({ queryKey: ["session"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : "Smazání selhalo"),
  });

  const factoryReset = useMutation({
    mutationFn: () => api.post(`/admin/reset`, { confirm: "RESET" }),
    onSuccess: () => setMsg("Resetuji… server za pár sekund naběhne do čisté instalace. Obnov stránku."),
    onError: (e) => setMsg(e instanceof ApiError ? e.message : "Reset selhal"),
  });

  return (
    <div className="max-w-[520px]">
      <div className="mb-4 rounded-[16px] border border-border bg-bg-raised p-4">
        <p className="text-[13.5px] font-[600] text-fg">Vymazat historii chatu</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
          Smaže zprávy (i {routinesData?.routines.length ?? 0} naplánovaných úloh se nedotkne). Paměť, SOUL a dovednosti zůstanou.
        </p>
        <button
          onClick={() => { if (window.confirm("Opravdu vymazat celou historii chatu?")) clearChat.mutate(); }}
          disabled={clearChat.isPending}
          className="pressable mt-3 rounded-full border border-danger/40 bg-danger-wash px-5 py-2 text-[13px] font-[600] text-danger disabled:opacity-40"
        >
          Vymazat historii
        </button>
      </div>
      {user?.role === "admin" && (
        <div className="mb-4 rounded-[16px] border border-danger/40 bg-danger-wash/40 p-4">
          <p className="text-[13.5px] font-[600] text-danger">Tovární nastavení</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
            Smaže ÚPLNĚ všechno — chaty, paměť, skilly, klíče, projekty — a restartuje server do stavu jako po první instalaci. Nevratné.
          </p>
          {!resetArmed ? (
            <button
              onClick={() => setResetArmed(true)}
              className="pressable mt-3 rounded-full bg-danger px-5 py-2 text-[13px] font-[600] text-white"
            >
              Tovární nastavení…
            </button>
          ) : (
            <div className="mt-3 flex items-center gap-2">
              <input
                value={resetText}
                onChange={(e) => setResetText(e.target.value)}
                placeholder='Pro potvrzení napiš RESET'
                className="mono w-full rounded-[14px] border border-danger/40 bg-bg-sunken px-3.5 py-2 text-[13px] text-fg outline-none"
              />
              <button
                onClick={() => void factoryReset.mutate()}
                disabled={factoryReset.isPending || resetText !== "RESET"}
                className="pressable shrink-0 rounded-full bg-danger px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40"
              >
                Smazat vše
              </button>
            </div>
          )}
        </div>
      )}
      {msg && <p className="text-[13px] text-fg-muted">{msg}</p>}
      <p className="mt-2 text-[12.5px] leading-relaxed text-fg-subtle">
        Všechna data běží jen na tvém serveru — žádný cloud. Zálohuj si složku s daty podle návodu v Nápovědě.
      </p>
    </div>
  );
}

/* ── Nápověda / Právní ──────────────────────────────────────────────── */

function HelpSection() {
  return (
    <div className="max-w-[560px] text-[13.5px] leading-relaxed text-fg-muted">
      <p className="mb-3 font-[600] text-fg">Jak to funguje</p>
      <ul className="list-disc space-y-2 pl-5">
        <li>Piš agentovi v hlavním chatu — pracuje ve svém vlastním počítači (kontejneru).</li>
        <li>Když potřebuje sáhnout mimo svůj počítač nebo udělat něco citlivého, přijde ti žádost o schválení.</li>
        <li>Živé dění sleduj v náhledu (tlačítko „Otevřít náhled") — a když se agent zasekne na přihlášení, obrazovku mu převezmi.</li>
        <li>Trvalé složky přidáš v záložce Složky, opakované úkoly v panelu agenta → Rutiny.</li>
        <li>Příkazy v chatu: <span className="mono text-fg">/compact</span> zhustí konverzaci, <span className="mono text-fg">/clear</span> vyčistí chat (paměť zůstane), <span className="mono text-fg">/export</span> stáhne přepis jako Markdown.</li>
      </ul>
    </div>
  );
}

function LegalSection() {
  return (
    <div className="max-w-[560px] text-[13.5px] leading-relaxed text-fg-muted">
      <p className="mb-3 font-[600] text-fg">Hertz</p>
      <p>Osobní AI agent běžící na tvém vlastním serveru. Tvoje konverzace a soubory nikam neodcházejí — kromě volání modelu u poskytovatele, kterého sis sám nastavil.</p>
      <p className="mt-3">Agent jedná tvým jménem jen v mezích schválení, která mu dáš. Citlivé kroky (e-maily, platby, změny mimo jeho počítač) vždy čekají na tvoje rozhodnutí.</p>
    </div>
  );
}
