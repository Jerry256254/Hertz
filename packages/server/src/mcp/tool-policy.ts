/**
 * Per-konektor bezpečnostní politika pro MCP nástroje.
 *
 * - Režim konektoru: "read-only" (výchozí — nejméně práv) vs. "read-write".
 * - Per-tool allow/deny: uživatel může jednotlivé nástroje povolit/zakázat.
 * - Citlivé operace (mazání, odesílání e-mailů, publikování, přepisování)
 *   VŽDY vyžadují schválení uživatelem přes approval flow — i v read-write
 *   režimu.
 *
 * Čistá logika bez závislostí na DB: vynucení probíhá v McpRegistry,
 * schvalování přes existující approvals tabulku (kind = "mcp_op").
 */

export type PolicyMode = "read-only" | "read-write";
export type ToolAccess = "allow" | "deny";
/** read = jen čte, write = mění stav, sensitive = mění stav + vždy vyžaduje schválení. */
export type ToolClass = "read" | "write" | "sensitive";

export interface ConnectorPolicy {
  mode: PolicyMode;
  /** toolName -> "deny"; chybějící klíč = allow. */
  tools: Record<string, ToolAccess>;
}

export function defaultPolicy(): ConnectorPolicy {
  return { mode: "read-only", tools: {} };
}

export function parsePolicy(mode: unknown, toolsJson: unknown): ConnectorPolicy {
  const policy = defaultPolicy();
  if (mode === "read-write" || mode === "read-only") policy.mode = mode;
  if (typeof toolsJson === "string" && toolsJson.trim() !== "") {
    try {
      const parsed = JSON.parse(toolsJson) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (v === "deny" || v === "allow") policy.tools[k] = v;
      }
    } catch {
      /* poškozené JSON = výchozí politika */
    }
  }
  return policy;
}

/** Nástroje, které jsou citlivé vždy (bez ohledu na heuristiku níže). */
const SENSITIVE_TOOLS = new Set([
  "gmail_send_message", // odeslání e-mailu
  "calendar_delete_event", // mazání
  "sheets_write_range", // přepisování buněk
]);

/** Heuristika pro zápisové operace (názvy nástrojů ve stylu sloveso_podstatné). */
const WRITE_PATTERN = /(^|_)(create|add|insert|update|edit|append|write|upload|share|trash|archive|rename|move)($|_)/;
/** Heuristika pro citlivé operace — platí i pro cizí/ruční MCP servery. */
const SENSITIVE_PATTERN = /(^|_)(delete|remove|destroy|send|publish|unpublish|revoke)($|_)/;

export function classifyTool(toolName: string): ToolClass {
  const name = toolName.toLowerCase();
  if (SENSITIVE_TOOLS.has(name) || SENSITIVE_PATTERN.test(name)) return "sensitive";
  if (WRITE_PATTERN.test(name)) return "write";
  return "read";
}

export type EnforcementOutcome =
  | { verdict: "allow" }
  | { verdict: "deny-tool" }
  | { verdict: "deny-read-only" }
  | { verdict: "approval-required" };

/**
 * Rozhodne, zda se MCP nástroj smí spustit.
 * Pořadí: explicitní deny > citlivé (vždy approval) > write v read-only > allow.
 * Explicitní "allow" u nástroje přepíše režim read-only — tak funguje per-tool
 * povolení v UI. Citlivé operace ale vyžadují schválení vždy (ani allow je
 * neobchází).
 */
export function enforcePolicy(policy: ConnectorPolicy, toolName: string): EnforcementOutcome {
  const access = policy.tools[toolName];
  if (access === "deny") return { verdict: "deny-tool" };
  const cls = classifyTool(toolName);
  if (cls === "sensitive") return { verdict: "approval-required" };
  if (cls === "write" && policy.mode === "read-only" && access !== "allow") return { verdict: "deny-read-only" };
  return { verdict: "allow" };
}

/** Lidsky čitelné české popisky pro UI. */
export const POLICY_MODE_CZ: Record<PolicyMode, string> = {
  "read-only": "Jen čtení",
  "read-write": "Čtení a zápis",
};

export const TOOL_CLASS_CZ: Record<ToolClass, string> = {
  read: "Čtení",
  write: "Zápis",
  sensitive: "Citlivé",
};

export function describeForAgent(toolName: string, cls: ToolClass, mode: PolicyMode): string | null {
  if (cls === "sensitive") {
    return "Citlivá operace — před spuštěním se vždy zobrazí žádost o schválení uživateli; bez schválení se nespustí.";
  }
  if (cls === "write" && mode === "read-only") {
    return "Zápisová operace — konektor je v režimu jen pro čtení, takže je zablokovaná (lze přepnout v Nastavení → Konektory).";
  }
  return null;
}

/** Payload approval žádosti kind="mcp_op" (JSON v approvals.payload). */
export interface McpOpPayload {
  serverId: string;
  serverName: string;
  toolName: string;
  input: unknown;
}

export function parseMcpOpPayload(raw: string | null): McpOpPayload | undefined {
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as Partial<McpOpPayload>;
    if (typeof p.serverId === "string" && typeof p.toolName === "string" && typeof p.serverName === "string") {
      return { serverId: p.serverId, serverName: p.serverName, toolName: p.toolName, input: p.input };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
