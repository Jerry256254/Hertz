import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import type { AgentToolDef } from "./tool-def.js";
import { approvals, auditLog, sessions } from "../db/schema.js";
import {
  decryptVaultSecret,
  getVaultCredentialMeta,
  listVaultCredentials,
  type VaultCredentialMeta,
} from "../secrets/vault.js";
import {
  VAULT_GRANT_TTL_MS,
  consumeVaultGrant,
  issueVaultGrant,
  peekVaultGrant,
} from "../secrets/vault-grants.js";

export interface VaultUsePayload {
  credentialId: string;
  purpose: string;
}

export function parseVaultUsePayload(raw: string | null): VaultUsePayload | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<VaultUsePayload>;
    if (typeof parsed.credentialId !== "string" || !parsed.credentialId) return undefined;
    if (typeof parsed.purpose !== "string" || !parsed.purpose) return undefined;
    return { credentialId: parsed.credentialId, purpose: parsed.purpose };
  } catch {
    return undefined;
  }
}

const listSchema = z.object({});

const useSchema = z.object({
  credentialId: z.string().min(1).describe("Id údaje z vault_list"),
  purpose: z
    .string()
    .min(10)
    .max(500)
    .describe("K čemu údaj potřebuješ (min. 10 znaků) — uživatel to čte při schvalování"),
});

/**
 * Credential vault (Trezor): the agent sees metadata only and may USE a
 * credential exactly once per user approval — it can NEVER read the secret.
 *
 * - vault_list returns metadata (id, service, label, username, dates). The
 *   secret, or any part of it, is never included and no tool reveals it.
 * - vault_use files a kind='vault_use' approval (service/label/username +
 *   purpose shown to the user, never the secret) and parks the run. On
 *   approval the SERVER decrypts the secret into a single-use, 5-minute
 *   in-memory grant; the agent then types the password via browser_type /
 *   desktop_type with vaultFill:true — the server substitutes the secret at
 *   execution time, so plaintext never crosses a tool result, message
 *   history, log line, or audit row.
 */
export function createVaultTools(db: Database, masterKey: Buffer): AgentToolDef[] {
  const vaultList: AgentToolDef = {
    name: "vault_list",
    description:
      "List login credentials stored in the vault (Trezor). Returns ONLY metadata — id, service, label, username, created/updated dates. The password/secret is NEVER included and there is no tool that reveals it: you cannot read, print, copy, or guess it, so never try. RULES: never write passwords into memory, notes, files, or chat; never ask the user for a password in chat when the vault holds the credential — use vault_use instead; if the user pastes a password into chat, do not store it anywhere yourself — tell them to save it in the vault (Settings › Trezor).",
    inputSchema: listSchema,
    async execute() {
      const items = await listVaultCredentials(db);
      if (items.length === 0) {
        return { summary: "Trezor je prázdný — žádné uložené údaje." };
      }
      const lines = items.map(
        (c) => `- ${c.id}: „${c.label}" — ${c.service} (uživatel: ${c.username})`,
      );
      return { summary: `Uložené údaje (${items.length}):\n${lines.join("\n")}` };
    },
  };

  const vaultUse: AgentToolDef = {
    name: "vault_use",
    description:
      "Request ONE-TIME use of a vault credential for a login (e.g. filling a login form). You give the credential id (from vault_list) and WHY you need it (purpose, min 10 chars). This files an approval request — the user sees the service, label, username and your purpose, NEVER the password — and the run parks until they approve or reject. After approval you do NOT receive the password: the server keeps it as a single-use, 5-minute grant. Type the USERNAME yourself with a normal browser_type/desktop_type call, then type the PASSWORD with browser_type/desktop_type and vaultFill:true — the server substitutes the approved secret at execution time and it never appears in logs, history, or tool results. The grant is consumed by the first fill. If the request is rejected or the grant expires, the password stays sealed: do NOT ask the user for it in chat, just continue without it or explain what's blocked.",
    inputSchema: useSchema,
    async execute(rawInput, ctx) {
      const input = useSchema.parse(rawInput);
      const projectId = ctx.actor.projectId;
      const sessionId = ctx.actor.sessionId;
      if (!projectId || !sessionId) {
        return { summary: "No project/session context — cannot file a vault-use request.", isError: true };
      }

      const meta = await getVaultCredentialMeta(db, input.credentialId);
      if (!meta) {
        return { summary: `Údaj s id „${input.credentialId}" v trezoru neexistuje. Zkontroluj id přes vault_list.`, isError: true };
      }
      if (peekVaultGrant(sessionId)) {
        return {
          summary: `Pro tuto konverzaci už je schválený údaj „${meta.label}" — nejdřív ho použi (vaultFill:true) a pak případně žádej znovu.`,
          isError: true,
        };
      }
      const pending = await db
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.sessionId, sessionId),
            eq(approvals.kind, "vault_use"),
            eq(approvals.status, "pending"),
          ),
        )
        .limit(1);
      if (pending[0]) {
        return {
          summary: `Žádost o použití údaje „${meta.label}" už čeká na schválení — vyčkej na rozhodnutí uživatele.`,
          isError: true,
        };
      }

      const payload: VaultUsePayload = { credentialId: meta.id, purpose: input.purpose };
      const summary = `Použít údaj „${meta.label}" (${meta.service}, ${meta.username}) — ${input.purpose.slice(0, 120)}`;
      const id = newId();
      await db.insert(approvals).values({
        id,
        projectId,
        agentId: ctx.actor.actorId,
        sessionId,
        summary,
        detail: `Účel: ${input.purpose}\nSlužba: ${meta.service}\nÚdaj: ${meta.label}\nUživatelské jméno: ${meta.username}\nHeslo agent nikdy neuvidí — po schválení ho server jednorázově vyplní (vaultFill).`,
        kind: "vault_use",
        payload: JSON.stringify(payload),
        result: null,
        createdAt: new Date(),
      });

      const rows = await db.select({ metadata: sessions.metadata }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      let sessMeta: Record<string, unknown> = {};
      try {
        sessMeta = rows[0]?.metadata ? (JSON.parse(rows[0].metadata) as Record<string, unknown>) : {};
      } catch {
        sessMeta = {};
      }
      await db
        .update(sessions)
        .set({
          metadata: JSON.stringify({
            ...sessMeta,
            pendingQuestion: `Schválení potřeba: ${summary}`,
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
        action: "vault_use.request",
        target: meta.id,
        targetType: "vault_credential",
        result: "allowed",
        detail: JSON.stringify({ service: meta.service, label: meta.label, username: meta.username, purpose: input.purpose }),
        at: new Date(),
      });

      return {
        summary: `Žádost o použití údaje „${meta.label}" (${meta.service}) odeslána ke schválení. Čekám na rozhodnutí uživatele.`,
        awaitUser: { question: `Schválení potřeba: ${summary}` },
      };
    },
  };

  return [vaultList, vaultUse];
}

/** Inbound text resuming the agent after an APPROVED vault_use request. */
export function formatVaultUseApprovedInbound(meta: VaultCredentialMeta): string {
  return (
    `[Uživatel SCHVÁLIL použití údaje „${meta.label}" (${meta.service}). ` +
    `Jednorázové vyplnění je připravené pro tuto konverzaci (vyprší za 5 minut, spotřebuje se prvním vyplněním). ` +
    `Uživatelské jméno „${meta.username}" vyplň sám běžným browser_type/desktop_type. ` +
    `HESLO vyplň pomocí browser_type/desktop_type s vaultFill:true — server dosadí schválené heslo při provedení; ` +
    `nikdy se neobjeví v logu, historii ani výsledku nástroje. Heslo nikam nezapisuj a nikdy ho nečti zpět.]`
  );
}

/** Inbound text resuming the agent after a REJECTED vault_use request. */
export function formatVaultUseRejectedInbound(meta: VaultCredentialMeta): string {
  return (
    `[Uživatel ZAMÍTL použití údaje „${meta.label}" (${meta.service}). ` +
    `Heslo zůstává zapečetěné — nežádej ho po uživateli v chatu. ` +
    `Pokračuj bez něj, případně vysvětli, co je zablokované.]`
  );
}

export interface VaultUseDecision {
  approvalId: string;
  sessionId: string;
  summary: string;
  payload: string | null;
  decision: "approved" | "rejected";
  decidedByUserId: string;
}

/**
 * Executes the server side of a decided vault_use approval. On approval the
 * secret is decrypted IN MEMORY and issued as a single-use grant — it never
 * touches the DB, the audit log, or the returned text. On rejection (or when
 * the credential is gone) nothing is issued. Returns the inbound text that
 * resumes the agent.
 */
export async function resolveVaultUseApproval(
  db: Database,
  masterKey: Buffer,
  decision: VaultUseDecision,
): Promise<string> {
  const payload = parseVaultUsePayload(decision.payload);
  const meta = payload ? await getVaultCredentialMeta(db, payload.credentialId) : undefined;

  if (!payload || !meta) {
    await db.insert(auditLog).values({
      id: newId(),
      actorId: decision.decidedByUserId,
      actorType: "user",
      sessionId: decision.sessionId,
      action: "vault_use.error",
      target: payload?.credentialId ?? null,
      targetType: "vault_credential",
      result: "error",
      detail: JSON.stringify({ approvalId: decision.approvalId, reason: "credential_not_found" }),
      at: new Date(),
    });
    return `[Schválení „${decision.summary}" se nezdařilo: údaj v trezoru už neexistuje. Pokračuj bez něj.]`;
  }

  if (decision.decision === "rejected") {
    await db.insert(auditLog).values({
      id: newId(),
      actorId: decision.decidedByUserId,
      actorType: "user",
      sessionId: decision.sessionId,
      action: "vault_use.rejected",
      target: meta.id,
      targetType: "vault_credential",
      result: "denied",
      detail: JSON.stringify({ service: meta.service, label: meta.label, username: meta.username, approvalId: decision.approvalId }),
      at: new Date(),
    });
    return formatVaultUseRejectedInbound(meta);
  }

  const decrypted = await decryptVaultSecret(db, masterKey, meta.id);
  if (!decrypted) {
    return `[Schválení „${decision.summary}" se nezdařilo: údaj v trezoru už neexistuje. Pokračuj bez něj.]`;
  }
  issueVaultGrant(decision.sessionId, {
    credentialId: meta.id,
    label: meta.label,
    username: meta.username,
    secret: decrypted.secret,
    expiresAt: Date.now() + VAULT_GRANT_TTL_MS,
  });
  // Metadata only — the secret NEVER lands in the approvals table.
  await db
    .update(approvals)
    .set({ result: JSON.stringify({ credentialId: meta.id, grantedAt: Date.now() }) })
    .where(eq(approvals.id, decision.approvalId));
  await db.insert(auditLog).values({
    id: newId(),
    actorId: decision.decidedByUserId,
    actorType: "user",
    sessionId: decision.sessionId,
    action: "vault_use.approved",
    target: meta.id,
    targetType: "vault_credential",
    result: "allowed",
    detail: JSON.stringify({ service: meta.service, label: meta.label, username: meta.username, approvalId: decision.approvalId }),
    at: new Date(),
  });
  return formatVaultUseApprovedInbound(meta);
}

/**
 * Consumes the session's outstanding vault grant for a fill tool
 * (browser_type / desktop_type with vaultFill:true). Returns the secret for
 * immediate substitution, or an error summary when no valid grant exists —
 * the secret itself never appears in the returned summary.
 */
export function consumeVaultGrantForFill(sessionId: string | undefined): { secret: string; label: string } | { error: string } {
  if (!sessionId) return { error: "vaultFill vyžaduje schválený údaj — nejdřív zavolej vault_use a vyčkej na schválení." };
  const grant = consumeVaultGrant(sessionId);
  if (!grant) {
    return {
      error:
        "Pro tuto konverzaci není žádný platný schválený údaj (nebyl schválen, už se spotřeboval, nebo vypršel). Zavolej vault_use a vyčkej na schválení.",
    };
  }
  return { secret: grant.secret, label: grant.label };
}
