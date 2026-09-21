import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { openDatabase } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import { approvals, auditLog, sessions, vaultCredentials, users, projects, providerConfigs, agents } from "../dist/db/schema.js";
import { eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "../dist/secrets/key-encryption.js";
import {
  createVaultCredential,
  listVaultCredentials,
  getVaultCredentialMeta,
  updateVaultCredential,
  deleteVaultCredential,
  decryptVaultSecret,
} from "../dist/secrets/vault.js";
import {
  VAULT_GRANT_TTL_MS,
  clearVaultGrants,
  consumeVaultGrant,
  issueVaultGrant,
  peekVaultGrant,
  revokeVaultGrantsForCredential,
} from "../dist/secrets/vault-grants.js";
import {
  consumeVaultGrantForFill,
  createVaultTools,
  parseVaultUsePayload,
  resolveVaultUseApproval,
  formatVaultUseApprovedInbound,
  formatVaultUseRejectedInbound,
} from "../dist/tools/vault-tools.js";
import { createBrowserTools } from "../dist/tools/browser-tools.js";
import { createDesktopTools } from "../dist/tools/desktop-tools.js";
import { decideApproval } from "../dist/tools/approval-tools.js";

const SECRET = "s3cr3t-p@ssw0rd-čřž";
const actor = { actorId: "agent-1", actorType: "agent", sessionId: "sess-1", projectId: "proj-1" };

async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-vault-"));
  const { client, db } = openDatabase(path.join(dir, "test.db"));
  await runMigrations(client);
  return { client, db, dir };
}

async function seedRun(db) {
  const now = new Date();
  await db.insert(users).values({ id: "user-1", email: "u@x.y", passwordHash: "h", role: "admin", createdAt: now });
  await db.insert(projects).values({ id: "proj-1", name: "p", createdAt: now });
  await db.insert(providerConfigs).values({ id: "pc-1", userId: "user-1", provider: "openai", label: "l", encryptedKey: "k", createdAt: now });
  await db.insert(agents).values({ id: "agent-1", projectId: "proj-1", name: "Orion", providerConfigId: "pc-1", model: "m", createdAt: now });
  await db.insert(sessions).values({ id: "sess-1", agentId: "agent-1", projectId: "proj-1", title: "t", status: "active", createdAt: now, updatedAt: now });
}

const MASTER = crypto.randomBytes(32);

before(() => clearVaultGrants());

describe("vault schema + migration", () => {
  it("bootstrap creates the vault_credentials table", async () => {
    const { client } = await makeDb();
    const cols = await client.execute("PRAGMA table_info(vault_credentials)");
    const names = cols.rows.map((r) => r.name);
    for (const c of ["id", "service", "label", "username", "encrypted_secret", "note", "created_at", "updated_at"]) {
      assert.ok(names.includes(c), `column ${c} missing`);
    }
    const idx = await client.execute("PRAGMA index_list(vault_credentials)");
    assert.ok(idx.rows.map((r) => r.name).includes("idx_vault_credentials_service"));
    client.close();
  });

  it("approvals kind accepts vault_use", async () => {
    const { client, db } = await makeDb();
    await seedRun(db);
    await db.insert(approvals).values({
      id: "ap-1", projectId: "proj-1", agentId: "agent-1", sessionId: "sess-1",
      summary: "s", kind: "vault_use", payload: "{}", createdAt: new Date(),
    });
    const rows = await db.select().from(approvals).where(eq(approvals.id, "ap-1"));
    assert.equal(rows[0].kind, "vault_use");
    client.close();
  });
});

describe("vault CRUD + encryption at rest", () => {
  it("stores only ciphertext; decrypt round-trips", async () => {
    const { client, db } = await makeDb();
    const meta = await createVaultCredential(db, MASTER, {
      service: "github.com", label: "osobní", username: "jerry", secret: SECRET, note: "poznámka",
    });
    assert.equal(meta.service, "github.com");
    assert.ok(!("secret" in meta) && !("encryptedSecret" in meta), "metadata must not carry the secret");

    const raw = await db.select().from(vaultCredentials);
    assert.equal(raw.length, 1);
    assert.ok(!raw[0].encryptedSecret.includes(SECRET), "ciphertext must not contain plaintext");
    const payload = JSON.parse(raw[0].encryptedSecret);
    assert.ok(payload.iv && payload.authTag && payload.ciphertext, "expected AES-GCM envelope");
    assert.equal(decryptSecret(MASTER, raw[0].encryptedSecret), SECRET);

    // Random IV: same secret encrypts differently each time.
    const meta2 = await createVaultCredential(db, MASTER, {
      service: "github.com", label: "pracovní", username: "jerry", secret: SECRET,
    });
    const raw2 = await db.select().from(vaultCredentials).where(eq(vaultCredentials.id, meta2.id));
    assert.notEqual(raw2[0].encryptedSecret, raw[0].encryptedSecret);
    client.close();
  });

  it("list returns metadata only — never the secret", async () => {
    const { client, db } = await makeDb();
    await createVaultCredential(db, MASTER, { service: "banka.cz", label: "hlavní", username: "klient123", secret: SECRET });
    const items = await listVaultCredentials(db);
    assert.equal(items.length, 1);
    const dump = JSON.stringify(items);
    assert.ok(!dump.includes(SECRET), "list output must not contain the secret");
    assert.ok(!dump.includes("encryptedSecret") && !dump.includes("encrypted_secret"));
    assert.equal(items[0].username, "klient123");
    client.close();
  });

  it("update rotates the secret; delete removes the row", async () => {
    const { client, db } = await makeDb();
    const meta = await createVaultCredential(db, MASTER, { service: "x.cz", label: "a", username: "u", secret: "old" });
    const updated = await updateVaultCredential(db, MASTER, meta.id, { label: "b", secret: "new-secret" });
    assert.equal(updated.label, "b");
    assert.equal((await decryptVaultSecret(db, MASTER, meta.id)).secret, "new-secret");
    assert.ok(await deleteVaultCredential(db, meta.id));
    assert.equal(await getVaultCredentialMeta(db, meta.id), undefined);
    assert.equal(await deleteVaultCredential(db, meta.id), false);
    client.close();
  });

  it("rejects empty secrets", async () => {
    const { client, db } = await makeDb();
    await assert.rejects(() => createVaultCredential(db, MASTER, { service: "s", label: "l", username: "u", secret: "" }), /must not be empty/);
    client.close();
  });
});

describe("vault_list tool", () => {
  it("returns metadata only and documents the never-reveal rules", async () => {
    const { client, db } = await makeDb();
    await seedRun(db);
    const [list] = createVaultTools(db, MASTER);
    assert.equal(list.name, "vault_list");
    assert.match(list.description, /NEVER included/i);
    assert.match(list.description, /never write passwords into memory/i);

    let res = await list.execute({}, { actor });
    assert.match(res.summary, /prázdný/);

    await createVaultCredential(db, MASTER, { service: "github.com", label: "osobní", username: "jerry", secret: SECRET });
    res = await list.execute({}, { actor });
    assert.ok(res.summary.includes("github.com") && res.summary.includes("jerry"));
    assert.ok(!res.summary.includes(SECRET), "tool result must not contain the secret");
    client.close();
  });
});

describe("vault_use tool + approval gate", () => {
  async function fileRequest(db) {
    const [, use] = createVaultTools(db, MASTER);
    const meta = await createVaultCredential(db, MASTER, { service: "github.com", label: "osobní", username: "jerry", secret: SECRET });
    const res = await use.execute({ credentialId: meta.id, purpose: "přihlášení do GitHubu pro kontrolu repozitáře" }, { actor });
    return { use, meta, res };
  }

  it("files a vault_use approval and parks the run — payload/summary carry no secret", async () => {
    const { client, db } = await makeDb();
    await seedRun(db);
    const { meta, res } = await fileRequest(db);
    assert.ok(res.awaitUser, "must park the run");
    const rows = await db.select().from(approvals);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "vault_use");
    const payload = parseVaultUsePayload(rows[0].payload);
    assert.deepEqual(payload, { credentialId: meta.id, purpose: "přihlášení do GitHubu pro kontrolu repozitáře" });
    const dump = JSON.stringify(rows[0]);
    assert.ok(!dump.includes(SECRET), "approval row must not contain the secret");
    // Session is parked with a deep link to the pending approval.
    const sess = await db.select({ metadata: sessions.metadata }).from(sessions).where(eq(sessions.id, "sess-1"));
    const sessMeta = JSON.parse(sess[0].metadata);
    assert.equal(sessMeta.pendingApprovalId, rows[0].id);
    // Audit trail carries metadata only.
    const audits = await db.select().from(auditLog);
    assert.ok(audits.length >= 1);
    assert.ok(!JSON.stringify(audits).includes(SECRET), "audit log must not contain the secret");
    client.close();
  });

  it("rejects unknown credential ids", async () => {
    const { client, db } = await makeDb();
    await seedRun(db);
    const [, use] = createVaultTools(db, MASTER);
    const res = await use.execute({ credentialId: "nope", purpose: "dostatečně dlouhý účel" }, { actor });
    assert.ok(res.isError);
    client.close();
  });

  it("refuses a second request while one is pending", async () => {
    const { client, db } = await makeDb();
    await seedRun(db);
    const { use, meta } = await fileRequest(db);
    const res = await use.execute({ credentialId: meta.id, purpose: "jiný dostatečně dlouhý účel" }, { actor });
    assert.ok(res.isError && /čeká na schválení/.test(res.summary));
    client.close();
  });

  it("no grant exists before approval — nothing leaks", async () => {
    const { client, db } = await makeDb();
    await seedRun(db);
    await fileRequest(db);
    assert.equal(peekVaultGrant("sess-1"), undefined);
    assert.equal(consumeVaultGrant("sess-1"), undefined);
    const filled = consumeVaultGrantForFill("sess-1");
    assert.ok("error" in filled && typeof filled.error === "string");
    assert.ok(!filled.error.includes(SECRET));
    client.close();
  });
});

describe("vault_use decision handling", () => {
  async function approvedFixture(db, decision) {
    const meta = await createVaultCredential(db, MASTER, { service: "github.com", label: "osobní", username: "jerry", secret: SECRET });
    const [, use] = createVaultTools(db, MASTER);
    await use.execute({ credentialId: meta.id, purpose: "přihlášení do GitHubu pro kontrolu repozitáře" }, { actor });
    const rows = await db.select().from(approvals);
    const approval = rows[0];
    const decided = await decideApproval(db, approval.id, decision, "user-1");
    const inbound = await resolveVaultUseApproval(db, MASTER, {
      approvalId: approval.id,
      sessionId: decided.sessionId,
      summary: decided.summary,
      payload: decided.payload,
      decision,
      decidedByUserId: "user-1",
    });
    return { meta, approval, inbound };
  }

  it("approved: issues a single-use grant; secret never in inbound text, approval result, or audit", async () => {
    const { client, db } = await makeDb();
    await seedRun(db);
    const { approval, inbound } = await approvedFixture(db, "approved");
    assert.ok(!inbound.includes(SECRET), "inbound text must not contain the secret");
    assert.match(inbound, /SCHVÁLIL/);

    const grant = consumeVaultGrant("sess-1");
    assert.ok(grant, "grant must exist after approval");
    assert.equal(grant.secret, SECRET);
    assert.equal(grant.username, "jerry");
    assert.ok(grant.expiresAt - Date.now() <= VAULT_GRANT_TTL_MS);

    // Single-use: second consume finds nothing.
    assert.equal(consumeVaultGrant("sess-1"), undefined);

    const rows = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    assert.equal(rows[0].status, "approved");
    assert.ok(!String(rows[0].result).includes(SECRET), "approval result must not contain the secret");
    const dump = JSON.stringify(await db.select().from(auditLog));
    assert.ok(!dump.includes(SECRET), "audit log must not contain the secret");
    client.close();
  });

  it("rejected: no grant is issued and nothing leaks", async () => {
    const { client, db } = await makeDb();
    await seedRun(db);
    const { inbound } = await approvedFixture(db, "rejected");
    assert.match(inbound, /ZAMÍTL/);
    assert.ok(!inbound.includes(SECRET));
    assert.equal(consumeVaultGrant("sess-1"), undefined);
    assert.ok(!JSON.stringify(await db.select().from(auditLog)).includes(SECRET));
    client.close();
  });

  it("expired grants are unusable", async () => {
    issueVaultGrant("sess-9", { credentialId: "c", label: "l", username: "u", secret: SECRET, expiresAt: Date.now() - 1000 });
    assert.equal(consumeVaultGrant("sess-9"), undefined);
    assert.equal(peekVaultGrant("sess-9"), undefined);
  });

  it("deleting a credential revokes its outstanding grants", async () => {
    const { client, db } = await makeDb();
    await seedRun(db);
    const meta = await createVaultCredential(db, MASTER, { service: "s", label: "l", username: "u", secret: SECRET });
    issueVaultGrant("sess-1", { credentialId: meta.id, label: meta.label, username: meta.username, secret: SECRET, expiresAt: Date.now() + 60000 });
    await deleteVaultCredential(db, meta.id);
    revokeVaultGrantsForCredential(meta.id);
    assert.equal(consumeVaultGrant("sess-1"), undefined);
    client.close();
  });

  it("inbound formatters never include the secret", () => {
    const meta = { id: "c", service: "github.com", label: "osobní", username: "jerry", note: null, createdAt: new Date(), updatedAt: new Date() };
    assert.ok(!formatVaultUseApprovedInbound(meta).includes(SECRET));
    assert.ok(!formatVaultUseRejectedInbound(meta).includes(SECRET));
  });
});

describe("vaultFill in type tools", () => {
  it("browser_type vaultFill without a grant is refused", async () => {
    const [typeTool] = createBrowserTools().filter((t) => t.name === "browser_type");
    const ctx = { actor, audit: { record() {} } };
    const res = await typeTool.execute({ selector: "#password", vaultFill: true }, ctx);
    assert.ok(res.isError);
    assert.ok(!res.summary.includes(SECRET));
  });

  it("browser_type vaultFill substitutes the secret server-side; summary stays redacted", async () => {
    const { client, db } = await makeDb();
    await seedRun(db);
    const meta = await createVaultCredential(db, MASTER, { service: "github.com", label: "osobní", username: "jerry", secret: SECRET });
    issueVaultGrant("sess-1", { credentialId: meta.id, label: meta.label, username: meta.username, secret: SECRET, expiresAt: Date.now() + 60000 });

    let captured;
    const fakeBrowser = { act: async (action, params) => { captured = { action, params }; return { ok: true, data: {} }; } };
    const audits = [];
    const ctx = { actor, browser: fakeBrowser, audit: { record(e) { audits.push(e); } } };
    const [typeTool] = createBrowserTools().filter((t) => t.name === "browser_type");
    const res = await typeTool.execute({ selector: "#password", vaultFill: true }, ctx);

    assert.ok(!res.isError);
    assert.equal(captured.action, "type");
    assert.equal(captured.params.text, SECRET, "secret must reach the browser daemon");
    assert.ok(!res.summary.includes(SECRET), "tool result must stay redacted");
    assert.equal(consumeVaultGrant("sess-1"), undefined, "grant is single-use");
    const auditDump = JSON.stringify(audits);
    assert.ok(!auditDump.includes(SECRET), "audit must not contain the secret");
    assert.ok(audits.some((a) => a.action === "vault.fill"));
    client.close();
  });

  it("browser_type still rejects vaultFill combined with text", async () => {
    const [typeTool] = createBrowserTools().filter((t) => t.name === "browser_type");
    const res = await typeTool.execute({ selector: "#password", text: "x", vaultFill: true }, { actor, audit: { record() {} } });
    assert.ok(res.isError);
  });

  it("desktop_type vaultFill without a grant is refused", async () => {
    const [typeTool] = createDesktopTools({}, Buffer.alloc(32), {}).filter((t) => t.name === "desktop_type");
    let captured;
    const ctx = { actor, computer: { exec: async (input) => { captured = input; return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false }; } }, audit: { record() {} } };
    const res = await typeTool.execute({ vaultFill: true }, ctx);
    assert.ok(res.isError);
    assert.equal(captured, undefined, "no exec may run without a grant");
    assert.ok(!res.summary.includes(SECRET));
  });

  it("desktop_type vaultFill substitutes the secret; summary stays redacted", async () => {
    const { client, db } = await makeDb();
    await seedRun(db);
    const meta = await createVaultCredential(db, MASTER, { service: "s", label: "l", username: "u", secret: SECRET });
    issueVaultGrant("sess-1", { credentialId: meta.id, label: meta.label, username: meta.username, secret: SECRET, expiresAt: Date.now() + 60000 });

    let captured;
    const ctx = {
      actor,
      computer: { exec: async (input) => { captured = input; return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false }; } },
      audit: { record() {} },
    };
    const [typeTool] = createDesktopTools({}, Buffer.alloc(32), {}).filter((t) => t.name === "desktop_type");
    const res = await typeTool.execute({ vaultFill: true }, ctx);
    assert.ok(!res.isError);
    assert.ok(captured.args.join(" ").includes(SECRET), "secret must be substituted into the typed command");
    assert.ok(!res.summary.includes(SECRET), "tool result must stay redacted");
    client.close();
  });
});
