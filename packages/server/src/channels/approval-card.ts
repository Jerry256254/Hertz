import { parseHostAccessPayload } from "../tools/host-access-tools.js";
import { parseMcpOpPayload } from "../mcp/tool-policy.js";
import type { ApprovalCard } from "./types.js";

export interface ApprovalRowLike {
  summary: string;
  detail: string | null;
  kind: string;
  payload: string | null;
}

const HOST_OP_LABELS: Record<string, string> = {
  read: "přečíst soubor",
  rewrite: "přepsat soubor",
  create: "vytvořit soubor",
  delete: "smazat soubor či složku",
};

/**
 * Builds the approval card shown on chat channels: what the agent wants to do
 * plus a plain-Czech explanation of WHY it needs the user's say-so. The
 * reason is derived from the approval kind and its payload — the agent's own
 * summary/detail describe the action, this explains the risk.
 */
export function buildApprovalCard(row: ApprovalRowLike): ApprovalCard {
  let reason: string;
  switch (row.kind) {
    case "host_access": {
      const payload = parseHostAccessPayload(row.payload);
      reason = payload
        ? `Agent chce sáhnout mimo svůj pracovní prostor — ${HOST_OP_LABELS[payload.op] ?? payload.op} „${payload.hostPath}". Mimo vlastní soubory čtu i zapisuji jen s tvým svolením.`
        : "Agent chce pracovat se souborem mimo svůj pracovní prostor — proto se ptám předem.";
      break;
    }
    case "vault_use": {
      reason =
        "Agent potřebuje jednorázově použít uložené přihlašovací údaje z trezoru. Heslo nikdy neuvidí — ani on, ani se neobjeví v chatu; server ho jen jednou dosadí při vyplnění.";
      break;
    }
    case "mcp_op": {
      const payload = parseMcpOpPayload(row.payload);
      reason = payload
        ? `Agent chce přes konektor „${payload.serverName}" spustit citlivý nástroj „${payload.toolName}". Takové operace mohou měnit data mimo Hertz, proto je potvrzuješ ty.`
        : "Agent chce spustit citlivou operaci konektoru, která může měnit data mimo Hertz — proto se ptám předem.";
      break;
    }
    default:
      reason =
        "Akce může mít dopad mimo tento chat (odeslání zprávy, změna dat, kontaktování třetí strany…), proto ji bez tvého svolení neprovedu. V náhledu vidíš přesně, co by se stalo.";
  }
  return { summary: row.summary, detail: row.detail, reason };
}
