import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronUp, Folder, FolderOpen, FolderPlus, House, X } from "lucide-react";
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
  const queryClient = useQueryClient();
  const [path, setPath] = useState(initialPath ?? "");
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["fs-browse", path],
    queryFn: () => api.get<BrowseResult>(`/fs/browse?path=${encodeURIComponent(path)}`),
    enabled: open,
  });

  const createFolder = useMutation({
    mutationFn: (name: string) => api.post<{ path: string }>("/fs/mkdir", { path: data?.path ?? "", name }),
    onSuccess: (created) => {
      setShowNewFolder(false);
      setNewFolderName("");
      void queryClient.invalidateQueries({ queryKey: ["fs-browse"] });
      setPath(created.path);
    },
  });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[28rem] max-h-[calc(100dvh-3rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-[20px] border border-border bg-bg-raised shadow-popover">
          <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border px-4">
            <Dialog.Title className="text-sm font-semibold text-fg">Vyber složku</Dialog.Title>
<Dialog.Close asChild>
              <button aria-label="Zavřít" className="flex h-11 w-11 items-center justify-center rounded-full text-fg-muted hover:bg-bg-sunken hover:text-fg">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex min-h-[48px] flex-shrink-0 items-center gap-1 border-b border-border px-2">
            <button
              onClick={() => data && setPath(data.home)}
              disabled={isLoading || !data}
              className="flex min-h-[40px] items-center gap-1 rounded px-2 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-30"
            >
              <House size={12} /> Domů
            </button>
            <button
              onClick={() => data?.parent && setPath(data.parent)}
              disabled={isLoading || !data?.parent}
              className="flex min-h-[40px] items-center gap-1 rounded px-2 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-30"
            >
              <ChevronUp size={12} /> Nahoru
            </button>
            <button
              onClick={() => setShowNewFolder((v) => !v)}
              disabled={!data}
              className="ml-auto flex min-h-[40px] items-center gap-1 rounded px-2 text-xs text-accent hover:bg-bg-hover disabled:opacity-30"
            >
              <FolderPlus size={12} /> Nová složka
            </button>
            <span className="mono min-w-0 max-w-[40%] flex-shrink truncate px-1.5 text-xs text-fg-subtle">{data?.path ?? path}</span>
          </div>

          {showNewFolder && (
            <form
              className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-bg-sunken px-3 py-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (newFolderName.trim()) createFolder.mutate(newFolderName.trim());
              }}
            >
              <FolderPlus size={13} className="flex-shrink-0 text-fg-subtle" />
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="Název nové složky"
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg-raised px-2 text-xs text-fg outline-none focus:border-accent"
              />
              <Button type="submit" size="sm" variant="primary" disabled={!newFolderName.trim() || createFolder.isPending}>
                Vytvořit
              </Button>
            </form>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {isLoading && <p className="p-3 text-xs text-fg-muted">Načítám…</p>}
            {error && <p className="p-3 text-xs text-danger">{(error as Error).message}</p>}
            {data?.entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => setPath(entry.path)}
                className="flex min-h-[44px] w-full items-center gap-2 px-4 py-2 text-left text-sm text-fg hover:bg-bg-hover"
              >
                <Folder size={13} className="flex-shrink-0 text-fg-subtle" />
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
            {data && data.entries.length === 0 && (
              <p className="p-3 text-xs text-fg-subtle">Tady nejsou žádné podsložky.</p>
            )}
          </div>

          <div className="flex flex-shrink-0 items-center justify-between border-t border-border px-4 py-3">
            <span className="flex items-center gap-1.5 text-xs text-fg-muted">
              <FolderOpen size={13} /> Vybere se aktuální složka
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
              Použít tuhle složku
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
