import { ShieldCheck } from "lucide-react";
import { ApprovalCard, ApprovalHistoryRow, useApprovals } from "../panels/Approvals";

/** Full-page approvals inbox (icon-rail module). */
export function ApprovalsView() {
  const { data, isLoading, isError, refetch } = useApprovals();
  const approvals = data?.approvals ?? [];
  const pending = approvals.filter((a) => a.status === "pending");
  const history = approvals.filter((a) => a.status !== "pending");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="safe-top flex h-14 shrink-0 items-center gap-3 px-3 sm:h-[60px] md:px-5">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-warning-wash text-warning"><ShieldCheck size={18} /></span>
        <div>
          <p className="text-[16px] font-[700] tracking-[-0.02em] text-fg">Schválení</p>
          <p className="text-[12px] text-fg-muted">
            {pending.length === 0 ? "Nic nečeká na rozhodnutí" : `${pending.length} ${pending.length === 1 ? "žádost čeká" : pending.length < 5 ? "žádosti čekají" : "žádostí čeká"} na rozhodnutí`}
          </p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 md:px-5">
        <div className="mx-auto w-full max-w-[760px] space-y-5">
          {isLoading && <p className="py-8 text-center text-[13px] text-fg-subtle">Načítám…</p>}
          {isError && (
            <div className="rounded-[20px] border border-danger/30 bg-danger-wash p-5 text-center">
              <p className="text-[13.5px] font-[600] text-fg">Schválení se nepodařilo načíst.</p>
              <button onClick={() => refetch()} className="pressable mt-3 inline-flex min-h-[44px] items-center rounded-full bg-danger px-4 py-2 text-[13px] font-[600] text-white">
                Zkusit znovu
              </button>
            </div>
          )}
          {!isLoading && !isError && pending.length > 0 && (
            <section className="space-y-2.5">
              <p className="text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">ČEKÁ NA ROZHODNUTÍ</p>
              {pending.map((a) => <ApprovalCard key={a.id} approval={a} />)}
            </section>
          )}
          <section>
            <p className="mb-1 text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">HISTORIE SCHVÁLENÍ</p>
            {!isError && history.length === 0 && !isLoading && <p className="py-2 text-[13px] text-fg-subtle">Zatím žádná historie.</p>}
            {history.map((a) => <ApprovalHistoryRow key={a.id} approval={a} />)}
          </section>
        </div>
      </div>
    </div>
  );
}
