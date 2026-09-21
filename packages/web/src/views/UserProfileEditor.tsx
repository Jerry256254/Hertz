import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { Agent } from "../lib/types";
import { AgentAvatar, avatarVersionOf } from "../components/AgentAvatar";
import { Markdown } from "../components/Markdown";

/**
 * USER.md editor — the agent's permanent picture of its human: name, how to
 * address them, what they like, boundaries. Stored in agents.user_profile,
 * injected into the system prompt on every turn, and self-maintained by the
 * agent via the update_user_profile tool as it learns from conversation.
 * Events and work facts belong to memory, not here.
 */
export function UserProfileEditor({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState(false);

  const save = useMutation({
    mutationFn: (userProfile: string) => api.patch(`/agents/${agent.id}`, { userProfile }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      setTimeout(() => setSaved(false), 2000);
      void queryClient.invalidateQueries({ queryKey: ["agent"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Uložení selhalo"),
  });

  const value = text ?? agent.userProfile ?? "";
  const dirty = value !== (agent.userProfile ?? "");

  function askClose() {
    if (dirty && !window.confirm("Máš neuložené změny. Opravdu zavřít bez uložení?")) return;
    onClose();
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-[60px] shrink-0 items-center gap-2.5 px-3 md:px-5">
        <AgentAvatar seed={agent.id} version={avatarVersionOf(agent)} size={30} />
        <h1 className="text-[15px] font-[700] text-fg">USER.md — obraz uživatele</h1>
        <span className="flex-1" />
        <button onClick={() => setPreview((v) => !v)} className={`pressable rounded-full px-4 py-2 text-[12.5px] font-[600] ${preview ? "bg-bg-sunken text-fg" : "text-fg-muted hover:text-fg"}`}>
          {preview ? "Upravit" : "Náhled"}
        </button>
        {dirty && (
          <button onClick={() => save.mutate(value)} disabled={save.isPending} className="pressable inline-flex min-h-[44px] items-center rounded-full bg-accent px-4 py-2 text-[13px] font-[600] text-white disabled:opacity-40">
            {save.isPending ? "Ukládám…" : saved ? "Uloženo" : "Uložit"}
          </button>
        )}
        {saved && !dirty && <span className="text-[13px] font-[600] text-live">Uloženo</span>}
        <button onClick={askClose} title="Zavřít" aria-label="Zavřít" className="pressable flex h-10 w-10 items-center justify-center rounded-full text-fg-muted hover:bg-bg-sunken hover:text-fg">
          <X size={16} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 md:px-5">
        <div className="mx-auto w-full max-w-[760px]">
          <p className="border-l-2 border-accent pl-3 text-[13px] italic leading-relaxed text-fg-muted">
            Trvalý obraz tvého člověka očima agenta: jméno, jak ho oslovovat, co má rád, kde jsou hranice. Agent ho sám doplňuje z konverzace a chová se podle něj při každém tahu. Události a fakta z práce patří do paměti, ne sem.
          </p>
          {error && <p className="mb-3 mt-4 rounded-[14px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">{error}</p>}

          {preview ? (
            <div className="mt-4 rounded-[20px] border border-border bg-bg-raised p-5">
              <Markdown>{value || "*Zatím prázdné — agent profil doplní, jakmile se o tobě něco dozví.*"}</Markdown>
            </div>
          ) : (
            <textarea
              value={value}
              onChange={(e) => setText(e.target.value)}
              placeholder={"# Uživatel\n- Jméno: \n- Oslovení: \n- Co má rád: \n- Hranice: "}
              rows={16}
              className="mt-4 w-full resize-y rounded-[20px] border border-border bg-bg-raised p-5 text-[14px] leading-relaxed text-fg placeholder:text-fg-subtle outline-none focus:border-accent"
            />
          )}
        </div>
      </div>
    </div>
  );
}
