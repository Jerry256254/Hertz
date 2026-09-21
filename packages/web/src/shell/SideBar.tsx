import { useState } from "react";
import { MessageSquare, MessageSquarePlus, Plus, Search, Send, Trash2, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
      <div className="flex shrink-0 items-center gap-3 px-5 pb-4 pt-5">
        <span className="shrink-0 rounded-full ring-1 ring-white/10">
          <AgentAvatar seed={agent.id} size={40} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold tracking-[-0.01em] text-fg">{agent.name}</span>
          <span className="mt-1 flex items-center gap-1.5 text-[12px] font-medium text-fg-muted">
            <span className="pulse-live h-1.5 w-1.5 rounded-full bg-live" />
            Připojeno
          </span>
        </span>
        <button
          onClick={onClose}
          title="Zavřít panel"
          aria-label="Zavřít panel"
          className="pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg-faint hover:bg-bg-sunken hover:text-fg-muted"
        >
          <X size={16} />
        </button>
      </div>

      {/* actions */}
      <div className="shrink-0 border-b border-border-faint px-4 pb-4">
        <div className="flex items-center gap-2">
          <button
            onClick={onOpenSearch}
            className="pressable flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-2xl border border-border-faint bg-bg-raised px-3.5 text-[13px] text-fg-subtle shadow-xs hover:border-border-strong hover:text-fg-muted"
          >
            <Search size={15} className="shrink-0" />
            <span className="truncate">Hledat v chatech</span>
          </button>
          <button
            onClick={() => createChat.mutate()}
            disabled={createChat.isPending}
            title="Nový chat"
            aria-label="Nový chat"
            className="pressable flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent text-white shadow-sm hover:bg-accent-hover disabled:opacity-50"
          >
            <Plus size={17} strokeWidth={2.5} />
          </button>
        </div>
        {createChatError && (
          <p className="mt-2 rounded-xl bg-danger-wash px-3 py-2 text-[12px] font-medium text-danger">{createChatError}</p>
        )}
      </div>

      {/* list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-1">
        {mainChatId && (
          <section aria-label="Hlavní">
            <SectionHeader label="Hlavní" />
            <ChatRow active={activeSessionId === mainChatId} onClick={() => onSelectChat(mainChatId)}>
              <span className="shrink-0 overflow-hidden rounded-full">
                <AgentAvatar seed={agent.id} size={36} />
              </span>
              <RowText
                title="Hlavní chat"
                subtitle={agent.name}
                active={activeSessionId === mainChatId}
              />
            </ChatRow>
          </section>
        )}

        <Divider />

        <section aria-label="Kanály">
          <SectionHeader label="Kanály" count={bindings.length} />
          {bindings.length === 0 ? (
            <EmptyState
              icon={<Send size={16} />}
              title={channels.length === 0 ? "Žádné kanály" : "Zatím žádné konverzace"}
              hint={
                channels.length === 0
                  ? "Připoj Telegram či Discord v Nastavení › Kanály zpráv."
                  : "Konverzace z připojených kanálů se objeví tady."
              }
            />
          ) : (
            bindings.slice(0, 10).map((b) => {
              const active = activeChannelBinding?.id === b.id;
              return (
                <ChatRow key={b.id} active={active} onClick={() => onSelectChannel(b)}>
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${channelChipClass(
                      channels.find((c) => c.id === b.channelId)?.kind ?? ""
                    )}`}
                  >
                    <Send size={15} />
                  </span>
                  <RowText
                    title={channelName(b.channelId)}
                    subtitle={b.sessionTitle || b.externalChatId}
                    meta={relTime(b.createdAt)}
                    active={active}
                  />
                </ChatRow>
              );
            })
          )}
        </section>

        <Divider />

        <section aria-label="Postranní chaty">
          <SectionHeader label="Postranní chaty" count={sideChats.length} />
          {sideChats.length === 0 ? (
            <EmptyState
              icon={<MessageSquarePlus size={16} />}
              title="Zatím žádné postranní chaty"
              hint="Založ první tlačítkem + nahoře."
            />
          ) : (
            sideChats.map((s) => {
              const active = activeSessionId === s.id;
              return (
                <div
                  key={s.id}
                  className={`group relative flex items-center gap-0.5 rounded-2xl transition-colors duration-150 ${
                    active ? "bg-accent/[0.10] ring-1 ring-inset ring-accent/20" : "hover:bg-white/[0.045]"
                  }`}
                >
                  <button
                    onClick={() => onSelectChat(s.id)}
                    className="pressable flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-3 py-2.5 text-left"
                  >
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors ${
                        active ? "bg-accent/15 text-accent" : "bg-bg-sunken text-fg-subtle"
                      }`}
                    >
                      <MessageSquare size={15} />
                    </span>
                    <RowText title={truncate(s.title, 38)} subtitle={relTime(s.updatedAt)} active={active} stacked />
                  </button>
                  {confirmDelete === s.id ? (
                    <span className="flex shrink-0 items-center gap-1.5 pr-2">
                      <button
                        onClick={() => deleteChat.mutate(s.id)}
                        className="pressable h-9 rounded-full bg-danger px-3.5 text-[12px] font-bold text-white hover:brightness-110"
                      >
                        Smazat
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="pressable h-9 rounded-full bg-bg-hover px-3.5 text-[12px] font-semibold text-fg-muted hover:text-fg"
                      >
                        Nechat
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(s.id)}
                      title="Smazat chat"
                      aria-label="Smazat chat"
                      className="pressable mr-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg-faint hover:bg-bg-sunken hover:text-danger md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </section>
      </div>
    </div>
  );
}

function Divider() {
  return <div aria-hidden className="mx-1 my-3 border-t border-border-faint" />;
}

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex items-center justify-between px-3 pb-1.5 pt-3.5">
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-fg-faint">{label}</p>
      {typeof count === "number" && count > 0 && (
        <span className="flex h-[18px] min-w-[22px] items-center justify-center rounded-full bg-bg-sunken px-1.5 text-[10.5px] font-bold tabular-nums text-fg-subtle">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </div>
  );
}

/** Unified conversation row: soft wash + inner ring when active, subtle hover otherwise. */
function ChatRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`pressable flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors duration-150 ${
        active ? "bg-accent/[0.10] ring-1 ring-inset ring-accent/20" : "hover:bg-white/[0.045]"
      }`}
    >
      {children}
    </button>
  );
}

function RowText({
  title,
  subtitle,
  meta,
  active,
  stacked,
  unread,
}: {
  title: string;
  subtitle: string;
  meta?: string;
  active: boolean;
  /** subtitle below the title instead of beside it */
  stacked?: boolean;
  /** unread message count — renders an accent badge when > 0 */
  unread?: number;
}) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex items-baseline gap-2">
        <span
          className={`min-w-0 flex-1 truncate text-[13.5px] leading-snug ${
            active ? "font-semibold text-fg" : "font-medium text-fg"
          }`}
        >
          {title}
        </span>
        {typeof unread === "number" && unread > 0 ? (
          <UnreadBadge count={unread} />
        ) : (
          meta && <span className="shrink-0 text-[11px] tabular-nums text-fg-faint">{meta}</span>
        )}
      </span>
      <span
        className={`mt-0.5 block truncate text-[12px] leading-snug ${stacked ? "text-fg-faint" : "text-fg-muted"}`}
      >
        {subtitle}
      </span>
    </span>
  );
}

function UnreadBadge({ count }: { count: number }) {
  return (
    <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[10.5px] font-bold tabular-nums text-white shadow-sm">
      {count > 99 ? "99+" : count}
    </span>
  );
}

function EmptyState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-2xl border border-dashed border-border-strong/70 px-4 py-5 text-center">
      <span className="mb-0.5 flex h-9 w-9 items-center justify-center rounded-xl bg-bg-sunken text-fg-subtle">
        {icon}
      </span>
      <p className="text-[12.5px] font-semibold text-fg-muted">{title}</p>
      {hint && <p className="max-w-[220px] text-[11.5px] leading-snug text-fg-subtle">{hint}</p>}
    </div>
  );
}
