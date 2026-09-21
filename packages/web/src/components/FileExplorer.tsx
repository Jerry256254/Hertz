import { lazy, Suspense, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronUp, File, Folder, FolderPlus } from "lucide-react";
import { api } from "../lib/api";
import type { FileEntry } from "../lib/types";

const CodeViewer = lazy(() => import("./CodeViewer").then((m) => ({ default: m.CodeViewer })));

export function FileExplorer({
  projectId,
  root = "main",
  agentId,
}: {
  projectId: string;
  root?: "main" | "self";
  agentId?: string;
}) {
  const [currentPath, setCurrentPath] = useState(".");
  const [previewPath, setPreviewPath] = useState<string | undefined>(undefined);
  const scopeParam = `&root=${root}${agentId ? `&agentId=${agentId}` : ""}`;
  const queryClient = useQueryClient();

  const createFolder = useMutation({
    mutationFn: (name: string) => api.post(`/projects/${projectId}/files/dir`, { path: currentPath === "." ? name : `${currentPath}/${name}`, root, agentId }),
    onSuccess: (_data, name) => {
      queryClient.invalidateQueries({ queryKey: ["files", projectId, root, agentId] });
      setPreviewPath(undefined);
      setCurrentPath(currentPath === "." ? name : `${currentPath}/${name}`);
    },
  });

  function promptNewFolder() {
    const name = window.prompt("Název nové složky")?.trim();
    if (!name || name === "." || name === ".." || name.includes("/")) return;
    createFolder.mutate(name);
  }

  useEffect(() => { setCurrentPath("."); setPreviewPath(undefined); }, [root, agentId]);

  const { data: listing, isFetching } = useQuery({
    queryKey: ["files", projectId, root, agentId, currentPath],
    queryFn: () => api.get<{ entries: FileEntry[] }>(`/projects/${projectId}/files?path=${encodeURIComponent(currentPath)}${scopeParam}`),
    refetchInterval: 4000,
  });
  const { data: preview, isLoading: previewLoading, isError: previewError } = useQuery({
    queryKey: ["file-content", projectId, root, agentId, previewPath],
    queryFn: () => api.get<{ content: string; truncated: boolean }>(`/projects/${projectId}/file-content?path=${encodeURIComponent(previewPath!)}${scopeParam}`),
    enabled: !!previewPath,
  });

  function goUp() {
    if (currentPath === ".") return;
    const parts = currentPath.split("/"); parts.pop();
    setCurrentPath(parts.length ? parts.join("/") : ".");
    setPreviewPath(undefined);
  }
  function open(entry: FileEntry) {
    const nextPath = currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
    if (entry.type === "directory") { setCurrentPath(nextPath); setPreviewPath(undefined); } else setPreviewPath(nextPath);
  }

  return (
    <div className="flex h-full flex-col bg-bg-raised">
      <div className="flex min-h-[48px] shrink-0 items-center gap-2 border-b border-border px-2">
        <button onClick={goUp} disabled={currentPath === "."} aria-label="O úroveň výš" className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-bg-sunken text-fg-muted hover:text-fg disabled:opacity-30"><ChevronUp size={14} /></button>
        <span className="mono truncate text-[11px] font-[500] tracking-wide text-fg-muted">{currentPath === "." ? "/" : currentPath}</span>
        <button onClick={promptNewFolder} disabled={createFolder.isPending} title="Nová složka" aria-label="Nová složka" className="ml-auto flex h-10 w-10 items-center justify-center rounded-md border border-border bg-bg-sunken text-fg-muted hover:text-fg disabled:opacity-30"><FolderPlus size={14} /></button>
        {isFetching && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-live pulse-live" />}
      </div>
      {createFolder.isError && <p className="shrink-0 border-b border-danger/20 bg-danger-wash px-2 py-1.5 mono text-[11px] text-danger">{(createFolder.error as Error).message}</p>}
      <div className="min-h-0 flex-1 overflow-auto">
        {previewPath ? (
          <div className="flex h-full flex-col">
            <button onClick={() => setPreviewPath(undefined)} className="flex min-h-[44px] shrink-0 items-center gap-1 border-b border-border px-3 mono text-[11px] font-[600] tracking-wide text-fg-muted hover:text-fg"><ArrowLeft size={12} /> zpět</button>
            <div className="min-h-0 flex-1 overflow-auto">
              {previewLoading && <p className="p-3 mono text-[11px] text-fg-subtle">Načítám náhled…</p>}
              {previewError && <p className="p-3 mono text-[11px] text-danger">Náhled se nepodařilo načíst.</p>}
              {preview && <Suspense fallback={<p className="p-3 mono text-[11px] text-fg-subtle">Načítám…</p>}><CodeViewer path={previewPath} content={preview.content} /></Suspense>}
            </div>
            {preview?.truncated && <p className="shrink-0 border-t border-warning/20 bg-warning-wash px-2 py-1.5 mono text-[11px] text-warning">Náhled zkrácen.</p>}
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {listing?.entries.map((entry) => (
              <li key={entry.name}>
                <button onClick={() => open(entry)} className="flex min-h-[44px] w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-sunken">
                  <span className={`flex h-6 w-6 items-center justify-center rounded-sm border ${entry.type === "directory" ? "border-fg bg-fg text-bg-raised" : "border-border bg-bg-sunken text-fg-subtle"}`}>
                    {entry.type === "directory" ? <Folder size={11} strokeWidth={1.8} /> : <File size={11} strokeWidth={1.8} />}
                  </span>
                  <span className="mono truncate text-[12px] tracking-[-0.01em] text-fg">{entry.name}</span>
                </button>
              </li>
            ))}
            {listing && listing.entries.length === 0 && <li className="px-3 py-8 text-center mono text-[11px] text-fg-subtle">Prázdná složka</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
