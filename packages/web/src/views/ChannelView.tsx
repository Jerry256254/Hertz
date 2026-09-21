import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { api } from "../lib/api";
import type { Agent, ChannelBinding, ChannelConfig } from "../lib/types";
import { channelAppGenitive, channelChipClass } from "../lib/channels";
import { ChatView } from "../chat/ChatView";

/**
 * Channel chat (Telegram/Discord/WhatsApp-style) — read-only mirror of the
 * linked session with a "continue in the app" banner.
 */
export function ChannelView({
  agent,
  binding,
  onOpenPreview,
  previewActive,
  onToggleSidebar,
  onOpenAgent,
}: {
  agent: Agent;
  binding: ChannelBinding;
  onOpenPreview: () => void;
  previewActive: boolean;
  onToggleSidebar: () => void;
  onOpenAgent?: () => void;
}) {
  const { data: channelsData } = useQuery({
    queryKey: ["channels"],
    queryFn: () => api.get<{ channels: ChannelConfig[] }>("/channels"),
    retry: false,
  });
  const channel = channelsData?.channels.find((c) => c.id === binding.channelId);
  const appName = channelAppGenitive(channel?.kind);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2.5 px-3 pt-3 md:px-5">
        <span className={`flex h-9 w-9 items-center justify-center rounded-full ${channelChipClass(channel?.kind ?? "")}`}><Send size={15} /></span>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-[700] text-fg">{channel?.label ?? "Kanál"}</p>
          <p className="truncate text-[12px] text-fg-muted">{binding.sessionTitle || binding.externalChatId} · jen zobrazení</p>
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatView
          sessionId={binding.sessionId}
          agent={agent}
          title={binding.sessionTitle ?? undefined}
          readOnly
          banner={`Jen zobrazení — zprávy se synchronizují z ${appName}. Pokračuj v konverzaci v ${appName}.`}
          onOpenPreview={onOpenPreview}
          previewActive={previewActive}
          onToggleSidebar={onToggleSidebar}
          onOpenAgent={onOpenAgent}
        />
      </div>
    </div>
  );
}
