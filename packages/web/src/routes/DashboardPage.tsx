import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Folder, FolderOpen, Plus } from "lucide-react";
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
          <div className="flex items-center gap-2.5 rounded-[12px] border border-border bg-bg-raised px-3 py-2.5">
            <FolderOpen size={15} strokeWidth={1.85} className="shrink-0 text-fg-subtle" />
            <span className="mono min-w-0 flex-1 truncate text-[13px] text-fg">{rootPath}</span>
            <button type="button" onClick={() => setPickerOpen(true)} className="shrink-0 text-[13px] font-[550] text-fg-muted hover:text-fg">
              Change
            </button>
          </div>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setPickerOpen(true)}>
            <FolderOpen size={15} /> Choose directory
          </Button>
        )}
        <DirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} onSelect={setRootPath} initialPath={rootPath || undefined} />
      </div>
      {error && <p className="text-[13px] text-danger">{error}</p>}
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

  const queryClient = useQueryClient();
  const deleteProject = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });

  const projects = data?.projects ?? [];
  const noProviders = providersData && providersData.providers.length === 0;

  if (isLoading) return <div className="container-app py-14"><div className="h-6 w-32 animate-pulse rounded bg-bg-sunken" /></div>;

  return (
    <div className="container-app py-8 md:py-12">
      {/* Header — editorial, not centered, with breathing room */}
      <div className="mb-8 md:mb-10">
        <h1 className="font-serif text-[28px] font-[500] tracking-[-0.03em] text-fg md:text-[32px]">Projects</h1>
        <p className="mt-2 max-w-[52ch] text-[14.5px] leading-relaxed text-fg-muted">
          Each project is a directory on this machine. Your agents live inside it — with their own computer, memory and tools.
        </p>
      </div>

      {noProviders && (
        <button
          onClick={() => navigate("/providers")}
          className="mb-6 flex w-full items-center gap-3 rounded-[14px] border border-border bg-bg-sunken px-4 py-3 text-left hover:border-border-strong hover:bg-bg-raised"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-warning-wash text-warning">!</span>
          <span className="text-[13.5px] font-[550] tracking-[-0.01em] text-fg">Add a model provider to start</span>
          <span className="hidden text-[13px] text-fg-subtle sm:inline">— set one up in Providers</span>
          <ArrowUpRight size={14} className="ml-auto text-fg-subtle" />
        </button>
      )}

      {projects.length === 0 && !showForm ? (
        <Card className="overflow-hidden">
          <EmptyState
            icon={<Folder size={22} strokeWidth={1.7} />}
            title="No projects yet"
            description="Create your first project to give agents a place to work — it points at a real directory on this machine."
            action={
              <Button variant="primary" onClick={() => setShowForm(true)}>
                <Plus size={14} /> New project
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => navigate(`/projects/${p.id}`)}
              className="group flex items-center gap-4 rounded-[16px] border border-border bg-bg-raised p-5 text-left hover:border-border-strong hover:shadow-sm hover:-translate-y-[1px] active:scale-[0.99] text-left"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-bg-sunken text-fg-subtle group-hover:bg-bg-hover group-hover:text-fg">
                <Folder size={18} strokeWidth={1.75} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px] font-[600] tracking-[-0.015em] text-fg">{p.name}</span>
                <span className="mono block truncate text-[12px] text-fg-subtle">{p.roots[0]?.absolutePath ?? "—"}</span>
              </span>
              <span className="hidden items-center gap-2 group-hover:flex" onClick={(e) => e.stopPropagation()}>
                <DeleteButton title="Delete project" onDelete={() => deleteProject.mutate(p.id)} />
              </span>
              <ArrowUpRight size={14} className="shrink-0 text-fg-subtle opacity-0 group-hover:opacity-100" />
            </button>
          ))}
          <button
            onClick={() => setShowForm(true)}
            className="flex min-h-[88px] items-center justify-center gap-2 rounded-[16px] border border-dashed border-border bg-transparent p-5 text-[14px] font-[550] text-fg-subtle hover:border-fg-muted hover:text-fg hover:bg-bg-raised"
          >
            <Plus size={16} /> New project
          </button>
        </div>
      )}

      {showForm && (
        <Card className="mt-6">
          <h2 className="mb-4 font-serif text-[18px] font-[550] tracking-[-0.02em] text-fg">New project</h2>
          <NewProjectForm onCreated={(id) => navigate(`/projects/${id}`)} />
        </Card>
      )}
    </div>
  );
}
