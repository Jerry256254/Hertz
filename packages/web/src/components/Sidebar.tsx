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
  Plug,
  Plus,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { HertzSession, Project } from "../lib/types";
import { Avatar, IconButton } from "./ui";
import { DeleteButton } from "./DeleteButton";

interface SidebarSession extends HertzSession {
  agentName: string;
  projectName: string;
}

export function Sidebar() {
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
      <div className="flex h-14 flex-shrink-0 items-center gap-2 px-4">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-xs font-bold text-accent-fg">
          H
        </span>
        <span className="text-sm font-semibold tracking-tight text-fg">Hertz</span>
        <span className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">KucLab</span>
      </div>

      <div className="px-3">
        <button
          onClick={() => navigate("/")}
          className="flex w-full items-center gap-2 rounded-md border border-border bg-bg-raised px-3 py-2 text-sm font-medium text-fg shadow-sm transition-colors hover:bg-bg-hover"
        >
          <Plus size={15} className="text-accent" />
          New chat
        </button>
      </div>

      <nav className="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">Projects</p>
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
                  className={`group flex items-center gap-1 rounded-md px-2 py-1.5 ${
                    isActiveProject && !params.sessionId ? "bg-bg-hover" : "hover:bg-bg-hover"
                  }`}
                >
                  <button onClick={() => toggle(project.id)} className="text-fg-subtle">
                    <ChevronRight
                      size={13}
                      className={`transition-transform duration-150 ${isCollapsed ? "" : "rotate-90"}`}
                    />
                  </button>
                  <Link
                    to={`/projects/${project.id}`}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-fg"
                  >
                    <FolderGit2 size={14} className="flex-shrink-0 text-fg-subtle" />
                    <span className="truncate">{project.name}</span>
                  </Link>
                </div>
                {!isCollapsed && (
                  <ul className="ml-4 border-l border-border pl-2">
                    {sessions.map((session) => {
                      const isActive = params.sessionId === session.id;
                      return (
                        <li
                          key={session.id}
                          className={`group/session flex items-center gap-1 rounded-md pr-1.5 text-[13px] ${
                            isActive ? "bg-accent-wash text-accent" : "text-fg-muted hover:bg-bg-hover hover:text-fg"
                          }`}
                        >
                          <Link
                            to={`/projects/${project.id}/sessions/${session.id}`}
                            className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5"
                          >
                            {session.status === "active" ? (
                              <Loader2 size={12} className="flex-shrink-0 animate-spin text-accent" />
                            ) : (
                              <MessagesSquare size={12} className="flex-shrink-0" />
                            )}
                            <span className="truncate">{session.title}</span>
                          </Link>
                          <span className="hidden flex-shrink-0 group-hover/session:block">
                            <DeleteButton title="Delete chat" onDelete={() => deleteSession.mutate(session.id)} />
                          </span>
                        </li>
                      );
                    })}
                    {sessions.length === 0 && (
                      <li className="px-2 py-1 text-[12px] text-fg-subtle">No chats yet</li>
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
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <Plug size={14} />
          Integrations
        </Link>
        <Link
          to="/providers"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <Cog size={14} />
          Providers
        </Link>
        <div className="mt-1 flex items-center gap-2 rounded-md px-2 py-1.5">
          <Avatar label={user?.email ?? "?"} />
          <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{user?.email}</span>
          <IconButton title="Log out" onClick={() => void logout()}>
            <LogOut size={14} />
          </IconButton>
        </div>
      </div>
    </aside>
  );
}
