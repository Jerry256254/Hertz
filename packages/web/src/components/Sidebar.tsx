import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Check,
  Copy,
  Search,
  Settings2,
  Folder,
  LogOut,
  MessagesSquare,
  Plug,
  Plus,
  ShieldCheck,
  Users,
  X,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { HertzSession, Project } from "../lib/types";
import { Avatar, IconButton } from "./ui";

interface SidebarSession extends HertzSession {
  agentName: string;
  peerAgentName?: string | null;
  projectName: string;
}

export function Sidebar({ onClose }: { onClose?: () => void } = {}) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const params = useParams<{ projectId?: string; sessionId?: string }>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  const { data: projectsData } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/projects"),
  });
  const { data: sessionsData } = useQuery({
    queryKey: ["sessions", "all"],
    queryFn: () => api.get<{ sessions: SidebarSession[] }>("/sessions"),
    refetchInterval: 6000,
  });

  const sessionsByProject = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, SidebarSession[]>();
    for (const s of sessionsData?.sessions ?? []) {
      if (q && !`${s.title} ${s.agentName ?? ""} ${s.peerAgentName ?? ""}`.toLowerCase().includes(q)) continue;
      const list = map.get(s.projectId) ?? [];
      list.push(s);
      map.set(s.projectId, list);
    }
    return map;
  }, [sessionsData, query]);

  function toggle(pid: string) {
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(pid)) n.delete(pid);
      else n.add(pid);
      return n;
    });
  }

  const projects = projectsData?.projects ?? [];

  return (
    <aside className="flex h-full w-full flex-col bg-bg-sidebar">
      {/* Mark */}
      <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="flex h-7 w-7 items-center justify-center bg-fg text-bg-raised">
          <span className="mono text-[11px] font-[700] tracking-[0.08em]">H</span>
        </div>
        <div className="min-w-0 leading-none">
          <div className="mono text-[11.5px] font-[700] tracking-[0.18em] text-fg">HERTZ</div>
          <div className="mono text-[10px] font-[500] tracking-[0.12em] text-fg-subtle">WORKSPACE</div>
        </div>
        <span className="ml-auto hidden h-5 items-center rounded-full border border-border bg-bg-sunken px-2 mono text-[10px] font-[600] tracking-[0.08em] text-fg-muted md:inline-flex">
          v0.13
        </span>
        {onClose && (
          <button onClick={onClose} className="ml-auto flex h-8 w-8 items-center justify-center rounded-[8px] border border-border text-fg-subtle hover:bg-bg-hover hover:text-fg md:hidden" aria-label="Zavřít">
            <X size={15} strokeWidth={1.9} />
          </button>
        )}
      </div>

      {/* Search + create */}
      <div className="p-3">
        <label className="flex h-[36px] items-center gap-2 rounded-[8px] border border-border bg-bg-sunken px-2.5 focus-within:border-border-strong focus-within:bg-bg-raised">
          <Search size={13} className="shrink-0 text-fg-subtle" strokeWidth={1.8} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Hledat v chatech…"
            className="w-full bg-transparent text-[13px] leading-none text-fg placeholder:text-fg-subtle outline-none"
          />
          <span className="hidden rounded-[6px] border border-border bg-bg-raised px-1.5 py-0.5 mono text-[10px] font-[600] tracking-wide text-fg-subtle sm:inline">⌘K</span>
        </label>
        <button
          onClick={() => navigate("/")}
          className="mt-2.5 flex h-[36px] w-full items-center justify-center gap-1.5 bg-fg text-bg-raised mono text-[12px] font-[600] tracking-[0.06em] hover:bg-accent-hover active:scale-[0.99]"
        >
          <Plus size={13} strokeWidth={2} /> NOVÝ PROJEKT
        </button>
      </div>

      {/* Projects */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <div className="mb-2 flex items-center justify-between px-1 pt-1">
          <span className="mono text-[10px] font-[700] tracking-[0.14em] text-fg-subtle">PROJEKTY</span>
          <span className="mono text-[10px] font-[600] tracking-wide text-fg-faint">{projects.length}</span>
        </div>

        {projects.length === 0 && (
          <p className="px-1 py-3 text-[13px] leading-relaxed text-fg-subtle">Zatím žádný projekt — založ první z dashboardu.</p>
        )}

        <ul className="space-y-1">
          {projects.map((project) => {
            const sessions = (sessionsByProject.get(project.id) ?? []).slice(0, 8);
            const isCollapsed = collapsed.has(project.id);
            const isActive = params.projectId === project.id;
            return (
              <li key={project.id} className={isActive ? "rounded-[10px] bg-bg-sunken" : ""}>
                <div className={`group flex items-center gap-1 rounded-[10px] px-1 py-1 ${isActive ? "" : "hover:bg-bg-sunken"}`}>
                  <button
                    onClick={() => toggle(project.id)}
                    className="flex h-6 w-6 items-center justify-center rounded-[6px] text-fg-subtle hover:bg-bg-raised hover:text-fg"
                    aria-label={isCollapsed ? "Rozbalit" : "Sbalit"}
                  >
                    <ChevronRight size={12} strokeWidth={2} className={`transition-transform duration-150 ${isCollapsed ? "" : "rotate-90"}`} />
                  </button>
                  <Link
                    to={`/projects/${project.id}`}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] px-1 py-1 text-[13px] font-[500] tracking-[-0.01em] text-fg"
                  >
                    <span className={`flex h-5 w-5 items-center justify-center rounded-[6px] border text-[11px] ${isActive ? "border-fg bg-fg text-bg-raised" : "border-border bg-bg-raised text-fg-subtle"}`}>
                      <Folder size={11} strokeWidth={1.8} />
                    </span>
                    <span className="truncate">{project.name}</span>
                  </Link>
                </div>
                {!isCollapsed && (
                  <ProjectContacts projectId={project.id} activeSessionId={params.sessionId} sessions={sessions} />
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {/* System */}
      <div className="shrink-0 border-t border-border">
        <div className="p-2">
          <div className="rounded-[12px] border border-border bg-bg-sunken p-1.5">
            <Link to="/approvals" className="flex items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[13px] font-[500] text-fg-muted hover:bg-bg-raised hover:text-fg">
              <ShieldCheck size={14} strokeWidth={1.7} /> Schválení
            </Link>
            <Link to="/integrations" className="flex items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[13px] font-[500] text-fg-muted hover:bg-bg-raised hover:text-fg">
              <Plug size={14} strokeWidth={1.7} /> Integrace
            </Link>
            <Link to="/providers" className="flex items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[13px] font-[500] text-fg-muted hover:bg-bg-raised hover:text-fg">
              <Settings2 size={14} strokeWidth={1.7} /> Provideři
            </Link>
            {user?.role === "admin" && (
              <Link to="/users" className="flex items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[13px] font-[500] text-fg-muted hover:bg-bg-raised hover:text-fg">
                <Users size={14} strokeWidth={1.7} /> Uživatelé
              </Link>
            )}
          </div>

          <div className="mt-2">
            <CheckUpdatesBlock />
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-bg-raised px-2.5 py-2.5">
          <Link to="/account" className="flex min-w-0 flex-1 items-center gap-2.5">
            <Avatar label={user?.email ?? "?"} />
            <span className="mono min-w-0 flex-1 truncate text-[11.5px] font-[500] tracking-[-0.01em] text-fg-muted">{user?.email}</span>
          </Link>
          <IconButton title="Odhlásit" onClick={() => void logout()} className="h-7 w-7 rounded-[8px] border border-border">
            <LogOut size={13} strokeWidth={1.85} />
          </IconButton>
        </div>
      </div>
    </aside>
  );
}

/* ── Check updates ── */
function CheckUpdatesBlock() {
  const [state, setState] = useState<"idle" | "checking" | "uptodate" | "outdated" | "error">("idle");
  const [info, setInfo] = useState<{ currentVersion: string; latestTag: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const cmd = "curl -fsSL https://raw.githubusercontent.com/Jerry256254/Hertz/main/install.sh | bash";

  async function check() {
    setState("checking");
    try {
      const res = await api.get<{ current: { version: string; sha: string }; latest: { tag: string; url: string } | null }>("/update/version");
      const latestTag = res.latest?.tag ?? "";
      const cur = res.current.version ?? "";
      const normalizedLatest = latestTag.replace(/^v/, "");
      const isOutdated = !!latestTag && normalizedLatest !== cur;
      setInfo({ currentVersion: cur || "—", latestTag: latestTag || "—", url: res.latest?.url ?? "" });
      setState(isOutdated ? "outdated" : "uptodate");
    } catch {
      setState("error");
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      const el = document.createElement("textarea");
      el.value = cmd;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-[12px] border border-border bg-bg-raised p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="mono text-[10px] font-[700] tracking-[0.12em] text-fg-subtle">SYSTÉM</span>
        {info && (
          <span className="mono text-[10px] font-[500] tracking-wide text-fg-subtle">
            {info.currentVersion} {state === "outdated" ? "→ " + info.latestTag : state === "uptodate" ? "• aktuální" : ""}
          </span>
        )}
      </div>

      {state === "idle" && (
        <button
          onClick={check}
          className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-[8px] border border-border bg-bg-sunken text-[12.5px] font-[600] tracking-[-0.01em] text-fg hover:border-border-strong hover:bg-bg-hover"
        >
          <RefreshCw size={13} strokeWidth={1.9} /> Zkontrolovat aktualizace
        </button>
      )}
      {state === "checking" && (
        <div className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-[8px] border border-border bg-bg-sunken text-[12.5px] font-[500] text-fg-muted">
          <RefreshCw size={13} className="animate-spin" /> Kontroluji…
        </div>
      )}
      {state === "uptodate" && (
        <div className="mt-2">
          <div className="flex items-center gap-1.5 rounded-[8px] border border-live/20 bg-live-wash px-2.5 py-2 text-[12.5px] font-[500] text-live">
            <Check size={13} strokeWidth={2} /> Máš nejnovější verzi
          </div>
          <button onClick={() => setState("idle")} className="mt-1.5 w-full text-center mono text-[11px] font-[500] tracking-wide text-fg-subtle hover:text-fg">
            zkontrolovat znovu
          </button>
        </div>
      )}
      {state === "outdated" && info && (
        <div className="mt-2 space-y-2">
          <div className="rounded-[8px] border border-warning/30 bg-warning-wash px-2.5 py-2">
            <p className="text-[12.5px] font-[600] tracking-[-0.01em] text-warning">Je dostupná nová verze</p>
            <p className="mono mt-0.5 text-[11px] leading-none text-fg-muted">{info.currentVersion} → {info.latestTag.replace(/^v/, "")}</p>
            {info.url && (
              <a href={info.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 mono text-[11px] font-[500] tracking-wide text-fg-muted hover:text-fg">
                poznámky k verzi <ExternalLink size={11} />
              </a>
            )}
          </div>
          <div className="rounded-[8px] border border-border bg-bg-sunken p-2">
            <p className="mono mb-1.5 text-[10px] font-[600] tracking-[0.08em] text-fg-subtle">AKTUALIZACE PŘES TERMINÁL</p>
            <div className="flex items-center gap-1.5 rounded-[8px] border border-border bg-bg-raised px-2 py-1.5">
              <span className="mono min-w-0 flex-1 truncate text-[11px] leading-none text-fg">{cmd}</span>
              <button
                onClick={copy}
                className={`flex h-7 shrink-0 items-center gap-1 rounded-[7px] border px-2 mono text-[11px] font-[600] tracking-wide ${copied ? "border-live/20 bg-live-wash text-live" : "border-border bg-bg-sunken text-fg hover:border-border-strong"}`}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Zkopírováno" : "Kopírovat"}
              </button>
            </div>
          </div>
          <button onClick={() => setState("idle")} className="w-full text-center mono text-[11px] font-[500] tracking-wide text-fg-subtle hover:text-fg">
            zavřít
          </button>
        </div>
      )}
      {state === "error" && (
        <div className="mt-2">
          <div className="rounded-[8px] border border-danger/20 bg-danger-wash px-2.5 py-2 text-[12.5px] font-[500] text-danger">Nepodařilo se ověřit verzi</div>
          <button onClick={check} className="mt-1.5 w-full text-center mono text-[11px] font-[500] tracking-wide text-fg-subtle hover:text-fg">
            zkusit znovu
          </button>
        </div>
      )}
    </div>
  );
}

// ── contacts inside project ──
interface ContactAgent {
  id: string;
  name: string;
  role: string;
  mascot: string | null;
  status: string;
  lastStatus: string | null;
}

function ProjectContacts({
  projectId,
  activeSessionId,
  sessions,
}: {
  projectId: string;
  activeSessionId?: string;
  sessions: SidebarSession[];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: agentsData } = useQuery({
    queryKey: ["project-agents", projectId],
    queryFn: () => api.get<{ agents: Array<ContactAgent & { model: string }> }>(`/projects/${projectId}/agents`),
  });
  const ensureChat = useMutation({
    mutationFn: (agentId: string) => api.post<{ id: string }>(`/agents/${agentId}/ensure-chat`, { projectId }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] });
      navigate(`/projects/${projectId}/sessions/${created.id}`);
    },
  });
  const groups = sessions.filter((s) => s.kind === "group");

  return (
    <div className="ml-[14px] mt-1 border-l border-border pl-2.5">
      <ul className="space-y-0.5">
        {(agentsData?.agents ?? []).map((a) => {
          const running = a.status === "running";
          return (
            <li key={a.id}>
              <button
                onClick={() => ensureChat.mutate(a.id)}
                className={`flex w-full items-center gap-2 rounded-[8px] px-2 py-1 text-left hover:bg-bg-raised ${running ? "bg-bg-raised border border-border" : "border border-transparent"}`}
                title={a.lastStatus ?? a.role}
              >
                <Avatar label={a.name} mascot={a.mascot} animate={running} />
                <span className="min-w-0 flex-1 leading-none">
                  <span className="flex items-center gap-1">
                    <span className="truncate text-[12.5px] font-[600] tracking-[-0.01em] text-fg">{a.name}</span>
                    {a.role === "manager" && (
                      <span className="rounded-[4px] bg-fg px-1 py-0.5 mono text-[9px] font-[700] leading-none tracking-[0.08em] text-bg-raised">LEAD</span>
                    )}
                  </span>
                  <span className="mono block truncate text-[11px] leading-none text-fg-subtle mt-0.5">{a.lastStatus ?? a.role}</span>
                </span>
                {running && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-live pulse-live" />}
              </button>
            </li>
          );
        })}
        {(agentsData?.agents ?? []).length === 0 && (
          <li className="px-2 py-1 text-[12px] leading-relaxed text-fg-subtle">Žádní boti — otevři projekt.</li>
        )}
      </ul>
      {groups.length > 0 && (
        <div className="mt-3">
          <div className="px-2 pb-1 mono text-[10px] font-[700] tracking-[0.1em] text-fg-subtle">SKUPINY</div>
          <ul className="space-y-0.5">
            {groups.map((s) => {
              const isActive = activeSessionId === s.id;
              return (
                <li key={s.id}>
                  <Link
                    to={`/projects/${projectId}/sessions/${s.id}`}
                    className={`flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-[12.5px] ${isActive ? "bg-fg text-bg-raised" : "text-fg-muted hover:bg-bg-raised hover:text-fg"}`}
                  >
                    <MessagesSquare size={12} strokeWidth={1.85} className={isActive ? "text-bg-raised/60" : "text-fg-subtle"} />
                    <span className="truncate font-[500]">{s.title}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
