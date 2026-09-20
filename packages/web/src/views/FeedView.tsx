import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Heart, Newspaper } from "lucide-react";
import { api } from "../lib/api";
import type { Agent, ApprovalItem, SessionListItem } from "../lib/types";
import { relTime } from "../lib/format";

const PROMPT_KEY = "hertz-feed-prompt";
const DEFAULT_PROMPT = "Shrň mi každé ráno to nejdůležitější: co agent včera udělal, co čeká na schválení a co je dnes v plánu.";

function loadPrompt(): string {
  try {
    return localStorage.getItem(PROMPT_KEY) ?? DEFAULT_PROMPT;
  } catch {
    return DEFAULT_PROMPT;
  }
}

interface FeedArticle {
  id: string;
  day: string;
  emoji: string;
  headline: string;
  body: string;
  time: string;
  ts: number;
}

/**
 * Kanál příspěvků — digest feed. Day sections are built from real activity
 * (recent chats, approvals); the prompt card configures what the agent
 * should prepare, and Diskutovat jumps into the chat about an article.
 */
export function FeedView({ agent, mainChatId, onDiscuss }: { agent: Agent; mainChatId: string | null; onDiscuss: (text: string) => void }) {
  const [prompt, setPrompt] = useState(loadPrompt);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(prompt);
  const [liked, setLiked] = useState<Set<string>>(new Set());

  const { data: sessionsData } = useQuery({
    queryKey: ["sessions", "all"],
    queryFn: () => api.get<{ sessions: SessionListItem[] }>("/sessions"),
    refetchInterval: 15000,
  });
  const { data: approvalsData } = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<{ approvals: ApprovalItem[] }>("/approvals"),
    refetchInterval: 15000,
  });

  const articles = useMemo<FeedArticle[]>(() => {
    const out: FeedArticle[] = [];
    const sessions = (sessionsData?.sessions ?? []).filter((s) => s.agentId === agent.id).slice(0, 12);
    for (const s of sessions) {
      const d = new Date(s.updatedAt);
      const dayLabel = Date.now() - d.getTime() < 24 * 3600 * 1000 ? "Dnešek" : d.toLocaleDateString("cs-CZ", { weekday: "long", day: "numeric", month: "numeric" });
      out.push({
        id: `s-${s.id}`,
        day: dayLabel,
        emoji: "💬",
        headline: s.title,
        body: `Konverzace s agentem ${agent.name} — poslední aktivita ${relTime(s.updatedAt)}.`,
        time: relTime(s.updatedAt),
        ts: d.getTime(),
      });
    }
    for (const a of (approvalsData?.approvals ?? []).slice(0, 8)) {
      const d = new Date(a.createdAt);
      const dayLabel = Date.now() - d.getTime() < 24 * 3600 * 1000 ? "Dnešek" : d.toLocaleDateString("cs-CZ", { weekday: "long", day: "numeric", month: "numeric" });
      out.push({
        id: `a-${a.id}`,
        day: dayLabel,
        emoji: a.status === "pending" ? "🛡️" : a.status === "approved" ? "✅" : "⛔",
        headline: a.summary,
        body: a.kind === "host_access" ? "Žádost o přístup na hostitelský disk." : (a.detail ?? "Žádost o schválení."),
        time: relTime(a.createdAt),
        ts: d.getTime(),
      });
    }
    out.sort((x, y) => y.ts - x.ts);
    return out;
  }, [sessionsData, approvalsData, agent]);

  const days = useMemo(() => {
    const groups = new Map<string, FeedArticle[]>();
    for (const a of articles) {
      const list = groups.get(a.day) ?? [];
      list.push(a);
      groups.set(a.day, list);
    }
    return [...groups.entries()];
  }, [articles]);

  function savePrompt() {
    try {
      localStorage.setItem(PROMPT_KEY, draft);
    } catch {
      /* ignore */
    }
    setPrompt(draft);
    setEditing(false);
  }

  function generate() {
    if (!mainChatId) return;
    onDiscuss(`Připrav mi přehled podle mého kanálu příspěvků. Zadání:\n${prompt}`);
  }

  function toggleLike(id: string) {
    setLiked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-[60px] shrink-0 items-center gap-3 px-3 md:px-5">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-wash text-accent"><Newspaper size={18} /></span>
        <div>
          <p className="text-[16px] font-[700] tracking-[-0.02em] text-fg">Kanál příspěvků</p>
          <p className="text-[12px] text-fg-muted">Přehled toho, co agent dělá</p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 md:px-5">
        <div className="mx-auto w-full max-w-[760px] space-y-5">
          <div className="rounded-[20px] border border-border bg-bg-raised p-5">
            <p className="text-[11px] font-[700] tracking-[0.08em] text-fg-subtle">VÁŠ PROMPT V KANÁLU PŘÍSPĚVKŮ</p>
            {editing ? (
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} className="mt-2 w-full resize-y rounded-[14px] border border-border bg-bg-sunken p-3 text-[13.5px] text-fg outline-none focus:border-accent" />
            ) : (
              <p className="mt-2 text-[14px] leading-relaxed text-fg">{prompt}</p>
            )}
            <div className="mt-3 flex gap-2">
              {editing ? (
                <>
                  <button onClick={savePrompt} className="pressable rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white">Uložit</button>
                  <button onClick={() => { setDraft(prompt); setEditing(false); }} className="pressable rounded-full border border-border bg-bg-sunken px-5 py-2 text-[13px] font-[600] text-fg">Zrušit</button>
                </>
              ) : (
                <>
                  <button onClick={() => setEditing(true)} className="pressable rounded-full border border-border bg-bg-sunken px-5 py-2 text-[13px] font-[600] text-fg hover:bg-bg-hover">Upravit</button>
                  <button onClick={generate} disabled={!mainChatId} className="pressable rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white hover:bg-accent-hover disabled:opacity-40">Generovat</button>
                </>
              )}
            </div>
          </div>

          {days.length === 0 && (
            <p className="py-8 text-center text-[13.5px] text-fg-subtle">Zatím tu nic není. Až agent začne pracovat, objeví se tu přehled.</p>
          )}
          {days.map(([day, items]) => (
            <section key={day}>
              <p className="mb-2 px-1 text-[13px] font-[700] text-fg">{day}</p>
              <div className="space-y-3">
                {items.map((a) => (
                  <article key={a.id} className="rounded-[20px] border border-border bg-bg-raised p-5">
                    <div className="flex items-start gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-[18px]">{a.emoji}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[15px] font-[700] leading-snug tracking-[-0.01em] text-fg">{a.headline}</p>
                        <p className="mt-1 text-[13.5px] leading-relaxed text-fg-muted">{a.body} <span className="text-fg-subtle">· {a.time}</span></p>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <button onClick={() => toggleLike(a.id)} title="To se mi líbí" className={`pressable flex h-9 w-9 items-center justify-center rounded-full border ${liked.has(a.id) ? "border-danger/40 bg-danger-wash text-danger" : "border-border text-fg-muted hover:text-danger"}`}>
                        <Heart size={15} fill={liked.has(a.id) ? "currentColor" : "none"} />
                      </button>
                      <button onClick={() => onDiscuss(`Pojďme probrat: ${a.headline}`)} className="pressable rounded-full border border-border bg-bg-sunken px-4 py-2 text-[13px] font-[600] text-fg hover:bg-bg-hover">
                        Diskutovat
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
