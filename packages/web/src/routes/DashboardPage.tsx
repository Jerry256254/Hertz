import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, FolderOpen, Plus } from "lucide-react";
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
        <Label>NÁZEV</Label>
        <Input placeholder="my-app" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <Label>ADRESÁŘ NA STROJI</Label>
        {rootPath ? (
          <div className="flex items-center gap-2.5 rounded-md border border-border bg-bg-sunken px-3 py-2.5">
            <FolderOpen size={14} strokeWidth={1.7} className="shrink-0 text-fg-subtle" />
            <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-fg">{rootPath}</span>
            <button type="button" onClick={() => setPickerOpen(true)} className="shrink-0 mono text-[11px] font-[700] tracking-[0.08em] text-fg-muted hover:text-fg">
              ZMĚNIT
            </button>
          </div>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setPickerOpen(true)}>
            <FolderOpen size={14} /> Vybrat složku
          </Button>
        )}
        <DirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} onSelect={setRootPath} initialPath={rootPath || undefined} />
        <p className="mono mt-1.5 text-[11px] leading-relaxed text-fg-subtle">Ukazuje na reálný adresář na hostiteli. Agenti v něm čtou, píší a spouštějí příkazy.</p>
      </div>
      {error && <p className="rounded-md border border-danger/20 bg-danger-wash px-3 py-2 text-[12.5px] text-danger">{error}</p>}
      <Button type="submit" variant="primary" disabled={createProject.isPending || !rootPath} className="w-full">
        {createProject.isPending ? "Zakládám…" : "Založit projekt"}
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

  if (isLoading) {
    return (
      <div className="container-app py-10">
        <div className="h-6 w-32 animate-pulse rounded-md bg-bg-sunken" />
        <div className="mt-8 space-y-2">
          <div className="h-[64px] animate-pulse rounded-lg bg-bg-sunken" />
          <div className="h-[64px] animate-pulse rounded-lg bg-bg-sunken" />
        </div>
      </div>
    );
  }

  return (
    <div className="container-app py-8 md:py-10">
      {/* Masthead */}
      <div className="flex flex-wrap items-end justify-between gap-6 border-b border-border pb-6">
        <div>
          <p className="mono text-[10px] font-[700] tracking-[0.18em] text-fg-subtle">PŘEHLED</p>
          <h1 className="mt-1 font-display text-[32px] leading-none tracking-[-0.04em] text-fg md:text-[42px]">Projekty</h1>
          <p className="mono mt-2 max-w-[52ch] text-[12.5px] leading-[1.6] text-fg-muted">
            Každý projekt je složka na tomto stroji. Agenti v ní žijí — se svým počítačem, pamětí a nástroji.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden items-baseline gap-2 border-r border-border pr-4 sm:flex">
            <span className="text-[28px] font-[700] leading-none tracking-[-0.03em] text-fg">{String(projects.length).padStart(2, "0")}</span>
            <span className="mono text-[10px] font-[700] tracking-[0.12em] text-fg-subtle">PROJEKTŮ</span>
          </div>
          <Button variant="primary" onClick={() => setShowForm((v) => !v)}>
            <Plus size={14} /> {showForm ? "Zavřít" : "Nový projekt"}
          </Button>
        </div>
      </div>

      {noProviders && (
        <button
          onClick={() => navigate("/providers")}
          className="mt-5 flex w-full items-center gap-3 rounded-md border border-warning/20 bg-warning-wash px-4 py-3 text-left hover:border-warning/30"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-warning text-white mono text-[12px] font-[700]">!</span>
          <span className="text-[13px] font-[600] tracking-[-0.01em] text-fg">Přidej poskytovatele modelu ať můžeš začít</span>
          <span className="hidden mono text-[12px] text-fg-subtle sm:inline">— nastavíš v Provideři</span>
          <ArrowUpRight size={14} className="ml-auto shrink-0 text-fg-subtle" />
        </button>
      )}

      {projects.length === 0 && !showForm ? (
        <Card className="mt-6 overflow-hidden border-dashed">
          <EmptyState
            icon={<span className="mono text-[11px] font-[700] tracking-[0.12em]">∅</span>}
            title="Zatím žádné projekty"
            description="Založ první projekt — ukáže na reálný adresář, kde budou agenti pracovat."
            action={
              <Button variant="primary" onClick={() => setShowForm(true)}>
                <Plus size={14} /> Založit projekt
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-bg-raised">
          {/* ledger head */}
          <div className="hidden grid-cols-[48px_1fr_280px_40px] border-b border-border bg-bg-sunken px-2 py-2 mono text-[10px] font-[700] tracking-[0.1em] text-fg-subtle md:grid">
            <span className="px-2">#</span>
            <span>PROJEKT</span>
            <span>ADRESÁŘ</span>
            <span />
          </div>

          {projects.map((p, idx) => (
            <div
              key={p.id}
              className="group grid grid-cols-1 gap-1 border-b border-border px-3 py-3 last:border-0 hover:bg-bg-sunken/60 md:grid-cols-[48px_1fr_280px_40px] md:items-center md:px-2 md:py-0"
            >
              <span className="hidden mono px-2 text-[11px] font-[500] tracking-wide text-fg-faint md:block">
                {String(idx + 1).padStart(2, "0")}
              </span>
              <button onClick={() => navigate(`/projects/${p.id}`)} className="flex min-w-0 items-center gap-3 text-left md:h-[56px]">
                <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-bg-raised mono text-[11px] font-[700] tracking-wide text-fg-subtle group-hover:border-fg group-hover:bg-fg group-hover:text-bg-raised md:flex">
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-[650] tracking-[-0.015em] text-fg group-hover:underline decoration-border-strong underline-offset-4">{p.name}</span>
                  <span className="mono block truncate text-[11px] text-fg-subtle md:hidden">{p.roots[0]?.absolutePath ?? "—"}</span>
                </span>
              </button>
              <span className="mono hidden truncate px-2 text-[11.5px] leading-none text-fg-muted md:block" title={p.roots[0]?.absolutePath}>
                {p.roots[0]?.absolutePath ?? "—"}
              </span>
              <span className="flex items-center justify-end gap-1 md:justify-center">
                <span className="hidden group-hover:flex" onClick={(e) => e.stopPropagation()}>
                  <DeleteButton title="Smazat projekt" onDelete={() => deleteProject.mutate(p.id)} />
                </span>
                <button
                  onClick={() => navigate(`/projects/${p.id}`)}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-fg-subtle group-hover:border-border group-hover:bg-bg-raised group-hover:text-fg"
                >
                  <ArrowUpRight size={13} strokeWidth={1.9} />
                </button>
              </span>
            </div>
          ))}

          <button
            onClick={() => setShowForm(true)}
            className="flex h-[52px] w-full items-center justify-center gap-2 border-t border-dashed border-border bg-transparent mono text-[12px] font-[600] tracking-[0.06em] text-fg-subtle hover:bg-bg-sunken hover:text-fg"
          >
            <Plus size={13} /> NOVÝ PROJEKT
          </button>
        </div>
      )}

      {showForm && (
        <Card className="mt-4">
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="font-display text-[22px] leading-none tracking-[-0.03em] text-fg">Nový projekt</h2>
            <span className="mono text-[10px] font-[600] tracking-[0.1em] text-fg-subtle">KROK 1 — ADRESÁŘ</span>
          </div>
          <NewProjectForm onCreated={(id) => navigate(`/projects/${id}`)} />
        </Card>
      )}
    </div>
  );
}
