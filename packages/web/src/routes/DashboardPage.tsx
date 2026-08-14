import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Project } from "../lib/types";

export function DashboardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const { data, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/projects"),
  });

  const createProject = useMutation({
    mutationFn: () => api.post<{ id: string }>("/projects", { name, rootPath }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setName("");
      setRootPath("");
      navigate(`/projects/${res.id}`);
    },
    onError: (err) => setError((err as Error).message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    createProject.mutate();
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-sm font-semibold text-fg-muted">Projects</h1>

      {isLoading ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : (
        <ul className="mb-6 divide-y divide-border rounded border border-border">
          {data?.projects.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => navigate(`/projects/${p.id}`)}
                className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-bg-raised"
              >
                <span className="text-sm">{p.name}</span>
                <span className="font-mono text-xs text-fg-muted">
                  {p.roots[0]?.absolutePath ?? "(no root)"}
                </span>
              </button>
            </li>
          ))}
          {data?.projects.length === 0 && (
            <li className="px-3 py-2 text-sm text-fg-muted">No projects yet.</li>
          )}
        </ul>
      )}

      <form onSubmit={onSubmit} className="rounded border border-border bg-bg-raised p-4">
        <h2 className="mb-3 text-xs font-semibold text-fg-muted">New project</h2>
        <div className="mb-2 flex gap-2">
          <input
            placeholder="Name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
          <input
            placeholder="Root directory (absolute path on the server)"
            required
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            className="flex-[2] rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm outline-none focus:border-accent"
          />
        </div>
        {error && <p className="mb-2 text-xs text-danger">{error}</p>}
        <button
          type="submit"
          disabled={createProject.isPending}
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {createProject.isPending ? "Creating…" : "Create project"}
        </button>
      </form>
    </div>
  );
}
