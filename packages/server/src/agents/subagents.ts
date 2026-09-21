import { and, eq, or } from "drizzle-orm";
import type { AgentLoopManager, PersistencePort, SubagentSummary } from "@kuclab-hertz/core";
import type { ContentBlock } from "@kuclab-hertz/providers";
import { newId, type Database } from "../db/client.js";
import { jobs, sessions } from "../db/schema.js";
import type { JobQueue } from "../queue/job-queue.js";

/**
 * Army of subagents (WORK PACKAGE 10).
 *
 * The main agent delegates background work to isolated subagents that run in
 * parallel while it stays responsive in chat. Each subagent is a full agent
 * session of its own (own conversation, own sandbox bundle, own job), spawned
 * with the SAME agentId as the parent — so it inherits exactly the parent's
 * permissions, project and approval flow, and can never escalate beyond them.
 * The parent only ever receives the final summary (completion handoff), never
 * the child's whole transcript.
 *
 * Inspired by the Hermes agent's delegation model (MIT, Nous Research):
 * an `output_schema` JSON-Schema contract the child sees up front, plus one
 * bounded correction turn when the output does not validate.
 */

export type SubagentStatus = "pending" | "running" | "done" | "failed" | "interrupted";

/** Tools a subagent must never have: no nesting, no direct line to the human. */
export const SUBAGENT_EXCLUDED_TOOLS = ["spawn_subagent", "ask_user"] as const;

/** Default cap on simultaneously running subagents (env-overridable). */
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 4;

export interface SubagentSpawnInput {
  task: string;
  label?: string;
  /** Extra background the child should know; inherited context stays with the parent. */
  context?: string;
  /** JSON Schema the child's final output must satisfy (the Hermes contract). */
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
}

export interface SubagentRecord extends SubagentSummary {
  parentSessionId: string;
  childSessionId: string;
  agentId: string;
  projectId: string;
  userId: string;
  task: string;
  context?: string;
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  correctionUsed: boolean;
  /** Final raw output text (delivered to the parent even when schema-invalid). */
  result?: string;
  /** Set when the run produced nothing usable. */
  error?: string;
  /** Set when the output never validated even after the correction turn. */
  schemaFailureNote?: string;
  finalized: boolean;
  updatedAt: number;
}

/** Persisted on the child session's metadata so subagents survive restarts. */
interface SubagentMeta {
  parentSessionId: string;
  label: string;
  task: string;
  context?: string;
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  status: SubagentStatus;
  correctionUsed: boolean;
  userId: string;
}

export interface SubagentManagerDeps {
  db: Database;
  agentLoop: AgentLoopManager;
  persistence: PersistencePort;
  queue: JobQueue;
  enqueueAgentRun: (payload: {
    sessionId: string;
    userId?: string;
    mode?: "plan" | "auto" | "autonomous";
    excludeTools?: string[];
    prePersisted?: boolean;
    userMessage?: ContentBlock[];
    maxTurns?: number;
  }) => Promise<string>;
  fallbackUserId: () => Promise<string>;
  maxConcurrent?: number;
}

function readMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** The task message the child session is started with — the schema contract is part of it. */
export function buildSubagentTaskMessage(input: SubagentSpawnInput): string {
  const lines = [
    "Jsi podagent hlavního agenta. Pracuješ na pozadí, samostatně a bez kontaktu s uživatelem.",
    "",
    "Tvůj úkol:",
    input.task.trim(),
  ];
  if (input.context?.trim()) {
    lines.push("", "Kontext k úkolu:", input.context.trim());
  }
  lines.push(
    "",
    "Pravidla:",
    "- Úkol dotáhni do konce a výsledek odevzdej jako jednu souhrnnou zprávu na konci.",
    "- Neptej se uživatele — nemáš s ním kontakt. Když ti něco chybí, rozhodni rozumně a poznač to do výsledku.",
    "- Hlavní agent dostane jen tvůj finální souhrn, ne celý průběh — piš ho proto srozumitelně a úplně.",
  );
  if (input.outputSchema) {
    lines.push(
      "",
      "Výstupní kontrakt — tvůj finální souhrn MUSÍ být platný JSON podle tohoto schématu, bez dalšího textu okolo:",
      "```json",
      JSON.stringify(input.outputSchema, null, 2),
      "```",
    );
  }
  return lines.join("\n");
}

function correctionMessage(errors: string[]): string {
  return [
    "Tvůj poslední výstup neodpovídal požadovanému schématu. Chyby:",
    ...errors.map((e) => `- ${e}`),
    "",
    "Oprav to: odpověz znovu a tentokrát odevzdej POUZE platný JSON podle schématu, bez dalšího textu okolo. Je to tvůj jediný opravný pokus.",
  ].join("\n");
}

/**
 * Pragmatic JSON-Schema subset validator (object/array/string/number/integer/
 * boolean/null, properties, required, items, enum, additionalProperties,
 * min/maxLength, minimum/maximum). Enough for the output_schema contract
 * without pulling in a new dependency; unknown keywords are ignored.
 */
export function validateAgainstSchema(schema: unknown, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if (!schema || typeof schema !== "object") return errors;
  const s = schema as Record<string, unknown>;

  if (typeof s.type === "string") {
    const ok =
      (s.type === "object" && isRecord(value)) ||
      (s.type === "array" && Array.isArray(value)) ||
      (s.type === "string" && typeof value === "string") ||
      (s.type === "boolean" && typeof value === "boolean") ||
      (s.type === "null" && value === null) ||
      (s.type === "number" && typeof value === "number") ||
      (s.type === "integer" && typeof value === "number" && Number.isInteger(value));
    if (!ok) {
      errors.push(`${path}: očekáván typ ${s.type}, obdržen ${jsonTypeOf(value)}`);
      return errors;
    }
  }

  if (Array.isArray(s.enum) && !s.enum.some((v) => deepEqual(v, value))) {
    errors.push(`${path}: hodnota není mezi povolenými možnostmi`);
  }

  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength)
      errors.push(`${path}: text je kratší než minimum ${s.minLength}`);
    if (typeof s.maxLength === "number" && value.length > s.maxLength)
      errors.push(`${path}: text je delší než maximum ${s.maxLength}`);
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) errors.push(`${path}: číslo je menší než minimum ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) errors.push(`${path}: číslo je větší než maximum ${s.maximum}`);
  }

  if (isRecord(value)) {
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === "string" && !(key in value)) errors.push(`${path}: chybí povinné pole "${key}"`);
      }
    }
    const props = isRecord(s.properties) ? (s.properties as Record<string, unknown>) : {};
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in value) errors.push(...validateAgainstSchema(propSchema, value[key], `${path}.${key}`));
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path}: nepovolené pole "${key}"`);
      }
    }
  }

  if (Array.isArray(value) && s.items && typeof s.items === "object") {
    value.forEach((item, i) => errors.push(...validateAgainstSchema(s.items, item, `${path}[${i}]`)));
  }
  return errors;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function jsonTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number" && Number.isInteger(v)) return "integer";
  return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Extracts the JSON payload from a child output (plain or ```json fenced). */
export function extractJson(text: string): { value: unknown; error?: string } {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1].trim());
  for (const c of candidates) {
    try {
      return { value: JSON.parse(c) };
    } catch {
      /* try next */
    }
  }
  return { value: undefined, error: "výstup není platný JSON" };
}

export class SubagentManager {
  private readonly records = new Map<string, SubagentRecord>(); // key: childSessionId
  private readonly unsubscribers = new Map<string, () => void>();
  private maxConcurrent: number;

  constructor(private readonly deps: SubagentManagerDeps) {
    const env = Number(process.env.HERTZ_SUBAGENT_MAX_CONCURRENT);
    this.maxConcurrent = deps.maxConcurrent ?? (Number.isFinite(env) && env > 0 ? Math.floor(env) : DEFAULT_MAX_CONCURRENT_SUBAGENTS);
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  setMaxConcurrent(n: number): void {
    if (!Number.isFinite(n) || n < 1) throw new Error("maxConcurrent musí být kladné číslo");
    this.maxConcurrent = Math.floor(n);
    void this.pump();
  }

  runningCount(): number {
    let n = 0;
    for (const r of this.records.values()) if (r.status === "running") n++;
    return n;
  }

  get(id: string): SubagentRecord | undefined {
    return this.records.get(id);
  }

  /** Records of one parent session, newest first. */
  listForParent(parentSessionId: string): SubagentRecord[] {
    return [...this.records.values()]
      .filter((r) => r.parentSessionId === parentSessionId)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  summariesForParent(parentSessionId: string): SubagentSummary[] {
    return this.listForParent(parentSessionId).map(
      ({ id, label, status, progress, startedAt, finishedAt }) => ({ id, label, status, progress, startedAt, finishedAt }),
    );
  }

  /**
   * Spawns a subagent: creates its isolated child session (own conversation,
   * own sandbox bundle) under the parent's agentId/project and queues it for
   * execution. Returns immediately — the parent stays responsive.
   */
  async spawn(
    parent: { parentSessionId: string; agentId: string; projectId: string; userId: string },
    input: SubagentSpawnInput,
  ): Promise<SubagentRecord> {
    const task = input.task?.trim();
    if (!task) throw new Error("Úkol podagenta nesmí být prázdný");
    const label = input.label?.trim() || task.slice(0, 60) || "Podagent";
    const childSessionId = newId();
    const now = Date.now();

    const meta: SubagentMeta = {
      parentSessionId: parent.parentSessionId,
      label,
      task,
      context: input.context?.trim() || undefined,
      outputSchema: input.outputSchema,
      maxTurns: input.maxTurns,
      status: "pending",
      correctionUsed: false,
      userId: parent.userId,
    };

    await this.deps.db.insert(sessions).values({
      id: childSessionId,
      agentId: parent.agentId,
      projectId: parent.projectId,
      title: label,
      mode: "autonomous",
      status: "active",
      metadata: JSON.stringify({ subagent: meta }),
      parentSessionId: parent.parentSessionId,
      isMainChat: false,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });

    const record: SubagentRecord = {
      id: childSessionId,
      childSessionId,
      parentSessionId: parent.parentSessionId,
      agentId: parent.agentId,
      projectId: parent.projectId,
      userId: parent.userId,
      label,
      status: "pending",
      task,
      context: meta.context,
      outputSchema: meta.outputSchema,
      maxTurns: meta.maxTurns,
      correctionUsed: false,
      finalized: false,
      startedAt: now,
      updatedAt: now,
    };
    this.records.set(childSessionId, record);
    this.notifyParent(record);
    void this.pump();
    return record;
  }

  /** Starts queued subagents while capacity allows. */
  private async pump(): Promise<void> {
    const pending = [...this.records.values()]
      .filter((r) => r.status === "pending" && !r.finalized)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    for (const record of pending) {
      if (this.runningCount() >= this.maxConcurrent) break;
      await this.startChild(record);
    }
  }

  private async startChild(record: SubagentRecord): Promise<void> {
    record.status = "running";
    record.updatedAt = Date.now();
    await this.writeMeta(record);
    this.subscribeChild(record);
    try {
      // After a restart the child's run may already be back in the queue —
      // boot reconciliation requeues jobs left 'running' by the dead process.
      // Enqueueing a second job would run the child twice against one thread.
      const busy = await this.deps.db
        .select({ payload: jobs.payload })
        .from(jobs)
        .where(and(eq(jobs.type, "agent_run"), or(eq(jobs.status, "queued"), eq(jobs.status, "running"))))
        .catch(() => [] as { payload: string }[]);
      const alreadyQueued = busy.some((j) => {
        try {
          return (JSON.parse(j.payload) as { sessionId?: string }).sessionId === record.childSessionId;
        } catch {
          return false;
        }
      });
      if (!alreadyQueued) {
        await this.deps.enqueueAgentRun({
          sessionId: record.childSessionId,
          userId: record.userId,
          mode: "autonomous",
          excludeTools: [...SUBAGENT_EXCLUDED_TOOLS],
          userMessage: [{ type: "text", text: buildSubagentTaskMessage(record) }],
          maxTurns: record.maxTurns,
        });
      }
    } catch (err) {
      record.status = "failed";
      record.error = `Nepodařilo se spustit: ${(err as Error).message}`;
      record.finalized = true;
      record.finishedAt = Date.now();
      await this.writeMeta(record);
      this.unsubscribeChild(record.childSessionId);
    }
    this.notifyParent(record);
    // A failure above frees a slot — let the next queued subagent in.
    void this.pump();
  }

  private subscribeChild(record: SubagentRecord): void {
    if (this.unsubscribers.has(record.childSessionId)) return;
    let toolCount = 0;
    const unsub = this.deps.agentLoop.subscribe(record.childSessionId, (event) => {
      if (event.type === "tool_call") {
        toolCount++;
        record.progress = `${toolCount}. krok: ${event.name}`;
        record.updatedAt = Date.now();
        this.notifyParent(record);
      }
    });
    this.unsubscribers.set(record.childSessionId, unsub);
  }

  private unsubscribeChild(childSessionId: string): void {
    this.unsubscribers.get(childSessionId)?.();
    this.unsubscribers.delete(childSessionId);
  }

  /**
   * Sends follow-up instructions to a subagent. If it is mid-run the message
   * lands in its conversation and the loop picks it up between turns; if it
   * is queued, the instructions wait in its history for the run to start.
   */
  async send(id: string, parentSessionId: string, message: string): Promise<SubagentRecord> {
    const record = this.requireOwned(id, parentSessionId);
    const text = message.trim();
    if (!text) throw new Error("Zpráva pro podagenta nesmí být prázdná");
    if (record.finalized) throw new Error(`Podagent „${record.label}" už skončil — nelze mu nic poslat`);
    const blocks: ContentBlock[] = [
      { type: "text", text: `[Doplňující instrukce od hlavního agenta]\n${text}` },
    ];
    if (this.deps.agentLoop.isRunning(record.childSessionId)) {
      await this.deps.agentLoop.appendInbound(record.childSessionId, blocks, record.agentId);
    } else if (record.status === "pending") {
      // Queued: persist into its history so the run starts with the extra context.
      await this.deps.persistence.appendMessage({
        sessionId: record.childSessionId,
        role: "user",
        content: blocks,
        senderAgentId: record.agentId,
        tokensIn: 0,
        tokensOut: 0,
        cachedTokensIn: 0,
        cost: 0,
        purpose: "agent_turn",
      });
    } else {
      // Not running and not pending (e.g. parked awaiting input): resume with the message.
      await this.deps.enqueueAgentRun({
        sessionId: record.childSessionId,
        userId: record.userId,
        mode: "autonomous",
        excludeTools: [...SUBAGENT_EXCLUDED_TOOLS],
        userMessage: blocks,
      });
      record.status = "running";
    }
    record.progress = "doplňující instrukce odeslány";
    record.updatedAt = Date.now();
    this.notifyParent(record);
    return record;
  }

  /**
   * Stops a subagent: aborts its in-flight work and marks it interrupted.
   * No completion handoff is delivered — the parent stopped it on purpose.
   */
  async stop(id: string, parentSessionId: string): Promise<SubagentRecord> {
    const record = this.requireOwned(id, parentSessionId);
    if (record.finalized) return record;
    record.status = "interrupted";
    record.finalized = true;
    record.finishedAt = Date.now();
    record.updatedAt = Date.now();
    record.progress = "zastaven hlavním agentem";
    // Mark first so the run-finished hook (fired by the aborted job) skips the handoff.
    this.deps.agentLoop.stop(record.childSessionId);
    this.unsubscribeChild(record.childSessionId);
    await this.writeMeta(record);
    try {
      await this.deps.db
        .update(sessions)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(sessions.id, record.childSessionId));
    } catch {
      /* best effort */
    }
    this.notifyParent(record);
    void this.pump();
    return record;
  }

  /**
   * Called by the agent_run job handler after a run finishes. Validates the
   * output against the schema contract (with one bounded correction turn),
   * then hands the result back to the parent session.
   */
  async handleRunFinished(childSessionId: string): Promise<void> {
    let record = this.records.get(childSessionId);
    if (!record) {
      // Unknown to this process (e.g. spawned before a restart) — rebuild from DB.
      const meta = await this.readMeta(childSessionId);
      if (!meta) return;
      record = this.registerFromMeta(childSessionId, meta);
    }
    if (record.finalized) return;
    if (record.status === "interrupted") {
      // Stopped on purpose — no handoff, just persist + notify.
      await this.writeMeta(record);
      this.notifyParent(record);
      return;
    }

    const sessionRows = await this.deps.db
      .select({ status: sessions.status, agentId: sessions.agentId })
      .from(sessions)
      .where(eq(sessions.id, childSessionId))
      .limit(1)
      .catch(() => []);
    const sessionStatus = sessionRows[0]?.status;

    const messages = await this.deps.persistence.listMessages(childSessionId).catch(() => []);
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && textOf(m.content));
    const outputText = lastAssistant ? textOf(lastAssistant.content) : "";

    if (sessionStatus === "error" || !outputText) {
      record.status = "failed";
      record.error =
        sessionStatus === "error"
          ? "Běh podagenta skončil chybou."
          : "Podagent neodevzdal žádný výstup.";
      record.finalized = true;
      record.finishedAt = Date.now();
      await this.writeMeta(record);
      this.unsubscribeChild(childSessionId);
      await this.handOff(record);
      this.notifyParent(record);
      void this.pump();
      return;
    }

    // output_schema contract (Hermes): validate, one correction turn on failure.
    if (record.outputSchema) {
      const { value, error } = extractJson(outputText);
      const errors = error ? [error] : validateAgainstSchema(record.outputSchema, value);
      if (errors.length > 0 && !record.correctionUsed) {
        record.correctionUsed = true;
        await this.writeMeta(record);
        await this.deps.agentLoop.appendInbound(
          childSessionId,
          [{ type: "text", text: correctionMessage(errors) }],
          record.agentId,
        );
        await this.deps.enqueueAgentRun({
          sessionId: childSessionId,
          userId: record.userId,
          mode: "autonomous",
          excludeTools: [...SUBAGENT_EXCLUDED_TOOLS],
          prePersisted: true,
          userMessage: [],
          maxTurns: record.maxTurns,
        });
        record.status = "running";
        record.progress = "opravný pokus výstupu";
        record.updatedAt = Date.now();
        this.notifyParent(record);
        return; // not finalized — the correction run will call back here again
      }
      if (errors.length > 0) {
        record.schemaFailureNote =
          "Výstup ani po opravném pokusu neodpovídal požadovanému schématu — předávám surový text.";
      }
      record.result = outputText;
    } else {
      record.result = outputText;
    }

    record.status = "done";
    record.finalized = true;
    record.finishedAt = Date.now();
    record.updatedAt = Date.now();
    record.progress = undefined;
    await this.writeMeta(record);
    this.unsubscribeChild(childSessionId);
    await this.handOff(record);
    this.notifyParent(record);
    void this.pump();
  }

  /** Delivers the subagent's result to the parent session; the main agent then summarizes it to the user. */
  private async handOff(record: SubagentRecord): Promise<void> {
    const lines = [`[Podagent „${record.label}" ${record.status === "done" ? "dokončil úkol" : "selhal"}]`, ""];
    if (record.result) {
      lines.push("Výsledek:", record.result);
    } else if (record.error) {
      lines.push(record.error);
    }
    if (record.schemaFailureNote) lines.push("", record.schemaFailureNote);
    const text = lines.join("\n");
    const blocks: ContentBlock[] = [{ type: "text", text }];

    const parentRows = await this.deps.db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, record.parentSessionId))
      .limit(1)
      .catch(() => []);
    const parent = parentRows[0];
    if (!parent || parent.status === "archived") return;

    if (this.deps.agentLoop.isRunning(record.parentSessionId)) {
      // Parent is mid-conversation — the loop notices the inbound message between turns.
      await this.deps.agentLoop.appendInbound(record.parentSessionId, blocks, record.agentId);
    } else {
      await this.deps.enqueueAgentRun({
        sessionId: record.parentSessionId,
        userId: record.userId,
        userMessage: blocks,
      });
    }
  }

  /** Rebuilds subagent state after a restart: re-subscribes to live children, re-queues pending ones. */
  async recover(): Promise<void> {
    const rows = await this.deps.db
      .select({ id: sessions.id, metadata: sessions.metadata, status: sessions.status, agentId: sessions.agentId, projectId: sessions.projectId })
      .from(sessions)
      .catch(() => []);
    for (const row of rows) {
      const meta = readMeta(row.metadata).subagent as SubagentMeta | undefined;
      if (!meta || !meta.parentSessionId) continue;
      if (this.records.has(row.id)) continue;
      if (meta.status === "done" || meta.status === "failed" || meta.status === "interrupted") continue;
      const record = this.registerFromMeta(row.id, meta, row);
      if (meta.status === "running") {
        // The run was requeued by boot reconciliation — re-subscribe for progress.
        this.subscribeChild(record);
      }
    }
    void this.pump();
  }

  private registerFromMeta(
    childSessionId: string,
    meta: SubagentMeta,
    row?: { agentId: string; projectId: string },
  ): SubagentRecord {
    const record: SubagentRecord = {
      id: childSessionId,
      childSessionId,
      parentSessionId: meta.parentSessionId,
      agentId: row?.agentId ?? "",
      projectId: row?.projectId ?? "",
      userId: meta.userId,
      label: meta.label,
      status: meta.status === "done" || meta.status === "failed" || meta.status === "interrupted" ? meta.status : "pending",
      task: meta.task,
      context: meta.context,
      outputSchema: meta.outputSchema,
      maxTurns: meta.maxTurns,
      correctionUsed: meta.correctionUsed,
      finalized: false,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.records.set(childSessionId, record);
    return record;
  }

  private async readMeta(childSessionId: string): Promise<SubagentMeta | null> {
    const rows = await this.deps.db
      .select({ metadata: sessions.metadata })
      .from(sessions)
      .where(eq(sessions.id, childSessionId))
      .limit(1)
      .catch(() => []);
    const meta = readMeta(rows[0]?.metadata ?? null).subagent as SubagentMeta | undefined;
    return meta?.parentSessionId ? meta : null;
  }

  private async writeMeta(record: SubagentRecord): Promise<void> {
    const rows = await this.deps.db
      .select({ metadata: sessions.metadata })
      .from(sessions)
      .where(eq(sessions.id, record.childSessionId))
      .limit(1)
      .catch(() => []);
    if (!rows[0]) return;
    const meta = readMeta(rows[0].metadata);
    const sub: SubagentMeta = {
      parentSessionId: record.parentSessionId,
      label: record.label,
      task: record.task,
      context: record.context,
      outputSchema: record.outputSchema,
      maxTurns: record.maxTurns,
      status: record.status,
      correctionUsed: record.correctionUsed,
      userId: record.userId,
    };
    meta.subagent = sub;
    try {
      await this.deps.db
        .update(sessions)
        .set({ metadata: JSON.stringify(meta), updatedAt: new Date() })
        .where(eq(sessions.id, record.childSessionId));
    } catch {
      /* best effort */
    }
  }

  private requireOwned(id: string, parentSessionId: string): SubagentRecord {
    const record = this.records.get(id);
    if (!record || record.parentSessionId !== parentSessionId) {
      throw new Error("Podagent nebyl nalezen v této konverzaci");
    }
    return record;
  }

  private notifyParent(record: SubagentRecord): void {
    try {
      this.deps.agentLoop.notify(record.parentSessionId, {
        type: "subagents",
        subagents: this.summariesForParent(record.parentSessionId),
      });
    } catch {
      /* the parent may not be watched — the session detail API still carries the state */
    }
  }
}

/** True when the session row belongs to a subagent child (used by the run handler). */
export function isSubagentChildSession(metadata: string | null): boolean {
  const sub = readMeta(metadata).subagent as SubagentMeta | undefined;
  return !!sub?.parentSessionId;
}
