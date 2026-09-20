import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bold, Heading1, Heading2, Heading3, Italic, List, ListOrdered, MoreHorizontal, X } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { Agent, AgentLayeredMemory } from "../lib/types";
import { AgentAvatar } from "../components/AgentAvatar";
import { Markdown } from "../components/Markdown";
import { SkillsEditor } from "./SkillsEditor";

const DEFAULT_SOUL = `Buď opravdu užitečný. Měj názory. Než se zeptáš, zkus si poradit sám. Jsi hostem v něčím životě — chovej se tak.`;

/**
 * SOUL.md editor — the persona file. The server stores two layers: the
 * agent-maintained L3 persona (shown as context) and the user's system
 * prompt (editable here, saved via PATCH /api/agents/:id).
 */
export function SoulEditor({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState(false);
  const [tab, setTab] = useState<"soul" | "skills">("soul");

  const { data: memory } = useQuery({
    queryKey: ["memory", agent.id],
    queryFn: () => api.get<AgentLayeredMemory>(`/agents/${agent.id}/memory`),
  });

  const save = useMutation({
    mutationFn: (systemPrompt: string) => api.patch(`/agents/${agent.id}`, { systemPrompt }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      setTimeout(() => setSaved(false), 2000);
      void queryClient.invalidateQueries({ queryKey: ["agent"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Uložení selhalo"),
  });

  const value = text ?? agent.systemPrompt ?? "";
  const dirty = value !== (agent.systemPrompt ?? "");

  function wrap(before: string, after = "") {
    const el = document.getElementById("soul-textarea") as HTMLTextAreaElement | null;
    if (!el) {
      setText(`${before}${value}${after}`);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + before.length, end + before.length);
    });
  }

  function prefixLine(prefix: string) {
    const el = document.getElementById("soul-textarea") as HTMLTextAreaElement | null;
    const pos = el?.selectionStart ?? value.length;
    const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
    setText(`${value.slice(0, lineStart)}${prefix}${value.slice(lineStart)}`);
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-[60px] shrink-0 items-center gap-2.5 px-3 md:px-5">
        <AgentAvatar seed={agent.id} size={30} />
        <div className="flex gap-1 rounded-full border border-border bg-bg-raised p-1">
          <button onClick={() => setTab("soul")} className={`pressable rounded-full px-3.5 py-1.5 text-[12.5px] font-[600] ${tab === "soul" ? "bg-bg-sunken text-fg" : "text-fg-subtle hover:text-fg-muted"}`}>📄 SOUL.md</button>
          <button onClick={() => setTab("skills")} className={`pressable rounded-full px-3.5 py-1.5 text-[12.5px] font-[600] ${tab === "skills" ? "bg-bg-sunken text-fg" : "text-fg-subtle hover:text-fg-muted"}`}>⚡ Skills</button>
        </div>
        <span className="flex-1" />
        {tab === "soul" && (
          <>
            <div className="hidden items-center gap-0.5 md:flex">
              <ToolButton title="Tučně" onClick={() => wrap("**", "**")}><Bold size={15} /></ToolButton>
              <ToolButton title="Kurzíva" onClick={() => wrap("*", "*")}><Italic size={15} /></ToolButton>
              <ToolButton title="Nadpis 1" onClick={() => prefixLine("# ")}><Heading1 size={15} /></ToolButton>
              <ToolButton title="Nadpis 2" onClick={() => prefixLine("## ")}><Heading2 size={15} /></ToolButton>
              <ToolButton title="Nadpis 3" onClick={() => prefixLine("### ")}><Heading3 size={15} /></ToolButton>
              <ToolButton title="Odrážky" onClick={() => prefixLine("- ")}><List size={15} /></ToolButton>
              <ToolButton title="Číslování" onClick={() => prefixLine("1. ")}><ListOrdered size={15} /></ToolButton>
            </div>
            <ToolButton title="Náhled" onClick={() => setPreview((v) => !v)} active={preview}><MoreHorizontal size={15} /></ToolButton>
            {dirty && (
              <button onClick={() => save.mutate(value)} disabled={save.isPending} className="pressable rounded-full bg-accent px-4 py-2 text-[13px] font-[600] text-white disabled:opacity-40">
                {save.isPending ? "Ukládám…" : saved ? "Uloženo ✓" : "Uložit"}
              </button>
            )}
            {saved && !dirty && <span className="text-[13px] font-[600] text-live">Uloženo ✓</span>}
          </>
        )}
        <ToolButton title="Zavřít" onClick={onClose}><X size={16} /></ToolButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 md:px-5">
        <div className="mx-auto w-full max-w-[760px]">
          {tab === "skills" ? (
            <SkillsEditor agent={agent} />
          ) : (
            <>
              <p className="border-l-2 border-accent pl-3 text-[13px] italic leading-relaxed text-fg-muted">
                O tomhle souboru: duše agenta — kým je a jak se chová. Tvoje úpravy tu mají přednost před tím, co si agent píše sám.
              </p>
              <h1 className="mb-3 mt-4 text-[22px] font-[700]">SOUL.md</h1>
              {error && <p className="mb-3 rounded-[14px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">{error}</p>}

              {preview ? (
                <div className="rounded-[20px] border border-border bg-bg-raised p-5">
                  <Markdown>{value || DEFAULT_SOUL}</Markdown>
                </div>
              ) : (
                <textarea
                  id="soul-textarea"
                  value={value}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={DEFAULT_SOUL}
                  rows={16}
                  className="w-full resize-y rounded-[20px] border border-border bg-bg-raised p-5 text-[14px] leading-relaxed text-fg placeholder:text-fg-subtle outline-none focus:border-accent"
                />
              )}

              {memory?.persona && (
                <div className="mt-4 rounded-[20px] border border-border bg-bg-raised p-5">
                  <p className="mb-2 text-[11px] font-[700] tracking-[0.06em] text-fg-subtle">CO SI O SOBĚ PÍŠE AGENT SÁM (JEN KE ČTENÍ)</p>
                  <Markdown>{memory.persona}</Markdown>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolButton({ title, onClick, children, active = false }: { title: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button onClick={onClick} title={title} className={`pressable rounded-full p-2 ${active ? "bg-bg-sunken text-fg" : "text-fg-muted hover:bg-bg-sunken hover:text-fg"}`}>
      {children}
    </button>
  );
}
