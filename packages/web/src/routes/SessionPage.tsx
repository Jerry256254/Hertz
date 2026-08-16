import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Files, Paperclip, Pause, Play, TriangleAlert, X } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { Budget, HertzSession, PersistedMessage } from "../lib/types";
import { subscribeToSession } from "../lib/ws-client";
import { MessageView } from "../components/MessageView";
import { Markdown } from "../components/Markdown";
import { FileExplorer } from "../components/FileExplorer";
import { IconButton, Input } from "../components/ui";
import { agentColor } from "../lib/agent-color";

interface SessionDetail {
  session: HertzSession;
  messages: PersistedMessage[];
  budget: Budget;
  running: boolean;
  paused: boolean;
  agent?: { id: string; name: string; role: string } | null;
  peerAgent?: { id: string; name: string; role: string } | null;
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
  const [isPaused, setIsPaused] = useState(false);
  const [runError, setRunError] = useState<string | undefined>(undefined);
  const [showFiles, setShowFiles] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const stickToBottomRef = useRef(true);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottomRef.current = nearBottom;
    setShowJumpToBottom(!nearBottom);
  }

  function jumpToBottom() {
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }

  const { data } = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.get<SessionDetail>(`/sessions/${sessionId}`),
  });

  useEffect(() => {
    if (data) {
      setIsRunning(data.running);
      setIsPaused(data.paused);
    }
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
        setIsPaused(event.status === "paused");
        if (event.status === "running") setRunError(undefined);
        if (event.status !== "running") setStreamingText("");
      } else if (event.type === "error") {
        setRunError(event.message);
      } else if (event.type === "done") {
        setIsRunning(false);
        setIsPaused(false);
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] });
      }
    });
    return unsubscribe;
  }, [sessionId, queryClient]);

  // Follow new content while at the bottom, but never yank the scroll position away
  // from the user mid-read (they can use the jump-to-bottom button instead).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [data?.messages.length, streamingText, isRunning]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  async function send() {
    if (!text && images.length === 0) return;

    if (text.trim() === "/compact") {
      setIsRunning(true);
      setRunError(undefined);
      setText("");
      try {
        await api.post(`/sessions/${sessionId}/compact`);
      } catch (err) {
        setRunError(err instanceof ApiError ? err.message : "Couldn't compact this chat");
      } finally {
        setIsRunning(false);
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      }
      return;
    }

    // Messages sent while the agent is working are injected into the run — it
    // answers them without stopping (and a paused run stays paused until resumed).
    const payload = { text, images };
    setText("");
    setImages([]);
    try {
      await api.post(`/sessions/${sessionId}/messages`, payload);
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Couldn't send the message");
      setText(payload.text);
      setImages(payload.images);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
  }

  const pauseResume = useMutation({
    mutationFn: (action: "pause" | "resume") => api.post(`/sessions/${sessionId}/${action}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
    },
    onError: (err) => setRunError(err instanceof ApiError ? err.message : "Couldn't update the run state"),
  });

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

  const senderNames = useMemo(() => {
    const names: Record<string, string> = {};
    if (data?.agent) names[data.agent.id] = data.agent.name;
    if (data?.peerAgent) names[data.peerAgent.id] = data.peerAgent.name;
    return names;
  }, [data]);

  // Which agent the streaming/typing bubble belongs to: in a direct conversation
  // it's whoever must answer next (the one who didn't send the last message).
  const activeAgentId = useMemo(() => {
    if (!data) return undefined;
    if (data.session.kind !== "conversation") return data.session.agentId;
    const last = [...data.messages].reverse().find((m) => m.senderAgentId);
    if (!last) return data.session.agentId;
    return last.senderAgentId === data.session.agentId
      ? data.session.peerAgentId ?? data.session.agentId
      : data.session.agentId;
  }, [data]);
  const activeAgentName = activeAgentId ? (senderNames[activeAgentId] ?? "H") : "H";

  const toolResultsById = useMemo(() => {
    const results = new Map<string, { content: string; isError?: boolean }>();
    for (const m of data?.messages ?? []) {
      for (const block of m.content) {
        if (block.type === "tool_result") results.set(block.toolUseId, { content: block.content, isError: block.isError });
      }
    }
    return results;
  }, [data?.messages]);

  return (
    <div className={`grid min-h-0 flex-1 grid-cols-1 grid-rows-1 ${showFiles ? "md:grid-cols-[1fr_340px]" : "md:grid-cols-[1fr_0px]"}`}>
      <div className="flex min-w-0 flex-col">
        <header className="flex h-14 flex-shrink-0 items-center justify-between gap-3 border-b border-border px-6">
          {data && <EditableTitle sessionId={sessionId!} title={data.session.title} />}
          <div className="flex items-center gap-3">
            {data?.session.kind === "conversation" && (
              <span className="rounded-full bg-bg-sunken px-2.5 py-1 text-[11px] font-medium text-fg-subtle">
                Direct chat
              </span>
            )}
            {isPaused && (
              <span className="rounded-full bg-bg-sunken px-2.5 py-1 text-[11px] font-medium text-fg-muted">
                Paused
              </span>
            )}
            {isRunning && (
              <IconButton title="Pause the agent's work" onClick={() => pauseResume.mutate("pause")}>
                <Pause size={15} />
              </IconButton>
            )}
            {isPaused && (
              <IconButton title="Resume the agent's work" onClick={() => pauseResume.mutate("resume")}>
                <Play size={15} />
              </IconButton>
            )}
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

        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto py-6">
          {data?.messages.map((m) => (
            <MessageView key={m.id} message={m} toolResultsById={toolResultsById} senderNames={senderNames} />
          ))}
          {streamingText && (
            <div className="mx-auto flex w-full max-w-3xl gap-3 px-4 py-3">
              <span
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                style={activeAgentId ? { backgroundColor: agentColor(activeAgentId), color: "#fff" } : undefined}
              >
                {activeAgentName.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <Markdown>{streamingText}</Markdown>
              </div>
            </div>
          )}
          {isRunning && !streamingText && (
            <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3">
              <span
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                style={activeAgentId ? { backgroundColor: agentColor(activeAgentId), color: "#fff" } : undefined}
              >
                {activeAgentName.slice(0, 1).toUpperCase()}
              </span>
              <span className="flex gap-1">
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fg-subtle [animation-delay:0s]" />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fg-subtle [animation-delay:0.15s]" />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fg-subtle [animation-delay:0.3s]" />
              </span>
              {isPaused && <span className="text-xs text-fg-subtle">paused — will continue on resume</span>}
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
            className="relative mx-auto max-w-3xl rounded-lg border border-border bg-bg-raised p-2 shadow-sm focus-within:border-border-strong"
          >
            {showJumpToBottom && (
              <button
                type="button"
                onClick={jumpToBottom}
                title="Jump to bottom"
                className="absolute -top-12 right-2 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-bg-raised text-fg-muted shadow-md transition-colors hover:bg-bg-hover hover:text-fg"
              >
                <ArrowDown size={16} />
              </button>
            )}
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
              placeholder={
                isPaused
                  ? "Paused — the agent will read this after you resume"
                  : isRunning
                    ? "Type to message the agent — it will answer without stopping its work"
                    : "Message the agent — drop or paste images, Enter to send, /compact to shrink context"
              }
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
                disabled={!text && images.length === 0}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity disabled:opacity-30"
              >
                <ArrowUp size={16} />
              </button>
            </div>
          </form>
        </div>
      </div>
      {showFiles && projectId && (
        // A full-screen overlay on mobile (with its own close button — a fixed 340px side
        // column on a phone-width screen squeezed the chat header, including this same
        // toggle button, down to a few unusable pixels) instead of a grid column there.
        <div className="fixed inset-0 z-20 flex flex-col bg-bg md:static md:z-auto">
          <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border px-3 md:hidden">
            <span className="text-sm font-medium text-fg">Files</span>
            <IconButton title="Close files" onClick={() => setShowFiles(false)}>
              <X size={16} />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1">
            <FileExplorer projectId={projectId} />
          </div>
        </div>
      )}
    </div>
  );
}
