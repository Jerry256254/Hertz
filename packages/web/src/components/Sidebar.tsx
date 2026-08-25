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
  const queryClient = useQueryClient();
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
    for (const session of sessionsData?.sessions ?? []) {
      if (q && !`${session.title} ${session.agentName ?? ""} ${session.peerAgentName ?? ""}`.toLowerCase().includes(q)) continue;
      const list = map.get(session.projectId) ?? [];
      list.push(session);
      map.set(session.projectId, list);
    }
    return map;
  }, [sessionsData, query]);

  function toggle(projectId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  const projects = projectsData?.projects ?? [];

  return (
    <aside className="flex h-full w-full flex-col bg-bg-sidebar">
      {/* Header — wordmark, not centered, with subtle baseline */}
      <div className="flex h-[56px] shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-fg text-bg text-[13px] font-[700] tracking-[-0.02em]">H</div>
        <div className="min-w-0 leading-none">
          <div className="text-[14px] font-[650] tracking-[-0.02em] text-fg">Hertz</div>
          <div className="text-[11px] font-medium text-fg-subtle -mt-0.5">workspace</div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-[10px] text-fg-subtle hover:bg-bg-hover hover:text-fg md:hidden"
            aria-label="Close menu"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Search + new */}
      <div className="p-3">
        <label className="flex h-9 items-center gap-2.5 rounded-[12px] border border-border bg-bg-raised px-3 focus-within:border-border-strong focus-within:bg-bg-raised">
          <Search size={14} className="shrink-0 text-fg-subtle" strokeWidth={1.9} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-full bg-transparent text-[13.5px] text-fg placeholder:text-fg-subtle outline-none"
          />
        </label>
        <button
          onClick={() => navigate("/")}
          className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-[12px] border border-border bg-bg-raised text-[13.5px] font-[550] tracking-[-0.01em] text-fg hover:border-border-strong hover:bg-bg-hover active:scale-[0.99]"
        >
          <Plus size={14} strokeWidth={2} /> New project
        </button>
      </div>

      {/* Projects — generous whitespace, not cramped */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <div className="mb-2 mt-1 px-1 text-[11.5px] font-[600] tracking-[-0.01em] text-fg-subtle">Projects</div>
        {projects.length === 0 && (
          <p className="px-1 py-2 text-[13px] leading-relaxed text-fg-subtle">No projects yet — create one from the dashboard.</p>
        )}
        <ul className="space-y-1">
          {projects.map((project) => {
            const sessions = (sessionsByProject.get(project.id) ?? []).slice(0, 8);
            const isCollapsed = collapsed.has(project.id);
            const isActiveProject = params.projectId === project.id;
            return (
              <li key={project.id}>
                <div
                  className={`group flex items-center gap-1 rounded-[10px] px-1 py-1 ${isActiveProject ? "bg-bg-raised" : "hover:bg-bg-raised"}`}
                >
                  <button
                    onClick={() => toggle(project.id)}
                    className="flex h-6 w-6 items-center justify-center rounded-[7px] text-fg-subtle hover:bg-bg-hover hover:text-fg"
                    aria-label={isCollapsed ? "Expand" : "Collapse"}
                  >
                    <ChevronRight size={13} strokeWidth={1.9} className={`transition-transform duration-150 ${isCollapsed ? "" : "rotate-90"}`} />
                  </button>
                  <Link
                    to={`/projects/${project.id}`}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] px-1 py-1 text-[13.5px] font-[500] tracking-[-0.01em] text-fg hover:text-fg"
                  >
                    <Folder size={14} strokeWidth={1.85} className="shrink-0 text-fg-subtle group-hover:text-fg-muted" />
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

      {/* Bottom — system */}
      <div className="shrink-0 border-t border-border p-2">
        <div className="space-y-0.5">
          <Link to="/approvals" className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13px] font-[500] text-fg-muted hover:bg-bg-raised hover:text-fg">
            <ShieldCheck size={14} strokeWidth={1.85} /> Approvals
          </Link>
          <CopyInstallButton />
          <Link to="/integrations" className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13px] font-[500] text-fg-muted hover:bg-bg-raised hover:text-fg">
            <Plug size={14} strokeWidth={1.85} /> Integrations
          </Link>
          <Link to="/providers" className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13px] font-[500] text-fg-muted hover:bg-bg-raised hover:text-fg">
            <Settings2 size={14} strokeWidth={1.85} /> Providers
          </Link>
          {user?.role === "admin" && (
            <Link to="/users" className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13px] font-[500] text-fg-muted hover:bg-bg-raised hover:text-fg">
              <Users size={14} strokeWidth={1.85} /> Users
            </Link>
          )}
        </div>

        <div className="mt-2 flex items-center gap-2 rounded-[12px] border border-border bg-bg-raised px-2 py-2">
          <Link to="/account" className="flex min-w-0 flex-1 items-center gap-2.5">
            <Avatar label={user?.email ?? "?"} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-[500] tracking-[-0.01em] text-fg-muted">{user?.email}</span>
          </Link>
          <IconButton title="Log out" onClick={() => void logout()} className="h-7 w-7 rounded-[9px]">
            <LogOut size={13} strokeWidth={1.85} />
          </IconButton>
        </div>
      </div>
    </aside>
  );
}

function CopyInstallButton() {
  const [copied, setCopied] = useState(false);
  const cmd = "curl -fsSL https://raw.githubusercontent.com/Jerry256254/Hertz/main/install.sh | bash";
  async function copy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const el = document.createElement("textarea");
      el.value = cmd;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }
  return (
    <button
      onClick={copy}
      className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[13px] font-[500] text-fg-muted hover:bg-bg-raised hover:text-fg"
      title={cmd}
    >
      {copied ? <Check size={14} strokeWidth={1.85} className="text-success" /> : <Copy size={14} strokeWidth={1.85} />}
      {copied ? "Copied" : "Copy install command"}
    </button>
  );
}

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
    <div className="ml-[18px] mt-1 border-l border-border pl-3">
      <ul className="space-y-0.5">
        {(agentsData?.agents ?? []).map((a) => {
          const running = a.status === "running";
          return (
            <li key={a.id}>
              <button
                onClick={() => ensureChat.mutate(a.id)}
                className={`flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left hover:bg-bg-raised ${running ? "bg-bg-raised" : ""}`}
                title={a.lastStatus ?? a.role}
              >
                <Avatar label={a.name} mascot={a.mascot} animate={running} />
                <span className="min-w-0 flex-1 leading-none">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-[550] tracking-[-0.01em] text-fg">{a.name}</span>
                    {a.role === "manager" && (
                      <span className="rounded-[6px] border border-border bg-bg-sunken px-1 py-0.5 text-[10px] font-[600] leading-none tracking-wide text-fg-subtle">lead</span>
                    )}
                  </span>
                  <span className="block truncate text-[11.5px] leading-none text-fg-subtle mt-1">{a.lastStatus ?? a.role}</span>
                </span>
                {running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-fg" />}
              </button>
            </li>
          );
        })}
        {(agentsData?.agents ?? []).length === 0 && (
          <li className="px-2 py-1 text-[12.5px] text-fg-subtle">No bots yet — open the project.</li>
        )}
      </ul>

      {groups.length > 0 && (
        <div className="mt-3">
          <div className="px-2 pb-1 text-[11px] font-[600] tracking-[0.02em] text-fg-subtle">Groups</div>
          <ul className="space-y-0.5">
            {groups.map((session) => {
              const isActive = activeSessionId === session.id;
              return (
                <li key={session.id}>
                  <Link
                    to={`/projects/${projectId}/sessions/${session.id}`}
                    className={`flex items-center gap-2 rounded-[10px] px-2 py-1.5 text-[13px] ${isActive ? "bg-fg text-bg" : "text-fg-muted hover:bg-bg-raised hover:text-fg"}`}
                  >
                    <MessagesSquare size={13} strokeWidth={1.85} className={isActive ? "text-bg/70" : "text-fg-subtle"} />
                    <span className="truncate font-[500]">{session.title}</span>
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
