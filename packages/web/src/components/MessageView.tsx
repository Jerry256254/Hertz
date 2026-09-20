import { Minimize2 } from "lucide-react";
import type { PersistedMessage } from "../lib/types";
import { AgentAvatar } from "./AgentAvatar";
import { Badge } from "./ui";
import { Markdown } from "./Markdown";
import { ToolStepChecklist, type ToolStep } from "./ToolStepChecklist";

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
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] font-[600] tracking-[0.04em] text-fg-muted marker:hidden">
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
    <div className="mx-auto flex w-full max-w-[760px] gap-2.5 px-4 py-2 animate-fade-in">
      <div className="mt-0.5 shrink-0">
        <AgentAvatar seed={message.senderAgentId ?? agentId} size={30} />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="rounded-[20px] rounded-tl-[8px] border border-border bg-bg-raised px-4 py-3">
          {textBlocks.map((block, i) => <Markdown key={i}>{block.text}</Markdown>)}
          {toolUses.length === 0 && textBlocks.length === 0 && <p className="text-[12px] italic text-fg-subtle">(bez výstupu)</p>}
        </div>
        {steps.length > 0 && (collapsibleTools ? (
          <details className="group rounded-[14px] border border-border bg-bg-raised/60 px-3 py-2">
            <summary className="cursor-pointer list-none text-[12px] font-[600] text-fg-muted marker:hidden">
              {steps.length} {steps.length === 1 ? "krok" : steps.length < 5 ? "kroky" : "kroků"} ▸
            </summary>
            <div className="mt-2"><ToolStepChecklist steps={steps} /></div>
          </details>
        ) : (
          <ToolStepChecklist steps={steps} />
        ))}
        {message.cost > 0 && <Badge tone="neutral" className="mono">${message.cost.toFixed(4)}</Badge>}
      </div>
    </div>
  );
}
