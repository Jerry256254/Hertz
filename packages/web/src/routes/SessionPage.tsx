import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Files, Paperclip, TriangleAlert, X } from "lucide-react";
import { api } from "../lib/api";
import type { Budget, HertzSession, PersistedMessage } from "../lib/types";
import { subscribeToSession } from "../lib/ws-client";
import { MessageView } from "../components/MessageView";
import { Markdown } from "../components/Markdown";
import { FileExplorer } from "../components/FileExplorer";
import { IconButton, Input } from "../components/ui";

interface SessionDetail {
  session: HertzSession;
  messages: PersistedMessage[];
  budget: Budget;
  running: boolean;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function EditableTitle({ sessionId, title }: { sessionId: string; title: string }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);

  const rename = useMutation({
    mutationFn: (nextTitle: string) => api.patch(`/sessions/${sessionId}`, { title: nextTitle }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] });
    },
  });

  useEffect(() => setValue(title), [title]);

  function commit() {
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed && trimmed !== title) rename.mutate(trimmed);
    else setValue(title);
  }

  if (editing) {
    return (
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setValue(title);
            setEditing(false);
          }
        }}
        className="h-7 max-w-xs text-sm"
      />
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="truncate rounded px-1 -mx-1 text-sm font-medium text-fg hover:bg-bg-hover"
      title="Click to rename"
    >
      {title}
    </button>
  );
}

export function SessionPage() {
  const { sessionId, projectId } = useParams<{ sessionId: string; projectId: string }>();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [images, setImages] = useState<Array<{ mimeType: string; data: string }>>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | undefined>(undefined);
  const [showFiles, setShowFiles] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data } = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.get<SessionDetail>(`/sessions/${sessionId}`),
  });

  useEffect(() => {
    if (data) setIsRunning(data.running);
  }, [data]);

  useEffect(() => {
    if (!sessionId) return;
    const unsubscribe = subscribeToSession(sessionId, (event) => {
      if (event.type === "text_delta") {
        setStreamingText((prev) => prev + event.text);
      } else if (event.type === "message_saved") {
        setStreamingText("");
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] });
      } else if (event.type === "status") {
        setIsRunning(event.status === "running");
      } else if (event.type === "error") {
        setRunError(event.message);
      } else if (event.type === "done") {
        setIsRunning(false);
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] });
      }
    });
    return unsubscribe;
  }, [sessionId, queryClient]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [data?.messages.length, streamingText]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  async function send() {
    if ((!text && images.length === 0) || isRunning) return;
    setIsRunning(true);
    setRunError(undefined);
    const payload = { text, images };
    setText("");
    setImages([]);
    await api.post(`/sessions/${sessionId}/messages`, payload);
    void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files) return;
    const next = await Promise.all(
      Array.from(files)
        .filter((f) => f.type.startsWith("image/"))
        .map(async (f) => ({ mimeType: f.type, data: await fileToBase64(f) })),
    );
    setImages((prev) => [...prev, ...next]);
  }

  const budget = data?.budget;

  return (
    <div className={`grid h-full ${showFiles ? "grid-cols-[1fr_340px]" : "grid-cols-[1fr_0px]"}`}>
      <div className="flex min-w-0 flex-col">
        <header className="flex h-14 flex-shrink-0 items-center justify-between gap-3 border-b border-border px-6">
          {data && <EditableTitle sessionId={sessionId!} title={data.session.title} />}
          <div className="flex items-center gap-3">
            {budget && budget.used > 0 && (
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-28 overflow-hidden rounded-full bg-bg-sunken">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-300"
                    style={{ width: `${Math.min(100, budget.percent)}%` }}
                  />
                </div>
                <span className="mono text-xs text-fg-subtle">{budget.used.toLocaleString()} tok</span>
              </div>
            )}
            <IconButton
              title="Toggle file browser"
              onClick={() => setShowFiles((v) => !v)}
              className={showFiles ? "bg-bg-hover text-fg" : ""}
            >
              <Files size={15} />
            </IconButton>
          </div>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-6">
          {data?.messages.map((m) => (
            <MessageView key={m.id} message={m} />
          ))}
          {streamingText && (
            <div className="mx-auto flex w-full max-w-3xl gap-3 px-4 py-3">
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-fg">
                H
              </span>
              <div className="min-w-0 flex-1">
                <Markdown>{streamingText}</Markdown>
              </div>
            </div>
          )}
          {isRunning && !streamingText && (
            <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3">
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-fg">
                H
              </span>
              <span className="flex gap-1">
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fg-subtle [animation-delay:0s]" />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fg-subtle [animation-delay:0.15s]" />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fg-subtle [animation-delay:0.3s]" />
              </span>
            </div>
          )}
          {runError && (
            <div className="mx-auto flex w-full max-w-3xl items-start gap-2.5 px-4 py-3">
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-danger-wash">
                <TriangleAlert size={14} className="text-danger" />
              </span>
              <div className="rounded-lg bg-danger-wash px-3 py-2 text-sm text-danger">
                <p className="font-medium">The run failed</p>
                <p className="mt-0.5">{runError}</p>
              </div>
            </div>
          )}
        </div>

        <div className="flex-shrink-0 px-4 pb-4">
          <form
            onSubmit={onSubmit}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void onFiles(e.dataTransfer.files);
            }}
            className="mx-auto max-w-3xl rounded-2xl border border-border bg-bg-raised p-2 shadow-sm focus-within:border-border-strong"
          >
            {images.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-2 px-1 pt-1">
                {images.map((img, i) => (
                  <div key={i} className="group relative">
                    <img
                      src={`data:${img.mimeType};base64,${img.data}`}
                      className="h-14 w-14 rounded-md border border-border object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-bg-sunken text-fg-muted opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={(e) => void onFiles(e.clipboardData.files)}
              placeholder={isRunning ? "Agent is working…" : "Message the agent — drop or paste images, Enter to send"}
              disabled={isRunning}
              rows={1}
              className="max-h-[200px] w-full resize-none border-0 bg-transparent px-2 py-1.5 text-sm text-fg placeholder:text-fg-subtle outline-none disabled:opacity-60"
            />
            <div className="flex items-center justify-between px-1 pt-1">
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => void onFiles(e.target.files)}
                className="hidden"
                id="file-input"
              />
              <IconButton type="button" onClick={() => document.getElementById("file-input")?.click()}>
                <Paperclip size={15} />
              </IconButton>
              <button
                type="submit"
                disabled={isRunning || (!text && images.length === 0)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity disabled:opacity-30"
              >
                <ArrowUp size={16} />
              </button>
            </div>
          </form>
        </div>
      </div>
      {showFiles && projectId && <FileExplorer projectId={projectId} />}
    </div>
  );
}
