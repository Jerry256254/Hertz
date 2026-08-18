import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Cog,
  FolderGit2,
  Loader2,
  LogOut,
  MessagesSquare,
  Pause,
  Plug,
  Plus,
  Users,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { HertzSession, Project } from "../lib/types";
import { Avatar, IconButton } from "./ui";
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
    const map = new Map<string, SidebarSession[]>();
    for (const session of sessionsData?.sessions ?? []) {
      const list = map.get(session.projectId) ?? [];
      list.push(session);
      map.set(session.projectId, list);
    }
    return map;
  }, [sessionsData]);

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
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-accent text-sm font-bold text-accent-fg shadow-lg">
          H
        </span>
        <span className="text-base font-semibold tracking-tight text-fg">Hertz</span>
        <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">KucLab</span>
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

      <div className="px-3">
        <button
          onClick={() => navigate("/")}
          className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-bg-raised px-3.5 py-2.5 text-sm font-medium text-fg shadow-sm hover:border-border-strong hover:bg-bg-hover transition-all group"
        >
          <Plus size={16} className="text-accent group-hover:scale-110 transition-transform" />
          New chat
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
                  <ul className="ml-4 border-l border-border pl-2">
                    {sessions.map((session) => {
                      const isActive = params.sessionId === session.id;
                      return (
                        <li
                          key={session.id}
                          className={`group/session flex items-center gap-1.5 rounded-lg pr-1.5 text-sm ${
                            isActive ? "bg-accent-wash text-accent" : "text-fg-muted hover:bg-bg-hover hover:text-fg"
                          } transition-colors`}
                        >
                          <Link
                            to={`/projects/${project.id}/sessions/${session.id}`}
                            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5"
                          >
                            {session.kind === "conversation" ? (
                              <span
                                className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                                style={{ backgroundColor: agentColor(session.peerAgentId ?? session.agentId) }}
                                title="Direct agent chat"
                              />
                            ) : session.status === "active" ? (
                              <Loader2 size={12} className="flex-shrink-0 animate-spin text-accent" />
                            ) : session.status === "paused" ? (
                              <Pause size={12} className="flex-shrink-0 text-warning" />
                            ) : (
                              <MessagesSquare size={12} className="flex-shrink-0 text-fg-subtle" />
                            )}
                            <span className="truncate">
                              {session.kind === "conversation" && session.peerAgentName
                                ? session.peerAgentName
                                : session.title}
                            </span>
                          </Link>
                          <span className="hidden flex-shrink-0 group-hover/session:block">
                            <DeleteButton title="Delete chat" onDelete={() => deleteSession.mutate(session.id)} />
                          </span>
                        </li>
                      );
                    })}
                    {sessions.length === 0 && (
                      <li className="px-2 py-1.5 text-xs text-fg-subtle">No chats yet</li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex-shrink-0 border-t border-border p-2">
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
