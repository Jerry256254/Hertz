import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { Agent } from "../lib/types";
import { Markdown } from "../components/Markdown";

interface SkillIndexEntry {
  name: string;
  description: string;
}

interface SkillFile {
  name: string;
  description: string;
  body: string;
  script: string | null;
  isDefault: boolean;
}

/**
 * Skills tab of the agent settings — the agent's durable procedures.
 * The agent reads these before acting (and updates them itself via
 * save_skill); the user can view, create, edit and delete them here.
 */
export function SkillsEditor({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: indexData, isLoading: indexLoading, isError: indexError } = useQuery({
    queryKey: ["skills", agent.id],
    queryFn: () => api.get<{ skills: SkillIndexEntry[] }>(`/agents/${agent.id}/skills`),
  });
  const skills = indexData?.skills ?? [];

  const { data: fileData, isLoading: fileLoading } = useQuery({
    queryKey: ["skill", agent.id, selected],
    queryFn: () => api.get<{ skill: SkillFile }>(`/agents/${agent.id}/skills/${selected}`),
    enabled: !!selected && !creating,
  });
  const file = fileData?.skill ?? null;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["skills", agent.id] });
    if (selected) void queryClient.invalidateQueries({ queryKey: ["skill", agent.id, selected] });
  };

  const remove = useMutation({
    mutationFn: (name: string) => api.delete(`/agents/${agent.id}/skills/${name}`),
    onSuccess: () => {
      setSelected(null);
      setEditing(false);
      setError(null);
      invalidate();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Smazání selhalo"),
  });

  function askDelete(name: string) {
    if (window.confirm(`Opravdu smazat skill „${name}"? Agent na ten postup zapomene.`)) remove.mutate(name);
  }

  return (
    <div>
      <p className="border-l-2 border-accent pl-3 text-[13px] italic leading-relaxed text-fg-muted">
        Postupy, podle kterých agent pracuje — nemusí je hledat ani si je pamatovat. Řídí se jimi automaticky,
        sám si je tvoří a opravuje; tady je vidíš a můžeš je upravit i ty.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <h1 className="text-[22px] font-[700]">Skills</h1>
        <span className="flex-1" />
        <button
          onClick={() => { setCreating(true); setEditing(false); setSelected(null); setError(null); }}
          className="pressable flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-[600] text-white"
        >
          <Plus size={14} /> Nový skill
        </button>
      </div>
      {error && <p className="mt-3 rounded-[14px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">{error}</p>}

      {creating ? (
        <SkillForm
          agentId={agent.id}
          initial={null}
          onDone={(name) => { setCreating(false); setSelected(name); invalidate(); }}
          onCancel={() => setCreating(false)}
        />
      ) : editing && file ? (
        <SkillForm
          agentId={agent.id}
          initial={file}
          onDone={() => { setEditing(false); invalidate(); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-[240px_1fr]">
          <div className="space-y-2">
            {indexLoading && <p className="p-4 text-[13px] text-fg-subtle">Načítám skilly…</p>}
            {indexError && <p className="rounded-[16px] border border-danger/25 bg-danger-wash p-4 text-[13px] text-danger">Seznam skillů se nepodařilo načíst.</p>}
            {!indexLoading && !indexError && skills.length === 0 && (
              <p className="rounded-[16px] border border-dashed border-border p-4 text-[13px] text-fg-subtle">
                Zatím žádné skilly. Agent si je začne tvořit sám — nebo přidej první.
              </p>
            )}
            {skills.map((s) => (
              <button
                key={s.name}
                onClick={() => { setSelected(s.name); setError(null); }}
                className={`pressable w-full rounded-[16px] border p-3.5 text-left ${selected === s.name ? "border-accent bg-accent-wash/40" : "border-border bg-bg-raised"}`}
              >
                <p className="mono text-[13px] font-[700] text-fg">{s.name}</p>
                <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-fg-muted">{s.description}</p>
              </button>
            ))}
          </div>

          <div className="min-w-0 rounded-[20px] border border-border bg-bg-raised p-5">
            {fileLoading ? (
              <p className="py-8 text-center text-[13.5px] text-fg-subtle">Načítám skill…</p>
            ) : !selected || !file ? (
              <p className="py-8 text-center text-[13.5px] text-fg-subtle">Vyber skill ze seznamu.</p>
            ) : (
              <>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="mono text-[15px] font-[700] text-fg">{file.name}</p>
                    <p className="mt-0.5 text-[13px] text-fg-muted">{file.description}</p>
                  </div>
                  {file.isDefault && (
                    <span className="shrink-0 rounded-full border border-border bg-bg-sunken px-2.5 py-1 text-[11px] font-[600] text-fg-muted">výchozí</span>
                  )}
                  <button onClick={() => setEditing(true)} title="Upravit" className="pressable rounded-full p-2 text-fg-muted hover:bg-bg-sunken hover:text-fg"><Pencil size={15} /></button>
                  <button onClick={() => askDelete(file.name)} title="Smazat" className="pressable rounded-full p-2 text-fg-muted hover:bg-danger-wash hover:text-danger"><Trash2 size={15} /></button>
                </div>
                <div className="mt-3 border-t border-border pt-3">
                  <Markdown>{file.body}</Markdown>
                </div>
                {file.script && (
                  <div className="mt-3">
                    <p className="mb-1.5 text-[11px] font-[700] tracking-[0.06em] text-fg-subtle">SCRIPT.SH</p>
                    <pre className="mono overflow-x-auto rounded-[14px] border border-border bg-bg-sunken p-3 text-[12px] text-fg">{file.script}</pre>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SkillForm({ agentId, initial, onDone, onCancel }: {
  agentId: string;
  initial: SkillFile | null;
  onDone: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [instructions, setInstructions] = useState(initial?.body ?? "");
  const [script, setScript] = useState(initial?.script ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.put(`/agents/${agentId}/skills/${encodeURIComponent(name.trim())}`, {
        description: description.trim(),
        instructions: instructions.trim(),
        ...(script.trim() ? { script: script } : {}),
      }),
    onSuccess: () => onDone(name.trim()),
    onError: (err) => setError(err instanceof ApiError ? err.message : "Uložení selhalo"),
  });

  const inputCls = "w-full rounded-[14px] border border-border bg-bg-sunken px-3.5 py-2.5 text-[13.5px] text-fg outline-none focus:border-accent";

  return (
    <div className="mt-3 rounded-[20px] border border-border bg-bg-raised p-5">
      <div className="flex items-center gap-2">
        <p className="text-[15px] font-[700] text-fg">{initial ? `Upravit „${initial.name}"` : "Nový skill"}</p>
        <span className="flex-1" />
        <button onClick={onCancel} title="Zavřít" className="pressable rounded-full p-2 text-fg-muted hover:bg-bg-sunken hover:text-fg"><X size={15} /></button>
      </div>
      {error && <p className="mt-3 rounded-[14px] border border-danger/25 bg-danger-wash px-4 py-2.5 text-[13px] text-danger">{error}</p>}
      <div className="mt-3 space-y-3">
        <div>
          <p className="mb-1.5 text-[11px] font-[700] tracking-[0.06em] text-fg-subtle">NÁZEV (malá písmena, pomlčky)</p>
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={!!initial} placeholder="např. tydenni-report" className={`${inputCls} mono disabled:opacity-60`} />
        </div>
        <div>
          <p className="mb-1.5 text-[11px] font-[700] tracking-[0.06em] text-fg-subtle">KDY HO POUŽÍT (jedna věta)</p>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="K čemu je skill dobrý, jedna věta" className={inputCls} />
        </div>
        <div>
          <p className="mb-1.5 text-[11px] font-[700] tracking-[0.06em] text-fg-subtle">POSTUP ( Markdown — přesné kroky, příkazy, cesty)</p>
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={10} className={`${inputCls} mono resize-y leading-relaxed`} />
        </div>
        <div>
          <p className="mb-1.5 text-[11px] font-[700] tracking-[0.06em] text-fg-subtle">VOLITELNÝ SKRIPT (script.sh)</p>
          <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={4} placeholder="#!/bin/bash" className={`${inputCls} mono resize-y`} />
        </div>
        <div className="flex gap-2">
          <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim() || !description.trim() || !instructions.trim()} className="pressable rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40">
            {save.isPending ? "Ukládám…" : "Uložit skill"}
          </button>
          <button onClick={onCancel} className="pressable rounded-full border border-border bg-bg-sunken px-5 py-2 text-[13px] font-[600] text-fg">Zrušit</button>
        </div>
      </div>
    </div>
  );
}
