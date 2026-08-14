import type { PersistedMessage } from "../lib/types";

function roleLabel(role: PersistedMessage["role"]): string {
  if (role === "user") return "you";
  if (role === "assistant") return "agent";
  return role;
}

export function MessageView({ message }: { message: PersistedMessage }) {
  return (
    <div className="border-b border-border px-4 py-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold text-fg-muted">{roleLabel(message.role)}</span>
        {message.cost > 0 && (
          <span className="font-mono text-xs text-fg-muted">${message.cost.toFixed(4)}</span>
        )}
      </div>
      <div className="space-y-2">
        {message.content.map((block, i) => {
          if (block.type === "text") {
            return (
              <p key={i} className="whitespace-pre-wrap text-sm">
                {block.text}
              </p>
            );
          }
          if (block.type === "image") {
            return (
              <img
                key={i}
                src={`data:${block.mimeType};base64,${block.data}`}
                alt="attachment"
                className="max-h-64 rounded border border-border"
              />
            );
          }
          if (block.type === "tool_use") {
            return (
              <div key={i} className="mono rounded bg-bg-sunken px-2 py-1 text-xs text-fg-muted">
                → {block.name}({JSON.stringify(block.input)})
              </div>
            );
          }
          return (
            <details key={i} className="mono rounded bg-bg-sunken px-2 py-1 text-xs">
              <summary className={block.isError ? "cursor-pointer text-danger" : "cursor-pointer text-fg-muted"}>
                tool result {block.isError ? "(error)" : ""}
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-all">{block.content}</pre>
            </details>
          );
        })}
      </div>
    </div>
  );
}
