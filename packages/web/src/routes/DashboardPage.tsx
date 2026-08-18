import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, FolderOpen, Plus, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import type { Project, ProviderConfig } from "../lib/types";
import { Button, Card, EmptyState, Input, Label } from "../components/ui";
import { DirectoryPicker } from "../components/DirectoryPicker";
import { DeleteButton } from "../components/DeleteButton";

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
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <Label>Name</Label>
        <Input placeholder="my-app" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <Label>Root directory</Label>
        {rootPath ? (
          <div className="flex items-center gap-2.5 rounded-lg border border-border bg-bg-raised px-4 py-2">
            <FolderOpen size={16} className="flex-shrink-0 text-accent" />
            <span className="mono min-w-0 flex-1 truncate text-sm text-fg">{rootPath}</span>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex-shrink-0 text-sm text-fg-muted hover:text-accent transition-colors"
            >
              Change
            </button>
          </div>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setPickerOpen(true)} className="justify-start">
            <FolderOpen size={16} /> Choose a directory…
          </Button>
        )}
        <DirectoryPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onSelect={setRootPath}
          initialPath={rootPath || undefined}
        />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="submit" variant="primary" size="md" disabled={createProject.isPending || !rootPath}>
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

  const queryClient = useQueryClient();
  const deleteProject = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });

  const projects = data?.projects ?? [];
  const noProviders = providersData && providersData.providers.length === 0;

  if (isLoading) return null;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-2">
        <h1 className="text-2xl font-semibold text-fg">Projects</h1>
        <p className="mt-1 text-base text-fg-muted">Each project is a directory on this machine an agent can work in.</p>
      </div>

      {noProviders && (
        <button
          onClick={() => navigate("/providers")}
          className="mb-6 flex w-full items-center gap-3 rounded-xl border border-warning bg-warning-wash/20 px-5 py-4 text-left text-base text-warning hover:bg-warning-wash/30 transition-all"
        >
          <TriangleAlert size={18} className="flex-shrink-0" />
          <span className="font-medium">Add a model provider before starting a chat</span>
          <span className="text-warning/70">— click to set one up</span>
        </button>
      )}

      {projects.length === 0 && !showForm ? (
        <Card className="p-8">
          <EmptyState
            icon={<FolderGit2 size={32} strokeWidth={1.5} />}
            title="No projects yet"
            description="Create one to point an agent at a real directory on this machine."
            action={
              <Button variant="primary" size="md" onClick={() => setShowForm(true)}>
                <Plus size={16} /> New project
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {projects.map((p) => (
            <div
              key={p.id}
              onClick={() => navigate(`/projects/${p.id}`)}
              className="group cursor-pointer rounded-xl border border-border bg-bg-raised p-5 text-left transition-all hover:border-border-strong hover:bg-bg-hover hover:shadow-md"
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <FolderGit2 size={18} className="flex-shrink-0 text-accent" />
                  <span className="truncate text-base font-medium text-fg">{p.name}</span>
                </div>
                <span className="hidden group-hover:block">
                  <DeleteButton title="Delete project" onDelete={() => deleteProject.mutate(p.id)} />
                </span>
              </div>
              <p className="mono truncate text-sm text-fg-subtle">{p.roots[0]?.absolutePath ?? "(no root)"}</p>
            </div>
          ))}
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center justify-center gap-2.5 rounded-xl border-2 border-dashed border-border p-5 text-base text-fg-muted hover:border-accent hover:text-accent transition-all group"
          >
            <Plus size={16} className="group-hover:scale-110 transition-transform" /> New project
          </button>
        </div>
      )}

      {showForm && (
        <Card className="mt-6 p-6">
          <h2 className="mb-4 text-lg font-semibold text-fg">New project</h2>
          <NewProjectForm onCreated={(id) => navigate(`/projects/${id}`)} />
        </Card>
      )}
    </div>
  );
}
