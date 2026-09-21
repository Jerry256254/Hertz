import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { mcpServers, oauthApps } from "../db/schema.js";
import { requireAuth } from "../auth/plugin.js";
import { decryptSecret, maskKey } from "../secrets/key-encryption.js";
import { CONNECTOR_CATALOG, getConnector } from "../mcp/catalog.js";

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
      const configuredByService = new Map(appRows.map((r) => [r.service, r]));
      const display = await ctx.mcpRegistry.listAllForDisplay();

      return {
        connectors: CONNECTOR_CATALOG.map((def) => {
          const appRow = configuredByService.get(def.service);
          const servers = display.filter((s) => s.connectorId === def.id);
          const connectedServers = servers.filter((s) => s.enabled);
          return {
            id: def.id,
            service: def.service,
            name: def.name,
            tagline: def.tagline,
            description: def.description,
            capabilities: def.capabilities,
            setupUrl: def.setupUrl,
            setupUrlLabel: def.setupUrlLabel,
            setupHelp: def.setupHelp,
            appConfigured: !!appRow,
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
            })),
          };
        }),
      };
    });

    // One-click disconnect: removes every MCP server row belonging to the
    // connector (deleting the encrypted tokens with it) and unregisters
    // its tools from the agent's toolset.
    instance.post("/api/integrations/:id/disconnect", async (request, reply) => {
      const parsed = z.enum(["google", "notion", "github"]).safeParse((request.params as { id: string }).id);
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
  });
}
