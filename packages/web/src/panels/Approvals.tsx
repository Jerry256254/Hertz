import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileWarning, HardDrive, ShieldCheck, X } from "lucide-react";
import { api } from "../lib/api";
import type { ApprovalItem, HostAccessOp, HostAccessPayload, HostAccessResult } from "../lib/types";
import { relTime } from "../lib/format";

export function useApprovals() {
  return useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<{ approvals: ApprovalItem[] }>("/approvals"),
    refetchInterval: 5000,
  });
}

export function parsePayload(raw: string | null): HostAccessPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<HostAccessPayload>;
    if (p.op !== "read" && p.op !== "rewrite" && p.op !== "create" && p.op !== "delete") return null;
    if (typeof p.hostPath !== "string" || typeof p.reason !== "string") return null;
    return p as HostAccessPayload;
  } catch {
    return null;
  }
}

export function parseResult(raw: string | null): HostAccessResult | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HostAccessResult;
  } catch {
    return null;
  }
}

const OP_META: Record<HostAccessOp, { label: string; cls: string }> = {
  read: { label: "čtení", cls: "bg-info-wash text-info border-info/25" },
  rewrite: { label: "přepsání", cls: "bg-warning-wash text-warning border-warning/25" },
  create: { label: "vytvoření", cls: "bg-success-wash text-success border-success/25" },
  delete: { label: "smazání", cls: "bg-danger-wash text-danger border-danger/25" },
};

export function ApprovalCard({ approval, compact = false }: { approval: ApprovalItem; compact?: boolean }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (decision: "approved" | "rejected") =>
      api.post(`/approvals/${approval.id}/decision`, { decision }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Rozhodnutí se nepodařilo uložit"),
  });

  const isHostAccess = approval.kind === "host_access";
  const payload = isHostAccess ? parsePayload(approval.payload) : null;
  const result = parseResult(approval.result);
  const pending = approval.status === "pending";
  const opMeta = payload ? OP_META[payload.op] : null;

  return (
    <div className={`rounded-[16px] border bg-bg-raised p-3.5 ${pending ? "border-accent/40" : "border-border"}`}>
      <div className="flex items-start gap-2.5">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${isHostAccess ? "bg-warning-wash text-warning" : "bg-accent-wash text-accent"}`}>
          {isHostAccess ? <HardDrive size={16} /> : <ShieldCheck size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {payload && opMeta && (
              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-[700] ${opMeta.cls}`}>
                {opMeta.label}
              </span>
            )}
            <p className="text-[13.5px] font-[600] leading-snug text-fg">{approval.summary}</p>
          </div>
          <p className="mt-1 text-[12px] text-fg-muted">
            {approval.agentName} · {relTime(approval.createdAt)}
            {!pending && approval.decidedByEmail && (
              <> · {approval.status === "approved" ? "povolil" : "zamítl"} {approval.decidedByEmail}</>
            )}
            {!pending && !approval.decidedByEmail && (
              <> · {approval.status === "approved" ? "Povoleno" : "Zamítnuto"}</>
            )}
          </p>
        </div>
        {!pending && (
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${approval.status === "approved" ? "bg-success-wash text-success" : "bg-danger-wash text-danger"}`}>
            {approval.status === "approved" ? <Check size={14} /> : <X size={14} />}
          </span>
        )}
      </div>

      {payload && (
        <div className="mt-2.5 space-y-2">
          <p className="mono break-all rounded-[12px] bg-bg-sunken px-3 py-2 text-[12px] text-fg">{payload.hostPath}</p>
          <div className="rounded-[12px] border border-border bg-bg-sunken/60 px-3 py-2">
            <p className="text-[11px] font-[700] tracking-[0.05em] text-fg-subtle">PROČ TO AGENT CHCE</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{payload.reason}</p>
          </div>
          {(payload.op === "rewrite" || payload.op === "create") && payload.content !== undefined && !compact && (
            <details className="rounded-[12px] border border-border">
              <summary className="cursor-pointer px-3 py-2 text-[12px] font-[600] text-fg-muted">
                Zobrazit obsah ({payload.content.length} znaků)
              </summary>
              <pre className="mono max-h-48 overflow-auto border-t border-border px-3 py-2 text-[11.5px] leading-relaxed text-fg-muted">{payload.content.slice(0, 8000)}</pre>
            </details>
          )}
        </div>
      )}

      {!isHostAccess && approval.detail && !compact && (
        <p className="mt-2 whitespace-pre-wrap rounded-[12px] bg-bg-sunken/60 px-3 py-2 text-[12.5px] leading-relaxed text-fg-muted">{approval.detail}</p>
      )}

      {result && (
        <div className={`mt-2.5 rounded-[12px] border px-3 py-2 ${result.ok ? "border-success/25 bg-success-wash" : "border-danger/25 bg-danger-wash"}`}>
          <p className={`text-[11px] font-[700] tracking-[0.05em] ${result.ok ? "text-success" : "text-danger"}`}>
            VÝSLEDEK PROVEDENÍ {result.bytes !== undefined && `· ${result.bytes} B`}
          </p>
          {result.output && <pre className="mono mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-fg">{result.output.slice(0, 6000)}</pre>}
          {result.error && <p className="mono mt-1 text-[12px] text-danger">{result.error}</p>}
        </div>
      )}

      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}

      {pending && (
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => decide.mutate("approved")}
            disabled={decide.isPending}
            className="pressable min-h-[44px] flex-1 rounded-full bg-accent py-2 text-[13px] font-[600] text-white hover:bg-accent-hover disabled:opacity-40"
          >
            Povolit
          </button>
          <button
            onClick={() => decide.mutate("rejected")}
            disabled={decide.isPending}
            className="pressable min-h-[44px] flex-1 rounded-full border border-border bg-bg-sunken py-2 text-[13px] font-[600] text-fg hover:bg-bg-hover disabled:opacity-40"
          >
            Zamítnout
          </button>
        </div>
      )}
    </div>
  );
}

/** Compact history row (approval-history look from the mockups). */
export function ApprovalHistoryRow({ approval }: { approval: ApprovalItem }) {
  const payload = approval.kind === "host_access" ? parsePayload(approval.payload) : null;
  return (
    <div className="flex items-start gap-3 rounded-[14px] px-2 py-2.5 hover:bg-bg-sunken/50">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-fg-muted">
        {approval.kind === "host_access" ? <HardDrive size={15} /> : <FileWarning size={15} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-[600] text-fg">{approval.summary}</p>
        <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-fg-muted">
          {payload ? `${payload.op} ${payload.hostPath} — ${payload.reason}` : approval.detail || approval.sessionTitle}
        </p>
        <p className="mt-0.5 text-[11.5px] text-fg-subtle">
          {approval.status === "approved" ? "Povoleno" : approval.status === "rejected" ? "Zamítnuto" : "Čeká"} · {relTime(approval.decidedAt ?? approval.createdAt)}
        </p>
      </div>
    </div>
  );
}
