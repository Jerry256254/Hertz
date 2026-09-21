import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Plus, Trash2, X } from "lucide-react";
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

/** Šířka (px), od které se seznam a detail vejdou vedle sebe. */
const TWO_COLUMN_MIN_WIDTH = 560;

/**
 * Skutečná šířka prvku měřená ResizeObserverem. Rozhoduje o layoutu —
 * viewportové breakpointy tu lžou, protože panel má vlastní (užší) šířku.
 */
function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/**
 * Skills tab of the agent settings — the agent's durable procedures.
 * The agent reads these before acting (and updates them itself via
 * save_skill); the user can view, create, edit and delete them here.
 *
 * Layout: na úzkém kontejneru (< 560 px) se po tapnutí na dovednost otevře
 * detail jako fullscreen overlay se šipkou Zpět; na širokém kontejneru je
 * klasický dvousloupec seznam vlevo / detail vpravo.
 */
export function SkillsEditor({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ref: measureRef, width } = useMeasuredWidth<HTMLDivElement>();
  const wide = width >= TWO_COLUMN_MIN_WIDTH;

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
    if (window.confirm(`Opravdu smazat dovednost „${name}"? Agent na ten postup zapomene.`)) remove.mutate(name);
  }

  function select(name: string) {
    setSelected(name);
    setError(null);
  }

  function goBack() {
    setSelected(null);
    setError(null);
  }

  const showOverlay = !!selected && !creating && !editing && !wide;

  return (
    <div>
      <p className="border-l-2 border-accent pl-3 text-[13px] italic leading-relaxed text-fg-muted">
        Postupy, podle kterých agent pracuje — nemusí je hledat ani si je pamatovat. Řídí se jimi automaticky,
        sám si je tvoří a opravuje; tady je vidíš a můžeš je upravit i ty.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <h1 className="text-[22px] font-[700]">Dovednosti</h1>
        <span className="flex-1" />
        <button
          onClick={() => { setCreating(true); setEditing(false); setSelected(null); setError(null); }}
          className="pressable flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-[600] text-white"
        >
          <Plus size={14} /> Nová dovednost
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
        <div ref={measureRef} className="mt-3">
          {wide ? (
            <div className="grid grid-cols-[248px_minmax(0,1fr)] gap-4">
              <SkillList
                skills={skills}
                selected={selected}
                loading={indexLoading}
                loadError={indexError}
                onSelect={select}
              />
              <div>
                {fileLoading ? (
                  <p className="rounded-[20px] border border-border bg-bg-raised p-5 py-8 text-center text-[13.5px] text-fg-subtle">Načítám dovednost…</p>
                ) : !selected || !file ? (
                  <p className="rounded-[20px] border border-border bg-bg-raised p-5 py-8 text-center text-[13.5px] text-fg-subtle">Vyber dovednost ze seznamu.</p>
                ) : (
                  <SkillDetail file={file} onEdit={() => setEditing(true)} onDelete={askDelete} />
                )}
              </div>
            </div>
          ) : (
            <SkillList
              skills={skills}
              selected={selected}
              loading={indexLoading}
              loadError={indexError}
              onSelect={select}
            />
          )}
        </div>
      )}

      {/* Úzký kontejner (mobil): detail jako fullscreen overlay se šipkou Zpět. */}
      {showOverlay && (
        <div className="fixed inset-0 z-50 flex flex-col bg-bg" role="dialog" aria-modal="true" aria-label={`Dovednost ${selected}`}>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-2">
            <button
              onClick={goBack}
              aria-label="Zpět na seznam dovedností"
              className="pressable flex min-h-[44px] items-center gap-2 rounded-full px-3 text-[13.5px] font-[600] text-fg hover:bg-bg-sunken"
            >
              <ArrowLeft size={16} /> Zpět na seznam
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-4">
            {fileLoading ? (
              <p className="py-8 text-center text-[13.5px] text-fg-subtle">Načítám dovednost…</p>
            ) : file ? (
              <SkillDetail file={file} onEdit={() => setEditing(true)} onDelete={askDelete} />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function SkillList({ skills, selected, loading, loadError, onSelect }: {
  skills: SkillIndexEntry[];
  selected: string | null;
  loading: boolean;
  loadError: boolean;
  onSelect: (name: string) => void;
}) {
  return (
    <div className="space-y-2">
      {loading && <p className="p-4 text-[13px] text-fg-subtle">Načítám dovednosti…</p>}
      {loadError && <p className="rounded-[16px] border border-danger/25 bg-danger-wash p-4 text-[13px] text-danger">Seznam dovedností se nepodařilo načíst.</p>}
      {!loading && !loadError && skills.length === 0 && (
        <p className="rounded-[16px] border border-dashed border-border p-4 text-[13px] text-fg-subtle">
          Zatím žádné dovednosti. Agent si je začne tvořit sám — nebo přidej první.
        </p>
      )}
      {skills.map((s) => (
        <button
          key={s.name}
          onClick={() => onSelect(s.name)}
          className={`pressable w-full rounded-[16px] border p-3.5 text-left ${selected === s.name ? "border-accent bg-accent-wash/40" : "border-border bg-bg-raised"}`}
        >
          <p className="mono text-[13px] font-[700] text-fg">{s.name}</p>
          <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-fg-muted">{s.description}</p>
        </button>
      ))}
    </div>
  );
}

function SkillDetail({ file, onEdit, onDelete }: {
  file: SkillFile;
  onEdit: () => void;
  onDelete: (name: string) => void;
}) {
  return (
    <div className="min-w-0 rounded-[20px] border border-border bg-bg-raised p-5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="mono text-[15px] font-[700] text-fg">{file.name}</p>
          <p className="mt-0.5 text-[13px] text-fg-muted">{file.description}</p>
        </div>
        {file.isDefault && (
          <span className="shrink-0 rounded-full border border-border bg-bg-sunken px-2.5 py-1 text-[11px] font-[600] text-fg-muted">výchozí</span>
        )}
        <button onClick={onEdit} title="Upravit" aria-label="Upravit dovednost" className="pressable rounded-full p-2 text-fg-muted hover:bg-bg-sunken hover:text-fg"><Pencil size={15} /></button>
        <button onClick={() => onDelete(file.name)} title="Smazat" aria-label="Smazat dovednost" className="pressable rounded-full p-2 text-fg-muted hover:bg-danger-wash hover:text-danger"><Trash2 size={15} /></button>
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
        <p className="text-[15px] font-[700] text-fg">{initial ? `Upravit „${initial.name}"` : "Nová dovednost"}</p>
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
          <p className="mb-1.5 text-[11px] font-[700] tracking-[0.06em] text-fg-subtle">KDY JI POUŽÍT (jedna věta)</p>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="K čemu je dovednost dobrá, jedna věta" className={inputCls} />
        </div>
        <div>
          <p className="mb-1.5 text-[11px] font-[700] tracking-[0.06em] text-fg-subtle">POSTUP (Markdown — přesné kroky, příkazy, cesty)</p>
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={10} className={`${inputCls} mono resize-y leading-relaxed`} />
        </div>
        <div>
          <p className="mb-1.5 text-[11px] font-[700] tracking-[0.06em] text-fg-subtle">VOLITELNÝ SKRIPT (script.sh)</p>
          <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={4} placeholder="#!/bin/bash" className={`${inputCls} mono resize-y`} />
        </div>
        <div className="flex gap-2">
          <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim() || !description.trim() || !instructions.trim()} className="pressable rounded-full bg-accent px-5 py-2 text-[13px] font-[600] text-white disabled:opacity-40">
            {save.isPending ? "Ukládám…" : "Uložit dovednost"}
          </button>
          <button onClick={onCancel} className="pressable rounded-full border border-border bg-bg-sunken px-5 py-2 text-[13px] font-[600] text-fg">Zrušit</button>
        </div>
      </div>
    </div>
  );
}
