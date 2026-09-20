import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CornerDownLeft, Folder, MessageSquare, Search } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { HertzSession, Project } from "../lib/types";

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  kind: "page" | "project" | "session";
  to: string;
}

const PAGES: Array<{ label: string; to: string; admin?: boolean }> = [
  { label: "Dashboard", to: "/" },
  { label: "Schválení", to: "/approvals", admin: true },
  { label: "Kanály (Telegram, Discord)", to: "/channels", admin: true },
  { label: "Integrace", to: "/integrations" },
  { label: "Provideři", to: "/providers" },
  { label: "Uživatelé", to: "/users", admin: true },
  { label: "Účet a API tokeny", to: "/account" },
];

function matches(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(q));
}

/**
 * ⌘K command palette: fuzzy jump to pages, projects, and chats.
 * Global hotkey (Cmd/Ctrl+K), arrows + Enter, Esc closes.
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: projectsData } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/projects"),
    enabled: open,
  });
  const { data: sessionsData } = useQuery({
    queryKey: ["sessions", "all"],
    queryFn: () => api.get<{ sessions: HertzSession[] }>("/sessions"),
    enabled: open,
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open ]);

  const items: PaletteItem[] = useMemo(() => {
    const out: PaletteItem[] = [];
    for (const p of PAGES) {
      if (p.admin && user?.role !== "admin") continue;
      if (matches(query, p.label)) out.push({ id: p.to, label: p.label, kind: "page", to: p.to });
    }
    for (const p of projectsData?.projects ?? []) {
      if (matches(query, p.name)) out.push({ id: `p:${p.id}`, label: p.name, hint: "projekt", kind: "project", to: `/projects/${p.id}` });
    }
    for (const s of (sessionsData?.sessions ?? []).slice(0, 30)) {
      if (matches(query, s.title)) {
        out.push({ id: `s:${s.id}`, label: s.title, hint: "chat", kind: "session", to: `/projects/${s.projectId}/sessions/${s.id}` });
      }
    }
    return out.slice(0, 40);
  }, [query, projectsData, sessionsData, user?.role]);

  useEffect(() => setActive(0), [query]);

  function go(item: PaletteItem | undefined) {
    if (!item) return;
    setOpen(false);
    navigate(item.to);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[14vh]" role="dialog" aria-modal="true" aria-label="Rychlá navigace">
      <div className="absolute inset-0 bg-[#11110E]/24 backdrop-blur-[2px]" onClick={() => setOpen(false)} aria-hidden />
      <div className="animate-fade-in relative w-full max-w-[560px] overflow-hidden rounded-lg border border-border bg-bg-raised shadow-popover">
        <div className="flex items-center gap-2.5 border-b border-border px-3.5">
          <Search size={14} className="shrink-0 text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter") go(items[active]);
            }}
            placeholder="Kam to bude? Stránky, projekty, chaty…"
            className="h-11 w-full bg-transparent text-[14px] text-fg placeholder:text-fg-subtle outline-none"
          />
          <kbd className="mono hidden shrink-0 rounded-sm border border-border bg-bg-sunken px-1.5 py-0.5 text-[10px] font-[600] text-fg-subtle sm:inline">ESC</kbd>
        </div>
        <ul className="max-h-[320px] overflow-y-auto p-1.5">
          {items.length === 0 && <li className="px-3 py-4 text-center text-[13px] text-fg-subtle">Nic jsem nenašel.</li>}
          {items.map((item, i) => (
            <li key={item.id}>
              <button
                onClick={() => go(item)}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] ${i === active ? "bg-fg text-bg-raised" : "text-fg"}`}
              >
                {item.kind === "project" ? (
                  <Folder size={13} className={i === active ? "text-bg-raised/70" : "text-fg-subtle"} />
                ) : item.kind === "session" ? (
                  <MessageSquare size={13} className={i === active ? "text-bg-raised/70" : "text-fg-subtle"} />
                ) : (
                  <CornerDownLeft size={13} className={i === active ? "text-bg-raised/70" : "text-fg-subtle"} />
                )}
                <span className="min-w-0 flex-1 truncate font-[500]">{item.label}</span>
                {item.hint && (
                  <span className={`mono shrink-0 text-[10px] tracking-wide ${i === active ? "text-bg-raised/60" : "text-fg-subtle"}`}>{item.hint}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
