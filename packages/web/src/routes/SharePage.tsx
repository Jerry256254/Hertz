import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Markdown } from "../components/Markdown";
import { Avatar } from "../components/ui";
import { AgentAvatar } from "../components/AgentAvatar";

interface SharedBlock {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
}

interface SharedMessage {
  role: string;
  content: SharedBlock[];
  createdAt: string;
}

interface SharedChat {
  title: string;
  agentName: string;
  projectName: string | null;
  sharedAt: string;
  messages: SharedMessage[];
}

/** Public read-only transcript — no login required. */
export function SharePage() {
  const { token } = useParams<{ token: string }>();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["share-public", token],
    queryFn: () => api.get<SharedChat>(`/share/${token}`),
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-bg text-sm text-fg-muted">Načítám sdílený chat…</div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-bg px-4 text-center">
        <p className="text-base font-semibold text-fg">Odkaz neplatí</p>
        <p className="max-w-sm text-sm text-fg-muted">Tenhle sdílený chat neexistuje, nebo ho majitel zrušil.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-[720px] px-4 py-8">
        <header className="mb-6 border-b border-border pb-4">
          <div className="mb-2 flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center bg-fg text-bg-raised">
              <span className="mono text-[10px] font-[700]">H</span>
            </div>
            <span className="mono text-[10px] font-[700] tracking-[0.18em] text-fg-subtle">HERTZ · SDÍLENÝ CHAT</span>
          </div>
          <div className="flex items-center gap-3">
            <AgentAvatar seed={data.agentName} size={40} animate={false} />
            <div className="min-w-0">
              <h1 className="text-lg font-[700] tracking-[-0.02em] text-fg">{data.title}</h1>
              <p className="mono mt-1 text-[11px] text-fg-subtle">
                {data.agentName}
                {data.projectName ? ` · ${data.projectName}` : ""} · sdíleno {new Date(data.sharedAt).toLocaleString()}
              </p>
            </div>
          </div>
        </header>
        <div className="space-y-4">
          {data.messages.map((m, i) => (
            <div key={i} className="flex gap-3">
              {m.role === "user" ? (
                <Avatar label="Ty" />
              ) : (
                <AgentAvatar seed={data.agentName} size={32} animate={false} />
              )}
              <div className="min-w-0 flex-1">
                <p className="mono mb-1 text-[10px] font-[700] tracking-[0.1em] text-fg-subtle">
                  {m.role === "user" ? "TY" : data.agentName.toUpperCase()}
                </p>
                <div className="space-y-2">
                  {m.content.map((b, j) =>
                    b.type === "image" && b.data ? (
                      <img
                        key={j}
                        src={`data:${b.mimeType ?? "image/png"};base64,${b.data}`}
                        alt="příloha"
                        className="max-h-80 rounded-md border border-border"
                      />
                    ) : b.type === "text" && b.text ? (
                      <div key={j} className="rounded-lg border border-border bg-bg-raised px-3 py-2.5">
                        <Markdown>{b.text}</Markdown>
                      </div>
                    ) : null,
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        <footer className="mono mt-8 border-t border-border pt-4 text-center text-[11px] text-fg-subtle">
          Vytvořeno v Hertz — self-hosted AI workspace
        </footer>
      </div>
    </div>
  );
}
