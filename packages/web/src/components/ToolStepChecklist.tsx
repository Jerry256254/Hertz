import {
  Check,
  FileEdit,
  FilePlus,
  Globe,
  ListChecks,
  Loader2,
  Search,
  Terminal,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

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

export interface ToolStep {
  id: string;
  name: string;
  input?: unknown;
  result?: { content: string; isError?: boolean };
}

function iconFor(name: string): LucideIcon {
  if (name.startsWith("mcp__")) return Globe;
  return TOOL_ICONS[name] ?? Terminal;
}

function labelFor(name: string): string {
  const mcpMatch = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (mcpMatch) return `${mcpMatch[1]}.${mcpMatch[2]}`;
  return name;
}

function argHintFor(input: unknown): string | undefined {
  if (input && typeof input === "object") {
    const first = Object.values(input as Record<string, unknown>)[0];
    if (typeof first === "string") return first;
  }
  return undefined;
}

/**
 * A single card grouping several tool steps together, each with its own
 * completion state — the "checklist" the agent worked through for this turn,
 * instead of a flat sequence of separate raw tool-call/tool-result bubbles.
 */
export function ToolStepChecklist({ steps }: { steps: ToolStep[] }) {
  if (steps.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-bg-sunken text-xs">
      <ul className="divide-y divide-border">
        {steps.map((step) => {
          const Icon = iconFor(step.name);
          const argHint = argHintFor(step.input);
          const isPending = !step.result;
          const isError = step.result?.isError;
          return (
            <li key={step.id}>
              <details className="group px-2.5 py-1.5 open:pb-2.5">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-fg-muted marker:hidden">
                  {isPending ? (
                    <Loader2 size={13} className="flex-shrink-0 animate-spin text-fg-subtle" />
                  ) : isError ? (
                    <TriangleAlert size={13} className="flex-shrink-0 text-danger" />
                  ) : (
                    <Check size={13} className="flex-shrink-0 text-success" />
                  )}
                  <Icon size={13} className="flex-shrink-0" />
                  <span className="mono text-fg-muted">{labelFor(step.name)}</span>
                  {argHint && <span className="mono min-w-0 flex-1 truncate text-fg-subtle">{argHint}</span>}
                </summary>
                {step.result && (
                  <pre className="mono mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-raised p-2 text-[11px] leading-relaxed text-fg-muted">
                    {step.result.content}
                  </pre>
                )}
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
