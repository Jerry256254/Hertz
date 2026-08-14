import type { MessagePurpose } from "./ports.js";

/**
 * Rule-based model routing (purpose -> cheap/strong model). M1/M2 ship only a single
 * configured model per agent, so this is a pass-through; M3 wires cheapModel/strongModel
 * per-Agent and this function starts returning something other than `defaultModel`.
 */
export interface RoutingTable {
  defaultModel: string;
  cheapModel?: string;
}

export function selectModelForPurpose(table: RoutingTable, purpose: MessagePurpose): string {
  if (purpose === "summarization" || purpose === "title_generation" || purpose === "routing") {
    return table.cheapModel ?? table.defaultModel;
  }
  return table.defaultModel;
}
