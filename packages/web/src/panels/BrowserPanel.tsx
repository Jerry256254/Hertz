import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Globe, Maximize, Monitor, RefreshCw, X } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { Agent } from "../lib/types";
import { Button, IconButton } from "../components/ui";

interface ScreenStatus {
  running: boolean;
  tunnelUrl?: string | null;
}

/** Live desktop view — the agent's computer next to the chat. */
export function BrowserPanel({ agent, onClose, onTakeoverDone }: { agent: Agent; onClose: () => void; onTakeoverDone?: () => void }) {
  const queryClient = useQueryClient();
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const loadingRef = useRef(false);
  const frameRef = useRef<HTMLDivElement>(null);

  const { data: status } = useQuery({
    queryKey: ["screen", agent.id],
    queryFn: () => api.get<ScreenStatus>(`/agents/${agent.id}/screen/status`),
    refetchInterval: 5000,
  });

  const openViewer = useMemo(
    () => async () => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoadError(null);
      try {
        const { token } = await api.get<{ token: string }>(`/agents/${agent.id}/screen/token`);
        setIframeUrl(`/screen/${agent.id}?t=${encodeURIComponent(token)}`);
        setIframeKey((k) => k + 1);
      } catch (err) {
        setLoadError(err instanceof ApiError ? err.message : "Náhled se nepodařilo načíst");
      } finally {
        loadingRef.current = false;
      }
    },
    [agent.id],
  );

  useEffect(() => {
    if (status?.running && !iframeUrl && !loadError) void openViewer();
  }, [status?.running, iframeUrl, loadError, openViewer]);

  async function startDesktop() {
    setStarting(true);
    try {
      await api.post(`/agents/${agent.id}/screen/start`);
      void queryClient.invalidateQueries({ queryKey: ["screen", agent.id] });
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Desktop se nepodařilo spustit");
    } finally {
      setStarting(false);
    }
  }

  function openInNewTab() {
    if (iframeUrl) window.open(iframeUrl, "_blank");
    else {
      const win = window.open("about:blank", "_blank");
      api
        .get<{ token: string }>(`/agents/${agent.id}/screen/token`)
        .then(({ token }) => {
          const url = `/screen/${agent.id}?t=${encodeURIComponent(token)}`;
          if (win && !win.closed) win.location.href = url;
          else window.open(url, "_blank");
        })
        .catch((err: unknown) => {
          if (win && !win.closed) win.close();
          setLoadError(err instanceof ApiError ? err.message : "Obrazovku nešlo otevřít — desktop možná ještě startuje.");
        });
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void frameRef.current?.requestFullscreen().catch(() => {});
  }

  async function takeoverDone() {
    try {
      await api.post(`/agents/${agent.id}/takeover/done`);
    } catch {
      /* link-only viewers just close */
    }
    onTakeoverDone?.();
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 px-4 pb-2 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-[15px] font-[700] tracking-[-0.02em] text-fg">Počítač agenta</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-fg-muted">
              {status?.running && <span className="h-1.5 w-1.5 rounded-full bg-live pulse-live" />}
              {status?.running ? "Živě" : "Vypnuto"} · {agent.name}
            </p>
          </div>
          <IconButton title="Zavřít" onClick={onClose}><X size={15} /></IconButton>
        </div>
        <div className="mt-2 flex gap-1.5 overflow-x-auto">
          <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-bg-raised px-3 py-1.5 text-[12px] text-fg-muted">
            <Globe size={12} /> desktop
          </span>
        </div>
        <Button size="sm" variant="primary" className="mt-2.5 w-full" onClick={openInNewTab}>
          Převzít kontrolu nad prohlížečem
        </Button>
      </div>

      <div ref={frameRef} className="min-h-0 flex-1 overflow-y-auto bg-bg px-4 pb-4">
        {iframeUrl ? (
          <iframe key={iframeKey} title="Obrazovka agenta" src={iframeUrl} className="aspect-[16/10] w-full rounded-[16px] border border-border bg-black" allow="clipboard-read; clipboard-write" />
        ) : loadError ? (
          <div className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-2.5 rounded-[16px] border border-dashed border-border bg-bg-raised px-4 text-center">
            <p className="mono text-[12px] leading-relaxed text-danger">{loadError}</p>
            <Button size="sm" variant="secondary" onClick={() => void openViewer()}>Zkusit znovu</Button>
          </div>
        ) : (
          <div className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-2.5 rounded-[16px] border border-dashed border-border bg-bg-raised text-fg-subtle">
            <Monitor size={24} className={status?.running ? "pulse-live" : undefined} />
            <span className="text-[12.5px] font-[600]">{status?.running ? "Připojuji náhled…" : "Desktop neběží"}</span>
            {!status?.running && (
              <Button size="sm" variant="primary" onClick={() => void startDesktop()} disabled={starting}>
                {starting ? "Spouštím…" : "Spustit desktop"}
              </Button>
            )}
          </div>
        )}

        <div className="mt-2.5 flex items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => void startDesktop()}>{status?.running ? "Restartovat" : "Spustit"}</Button>
          <Button size="sm" variant="secondary" onClick={() => void takeoverDone()}>Hotovo — vrátit agentovi</Button>
          <span className="flex-1" />
          <IconButton title="Obnovit náhled" onClick={() => void openViewer()} disabled={!status?.running}><RefreshCw size={14} /></IconButton>
          <IconButton title="Celá obrazovka" onClick={toggleFullscreen} disabled={!iframeUrl}><Maximize size={14} /></IconButton>
          <IconButton title="Otevřít v novém okně" onClick={openInNewTab} disabled={!status?.running}><ExternalLink size={14} /></IconButton>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-fg-subtle">
          Myš a klávesnice v okně ovládají počítač agenta přímo. Převzetí se hodí na přihlášení a kroky, které agent sám nesmí.
        </p>
      </div>
    </div>
  );
}
