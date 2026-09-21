import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Plus, Search, Send, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import type { Agent, ChannelBinding, ChannelConfig, SessionListItem } from "../lib/types";
import { relTime, truncate } from "../lib/format";
import { channelChipClass } from "../lib/channels";
import { AgentAvatar } from "../components/AgentAvatar";

export function SideBar({
  agent,
  projectId,
  mainChatId,
  activeSessionId,
  activeChannelBinding,
  onSelectChat,
  onSelectChannel,
  onOpenSearch,
  onClose,
}: {
  agent: Agent;
  projectId: string;
  mainChatId: string | null;
  activeSessionId: string | null;
  activeChannelBinding: ChannelBinding | null;
  onSelectChat: (sessionId: string) => void;
  onSelectChannel: (binding: ChannelBinding) => void;
  onOpenSearch: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const { data: sessionsData } = useQuery({
    queryKey: ["sessions", "all"],
    queryFn: () => api.get<{ sessions: SessionListItem[] }>("/sessions"),
    refetchInterval: 10000,
  });
  const { data: channelsData } = useQuery({
    queryKey: ["channels"],
    queryFn: () => api.get<{ channels: ChannelConfig[] }>("/channels"),
    retry: false,
  });
  const { data: bindingsData } = useQuery({
    queryKey: ["channel-bindings"],
    queryFn: () => api.get<{ bindings: ChannelBinding[] }>("/channels/bindings"),
    retry: false,
  });

  const createChat = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/agents/${agent.id}/sessions`, { projectId }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] });
      onSelectChat(res.id);
    },
  });
  const deleteChat = useMutation({
    mutationFn: (id: string) => api.delete(`/sessions/${id}`),
    onSuccess: (_d, id) => {
      setConfirmDelete(null);
      void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] });
      if (id === activeSessionId && mainChatId) onSelectChat(mainChatId);
    },
  });

  const mine = (sessionsData?.sessions ?? []).filter((s) => s.agentId === agent.id);
  const channels = channelsData?.channels ?? [];
  const bindings = bindingsData?.bindings ?? [];
  const boundSessionIds = new Set(bindings.map((b) => b.sessionId));
  // Channel sessions live in the channels section — never duplicated as side chats.
  const sideChats = mine.filter((s) => s.id !== mainChatId && !boundSessionIds.has(s.id)).sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
  const channelName = (id: string) => channels.find((c) => c.id === id)?.label ?? "Kanál";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2.5 px-3 pb-1 pt-3">
        <AgentAvatar seed={agent.id} size={32} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-[700] tracking-[-0.01em] text-fg">{agent.name}</span>
          <span className="flex items-center gap-1.5 text-[12px] text-fg-muted">
            <span className="h-2 w-2 rounded-full bg-live" /> Připojeno
          </span>
        </span>
        <button onClick={onClose} title="Zavřít panel" className="pressable rounded-full p-2 text-fg-muted hover:bg-bg-sunken hover:text-fg">
          <X size={15} />
        </button>
      </div>
      <div className="shrink-0 px-3 pt-2">
        <button onClick={onOpenSearch} className="pressable flex w-full items-center gap-2.5 rounded-full border border-border bg-bg-raised px-4 py-2.5 text-[13.5px] text-fg-subtle hover:bg-bg-hover hover:text-fg-muted">
          <Search size={15} />
          Hledat
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {mainChatId && (
          <button
            onClick={() => onSelectChat(mainChatId)}
            className={`pressable flex w-full items-center gap-2.5 rounded-[14px] px-3 py-2.5 text-left ${activeSessionId === mainChatId ? "bg-bg-sunken" : "hover:bg-bg-sunken/50"}`}
          >
            <AgentAvatar seed={agent.id} size={30} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-[600] text-fg">Hlavní chat</span>
              <span className="block truncate text-[12px] text-fg-muted">{agent.name}</span>
            </span>
          </button>
        )}

        <p className="px-3 pb-1 pt-4 text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">Kanály</p>
        {bindings.length === 0 && (
          <p className="px-3 py-1.5 text-[12.5px] leading-snug text-fg-subtle">
            {channels.length === 0 ? "Žádné kanály. Připoj Telegram/Discord v Nastavení → Kanály zpráv." : "Zatím žádná konverzace z kanálů."}
          </p>
        )}
        {bindings.slice(0, 10).map((b) => (
          <button
            key={b.id}
            onClick={() => onSelectChannel(b)}
            className={`pressable flex w-full items-center gap-2.5 rounded-[14px] px-3 py-2.5 text-left ${activeChannelBinding?.id === b.id ? "bg-bg-sunken" : "hover:bg-bg-sunken/50"}`}
          >
            <span className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full ${channelChipClass(channels.find((c) => c.id === b.channelId)?.kind ?? "")}`}>
              <Send size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-[600] text-fg">{channelName(b.channelId)}</span>
              <span className="block truncate text-[12px] text-fg-muted">{b.sessionTitle || b.externalChatId}</span>
            </span>
            <span className="shrink-0 text-[11px] text-fg-subtle">{relTime(b.createdAt)}</span>
          </button>
        ))}

        <div className="flex items-center justify-between px-3 pb-1 pt-4">
          <p className="text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">Postranní chaty</p>
          <button onClick={() => createChat.mutate()} disabled={createChat.isPending} title="Nový postranní chat" className="pressable flex h-7 w-7 items-center justify-center rounded-full border border-border bg-bg-raised text-fg-muted hover:text-fg disabled:opacity-40">
            <Plus size={14} />
          </button>
        </div>
        {sideChats.length === 0 && <p className="px-3 py-1.5 text-[12.5px] text-fg-subtle">Zatím žádné. Založ první tlačítkem +.</p>}
        {sideChats.map((s) => (
          <div key={s.id} className={`group flex w-full items-center gap-2 rounded-[14px] px-3 py-2 ${activeSessionId === s.id ? "bg-bg-sunken" : "hover:bg-bg-sunken/50"}`}>
            <button onClick={() => onSelectChat(s.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
              <MessageCircle size={15} className="shrink-0 text-fg-subtle" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-[500] text-fg">{truncate(s.title, 34)}</span>
                <span className="block text-[11.5px] text-fg-subtle">{relTime(s.updatedAt)}</span>
              </span>
            </button>
            {confirmDelete === s.id ? (
              <span className="flex shrink-0 gap-1">
                <button onClick={() => deleteChat.mutate(s.id)} title="Opravdu smazat" className="rounded-full bg-danger px-2 py-1 text-[11px] font-[700] text-white">Ano</button>
                <button onClick={() => setConfirmDelete(null)} title="Nechat" className="rounded-full bg-bg-hover px-2 py-1 text-[11px] font-[700] text-fg-muted">Ne</button>
              </span>
            ) : (
              <button onClick={() => setConfirmDelete(s.id)} title="Smazat chat" className="hidden shrink-0 rounded-full p-1.5 text-fg-subtle hover:text-danger group-hover:block">
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
