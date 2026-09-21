import fs from "node:fs/promises";
import path from "node:path";
import type { HertzPaths } from "../paths.js";
import { agentSkillsDir, assertInside } from "../paths.js";

export interface DefaultSkill {
  name: string;
  description: string;
  instructions: string;
}

/**
 * Skills the agent is born with — the durable procedures behind "don't make
 * me explain twice, don't repeat mistakes". The agent reads the matching one
 * before acting (see the ## Your skills prompt block), and updates or extends
 * them with save_skill as its procedures improve. Seeded once per agent;
 * never overwritten after that, so agent/user edits always win.
 */
export const DEFAULT_SKILLS: DefaultSkill[] = [
  {
    name: "debugging",
    description: "Použij, kdykoliv něco selže, rozbije se nebo se chová divně — dřív, než začneš hádat opravu.",
    instructions: `## Debugging — find the cause, then fix it once

1. **Reproduce first.** Run the failing thing yourself and read the full error (message + stack + logs). Never fix from a guess about what "probably" broke.
2. **Isolate.** Narrow it down: which input, which file, which step? Bisect — disable halves until the failure follows one part.
3. **Read the code, don't assume.** Open the actual implementation and its tests. The bug is in what it DOES, not what it was meant to do.
4. **Fix the root cause**, not the symptom. If you catch yourself patching around the same area twice, stop — you haven't found it yet.
5. **Verify the fix** by re-running the reproduction from step 1, then the relevant tests.
6. **Durable lesson.** If this failure could recur (a gotcha, a wrong assumption, a fragile setup step), update this skill or save a new one with save_skill — future-you must not debug the same thing twice.`,
  },
  {
    name: "verify-before-done",
    description: "Použij, než uživateli řekneš, že je něco hotové, opravené nebo že to funguje.",
    instructions: `## Verify before done — proof, not promises

- **Run it, don't reason about it.** A fix is done when the failing command now passes in front of you — not when the code "looks right".
- **Show the evidence.** When you report completion, say what you ran and what it printed (test counts, exit codes, observed behavior).
- **Cover the edges you touched.** Changed an API? Hit the error paths too, not just the happy path. Changed UI text? Confirm where it renders.
- **Never claim what you didn't observe.** "Should work" means "not verified" — either verify it now or say plainly that you couldn't and what the user should check.
- **If verification is impossible here** (needs their hardware, their account, their network), say exactly which step they must run themselves.`,
  },
  {
    name: "web-research",
    description: "Použij, když potřebuješ aktuální fakta, dokumentaci, ceny nebo cokoliv mimo svá tréninková data.",
    instructions: `## Web research — search, then read the source

1. **Search first** by fetching \`https://html.duckduckgo.com/html/?q=<query>\` with web_fetch (web_fetch is a page fetcher, not a search engine — the DuckDuckGo HTML endpoint is the search step).
2. **Open the primary source.** Prefer official docs, changelogs, and the project's own repo over blog summaries. Fetch the actual page and quote what it says.
3. **Check the date.** Note when the source was written — APIs and prices change. If two sources disagree, the newer official one wins.
4. **Cite in your answer.** Link the pages you used so the user can verify; never present searched facts as if you always knew them.
5. **Save repeatable lookups.** If you find yourself researching the same topic twice, save a skill with the exact queries and sources that worked.`,
  },
  {
    name: "skills-over-memory",
    description: "Použij, když se rozhoduješ, kam patří ponaučení: do znovupoužitelného postupu (dovednost), nebo do obyčejného faktu (paměť).",
    instructions: `## Skills over memory — procedures live in skills, facts live in memory

- **A procedure you may repeat → save_skill.** Exact steps, commands, file paths, gotchas — written so following them reproduces the result. Examples: how you deploy project X, how you build the weekly report, how you fixed the VPN last time.
- **A fact worth recalling → remember.** Preferences, names, decisions, context ("user prefers dark UI", "production DB is on :5433"). Keep each atom one self-contained sentence.
- **Procedures change → update the skill.** save_skill with the same name overwrites: when a saved procedure fails or improves, fix the skill in the same turn. A stale skill is worse than none — it teaches future-you the wrong steps.
- **Before improvising, check.** Run list_skills (or glance at your ## Your skills index) when a task smells repeatable. Following a skill beats rediscovering it.
- **Name skills by the situation**, not the solution: \`vpn-fix\`, \`weekly-sales-report\`, \`deploy-hertz\` — future-you searches by problem.`,
  },
];

/**
 * Seed the default skills into the agent's home. Only writes skills that are
 * missing entirely — existing SKILL.md files (agent-written or user-edited)
 * are never touched. Returns the names that were created.
 */
export async function ensureDefaultSkills(paths: HertzPaths, projectId: string, agentId: string): Promise<string[]> {
  const root = agentSkillsDir(paths, projectId, agentId);
  await fs.mkdir(root, { recursive: true });
  const created: string[] = [];
  for (const skill of DEFAULT_SKILLS) {
    const dir = assertInside(root, path.join(root, skill.name), "skill");
    const file = path.join(dir, "SKILL.md");
    try {
      await fs.stat(file);
      continue; // already exists — agent or user owns it now
    } catch {
      /* missing → seed it */
    }
    await fs.mkdir(dir, { recursive: true });
    const frontmatter = `---\nname: ${skill.name}\ndescription: ${skill.description}\nupdated: ${new Date().toISOString()}\ndefault: true\n---\n\n`;
    await fs.writeFile(file, `${frontmatter}${skill.instructions}\n`, "utf8");
    created.push(skill.name);
  }
  return created;
}
