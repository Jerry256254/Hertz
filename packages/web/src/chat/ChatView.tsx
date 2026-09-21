import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Globe, Image as ImageIcon, MonitorUp, Paperclip, Pause, Play, Square, TriangleAlert, X } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { Agent, Budget, HertzSession, PersistedMessage } from "../lib/types";
import { subscribeToSession } from "../lib/ws-client";
import { firstText, truncate } from "../lib/format";
import { MessageView } from "../components/MessageView";
import { Markdown } from "../components/Markdown";
import { AgentAvatar } from "../components/AgentAvatar";
import { ToolStepChecklist, type ToolStep } from "../components/ToolStepChecklist";
import { IconButton } from "../components/ui";

export interface SessionDetail {
  session: HertzSession;
  messages: PersistedMessage[];
  budget: Budget;
  running: boolean;
  paused: boolean;
  pendingQuestion: string | null;
  agent?: { id: string; name: string; mascot?: string | null } | null;
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

function hasBrowserTools(m: PersistedMessage): boolean {
  return m.content.some((b) => b.type === "tool_use" && (b.name.startsWith("browser_") || b.name.startsWith("desktop_")));
}

function messageImages(m: PersistedMessage): Array<{ mimeType: string; data: string }> {
  return m.content.filter((b): b is Extract<typeof b, { type: "image" }> => b.type === "image");
}

/** Mirrors MessageView: tool-result-only user messages render nothing. */
function isVisibleMessage(m: PersistedMessage): boolean {
  if (m.role !== "user") return true;
  return m.content.some((b) => b.type === "text" || b.type === "image");
}

/** Assistant turn with tools but no text — these collapse into one steps block. */
function isToolOnlyAssistant(m: PersistedMessage): boolean {
  if (m.role !== "assistant" || m.purpose === "summarization") return false;
  const hasText = m.content.some((b) => b.type === "text" && b.text.trim().length > 0);
  const hasTools = m.content.some((b) => b.type === "tool_use");
  return hasTools && !hasText;
}

function blockText(m: PersistedMessage): string {
  return m.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Chat → Markdown for /export: readable transcript, tool calls as a compact list. */
export function chatToMarkdown(title: string, agentName: string, messages: PersistedMessage[]): string {
  const lines: string[] = [`# ${title}`, "", `Agent: ${agentName}`, `Exportováno: ${new Date().toLocaleString("cs-CZ")}`, ""];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (!isVisibleMessage(m)) continue;
    const text = blockText(m);
    const tools = m.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
    if (m.role === "user") {
      const images = m.content.filter((b) => b.type === "image").length;
      lines.push("## Ty", "");
      if (text.trim()) lines.push(text.trim(), "");
      if (images > 0) lines.push(`[${images}x obrázek]`, "");
    } else if (m.role === "assistant") {
      if (m.purpose === "summarization") {
        lines.push("---", "", "*Kontext zhustěn.*", "");
        continue;
      }
      lines.push(`## ${agentName}`, "");
      if (text.trim()) lines.push(text.trim(), "");
      for (const t of tools) {
        const input = t.input && typeof t.input === "object" ? JSON.stringify(t.input).slice(0, 160) : "";
        lines.push(`- [nástroj] ${t.name}${input ? ` — \`${input}\`` : ""}`);
      }
      if (tools.length > 0) lines.push("");
    }
  }
  return lines.join("\n").trim() + "\n";
}

export function ChatView({
  sessionId,
  agent,
  title,
  readOnly = false,
  banner,
  onOpenPreview,
  previewActive = false,
  onDesktopActivity,
  onToggleSidebar,
  onOpenAgent,
}: {
  sessionId: string;
  agent: Agent;
  title?: string;
  readOnly?: boolean;
  banner?: string;
  onOpenPreview: () => void;
  previewActive?: boolean;
  onDesktopActivity?: () => void;
  onToggleSidebar: () => void;
  onOpenAgent?: () => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [images, setImages] = useState<Array<{ mimeType: string; data: string }>>([]);
  const [docFiles, setDocFiles] = useState<Array<{ name: string; mimeType: string; data: string }>>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [runError, setRunError] = useState<string | undefined>(undefined);
  const [answerText, setAnswerText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const stickToBottomRef = useRef(true);
  const desktopNotifiedRef = useRef(false);

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
    desktopNotifiedRef.current = false;
    stickToBottomRef.current = true;
  }, [sessionId]);

  useEffect(() => {
    const unsub = subscribeToSession(sessionId, (event) => {
      if (event.type === "text_delta") setStreamingText((p) => p + event.text);
      else if (event.type === "message_saved") {
        setStreamingText("");
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] });
      } else if (event.type === "status") {
        setIsRunning(event.status === "running");
        setIsPaused(event.status === "paused");
        if (event.status === "running") {
          setRunError(undefined);
          desktopNotifiedRef.current = false;
        }
        if (event.status !== "running") setStreamingText("");
      } else if (event.type === "tool_call" && typeof event.name === "string" && (event.name.startsWith("desktop_") || event.name.startsWith("browser_"))) {
        if (!desktopNotifiedRef.current) {
          desktopNotifiedRef.current = true;
          onDesktopActivity?.();
        }
      } else if (event.type === "awaiting_input") {
        setStreamingText("");
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      } else if (event.type === "error") setRunError(event.message);
      else if (event.type === "done") {
        setIsRunning(false);
        setIsPaused(false);
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] });
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, queryClient]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [data?.messages.length, streamingText, isRunning]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  function downloadExport() {
    if (!data) return;
    const md = chatToMarkdown(title ?? data.session.title ?? "Chat", agent.name, data.messages);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${sessionId.slice(0, 8)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function send() {
    if (readOnly) return;
    if (!text && images.length === 0 && docFiles.length === 0) return;
    const command = text.trim().toLowerCase();
    if (command === "/compact" || command === "/clear" || command === "/export") {
      setText("");
      if (command === "/export") {
        downloadExport();
        return;
      }
      setIsRunning(command === "/compact");
      setRunError(undefined);
      try {
        await api.post(`/sessions/${sessionId}/${command === "/clear" ? "clear" : "compact"}`);
      } catch (err) {
        setRunError(err instanceof ApiError ? err.message : command === "/clear" ? "Nešlo vyčistit" : "Nešlo zkompaktnout");
      } finally {
        setIsRunning(false);
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] });
      }
      return;
    }
    const payload = { text, images, files: docFiles };
    setText("");
    setImages([]);
    setDocFiles([]);
    try {
      await api.post(`/sessions/${sessionId}/messages`, payload);
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Zprávu se nepodařilo odeslat");
      setText(payload.text);
      setImages(payload.images);
      setDocFiles(payload.files);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
  }

  const pauseResume = useMutation({
    mutationFn: (action: "pause" | "resume") => api.post(`/sessions/${sessionId}/${action}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["session", sessionId] }),
    onError: (err) => setRunError(err instanceof ApiError ? err.message : "Nešlo změnit stav"),
  });

  const doneTakeover = useMutation({
    mutationFn: () => api.post(`/agents/${agent.id}/takeover/done`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["session", sessionId] }),
  });

  const answerQuestion = useMutation({
    mutationFn: (answer: string) => api.post(`/sessions/${sessionId}/answer`, { text: answer }),
    onSuccess: () => {
      setAnswerText("");
      setIsRunning(true);
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
    },
    onError: (err) => setRunError(err instanceof ApiError ? err.message : "Odpověď se nepodařilo odeslat"),
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
    const list = Array.from(files);
    const nextImages = await Promise.all(
      list.filter((f) => f.type.startsWith("image/")).map(async (f) => ({ mimeType: f.type, data: await fileToBase64(f) })),
    );
    setImages((prev) => [...prev, ...nextImages]);
    const textish = list.filter(
      (f) => !f.type.startsWith("image/") && (f.type.startsWith("text/") || /json|csv|javascript|markdown/.test(f.type) || /\.(txt|md|markdown|csv|json|ts|js|py|log)$/i.test(f.name)),
    );
    if (textish.length > 0) {
      const nextDocs = await Promise.all(
        textish.slice(0, 5).map(async (f) => ({ name: f.name, mimeType: f.type || "text/plain", data: await fileToBase64(f) })),
      );
      setDocFiles((prev) => [...prev, ...nextDocs]);
    }
    const skipped = list.length - nextImages.length - textish.slice(0, 5).length;
    if (skipped > 0) setRunError("Některé soubory jsem přeskočil — umím obrázky a textové dokumenty (txt, md, csv, json).");
  }

  const toolResultsById = useMemo(() => {
    const results = new Map<string, { content: string; isError?: boolean }>();
    for (const m of data?.messages ?? []) {
      for (const block of m.content) {
        if (block.type === "tool_result") results.set(block.toolUseId, { content: block.content, isError: block.isError });
      }
    }
    return results;
  }, [data?.messages]);

  const mood = isRunning ? "working" : data?.session.status === "awaiting_input" ? "thinking" : "idle";
  // The counter shows what the user actually sees — hidden tool-result plumbing excluded.
  const messageCount = (data?.messages ?? []).filter(isVisibleMessage).length;

  /** Consecutive tool-only assistant turns merge into one steps block (no more "N kroků" spam). Hidden tool-result messages are transparent to grouping. */
  const renderBlocks = useMemo(() => {
    const blocks: Array<{ key: string; messages: PersistedMessage[]; grouped: boolean }> = [];
    for (const m of data?.messages ?? []) {
      if (!isVisibleMessage(m)) continue;
      const last = blocks[blocks.length - 1];
      if (isToolOnlyAssistant(m) && last?.grouped) {
        last.messages.push(m);
      } else if (isToolOnlyAssistant(m)) {
        blocks.push({ key: m.id, messages: [m], grouped: true });
      } else {
        blocks.push({ key: m.id, messages: [m], grouped: false });
      }
    }
    return blocks;
  }, [data?.messages]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* top bar */}
      <header className="flex h-[60px] shrink-0 items-center gap-2 px-3 md:px-5">
        <button onClick={onToggleSidebar} className="pressable flex items-center gap-2 rounded-full border border-border bg-bg-raised py-2 pl-3 pr-4 text-[13px] font-[600] text-fg hover:bg-bg-hover">
          <span className="flex flex-col gap-[3px]">
            <span className="h-[2px] w-4 rounded bg-fg" />
            <span className="h-[2px] w-4 rounded bg-fg" />
            <span className="h-[2px] w-4 rounded bg-fg" />
          </span>
          Chaty
        </button>
        <button onClick={onOpenPreview} className={`pressable hidden items-center gap-2 rounded-full border py-2 pl-3 pr-4 text-[13px] font-[600] sm:flex ${previewActive ? "border-accent bg-accent-wash text-accent" : "border-border bg-bg-raised text-fg-muted hover:bg-bg-hover hover:text-fg"}`}>
          <MonitorUp size={14} />
          Otevřít náhled
        </button>
        <span className="flex-1" />
        <button onClick={onOpenAgent} title="Otevřít nastavení agenta" className="pressable flex items-center gap-2 rounded-full py-1 pl-1 pr-3 hover:bg-bg-hover">
          <AgentAvatar seed={agent.id} mood={mood} size={30} />
          <span className="text-[14px] font-[600] text-fg">{agent.name}</span>
          <span className={`h-2 w-2 rounded-full ${isRunning ? "bg-live pulse-live" : "bg-live"}`} title={isRunning ? "Pracuje" : "Připojeno"} />
        </button>
      </header>

      {/* messages */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto py-3">
        {renderBlocks.map((block) =>
          block.grouped ? (
            <GroupedSteps
              key={block.key}
              messages={block.messages}
              agentId={agent.id}
              toolResultsById={toolResultsById}
              sessionTitle={data?.session.title ?? ""}
              onOpenPreview={onOpenPreview}
            />
          ) : (
            <div key={block.key}>
              <MessageView message={block.messages[0]!} toolResultsById={toolResultsById} agentId={agent.id} />
              {block.messages[0]!.role === "assistant" && hasBrowserTools(block.messages[0]!) && (
                <BrowserCard title={truncate(firstText(block.messages[0]!.content) || data?.session.title || "", 48)} onOpen={onOpenPreview} />
              )}
              {block.messages[0]!.role === "assistant" && messageImages(block.messages[0]!).map((img, i) => (
                <ArtifactCard key={i} image={img} title={truncate(firstText(block.messages[0]!.content) || "Bez názvu", 40)} />
              ))}
            </div>
          ),
        )}
        {streamingText && (
          <div className="mx-auto flex w-full max-w-[760px] gap-2.5 px-4 py-2">
            <div className="mt-0.5 shrink-0"><AgentAvatar seed={agent.id} mood="speaking" size={30} /></div>
            <div className="min-w-0 flex-1 rounded-[20px] rounded-tl-[8px] border border-border bg-bg-raised px-4 py-3">
              <Markdown>{streamingText}</Markdown>
            </div>
          </div>
        )}
        {isRunning && !streamingText && (
          <div className="mx-auto flex w-full max-w-[760px] items-center gap-2 px-4 py-1.5">
            <AgentAvatar seed={agent.id} mood="working" size={24} />
            <span className="flex items-center gap-1.5 text-[12px] text-fg-muted">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" />
              {isPaused ? "pozastaveno — bude pokračovat" : "pracuje…"}
            </span>
            {!readOnly && (
              <span className="flex items-center gap-1">
                {isPaused ? (
                  <button onClick={() => pauseResume.mutate("resume")} className="pressable flex items-center gap-1 rounded-full border border-border bg-bg-raised px-2.5 py-1 text-[11.5px] font-[600] text-fg-muted hover:text-fg">
                    <Play size={11} /> Pokračovat
                  </button>
                ) : (
                  <button onClick={() => pauseResume.mutate("pause")} className="pressable flex items-center gap-1 rounded-full border border-border bg-bg-raised px-2.5 py-1 text-[11.5px] font-[600] text-fg-muted hover:text-fg">
                    <Pause size={11} /> Pozastavit
                  </button>
                )}
                <button onClick={() => void api.post(`/sessions/${sessionId}/stop`).catch(() => {})} className="pressable flex items-center gap-1 rounded-full border border-border bg-bg-raised px-2.5 py-1 text-[11.5px] font-[600] text-fg-muted hover:text-danger">
                  <Square size={10} /> Zastavit
                </button>
              </span>
            )}
          </div>
        )}
        {runError && (
          <div className="mx-auto flex w-full max-w-[760px] items-start gap-2.5 px-4 py-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger-wash text-danger"><TriangleAlert size={14} /></span>
            <div className="rounded-[16px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">
              <p className="font-[600]">Běh selhal</p>
              <p className="mono mt-0.5 text-[12px]">{runError}</p>
            </div>
          </div>
        )}
      </div>

      {/* run controls + pending states */}
      <div className="shrink-0 px-3 pb-3 md:px-5">
        <div className="mx-auto w-full max-w-[760px]">
          {data?.pendingTakeover && (
            <div className="mb-2 rounded-[16px] border border-warning/30 bg-warning-wash p-3.5">
              <p className="text-[13px] font-[600] text-fg">Agent potřebuje převzít obrazovku</p>
              <p className="mt-0.5 text-[12.5px] text-fg-muted">{data.pendingTakeover.reason}</p>
              <div className="mt-2.5 flex items-center gap-2">
                <button onClick={onOpenPreview} className="pressable rounded-full bg-accent px-4 py-1.5 text-[12.5px] font-[600] text-white">Převzít</button>
                <button onClick={() => doneTakeover.mutate()} className="pressable rounded-full border border-border bg-bg-raised px-4 py-1.5 text-[12.5px] font-[600] text-fg">Mám hotovo</button>
              </div>
            </div>
          )}

          {data?.pendingQuestion && data.session.status === "awaiting_input" && !readOnly && (
            <form onSubmit={submitAnswer} className="mb-2 rounded-[16px] border border-border bg-bg-raised p-3.5">
              <p className="flex items-center gap-2 text-[11px] font-[700] tracking-[0.06em] text-fg"><span className="h-2 w-2 rounded-full bg-live pulse-live" /> AGENT ČEKÁ NA ODPOVĚĎ</p>
              <p className="mt-1.5 text-[13.5px] text-fg">{data.pendingQuestion}</p>
              <div className="mt-2.5 flex items-center gap-2">
                <textarea value={answerText} onChange={(e) => setAnswerText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAnswer(e); } }} rows={2} autoFocus placeholder="Tvá odpověď…" className="max-h-[140px] w-full resize-none rounded-[14px] border border-border bg-bg-sunken px-3.5 py-2.5 text-[13.5px] text-fg placeholder:text-fg-subtle outline-none focus:border-accent" />
                <button type="submit" disabled={!answerText.trim() || answerQuestion.isPending} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white disabled:opacity-30"><ArrowUp size={16} /></button>
              </div>
            </form>
          )}

          {banner ? (
            <div className="rounded-full border border-border bg-bg-raised px-5 py-3 text-center text-[12.5px] text-fg-muted">{banner}</div>
          ) : !readOnly && (
            <form
              onSubmit={onSubmit}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); void onFiles(e.dataTransfer.files); }}
              className="relative rounded-[24px] border border-border bg-bg-raised p-2 shadow-sm focus-within:border-border-strong"
            >
              {showJumpToBottom && (
                <button type="button" onClick={jumpToBottom} title="Skočit dolů" className="absolute -top-12 right-3 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-bg-raised text-fg-muted shadow-md hover:text-fg">
                  <ArrowDown size={15} />
                </button>
              )}
              {messageCount > 0 && (
                <button type="button" onClick={jumpToBottom} title="Počet zpráv — skočit dolů" className="absolute -top-8 left-1/2 -translate-x-1/2 rounded-full bg-bg-sunken/90 px-2.5 py-0.5 text-[11px] font-[600] text-fg-muted hover:text-fg">
                  {messageCount} {messageCount === 1 ? "zpráva" : messageCount < 5 ? "zprávy" : "zpráv"} ⌄
                </button>
              )}
              {images.length > 0 && (
                <div className="flex flex-wrap gap-2 px-2 pt-1">
                  {images.map((img, i) => (
                    <div key={i} className="group relative">
                      <img src={`data:${img.mimeType};base64,${img.data}`} className="h-14 w-14 rounded-[12px] border border-border object-cover" />
                      <button type="button" onClick={() => setImages((p) => p.filter((_, idx) => idx !== i))} className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-bg-raised text-fg-muted opacity-0 group-hover:opacity-100"><X size={11} /></button>
                    </div>
                  ))}
                </div>
              )}
              {docFiles.length > 0 && (
                <div className="flex flex-wrap gap-2 px-2 pt-1">
                  {docFiles.map((f, i) => (
                    <span key={i} className="mono flex items-center gap-1.5 rounded-full border border-border bg-bg-sunken px-3 py-1 text-[11px] text-fg-muted">
                      <Paperclip size={11} /> {f.name}
                      <button type="button" onClick={() => setDocFiles((p) => p.filter((_, idx) => idx !== i))} className="text-fg-subtle hover:text-fg"><X size={11} /></button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-1.5">
                <input type="file" accept="image/*,.txt,.md,.markdown,.csv,.json,.log,.ts,.js,.py" multiple onChange={(e) => void onFiles(e.target.files)} className="hidden" id={`file-input-${sessionId}`} />
                <IconButton type="button" title="Přiložit soubor" onClick={() => document.getElementById(`file-input-${sessionId}`)?.click()} className="mb-0.5"><Paperclip size={16} /></IconButton>
                <textarea
                  ref={textareaRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={onKeyDown}
                  onPaste={(e) => void onFiles(e.clipboardData.files)}
                  placeholder={title ? `Zpráva — ${title}` : "Zpráva"}
                  rows={1}
                  className="max-h-[140px] min-h-[40px] w-full resize-none bg-transparent px-2 py-2.5 text-[14px] leading-6 text-fg placeholder:text-fg-subtle outline-none"
                />
                <button type="submit" disabled={!text && images.length === 0 && docFiles.length === 0} title="Odeslat" className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-white disabled:opacity-30"><ArrowUp size={16} strokeWidth={2.2} /></button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export function BrowserCard({ title, onOpen }: { title: string; onOpen: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 py-1">
      <div className="ml-[34px] flex items-center gap-2">
        <Globe size={13} className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-muted">Prohlížeč · {title}</span>
        <button onClick={onOpen} className="pressable shrink-0 text-[12px] font-[600] text-accent hover:underline">
          Náhled
        </button>
      </div>
    </div>
  );
}

/** One steps block for a run of consecutive tool-only assistant turns. */
export function GroupedSteps({
  messages,
  agentId,
  toolResultsById,
  sessionTitle,
  onOpenPreview,
}: {
  messages: PersistedMessage[];
  agentId: string;
  toolResultsById: Map<string, { content: string; isError?: boolean }>;
  sessionTitle: string;
  onOpenPreview: () => void;
}) {
  const steps: ToolStep[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") steps.push({ id: b.id, name: b.name, input: b.input, result: toolResultsById.get(b.id) });
    }
  }
  const showBrowser = messages.some(hasBrowserTools);
  const images = messages.flatMap(messageImages);
  return (
    <div className="mx-auto flex w-full max-w-[760px] gap-2 px-4 py-1.5">
      <div className="mt-0.5 shrink-0">
        <AgentAvatar seed={agentId} size={24} />
      </div>
      <div className="min-w-0 flex-1">
        <details className="group px-0.5 py-1">
          <summary className="cursor-pointer list-none text-[11.5px] font-[600] text-fg-subtle marker:hidden hover:text-fg-muted">
            {steps.length} {steps.length === 1 ? "krok" : steps.length < 5 ? "kroky" : "kroků"} ▸
          </summary>
          <div className="mt-1"><ToolStepChecklist steps={steps} /></div>
        </details>
        {showBrowser && <BrowserCard title={truncate(sessionTitle, 48)} onOpen={onOpenPreview} />}
        {images.map((img, i) => (
          <ArtifactCard key={i} image={img} title={truncate(sessionTitle || "Bez názvu", 40)} />
        ))}
      </div>
    </div>
  );
}

export function ArtifactCard({ image, title }: { image: { mimeType: string; data: string }; title: string }) {
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 py-1.5">
      <div className="ml-[34px] overflow-hidden rounded-[16px] border border-border bg-bg-raised">
        <img src={`data:${image.mimeType};base64,${image.data}`} alt={title} className="max-h-64 w-full object-cover" />
        <div className="flex items-center gap-2.5 p-3.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-bg-sunken text-fg-muted"><ImageIcon size={16} /></span>
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-[600] text-fg">{title}</p>
            <p className="text-[12px] text-fg-muted">Artefakt</p>
          </div>
        </div>
      </div>
    </div>
  );
}
