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
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (m) return `${m[1]}.${m[2]}`;
  return name;
}
function argHintFor(input: unknown): string | undefined {
  if (input && typeof input === "object") {
    const first = Object.values(input as Record<string, unknown>)[0];
    if (typeof first === "string") return first;
  }
  return undefined;
}

export function ToolStepChecklist({ steps }: { steps: ToolStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-md border border-border bg-bg-sunken">
      <div className="flex items-center gap-1.5 border-b border-border bg-bg-raised px-2.5 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-live pulse-live" />
        <span className="mono text-[10px] font-[700] tracking-[0.08em] text-fg-subtle">NÁSTROJE · {steps.length}</span>
      </div>
      <ul className="divide-y divide-border">
        {steps.map((step) => {
          const Icon = iconFor(step.name);
          const argHint = argHintFor(step.input);
          const isPending = !step.result;
          const isError = step.result?.isError;
          return (
            <li key={step.id}>
              <details className="group px-2.5 py-1.5 open:pb-2">
                <summary className="flex cursor-pointer list-none items-center gap-2 marker:hidden">
                  {isPending ? <Loader2 size={12} className="shrink-0 animate-spin text-fg-subtle" /> : isError ? <TriangleAlert size={12} className="shrink-0 text-danger" /> : <Check size={12} className="shrink-0 text-live" />}
                  <Icon size={12} className="shrink-0 text-fg-subtle" />
                  <span className="mono text-[11px] font-[600] tracking-[-0.01em] text-fg">{labelFor(step.name)}</span>
                  {argHint && <span className="mono min-w-0 flex-1 truncate text-[11px] text-fg-subtle">{argHint}</span>}
                </summary>
                {step.result && (
                  <pre className="mono mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-bg-raised p-2 text-[11px] leading-relaxed text-fg-muted">
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
