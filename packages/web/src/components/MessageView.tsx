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
}: {
  message: PersistedMessage;
  /** tool_use id -> its result, gathered across the whole session — lets an assistant's tool_use blocks show their outcome inline. */
  toolResultsById?: Map<string, { content: string; isError?: boolean }>;
  /** agentId -> display name, for messages written by agents (direct conversations) instead of the human user. */
  senderNames?: Record<string, string>;
}) {
  if (message.purpose === "summarization") {
    const text = message.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")).join("\n");
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-2">
        <details className="group rounded-lg border border-border bg-bg-sunken px-3 py-2 text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-fg-muted marker:hidden">
            <Minimize2 size={13} className="flex-shrink-0" />
            <span>Chat compacted — earlier history summarized to save context</span>
          </summary>
          <div className="mt-2 whitespace-pre-wrap text-fg-muted">{text}</div>
        </details>
      </div>
    );
  }

  if (message.role === "user") {
    const textBlocks = message.content.filter((b) => b.type === "text");
    const imageBlocks = message.content.filter((b) => b.type === "image");
    const toolResults = message.content.filter((b) => b.type === "tool_result");

    // Tool-result-only messages are the mechanical continuation of the preceding
    // assistant turn's tool_use blocks, which already render this same result
    // inline (via toolResultsById) — nothing left to show here.
    if (textBlocks.length === 0 && imageBlocks.length === 0 && toolResults.length > 0) {
      return null;
    }

    // Messages written by an agent (direct conversation) sit on the left with
    // their name, like the other side of the conversation; the human user's
    // messages stay on the right.
    const senderName = message.senderAgentId ? senderNames?.[message.senderAgentId] : undefined;
    if (senderName) {
      return (
        <div className="mx-auto flex w-full max-w-3xl gap-3 px-4 py-1.5">
          <Avatar label={senderName} color={agentColor(message.senderAgentId!)} />
          <div className="min-w-0 max-w-[80%]">
            <p className="mb-0.5 text-xs font-medium text-fg-muted">{senderName}</p>
            <div className="space-y-2 rounded-2xl rounded-tl-md bg-bg-raised px-4 py-2.5 text-sm text-fg">
              {imageBlocks.map((block, i) =>
                block.type === "image" ? (
                  <img
                    key={i}
                    src={`data:${block.mimeType};base64,${block.data}`}
                    alt="attachment"
                    className="max-h-64 rounded-md border border-border"
                  />
                ) : null,
              )}
              {textBlocks.map((block, i) =>
                block.type === "text" ? (
                  <p key={i} className="whitespace-pre-wrap leading-relaxed">
                    {block.text}
                  </p>
                ) : null,
              )}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="mx-auto flex w-full max-w-3xl justify-end px-4 py-1.5">
        <div className="max-w-[75%] space-y-2 rounded-2xl rounded-tr-md bg-[#2c2f34] px-4 py-2.5 text-sm text-fg">
          {imageBlocks.map((block, i) =>
            block.type === "image" ? (
              <img
                key={i}
                src={`data:${block.mimeType};base64,${block.data}`}
                alt="attachment"
                className="max-h-64 rounded-md border border-border"
              />
            ) : null,
          )}
          {textBlocks.map((block, i) =>
            block.type === "text" ? (
              <p key={i} className="whitespace-pre-wrap leading-relaxed">
                {block.text}
              </p>
            ) : null,
          )}
        </div>
      </div>
    );
  }

  // Assistant turn: flowing text, then one grouped checklist for every tool call in the turn.
  const textBlocks = message.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
  const toolUses = message.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
  const steps: ToolStep[] = toolUses.map((block) => ({
    id: block.id,
    name: block.name,
    input: block.input,
    result: toolResultsById?.get(block.id),
  }));

  const senderName = message.senderAgentId ? senderNames?.[message.senderAgentId] : undefined;
  return (
    <div className="mx-auto flex w-full max-w-3xl gap-3 px-4 py-3">
      <Avatar label={senderName ?? "H"} color={message.senderAgentId ? agentColor(message.senderAgentId) : undefined} />
      <div className="min-w-0 flex-1 space-y-2">
        {senderName && <p className="mb-0.5 text-xs font-medium text-fg-muted">{senderName}</p>}
        {textBlocks.map((block, i) => (
          <Markdown key={i}>{block.text}</Markdown>
        ))}
        <ToolStepChecklist steps={steps} />
        {toolUses.length === 0 && textBlocks.length === 0 && (
          <p className="text-sm italic text-fg-subtle">(no output)</p>
        )}
        {message.cost > 0 && (
          <Badge tone="neutral" className="mt-1">
            ${message.cost.toFixed(4)}
          </Badge>
        )}
      </div>
    </div>
  );
}
