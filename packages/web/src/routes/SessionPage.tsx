import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, Files, Link2Off, Monitor, Paperclip, Pause, Play, Settings, Share2, Square, TriangleAlert, X, Hash } from "lucide-react";
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
    const t = value.trim();
    if (t && t !== title) rename.mutate(t);
    else setValue(title);
  }
  if (editing) {
    return (
      <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.currentTarget.select()} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setValue(title); setEditing(false); }}} className="h-7 max-w-xs text-sm" />
    );
  }
  return (
    <button onClick={() => setEditing(true)} className="truncate rounded-[6px] px-1 -mx-1 mono text-[12px] font-[600] tracking-[-0.01em] text-fg hover:bg-bg-sunken" title="Klikni pro přejmenování">
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
  const [docFiles, setDocFiles] = useState<Array<{ name: string; mimeType: string; data: string }>>([]);
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
    const el = scrollRef.current; if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottomRef.current = nearBottom;
    setShowJumpToBottom(!nearBottom);
  }
  function jumpToBottom() { stickToBottomRef.current = true; setShowJumpToBottom(false); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }

  const { data } = useQuery({ queryKey: ["session", sessionId], queryFn: () => api.get<SessionDetail>(`/sessions/${sessionId}`) });

  useEffect(() => { if (data) { setIsRunning(data.running); setIsPaused(data.paused); } }, [data]);

  useEffect(() => {
    if (!sessionId) return;
    const unsub = subscribeToSession(sessionId, (event) => {
      if (event.type === "text_delta") setStreamingText((p) => p + event.text);
      else if (event.type === "message_saved") { setStreamingText(""); void queryClient.invalidateQueries({ queryKey: ["session", sessionId] }); void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] }); }
      else if (event.type === "status") { setIsRunning(event.status === "running"); setIsPaused(event.status === "paused"); if (event.status === "running") setRunError(undefined); if (event.status !== "running") setStreamingText(""); }
      else if (event.type === "awaiting_input") { setStreamingText(""); void queryClient.invalidateQueries({ queryKey: ["session", sessionId] }); }
      else if (event.type === "error") setRunError(event.message);
      else if (event.type === "done") { setIsRunning(false); setIsPaused(false); void queryClient.invalidateQueries({ queryKey: ["session", sessionId] }); void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] }); }
    });
    return unsub;
  }, [sessionId, queryClient]);

  useEffect(() => { const el = scrollRef.current; if (!el || !stickToBottomRef.current) return; el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }, [data?.messages.length, streamingText, isRunning]);

  useEffect(() => { const el = textareaRef.current; if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 180)}px`; }, [text]);

  async function send() {
    if (!text && images.length === 0 && docFiles.length === 0) return;
    if (text.trim() === "/compact") {
      setIsRunning(true); setRunError(undefined); setText("");
      try { await api.post(`/sessions/${sessionId}/compact`); } catch (err) { setRunError(err instanceof ApiError ? err.message : "Nešlo zkompaktnout"); } finally { setIsRunning(false); void queryClient.invalidateQueries({ queryKey: ["session", sessionId] }); }
      return;
    }
    const payload = { text, images, files: docFiles, mode };
    setText(""); setImages([]); setDocFiles([]);
    try { await api.post(`/sessions/${sessionId}/messages`, payload); } catch (err) { setRunError(err instanceof ApiError ? err.message : "Zprávu se nepodařilo odeslat"); setText(payload.text); setImages(payload.images); setDocFiles(payload.files); return; }
    void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
  }

  const pauseResume = useMutation({
    mutationFn: (action: "pause" | "resume") => api.post(`/sessions/${sessionId}/${action}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["session", sessionId] }),
    onError: (err) => setRunError(err instanceof ApiError ? err.message : "Nešlo změnit stav"),
  });

  const agentIdForScreen = data?.agent?.id ?? data?.session.agentId ?? "";

  function openScreen(agentId: string) {
    const win = window.open("about:blank", "_blank");
    api.get<{ token: string }>(`/agents/${agentId}/screen/token`).then(({ token }) => {
      const url = `/screen/${agentId}?t=${encodeURIComponent(token)}`;
      if (win && !win.closed) win.location.href = url; else window.open(url, "_blank");
    }).catch((err: unknown) => {
      if (win && !win.closed) win.close();
      setRunError(err instanceof ApiError ? err.message : "Obrazovku nešlo otevřít — desktop možná ještě startuje. Zkus za chvíli.");
    });
  }

  const doneTakeover = useMutation({ mutationFn: () => api.post(`/agents/${data?.session.agentId ?? agentIdForScreen}/takeover/done`), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["session", sessionId] }) });
  const answerQuestion = useMutation({
    mutationFn: (answer: string) => api.post(`/sessions/${sessionId}/answer`, { text: answer }),
    onSuccess: () => { setAnswerText(""); setIsRunning(true); void queryClient.invalidateQueries({ queryKey: ["session", sessionId] }); },
    onError: (err) => setRunError(err instanceof ApiError ? err.message : "Odpověď se nepodařilo odeslat"),
  });
  function submitAnswer(e: FormEvent) { e.preventDefault(); if (!answerText.trim()) return; answerQuestion.mutate(answerText); }
  function onSubmit(e: FormEvent) { e.preventDefault(); void send(); }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }
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
  const activeAgentId = useMemo(() => {
    if (!data) return undefined;
    if (data.session.kind !== "conversation") return data.session.agentId;
    const last = [...data.messages].reverse().find((m) => m.senderAgentId);
    if (!last) return data.session.agentId;
    return last.senderAgentId === data.session.agentId ? data.session.peerAgentId ?? data.session.agentId : data.session.agentId;
  }, [data]);
  const activeAgentName = activeAgentId ? (senderNames[activeAgentId] ?? "H") : "H";
  const toolResultsById = useMemo(() => {
    const results = new Map<string, { content: string; isError?: boolean }>();
    for (const m of data?.messages ?? []) for (const block of m.content) if (block.type === "tool_result") results.set(block.toolUseId, { content: block.content, isError: block.isError });
    return results;
  }, [data?.messages]);

  return (
    <div className={`grid min-h-0 flex-1 grid-cols-1 grid-rows-1 ${showFiles || showScreen ? "md:grid-cols-[1fr_360px]" : "md:grid-cols-[1fr_0px]"}`}>
      <div className="flex min-w-0 flex-col bg-bg">
        {/* header — paper ledger */}
        <header className="flex h-[48px] shrink-0 items-center justify-between gap-2 border-b border-border bg-bg-raised px-3 md:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            {data?.agent ? (
              <>
                <Avatar label={data.agent.name} mascot={data.agent.mascot} />
                <div className="min-w-0 leading-none">
                  <p className="truncate text-[13px] font-[650] tracking-[-0.015em] text-fg">{data.agent.name}</p>
                  <p className="mono mt-0.5 truncate text-[10px] font-[600] tracking-[0.06em] text-fg-subtle">
                    {isRunning ? "PRACUJE…" : data.session.status === "awaiting_input" ? "ČEKÁ NA TEBE" : "ONLINE"} {isPaused ? "· POZASTAVENO" : ""}
                  </p>
                </div>
                {data.session.kind === "conversation" && <span className="hidden rounded-full border border-border bg-bg-sunken px-2 py-1 mono text-[10px] font-[600] tracking-[0.06em] text-fg-muted md:inline-flex">PŘÍMÝ CHAT</span>}
              </>
            ) : data ? <EditableTitle sessionId={sessionId!} title={data.session.title} /> : <span className="mono text-[12px] text-fg-subtle">Načítám…</span>}
          </div>

          <div className="flex items-center gap-1.5">
            {data?.pendingTakeover && (
              <span className="hidden items-center gap-1.5 rounded-full border border-fg bg-fg px-2.5 py-1 text-[11px] font-[600] tracking-[-0.01em] text-bg-raised md:flex">
                Převzetí
                <button className="underline decoration-bg-raised/30 underline-offset-2" onClick={() => void openScreen(data.agent?.id ?? data.session.agentId)}>Otevřít</button>
                <button className="rounded-full bg-bg-raised px-2 py-0.5 text-fg" onClick={() => doneTakeover.mutate()}>Hotovo</button>
              </span>
            )}
            {isRunning && <IconButton title="Pozastavit" onClick={() => pauseResume.mutate("pause")} className="border border-border bg-bg-raised"><Pause size={14} /></IconButton>}
            {isPaused && <IconButton title="Pokračovat" onClick={() => pauseResume.mutate("resume")} className="border border-border bg-bg-raised"><Play size={14} /></IconButton>}
            {isRunning && <IconButton title="Zastavit" className="border border-border bg-bg-raised" onClick={() => api.post(`/sessions/${sessionId}/stop`)}><Square size={13} /></IconButton>}
            {budget && budget.used > 0 && (
              <div className="hidden items-center gap-2 border-l border-border pl-3 md:flex">
                <div className="h-1 w-20 overflow-hidden rounded-full bg-bg-sunken"><div className="h-full bg-fg transition-[width] duration-300" style={{ width: `${Math.min(100, budget.percent)}%` }} /></div>
                <span className="mono text-[11px] font-[500] tracking-wide text-fg-subtle">{budget.used.toLocaleString()} tok</span>
              </div>
            )}
            <span className="hidden h-6 w-px bg-border md:block" />
            <IconButton title="Obrazovka" onClick={() => { setShowScreen((v) => !v); setShowFiles(false); }} className={showScreen ? "bg-fg text-bg-raised border-fg" : "border border-border bg-bg-raised"}><Monitor size={14} /></IconButton>
            <IconButton title="Soubory" onClick={() => { setShowFiles((v) => !v); setShowScreen(false); }} className={showFiles ? "bg-fg text-bg-raised border-fg" : "border border-border bg-bg-raised"}><Files size={14} /></IconButton>
            {data?.agent && projectId && <IconButton title="Nastavení bota" onClick={() => navigate(`/projects/${projectId}/agents/${data.agent!.id}`)} className="border border-border bg-bg-raised"><Settings size={14} /></IconButton>}
            {sessionId && <ShareButton sessionId={sessionId} />}
          </div>
        </header>

        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto bg-bg py-4">
          {data?.messages.map((m) => (
            <MessageView key={m.id} message={m} toolResultsById={toolResultsById} senderNames={senderNames} senderMascots={senderMascots} />
          ))}
          {streamingText && (
            <div className="mx-auto flex w-full max-w-[720px] gap-3 px-4 py-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-border text-[11px] font-[700]" style={activeAgentId ? { backgroundColor: agentColor(activeAgentId), color: "#fff", borderColor: "transparent" } : undefined}>{activeAgentName.slice(0, 1).toUpperCase()}</span>
              <div className="min-w-0 flex-1 rounded-[12px] border border-border bg-bg-raised px-3 py-2.5"><Markdown>{streamingText}</Markdown></div>
            </div>
          )}
          {isRunning && !streamingText && (
            <div className="mx-auto flex w-full max-w-[720px] items-center gap-3 px-4 py-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-border text-[11px] font-[700]" style={activeAgentId ? { backgroundColor: agentColor(activeAgentId), color: "#fff", borderColor: "transparent" } : undefined}>{activeAgentName.slice(0, 1).toUpperCase()}</span>
              <span className="flex items-center gap-1 rounded-full border border-border bg-bg-raised px-3 py-1.5">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" />
                <span className="mono text-[11px] font-[500] tracking-wide text-fg-muted">{isPaused ? "pozastaveno — bude pokračovat" : "pracuje…"}</span>
              </span>
            </div>
          )}
          {runError && (
            <div className="mx-auto flex w-full max-w-[720px] items-start gap-2.5 px-4 py-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-danger/20 bg-danger-wash text-danger"><TriangleAlert size={14} /></span>
              <div className="rounded-[10px] border border-danger/20 bg-danger-wash px-3 py-2 text-[12.5px] leading-relaxed text-danger"><p className="font-[650]">Běh selhal</p><p className="mono mt-0.5 text-[12px]">{runError}</p></div>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-border bg-bg px-3 py-3 md:px-4">
          {data?.pendingTakeover && (
            <div className="mx-auto mb-3 w-full max-w-[720px]">
              <div className="rounded-[12px] border border-fg bg-fg p-3">
                <div className="mb-2 flex items-center gap-2"><span className="rounded-full bg-bg-raised px-2 py-0.5 mono text-[10px] font-[700] tracking-[0.08em] text-fg">⚡ VYŽADUJE AKCI</span><span className="mono text-[11px] font-[600] tracking-[-0.01em] text-bg-raised">Převzít obrazovku bota</span></div>
                <p className="mb-3 mono text-[12px] leading-relaxed text-bg-raised/80">{data.pendingTakeover.reason}</p>
                <div className="flex items-center gap-2"><Button variant="secondary" size="sm" className="bg-bg-raised" onClick={() => void openScreen(data.agent?.id ?? data.session.agentId)}>Převzít</Button><Button variant="ghost" size="sm" className="text-bg-raised hover:bg-white/10" onClick={() => doneTakeover.mutate()}>Mám hotovo</Button></div>
              </div>
            </div>
          )}

          {data?.pendingQuestion && data.session.status === "awaiting_input" && (
            <form onSubmit={submitAnswer} className="mx-auto mb-3 max-w-[720px] rounded-[12px] border border-fg bg-bg-raised p-3 shadow-sm">
              <p className="flex items-center gap-2 mono text-[10px] font-[700] tracking-[0.08em] text-fg"><span className="h-1.5 w-1.5 rounded-full bg-live pulse-live" /> AGENT ČEKÁ NA ODPOVĚĎ</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-fg">{data.pendingQuestion}</p>
              <div className="mt-2.5 flex items-center gap-2">
                <textarea value={answerText} onChange={(e) => setAnswerText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAnswer(e); }}} rows={2} autoFocus placeholder="Tvá odpověď…" className="max-h-[140px] w-full resize-none rounded-[8px] border border-border bg-bg px-2.5 py-2 text-[13px] text-fg placeholder:text-fg-subtle outline-none focus:border-fg" />
                <button type="submit" disabled={!answerText.trim() || answerQuestion.isPending} className="flex h-9 w-9 shrink-0 items-center justify-center bg-fg text-bg-raised disabled:opacity-30"><ArrowUp size={16} /></button>
              </div>
            </form>
          )}

          <form
            onSubmit={onSubmit}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); void onFiles(e.dataTransfer.files); }}
            className="relative mx-auto flex max-w-[720px] flex-col gap-2 rounded-[14px] border border-border bg-bg-raised p-2 shadow-xs focus-within:border-fg focus-within:shadow-sm"
          >
            {showJumpToBottom && (
              <button type="button" onClick={jumpToBottom} title="Skočit dolů" className="absolute -top-11 right-2 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-bg-raised text-fg-muted shadow-md hover:bg-bg-sunken hover:text-fg">
                <ArrowDown size={14} />
              </button>
            )}
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2 px-1 pt-1">
                {images.map((img, i) => (
                  <div key={i} className="group relative">
                    <img src={`data:${img.mimeType};base64,${img.data}`} className="h-14 w-14 rounded-[8px] border border-border object-cover" />
                    <button type="button" onClick={() => setImages((p) => p.filter((_, idx) => idx !== i))} className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-bg-raised text-fg-muted opacity-0 shadow-xs group-hover:opacity-100"><X size={11} /></button>
                  </div>
                ))}
              </div>
            )}
            {docFiles.length > 0 && (
              <div className="flex flex-wrap gap-2 px-1 pt-1">
                {docFiles.map((f, i) => (
                  <span key={i} className="mono flex items-center gap-1.5 rounded-[8px] border border-border bg-bg-sunken px-2 py-1 text-[11px] text-fg-muted">
                    📎 {f.name}
                    <button type="button" onClick={() => setDocFiles((p) => p.filter((_, idx) => idx !== i))} className="text-fg-subtle hover:text-fg"><X size={11} /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => { setText(e.target.value); const el = e.target as HTMLTextAreaElement; el.style.height = "24px"; el.style.height = Math.min(el.scrollHeight, 140) + "px"; }}
                onKeyDown={onKeyDown}
                onPaste={(e) => void onFiles(e.clipboardData.files)}
                placeholder={data?.pendingQuestion && data.session.status === "awaiting_input" ? "Odpověz agentovi…" : isPaused ? "Pozastaveno — pokračuj tlačítkem" : `Napiš ${data?.agent?.name ?? "agentovi"}…`}
                rows={1}
                className="max-h-[140px] min-h-[24px] w-full resize-none border-0 bg-transparent px-2 py-1.5 text-[13.5px] leading-6 text-fg placeholder:text-fg-subtle outline-none"
              />
              <div className="flex shrink-0 items-center gap-1">
                <input type="file" accept="image/*,.txt,.md,.markdown,.csv,.json,.log,.ts,.js,.py" multiple onChange={(e) => void onFiles(e.target.files)} className="hidden" id="file-input" />
                <IconButton type="button" onClick={() => document.getElementById("file-input")?.click()} className="h-8 w-8 rounded-[10px] border border-border bg-bg-sunken"><Paperclip size={14} /></IconButton>
                <button type="submit" disabled={!text && images.length === 0} className="flex h-8 w-8 shrink-0 items-center justify-center bg-fg text-bg-raised disabled:opacity-30"><ArrowUp size={15} strokeWidth={2} /></button>
              </div>
            </div>
            <div className="flex items-center gap-1.5 px-1">
              <span className="mono text-[10px] font-[500] tracking-wide text-fg-faint"><Hash size={10} className="inline" /> {data?.session.title ?? ""}</span>
              <span className="ml-auto mono hidden text-[10px] tracking-wide text-fg-faint md:inline">↵ odeslat · ⇧↵ nový řádek · /compact zhustit</span>
            </div>
          </form>
        </div>
      </div>

      {showScreen && agentIdForScreen && (
        <div className="fixed inset-0 z-20 flex flex-col bg-bg md:static md:z-auto md:min-h-0 md:flex-col md:overflow-y-auto md:border-l md:border-border md:bg-bg-sunken">
          <ScreenPanel agentId={agentIdForScreen} agentName={data?.agent?.name ?? "Bot"} />
        </div>
      )}
      {showFiles && projectId && (
        <div className="fixed inset-0 z-20 flex flex-col bg-bg md:static md:z-auto">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-bg-raised px-3 md:hidden">
            <span className="mono text-[11px] font-[700] tracking-[0.08em] text-fg">SOUBORY</span>
            <IconButton title="Zavřít" onClick={() => setShowFiles(false)}><X size={16} /></IconButton>
          </div>
          <div className="min-h-0 flex-1 bg-bg-raised"><FileExplorer projectId={projectId} /></div>
        </div>
      )}
    </div>
  );
}

function ScreenPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const { data: status } = useQuery({ queryKey: ["screen", agentId], queryFn: () => api.get<{ running: boolean; tunnelUrl?: string | null }>(`/agents/${agentId}/screen/status`), refetchInterval: 5000 });
  async function openViewer() { const { token } = await api.get<{ token: string }>(`/agents/${agentId}/screen/token`); setIframeUrl(`/screen/${agentId}?t=${encodeURIComponent(token)}`); }
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="overflow-hidden rounded-[12px] border border-border bg-bg-raised">
        <div className="flex items-center justify-between border-b border-border bg-bg-sunken px-3 py-2">
          <p className="mono text-[10px] font-[700] tracking-[0.08em] text-fg-muted">{agentName.toUpperCase()} — OBRAZOVKA</p>
          <Badge tone={status?.running ? "live" : "neutral"}>{status?.running ? "živě" : "vypnuto"}</Badge>
        </div>
        <div className="p-2">
          {iframeUrl ? <iframe title="Agent screen" src={iframeUrl} className="aspect-[16/10] w-full rounded-[8px] border border-border" /> : <button onClick={() => void openViewer()} className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-2 rounded-[8px] border border-dashed border-border bg-bg-sunken text-fg-subtle hover:border-fg hover:text-fg"><Monitor size={22} /><span className="mono text-[11px] font-[600] tracking-wide">Otevřít náhled</span></button>}
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => void api.post(`/agents/${agentId}/screen/start`)}>{status?.running ? "Restartovat" : "Spustit desktop"}</Button>
            {iframeUrl && <Button size="sm" variant="ghost" onClick={() => window.open(iframeUrl, "_blank")}>Vyskočit</Button>}
          </div>
        </div>
      </div>
      <AgentRoutines agentId={agentId} />
    </div>
  );
}

function ShareButton({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const { data } = useQuery({
    queryKey: ["share", sessionId],
    queryFn: () => api.get<{ token: string | null }>(`/sessions/${sessionId}/share`),
  });

  async function copyLink(token: string) {
    const url = `${window.location.origin}/s/${token}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Zkopíruj odkaz:", url);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function ensureAndCopy() {
    if (data?.token) return copyLink(data.token);
    try {
      const created = await api.post<{ token: string }>(`/sessions/${sessionId}/share`);
      void queryClient.invalidateQueries({ queryKey: ["share", sessionId] });
      await copyLink(created.token);
    } catch {
      /* error surfaces via global handler */
    }
  }

  async function revoke() {
    if (!window.confirm("Zrušit veřejný odkaz na tuto konverzaci?")) return;
    await api.delete(`/sessions/${sessionId}/share`);
    void queryClient.invalidateQueries({ queryKey: ["share", sessionId] });
  }

  return (
    <span className="flex items-center gap-1.5">
      <IconButton
        title={data?.token ? "Kopírovat veřejný odkaz" : "Vytvořit veřejný odkaz"}
        onClick={() => void ensureAndCopy()}
        className={data?.token ? "border-fg bg-fg text-bg-raised" : "border border-border bg-bg-raised"}
      >
        {copied ? <Check size={14} /> : <Share2 size={14} />}
      </IconButton>
      {data?.token && (
        <IconButton title="Zrušit veřejný odkaz" onClick={() => void revoke()} className="border border-border bg-bg-raised">
          <Link2Off size={14} />
        </IconButton>
      )}
    </span>
  );
}

function AgentRoutines({ agentId }: { agentId: string }) {
  const { projectId } = useParams<{ projectId: string; sessionId: string }>();
  const { data } = useQuery({ queryKey: ["routines", projectId], queryFn: () => api.get<{ routines: Array<{ id: string; title: string; schedule: string; enabled: boolean; agentId: string }> }>(`/projects/${projectId}/routines`), enabled: !!projectId });
  const mine = (data?.routines ?? []).filter((r) => r.agentId === agentId);
  return (
    <div className="rounded-[12px] border border-border bg-bg-raised p-3">
      <p className="mono mb-2 text-[10px] font-[700] tracking-[0.08em] text-fg-subtle">RUTINY</p>
      {mine.length === 0 ? <p className="mono text-[11px] leading-relaxed text-fg-subtle">Opakované úkoly, které bot plní podle plánu — zadej mu je v chatu.</p> : <ul className="space-y-1.5">{mine.map((r) => <li key={r.id} className="rounded-[8px] border border-border bg-bg-sunken px-2.5 py-2"><p className="flex items-center gap-1.5 text-[12px] font-[600] tracking-[-0.01em] text-fg"><Clock size={11} className="text-fg-subtle" /> {r.title}</p><p className="mono text-[11px] text-fg-subtle">{r.schedule}</p></li>)}</ul>}
    </div>
  );
}
