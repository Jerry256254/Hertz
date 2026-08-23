import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { Agent } from "../lib/types";
import { Badge, Button, Card, CardDescription, CardHeader, CardTitle, EmptyState, IconButton, Input, Label } from "../components/ui";

interface ChannelItem {
  id: string;
  kind: "telegram" | "discord";
  label: string;
  defaultAgentId: string | null;
  agentName: string | null;
  allowedChats: string[];
  enabled: boolean;
  live: boolean;
}

export function ChannelsPage() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"telegram" | "discord">("telegram");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [defaultAgentId, setDefaultAgentId] = useState("");
  const [allowedChats, setAllowedChats] = useState("");

  const { data: agentsData } = useQuery({
    queryKey: ["agents", "all"],
    queryFn: () => api.get<{ agents: Array<Agent & { homeProjectName?: string }> }>("/agents"),
  });

  const { data: channelsData } = useQuery({
    queryKey: ["channels"],
    queryFn: () => api.get<{ channels: ChannelItem[] }>("/channels"),
    refetchInterval: 8000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["channels"] });

  const createChannel = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post("/channels", body),
    onSuccess: () => {
      setLabel("");
      setToken("");
      setAllowedChats("");
      invalidate();
    },
  });

  const patchChannel = useMutation({
    mutationFn: (args: { id: string; body: Record<string, unknown> }) => api.patch(`/channels/${args.id}`, args.body),
    onSuccess: invalidate,
  });

  const deleteChannel = useMutation({
    mutationFn: (id: string) => api.delete(`/channels/${id}`),
    onSuccess: invalidate,
  });

  const agents = agentsData?.agents ?? [];
  const channels = channelsData?.channels ?? [];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
      <div className="mb-5 flex items-center gap-2">
        <Radio size={18} className="text-accent" />
        <h1 className="text-base font-semibold text-fg">Channels</h1>
      </div>
      <p className="mb-6 text-sm text-fg-muted">
        Connect a Telegram or Discord bot and message your agents from your phone — a message wakes them anywhere.
      </p>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="text-sm">Connect a bot</CardTitle>
          <CardDescription>Create a Telegram bot (BotFather) or a Discord bot (Developer Portal) and paste its token.</CardDescription>
        </CardHeader>
        <div className="space-y-3 px-4 pb-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setKind("telegram")}
              className={`flex-1 rounded-lg border px-3 py-2 text-xs transition-colors ${kind === "telegram" ? "border-accent text-accent" : "border-border text-fg-muted"}`}
            >
              Telegram
            </button>
            <button
              type="button"
              onClick={() => setKind("discord")}
              className={`flex-1 rounded-lg border px-3 py-2 text-xs transition-colors ${kind === "discord" ? "border-accent text-accent" : "border-border text-fg-muted"}`}
            >
              Discord
            </button>
          </div>
          <div>
            <Label>Label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My bot" />
          </div>
          <div>
            <Label>Bot token</Label>
            <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder={kind === "telegram" ? "123456:ABC-DEF..." : "MTIzNDU2..."} />
          </div>
          <div>
            <Label>Default agent</Label>
            <select
              value={defaultAgentId}
              onChange={(e) => setDefaultAgentId(e.target.value)}
              className="w-full rounded-md border border-border bg-bg-raised px-2.5 py-1.5 text-sm text-fg"
            >
              <option value="">— pick one —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.role})
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Allowed chats (optional)</Label>
            <Input
              value={allowedChats}
              onChange={(e) => setAllowedChats(e.target.value)}
              placeholder="comma-separated chat IDs — empty = allow all"
            />
          </div>
          <Button
            size="sm"
            disabled={!label || !token || !defaultAgentId || createChannel.isPending}
            onClick={() =>
              createChannel.mutate({
                kind,
                label,
                token,
                defaultAgentId,
                allowedChats: allowedChats.split(",").map((s) => s.trim()).filter(Boolean),
              })
            }
          >
            Connect
          </Button>
        </div>
      </Card>

      {channels.length === 0 ? (
        <EmptyState title="No channels yet" description="Connect your first bot and run your agents from your phone." />
      ) : (
        <ul className="space-y-2">
          {channels.map((c) => (
            <li key={c.id} className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
              <Badge tone={c.live ? "success" : "neutral"}>{c.kind}</Badge>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-fg">{c.label}</div>
                <div className="truncate text-xs text-fg-subtle">
                  → {c.agentName ?? "no default agent"} · {c.allowedChats.length > 0 ? `${c.allowedChats.length} allowed chats` : "open"}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => patchChannel.mutate({ id: c.id, body: { enabled: !c.enabled } })}
              >
                {c.enabled ? "Disable" : "Enable"}
              </Button>
              <IconButton title="Delete" onClick={() => deleteChannel.mutate(c.id)}>
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
