import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Blocks, Bot, Cpu, Database, FolderOpen, Info, KeyRound, LogOut,
  Pencil, Plus, Send, Server, Trash2, X,
} from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Agent, ChannelConfig, IntegrationConnector, McpServer, MountList, ProviderConfig, Routine } from "../lib/types";
import { DirectoryPicker } from "../components/DirectoryPicker";
import { ModelFields } from "../components/ModelFields";
import { ProviderCreateForm } from "../components/ProviderCreateForm";
import { AgentAvatar, avatarVersionOf } from "../components/AgentAvatar";
import { VaultSection } from "./VaultSection";

export type Section = "agent" | "model" | "folders" | "providers" | "channels" | "connectors" | "vault" | "data" | "about";

const NAV: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
  { id: "agent", label: "Agent", icon: <Bot size={15} /> },
  { id: "model", label: "Model", icon: <Cpu size={15} /> },
  { id: "folders", label: "Složky", icon: <FolderOpen size={15} /> },
  { id: "providers", label: "Poskytovatelé", icon: <Server size={15} /> },
  { id: "channels", label: "Kanály", icon: <Send size={15} /> },
  { id: "connectors", label: "Integrace", icon: <Blocks size={15} /> },
  { id: "vault", label: "Trezor", icon: <KeyRound size={15} /> },
  { id: "data", label: "Data", icon: <Database size={15} /> },
  { id: "about", label: "O aplikaci", icon: <Info size={15} /> },
];

export function SettingsModal({ agent, projectId, initialSection = "agent", onClose }: { agent: Agent; projectId: string; initialSection?: Section; onClose: () => void }) {
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
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" style={{ backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div className="safe-bottom flex max-h-[94dvh] w-full animate-fade-in overflow-hidden rounded-t-[24px] border border-border bg-bg shadow-popover sm:max-h-[92dvh] sm:max-w-[600px] sm:rounded-[24px]" onClick={(e) => e.stopPropagation()}>
        {/* Levý sloupec s navigací (na mobilu skrytý — tam jsou záložky pod hlavičkou) */}
        <nav aria-label="Sekce nastavení" className="flex w-[188px] shrink-0 flex-col border-r border-border bg-bg-sidebar p-2.5 max-sm:hidden">
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {NAV.map((n) => (
              <button
                key={n.id}
                onClick={() => setSection(n.id)}
                aria-current={section === n.id ? "true" : undefined}
                className={`pressable flex min-h-[44px] w-full items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left text-[13.5px] ${section === n.id ? "bg-bg-sunken font-[600] text-fg" : "text-fg-muted hover:bg-bg-sunken/50 hover:text-fg"}`}
              >
                <span className="shrink-0">{n.icon}</span>
                {n.label}
              </button>
            ))}
          </div>
          <button onClick={() => void logout()} className="pressable mt-2 flex min-h-[44px] w-full items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left text-[13.5px] text-fg-muted hover:bg-bg-sunken/50 hover:text-danger">
            <LogOut size={15} /> Odhlásit se
          </button>
          {user?.email && <p className="truncate px-3 pb-1 pt-1.5 text-[11px] text-fg-subtle">{user.email}</p>}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-1 pt-4 sm:px-5">
            <p className="text-[16px] font-[700] tracking-[-0.02em] text-fg">{NAV.find((n) => n.id === section)?.label}</p>
            <div className="flex items-center gap-1">
              <button onClick={() => void logout()} title="Odhlásit se" aria-label="Odhlásit se" className="pressable flex h-11 w-11 items-center justify-center rounded-full text-fg-muted hover:bg-bg-sunken hover:text-danger sm:hidden"><LogOut size={17} /></button>
              <button onClick={onClose} title="Zavřít" aria-label="Zavřít" className="pressable flex h-11 w-11 items-center justify-center rounded-full text-fg-muted hover:bg-bg-sunken hover:text-fg"><X size={17} /></button>
            </div>
          </div>
          {/* Záložky pro mobil */}
          <div className="scrollbar-none flex shrink-0 gap-1.5 overflow-x-auto px-4 pb-3 sm:hidden sm:px-5" role="tablist" aria-label="Sekce nastavení">
            {NAV.map((n) => (
              <button
                key={n.id}
                role="tab"
                aria-selected={section === n.id}
                onClick={() => setSection(n.id)}
                className={`pressable flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full px-4 text-[12.5px] font-[600] ${section === n.id ? "bg-accent text-white" : "text-fg-muted hover:bg-bg-sunken hover:text-fg"}`}
              >
                {n.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-4 pb-6 pt-4 sm:px-5">
            {section === "agent" && <AgentSection agent={agent} />}
            {section === "model" && <ModelSection agent={agent} />}
            {section === "folders" && <FoldersSection projectId={projectId} />}
            {section === "providers" && <ProvidersSection agent={agent} />}
            {section === "channels" && <ChannelsSection agent={agent} />}
            {section === "connectors" && <ConnectorsSection agent={agent} />}
            {section === "vault" && <VaultSection />}
            {section === "data" && <DataSection agent={agent} projectId={projectId} />}
            {section === "about" && <AboutSection />}
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

/** Nadpis + úvodní popisek každé sekce — ať je hned jasné, k čemu sekce je. */
function SectionHead({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 max-w-[520px] text-[13px] leading-relaxed text-fg-muted">{children}</p>;
}

const inputCls = "h-11 w-full rounded-full border border-border bg-bg-raised px-4 text-[13.5px] text-fg outline-none focus:border-accent disabled:opacity-50";

/* ── Agent ──────────────────────────────────────────────────────────── */

function AgentSection({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(agent.name);
  const [heartbeat, setHeartbeat] = useState(String(agent.heartbeatMinutes));
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Per-field dirty tracking: a background refresh must never clobber a
  // field the user is currently editing.
  const [touched, setTouched] = useState({ name: false, heartbeat: false });
  function touch(field: keyof typeof touched) {
    setTouched((t) => (t[field] ? t : { ...t, [field]: true }));
  }

  useEffect(() => {
    setTouched({ name: false, heartbeat: false });
  }, [agent.id]);

  useEffect(() => {
    if (!touched.name) setName(agent.name);
    if (!touched.heartbeat) setHeartbeat(String(agent.heartbeatMinutes));
  }, [agent.id, agent.name, agent.heartbeatMinutes, touched]);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/agents/${agent.id}`, {
        name: name.trim() || agent.name,
        heartbeatMinutes: Math.max(0, Math.min(10080, Number.parseInt(heartbeat, 10) || 0)),
      }),
    onSuccess: () => {
      setMsg("Uloženo");
      setErr(null);
      setTouched({ name: false, heartbeat: false });
      setTimeout(() => setMsg(null), 2000);
      void queryClient.invalidateQueries({ queryKey: ["agent"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Uložení selhalo"),
  });

  return (
    <div className="max-w-[520px]">
      <SectionHead>Základní údaje o tvém agentovi — jak se jmenuje a jak často se sám probouzí.</SectionHead>
      <div className="mb-4 flex items-center gap-3 rounded-[16px] border border-border bg-bg-raised px-4 py-3">
        <AgentAvatar seed={agent.id} version={avatarVersionOf(agent)} size={48} />
        <div className="min-w-0">
          <p className="truncate text-[14px] font-[700] tracking-[-0.01em] text-fg">{agent.name}</p>
          <p className="mono truncate text-[12px] text-fg-muted">{agent.model}</p>
        </div>
      </div>
      <Field label="Jméno agenta" hint="Jak ti bude říkat a jak se bude představovat.">
        <input value={name} onChange={(e) => { touch("name"); setName(e.target.value); }} className={inputCls} />
      </Field>
      <Field label="Heartbeat (minut)" hint="Jak často se agent sám probudí a zkontroluje rozdělanou práci. 0 = vypnuto.">
        <input value={heartbeat} onChange={(e) => { touch("heartbeat"); setHeartbeat(e.target.value); }} inputMode="numeric" className={inputCls} />
      </Field>
      {err && <p className="mb-3 text-[13px] text-danger">{err}</p>}
      <button onClick={() => save.mutate()} disabled={save.isPending} className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full bg-accent px-6 py-2.5 text-[13.5px] font-[600] text-white disabled:opacity-40">
        {save.isPending ? "Ukládám…" : msg ?? "Uložit změny"}
      </button>
    </div>
  );
}

/* ── Model ──────────────────────────────────────────────────────────── */

function ModelSection({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [model, setModel] = useState(agent.model);
  const [providerId, setProviderId] = useState(agent.providerConfigId);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Per-field dirty tracking: a background refresh must never clobber a
  // field the user is currently editing.
  const [touched, setTouched] = useState({ providerId: false, model: false });
  function touch(field: keyof typeof touched) {
    setTouched((t) => (t[field] ? t : { ...t, [field]: true }));
  }

  useEffect(() => {
    setTouched({ providerId: false, model: false });
  }, [agent.id]);

  // The server can correct the stored model mid-run (stale id → scanned
  // fallback); keep the form in sync, but only for fields the user hasn't
  // touched yet.
  useEffect(() => {
    if (!touched.providerId) setProviderId(agent.providerConfigId);
    if (!touched.model) setModel(agent.model);
  }, [agent.id, agent.model, agent.providerConfigId, touched]);

  const save = useMutation({
    mutationFn: () => {
      if (!model.trim()) throw new Error("Nejdřív vyber model — bez něj chat neběží.");
      return api.patch(`/agents/${agent.id}`, {
        model: model.trim(),
        providerConfigId: providerId,
      });
    },
    onSuccess: () => {
      setMsg("Uloženo");
      setErr(null);
      setTouched({ providerId: false, model: false });
      setTimeout(() => setMsg(null), 2000);
      void queryClient.invalidateQueries({ queryKey: ["agent"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Uložení selhalo"),
  });

  return (
    <div className="max-w-[520px]">
      <SectionHead>Kterým modelem agent přemýšlí a odpovídá. Platí se u poskytovatele, kterého sis nastavil.</SectionHead>
      <Field label="Poskytovatel a model" hint="Nového poskytovatele (a jeho API klíč) přidáš v sekci Poskytovatelé.">
        <div className="rounded-[16px] border border-border bg-bg-raised p-3">
          <ModelFields
            providerId={providerId}
            onProviderIdChange={(id) => { touch("providerId"); setProviderId(id); }}
            model={model}
            onModelChange={(m) => { touch("model"); setModel(m); }}
            idPrefix="settings"
          />
        </div>
      </Field>
      {err && <p className="mb-3 text-[13px] text-danger">{err}</p>}
      <button onClick={() => save.mutate()} disabled={save.isPending} className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full bg-accent px-6 py-2.5 text-[13.5px] font-[600] text-white disabled:opacity-40">
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
      <SectionHead>
        Trvalé složky z tvého počítače, které agent vidí ve svém. Změny se projeví po restartu jeho kontejneru.
      </SectionHead>
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
              <button onClick={() => patch.mutate()} disabled={patch.isPending || !editing.name.trim()} className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40">Uložit</button>
              <button onClick={() => setEditing(null)} className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full border border-border bg-bg-sunken px-5 py-2 text-[13px] font-[600] text-fg">Zrušit</button>
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
            <button onClick={() => setEditing({ id: m.id, name: m.name, purpose: m.purpose ?? "" })} title="Přejmenovat / popsat" className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-sunken hover:text-fg"><Pencil size={14} /></button>
            <button onClick={() => { if (window.confirm(`Opravdu smazat složku „${m.name}"? Agent ji přestane vidět (po restartu kontejneru).`)) remove.mutate(m.id); }} title="Smazat" className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-sunken hover:text-danger"><Trash2 size={14} /></button>
          </div>
        ),
      )}

      {showAdd ? (
        <div className="mt-3 space-y-2.5 rounded-[16px] border border-accent/40 bg-bg-raised p-4">
          <Field label="Složka na tvém počítači">
            <div className="flex gap-2">
              <input value={hostPath} readOnly placeholder="Vyber tlačítkem…" className={`${inputCls} mono`} />
              <button onClick={() => setPickerOpen(true)} className="pressable inline-flex min-h-[44px] shrink-0 items-center rounded-full border border-border bg-bg-sunken px-4 text-[13px] font-[600] text-fg">Vybrat…</button>
            </div>
          </Field>
          <Field label="Název viditelný agentovi" hint="Krátký název bez mezer, např. fotky.">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="např. fotky" className={inputCls} />
          </Field>
          <Field label="Účel (nepovinné)">
            <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="K čemu agent složku má" className={inputCls} />
          </Field>
          <div className="flex gap-2">
            <button onClick={() => create.mutate()} disabled={create.isPending || !hostPath || !name.trim()} className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40">Přidat složku</button>
            <button onClick={() => setShowAdd(false)} className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full border border-border bg-bg-sunken px-5 py-2 text-[13px] font-[600] text-fg">Zrušit</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} className="pressable mt-3 flex min-h-[44px] items-center gap-2 rounded-full border border-border bg-bg-raised px-5 py-2.5 text-[13.5px] font-[600] text-fg hover:bg-bg-hover">
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
  const [info, setInfo] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers"),
  });
  const providers = data?.providers ?? [];

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/providers/${id}`),
    onSuccess: () => {
      setErr(null);
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Smazání selhalo"),
  });
  const useForAgent = useMutation({
    mutationFn: (p: ProviderConfig) =>
      api.patch(`/agents/${agent.id}`, {
        providerConfigId: p.id,
        // A provider without a default model must NOT silently keep the old
        // provider's model — clear it and make the user pick one.
        model: p.defaultModel ?? "",
      }),
    onSuccess: (_d, p) => {
      void queryClient.invalidateQueries({ queryKey: ["agent"] });
      setErr(null);
      setInfo(p.defaultModel ? null : "Poskytovatel přepnut. Vyber mu model v sekci Model — bez modelu chat neběží.");
    },
    onError: (e) => {
      setInfo(null);
      setErr(e instanceof ApiError ? e.message : "Přepnutí selhalo");
    },
  });

  return (
    <div className="max-w-[560px]">
      <SectionHead>
        Odkud agent bere modely a komu za ně platíš. Agent právě používá model <span className="mono text-fg">{agent.model}</span>.
      </SectionHead>
      {err && <p className="mb-3 rounded-[14px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">{err}</p>}
      {info && <p className="mb-3 rounded-[14px] border border-warning/25 bg-warning-wash px-4 py-2.5 text-[13px] text-fg">{info}</p>}
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
            <button onClick={() => useForAgent.mutate(p)} disabled={useForAgent.isPending} title="Použít pro agenta" className="pressable inline-flex min-h-[44px] shrink-0 items-center rounded-full border border-border bg-bg-sunken px-4 text-[12px] font-[600] text-fg hover:bg-bg-hover disabled:opacity-40">
              {useForAgent.isPending ? "Přepínám…" : "Použít"}
            </button>
          )}
          <button onClick={() => { if (window.confirm(`Smazat poskytovatele „${p.label}"?`)) remove.mutate(p.id); }} title="Smazat" className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-sunken hover:text-danger"><Trash2 size={14} /></button>
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
        <button onClick={() => setShowAdd(true)} className="pressable mt-3 flex min-h-[44px] items-center gap-2 rounded-full border border-border bg-bg-raised px-5 py-2.5 text-[13.5px] font-[600] text-fg hover:bg-bg-hover">
          <Plus size={15} /> Přidat poskytovatele
        </button>
      )}
    </div>
  );
}

/* ── Kanály ───────────────────────────────────────────────────────── */

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
    return <p className="max-w-[520px] text-[13px] leading-relaxed text-fg-muted">Kanály může spravovat jen administrátor.</p>;
  }

  return (
    <div className="max-w-[560px]">
      <SectionHead>
        Piš agentovi i mimo web — připoj ho k Telegramu nebo Discordu a bude ti odpovídat tam.
      </SectionHead>
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
            <button onClick={() => create.mutate()} disabled={create.isPending || !label.trim() || token.length < 10} className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40">Připojit</button>
            <button onClick={() => setShowAdd(false)} className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full border border-border bg-bg-sunken px-5 py-2 text-[13px] font-[600] text-fg">Zrušit</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} className="pressable mt-3 flex min-h-[44px] items-center gap-2 rounded-full border border-border bg-bg-raised px-5 py-2.5 text-[13.5px] font-[600] text-fg hover:bg-bg-hover">
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
        <button onClick={onToggle} className={`relative flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 before:absolute before:-inset-3 before:content-[''] ${c.enabled ? "justify-end bg-live" : "justify-start bg-bg-sunken"}`}>
          <span className="h-5 w-5 rounded-full bg-white shadow" />
        </button>
      </div>
      <div className="mt-2 flex gap-2 pl-12">
        <button onClick={onTest} disabled={testing} className="pressable inline-flex min-h-[44px] items-center rounded-full border border-border bg-bg-sunken px-4 text-[12px] font-[600] text-fg">Otestovat</button>
        <button onClick={() => setListsOpen((v) => !v)} className="pressable inline-flex min-h-[44px] items-center rounded-full border border-border bg-bg-sunken px-4 text-[12px] font-[600] text-fg">Kdo smí psát</button>
        <button onClick={onRemove} className="pressable inline-flex min-h-[44px] items-center rounded-full border border-border bg-bg-sunken px-4 text-[12px] font-[600] text-danger">Odpojit</button>
      </div>
      {listsOpen && (
        <div className="mt-3 space-y-2.5 border-t border-border pl-12 pr-1 pt-3">
          <Field label="Povolené chaty (ID, čárkou; prázdné = všechny)" hint="Telegram: ID chatu zobrazí např. @userinfobot. Discord: ID kanálu.">
            <input value={chats} onChange={(e) => setChats(e.target.value)} placeholder="123456789, -100123456" className={inputCls} />
          </Field>
          <Field label="Povolení odesílatelé (ID nebo @nick, čárkou; prázdné = všichni)" hint="Bot odpoví jen těmto lidem — ostatní dostanou zamítnutí.">
            <input value={senders} onChange={(e) => setSenders(e.target.value)} placeholder="@sefa, 123456789" className={inputCls} />
          </Field>
          <button onClick={() => onSaveLists(parseList(chats), parseList(senders))} disabled={saving || !dirty} className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40">
            {saving ? "Ukládám…" : "Uložit seznamy"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Integrace a MCP ────────────────────────────────────────────────── */

function ConnectorsSection({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // OAuth round-trip results land here as ?connected= / ?oauthError= query
  // params (the provider redirects back to the app root). Show them once,
  // then strip them from the URL.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const connected = q.get("connected");
    const oauthError = q.get("oauthError");
    if (connected || oauthError) {
      setNotice(
        connected
          ? { kind: "ok", text: `„${connected}“ je připojeno. Agent nové nástroje umí hned použít.` }
          : { kind: "err", text: oauthError ?? "Připojení se nezdařilo." },
      );
      q.delete("connected");
      q.delete("oauthError");
      const rest = q.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
      void queryClient.invalidateQueries({ queryKey: ["integrations"] });
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    }
  }, [queryClient]);

  return (
    <div className="max-w-[560px]">
      <SectionHead>
        Služby a nástroje, které agent umí používat. Připoj službu jedním kliknutím, nebo přidej vlastní MCP server.
        U každého konektoru nastavíš, co agent smí dělat — výchozí je jen čtení.
      </SectionHead>
      {notice && (
        <p className={`mb-3 rounded-[14px] border px-4 py-2.5 text-[13px] ${notice.kind === "ok" ? "border-live/25 bg-live/10 text-fg" : "border-danger/25 bg-danger-wash text-danger"}`}>
          {notice.text}
        </p>
      )}
      <OneClickConnectors />
      <ManualMcpServers agent={agent} />
    </div>
  );
}

/* ── One-click integrace ─────────────────────────────────────────── */

const ctaCls = "pressable inline-flex min-h-[44px] shrink-0 items-center justify-center rounded-full bg-accent px-5 text-[13px] font-[600] text-white disabled:opacity-40";

function OneClickConnectors() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  // Karta, u které je otevřený panel: OAuth krok pro správce, nebo vložení klíče.
  const [panelFor, setPanelFor] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [keyValues, setKeyValues] = useState<Record<string, string>>({});
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; reason: string | null } | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["integrations"],
    queryFn: () => api.get<{ connectors: IntegrationConnector[] }>("/integrations"),
  });
  const connectors = data?.connectors ?? [];

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["integrations"] });
    void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
  }

  const saveApp = useMutation({
    mutationFn: (c: IntegrationConnector) =>
      api.post("/oauth/apps", { service: c.service, clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
    onSuccess: (_res, c) => {
      setPanelFor(null);
      setClientId("");
      setClientSecret("");
      setSaveErr(null);
      refresh();
      // Po uložení rovnou na souhlas poskytovatele — žádné další klikání.
      window.location.href = `/api/oauth/${c.service}/start?catalogId=${c.id}`;
    },
    onError: (e) => setSaveErr(e instanceof ApiError ? e.message : "Uložení selhalo"),
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => api.post(`/integrations/${id}/disconnect`),
    onSuccess: () => {
      setTestResult(null);
      refresh();
    },
  });

  const enable = useMutation({
    mutationFn: (id: string) => api.post(`/integrations/${id}/enable`),
    onSuccess: () => refresh(),
  });

  const saveKey = useMutation({
    mutationFn: (c: IntegrationConnector) => {
      const values: Record<string, string> = {};
      for (const f of c.credentialFields ?? []) values[f.env] = (keyValues[f.env] ?? "").trim();
      return api.post(`/integrations/${c.id}/credentials`, { values });
    },
    onSuccess: () => {
      setPanelFor(null);
      setKeyValues({});
      setKeyErr(null);
      refresh();
    },
    onError: (e) => setKeyErr(e instanceof ApiError ? e.message : "Uložení selhalo"),
  });

  const test = useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: boolean; servers: Array<{ ok: boolean; reason: string | null }> }>(`/integrations/${id}/test`),
    onSuccess: (res, id) => {
      const failed = res.servers.find((s) => !s.ok);
      setTestResult({ id, ok: res.ok, reason: failed?.reason ?? null });
      refresh();
    },
  });

  function openPanel(c: IntegrationConnector) {
    setPanelFor(c.id);
    setClientId(c.clientId ?? "");
    setClientSecret("");
    setSaveErr(null);
    setKeyValues({});
    setKeyErr(null);
  }

  return (
    <div className="mb-6">
      <p className="mb-1 text-[14px] font-[700] text-fg">Jedním kliknutím</p>
      <p className="mb-3 text-[13px] leading-relaxed text-fg-muted">
        Vyber službu a klikni na Připojit — přihlášení proběhne bezpečně u poskytovatele, klíče se ukládají šifrovaně. Agent nové nástroje umí použít hned.
      </p>
      {isLoading && <p className="text-[13px] text-fg-muted">Načítám…</p>}
      {isError && <p className="mb-3 rounded-[14px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">Stav připojení se nepodařilo načíst.</p>}
      {connectors.map((c) => {
        const failed = c.servers.find((s) => s.error);
        const panelOpen = panelFor === c.id;
        const requiredFields = (c.credentialFields ?? []).filter((f) => f.required !== false);
        const optionalFields = (c.credentialFields ?? []).filter((f) => f.required === false);
        return (
          <div key={c.id} className="mb-2 rounded-[16px] border border-border bg-bg-raised px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-[600] text-fg">
                  {c.name}
                  {failed ? (
                    <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[11px] font-[700] text-danger">Nefunguje</span>
                  ) : c.connected ? (
                    <span className="rounded-full bg-live/15 px-2 py-0.5 text-[11px] font-[700] text-live">Připojeno</span>
                  ) : (
                    <span className="rounded-full bg-bg-sunken px-2 py-0.5 text-[11px] font-[700] text-fg-muted">Nepřipojeno</span>
                  )}
                </p>
                <p className="mt-0.5 text-[12.5px] text-fg-muted">{c.tagline}</p>
              </div>
              {c.connected ? (
                <button
                  onClick={() => { if (window.confirm(`${c.local ? "Vypnout" : "Odpojit"} „${c.name}“? Agent přestane jeho nástroje vidět.`)) disconnect.mutate(c.id); }}
                  disabled={disconnect.isPending}
                  className="pressable inline-flex min-h-[44px] shrink-0 items-center justify-center rounded-full border border-border bg-bg-sunken px-5 text-[13px] font-[600] text-fg disabled:opacity-40"
                >
                  {c.local ? "Vypnout" : "Odpojit"}
                </button>
              ) : c.local ? (
                <button onClick={() => enable.mutate(c.id)} disabled={enable.isPending} className={ctaCls}>
                  {enable.isPending ? "Připojuji…" : "Připojit"}
                </button>
              ) : c.credentialKind === "apiKey" ? (
                <button onClick={() => openPanel(c)} className={ctaCls}>
                  Připojit
                </button>
              ) : c.oauthReady ? (
                <a href={`/api/oauth/${c.service}/start?catalogId=${c.id}`} className={ctaCls}>
                  Připojit
                </a>
              ) : (
                <button onClick={() => openPanel(c)} className={ctaCls}>
                  Připojit
                </button>
              )}
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-fg-muted">{c.description}</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-fg-subtle">{c.capabilities.join(" · ")}</p>
            {failed && (
              <p className="mt-2 rounded-[12px] border border-danger/25 bg-danger-wash px-3 py-2 text-[12.5px] text-danger">
                Nefunguje: {failed.errorHuman ?? failed.error}
              </p>
            )}
            {c.id === "google" && c.connected && (
              <p className="mt-2 text-[12.5px] text-fg-muted">
                Nově umí i Tabulky, Dokumenty a Prezentace.{" "}
                <a href={`/api/oauth/${c.service}/start?catalogId=${c.id}`} className="font-[600] text-accent underline">
                  Znovu připojit
                </a>{" "}
                pro rozšířená oprávnění (Google se znovu zeptá na souhlas).
              </p>
            )}
            {c.connected && (
              <div className="mt-2">
                <button
                  onClick={() => test.mutate(c.id)}
                  disabled={test.isPending}
                  className="pressable inline-flex min-h-[40px] items-center rounded-full border border-border bg-bg-sunken px-4 text-[12.5px] font-[600] text-fg disabled:opacity-40"
                >
                  {test.isPending ? "Testuji…" : "Otestovat připojení"}
                </button>
              </div>
            )}
            {testResult && testResult.id === c.id && (
              <p className={`mt-2 rounded-[12px] border px-3 py-2 text-[12.5px] ${testResult.ok ? "border-live/25 bg-live/10 text-fg" : "border-danger/25 bg-danger-wash text-danger"}`}>
                {testResult.ok ? `Funguje — ${c.name} je v pořádku.` : `Nefunguje: ${testResult.reason ?? "neznámá chyba"}`}
              </p>
            )}
            {c.connected && c.servers.some((s) => s.tools.length > 0) && (
              <p className="mono mt-2 text-[11.5px] leading-relaxed text-fg-subtle">
                Nástroje: {c.servers.flatMap((s) => s.tools).join(", ")}
              </p>
            )}
            {c.connected && <ConnectorPolicy c={c} />}

            {/* OAuth: přihlašování ještě není na serveru zapnuté → krok pro správce (ne pro běžného uživatele). */}
            {panelOpen && c.credentialKind === "oauth" && (
              <div className="mt-3 rounded-[12px] border border-border bg-bg px-4 py-3">
                {!c.oauthReady ? (
                  <>
                    <p className="text-[13px] font-[600] text-fg">Ještě jeden krok — ten udělá správce serveru</p>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
                      Abys mohl(a) používat {c.name}, musí správce tohoto serveru nejdřív zapnout přihlašování. Je to jednorázové a zabere pár minut.
                    </p>
                    {isAdmin ? (
                      <details className="mt-2" open>
                        <summary className="cursor-pointer text-[12.5px] font-[600] text-accent">Jsem správce — zapnout přihlašování</summary>
                        <div className="mt-2">
                          <AdminOAuthForm
                            c={c}
                            clientId={clientId}
                            setClientId={setClientId}
                            clientSecret={clientSecret}
                            setClientSecret={setClientSecret}
                            saveErr={saveErr}
                            saving={saveApp.isPending}
                            onSave={() => saveApp.mutate(c)}
                          />
                        </div>
                      </details>
                    ) : (
                      <p className="mt-2 text-[12.5px] leading-relaxed text-fg-muted">
                        Nejsi správcem? Popros ho, ať přihlašování přes {c.name} zapne — pak tu jen klikneš na Připojit.
                      </p>
                    )}
                  </>
                ) : (
                  <AdminOAuthForm
                    c={c}
                    clientId={clientId}
                    setClientId={setClientId}
                    clientSecret={clientSecret}
                    setClientSecret={setClientSecret}
                    saveErr={saveErr}
                    saving={saveApp.isPending}
                    onSave={() => saveApp.mutate(c)}
                  />
                )}
                <button
                  onClick={() => setPanelFor(null)}
                  className="pressable mt-2 inline-flex min-h-[40px] items-center justify-center rounded-full border border-border bg-bg-sunken px-4 text-[12.5px] font-[600] text-fg"
                >
                  Zavřít
                </button>
              </div>
            )}
            {c.credentialKind === "oauth" && c.oauthReady && isAdmin && !c.connected && !panelOpen && (
              <button onClick={() => openPanel(c)} className="mt-2 text-[12.5px] font-[600] text-accent underline">
                Změnit údaje pro přihlašování
              </button>
            )}

            {/* API klíč: jedno pole „Vlož klíč“ + odkaz, kde ho najít. */}
            {panelOpen && c.credentialKind === "apiKey" && (
              <div className="mt-3 space-y-2.5 rounded-[12px] border border-border bg-bg px-4 py-3">
                <p className="text-[13px] font-[600] text-fg">Připojit {c.name}</p>
                <p className="text-[12.5px] leading-relaxed text-fg-muted">{c.setupHelp}</p>
                {c.setupUrl && (
                  <a href={c.setupUrl} target="_blank" rel="noreferrer" className="inline-block text-[12.5px] font-[600] text-accent underline">
                    {c.setupUrlLabel ?? "Kde klíč najdu?"}
                  </a>
                )}
                {keyErr && <p className="rounded-[12px] border border-danger/25 bg-danger-wash px-3 py-2 text-[12.5px] text-danger">{keyErr}</p>}
                {requiredFields.map((f) => (
                  <Field key={f.env} label={f.label} hint={f.hint}>
                    <input
                      type={f.secret ? "password" : "text"}
                      value={keyValues[f.env] ?? ""}
                      onChange={(e) => setKeyValues((v) => ({ ...v, [f.env]: e.target.value }))}
                      placeholder={f.secret ? "Vlož klíč…" : ""}
                      className={`${inputCls} mono`}
                      autoComplete="new-password"
                    />
                  </Field>
                ))}
                {optionalFields.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-[12.5px] font-[600] text-fg-muted">Volitelné nastavení</summary>
                    <div className="mt-2 space-y-2.5">
                      {optionalFields.map((f) => (
                        <Field key={f.env} label={f.label} hint={f.hint}>
                          <input
                            type={f.secret ? "password" : "text"}
                            value={keyValues[f.env] ?? ""}
                            onChange={(e) => setKeyValues((v) => ({ ...v, [f.env]: e.target.value }))}
                            className={`${inputCls} mono`}
                            autoComplete="new-password"
                          />
                        </Field>
                      ))}
                    </div>
                  </details>
                )}
                <p className="text-[12px] leading-relaxed text-fg-subtle">Klíč se uloží šifrovaně na tento server a nikomu se nezobrazí.</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => saveKey.mutate(c)}
                    disabled={saveKey.isPending || requiredFields.some((f) => !(keyValues[f.env] ?? "").trim())}
                    className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full bg-accent px-5 text-[13px] font-[600] text-white disabled:opacity-40"
                  >
                    Uložit a připojit
                  </button>
                  <button
                    onClick={() => setPanelFor(null)}
                    className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full border border-border bg-bg-sunken px-5 text-[13px] font-[600] text-fg"
                  >
                    Zrušit
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Formulář pro správce: zapnutí OAuth přihlašování (jednorázový krok). */
function AdminOAuthForm({
  c,
  clientId,
  setClientId,
  clientSecret,
  setClientSecret,
  saveErr,
  saving,
  onSave,
}: {
  c: IntegrationConnector;
  clientId: string;
  setClientId: (v: string) => void;
  clientSecret: string;
  setClientSecret: (v: string) => void;
  saveErr: string | null;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <div className="space-y-2.5">
      {c.adminSetupHelp && <p className="text-[12.5px] leading-relaxed text-fg-muted">{c.adminSetupHelp}</p>}
      {c.setupUrl && (
        <a href={c.setupUrl} target="_blank" rel="noreferrer" className="inline-block text-[12.5px] font-[600] text-accent underline">
          {c.setupUrlLabel}
        </a>
      )}
      {saveErr && <p className="rounded-[12px] border border-danger/25 bg-danger-wash px-3 py-2 text-[12.5px] text-danger">{saveErr}</p>}
      <Field label="Client ID">
        <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="např. 123….apps.googleusercontent.com" className={`${inputCls} mono`} />
      </Field>
      <Field label="Client secret" hint={c.secretHint ? `Uloženo (…${c.secretHint}) — vyplň jen pro změnu.` : undefined}>
        <input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} type="password" placeholder="••••••••" className={`${inputCls} mono`} autoComplete="new-password" />
      </Field>
      <p className="text-[12px] leading-relaxed text-fg-subtle">
        Tip: údaje můžeš místo toho nastavit přímo na serveru přes proměnné prostředí — pak je tu nemusíš vyplňovat vůbec.
      </p>
      <button
        onClick={onSave}
        disabled={saving || !clientId.trim()}
        className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full bg-accent px-5 text-[13px] font-[600] text-white disabled:opacity-40"
      >
        Uložit a pokračovat
      </button>
    </div>
  );
}

/* ── Práva konektoru (politika) ─────────────────────────────────────────── */

function ConnectorPolicy({ c }: { c: IntegrationConnector }) {
  const queryClient = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const server = c.servers.find((s) => s.enabled) ?? c.servers[0];
  const policy = server?.policy;
  const tools = policy?.tools ?? [];

  const setPolicy = useMutation({
    mutationFn: (body: { mode?: "read-only" | "read-write"; tools?: Record<string, "allow" | "deny"> }) =>
      api.post(`/integrations/${c.id}/policy`, body),
    onSuccess: () => {
      setErr(null);
      void queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Uložení práv selhalo"),
  });

  if (!policy) return null;
  const modeBtn = (mode: "read-only" | "read-write", label: string) => (
    <button
      key={mode}
      onClick={() => setPolicy.mutate({ mode })}
      disabled={setPolicy.isPending || policy.mode === mode}
      className={`pressable inline-flex min-h-[36px] items-center justify-center rounded-full px-4 text-[12.5px] font-[600] disabled:opacity-40 ${
        policy.mode === mode ? "bg-accent text-white" : "border border-border bg-bg-sunken text-fg"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="mt-3 rounded-[12px] border border-border bg-bg px-4 py-3">
      <p className="text-[13px] font-[600] text-fg">Práva konektoru</p>
      <div className="mt-2 flex gap-2">
        {modeBtn("read-only", "Jen čtení")}
        {modeBtn("read-write", "Čtení a zápis")}
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-fg-muted">
        Výchozí je „Jen čtení“ (nejméně práv). Citlivé operace — odeslání e-mailu, mazání, publikování, přepisování —
        vyžadují schválení vždy, i v režimu „Čtení a zápis“.
      </p>
      {tools.length > 0 && (
        <div className="mt-2 space-y-1">
          {tools.map((t) => (
            <div key={t.name} className="flex items-center gap-2 rounded-[10px] bg-bg-sunken px-3 py-1.5">
              <span className="mono min-w-0 flex-1 truncate text-[11.5px] text-fg" title={t.name}>
                {t.name}
              </span>
              <span className="shrink-0 rounded-full bg-bg px-2 py-0.5 text-[10.5px] font-[700] text-fg-muted">
                {t.classLabel}
              </span>
              {t.requiresApproval && (
                <span className="shrink-0 rounded-full bg-danger/15 px-2 py-0.5 text-[10.5px] font-[700] text-danger" title="Před spuštěním se vždy zobrazí žádost o schválení.">
                  Vyžaduje schválení
                </span>
              )}
              <button
                onClick={() => setPolicy.mutate({ tools: { [t.name]: t.allowed ? "deny" : "allow" } })}
                disabled={setPolicy.isPending}
                className={`pressable inline-flex min-h-[32px] shrink-0 items-center justify-center rounded-full px-3 text-[11.5px] font-[600] disabled:opacity-40 ${
                  t.allowed ? "border border-border bg-bg text-fg" : "bg-danger/15 text-danger"
                }`}
                title={t.allowed ? "Zakázat tento nástroj" : "Povolit tento nástroj"}
              >
                {t.allowed ? "Povoleno" : "Zakázáno"}
              </button>
            </div>
          ))}
        </div>
      )}
      {err && <p className="mt-2 rounded-[12px] border border-danger/25 bg-danger-wash px-3 py-2 text-[12.5px] text-danger">{err}</p>}
    </div>
  );
}

/* ── Ruční MCP servery ───────────────────────────────────────────────────── */

function ManualMcpServers({ agent }: { agent: Agent }) {
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
    <div>
      <p className="mb-1 text-[14px] font-[700] text-fg">Vlastní MCP servery</p>
      <p className="mb-3 text-[13px] leading-relaxed text-fg-muted">
        Pro pokročilé: vlastní MCP server z příkazu nebo URL. Agent jeho nástroje umí hned použít.
      </p>
      {err && <p className="mb-3 rounded-[14px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">{err}</p>}
      {servers.map((s) => (
        <div key={s.id} className="mb-2 flex items-center gap-3 rounded-[16px] border border-border bg-bg-raised px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-fg-muted"><Blocks size={15} /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-[600] text-fg">{s.name}</p>
            <p className="mono truncate text-[12px] text-fg-muted">{s.transport}{s.command ? ` · ${s.command}` : ""}{s.url ? ` · ${s.url}` : ""}</p>
          </div>
          <button onClick={() => toggle.mutate(s)} className={`relative flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 before:absolute before:-inset-3 before:content-[''] ${s.enabled ? "justify-end bg-live" : "justify-start bg-bg-sunken"}`}>
            <span className="h-5 w-5 rounded-full bg-white shadow" />
          </button>
          <button onClick={() => { if (window.confirm(`Smazat konektor „${s.name}“?`)) remove.mutate(s.id); }} title="Smazat" className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-sunken hover:text-danger"><Trash2 size={14} /></button>
        </div>
      ))}
      {showAdd ? (
        <div className="mt-3 space-y-2.5 rounded-[16px] border border-accent/40 bg-bg-raised p-4">
          <Field label="Název"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="např. Vlastní server" className={inputCls} /></Field>
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
            <button onClick={() => create.mutate()} disabled={create.isPending || !name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())} className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40">Přidat</button>
            <button onClick={() => setShowAdd(false)} className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full border border-border bg-bg-sunken px-5 py-2 text-[13px] font-[600] text-fg">Zrušit</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} className="pressable mt-3 flex min-h-[44px] items-center gap-2 rounded-full border border-border bg-bg-raised px-5 py-2.5 text-[13.5px] font-[600] text-fg hover:bg-bg-hover">
          <Plus size={15} /> Přidat konektor
        </button>
      )}
    </div>
  );
}

/* ── Data ─────────────────────────────────────────────────────────── */

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
      <SectionHead>
        Co se děje s tvými daty. Všechno běží jen na tvém serveru — žádný cloud. Zálohu si udělej zkopírováním datové složky, návod najdeš v sekci O aplikaci.
      </SectionHead>
      <div className="mb-4 rounded-[16px] border border-border bg-bg-raised p-4">
        <p className="text-[13.5px] font-[600] text-fg">Vymazat historii chatu</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
          Smaže zprávy (i {routinesData?.routines.length ?? 0} naplánovaných úloh se nedotkne). Paměť, SOUL a dovednosti zůstanou.
        </p>
        <button
          onClick={() => { if (window.confirm("Opravdu vymazat celou historii chatu?")) clearChat.mutate(); }}
          disabled={clearChat.isPending}
          className="pressable mt-3 inline-flex min-h-[44px] items-center justify-center rounded-full border border-danger/40 bg-danger-wash px-5 py-2 text-[13px] font-[600] text-danger disabled:opacity-40"
        >
          Vymazat historii
        </button>
      </div>
      {user?.role === "admin" && (
        <div className="mb-4 rounded-[16px] border border-danger/40 bg-danger-wash/40 p-4">
          <p className="text-[13.5px] font-[600] text-danger">Tovární nastavení</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
            Smaže ÚPLNĚ všechno — chaty, paměť, dovednosti, klíče — a restartuje server do stavu jako po první instalaci. Nevratné.
          </p>
          {!resetArmed ? (
            <button
              onClick={() => setResetArmed(true)}
              className="pressable mt-3 inline-flex min-h-[44px] items-center justify-center rounded-full bg-danger px-5 py-2 text-[13px] font-[600] text-white"
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
                className="pressable inline-flex min-h-[44px] shrink-0 items-center justify-center rounded-full bg-danger px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40"
              >
                Smazat vše
              </button>
            </div>
          )}
        </div>
      )}
      {msg && <p className="text-[13px] text-fg-muted">{msg}</p>}
    </div>
  );
}

/* ── O aplikaci ─────────────────────────────────────────────────────── */

function AboutSection() {
  return (
    <div className="max-w-[560px] text-[13.5px] leading-relaxed text-fg-muted">
      <p className="mb-3 font-[600] text-fg">Jak to funguje</p>
      <ul className="mb-6 list-disc space-y-2 pl-5">
        <li>Piš agentovi v hlavním chatu — pracuje ve svém vlastním počítači (kontejneru).</li>
        <li>Když potřebuje sáhnout mimo svůj počítač nebo udělat něco citlivého, přijde ti žádost o schválení.</li>
        <li>Živé dění sleduj v náhledu (tlačítko „Otevřít náhled") — a když se agent zasekne na přihlášení, obrazovku mu převezmi.</li>
        <li>Trvalé složky přidáš v sekci Složky, opakované úkoly v panelu agenta › Rutiny.</li>
        <li>Příkazy v chatu: <span className="mono text-fg">/compact</span> zhustí konverzaci, <span className="mono text-fg">/clear</span> vyčistí chat (paměť zůstane), <span className="mono text-fg">/export</span> stáhne přepis jako Markdown.</li>
      </ul>
      <p className="mb-3 font-[600] text-fg">Hertz</p>
      <p>Osobní AI agent běžící na tvém vlastním serveru. Tvoje konverzace a soubory nikam neodcházejí — kromě volání modelu u poskytovatele, kterého sis sám nastavil.</p>
      <p className="mt-3">Agent jedná tvým jménem jen v mezích schválení, která mu dáš. Citlivé kroky (e-maily, platby, změny mimo jeho počítač) vždy čekají na tvoje rozhodnutí.</p>
    </div>
  );
}
