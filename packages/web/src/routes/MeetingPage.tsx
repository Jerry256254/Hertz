import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, TriangleAlert, Video } from "lucide-react";
import { api } from "../lib/api";
import type { Agent, Meeting, MeetingMessage } from "../lib/types";
import { ROLE_LABEL } from "../lib/types";
import { subscribeToMeeting } from "../lib/ws-client";
import { Markdown } from "../components/Markdown";
import { Avatar } from "../components/ui";

interface MeetingDetail {
  meeting: Meeting;
  participants: Agent[];
  messages: MeetingMessage[];
  running: boolean;
}

export function MeetingPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [typingAgent, setTypingAgent] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data } = useQuery({
    queryKey: ["meeting", meetingId],
    queryFn: () => api.get<MeetingDetail>(`/meetings/${meetingId}`),
  });

  useEffect(() => {
    if (data) setIsRunning(data.running);
  }, [data]);

  useEffect(() => {
    if (!meetingId) return;
    const unsubscribe = subscribeToMeeting(meetingId, (event) => {
      if (event.type === "turn_started") {
        setTypingAgent(event.agentName);
      } else if (event.type === "message") {
        setTypingAgent(undefined);
        void queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
      } else if (event.type === "error") {
        setError(event.message);
      } else if (event.type === "done") {
        setIsRunning(false);
        setTypingAgent(undefined);
        void queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
      }
    });
    return unsubscribe;
  }, [meetingId, queryClient]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [data?.messages.length, typingAgent]);

  const participantById = new Map((data?.participants ?? []).map((a) => [a.id, a]));

  async function send() {
    if (!text || isRunning) return;
    setIsRunning(true);
    setError(undefined);
    const payload = { text };
    setText("");
    await api.post(`/meetings/${meetingId}/messages`, payload);
    void queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
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

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 flex-shrink-0 items-center gap-3 border-b border-border px-6">
        <Video size={15} className="text-accent" />
        <span className="truncate text-sm font-medium text-fg">{data?.meeting.title}</span>
        <div className="ml-auto flex -space-x-2">
          {data?.participants.map((a) => (
            <div key={a.id} title={`${a.name} — ${ROLE_LABEL[a.role]}`} className="ring-2 ring-bg">
              <Avatar label={a.name} tone={a.role === "manager" ? "accent" : "neutral"} />
            </div>
          ))}
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-6">
        {data?.messages.map((m) => {
          const speaker = m.senderAgentId ? participantById.get(m.senderAgentId) : undefined;
          const isUser = !m.senderAgentId;
          return (
            <div key={m.id} className={`mx-auto flex w-full max-w-3xl gap-3 px-4 py-3 ${isUser ? "justify-end" : ""}`}>
              {!isUser && <Avatar label={speaker?.name ?? "?"} tone="accent" />}
              <div className={isUser ? "max-w-[80%] rounded-lg bg-accent-wash px-4 py-2.5" : "min-w-0 flex-1"}>
                {!isUser && (
                  <p className="mb-1 text-xs font-medium text-fg-muted">
                    {speaker?.name ?? "Former teammate"}
                    {speaker && <span className="text-fg-subtle"> · {ROLE_LABEL[speaker.role]}</span>}
                  </p>
                )}
                {isUser ? (
                  m.content.map((b, i) => b.type === "text" && <p key={i} className="text-sm text-fg">{b.text}</p>)
                ) : (
                  m.content.map((b, i) => b.type === "text" && <Markdown key={i}>{b.text}</Markdown>)
                )}
              </div>
            </div>
          );
        })}
        {typingAgent && (
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3">
            <Avatar label={typingAgent} tone="accent" />
            <span className="text-xs text-fg-muted">{typingAgent} is responding…</span>
          </div>
        )}
        {error && (
          <div className="mx-auto flex w-full max-w-3xl items-start gap-2.5 px-4 py-3">
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-danger-wash">
              <TriangleAlert size={14} className="text-danger" />
            </span>
            <div className="rounded-lg bg-danger-wash px-3 py-2 text-sm text-danger">{error}</div>
          </div>
        )}
      </div>

      <div className="flex-shrink-0 px-4 pb-4">
        <form
          onSubmit={onSubmit}
          className="mx-auto max-w-3xl rounded-2xl border border-border bg-bg-raised p-2 shadow-sm focus-within:border-border-strong"
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={isRunning ? "Waiting for the room…" : "Speak in the meeting — Enter to send"}
            disabled={isRunning}
            rows={1}
            className="max-h-[200px] w-full resize-none border-0 bg-transparent px-2 py-1.5 text-sm text-fg placeholder:text-fg-subtle outline-none disabled:opacity-60"
          />
          <div className="flex items-center justify-end px-1 pt-1">
            <button
              type="submit"
              disabled={isRunning || !text}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity disabled:opacity-30"
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
