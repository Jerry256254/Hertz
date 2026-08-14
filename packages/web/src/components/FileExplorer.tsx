import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { FileEntry } from "../lib/types";

export function FileExplorer({ projectId }: { projectId: string }) {
  const [currentPath, setCurrentPath] = useState(".");
  const [previewPath, setPreviewPath] = useState<string | undefined>(undefined);

  const { data: listing, isFetching } = useQuery({
    queryKey: ["files", projectId, currentPath],
    queryFn: () =>
      api.get<{ entries: FileEntry[] }>(
        `/projects/${projectId}/files?path=${encodeURIComponent(currentPath)}`,
      ),
    refetchInterval: 4000,
  });

  const { data: preview } = useQuery({
    queryKey: ["file-content", projectId, previewPath],
    queryFn: () =>
      api.get<{ content: string; truncated: boolean }>(
        `/projects/${projectId}/file-content?path=${encodeURIComponent(previewPath!)}`,
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
        <button onClick={goUp} disabled={currentPath === "."} className="text-xs text-fg-muted hover:text-fg disabled:opacity-30">
          ↑ up
        </button>
        <span className="truncate font-mono text-xs text-fg-muted">{currentPath}</span>
        {isFetching && <span className="text-xs text-fg-muted">·</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {previewPath ? (
          <div className="p-2">
            <button onClick={() => setPreviewPath(undefined)} className="mb-2 text-xs text-fg-muted hover:text-fg">
              ← back
            </button>
            <pre className="mono overflow-auto whitespace-pre-wrap break-all text-xs">{preview?.content}</pre>
            {preview?.truncated && <p className="mt-2 text-xs text-warning">Truncated preview.</p>}
          </div>
        ) : (
          <ul>
            {listing?.entries.map((entry) => (
              <li key={entry.name}>
                <button
                  onClick={() => open(entry)}
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-bg-raised"
                >
                  <span className="text-fg-muted">{entry.type === "directory" ? "▸" : " "}</span>
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
