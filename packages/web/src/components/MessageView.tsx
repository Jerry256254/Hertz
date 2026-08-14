import {
  FileEdit,
  FilePlus,
  Globe,
  ListChecks,
  Search,
  Terminal,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { PersistedMessage } from "../lib/types";
import { Avatar, Badge } from "./ui";

const TOOL_ICONS: Record<string, LucideIcon> = {
  read_file: Search,
  glob: Search,
  grep: Search,
  write_file: FilePlus,
  edit_file: FileEdit,
  shell_exec: Terminal,
  web_fetch: Globe,
  todo_write: ListChecks,
};

function ToolActivity({
  name,
  input,
  result,
}: {
  name: string;
  input?: unknown;
  result?: { content: string; isError?: boolean };
}) {
  const Icon = TOOL_ICONS[name] ?? Terminal;
  const argHint = input && typeof input === "object" ? Object.values(input as Record<string, unknown>)[0] : undefined;

  return (
    <details className="group rounded-md border border-border bg-bg-sunken px-2.5 py-1.5 text-xs open:pb-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-fg-muted marker:hidden">
        <Icon size={13} className="flex-shrink-0" />
        <span className="mono text-fg-muted">{name}</span>
        {typeof argHint === "string" && (
          <span className="mono min-w-0 flex-1 truncate text-fg-subtle">{argHint}</span>
        )}
        {result?.isError && <TriangleAlert size={12} className="flex-shrink-0 text-danger" />}
      </summary>
      {result && (
        <pre className="mono mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-sunken text-[11px] leading-relaxed text-fg-muted">
          {result.content}
        </pre>
      )}
    </details>
  );
}

export function MessageView({ message }: { message: PersistedMessage }) {
  if (message.role === "user") {
    const textBlocks = message.content.filter((b) => b.type === "text");
    const imageBlocks = message.content.filter((b) => b.type === "image");
    const toolResults = message.content.filter((b) => b.type === "tool_result");

    // Tool-result-only messages are the mechanical continuation of an assistant's
    // tool call — render as activity rows, not another "you" turn.
    if (textBlocks.length === 0 && imageBlocks.length === 0 && toolResults.length > 0) {
      return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 px-4 py-1">
          {toolResults.map((block, i) =>
            block.type === "tool_result" ? (
              <ToolActivity
                key={i}
                name="result"
                result={{ content: block.content, isError: block.isError }}
              />
            ) : null,
          )}
        </div>
      );
    }

    return (
      <div className="mx-auto flex w-full max-w-3xl justify-end px-4 py-2">
        <div className="max-w-[80%] space-y-2 rounded-lg bg-accent-wash px-4 py-2.5 text-sm text-fg">
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

  // Assistant turn: flowing text + inline tool-call activity, with an avatar.
  const toolUses = message.content.filter((b) => b.type === "tool_use");

  return (
    <div className="mx-auto flex w-full max-w-3xl gap-3 px-4 py-3">
      <Avatar label="H" tone="accent" />
      <div className="min-w-0 flex-1 space-y-2">
        {message.content.map((block, i) => {
          if (block.type === "text") {
            return (
              <p key={i} className="whitespace-pre-wrap text-[15px] leading-relaxed text-fg">
                {block.text}
              </p>
            );
          }
          if (block.type === "tool_use") {
            return <ToolActivity key={i} name={block.name} input={block.input} />;
          }
          return null;
        })}
        {toolUses.length === 0 && message.content.every((b) => b.type !== "text") && (
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
