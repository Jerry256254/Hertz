import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Search,
  Cog,
  FolderGit2,
  Loader2,
  LogOut,
  MessagesSquare,
  Pause,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { HertzSession, Project } from "../lib/types";
import { Avatar, Button, IconButton } from "./ui";
import { agentColor } from "../lib/agent-color";
import { DeleteButton } from "./DeleteButton";

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

  const deleteSession = useMutation({
    mutationFn: (sessionId: string) => api.delete(`/sessions/${sessionId}`),
    onSuccess: (_data, sessionId) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] });
      if (params.sessionId === sessionId) navigate(`/projects/${params.projectId}`);
    },
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
    <aside className="flex h-full w-64 flex-shrink-0 flex-col border-r border-border bg-bg-sidebar">
      <div className="flex h-14 flex-shrink-0 items-center gap-3 px-4">
        <span className="text-base font-semibold tracking-tight text-fg">Hertz Jobs</span>
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-bg-hover hover:text-accent md:hidden transition-all"
            aria-label="Close menu"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className="space-y-2 px-3">
        <div className="flex h-9 items-center gap-2 rounded-xl border border-border bg-bg-raised px-3 focus-within:border-border-strong">
          <Search size={14} className="flex-shrink-0 text-fg-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="w-full border-0 bg-transparent text-sm text-fg placeholder:text-fg-subtle outline-none"
          />
        </div>
        <button
          onClick={() => navigate("/")}
          className="flex w-full items-center gap-2.5 rounded-xl bg-bg-raised px-3.5 py-2.5 text-sm font-medium text-fg shadow-sm transition-all hover:bg-bg-hover group"
        >
          <Plus size={16} className="text-accent group-hover:scale-110 transition-transform" />
          Create new
        </button>
      </div>

      <nav className="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <p className="px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Projects</p>
        {projects.length === 0 && (
          <p className="px-2 py-2 text-xs text-fg-subtle">No projects yet — create one from the dashboard.</p>
        )}
        <ul>
          {projects.map((project) => {
            const sessions = (sessionsByProject.get(project.id) ?? []).slice(0, 8);
            const isCollapsed = collapsed.has(project.id);
            const isActiveProject = params.projectId === project.id;
            return (
              <li key={project.id} className="mb-0.5">
                <div
                  className={`group flex items-center gap-1.5 rounded-lg px-2 py-1.5 ${
                    isActiveProject && !params.sessionId ? "bg-bg-hover" : "hover:bg-bg-hover"
                  } transition-colors`}
                >
                  <button onClick={() => toggle(project.id)} className="text-fg-subtle hover:text-fg transition-colors">
                    <ChevronRight
                      size={14}
                      className={`transition-transform duration-200 ${isCollapsed ? "" : "rotate-90"}`}
                    />
                  </button>
                  <Link
                    to={`/projects/${project.id}`}
                    className="flex min-w-0 flex-1 items-center gap-2 text-sm text-fg hover:text-accent transition-colors"
                  >
                    <FolderGit2 size={15} className="flex-shrink-0 text-fg-subtle" />
                    <span className="truncate font-medium">{project.name}</span>
                  </Link>
                </div>
                                {!isCollapsed && (
                  <ProjectContacts
                    projectId={project.id}
                    activeSessionId={params.sessionId}
                    sessions={sessions}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex-shrink-0 border-t border-border p-2">
        <Link
          to="/approvals"
          className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-accent transition-colors"
        >
          <ShieldCheck size={15} />
          Approvals
        </Link>
        {user?.role === "admin" && <UpdateButton />}
        <Link
          to="/integrations"
          className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-accent transition-colors"
        >
          <Plug size={15} />
          Integrations
        </Link>
        <Link
          to="/providers"
          className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-accent transition-colors"
        >
          <Cog size={15} />
          Providers
        </Link>
        {user?.role === "admin" && (
          <Link
            to="/users"
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-accent transition-colors"
          >
            <Users size={15} />
            Users
          </Link>
        )}
        <div className="mt-2 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 bg-bg-raised">
          <Link to="/account" className="flex min-w-0 flex-1 items-center gap-2 hover:opacity-80">
            <Avatar label={user?.email ?? "?"} />
            <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{user?.email}</span>
          </Link>
          <IconButton title="Log out" onClick={() => void logout()}>
            <LogOut size={14} />
          </IconButton>
        </div>
      </div>
    </aside>
  );
}

function UpdateButton() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: versions } = useQuery({
    queryKey: ["update-version"],
    queryFn: () => api.get<{ current: { version: string; sha: string }; latest: { tag: string; url: string } | null }>("/update/version"),
    enabled: true,
  });
  const updateAvailable = (() => {
    if (!versions?.latest?.tag) return false;
    const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
    const cur = parse(versions.current.version);
    const lat = parse(versions.latest.tag);
    const cMaj = cur[0] ?? 0, cMin = cur[1] ?? 0, cPat = cur[2] ?? 0;
    const lMaj = lat[0] ?? 0, lMin = lat[1] ?? 0, lPat = lat[2] ?? 0;
    if (lMaj !== cMaj) return lMaj > cMaj;
    if (lMin !== cMin) return lMin > cMin;
    return lPat > cPat;
  })();
  const { data } = useQuery({
    queryKey: ["update-status"],
    queryFn: () => api.get<{ running: boolean; log: string }>("/update/status"),
    enabled: true,
    refetchInterval: open ? 2000 : false,
  });

  // When the update finishes (health poll line appears), reload into the new version.
  const finished = data?.log.includes("UPDATE OK") ?? false;
  useEffect(() => {
    if (finished) {
      const t = setTimeout(() => window.location.reload(), 2500);
      return () => clearTimeout(t);
    }
  }, [finished]);

  const startUpdate = useMutation({
    mutationFn: () => api.post("/update"),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["update-status"] }),
  });

  return (
    <>
      <button
        onClick={() => {
          if (!startUpdate.isPending && !data?.running && !finished) startUpdate.mutate();
          setOpen(true);
        }}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors disabled:opacity-50 ${
          updateAvailable
            ? "bg-accent-wash text-accent font-medium hover:bg-accent hover:text-accent-fg"
            : "text-fg-muted hover:bg-bg-hover hover:text-accent"
        }`}
      >
        <RefreshCw size={15} className={data?.running ? "animate-spin" : ""} />
        Update Hertz
        {updateAvailable && (
          <span className="ml-auto rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-accent-fg">
            NEW
          </span>
        )}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !data?.running && setOpen(false)}>
          <div className="w-full max-w-lg rounded-xl border border-border bg-bg-raised p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <RefreshCw size={15} className={data?.running ? "animate-spin text-accent" : "text-accent"} />
              <span className="text-sm font-medium text-fg">
                {data?.running ? "Updating Hertz…" : finished ? "Updated — reloading…" : "Update Hertz"}
              </span>
            </div>
            {updateAvailable && (
              <div className="mb-3 rounded-md bg-accent-wash px-3 py-2 text-xs font-medium text-accent">
                Update available — click the button below, watch the log, the page reconnects when done.
              </div>
            )}
            {versions && (
              <div className="mb-3 rounded-md bg-bg-sunken px-3 py-2 text-xs text-fg-muted">
                Installed: <span className="mono text-fg">v{versions.current.version}</span> ({versions.current.sha || "?"})
                {versions.latest && (
                  <>
                    {" · "}Latest release:{" "}
                    <a href={versions.latest.url} target="_blank" rel="noreferrer" className="text-accent underline">
                      {versions.latest.tag}
                    </a>
                    {updateAvailable && <span className="ml-1 font-medium text-warning">— update available</span>}
                  </>
                )}
              </div>
            )}
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-bg-sunken p-3 text-[11px] text-fg-muted">
              {data?.log || "Starting…"}
            </pre>
            <div className="mt-3 flex items-center justify-between">
              {!data?.running && !finished && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => startUpdate.mutate()}
                  disabled={startUpdate.isPending}
                >
                  <RefreshCw size={13} /> Update now
                </Button>
              )}
              <span className="flex-1" />
              <button
                className="rounded-md px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
                onClick={() => setOpen(false)}
              >
                {data?.running ? "Hide" : "Close"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
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

/**
 * Contacts model: under each project the sidebar lists its AGENTS (contacts),
 * not raw chats. Clicking a contact opens that agent's ONE permanent thread
 * (created on first touch). Group chats are listed below the contacts.
 */
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
    <div className="ml-4 border-l border-border pl-2">
      <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Contacts</p>
      <ul>
        {(agentsData?.agents ?? []).map((a) => {
          const running = a.status === "running";
          return (
            <li key={a.id}>
              <button
                onClick={() => ensureChat.mutate(a.id)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                  running ? "bg-bg-hover" : "hover:bg-bg-hover"
                }`}
                title={a.lastStatus ?? a.role}
              >
                <Avatar label={a.name} mascot={a.mascot} animate={running} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm text-fg">{a.name}</span>
                    {a.role === "manager" && (
                      <span className="flex-shrink-0 rounded bg-bg-sunken px-1 text-[9px] font-semibold uppercase text-fg-subtle">
                        lead
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-fg-subtle">{a.lastStatus ?? a.role}</span>
                </span>
                {running && <span className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-accent" />}
              </button>
            </li>
          );
        })}
        {(agentsData?.agents ?? []).length === 0 && (
          <li className="px-2 py-1.5 text-xs text-fg-subtle">No bots yet — open the project to hire.</li>
        )}
      </ul>

      {groups.length > 0 && (
        <>
          <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Groups</p>
          <ul>
            {groups.map((session) => {
              const isActive = activeSessionId === session.id;
              return (
                <li key={session.id}>
                  <Link
                    to={`/projects/${projectId}/sessions/${session.id}`}
                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors ${
                      isActive ? "bg-accent-wash text-accent" : "text-fg-muted hover:bg-bg-hover hover:text-fg"
                    }`}
                  >
                    <MessagesSquare size={13} className="flex-shrink-0 text-fg-subtle" />
                    <span className="truncate">{session.title}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
