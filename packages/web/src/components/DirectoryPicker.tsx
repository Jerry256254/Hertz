import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { ChevronUp, Folder, FolderOpen, House, X } from "lucide-react";
import { api } from "../lib/api";
import { Button } from "./ui";

interface BrowseResult {
  path: string;
  parent: string | null;
  home: string;
  entries: Array<{ name: string; path: string }>;
}

export function DirectoryPicker({
  open,
  onOpenChange,
  onSelect,
  initialPath,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
  initialPath?: string;
}) {
  const [path, setPath] = useState(initialPath ?? "");

  const { data, isLoading, error } = useQuery({
    queryKey: ["fs-browse", path],
    queryFn: () => api.get<BrowseResult>(`/fs/browse?path=${encodeURIComponent(path)}`),
    enabled: open,
  });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 flex h-[28rem] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-bg-raised shadow-popover">
          <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border px-4">
            <Dialog.Title className="text-sm font-semibold text-fg">Choose a directory</Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-fg-muted hover:text-fg">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-border px-2">
            <button
              onClick={() => data && setPath(data.home)}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              <House size={12} /> Home
            </button>
            <button
              onClick={() => data?.parent && setPath(data.parent)}
              disabled={!data?.parent}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-30"
            >
              <ChevronUp size={12} /> Up
            </button>
            <span className="mono min-w-0 flex-1 truncate px-1.5 text-xs text-fg-subtle">{data?.path ?? path}</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {isLoading && <p className="p-3 text-xs text-fg-muted">Loading…</p>}
            {error && <p className="p-3 text-xs text-danger">{(error as Error).message}</p>}
            {data?.entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => setPath(entry.path)}
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm text-fg hover:bg-bg-hover"
              >
                <Folder size={13} className="flex-shrink-0 text-fg-subtle" />
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
            {data && data.entries.length === 0 && (
              <p className="p-3 text-xs text-fg-subtle">No subdirectories here.</p>
            )}
          </div>

          <div className="flex flex-shrink-0 items-center justify-between border-t border-border px-4 py-3">
            <span className="flex items-center gap-1.5 text-xs text-fg-muted">
              <FolderOpen size={13} /> Selecting current folder
            </span>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                if (data) onSelect(data.path);
                onOpenChange(false);
              }}
              disabled={!data}
            >
              Use this folder
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
