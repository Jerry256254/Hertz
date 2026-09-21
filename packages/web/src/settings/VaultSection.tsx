import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { VaultCredential } from "../lib/types";

const inputCls = "h-11 w-full rounded-full border border-border bg-bg-raised px-4 text-[13.5px] text-fg outline-none focus:border-accent disabled:opacity-50";

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-4">
      <p className="mb-1.5 text-[12px] font-[600] text-fg-muted">{label}</p>
      {children}
      {hint && <p className="mt-1 text-[12px] leading-snug text-fg-subtle">{hint}</p>}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric" });
}

/**
 * Trezor — úložiště přihlašovacích údajů. Agent vidí jen metadata (služba,
 * název, uživatelské jméno); heslo se posílá jen na server, šifruje se
 * hlavním klíčem a nikdy se nezobrazuje zpět. Použití údaje agentem vždy
 * vyžaduje tvoje schválení.
 */
export function VaultSection() {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [service, setService] = useState("");
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["vault"],
    queryFn: () => api.get<{ credentials: VaultCredential[] }>("/vault"),
    retry: false,
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["vault"] });
  }

  function resetForm() {
    setShowAdd(false);
    setService("");
    setLabel("");
    setUsername("");
    setSecret("");
    setNote("");
    setErr(null);
  }

  const create = useMutation({
    mutationFn: () =>
      api.post<VaultCredential>("/vault", {
        service: service.trim(),
        label: label.trim(),
        username: username.trim(),
        secret,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      resetForm();
      refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setErr(e instanceof ApiError ? e.message : "Uložení selhalo");
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/vault/${id}`),
    onSuccess: () => {
      setErr(null);
      refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setErr(e instanceof ApiError ? e.message : "Smazání selhalo");
    },
  });

  if (forbidden) {
    return <p className="max-w-[520px] text-[13px] leading-relaxed text-fg-muted">Trezor může spravovat jen administrátor.</p>;
  }

  const credentials = data?.credentials ?? [];

  return (
    <div className="max-w-[560px]">
      <p className="mb-4 text-[13px] leading-relaxed text-fg-muted">
        Přihlašovací údaje, které si agent umí vyžádat na přihlášení. Hesla se ukládají šifrovaně a nikdy se nezobrazují —
        ani tobě, ani agentovi. Každé použití agentem musíš schválit.
      </p>
      {isLoading && <p className="text-[13px] text-fg-subtle">Načítám…</p>}
      {err && <p className="mb-3 rounded-[14px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">{err}</p>}

      {!isLoading && credentials.length === 0 && !showAdd && (
        <p className="mb-2 text-[13px] text-fg-subtle">Zatím tu nic není. Přidej první údaj tlačítkem níže.</p>
      )}

      {credentials.map((c) => (
        <div key={c.id} className="mb-2 flex items-center gap-3 rounded-[16px] border border-border bg-bg-raised px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-wash text-accent"><KeyRound size={15} /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-[600] text-fg">{c.label} <span className="font-[400] text-fg-muted">· {c.service}</span></p>
            <p className="mono truncate text-[12px] text-fg-muted">{c.username}{c.note ? ` · ${c.note}` : ""}</p>
            <p className="text-[11.5px] text-fg-subtle">přidáno {formatDate(c.createdAt)}</p>
          </div>
          <button
            onClick={() => { if (window.confirm(`Opravdu smazat údaj „${c.label}" (${c.service})? Agent ho přestane moct používat.`)) remove.mutate(c.id); }}
            title="Smazat"
            className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-sunken hover:text-danger"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}

      {showAdd ? (
        <div className="mt-3 space-y-2.5 rounded-[16px] border border-accent/40 bg-bg-raised p-4">
          <Field label="Služba" hint="Kam se údajem přihlašuješ, např. github.com.">
            <input value={service} onChange={(e) => setService(e.target.value)} placeholder="např. github.com" className={inputCls} autoComplete="off" />
          </Field>
          <Field label="Název" hint="Rozlišení více účtů u jedné služby, např. osobní.">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="např. osobní účet" className={inputCls} autoComplete="off" />
          </Field>
          <Field label="Uživatelské jméno">
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="např. jan.novak" className={inputCls} autoComplete="username" />
          </Field>
          <Field label="Heslo" hint="Odešle se jen na server, zašifruje se a už nikdy se nezobrazí.">
            <input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" placeholder="…" className={inputCls} autoComplete="new-password" />
          </Field>
          <Field label="Poznámka (nepovinná)">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="např. k čemu účet je" className={inputCls} autoComplete="off" />
          </Field>
          <div className="flex gap-2">
            <button
              onClick={() => create.mutate()}
              disabled={create.isPending || !service.trim() || !label.trim() || !username.trim() || !secret}
              className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40"
            >
              {create.isPending ? "Ukládám…" : "Uložit do trezoru"}
            </button>
            <button onClick={resetForm} className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full border border-border bg-bg-sunken px-5 py-2 text-[13px] font-[600] text-fg">Zrušit</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} className="pressable mt-3 flex min-h-[44px] items-center gap-2 rounded-full border border-border bg-bg-raised px-5 py-2.5 text-[13.5px] font-[600] text-fg hover:bg-bg-hover">
          <Plus size={15} /> Přidat údaj
        </button>
      )}
    </div>
  );
}
