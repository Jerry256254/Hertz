import { z } from "zod";
import type { SubagentManager, SubagentRecord } from "../agents/subagents.js";
import type { AgentToolDef } from "./tool-def.js";

const spawnSchema = z.object({
  task: z.string().min(1).describe("Zadání pro podagenta — co má samostatně udělat"),
  label: z.string().max(80).optional().describe("Krátký název úkolu pro přehled"),
  context: z.string().optional().describe("Doplňující kontext, který podagent potřebuje znát"),
  output_schema: z
    .record(z.unknown())
    .optional()
    .describe("JSON Schema očekávaného výstupu — podagent ho vidí předem a musí ho dodržet"),
  max_turns: z.number().int().positive().max(200).optional().describe("Limit tahů podagenta (výchozí 50)"),
});

const idSchema = z.object({
  subagent_id: z.string().min(1).describe("Id podagenta z výstupu spawn_subagent"),
});

const sendSchema = idSchema.extend({
  message: z.string().min(1).describe("Doplňující instrukce pro běžícího podagenta"),
});

function describe(r: SubagentRecord): string {
  const state =
    r.status === "pending"
      ? "čeká ve frontě"
      : r.status === "running"
        ? `běží${r.progress ? ` (${r.progress})` : ""}`
        : r.status === "done"
          ? "hotovo — výsledek ti byl doručen do této konverzace"
          : r.status === "failed"
            ? `selhal${r.error ? `: ${r.error}` : ""}`
            : "zastaven";
  return `„${r.label}" [id: ${r.id}] — ${state}`;
}

/**
 * Delegation tools: the main agent spawns background subagents that work in
 * parallel while it stays responsive in chat. Each subagent runs as an
 * isolated session with the same agent (same permissions, same project, same
 * approval flow) — it cannot escalate beyond what the parent agent may do.
 */
export function createSubagentTools(getManager: () => SubagentManager): AgentToolDef[] {
  const spawnSubagent: AgentToolDef = {
    name: "spawn_subagent",
    description:
      "Spusť podagenta na pozadí se samostatným úkolem. Okamžitě se vrátí s jeho id — zatímco pracuje (paralelně s ostatními podagenty), ty normálně pokračuješ v konverzaci s uživatelem. Jakmile skončí, jeho výsledek ti doručím do této konverzace a ty ho shrneš uživateli. Vhodné pro nezávislé dílčí úkoly (rešerše, analýzy, přípravy). Podagent dědí tvá oprávnění i tvůj pracovní kontext, ale nemůže je rozšířit.",
    inputSchema: spawnSchema,
    async execute(rawInput, ctx) {
      const input = spawnSchema.parse(rawInput);
      const parentSessionId = ctx.actor.sessionId;
      if (!parentSessionId) return { summary: "Chyba: nástroj lze volat jen z konverzace.", isError: true };
      const record = await getManager().spawn(
        {
          parentSessionId,
          agentId: ctx.actor.actorId,
          projectId: ctx.actor.projectId ?? "",
          userId: ctx.actor.userId ?? "",
        },
        {
          task: input.task,
          label: input.label,
          context: input.context,
          outputSchema: input.output_schema as Record<string, unknown> | undefined,
          maxTurns: input.max_turns,
        },
      );
      return {
        summary: `Podagent spuštěn: ${describe(record)}. Pokračuj v konverzaci — výsledek ti doručím, jakmile bude hotový.`,
      };
    },
  };

  const listSubagents: AgentToolDef = {
    name: "list_subagents",
    description:
      "Vypiš podagenty spuštěné z této konverzace — jejich stav (čeká/běží/hotovo/selhal/zastaven), na čem pracují a jejich id pro další nástroje.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const parentSessionId = ctx.actor.sessionId;
      if (!parentSessionId) return { summary: "Chyba: nástroj lze volat jen z konverzace.", isError: true };
      const records = getManager().listForParent(parentSessionId);
      if (records.length === 0) return { summary: "Z této konverzace neběží žádní podagenti." };
      return { summary: records.map(describe).join("\n") };
    },
  };

  const subagentStatus: AgentToolDef = {
    name: "subagent_status",
    description: "Zjisti podrobný stav jednoho podagenta: fázi, průběh a případně jeho výsledek nebo chybu.",
    inputSchema: idSchema,
    async execute(rawInput, ctx) {
      const input = idSchema.parse(rawInput);
      const parentSessionId = ctx.actor.sessionId ?? "";
      const record = getManager().get(input.subagent_id);
      if (!record || record.parentSessionId !== parentSessionId) {
        return { summary: "Podagent nebyl v této konverzaci nalezen.", isError: true };
      }
      const lines = [describe(record), `Zadání: ${record.task}`];
      if (record.result) lines.push(`Výsledek: ${record.result.slice(0, 2000)}`);
      if (record.schemaFailureNote) lines.push(record.schemaFailureNote);
      return { summary: lines.join("\n") };
    },
  };

  const sendToSubagent: AgentToolDef = {
    name: "send_to_subagent",
    description:
      "Pošli běžícímu (nebo čekajícímu) podagentovi doplňující instrukce či upřesnění úkolu. Nepřerušuje jeho práci — zprávu zpracuje při nejbližší příležitosti.",
    inputSchema: sendSchema,
    async execute(rawInput, ctx) {
      const input = sendSchema.parse(rawInput);
      const parentSessionId = ctx.actor.sessionId ?? "";
      try {
        const record = await getManager().send(input.subagent_id, parentSessionId, input.message);
        return { summary: `Odesláno podagentovi ${describe(record)}.` };
      } catch (err) {
        return { summary: (err as Error).message, isError: true };
      }
    },
  };

  const stopSubagent: AgentToolDef = {
    name: "stop_subagent",
    description:
      "Zastav podagenta — přeruší jeho běžící práci (nebo ho vyřadí z fronty). Už hotovému podagentovi výsledek zůstává; zastavený žádný výsledek nedoručí.",
    inputSchema: idSchema,
    async execute(rawInput, ctx) {
      const input = idSchema.parse(rawInput);
      const parentSessionId = ctx.actor.sessionId ?? "";
      try {
        const record = await getManager().stop(input.subagent_id, parentSessionId);
        return { summary: `Podagent zastaven: ${describe(record)}.` };
      } catch (err) {
        return { summary: (err as Error).message, isError: true };
      }
    },
  };

  return [spawnSubagent, listSubagents, subagentStatus, sendToSubagent, stopSubagent];
}
