import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { AgentLoopManager } from "@kuclab-hertz/core";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import {
  agentMemoryAtoms,
  agents,
  channelBindings,
  channelConfigs,
  providerConfigs,
  sessions,
} from "../db/schema.js";
import type { HertzPaths } from "../paths.js";
import { forgetById, searchMemory } from "../memory/recall.js";
import { keywordsFor } from "../memory/tokenize.js";
import { removeAtomVector } from "../memory/vector-store.js";
import { skillsIndexFor } from "../tools/skill-tools.js";
import { parseChannelCommand, type InboundMessage } from "./types.js";
import type { TelegramDriver } from "./telegram.js";
import { screenLinkFor } from "./screen-link.js";

/**
 * Everything the bot can manage over Telegram, in Czech, without emoji.
 * Pure command layer: the ChannelManager implements TelegramCommandEnv and
 * hands it over per incoming message / callback query.
 */
export interface TelegramCommandEnv {
  db: Database;
  masterKey: Buffer;
  agentLoop: AgentLoopManager;
  paths: HertzPaths;
  fallbackUserId: () => Promise<string>;
  configId: string;
  configLabel: string;
  driver: TelegramDriver;
  /** The chat's bound session, creating one when needed (undefined = no default agent). */
  ensureSession(externalChatId: string, senderLabel: string): Promise<string | undefined>;
  /** The chat's bound session id, without creating one. */
  boundSessionId(externalChatId: string): Promise<string | undefined>;
  /** Restart the inbound poll loop (keeps the backlog). */
  restartPolling(): Promise<void>;
  /** Enable/disable this channel config (reloads the manager). */
  setEnabled(enabled: boolean): Promise<void>;
  /** Wipe the bound session's messages. Returns false when there is no bound chat. */
  clearChat(externalChatId: string): Promise<boolean>;
  /**
   * Decide a pending approval exactly like the WebUI inbox does (host_access
   * ops are executed by the server, not the agent). Returns the user-facing
   * reply text, or undefined when the approval is no longer pending.
   */
  decide(externalChatId: string, approvalId: string, decision: "approved" | "rejected"): Promise<string | undefined>;
  pendingApprovals(sessionId: string): Promise<Array<{ id: string; summary: string; detail: string | null }>>;
  /** Best-effort: make sure the agent's desktop (noVNC) is up. */
  startDesktop(agentId: string): Promise<void>;
  /** True while the long-poll loop is up. */
  botPolling(): boolean;
}

/** Commands that must be alone on the line — with args the text goes to the agent. */
const NO_ARG_COMMANDS = new Set([
  "pomoc",
  "stav",
  "restart",
  "odpojit",
  "novy",
  "vycistit",
  "chaty",
  "pamet",
  "skilly",
  "pauza",
  "pokracuj",
  "schvaleni",
  "obrazovka",
]);

export function telegramHelpText(): string {
  return [
    `**Co umím**`,
    ``,
    `/stav — stav bota, agenta a chatu`,
    `/obrazovka — odkaz na živý náhled počítače agenta`,
    `/novy — začít nový chat`,
    `/vycistit — smazat historii chatu (paměť zůstává)`,
    `/jmeno <jméno> — přejmenovat agenta`,
    `/model [model-id] — změnit model / poskytovatele`,
    `/rezim <plan|auto|autonomni> — režim práce agenta`,
    `/chaty — přepínat mezi chaty`,
    `/pamet — vypsat paměť`,
    `/zapamatuj <text> — uložit do paměti`,
    `/zapomen <id> — zapomenout poznámku`,
    `/hledej <dotaz> — hledat v paměti`,
    `/skilly — seznam skillů`,
    `/pauza, /pokracuj — pozastavit / obnovit práci`,
    `/schvaleni — čekající schválení`,
    `/schvalit <id>, /zamitnout <id> — rozhodnout schválení`,
    `/restart — restartovat příjem zpráv`,
    `/odpojit — odpojit bota`,
    ``,
    `Všechno ostatní beru jako zprávu pro agenta.`,
  ].join("\n");
}

const MODE_LABELS: Record<string, string> = { plan: "plánování", auto: "auto", autonomous: "autonomní" };

function parseModeArg(args: string): "plan" | "auto" | "autonomous" | undefined {
  const a = args.toLowerCase();
  if (a === "plan" || a === "plánování" || a === "planovani") return "plan";
  if (a === "auto") return "auto";
  if (a === "autonomous" || a === "autonomni" || a === "autonomní") return "autonomous";
  return undefined;
}

async function sessionAgent(env: TelegramCommandEnv, sessionId: string) {
  const sRows = await env.db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const session = sRows[0];
  if (!session) return undefined;
  const aRows = await env.db.select().from(agents).where(eq(agents.id, session.agentId)).limit(1);
  const agent = aRows[0];
  if (!agent) return undefined;
  const pRows = await env.db.select().from(providerConfigs).where(eq(providerConfigs.id, agent.providerConfigId)).limit(1);
  return { session, agent, provider: pRows[0] };
}

async function needSession(env: TelegramCommandEnv, msg: InboundMessage): Promise<string | undefined> {
  const sessionId = await env.ensureSession(msg.externalChatId, msg.senderLabel);
  if (!sessionId) {
    await env.driver.sendText(
      msg.externalChatId,
      "Nejdřív nastav výchozího agenta na stránce Kanály ve webovém rozhraní.",
    );
  }
  return sessionId;
}

async function cmdPomoc(env: TelegramCommandEnv, msg: InboundMessage): Promise<void> {
  await env.driver.sendText(msg.externalChatId, telegramHelpText());
}

async function cmdStav(env: TelegramCommandEnv, msg: InboundMessage): Promise<void> {
  const sessionId = await env.boundSessionId(msg.externalChatId);
  const lines = [`**Stav**`, ``, `Bot: ${env.configLabel} (${env.botPolling() ? "příjem běží" : "příjem neběží"})`];
  if (sessionId) {
    const info = await sessionAgent(env, sessionId);
    if (info) {
      const pending = await env.pendingApprovals(sessionId);
      lines.push(
        `Agent: **${info.agent.name}**`,
        `Model: ${info.provider ? `${info.provider.label} (${info.provider.provider})` : "?"}, ${info.agent.model}`,
        `Režim: ${MODE_LABELS[info.session.mode] ?? info.session.mode}`,
        `Chat: ${info.session.title} (${info.session.status})`,
        pending.length > 0 ? `Čekající schválení: ${pending.length} (viz /schvaleni)` : `Čekající schválení: žádná`,
      );
    }
  } else {
    lines.push(`Zatím tu není žádný chat — napiš zprávu a začneme.`);
  }
  await env.driver.sendText(msg.externalChatId, lines.join("\n"));
}

async function cmdRestart(env: TelegramCommandEnv, msg: InboundMessage): Promise<void> {
  await env.restartPolling();
  await env.driver.sendText(msg.externalChatId, "Hotovo — příjem zpráv běží znovu.");
}

async function cmdOdpojit(env: TelegramCommandEnv, msg: InboundMessage): Promise<void> {
  await env.driver.sendButtons(
    msg.externalChatId,
    "Opravdu odpojit bota? Přestane odpovídat. Znovu ho připojíš na stránce Kanály ve webovém rozhraní.",
    [
      [
        { label: "Ano, odpojit", data: "tgcmd:odpojit:ano" },
        { label: "Zrušit", data: "tgcmd:odpojit:ne" },
      ],
    ],
  );
}

async function cmdNovy(env: TelegramCommandEnv, msg: InboundMessage): Promise<void> {
  await env.db
    .delete(channelBindings)
    .where(and(eq(channelBindings.channelId, env.configId), eq(channelBindings.externalChatId, msg.externalChatId)));
  await env.driver.sendText(msg.externalChatId, "Začínám nový chat — o čem si budeme povídat?");
}

async function cmdVycistit(env: TelegramCommandEnv, msg: InboundMessage): Promise<void> {
  const cleared = await env.clearChat(msg.externalChatId);
  await env.driver.sendText(
    msg.externalChatId,
    cleared ? "Chat vymazán. Paměť, skilly a poznámky zůstávají." : "Není co mazat — tady zatím žádný aktivní chat není.",
  );
}

async function cmdJmeno(env: TelegramCommandEnv, msg: InboundMessage, args: string): Promise<void> {
  if (!args) {
    await env.driver.sendText(msg.externalChatId, "Použití: /jmeno <jméno>");
    return;
  }
  const sessionId = await needSession(env, msg);
  if (!sessionId) return;
  const info = await sessionAgent(env, sessionId);
  if (!info) return;
  const name = args.slice(0, 60);
  await env.db.update(agents).set({ name }).where(eq(agents.id, info.agent.id));
  await env.driver.sendText(msg.externalChatId, `Hotovo, od teď jsem **${name}**.`);
}

async function cmdModel(env: TelegramCommandEnv, msg: InboundMessage, args: string): Promise<void> {
  const modelId = args.trim();
  if (modelId) {
    // Direct model id on the current provider — no picker round-trip needed.
    const sessionId = await needSession(env, msg);
    if (!sessionId) return;
    const info = await sessionAgent(env, sessionId);
    if (!info) return;
    const pcRows = await env.db.select().from(providerConfigs).where(eq(providerConfigs.id, info.agent.providerConfigId)).limit(1);
    const pc = pcRows[0];
    await env.db.update(agents).set({ model: modelId.slice(0, 120) }).where(eq(agents.id, info.agent.id));
    await env.driver.sendText(
      msg.externalChatId,
      `Model nastaven: **${modelId.slice(0, 120)}**${pc ? ` (${pc.label})` : ""}.`,
    );
    return;
  }
  const configs = await env.db.select().from(providerConfigs).orderBy(asc(providerConfigs.label));
  if (configs.length === 0) {
    await env.driver.sendText(
      msg.externalChatId,
      "Žádný poskytovatel není nastavený — přidej ho ve webovém rozhraní (Nastavení → Poskytovatelé).",
    );
    return;
  }
  const buttons = configs.map((c) => [{ label: `${c.label} (${c.provider})`, data: `tgcmd:model:${c.id}` }]);
  await env.driver.sendButtons(msg.externalChatId, "Vyber model / poskytovatele:", buttons);
}

async function cmdRezim(env: TelegramCommandEnv, msg: InboundMessage, args: string): Promise<void> {
  const sessionId = await needSession(env, msg);
  if (!sessionId) return;
  const mode = parseModeArg(args);
  if (!mode) {
    const rows = await env.db.select({ mode: sessions.mode }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    await env.driver.sendText(
      msg.externalChatId,
      `Aktuální režim: **${MODE_LABELS[rows[0]?.mode ?? ""] ?? rows[0]?.mode}**.\nPoužití: /rezim <plan|auto|autonomni>\n- plan — agent jen přemýšlí a odpovídá, žádné nástroje\n- auto — plný přístup k nástrojům, když potřebuje, zeptá se\n- autonomni — pracuje, dokud není hotovo, neptá se`,
    );
    return;
  }
  await env.db.update(sessions).set({ mode, updatedAt: new Date() }).where(eq(sessions.id, sessionId));
  await env.driver.sendText(msg.externalChatId, `Režim nastaven: **${MODE_LABELS[mode]}**.`);
}

async function cmdChaty(env: TelegramCommandEnv, msg: InboundMessage): Promise<void> {
  const sessionId = await needSession(env, msg);
  if (!sessionId) return;
  const info = await sessionAgent(env, sessionId);
  if (!info) return;
  const rows = await env.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.agentId, info.agent.id), ne(sessions.status, "archived")))
    .orderBy(desc(sessions.updatedAt))
    .limit(10);
  if (rows.length === 0) {
    await env.driver.sendText(msg.externalChatId, "Žádné chaty tu zatím nejsou.");
    return;
  }
  const buttons = rows.map((s) => [
    { label: `${s.id === sessionId ? "> " : ""}${s.title.slice(0, 40)}`, data: `tgcmd:chat:${s.id}` },
  ]);
  await env.driver.sendButtons(msg.externalChatId, "Vyber chat:", buttons);
}

async function cmdPamet(env: TelegramCommandEnv, msg: InboundMessage): Promise<void> {
  const sessionId = await needSession(env, msg);
  if (!sessionId) return;
  const info = await sessionAgent(env, sessionId);
  if (!info) return;
  const atoms = await env.db
    .select()
    .from(agentMemoryAtoms)
    .where(eq(agentMemoryAtoms.agentId, info.agent.id))
    .orderBy(asc(agentMemoryAtoms.createdAt))
    .limit(50);
  if (atoms.length === 0) {
    await env.driver.sendText(msg.externalChatId, "Paměť je prázdná. Ulož něco příkazem /zapamatuj <text>.");
    return;
  }
  const lines = [`**Paměť** (${atoms.length}):`, ``];
  for (const a of atoms) lines.push(`\`${a.id.slice(0, 8)}\` ${a.text}`);
  await env.driver.sendText(msg.externalChatId, lines.join("\n"));
}

async function cmdZapamatuj(env: TelegramCommandEnv, msg: InboundMessage, args: string): Promise<void> {
  if (!args) {
    await env.driver.sendText(msg.externalChatId, "Použití: /zapamatuj <text>");
    return;
  }
  const sessionId = await needSession(env, msg);
  if (!sessionId) return;
  const info = await sessionAgent(env, sessionId);
  if (!info) return;
  await env.db.insert(agentMemoryAtoms).values({
    id: newId(),
    agentId: info.agent.id,
    text: args.slice(0, 500),
    importance: 3,
    keywords: keywordsFor(args),
    createdAt: new Date(),
  });
  await env.driver.sendText(msg.externalChatId, "Uloženo do paměti.");
}

async function cmdZapomen(env: TelegramCommandEnv, msg: InboundMessage, args: string): Promise<void> {
  if (!args) {
    await env.driver.sendText(msg.externalChatId, "Použití: /zapomen <id> (id zjistíš příkazem /pamet)");
    return;
  }
  const sessionId = await needSession(env, msg);
  if (!sessionId) return;
  const info = await sessionAgent(env, sessionId);
  if (!info) return;
  const atoms = await env.db
    .select({ id: agentMemoryAtoms.id })
    .from(agentMemoryAtoms)
    .where(eq(agentMemoryAtoms.agentId, info.agent.id));
  const matches = atoms.filter((a) => a.id === args || a.id.startsWith(args));
  if (matches.length === 0) {
    await env.driver.sendText(msg.externalChatId, "Takovou poznámku v paměti nemám — zkontroluj id příkazem /pamet.");
    return;
  }
  if (matches.length > 1) {
    await env.driver.sendText(msg.externalChatId, `Předpona odpovídá ${matches.length} poznámkám — upřesni delší část id.`);
    return;
  }
  const deleted = await forgetById(env.db, info.agent.id, matches[0]!.id);
  if (deleted) {
    try {
      removeAtomVector(env.paths, matches[0]!.id);
    } catch {
      /* vector cleanup is best-effort */
    }
    await env.driver.sendText(msg.externalChatId, "Zapomenuto.");
  } else {
    await env.driver.sendText(msg.externalChatId, "Poznámku se nepodařilo smazat.");
  }
}

async function cmdHledej(env: TelegramCommandEnv, msg: InboundMessage, args: string): Promise<void> {
  if (!args) {
    await env.driver.sendText(msg.externalChatId, "Použití: /hledej <dotaz>");
    return;
  }
  const sessionId = await needSession(env, msg);
  if (!sessionId) return;
  const info = await sessionAgent(env, sessionId);
  if (!info) return;
  const hits = await searchMemory(env.db, info.agent.id, args, env.paths);
  if (hits.length === 0) {
    await env.driver.sendText(msg.externalChatId, `Na dotaz "${args}" jsem v paměti nic nenašel.`);
    return;
  }
  const lines = [`**Výsledky hledání** (${hits.length}):`, ``];
  for (const h of hits.slice(0, 5)) lines.push(`- [${h.layer}] ${h.text}`);
  await env.driver.sendText(msg.externalChatId, lines.join("\n"));
}

async function cmdSkilly(env: TelegramCommandEnv, msg: InboundMessage): Promise<void> {
  const sessionId = await needSession(env, msg);
  if (!sessionId) return;
  const info = await sessionAgent(env, sessionId);
  if (!info) return;
  const index = await skillsIndexFor(env.paths, info.session.projectId, info.agent.id);
  if (index.length === 0) {
    await env.driver.sendText(msg.externalChatId, "Žádné skilly tu zatím nejsou.");
    return;
  }
  const lines = [`**Skilly** (${index.length}):`, ``];
  for (const s of index) lines.push(`- **${s.name}** — ${s.description || "bez popisu"}`);
  await env.driver.sendText(msg.externalChatId, lines.join("\n"));
}

async function cmdPauza(env: TelegramCommandEnv, msg: InboundMessage): Promise<void> {
  const sessionId = await env.boundSessionId(msg.externalChatId);
  if (!sessionId || !env.agentLoop.isRunning(sessionId)) {
    await env.driver.sendText(msg.externalChatId, "Teď nic neběží — není co pozastavit.");
    return;
  }
  await env.agentLoop.pause(sessionId);
  await env.driver.sendText(msg.externalChatId, "Pozastaveno. Práci obnovíš příkazem /pokracuj.");
}

async function cmdPokracuj(env: TelegramCommandEnv, msg: InboundMessage): Promise<void> {
  const sessionId = await env.boundSessionId(msg.externalChatId);
  if (!sessionId) {
    await env.driver.sendText(msg.externalChatId, "Tady zatím žádný chat není.");
    return;
  }
  const resumed = await env.agentLoop.resume(sessionId);
  await env.driver.sendText(
    msg.externalChatId,
    resumed ? "Pokračuji v práci." : "Není co obnovit — nic není pozastavené.",
  );
}

async function cmdSchvaleni(env: TelegramCommandEnv, msg: InboundMessage): Promise<void> {
  const sessionId = await env.boundSessionId(msg.externalChatId);
  if (!sessionId) {
    await env.driver.sendText(msg.externalChatId, "Tady zatím žádný chat není.");
    return;
  }
  const pending = await env.pendingApprovals(sessionId);
  if (pending.length === 0) {
    await env.driver.sendText(msg.externalChatId, "Žádná čekající schválení.");
    return;
  }
  for (const a of pending) {
    await env.driver.sendApproval(msg.externalChatId, a.id, a.summary, a.detail);
  }
}

async function cmdRozhodnuti(
  env: TelegramCommandEnv,
  msg: InboundMessage,
  args: string,
  decision: "approved" | "rejected",
): Promise<void> {
  if (!args) {
    await env.driver.sendText(
      msg.externalChatId,
      decision === "approved" ? "Použití: /schvalit <id> (id zjistíš příkazem /schvaleni)" : "Použití: /zamitnout <id> (id zjistíš příkazem /schvaleni)",
    );
    return;
  }
  // Accept an id prefix for convenience.
  const sessionId = await env.boundSessionId(msg.externalChatId);
  let approvalId = args;
  if (sessionId) {
    const pending = await env.pendingApprovals(sessionId);
    const matches = pending.filter((a) => a.id === args || a.id.startsWith(args));
    if (matches.length === 1) approvalId = matches[0]!.id;
    else if (matches.length > 1) {
      await env.driver.sendText(msg.externalChatId, `Předpona odpovídá ${matches.length} schválením — upřesni delší část id.`);
      return;
    }
  }
  const reply = await env.decide(msg.externalChatId, approvalId, decision);
  await env.driver.sendText(
    msg.externalChatId,
    reply ?? "Toto schválení už nečeká (bylo rozhodnuto nebo vypršelo).",
  );
}

async function cmdObrazovka(env: TelegramCommandEnv, msg: InboundMessage): Promise<void> {
  const sessionId = await needSession(env, msg);
  if (!sessionId) return;
  const info = await sessionAgent(env, sessionId);
  if (!info) return;
  try {
    await env.startDesktop(info.agent.id);
  } catch {
    /* the viewer page explains a stopped desktop — the link still works */
  }
  const link = screenLinkFor(env.masterKey, info.agent.id);
  if (!link) {
    await env.driver.sendText(
      msg.externalChatId,
      "Nepodařilo se zjistit adresu serveru — náhled otevři ve webovém rozhraní (stránka agenta → Obrazovka).",
    );
    return;
  }
  await env.driver.sendText(
    msg.externalChatId,
    `Živý náhled počítače agenta **${info.agent.name}**:\n${link}\n\nOdkaz platí 6 hodin.`,
  );
}

/** Route one incoming text; returns true when it was a bot command. */
export async function handleTelegramCommand(env: TelegramCommandEnv, msg: InboundMessage): Promise<boolean> {
  const parsed = parseChannelCommand(msg.text);
  if (!parsed) return false;
  // Commands that take no arguments must stand alone — "/novy nápad" is a chat message.
  if (NO_ARG_COMMANDS.has(parsed.name) && parsed.args) return false;

  switch (parsed.name) {
    case "pomoc": return void (await cmdPomoc(env, msg)), true;
    case "stav": return void (await cmdStav(env, msg)), true;
    case "restart": return void (await cmdRestart(env, msg)), true;
    case "odpojit": return void (await cmdOdpojit(env, msg)), true;
    case "novy": return void (await cmdNovy(env, msg)), true;
    case "vycistit": return void (await cmdVycistit(env, msg)), true;
    case "jmeno": return void (await cmdJmeno(env, msg, parsed.args)), true;
    case "model": return void (await cmdModel(env, msg, parsed.args)), true;
    case "rezim": return void (await cmdRezim(env, msg, parsed.args)), true;
    case "chaty": return void (await cmdChaty(env, msg)), true;
    case "pamet": return void (await cmdPamet(env, msg)), true;
    case "zapamatuj": return void (await cmdZapamatuj(env, msg, parsed.args)), true;
    case "zapomen": return void (await cmdZapomen(env, msg, parsed.args)), true;
    case "hledej": return void (await cmdHledej(env, msg, parsed.args)), true;
    case "skilly": return void (await cmdSkilly(env, msg)), true;
    case "pauza": return void (await cmdPauza(env, msg)), true;
    case "pokracuj": return void (await cmdPokracuj(env, msg)), true;
    case "schvaleni": return void (await cmdSchvaleni(env, msg)), true;
    case "schvalit": return void (await cmdRozhodnuti(env, msg, parsed.args, "approved")), true;
    case "zamitnout": return void (await cmdRozhodnuti(env, msg, parsed.args, "rejected")), true;
    case "obrazovka": return void (await cmdObrazovka(env, msg)), true;
    default: return false;
  }
}

async function switchToChat(env: TelegramCommandEnv, externalChatId: string, newSessionId: string): Promise<void> {
  const rows = await env.db
    .select()
    .from(channelBindings)
    .where(and(eq(channelBindings.channelId, env.configId), eq(channelBindings.externalChatId, externalChatId)))
    .limit(1);
  const now = new Date();
  if (rows[0]) {
    await env.db.update(channelBindings).set({ sessionId: newSessionId }).where(eq(channelBindings.id, rows[0].id));
  } else {
    await env.db
      .insert(channelBindings)
      .values({ id: newId(), channelId: env.configId, externalChatId, sessionId: newSessionId, createdAt: now })
      .onConflictDoNothing();
  }
  const sRows = await env.db.select({ title: sessions.title }).from(sessions).where(eq(sessions.id, newSessionId)).limit(1);
  await env.driver.sendText(externalChatId, `Přepnuto na chat **${sRows[0]?.title ?? newSessionId}**.`);
}

/** Route an inline-picker callback (tgcmd:<action>:<payload>). */
export async function handleTelegramCallback(
  env: TelegramCommandEnv,
  externalChatId: string,
  senderLabel: string,
  action: string,
  payload: string,
): Promise<void> {
  switch (action) {
    case "odpojit": {
      if (payload === "ano") {
        await env.setEnabled(false);
        await env.driver.sendText(
          externalChatId,
          "Bot je odpojený. Znovu ho připojíš na stránce Kanály ve webovém rozhraní.",
        );
      } else {
        await env.driver.sendText(externalChatId, "Zrušeno — bot běží dál.");
      }
      return;
    }
    case "model": {
      const sessionId = await needSession(env, { externalChatId, senderLabel, senderId: "", text: "" });
      if (!sessionId) return;
      const info = await sessionAgent(env, sessionId);
      const pcRows = await env.db.select().from(providerConfigs).where(eq(providerConfigs.id, payload)).limit(1);
      const pc = pcRows[0];
      if (!info || !pc) {
        await env.driver.sendText(externalChatId, "Tento poskytovatel už neexistuje — zkus /model znovu.");
        return;
      }
      await env.db
        .update(agents)
        .set({ providerConfigId: pc.id, model: pc.defaultModel ?? info.agent.model })
        .where(eq(agents.id, info.agent.id));
      await env.driver.sendText(externalChatId, `Model nastaven: **${pc.label}** (${pc.provider}), ${pc.defaultModel ?? info.agent.model}.`);
      return;
    }
    case "chat": {
      const sRows = await env.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, payload)).limit(1);
      if (!sRows[0]) {
        await env.driver.sendText(externalChatId, "Tento chat už neexistuje.");
        return;
      }
      await switchToChat(env, externalChatId, payload);
      return;
    }
    default:
      await env.driver.sendText(externalChatId, "Toto tlačítko už neplatí — zkus příkaz znovu.");
  }
}
