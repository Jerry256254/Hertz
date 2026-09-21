import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Plus, Search, Send, Trash2, X } from "lucide-react";
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
      setCreateChatError(null);
      void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] });
      onSelectChat(res.id);
    },
    onError: () => setCreateChatError("Chat se nepodařilo založit."),
  });
  const [createChatError, setCreateChatError] = useState<string | null>(null);
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
      {/* identity */}
      <div className="flex shrink-0 items-center gap-3 px-4 pb-2 pt-4">
        <AgentAvatar seed={agent.id} size={36} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-[700] tracking-[-0.01em] text-fg">{agent.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-fg-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-live" /> Připojeno
          </span>
        </span>
        <button onClick={onClose} title="Zavřít panel" aria-label="Zavřít panel" className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-sunken hover:text-fg">
          <X size={17} />
        </button>
      </div>

      {/* search */}
      <div className="shrink-0 px-4 pt-1">
        <button
          onClick={onOpenSearch}
          className="pressable flex h-11 w-full items-center gap-2.5 rounded-xl border border-border bg-bg-raised px-4 text-[13.5px] text-fg-subtle hover:border-border-strong hover:text-fg-muted"
        >
          <Search size={15} className="shrink-0" />
          Hledat v chatech
        </button>
      </div>

      {/* list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2">
        {mainChatId && (
          <div className="px-2">
            <SectionLabel>Hlavní</SectionLabel>
            <Row active={activeSessionId === mainChatId} onClick={() => onSelectChat(mainChatId)}>
              <AgentAvatar seed={agent.id} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-[600] text-fg">Hlavní chat</span>
                <span className="block truncate text-[12px] text-fg-muted">{agent.name}</span>
              </span>
            </Row>
          </div>
        )}

        <div className="px-2">
          <SectionLabel>Kanály</SectionLabel>
          {bindings.length === 0 && (
            <p className="px-3 py-2 text-[12.5px] leading-snug text-fg-subtle">
              {channels.length === 0 ? "Žádné kanály. Připoj Telegram či Discord v Nastavení › Kanály zpráv." : "Zatím žádná konverzace z kanálů."}
            </p>
          )}
          {bindings.slice(0, 10).map((b) => (
            <Row key={b.id} active={activeChannelBinding?.id === b.id} onClick={() => onSelectChannel(b)}>
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${channelChipClass(channels.find((c) => c.id === b.channelId)?.kind ?? "")}`}>
                <Send size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-[600] text-fg">{channelName(b.channelId)}</span>
                <span className="block truncate text-[12px] text-fg-muted">{b.sessionTitle || b.externalChatId}</span>
              </span>
              <span className="shrink-0 text-[11px] text-fg-faint">{relTime(b.createdAt)}</span>
            </Row>
          ))}
        </div>

        <div className="px-2">
          <div className="flex items-center justify-between">
            <SectionLabel>Postranní chaty</SectionLabel>
            <button
              onClick={() => createChat.mutate()}
              disabled={createChat.isPending}
              title="Nový postranní chat"
              aria-label="Nový postranní chat"
              className="pressable relative flex h-8 w-8 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-sunken hover:text-fg disabled:opacity-40 before:absolute before:-inset-2 before:content-['']"
            >
              <Plus size={16} />
            </button>
          </div>
          {sideChats.length === 0 && <p className="px-3 py-2 text-[12.5px] text-fg-subtle">Zatím žádné. Založ první tlačítkem +.</p>}
          {createChatError && <p className="px-3 py-1 text-[12px] text-danger">{createChatError}</p>}
          {sideChats.map((s) => (
            <div
              key={s.id}
              className={`group relative flex min-h-[52px] w-full items-center gap-1 rounded-xl px-2 py-1.5 transition-colors ${activeSessionId === s.id ? "bg-accent/[0.12]" : "hover:bg-bg-sunken/60"}`}
            >
              {activeSessionId === s.id && <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-full bg-accent" />}
              <button onClick={() => onSelectChat(s.id)} className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 rounded-lg px-1.5 text-left">
                <MessageSquare size={15} className={`shrink-0 ${activeSessionId === s.id ? "text-accent" : "text-fg-faint"}`} />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[13.5px] ${activeSessionId === s.id ? "font-[600] text-fg" : "font-[500] text-fg"}`}>{truncate(s.title, 36)}</span>
                  <span className="block text-[11.5px] text-fg-faint">{relTime(s.updatedAt)}</span>
                </span>
              </button>
              {confirmDelete === s.id ? (
                <span className="flex shrink-0 items-center gap-1.5 pr-1">
                  <button onClick={() => deleteChat.mutate(s.id)} className="pressable min-h-[36px] rounded-full bg-danger px-3 text-[12px] font-[700] text-white">Smazat</button>
                  <button onClick={() => setConfirmDelete(null)} className="pressable min-h-[36px] rounded-full bg-bg-hover px-3 text-[12px] font-[700] text-fg-muted">Nechat</button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmDelete(s.id)}
                  title="Smazat chat"
                  aria-label="Smazat chat"
                  className="pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg-faint hover:bg-bg-sunken hover:text-danger md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pb-1.5 pt-4 text-[11px] font-[700] uppercase tracking-[0.09em] text-fg-subtle">
      {children}
    </p>
  );
}

function Row({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`pressable relative flex min-h-[52px] w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
        active ? "bg-accent/[0.12]" : "hover:bg-bg-sunken/60"
      }`}
    >
      {active && <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-full bg-accent" />}
      {children}
    </button>
  );
}
