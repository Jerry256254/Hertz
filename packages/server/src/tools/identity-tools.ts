import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agents } from "../db/schema.js";
import type { AgentToolDef } from "./tool-def.js";

const MAX_TEXT = 20_000;

const soulSchema = z.object({
  soul: z
    .string()
    .min(1)
    .max(MAX_TEXT)
    .describe("Celý nový text tvé duše (SOUL.md) — kým jsi, tvoje hodnoty, tvůj vztah k člověku. Piš česky, bez emoji."),
  mode: z
    .enum(["rewrite", "append"])
    .optional()
    .default("rewrite")
    .describe("'rewrite' = nahradí celou duši novým textem; 'append' = připojí text na konec stávající duše"),
});

const userProfileSchema = z.object({
  userProfile: z
    .string()
    .min(1)
    .max(MAX_TEXT)
    .describe("Celý nový text obrazu uživatele (USER.md) — jeho jméno, oslovení, co má rád, hranice. Piš česky, bez emoji."),
  mode: z
    .enum(["rewrite", "append"])
    .optional()
    .default("rewrite")
    .describe("'rewrite' = nahradí celý profil novým textem; 'append' = připojí text na konec stávajícího profilu"),
});

async function loadCurrent(db: Database, agentId: string): Promise<{ soul: string | null; userProfile: string | null } | null> {
  const rows = await db
    .select({ soul: agents.soul, userProfile: agents.userProfile })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Nástroje, kterými agent sám udržuje svoji identitu: duši (SOUL.md) a trvalý
 * obraz uživatele (USER.md). Obě hodnoty se injektují do system promptu každý
 * tah (viz agents/system-prompt.ts), takže změna se projeví okamžitě.
 *
 * Pravidla, která nástroje agentovi předávají: duše = kým je on, profil =
 * kým je člověk; události a fakta z práce patří do paměti (remember), ne sem;
 * úpravy uživatele v UI mají vždy přednost.
 */
export function createIdentityTools(db: Database): AgentToolDef[] {
  const updateSoul: AgentToolDef = {
    name: "update_soul",
    description:
      "Přepíše nebo doplní tvoji duši (SOUL.md) — trvalý text o tom, kým jsi: tvoje identita, hodnoty, vztah k člověku. Volej, jen když ses o sobě naučil něco TRVALÉHO (ne momentální náladu ani fakta zrovna řešeného úkolu — ta patří do paměti přes remember). Úpravy uživatele v UI mají vždy přednost: duši čteš v system promptu, nikdy nepřepisuj to, co tam zapsal on, a nepolemizuj s tím.",
    inputSchema: soulSchema,
    async execute(rawInput, ctx) {
      const input = soulSchema.parse(rawInput);
      const current = await loadCurrent(db, ctx.actor.actorId);
      if (!current) return { summary: "Agent nenalezen.", isError: true };
      const next =
        input.mode === "append" && current.soul?.trim()
          ? `${current.soul.trim()}\n\n${input.soul.trim()}`
          : input.soul.trim();
      await db.update(agents).set({ soul: next }).where(eq(agents.id, ctx.actor.actorId));
      return {
        summary: input.mode === "append" ? "Duše doplněna — platí od dalšího tahu." : "Duše přepsána — platí od dalšího tahu.",
      };
    },
  };

  const updateUserProfile: AgentToolDef = {
    name: "update_user_profile",
    description:
      "Přepíše nebo doplní trvalý obraz tvého člověka (USER.md) — jeho jméno, jak ho oslovovat, co má rád, hranice. Volej, když se z konverzace dozvíš něco TRVALÉHO o něm (ne události a ne fakta zrovna řešeného úkolu — ta patří do paměti přes remember, jinak by se profil a paměť dublovaly). Jméno, které ti řekne, si zapamatuj a už se na něj nikdy neptej.",
    inputSchema: userProfileSchema,
    async execute(rawInput, ctx) {
      const input = userProfileSchema.parse(rawInput);
      const current = await loadCurrent(db, ctx.actor.actorId);
      if (!current) return { summary: "Agent nenalezen.", isError: true };
      const next =
        input.mode === "append" && current.userProfile?.trim()
          ? `${current.userProfile.trim()}\n\n${input.userProfile.trim()}`
          : input.userProfile.trim();
      await db.update(agents).set({ userProfile: next }).where(eq(agents.id, ctx.actor.actorId));
      return {
        summary:
          input.mode === "append"
            ? "Obraz uživatele doplněn — platí od dalšího tahu."
            : "Obraz uživatele přepsán — platí od dalšího tahu.",
      };
    },
  };

  return [updateSoul, updateUserProfile];
}
