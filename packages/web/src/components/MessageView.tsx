import { ChevronRight, Minimize2 } from "lucide-react";
import type { PersistedMessage } from "../lib/types";
import { fmtDateTime, fmtMsgTime } from "../lib/format";
import { FileAttachmentCard } from "./FileAttachmentCard";
import { Markdown } from "./Markdown";
import { ToolStepChecklist, type ToolStep } from "./ToolStepChecklist";

const NUDGE_PREFIX = "[System nudge — not from the user]";

export function MessageView({
  message,
  toolResultsById,
  projectId,
  collapsibleTools = true,
  stepsSettled = false,
  agentName,
  firstInRun = true,
  lastInRun = true,
}: {
  message: PersistedMessage;
  toolResultsById?: Map<string, { content: string; isError?: boolean }>;
  /** Kept for API compatibility (unused now that bubbles no longer show an avatar). */
  agentId: string;
  /** Project id — builds the attachment download URLs. */
  projectId: string;
  collapsibleTools?: boolean;
  /** True when the run is over — orphaned tool uses stop spinning. */
  stepsSettled?: boolean;
  /** Agent display name shown above the first assistant bubble of a run. */
  agentName?: string;
  /** False when the previous visible block has the same role — tighter spacing, squared corner. */
  firstInRun?: boolean;
  /** False when the next visible block has the same role — tighter spacing, squared corner, no caption. */
  lastInRun?: boolean;
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

    // Stacked same-side bubbles square the corners facing their neighbours.
    const rounding = `rounded-[22px] ${lastInRun ? "rounded-br-[7px]" : ""} ${firstInRun ? "" : "rounded-tr-[7px]"}`;
    return (
      <div className={`mx-auto flex w-full max-w-[760px] animate-fade-in justify-end px-4 ${firstInRun ? "pt-2.5" : "pt-[3px]"} ${lastInRun ? "pb-2.5" : "pb-[3px]"}`}>
        <div className="flex max-w-[78%] flex-col items-end">
          <div
            className={rounding}
            style={{
              backgroundColor: "var(--color-user-bubble)",
              color: "var(--color-user-bubble-fg)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.16)",
              padding: "11px 18px",
            }}
          >
            {imageBlocks.map((block, i) => block.type === "image" ? <img key={i} src={`data:${block.mimeType};base64,${block.data}`} alt="příloha" className="mb-2 max-h-64 rounded-[12px]" /> : null)}
            {textBlocks.map((block, i) => block.type === "text" ? <p key={i} className="whitespace-pre-wrap break-words text-[14.5px] font-normal leading-[1.65] tracking-[-0.006em]">{block.text}</p> : null)}
          </div>
          {lastInRun && (
            <span title={fmtDateTime(message.createdAt)} className="mr-1.5 mt-1 select-none text-[11px] font-[500] leading-none text-fg-faint">
              {fmtMsgTime(message.createdAt)}
            </span>
          )}
        </div>
      </div>
    );
  }

  const textBlocks = message.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text" && b.text.trim().length > 0);
  const toolUses = message.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
  const attachments = message.attachments ?? [];
  const steps: ToolStep[] = toolUses.map((block) => ({ id: block.id, name: block.name, input: block.input, result: toolResultsById?.get(block.id) }));
  // Nothing visible (e.g. image-only turn — artifacts render separately in ChatView): no empty bubble.
  if (textBlocks.length === 0 && toolUses.length === 0 && attachments.length === 0) return null;

  const rounding = `rounded-[22px] ${lastInRun ? "rounded-bl-[7px]" : ""} ${firstInRun ? "" : "rounded-tl-[7px]"}`;
  return (
    <div className={`mx-auto w-full max-w-[760px] animate-fade-in px-4 ${firstInRun ? "pt-2.5" : "pt-[3px]"} ${lastInRun ? "pb-2.5" : "pb-[3px]"}`}>
      <div className="max-w-[88%]">
        {firstInRun && (
          <div className="mb-1.5 flex select-none items-baseline gap-1.5 pl-[18px]">
            <span className="text-[11.5px] font-[700] uppercase tracking-[0.04em] text-fg-subtle">{agentName ?? "Hertz"}</span>
            <span title={fmtDateTime(message.createdAt)} className="text-[11px] font-[500] leading-none text-fg-faint">
              {fmtMsgTime(message.createdAt)}
            </span>
          </div>
        )}
        <div className="min-w-0 space-y-1.5">
          {textBlocks.length > 0 && (
            <div
              className={`assistant-bubble ${rounding} border border-border-faint shadow-md`}
              style={{
                background: "linear-gradient(180deg, #202026 0%, #1b1b1f 100%)",
                padding: "15px 20px",
              }}
            >
              {textBlocks.map((block, i) => <Markdown key={i}>{block.text}</Markdown>)}
            </div>
          )}
          {attachments.map((attachment) => (
            <div key={attachment.id} className="py-0.5">
              <FileAttachmentCard attachment={attachment} projectId={projectId} />
            </div>
          ))}
          {steps.length > 0 && (collapsibleTools ? (
            <details className="group px-0.5 py-1">
              <summary className="flex cursor-pointer list-none items-center gap-0.5 text-[11.5px] font-[600] text-fg-subtle marker:hidden hover:text-fg-muted">
                {steps.length} {steps.length === 1 ? "krok" : steps.length < 5 ? "kroky" : "kroků"}
                <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
              </summary>
              <div className="mt-1"><ToolStepChecklist steps={steps} settled={stepsSettled} /></div>
            </details>
          ) : (
            <ToolStepChecklist steps={steps} settled={stepsSettled} />
          ))}
        </div>
      </div>
    </div>
  );
}
