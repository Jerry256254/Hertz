import {
  Check,
  FileEdit,
  FilePlus,
  Globe,
  ListChecks,
  Loader2,
  Monitor,
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
  if (name.startsWith("browser_")) return Globe;
  if (name.startsWith("desktop_")) return Monitor;
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
    <ul className="divide-y divide-border/50">
      {steps.map((step) => {
        const Icon = iconFor(step.name);
        const argHint = argHintFor(step.input);
        const isPending = !step.result;
        const isError = step.result?.isError;
        return (
          <li key={step.id}>
            <details className="group py-1 open:pb-1.5">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 marker:hidden">
                {isPending ? <Loader2 size={11} className="shrink-0 animate-spin text-fg-subtle" /> : isError ? <TriangleAlert size={11} className="shrink-0 text-danger" /> : <Check size={11} className="shrink-0 text-live" />}
                <Icon size={11} className="shrink-0 text-fg-subtle" />
                <span className="mono text-[11px] font-[600] tracking-[-0.01em] text-fg-muted">{labelFor(step.name)}</span>
                {argHint && <span className="mono min-w-0 flex-1 truncate text-[11px] text-fg-subtle/70">{argHint}</span>}
              </summary>
              {step.result && (
                <pre className="mono mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-bg-sunken p-2 text-[11px] leading-relaxed text-fg-muted">
                  {step.result.content}
                </pre>
              )}
            </details>
          </li>
        );
      })}
    </ul>
  );
}
