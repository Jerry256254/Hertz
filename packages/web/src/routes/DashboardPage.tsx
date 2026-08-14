import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, FolderOpen, Plus, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import type { Project, ProviderConfig } from "../lib/types";
import { Button, Card, EmptyState, Input, Label } from "../components/ui";
import { DirectoryPicker } from "../components/DirectoryPicker";

function NewProjectForm({ onCreated }: { onCreated: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const createProject = useMutation({
    mutationFn: () => api.post<{ id: string }>("/projects", { name, rootPath }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onCreated(res.id);
    },
    onError: (err) => setError((err as Error).message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    createProject.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <Label>Name</Label>
        <Input placeholder="my-app" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <Label>Root directory</Label>
        {rootPath ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-bg-raised px-3 py-1.5">
            <FolderOpen size={14} className="flex-shrink-0 text-accent" />
            <span className="mono min-w-0 flex-1 truncate text-sm text-fg">{rootPath}</span>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex-shrink-0 text-xs text-fg-muted hover:text-fg"
            >
              Change
            </button>
          </div>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setPickerOpen(true)}>
            <FolderOpen size={14} /> Choose a directory…
          </Button>
        )}
        <DirectoryPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onSelect={setRootPath}
          initialPath={rootPath || undefined}
        />
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <Button type="submit" variant="primary" disabled={createProject.isPending || !rootPath}>
        {createProject.isPending ? "Creating…" : "Create project"}
      </Button>
    </form>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/projects"),
  });

  const { data: providersData } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers"),
  });

  const projects = data?.projects ?? [];
  const noProviders = providersData && providersData.providers.length === 0;

  if (isLoading) return null;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="mb-1 text-xl font-semibold text-fg">Projects</h1>
      <p className="mb-6 text-sm text-fg-muted">Each project is a directory on this machine an agent can work in.</p>

      {noProviders && (
        <button
          onClick={() => navigate("/providers")}
          className="mb-6 flex w-full items-center gap-2.5 rounded-lg border border-border bg-warning-wash px-4 py-3 text-left text-sm text-warning transition-opacity hover:opacity-90"
        >
          <TriangleAlert size={16} className="flex-shrink-0" />
          Add a model provider before starting a chat — click to set one up.
        </button>
      )}

      {projects.length === 0 && !showForm ? (
        <Card>
          <EmptyState
            icon={<FolderGit2 size={28} strokeWidth={1.5} />}
            title="No projects yet"
            description="Create one to point an agent at a real directory on this machine."
            action={
              <Button variant="primary" onClick={() => setShowForm(true)}>
                <Plus size={14} /> New project
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => navigate(`/projects/${p.id}`)}
              className="rounded-lg border border-border bg-bg-raised p-4 text-left transition-colors hover:border-border-strong hover:bg-bg-hover"
            >
              <div className="mb-1.5 flex items-center gap-2">
                <FolderGit2 size={15} className="text-accent" />
                <span className="text-sm font-medium text-fg">{p.name}</span>
              </div>
              <p className="mono truncate text-xs text-fg-subtle">{p.roots[0]?.absolutePath ?? "(no root)"}</p>
            </button>
          ))}
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border p-4 text-sm text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
          >
            <Plus size={14} /> New project
          </button>
        </div>
      )}

      {showForm && projects.length > 0 && (
        <Card className="mt-4 p-4">
          <h2 className="mb-3 text-sm font-semibold text-fg">New project</h2>
          <NewProjectForm onCreated={(id) => navigate(`/projects/${id}`)} />
        </Card>
      )}
      {showForm && projects.length === 0 && (
        <Card className="mt-4 p-4">
          <NewProjectForm onCreated={(id) => navigate(`/projects/${id}`)} />
        </Card>
      )}
    </div>
  );
}
