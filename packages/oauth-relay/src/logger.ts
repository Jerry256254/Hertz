/**
 * Minimalistický logger pro oauth-relay.
 *
 * Zásadní pravidlo: NIKDY se nelogují query parametry ani těla požadavků.
 * Autorizační kód (`code`) je citlivý a jednorázový — nesmí se objevit
 * v logu, v odpovědi serveru, ani nikde jinde.
 */

export type LogLevel = "info" | "warn" | "error";

export interface RelayLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Vytvoří logger. Každá zpráva je čistý text bez query parametrů —
 * volající smí předat pouze metodu a cestu (bez `?…` části URL).
 */
export function createLogger(out: NodeJS.WritableStream = process.stdout): RelayLogger {
  const line = (level: LogLevel, message: string): void => {
    // Obrana do hloubky: i kdyby volající omylem předal query string,
    // ustřihneme vše od prvního `?`, aby se kód nikdy nedostal do logu.
    const safe = message.split("?")[0];
    out.write(`${new Date().toISOString()} [${level}] ${safe}\n`);
  };
  return {
    info: (message: string) => line("info", message),
    warn: (message: string) => line("warn", message),
    error: (message: string) => line("error", message),
  };
}
