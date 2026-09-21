import { Minimize2 } from "lucide-react";
import type { PersistedMessage } from "../lib/types";
import { AgentAvatar } from "./AgentAvatar";
import { Markdown } from "./Markdown";
import { ToolStepChecklist, type ToolStep } from "./ToolStepChecklist";

const NUDGE_PREFIX = "[System nudge — not from the user]";

export function MessageView({
  message,
  toolResultsById,
  agentId,
  collapsibleTools = true,
}: {
  message: PersistedMessage;
  toolResultsById?: Map<string, { content: string; isError?: boolean }>;
  agentId: string;
  collapsibleTools?: boolean;
}) {
  if (message.purpose === "summarization") {
    const text = message.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")).join("\n");
    return (
      <div className="mx-auto w-full max-w-[760px] px-4 py-2">
        <details className="group rounded-[16px] border border-border bg-bg-raised px-4 py-2.5">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[12px] font-[600] text-fg-muted marker:hidden">
            <Minimize2 size={12} className="shrink-0" />
            Zhustěno <span className="font-normal text-fg-subtle">— agent shrnul kontext, nic důležitého se neztratilo</span>
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
    // Spin-guard nudges are system notices, not user bubbles.
    const onlyText = textBlocks.length === 1 && imageBlocks.length === 0 && toolResults.length === 0 ? textBlocks[0] : undefined;
    if (onlyText?.type === "text" && onlyText.text.startsWith(NUDGE_PREFIX)) {
      return (
        <div className="mx-auto w-full max-w-[760px] px-4 py-1.5">
          <p className="rounded-[14px] border border-dashed border-border px-4 py-2.5 text-center text-[12.5px] italic leading-relaxed text-fg-muted">
            {onlyText.text.slice(NUDGE_PREFIX.length).trim()}
          </p>
        </div>
      );
    }

    return (
      <div className="mx-auto flex w-full max-w-[760px] justify-end px-4 py-1.5 animate-fade-in">
        <div
          className="max-w-[80%] rounded-[20px] rounded-br-[8px] px-4 py-2.5 text-[14px] leading-relaxed"
          style={{ backgroundColor: "var(--color-user-bubble)", color: "var(--color-user-bubble-fg)" }}
        >
          {imageBlocks.map((block, i) => block.type === "image" ? <img key={i} src={`data:${block.mimeType};base64,${block.data}`} alt="příloha" className="mb-2 max-h-64 rounded-[12px]" /> : null)}
          {textBlocks.map((block, i) => block.type === "text" ? <p key={i} className="whitespace-pre-wrap">{block.text}</p> : null)}
        </div>
      </div>
    );
  }

  const textBlocks = message.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
  const toolUses = message.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
  const steps: ToolStep[] = toolUses.map((block) => ({ id: block.id, name: block.name, input: block.input, result: toolResultsById?.get(block.id) }));
  return (
    <div className="mx-auto flex w-full max-w-[760px] gap-2 px-4 py-1.5 animate-fade-in">
      <div className="mt-0.5 shrink-0">
        <AgentAvatar seed={message.senderAgentId ?? agentId} size={24} />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="rounded-[16px] rounded-tl-[6px] border border-border bg-bg-raised px-3.5 py-2.5">
          {textBlocks.map((block, i) => <Markdown key={i}>{block.text}</Markdown>)}
          {toolUses.length === 0 && textBlocks.length === 0 && <p className="text-[12px] italic text-fg-subtle">(bez výstupu)</p>}
        </div>
        {steps.length > 0 && (collapsibleTools ? (
          <details className="group px-0.5 py-1">
            <summary className="cursor-pointer list-none text-[11.5px] font-[600] text-fg-subtle marker:hidden hover:text-fg-muted">
              {steps.length} {steps.length === 1 ? "krok" : steps.length < 5 ? "kroky" : "kroků"} ▸
            </summary>
            <div className="mt-1"><ToolStepChecklist steps={steps} /></div>
          </details>
        ) : (
          <ToolStepChecklist steps={steps} />
        ))}
      </div>
    </div>
  );
}
