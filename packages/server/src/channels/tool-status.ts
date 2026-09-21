/**
 * Compact Czech status lines for agent tool calls shown on chat channels.
 *
 * While the agent works, the live stream message shows one short line such
 * as "Hledám na webu…" instead of a raw tool-call dump. This is UI chrome,
 * so strictly no emoji. Details are picked only from known input fields —
 * the whole input is never stringified (inputs may carry secrets, e.g.
 * vault payloads, and raw JSON is exactly what we don't want to show).
 */

/** First non-empty string among the candidate fields of a tool input. */
function strField(input: unknown, keys: string[]): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Collapse to one line and cap the length. */
function clean(value: string, max = 60): string {
  const oneLine = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

function baseName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const base = path.split(/[\\/]/).filter(Boolean).pop();
  return base ? clean(base, 48) : undefined;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /^https?:\/\/([^/\s:?#]+)/i.exec(url.trim());
  return match ? clean(match[1]!, 48) : undefined;
}

function quoted(value: string | undefined): string | undefined {
  return value ? `„${clean(value, 48)}“` : undefined;
}

/** "Hledám na webu" + optional detail → "Hledám na webu „dotaz"…". */
function line(prefix: string, detail?: string): string {
  return detail ? `${prefix} ${detail}…` : `${prefix}…`;
}

const EXACT: Record<string, (input: unknown) => string> = {
  read_file: (i) => line("Čtu soubor", baseName(strField(i, ["path"]))),
  write_file: (i) => line("Zapisuji soubor", baseName(strField(i, ["path"]))),
  edit_file: (i) => line("Upravuji soubor", baseName(strField(i, ["path"]))),
  glob: (i) => line("Prohledávám soubory", quoted(strField(i, ["pattern"]))),
  grep: (i) => line("Hledám v souborech", quoted(strField(i, ["pattern"]))),
  shell_exec: (i) => line("Spouštím příkaz", clean(strField(i, ["command"]) ?? "", 24) || undefined),
  web_search: (i) => line("Hledám na webu", quoted(strField(i, ["query"]))),
  web_fetch: (i) => line("Stahuji stránku", hostOf(strField(i, ["url"]))),
  todo_write: () => "Aktualizuji plán…",
  generate_image: (i) => line("Generuji obrázek", quoted(strField(i, ["prompt"]))),
  speak_text: () => "Převádím text na řeč…",
  transcribe_audio: () => "Přepisuji audio…",
  send_file: (i) => line("Posílám soubor", baseName(strField(i, ["path", "filename"]))),
  remember: () => "Zapisuji do paměti…",
  save_note: () => "Zapisuji do poznámek…",
  recall_memory: () => "Hledám v paměti…",
  list_memory: () => "Procházím paměť…",
  read_memory_ref: () => "Čtu z paměti…",
  forget: () => "Mažu z paměti…",
  update_user_profile: () => "Aktualizuji profil…",
  update_soul: () => "Aktualizuji osobnost…",
  list_skills: () => "Procházím skilly…",
  read_skill: (i) => line("Čtu skill", clean(strField(i, ["name"]) ?? "", 32) || undefined),
  save_skill: () => "Ukládám skill…",
  delete_skill: () => "Mažu skill…",
  spawn_subagent: () => "Spouštím podagenta…",
  send_to_subagent: () => "Píšu podagentovi…",
  list_subagents: () => "Kontroluji podagenty…",
  subagent_status: () => "Kontroluji podagenty…",
  stop_subagent: () => "Zastavuji podagenta…",
  run_in_shell: (i) => line("Spouštím v terminálu", clean(strField(i, ["command"]) ?? "", 24) || undefined),
  create_shell: () => "Otevírám terminál…",
  share_shell: () => "Sdílím terminál…",
  list_my_shells: () => "Procházím terminály…",
  request_approval: () => "Žádám o schválení…",
  request_host_access: () => "Žádám o přístup k souboru…",
  request_takeover: () => "Žádám o převzetí…",
  vault_use: () => "Používám uložené přihlašovací údaje…",
  vault_list: () => "Procházím trezor…",
  ask_user: () => "Čekám na tvou odpověď…",
  list_pending_approvals: () => "Kontroluji schválení…",
  list_my_chats: () => "Procházím chaty…",
  list_my_routines: () => "Procházím rutiny…",
  complete_onboarding: () => "Dokončuji nastavení…",
  regenerate_avatar: () => "Generuji nový avatar…",
  browser_navigate: (i) => line("Otevírám stránku", hostOf(strField(i, ["url"]))),
  browser_screenshot: () => "Fotím obrazovku prohlížeče…",
  mcp__catalog: () => "Procházím konektory…",
};

const PREFIX: Array<[prefix: string, label: string]> = [
  ["browser_", "Ovládám prohlížeč"],
  ["desktop_", "Ovládám počítač"],
];

/**
 * One compact Czech line describing what the agent is doing right now.
 * Never contains raw JSON, technical dumps, or emoji.
 */
export function toolStatusLine(toolName: string, input: unknown): string {
  const exact = EXACT[toolName];
  if (exact) return exact(input);
  for (const [prefix, label] of PREFIX) {
    if (toolName.startsWith(prefix)) return `${label}…`;
  }
  // MCP tools are named mcp__<server>__<tool> — name the connector.
  const mcp = /^mcp__([A-Za-z0-9_-]+)__/.exec(toolName);
  if (mcp) return line("Volám konektor", clean(mcp[1]!, 32));
  return "Pracuji…";
}
