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
  /** "self" browses one employee's own folder (notes/materials/data) instead of the shared project root — requires agentId. */
  root?: "main" | "self";
  agentId?: string;
}) {
  const [currentPath, setCurrentPath] = useState(".");
  const [previewPath, setPreviewPath] = useState<string | undefined>(undefined);
  const scopeParam = `&root=${root}${agentId ? `&agentId=${agentId}` : ""}`;
  const queryClient = useQueryClient();

  const createFolder = useMutation({
    mutationFn: (name: string) =>
      api.post(`/projects/${projectId}/files/dir`, {
        path: currentPath === "." ? name : `${currentPath}/${name}`,
        root,
        agentId,
      }),
    onSuccess: (_data, name) => {
      queryClient.invalidateQueries({ queryKey: ["files", projectId, root, agentId] });
      setPreviewPath(undefined);
      setCurrentPath(currentPath === "." ? name : `${currentPath}/${name}`);
    },
  });

  function promptNewFolder() {
    const name = window.prompt("New folder name")?.trim();
    if (!name || name === "." || name === ".." || name.includes("/")) return;
    createFolder.mutate(name);
  }

  useEffect(() => {
    setCurrentPath(".");
    setPreviewPath(undefined);
  }, [root, agentId]);

  const { data: listing, isFetching } = useQuery({
    queryKey: ["files", projectId, root, agentId, currentPath],
    queryFn: () =>
      api.get<{ entries: FileEntry[] }>(
        `/projects/${projectId}/files?path=${encodeURIComponent(currentPath)}${scopeParam}`,
      ),
    refetchInterval: 4000,
  });

  const { data: preview } = useQuery({
    queryKey: ["file-content", projectId, root, agentId, previewPath],
    queryFn: () =>
      api.get<{ content: string; truncated: boolean }>(
        `/projects/${projectId}/file-content?path=${encodeURIComponent(previewPath!)}${scopeParam}`,
      ),
    enabled: !!previewPath,
  });

  function goUp() {
    if (currentPath === ".") return;
    const parts = currentPath.split("/");
    parts.pop();
    setCurrentPath(parts.length ? parts.join("/") : ".");
    setPreviewPath(undefined);
  }

  function open(entry: FileEntry) {
    const nextPath = currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
    if (entry.type === "directory") {
      setCurrentPath(nextPath);
      setPreviewPath(undefined);
    } else {
      setPreviewPath(nextPath);
    }
  }

  return (
    <div className="flex h-full flex-col border-l border-border">
      <div className="flex h-8 flex-shrink-0 items-center gap-2 border-b border-border px-2">
        <button
          onClick={goUp}
          disabled={currentPath === "."}
          className="flex items-center text-fg-muted hover:text-fg disabled:opacity-30"
        >
          <ChevronUp size={13} />
        </button>
        <span className="mono truncate text-xs text-fg-muted">{currentPath === "." ? "/" : currentPath}</span>
        <button
          onClick={promptNewFolder}
          disabled={createFolder.isPending}
          title="New folder"
          className="ml-auto flex items-center text-fg-muted hover:text-fg disabled:opacity-30"
        >
          <FolderPlus size={13} />
        </button>
        {isFetching && <span className="h-1 w-1 flex-shrink-0 rounded-full bg-fg-subtle" />}
      </div>
      {createFolder.isError && (
        <p className="flex-shrink-0 border-b border-border px-2 py-1 text-xs text-danger">
          {(createFolder.error as Error).message}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {previewPath ? (
          <div className="flex h-full flex-col">
            <button
              onClick={() => setPreviewPath(undefined)}
              className="flex flex-shrink-0 items-center gap-1 px-2 py-1.5 text-xs text-fg-muted hover:text-fg"
            >
              <ArrowLeft size={12} /> back
            </button>
            <div className="min-h-0 flex-1 overflow-auto">
              {preview && (
                <Suspense fallback={<p className="p-2 text-xs text-fg-subtle">Loading…</p>}>
                  <CodeViewer path={previewPath} content={preview.content} />
                </Suspense>
              )}
            </div>
            {preview?.truncated && (
              <p className="flex-shrink-0 border-t border-border px-2 py-1.5 text-xs text-warning">
                Truncated preview.
              </p>
            )}
          </div>
        ) : (
          <ul>
            {listing?.entries.map((entry) => (
              <li key={entry.name}>
                <button
                  onClick={() => open(entry)}
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-bg-hover"
                >
                  {entry.type === "directory" ? (
                    <Folder size={12} className="flex-shrink-0 text-fg-subtle" />
                  ) : (
                    <File size={12} className="flex-shrink-0 text-fg-subtle" />
                  )}
                  <span className="mono truncate">{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
