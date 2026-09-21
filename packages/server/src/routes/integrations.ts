import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createRequire } from "node:module";
import path from "node:path";
import type { AppContext } from "../context.js";
import { mcpServers, oauthApps } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";
import { decryptSecret, encryptSecret, maskKey } from "../secrets/key-encryption.js";
import { CONNECTOR_CATALOG, getConnector, humanizeConnectorError, setupHelpFor, adminSetupHelpFor, copyableRelayUrlsFor, type ConnectorId } from "../mcp/catalog.js";
import { serverOAuthApp } from "../oauth/oauth-service.js";
import type { OAuthService } from "../oauth/oauth-service.js";
import { POLICY_MODE_CZ, TOOL_CLASS_CZ } from "../mcp/tool-policy.js";

const require = createRequire(import.meta.url);

/** Líně, až když je potřeba: chybějící balíček nesmí rozbít celý routes modul. */
function resolveConnectorServerPath(def: { id: string }): string | null {
  const pkgs: Record<string, string> = {
    presentation: "@kuclab-hertz/mcp-presentation/dist/server.js",
    gitlab: "@kuclab-hertz/mcp-gitlab/dist/server.js",
    todoist: "@kuclab-hertz/mcp-todoist/dist/server.js",
    openweather: "@kuclab-hertz/mcp-openweather/dist/server.js",
    rss: "@kuclab-hertz/mcp-rss/dist/server.js",
  };
  const pkg = pkgs[def.id];
  if (!pkg) return null;
  try {
    return require.resolve(pkg);
  } catch {
    return null;
  }
}

const CONNECTOR_IDS = CONNECTOR_CATALOG.map((d) => d.id) as [ConnectorId, ...ConnectorId[]];

const policySchema = z.object({
  /** "read-only" (výchozí, nejméně práv) nebo "read-write". */
  mode: z.enum(["read-only", "read-write"]).optional(),
  /** Per-tool allow/deny: { toolName: "allow" | "deny" }. Neuvedené nástroje se nemění. */
  tools: z.record(z.enum(["allow", "deny"])).optional(),
});

/** Všechny mcp_servers řádky patřící konektoru (podle spouštěného binárního souboru). */
async function rowsForConnector(ctx: AppContext, connectorId: ConnectorId) {
  const def = getConnector(connectorId);
  if (!def) return [];
  const rows = await ctx.db.select().from(mcpServers);
  return rows.filter((r) => {
    const args = r.argsJson ? (JSON.parse(r.argsJson) as string[]) : [];
    return (args[0] ?? "").endsWith(def.serverDistSuffix);
  });
}

/**
 * One-click integrations API: the catalog of available connectors (Google,
 * Notion, GitHub) with live connection status for Nastavení → Konektory,
 * plus one-click disconnect. Connecting happens through the OAuth routes
 * (browser consent); disconnecting deletes the stored (encrypted) tokens and
 * unregisters the MCP tools via the registry.
 */
export function registerIntegrationRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.get("/api/integrations", async () => {
      const appRows = await ctx.db.select().from(oauthApps);
      // Klíčováno prostým stringem: lokální konektory ("local") v oauthApps nikdy nejsou.
      const configuredByService = new Map<string, (typeof appRows)[number]>(appRows.map((r) => [r.service, r]));
      const display = await ctx.mcpRegistry.listAllForDisplay();

      return {
        connectors: CONNECTOR_CATALOG.map((def) => {
          const appRow = configuredByService.get(def.service);
          const servers = display.filter((s) => s.connectorId === def.id);
          const connectedServers = servers.filter((s) => s.enabled);
          return {
            id: def.id,
            service: def.service,
            local: !!def.local,
            credentialKind: def.credentialKind,
            credentialFields: def.credentialFields ?? null,
            name: def.name,
            tagline: def.tagline,
            description: def.description,
            capabilities: def.capabilities,
            setupUrl: def.setupUrl ?? null,
            setupUrlLabel: def.setupUrlLabel ?? null,
            setupHelp: setupHelpFor(def) ?? null,
            // Návod pro správce serveru (zapnutí OAuth přihlašování) — vidí ho jen admin.
            adminSetupHelp: adminSetupHelpFor(def) ?? null,
            // URL ke zkopírování v UI (tlačítko řeší frontend): když je zapnutý
            // OAuth relay, je to bounce URL jako redirect URI pro konzoli
            // poskytovatele. Jinak prázdné pole.
            copyableUrls: copyableRelayUrlsFor(def),
            appConfigured: !!appRow,
            // "Připojit" může vést rovnou na souhlas poskytovatele, když má
            // server přihlašovací údaje (uložené v DB, nebo od správce přes
            // HERTZ_OAUTH_* proměnné). Jinak UI nabídne jen krok pro správce.
            oauthReady: def.credentialKind === "oauth" ? !!appRow || !!serverOAuthApp(def.service as OAuthService) : null,
            // The client ID is public by OAuth design (it travels in the
            // authorize URL); the secret is never exposed, only a masked hint.
            clientId: appRow?.clientId ?? null,
            secretHint: appRow ? maskKey(decryptSecret(ctx.masterKey, appRow.encryptedClientSecret)) : null,
            connected: connectedServers.length > 0,
            servers: servers.map((s) => ({
              id: s.serverId,
              name: s.serverName,
              enabled: s.enabled,
              tools: s.tools,
              error: s.error ?? null,
              // Lidský důvod nefunkčnosti pro UI ("Nefunguje: …") — nikdy technický detail.
              errorHuman: s.error ? humanizeConnectorError(s.error) : null,
              policy: {
                mode: s.policy.mode,
                modeLabel: POLICY_MODE_CZ[s.policy.mode],
                tools: s.policy.tools.map((t) => ({ ...t, classLabel: TOOL_CLASS_CZ[t.class] })),
              },
            })),
          };
        }),
      };
    });

    // One-click disconnect: removes every MCP server row belonging to the
    // connector (deleting the encrypted tokens with it) and unregisters
    // its tools from the agent's toolset.
    instance.post("/api/integrations/:id/disconnect", async (request, reply) => {
      const parsed = z.enum(CONNECTOR_IDS).safeParse((request.params as { id: string }).id);
      if (!parsed.success) return reply.code(400).send({ error: "Neznámý konektor" });
      const def = getConnector(parsed.data);
      if (!def) return reply.code(400).send({ error: "Neznámý konektor" });

      const rows = await ctx.db.select().from(mcpServers);
      const matching = rows.filter((r) => {
        const args = r.argsJson ? (JSON.parse(r.argsJson) as string[]) : [];
        return (args[0] ?? "").endsWith(def.serverDistSuffix);
      });
      for (const row of matching) {
        await ctx.db.delete(mcpServers).where(eq(mcpServers.id, row.id));
        ctx.mcpRegistry.invalidate(row.id);
      }
      return { ok: true, removed: matching.length };
    });

    // One-click enable pro lokální konektory bez přihlášení (credentialKind
    // "none"): založí mcp_servers řádek se serverem běžícím na tomto stroji.
    // Výchozí politika je read-only (nejméně práv).
    instance.post("/api/integrations/:id/enable", async (request, reply) => {
      const parsed = z.enum(CONNECTOR_IDS).safeParse((request.params as { id: string }).id);
      if (!parsed.success) return reply.code(400).send({ error: "Neznámý konektor" });
      const def = getConnector(parsed.data);
      if (!def || def.credentialKind !== "none") return reply.code(400).send({ error: "Tento konektor vyžaduje přihlášení nebo API klíč." });

      const serverBin = resolveConnectorServerPath(def);
      if (!serverBin) return reply.code(500).send({ error: `Konektor ${def.name} není nainstalovaný (chybí jeho balíček).` });

      const env: Record<string, string> = {};
      // Výstupní adresář prezentací patří pod datový adresář aplikace.
      // (V testech se appka staví bez paths — server má vlastní výchozí adresář.)
      if (def.id === "presentation" && ctx.paths?.dataDir) env.PRESENTATION_OUTPUT_DIR = path.join(ctx.paths.dataDir, "presentations");

      const existing = await rowsForConnector(ctx, parsed.data);
      let serverId: string;
      if (existing[0]) {
        await ctx.db.update(mcpServers).set({ encryptedEnv: encryptSecret(ctx.masterKey, JSON.stringify(env)), enabled: true, name: def.name }).where(eq(mcpServers.id, existing[0].id));
        serverId = existing[0].id;
      } else {
        serverId = newId();
        await ctx.db.insert(mcpServers).values({
          id: serverId,
          agentId: null,
          name: def.name,
          transport: "stdio",
          command: "node",
          argsJson: JSON.stringify([serverBin]),
          encryptedEnv: encryptSecret(ctx.masterKey, JSON.stringify(env)),
          url: null,
          enabled: true,
          policyMode: "read-only",
          policyToolsJson: null,
          createdAt: new Date(),
        });
      }
      ctx.mcpRegistry.invalidate(serverId);
      return { ok: true, serverId };
    });

    // "Otestovat připojení": vynutí čerstvý pokus o spojení se všemi servery
    // konektoru a vrátí výsledek lidskou češtinou (připojeno / nefunguje + proč).
    instance.post("/api/integrations/:id/test", async (request, reply) => {
      const parsed = z.enum(CONNECTOR_IDS).safeParse((request.params as { id: string }).id);
      if (!parsed.success) return reply.code(400).send({ error: "Neznámý konektor" });
      const def = getConnector(parsed.data);
      if (!def) return reply.code(400).send({ error: "Neznámý konektor" });

      const rows = await rowsForConnector(ctx, parsed.data);
      if (rows.length === 0) return reply.code(404).send({ error: "Konektor není připojený" });

      const servers = [];
      for (const row of rows) {
        const t = await ctx.mcpRegistry.testConnection(row.id);
        servers.push({
          serverId: row.id,
          name: row.name,
          ok: t.ok,
          reason: t.ok ? null : humanizeConnectorError(t.error),
        });
      }
      return { ok: servers.every((s) => s.ok), servers };
    });

    const credentialsSchema = z.object({ values: z.record(z.string(), z.string()) });

    // Uložení API klíče pro apiKey konektory: hodnoty se uloží šifrovaně jako
    // env proměnné MCP serveru (nikdy se nevracejí v API) a server se
    // zaregistruje. Opakované uložení klíč přepíše.
    instance.post("/api/integrations/:id/credentials", async (request, reply) => {
      const parsed = z.enum(CONNECTOR_IDS).safeParse((request.params as { id: string }).id);
      if (!parsed.success) return reply.code(400).send({ error: "Neznámý konektor" });
      const def = getConnector(parsed.data);
      if (!def || def.credentialKind !== "apiKey") return reply.code(400).send({ error: "Tento konektor nepřijímá API klíč." });
      const body = credentialsSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Neplatný formát údajů" });

      const fields = def.credentialFields ?? [];
      const missing = fields.filter((f) => f.required !== false && !body.data.values[f.env]?.trim());
      if (missing.length > 0) {
        return reply.code(400).send({ error: `Chybí povinný údaj: ${missing.map((f) => f.label).join(", ")}` });
      }
      const serverBin = resolveConnectorServerPath(def);
      if (!serverBin) return reply.code(500).send({ error: `Konektor ${def.name} není nainstalovaný (chybí jeho balíček).` });

      const env: Record<string, string> = {};
      for (const f of fields) {
        const v = body.data.values[f.env]?.trim();
        if (v) env[f.env] = v;
      }

      const existing = await rowsForConnector(ctx, parsed.data);
      let serverId: string;
      if (existing[0]) {
        await ctx.db.update(mcpServers).set({ encryptedEnv: encryptSecret(ctx.masterKey, JSON.stringify(env)), enabled: true, name: def.name }).where(eq(mcpServers.id, existing[0].id));
        serverId = existing[0].id;
      } else {
        serverId = newId();
        await ctx.db.insert(mcpServers).values({
          id: serverId,
          agentId: null,
          name: def.name,
          transport: "stdio",
          command: "node",
          argsJson: JSON.stringify([serverBin]),
          encryptedEnv: encryptSecret(ctx.masterKey, JSON.stringify(env)),
          url: null,
          enabled: true,
          policyMode: "read-only",
          policyToolsJson: null,
          createdAt: new Date(),
        });
      }
      ctx.mcpRegistry.invalidate(serverId);
      return { ok: true, serverId };
    });

    // Per-konektor bezpečnostní politika: režim read-only / read-write
    // (výchozí read-only = nejméně práv) + per-tool allow/deny.
    // Citlivé operace (mazání, odesílání e-mailů, publikování, přepisování)
    // vyžadují schválení uživatele vždy — ani read-write je neobchází.
    instance.post("/api/integrations/:id/policy", async (request, reply) => {
      const parsed = z.enum(CONNECTOR_IDS).safeParse((request.params as { id: string }).id);
      if (!parsed.success) return reply.code(400).send({ error: "Neznámý konektor" });
      const body = policySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.message });

      const rows = await rowsForConnector(ctx, parsed.data);
      if (rows.length === 0) return reply.code(404).send({ error: "Konektor není připojený" });

      for (const row of rows) {
        const current = row.policyToolsJson ? (JSON.parse(row.policyToolsJson) as Record<string, string>) : {};
        // Ukládáme i explicitní "allow": v režimu read-only přepisuje zákaz zápisu.
        const merged = { ...current, ...(body.data.tools ?? {}) };
        await ctx.db
          .update(mcpServers)
          .set({
            ...(body.data.mode ? { policyMode: body.data.mode } : {}),
            policyToolsJson: Object.keys(merged).length > 0 ? JSON.stringify(merged) : null,
          })
          .where(eq(mcpServers.id, row.id));
        ctx.mcpRegistry.invalidate(row.id);
      }
      ctx.mcpRegistry.invalidateIndex();
      return { ok: true, updated: rows.length };
    });
  });
}
