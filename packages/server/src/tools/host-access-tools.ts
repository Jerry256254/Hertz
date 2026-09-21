import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { approvals, auditLog, sessions } from "../db/schema.js";
import type { AgentToolDef } from "./tool-def.js";
import { hasSessionApproval, sessionApprovalKey } from "./session-approval-grants.js";

export type HostAccessOp = "read" | "rewrite" | "create" | "delete";

export interface HostAccessPayload {
  op: HostAccessOp;
  hostPath: string;
  content?: string;
  reason: string;
}

export interface HostAccessResult {
  ok: boolean;
  output?: string;
  bytes?: number;
  error?: string;
}

const MAX_HOST_READ_BYTES = 5_000_000;
const MAX_HOST_WRITE_BYTES = 5_000_000;
/** Read output inlined into the resumed run is truncated past this, with a marker. */
export const HOST_READ_INBOUND_LIMIT = 12_000;

export const hostAccessInputSchema = z
  .object({
    op: z.enum(["read", "rewrite", "create", "delete"]).describe("read = read a host file; rewrite = overwrite an EXISTING host file; create = write a NEW host file; delete = delete a host file or EMPTY directory (never recursive)"),
    hostPath: z
      .string()
      .min(1)
      .refine((p) => path.isAbsolute(p), "hostPath must be an absolute host path")
      .describe("Absolute path on the HOST machine (outside your computer)"),
    content: z.string().max(MAX_HOST_WRITE_BYTES).optional().describe("Required for rewrite/create: the full new file content"),
    reason: z.string().min(10).describe("Why you need this host path (min 10 chars) — the user reads this to decide"),
  })
  .refine((d) => (d.op === "rewrite" || d.op === "create" ? typeof d.content === "string" : true), {
    message: "content is required for rewrite/create",
    path: ["content"],
  });

export type HostAccessInput = z.infer<typeof hostAccessInputSchema>;

/**
 * Executes one approved host-filesystem op SERVER-side (user-actuated — the
 * user approved exactly this op+path). Deliberately narrow: no recursive
 * delete, no invented directory trees, reads capped like read_file.
 */
export async function executeHostAccessOp(payload: HostAccessPayload): Promise<HostAccessResult> {
  const target = path.normalize(payload.hostPath);
  try {
    switch (payload.op) {
      case "read": {
        const st = await fs.stat(target);
        if (!st.isFile()) return { ok: false, error: `Not a file: ${target}` };
        if (st.size > MAX_HOST_READ_BYTES) {
          return { ok: false, error: `File too large (${st.size} bytes) — max ${MAX_HOST_READ_BYTES}` };
        }
        const output = await fs.readFile(target, "utf8");
        return { ok: true, output, bytes: st.size };
      }
      case "rewrite": {
        if (typeof payload.content !== "string") return { ok: false, error: "rewrite requires content" };
        let st;
        try {
          st = await fs.stat(target);
        } catch {
          return { ok: false, error: `rewrite target does not exist (use create for new files): ${target}` };
        }
        if (!st.isFile()) return { ok: false, error: `rewrite target is not a file: ${target}` };
        await fs.writeFile(target, payload.content, "utf8");
        return { ok: true, bytes: Buffer.byteLength(payload.content, "utf8") };
      }
      case "create": {
        if (typeof payload.content !== "string") return { ok: false, error: "create requires content" };
        try {
          await fs.stat(target);
          return { ok: false, error: `create target already exists (use rewrite to overwrite): ${target}` };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        let parent;
        try {
          parent = await fs.stat(path.dirname(target));
        } catch {
          return { ok: false, error: `create parent directory does not exist: ${path.dirname(target)}` };
        }
        if (!parent.isDirectory()) return { ok: false, error: `create parent is not a directory: ${path.dirname(target)}` };
        await fs.writeFile(target, payload.content, "utf8");
        return { ok: true, bytes: Buffer.byteLength(payload.content, "utf8") };
      }
      case "delete": {
        let st;
        try {
          st = await fs.stat(target);
        } catch {
          return { ok: false, error: `delete target does not exist: ${target}` };
        }
        if (st.isDirectory()) {
          // rmdir refuses non-empty dirs — never recursive by construction.
          try {
            await fs.rmdir(target);
          } catch (err) {
            return { ok: false, error: `Cannot delete directory (not empty?): ${target}: ${(err as Error).message}` };
          }
          return { ok: true };
        }
        await fs.rm(target, { force: false });
        return { ok: true };
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Inbound text resuming the agent after an APPROVED host_access op executed. */
export function formatHostAccessExecutedInbound(payload: HostAccessPayload, result: HostAccessResult): string {
  const what = `host ${payload.op} '${payload.hostPath}'`;
  if (!result.ok) {
    return `[The user APPROVED your ${what} request, but executing it FAILED: ${result.error ?? "unknown error"}. Do not retry the same op — continue inside your own files or ask the user for help.]`;
  }
  if (payload.op === "read") {
    const output = result.output ?? "";
    const truncated = output.length > HOST_READ_INBOUND_LIMIT;
    const body = truncated ? output.slice(0, HOST_READ_INBOUND_LIMIT) : output;
    return `[The user APPROVED your ${what} request. Result (${result.bytes ?? output.length} bytes${truncated ? `, [truncated ${output.length - HOST_READ_INBOUND_LIMIT} bytes]` : ""}):]\n${body}`;
  }
  return `[The user APPROVED your ${what} request and it succeeded${typeof result.bytes === "number" ? ` (${result.bytes} bytes written)` : ""}. Continue your work.]`;
}

/** Inbound text resuming the agent after a REJECTED host_access request. */
export function formatHostAccessRejectedInbound(payload: HostAccessPayload): string {
  return `[The user REJECTED your host request '${payload.op} ${payload.hostPath}' (reason you gave: '${payload.reason}'). Do not retry or work around — continue inside your own files.]`;
}

export function parseHostAccessPayload(raw: string | null): HostAccessPayload | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<HostAccessPayload>;
    if (!parsed || (parsed.op !== "read" && parsed.op !== "rewrite" && parsed.op !== "create" && parsed.op !== "delete")) return undefined;
    if (typeof parsed.hostPath !== "string" || !path.isAbsolute(parsed.hostPath)) return undefined;
    if (typeof parsed.reason !== "string") return undefined;
    return { op: parsed.op, hostPath: parsed.hostPath, content: parsed.content, reason: parsed.reason };
  } catch {
    return undefined;
  }
}

/**
 * One-shot host-filesystem access for VM-isolated agents: the agent lives
 * inside its container and CANNOT reach host paths directly — this files a
 * machine-readable request the user approves/rejects in the inbox, and the
 * SERVER then executes exactly that op (see routes/approvals.ts). The run
 * parks in awaiting_input until decided, like request_approval.
 */
export function createHostAccessTools(db: Database): AgentToolDef[] {
  const requestHostAccess: AgentToolDef = {
    name: "request_host_access",
    description:
      "Request one-shot access to a file OUTSIDE your computer (a host path unreachable from inside your VM): read it, rewrite an existing file, create a new file, or delete a file/empty directory. If the user gave this folder a name, use that root with the normal file tools instead — this is only for genuinely out-of-VM paths. The user approves or rejects with the reason you give (say WHY, min 10 chars); the run pauses until they decide, then resumes with the result. One path per call.",
    inputSchema: hostAccessInputSchema,
    async execute(rawInput, ctx) {
      const input = hostAccessInputSchema.parse(rawInput);
      const projectId = ctx.actor.projectId;
      const sessionId = ctx.actor.sessionId;
      if (!projectId || !sessionId) {
        return { summary: "No project/session context — cannot file a host-access request.", isError: true };
      }

      const hostPath = path.normalize(input.hostPath);
      const payload: HostAccessPayload = { op: input.op, hostPath, content: input.content, reason: input.reason };
      const summary = `Host ${input.op} ${hostPath} — ${input.reason.slice(0, 120)}`;
      const id = newId();
      // "Povolit pro session": pre-approved op+path — the server executes it
      // right away, exactly like a one-shot approval, without parking.
      if (hasSessionApproval(sessionId, sessionApprovalKey("host_access", `${input.op}:${hostPath}`))) {
        await db.insert(auditLog).values({
          id: newId(),
          actorId: ctx.actor.actorId,
          actorType: "agent",
          sessionId,
          projectId,
          action: "host_access.approved",
          target: hostPath,
          targetType: "host_path",
          result: "allowed",
          detail: JSON.stringify({ op: input.op, hostPath, via: "session_grant" }),
          at: new Date(),
        });
        const opResult = await executeHostAccessOp(payload);
        await db.insert(approvals).values({
          id,
          projectId,
          agentId: ctx.actor.actorId,
          sessionId,
          summary,
          detail: input.reason,
          kind: "host_access",
          payload: JSON.stringify(payload),
          result: JSON.stringify(opResult),
          status: "approved",
          decidedAt: new Date(),
          createdAt: new Date(),
        });
        return { summary: `[Automaticky schváleno pro tuto session] ${formatHostAccessExecutedInbound(payload, opResult)}` };
      }
      await db.insert(approvals).values({
        id,
        projectId,
        agentId: ctx.actor.actorId,
        sessionId,
        summary,
        detail: input.reason,
        kind: "host_access",
        payload: JSON.stringify(payload),
        result: null,
        createdAt: new Date(),
      });

      const rows = await db.select({ metadata: sessions.metadata }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      let meta: Record<string, unknown> = {};
      try {
        meta = rows[0]?.metadata ? (JSON.parse(rows[0].metadata) as Record<string, unknown>) : {};
      } catch {
        meta = {};
      }
      await db
        .update(sessions)
        .set({
          metadata: JSON.stringify({
            ...meta,
            pendingQuestion: `Host access needed: ${summary}`,
            pendingApprovalId: id,
          }),
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, sessionId));

      await db.insert(auditLog).values({
        id: newId(),
        actorId: ctx.actor.actorId,
        actorType: "agent",
        sessionId,
        projectId,
        action: "host_access.request",
        target: hostPath,
        targetType: "host_path",
        result: "allowed",
        detail: JSON.stringify({ op: input.op, hostPath, reason: input.reason }),
        at: new Date(),
      });

      return {
        summary: `Host-access request filed ("${summary}") and shown to the user. Waiting for their decision.`,
        awaitUser: { question: `Host access needed: ${summary}` },
      };
    },
  };

  return [requestHostAccess];
}
