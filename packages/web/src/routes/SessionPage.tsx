import { useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Budget, HertzSession, PersistedMessage } from "../lib/types";
import { subscribeToSession } from "../lib/ws-client";
import { MessageView } from "../components/MessageView";

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

export function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [images, setImages] = useState<Array<{ mimeType: string; data: string }>>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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
      } else if (event.type === "status") {
        setIsRunning(event.status === "running");
      } else if (event.type === "done") {
        setIsRunning(false);
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      }
    });
    return unsubscribe;
  }, [sessionId, queryClient]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [data?.messages.length, streamingText]);

  async function onSend(e: FormEvent) {
    e.preventDefault();
    if (!text && images.length === 0) return;
    setIsRunning(true);
    await api.post(`/sessions/${sessionId}/messages`, { text, images });
    setText("");
    setImages([]);
    void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
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
    <div className="flex h-full flex-col">
      <div className="flex h-8 flex-shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-xs text-fg-muted">{data?.session.title}</span>
        {budget && (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-32 overflow-hidden rounded bg-bg-sunken">
              <div
                className="h-full bg-accent"
                style={{ width: `${Math.min(100, budget.percent)}%` }}
              />
            </div>
            <span className="font-mono text-xs text-fg-muted">{budget.used.toLocaleString()} tok</span>
          </div>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {data?.messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        {streamingText && (
          <div className="border-b border-border px-4 py-3">
            <div className="mb-1 text-xs font-semibold text-fg-muted">agent</div>
            <p className="whitespace-pre-wrap text-sm">{streamingText}</p>
          </div>
        )}
        {isRunning && !streamingText && (
          <div className="px-4 py-3 text-xs text-fg-muted">thinking…</div>
        )}
      </div>

      <form
        onSubmit={onSend}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void onFiles(e.dataTransfer.files);
        }}
        className="flex-shrink-0 border-t border-border p-3"
      >
        {images.length > 0 && (
          <div className="mb-2 flex gap-2">
            {images.map((img, i) => (
              <img
                key={i}
                src={`data:${img.mimeType};base64,${img.data}`}
                className="h-12 w-12 rounded border border-border object-cover"
              />
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => void onFiles(e.clipboardData.files)}
            placeholder={isRunning ? "Agent is working…" : "Message the agent — drop or paste images"}
            disabled={isRunning}
            rows={2}
            className="flex-1 resize-none rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-50"
          />
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => void onFiles(e.target.files)}
            className="hidden"
            id="file-input"
          />
          <label htmlFor="file-input" className="cursor-pointer rounded border border-border px-2 py-1.5 text-xs text-fg-muted hover:text-fg">
            + image
          </label>
          <button
            type="submit"
            disabled={isRunning}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
