import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Plus } from "lucide-react";
import { api } from "../lib/api";
import { Avatar, Badge, Button, Card, EmptyState, Input, Label, Textarea } from "../components/ui";
import { DeleteButton } from "../components/DeleteButton";

interface ChannelItem {
  id: string;
  kind: "telegram" | "discord";
  label: string;
  tokenHint: string;
  defaultAgentId: string | null;
  allowedChats: string[];
  enabled: boolean;
  running: boolean;
  botLabel: string | null;
  createdAt: string;
}

interface ChannelAgent {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
}

interface ChannelBinding {
  id: string;
  channelId: string;
  externalChatId: string;
  sessionId: string;
  projectId: string | null;
  sessionTitle: string | null;
  createdAt: string;
}

function fmtDate(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export function ChannelsPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);

  const { data } = useQuery({
    queryKey: ["channels"],
    queryFn: () => api.get<{ channels: ChannelItem[] }>("/channels"),
    refetchInterval: 8000,
  });
  const { data: agentsData } = useQuery({
    queryKey: ["channel-agents"],
    queryFn: () => api.get<{ agents: ChannelAgent[] }>("/channels/agents"),
  });
  const { data: bindingsData } = useQuery({
    queryKey: ["channel-bindings"],
    queryFn: () => api.get<{ bindings: ChannelBinding[] }>("/channels/bindings"),
    refetchInterval: 10000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["channels"] });

  const toggle = useMutation({
    mutationFn: (args: { id: string; enabled: boolean }) => api.patch(`/channels/${args.id}`, { enabled: args.enabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/channels/${id}`),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["channel-bindings"] });
    },
  });
  const test = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; botLabel: string; running: boolean }>(`/channels/${id}/test`),
    onSuccess: invalidate,
  });
  const setDefaultAgent = useMutation({
    mutationFn: (args: { id: string; defaultAgentId: string | null }) =>
      api.patch(`/channels/${args.id}`, { defaultAgentId: args.defaultAgentId }),
    onSuccess: invalidate,
  });

  const channels = data?.channels ?? [];
  const agents = agentsData?.agents ?? [];
  const bindings = bindingsData?.bindings ?? [];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
      <div className="mb-5 flex items-center gap-2">
        <MessageCircle size={18} className="text-accent" />
        <h1 className="text-base font-semibold text-fg">Kanály</h1>
        <Button variant="primary" className="ml-auto" onClick={() => setShowForm((v) => !v)}>
          <Plus size={14} /> {showForm ? "Zavřít" : "Připojit bota"}
        </Button>
      </div>
      <p className="mb-6 text-sm text-fg-muted">
        Telegram a Discord boti, přes které mluvíš se svými boty z mobilu. Každý chat venku je tady normální konverzace — včetně schvalování jedním tapnutím.
      </p>

      {showForm && (
        <div className="mb-6">
          <ChannelForm agents={agents} onDone={() => { setShowForm(false); invalidate(); }} />
        </div>
      )}

      {channels.length === 0 && !showForm ? (
        <EmptyState
          title="Zatím žádný kanál"
          description="Připoj prvního bota — na Telegramu stačí token od @BotFather, na Discordu token z Developer Portalu."
        />
      ) : (
        <div className="space-y-3">
          {channels.map((c) => (
            <Card key={c.id}>
              <div className="flex items-start gap-3">
                <Avatar label={c.kind === "telegram" ? "TG" : "DC"} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-fg">{c.label}</span>
                    <Badge tone="neutral">{c.kind}</Badge>
                    {c.running ? <Badge tone="live">běží{c.botLabel ? ` · ${c.botLabel}` : ""}</Badge> : <Badge tone="danger">nebží</Badge>}
                    {!c.enabled && <Badge tone="neutral">vypnuto</Badge>}
                  </div>
                  <p className="mono mt-1 text-xs text-fg-subtle">token {c.tokenHint}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-xs text-fg-muted">
                      Výchozí bot
                      <select
                        value={c.defaultAgentId ?? ""}
                        onChange={(e) => setDefaultAgent.mutate({ id: c.id, defaultAgentId: e.target.value || null })}
                        className="h-8 max-w-[220px] rounded-md border border-border bg-bg-raised px-2 text-xs text-fg outline-none focus:border-accent"
                      >
                        <option value="">— nevybráno —</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} ({a.projectName})
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {c.allowedChats.length > 0 && (
                    <p className="mono mt-2 text-xs text-fg-subtle">allowlist: {c.allowedChats.join(", ")}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col gap-2">
                  <Button variant="secondary" onClick={() => test.mutate(c.id)} disabled={test.isPending}>
                    {test.isPending ? "…" : "Test"}
                  </Button>
                  <Button variant="secondary" onClick={() => toggle.mutate({ id: c.id, enabled: !c.enabled })} disabled={toggle.isPending}>
                    {c.enabled ? "Vypnout" : "Zapnout"}
                  </Button>
                  <DeleteButton onDelete={() => remove.mutate(c.id)} title="Smazat kanál" />
                </div>
              </div>
              {test.failureReason && test.variables === c.id && (
                <p className="mt-2 text-xs text-danger">{(test.failureReason as Error).message}</p>
              )}
            </Card>
          ))}
        </div>
      )}

      {bindings.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-fg">Aktivní chaty z kanálů</h2>
          <div className="space-y-2">
            {bindings.map((b) => (
              <Card key={b.id} className="p-3">
                <div className="flex items-center gap-2 text-sm">
                  <Badge tone="neutral">{b.externalChatId.split(":")[0]}</Badge>
                  <span className="mono truncate text-xs text-fg-muted">{b.externalChatId}</span>
                  {b.projectId ? (
                    <Link to={`/projects/${b.projectId}/sessions/${b.sessionId}`} className="ml-auto shrink-0 text-xs text-accent hover:underline">
                      {b.sessionTitle ?? "otevřít konverzaci"}
                    </Link>
                  ) : (
                    <span className="ml-auto shrink-0 text-xs text-fg-subtle">konverzace smazána</span>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      <Card className="mt-8">
        <h2 className="text-sm font-semibold text-fg">Jak na to</h2>
        <div className="mt-2 space-y-2 text-[13px] leading-relaxed text-fg-muted">
          <p>
            <strong className="text-fg">Telegram:</strong> napiš <span className="mono">@BotFather</span> → <span className="mono">/newbot</span>,
            zkopíruj token a vlož ho sem. Pak botovi napiš — odpověď přijde do stejného chatu. Příkazy: <span className="mono">/new</span> začne nový chat,{" "}
            <span className="mono">/approve 123…</span> / <span className="mono">/reject 123…</span> rozhodnou schválení (nebo tapni tlačítko).
          </p>
          <p>
            <strong className="text-fg">Discord:</strong> v <span className="mono">Developer Portal → Bot</span> zkopíruj token, v <span className="mono">OAuth2 → URL Generator</span> zaškrtni{" "}
            <span className="mono">bot</span> + <span className="mono">Send Messages</span> a pozvi bota na server. Nutné: v záložce <span className="mono">Bot</span> zapnout{" "}
            <span className="mono">MESSAGE CONTENT INTENT</span>, jinak bot nevidí text zpráv.
          </p>
          <p>
            <strong className="text-fg">Allowlist:</strong> prázdná znamená, že bot odpoví každému, kdo ho najde. Pro soukromí vyplň ID chatů (Telegram: ID zjistíš např.
            přes <span className="mono">@userinfobot</span>; Discord: pravý klik na kanál → Copy ID s Developer Mode).
          </p>
        </div>
      </Card>
    </div>
  );
}

function ChannelForm({ agents, onDone }: { agents: ChannelAgent[]; onDone: () => void }) {
  const [kind, setKind] = useState<"telegram" | "discord">("telegram");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [defaultAgentId, setDefaultAgentId] = useState("");
  const [allowedChats, setAllowedChats] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; botLabel: string }>("/channels", {
        kind,
        label,
        token,
        defaultAgentId: defaultAgentId || undefined,
        allowedChats: allowedChats.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
      }),
    onSuccess: onDone,
    onError: (err) => setError((err as Error).message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    create.mutate();
  }

  return (
    <Card className="p-4">
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <Label>Typ</Label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "telegram" | "discord")}
            className="h-9 w-full rounded-md border border-border bg-bg-raised px-3 text-sm text-fg outline-none focus:border-accent"
          >
            <option value="telegram">Telegram</option>
            <option value="discord">Discord</option>
          </select>
        </div>
        <div>
          <Label>Název</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} required placeholder={kind === "telegram" ? "např. Můj TG bot" : "např. Discord #general"} />
        </div>
        <div>
          <Label>Token bota</Label>
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} required className="mono" placeholder={kind === "telegram" ? "123456:ABC-DEF…" : "MTI…"} />
        </div>
        <div>
          <Label>Výchozí bot (odpovídá na nové chaty)</Label>
          <select
            value={defaultAgentId}
            onChange={(e) => setDefaultAgentId(e.target.value)}
            className="h-9 w-full rounded-md border border-border bg-bg-raised px-3 text-sm text-fg outline-none focus:border-accent"
          >
            <option value="">— vyber později —</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.projectName})
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Allowlist chatů (volitelné, čárkou oddělená ID)</Label>
          <Textarea value={allowedChats} onChange={(e) => setAllowedChats(e.target.value)} rows={2} className="mono" placeholder="123456789, 987654321" />
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? "Ověřuji token…" : "Připojit a ověřit"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Zrušit
          </Button>
        </div>
      </form>
    </Card>
  );
}
