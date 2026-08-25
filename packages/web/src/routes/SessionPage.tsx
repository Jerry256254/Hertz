import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Files, Monitor, Paperclip, Pause, Play, Settings, Square, TriangleAlert, X } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { Budget, HertzSession, PersistedMessage } from "../lib/types";
import { subscribeToSession } from "../lib/ws-client";
import { MessageView } from "../components/MessageView";
import { Markdown } from "../components/Markdown";
import { FileExplorer } from "../components/FileExplorer";
import { Avatar, IconButton, Input, Badge, Button } from "../components/ui";
import { Clock } from "lucide-react";
import { agentColor } from "../lib/agent-color";

interface SessionDetail {
  session: HertzSession;
  messages: PersistedMessage[];
  budget: Budget;
  running: boolean;
  paused: boolean;
  pendingQuestion: string | null;
  agent?: { id: string; name: string; role: string; mascot?: string | null } | null;
  peerAgent?: { id: string; name: string; role: string; mascot?: string | null } | null;
  participants?: Array<{ id: string; name: string; role: string; mascot?: string | null }>;
  pendingTakeover?: { reason?: string } | null;
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [images, setImages] = useState<Array<{ mimeType: string; data: string }>>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [runError, setRunError] = useState<string | undefined>(undefined);
  const [showFiles, setShowFiles] = useState(false);
  const [showScreen, setShowScreen] = useState(false);
  const mode = "autonomous" as const;
  const [answerText, setAnswerText] = useState("");
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
      } else if (event.type === "awaiting_input") {
        setStreamingText("");
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
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
    const payload = { text, images, mode };
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

  const agentIdForScreen = data?.agent?.id ?? data?.session.agentId ?? "";

  function openScreen(agentId: string) {
    const win = window.open("about:blank", "_blank");
    api.get<{ token: string }>(`/agents/${agentId}/screen/token`)
      .then(({ token }) => {
        const url = `/screen/${agentId}?t=${encodeURIComponent(token)}`;
        if (win && !win.closed) win.location.href = url;
        else window.open(url, "_blank");
      })
      .catch((err: unknown) => {
        if (win && !win.closed) win.close();
        setRunError(err instanceof ApiError ? err.message : "Couldn't open screen — desktop may still be starting. Try again in a few seconds.");
      });
  }

  const doneTakeover = useMutation({
    mutationFn: () => api.post(`/agents/${data?.session.agentId ?? agentIdForScreen}/takeover/done`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["session", sessionId] }),
  });

  const answerQuestion = useMutation({
    mutationFn: (answer: string) => api.post(`/sessions/${sessionId}/answer`, { text: answer }),
    onSuccess: () => {
      setAnswerText("");
      setIsRunning(true);
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
    },
    onError: (err) => setRunError(err instanceof ApiError ? err.message : "Couldn't send the answer"),
  });

  function submitAnswer(e: FormEvent) {
    e.preventDefault();
    if (!answerText.trim()) return;
    answerQuestion.mutate(answerText);
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

  const senderNames = useMemo(() => {
    const names: Record<string, string> = {};
    if (data?.agent) names[data.agent.id] = data.agent.name;
    if (data?.peerAgent) names[data.peerAgent.id] = data.peerAgent.name;
    for (const p of data?.participants ?? []) names[p.id] = p.name;
    return names;
  }, [data]);

  const senderMascots = useMemo(() => {
    const mascots: Record<string, string | null | undefined> = {};
    if (data?.agent) mascots[data.agent.id] = data.agent.mascot;
    if (data?.peerAgent) mascots[data.peerAgent.id] = data.peerAgent.mascot;
    for (const p of data?.participants ?? []) mascots[p.id] = p.mascot;
    return mascots;
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
    <div className={`grid min-h-0 flex-1 grid-cols-1 grid-rows-1 ${showFiles || showScreen ? "md:grid-cols-[1fr_340px]" : "md:grid-cols-[1fr_0px]"}`}>
      <div className="flex min-w-0 flex-col">
        <header className="flex h-14 flex-shrink-0 items-center justify-between gap-3 border-b border-border px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            {data?.agent ? (
              <>
                <Avatar label={data.agent.name} mascot={data.agent.mascot} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-fg">{data.agent.name}</p>
                  <p className="truncate text-[11px] text-fg-subtle">{isRunning ? "working…" : data.session.status === "awaiting_input" ? "waiting for you" : "online"}</p>
                </div>
              </>
            ) : (
              data && <EditableTitle sessionId={sessionId!} title={data.session.title} />
            )}
          </div>
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
            {data?.pendingTakeover && (
              <span className="flex items-center gap-2 rounded-full border border-accent bg-accent-wash px-3 py-1 text-[11px] font-medium text-accent">
                Take-over requested
                <button
                  className="underline"
                  onClick={() => void openScreen(data.agent?.id ?? data.session.agentId)}
                >
                  Open screen
                </button>
                <button
                  className="rounded-full bg-accent px-2 py-0.5 text-accent-fg"
                  onClick={() => doneTakeover.mutate()}
                >
                  I'm done
                </button>
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
            {isRunning && (
              <IconButton
                title="Hard-stop this run (aborts the current call and finishes the session)"
                onClick={() => api.post(`/sessions/${sessionId}/stop`)}
              >
                <Square size={15} />
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
              title="Bot's screen — watch or take over"
              onClick={() => {
                setShowScreen((v) => !v);
                setShowFiles(false);
              }}
              className={showScreen ? "bg-bg-hover text-fg" : ""}
            >
              <Monitor size={15} />
            </IconButton>
            <IconButton
              title="Toggle file browser"
              onClick={() => {
                setShowFiles((v) => !v);
                setShowScreen(false);
              }}
              className={showFiles ? "bg-bg-hover text-fg" : ""}
            >
              <Files size={15} />
            </IconButton>
            {data?.agent && projectId && (
              <IconButton title="Bot settings" onClick={() => navigate(`/projects/${projectId}/agents/${data.agent!.id}`)}>
                <Settings size={15} />
              </IconButton>
            )}
          </div>
        </header>

        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto py-6">
          {data?.messages.map((m) => (
            <MessageView key={m.id} message={m} toolResultsById={toolResultsById} senderNames={senderNames} senderMascots={senderMascots} />
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
          {data?.pendingTakeover && (
            <div className="mx-auto mb-3 w-full max-w-3xl px-4">
              <div className="rounded-2xl border border-border bg-bg-raised p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded-full bg-success-wash px-2 py-0.5 text-[11px] font-semibold text-success">
                    ⚡ Action needed
                  </span>
                  <span className="text-sm font-medium text-fg">Take over the bot's screen</span>
                </div>
                <p className="mb-3 text-sm text-fg-muted">{data.pendingTakeover.reason}</p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void openScreen(data.agent?.id ?? data.session.agentId)}
                  >
                    Take over
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => doneTakeover.mutate()}>
                    I'm done
                  </Button>
                </div>
              </div>
            </div>
          )}
          {data?.pendingQuestion && data.session.status === "awaiting_input" && (
            <form
              onSubmit={submitAnswer}
              className="mx-auto mb-3 max-w-3xl rounded-lg border border-border-strong bg-bg-raised p-3 shadow-sm"
            >
              <p className="flex items-center gap-2 text-xs font-medium text-fg">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                The agent is waiting for your answer
              </p>
              <p className="mt-1 text-sm text-fg">{data.pendingQuestion}</p>
              <div className="mt-2 flex items-center gap-2">
                <textarea
                  value={answerText}
                  onChange={(e) => setAnswerText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submitAnswer(e);
                    }
                  }}
                  rows={2}
                  autoFocus
                  placeholder="Your answer…"
                  className="max-h-[160px] w-full resize-none rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-subtle outline-none focus:border-border-strong disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={!answerText.trim() || answerQuestion.isPending}
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity disabled:opacity-30"
                  title="Send answer"
                >
                  <ArrowUp size={16} />
                </button>
              </div>
            </form>
          )}
          <form
            onSubmit={onSubmit}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void onFiles(e.dataTransfer.files);
            }}
            className="relative mx-auto flex max-w-3xl items-center gap-1 rounded-full border border-border bg-bg-raised py-1 pl-2 pr-1.5 shadow-sm focus-within:border-border-strong"
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
              onChange={(e) => {
                setText(e.target.value);
                const el = e.target as HTMLTextAreaElement;
                el.style.height = "24px";
                el.style.height = Math.min(el.scrollHeight, 120) + "px";
              }}
              onKeyDown={onKeyDown}
              onPaste={(e) => void onFiles(e.clipboardData.files)}
              placeholder={
                data?.pendingQuestion && data.session.status === "awaiting_input"
                  ? "Answer the agent's question…"
                  : isPaused
                    ? "Paused — resume to continue"
                    : `Message ${data?.agent?.name ?? "the agent"}…`
              }
              rows={1}
              className="max-h-[120px] min-h-[24px] w-full resize-none border-0 bg-transparent px-2 py-1 text-sm leading-6 text-fg placeholder:text-fg-subtle outline-none disabled:opacity-60"
            />
            <div className="flex items-center gap-1 px-1">
              <div className="flex items-center gap-1">
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
              </div>
              <span className="flex-1" />
              <button
                type="submit"
                disabled={!text && images.length === 0}
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity disabled:opacity-30"
              >
                <ArrowUp size={16} />
              </button>
            </div>
          </form>
        </div>
      </div>
      {showScreen && agentIdForScreen && (
        <div className="fixed inset-0 z-20 flex flex-col bg-bg md:static md:z-auto md:min-h-0 md:flex-col md:overflow-y-auto md:border-l md:border-border md:bg-bg-sidebar flex">
          <ScreenPanel agentId={agentIdForScreen} agentName={data?.agent?.name ?? "Bot"} />
        </div>
      )}
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

/** Right-side panel: the bot's live screen (embed) + its routines, Grok-Bot style. */
function ScreenPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const { data: status } = useQuery({
    queryKey: ["screen", agentId],
    queryFn: () => api.get<{ running: boolean; tunnelUrl?: string | null }>(`/agents/${agentId}/screen/status`),
    refetchInterval: 5000,
  });

  async function openViewer() {
    const { token } = await api.get<{ token: string }>(`/agents/${agentId}/screen/token`);
    setIframeUrl(`/screen/${agentId}?t=${encodeURIComponent(token)}`);
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{agentName}'s screen</p>
          <Badge tone={status?.running ? "success" : "neutral"}>{status?.running ? "live" : "off"}</Badge>
        </div>
        {iframeUrl ? (
          <iframe title="Agent screen" src={iframeUrl} className="aspect-[16/10] w-full rounded-xl border border-border" />
        ) : (
          <button
            onClick={() => void openViewer()}
            className="flex aspect-[16/10] w-full items-center justify-center rounded-xl border border-border bg-bg-raised text-fg-subtle transition-colors hover:border-border-strong hover:text-fg"
          >
            <Monitor size={22} />
          </button>
        )}
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => void api.post(`/agents/${agentId}/screen/start`)}>
            {status?.running ? "Restart stack" : "Start desktop"}
          </Button>
          {iframeUrl && (
            <Button size="sm" variant="ghost" onClick={() => window.open(iframeUrl, "_blank")}>
              Pop out
            </Button>
          )}
        </div>
      </div>

      <AgentRoutines agentId={agentId} />
    </div>
  );
}

function AgentRoutines({ agentId }: { agentId: string }) {
  const { projectId } = useParams<{ projectId: string; sessionId: string }>();
  const { data } = useQuery({
    queryKey: ["routines", projectId],
    queryFn: () => api.get<{ routines: Array<{ id: string; title: string; schedule: string; enabled: boolean; agentId: string }> }>(`/projects/${projectId}/routines`),
    enabled: !!projectId,
  });
  const mine = (data?.routines ?? []).filter((r) => r.agentId === agentId);

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Routines</p>
      {mine.length === 0 ? (
        <p className="text-xs text-fg-subtle">Recurring tasks this bot runs on a schedule — just ask it in the chat to set one up.</p>
      ) : (
        <ul className="space-y-1.5">
          {mine.map((r) => (
            <li key={r.id} className="rounded-lg border border-border px-3 py-2">
              <p className="flex items-center gap-1.5 text-sm text-fg">
                <Clock size={12} className="text-accent" /> {r.title}
              </p>
              <p className="text-xs text-fg-subtle">{r.schedule}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
