import { z } from "zod";
import { eq } from "drizzle-orm";
import { newId, type Database } from "../db/client.js";
import { agentMemoryAtoms, agents } from "../db/schema.js";
import { keywordsFor } from "../memory/tokenize.js";
import { defaultAgentPrompt } from "../agents/persona.js";
import { generateAvatarSpec } from "../agents/avatar.js";
import type { AgentToolDef } from "./tool-def.js";

const completeOnboardingSchema = z.object({
  agentName: z.string().min(1).max(80).describe("Jméno, které si uživatel zvolil pro agenta"),
  userName: z.string().min(1).max(80).describe("Jméno uživatele"),
});

/**
 * First-run onboarding tools. complete_onboarding is single-use: it is hidden
 * from the tool list (see tools/tool-port.ts) once agents.onboarded_at is set,
 * and it refuses to run twice.
 */
export function createOnboardingTools(db: Database): AgentToolDef[] {
  const completeOnboarding: AgentToolDef = {
    name: "complete_onboarding",
    description:
      "Dokončí úvodní představení: uloží jméno agenta a jméno uživatele do paměti a vygeneruje agentovi jedinečný avatar. Volej jen jednou, když znáš obě jména — po onboardingu už se na jména nikdy neptej.",
    inputSchema: completeOnboardingSchema,
    async execute(rawInput, ctx) {
      const input = completeOnboardingSchema.parse(rawInput);
      const agentId = ctx.actor.actorId;
      const rows = await db
        .select({ id: agents.id, name: agents.name, onboardedAt: agents.onboardedAt })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      const agent = rows[0];
      if (!agent) return { summary: "Agent nenalezen.", isError: true };
      if (agent.onboardedAt) {
        return { summary: `Onboarding už proběhl — jmenuješ se ${agent.name}. Už se na jména neptej.` };
      }
      const agentName = input.agentName.trim();
      const userName = input.userName.trim();
      if (!agentName || !userName) {
        return { summary: "Obě jména musí být neprázdná.", isError: true };
      }
      const avatar = generateAvatarSpec(agentName);
      const now = new Date();
      await db
        .update(agents)
        .set({
          name: agentName,
          systemPrompt: defaultAgentPrompt(agentName),
          avatar: JSON.stringify(avatar),
          onboardedAt: now,
        })
        .where(eq(agents.id, agentId));
      // The user's name is identity-grade memory: importance 5, never re-asked.
      const note = `Uživatel se jmenuje ${userName}. Oslovuj ho tak.`;
      await db.insert(agentMemoryAtoms).values({
        id: newId(),
        agentId,
        text: note.slice(0, 500),
        importance: 5,
        keywords: keywordsFor(note),
        createdAt: now,
      });
      return {
        summary: `Hotovo — odteď se jmenuješ ${agentName} a uživatel je ${userName}. Avatar vygenerován. Už se na jména nikdy neptej.`,
      };
    },
  };

  const regenerateAvatar: AgentToolDef = {
    name: "regenerate_avatar",
    description:
      "Vygeneruje agentovi nový jedinečný avatar (nový náhodný motiv). Volej, když o to uživatel požádá.",
    inputSchema: z.object({}),
    async execute(_rawInput, ctx) {
      const agentId = ctx.actor.actorId;
      const rows = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      if (!rows[0]) return { summary: "Agent nenalezen.", isError: true };
      const spec = generateAvatarSpec(rows[0].name ?? "agent");
      await db.update(agents).set({ avatar: JSON.stringify(spec) }).where(eq(agents.id, agentId));
      return { summary: "Avatar přegenerován — nový jedinečný motiv." };
    },
  };

  return [completeOnboarding, regenerateAvatar];
}
