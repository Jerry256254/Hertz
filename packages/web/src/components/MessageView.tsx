import { Minimize2 } from "lucide-react";
import type { PersistedMessage } from "../lib/types";
import { Avatar, Badge } from "./ui";
import { agentColor } from "../lib/agent-color";
import { Markdown } from "./Markdown";
import { ToolStepChecklist, type ToolStep } from "./ToolStepChecklist";

export function MessageView({
  message,
  toolResultsById,
  senderNames,
  senderMascots,
}: {
  message: PersistedMessage;
  toolResultsById?: Map<string, { content: string; isError?: boolean }>;
  senderNames?: Record<string, string>;
  senderMascots?: Record<string, string | null | undefined>;
}) {
  if (message.purpose === "summarization") {
    const text = message.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")).join("\n");
    return (
      <div className="mx-auto w-full max-w-[720px] px-4 py-2">
        <details className="group rounded-[10px] border border-border bg-bg-sunken px-3 py-2">
          <summary className="flex cursor-pointer list-none items-center gap-2 mono text-[11px] font-[600] tracking-[0.04em] text-fg-muted marker:hidden">
            <Minimize2 size={12} className="shrink-0" />
            ZHUSTĚNO <span className="font-normal tracking-normal text-fg-subtle">— agent shrnul kontext, nic důležitého se neztratilo</span>
          </summary>
          <div className="mono mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-fg-muted">{text}</div>
        </details>
      </div>
    );
  }

  if (message.role === "user") {
    const textBlocks = message.content.filter((b) => b.type === "text");
    const imageBlocks = message.content.filter((b) => b.type === "image");
    const toolResults = message.content.filter((b) => b.type === "tool_result");
    if (textBlocks.length === 0 && imageBlocks.length === 0 && toolResults.length > 0) return null;

    const senderName = message.senderAgentId ? senderNames?.[message.senderAgentId] : undefined;
    if (senderName) {
      return (
        <div className="mx-auto flex w-full max-w-[720px] gap-2.5 px-4 py-1.5">
          <Avatar label={senderName} color={agentColor(message.senderAgentId!)} mascot={senderMascots?.[message.senderAgentId!]} />
          <div className="min-w-0 max-w-[82%]">
            <p className="mono mb-1 text-[10px] font-[700] tracking-[0.06em] text-fg-muted">{senderName.toUpperCase()}</p>
            <div className="space-y-2 rounded-[12px] border border-border bg-bg-raised px-3 py-2.5 text-[13px] leading-relaxed text-fg">
              {imageBlocks.map((block, i) => block.type === "image" ? <img key={i} src={`data:${block.mimeType};base64,${block.data}`} alt="příloha" className="max-h-64 rounded-[8px] border border-border" /> : null)}
              {textBlocks.map((block, i) => block.type === "text" ? <p key={i} className="whitespace-pre-wrap leading-relaxed">{block.text}</p> : null)}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="mx-auto flex w-full max-w-[720px] justify-end px-4 py-1.5">
        <div className="max-w-[78%] rounded-[14px] bg-fg px-3.5 py-2.5 text-[13px] leading-relaxed text-bg-raised">
          {imageBlocks.map((block, i) => block.type === "image" ? <img key={i} src={`data:${block.mimeType};base64,${block.data}`} alt="příloha" className="mb-2 max-h-64 rounded-[8px] border border-white/10" /> : null)}
          {textBlocks.map((block, i) => block.type === "text" ? <p key={i} className="whitespace-pre-wrap">{block.text}</p> : null)}
        </div>
      </div>
    );
  }

  const textBlocks = message.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
  const toolUses = message.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
  const steps: ToolStep[] = toolUses.map((block) => ({ id: block.id, name: block.name, input: block.input, result: toolResultsById?.get(block.id) }));
  const senderName = message.senderAgentId ? senderNames?.[message.senderAgentId] : undefined;
  return (
    <div className="mx-auto flex w-full max-w-[720px] gap-2.5 px-4 py-2">
      <Avatar label={senderName ?? "H"} color={message.senderAgentId ? agentColor(message.senderAgentId) : undefined} mascot={message.senderAgentId ? senderMascots?.[message.senderAgentId] : undefined} />
      <div className="min-w-0 flex-1 space-y-2">
        {senderName && <p className="mono text-[10px] font-[700] tracking-[0.06em] text-fg-muted">{senderName.toUpperCase()}</p>}
        <div className="rounded-[12px] border border-border bg-bg-raised px-3 py-2.5">
          {textBlocks.map((block, i) => <Markdown key={i}>{block.text}</Markdown>)}
          {toolUses.length === 0 && textBlocks.length === 0 && <p className="mono text-[12px] italic text-fg-subtle">(bez výstupu)</p>}
        </div>
        <ToolStepChecklist steps={steps} />
        {message.cost > 0 && <Badge tone="neutral" className="mono">${message.cost.toFixed(4)}</Badge>}
      </div>
    </div>
  );
}
