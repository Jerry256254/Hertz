import type { FastifyReply } from "fastify";
import { z } from "zod";

/**
 * Sdílený překlad Zod validačních chyb do češtiny.
 *
 * Serverové routy vracely surový anglický `ZodError.message` (JSON pole
 * issues), který klient renderoval 1:1 do UI — např. v Nastavení →
 * Poskytovatelé po přepnutí providera bez defaultního modelu:
 * `[{"code":"too_small","minimum":1,...,"path":["model"]}]`.
 *
 * Místo toho routy volají `sendZodError(reply, parsed.error)`, která vrátí
 * lidsky čitelnou českou hlášku.
 */

/** České popisky polí (nominativ, v uvozovkách za „pole"). */
const FIELD_LABELS: Record<string, string> = {
  model: "model",
  label: "název",
  name: "název",
  title: "nadpis",
  description: "popis",
  note: "poznámka",
  apiKey: "API klíč",
  key: "klíč",
  token: "token",
  secret: "tajné heslo",
  password: "heslo",
  baseUrl: "adresa serveru",
  url: "adresa",
  provider: "poskytovatel",
  command: "příkaz",
  args: "argumenty",
  cwd: "pracovní složka",
  env: "proměnné prostředí",
  content: "obsah",
  text: "text",
  message: "zpráva",
  prompt: "výzva",
  query: "dotaz",
  service: "služba",
  username: "uživatelské jméno",
  email: "e-mail",
  phone: "telefonní číslo",
  webhook: "webhook",
  chatId: "ID chatu",
  channel: "kanál",
  topic: "téma",
  language: "jazyk",
  timezone: "časové pásmo",
  cron: "plán",
  schedule: "rozvrh",
  projectId: "projekt",
  agentId: "agent",
  sessionId: "relace",
  avatar: "avatar",
  soul: "povaha",
  instructions: "pokyny",
  value: "hodnota",
  path: "cesta",
  dir: "složka",
  file: "soubor",
  script: "skript",
  host: "server",
  port: "port",
  limit: "limit",
  offset: "posun",
  kind: "typ",
  status: "stav",
  role: "role",
};

/** Obecná záložní hláška pro neznámé / nerozpoznané validační chyby. */
export const CZECH_VALIDATION_FALLBACK =
  "Zadané údaje nejsou v pořádku, zkontroluj je prosím.";

/** Český popisek pole z cesty issue; neznámá pole → „pole". */
function labelOf(path: (string | number)[]): string {
  const last = [...path].reverse().find((p): p is string => typeof p === "string");
  if (last && FIELD_LABELS[last]) return `„${FIELD_LABELS[last]}"`;
  return "pole";
}

/** Je to chyba prázdného / chybějícího modelu? */
function isModelIssue(issue: z.ZodIssue): boolean {
  return issue.path.some((p) => p === "model" || p === "defaultModel");
}

function issueToCzech(issue: z.ZodIssue): string | null {
  const label = labelOf(issue.path);
  switch (issue.code) {
    case z.ZodIssueCode.too_small: {
      if (issue.type === "string") {
        // Prázdný string po .trim().min(1) — nejčastější případ z formulářů.
        if (isModelIssue(issue)) return "Vyber nebo zadej model.";
        return `Vyplň ${label}.`;
      }
      if (issue.type === "array") {
        const min = typeof issue.minimum === "number" ? issue.minimum : 1;
        return `${label} musí obsahovat aspoň ${min} ${min === 1 ? "položku" : min < 5 ? "položky" : "položek"}.`;
      }
      if (issue.type === "number" || issue.type === "bigint") {
        return `${label} musí být aspoň ${issue.minimum}.`;
      }
      return null;
    }
    case z.ZodIssueCode.invalid_string: {
      if (issue.validation === "url") {
        return `${label} musí být platná adresa, např. https://….`;
      }
      if (issue.validation === "email") {
        return `Zadej platný e-mail pro ${label}.`;
      }
      if (issue.validation === "uuid") {
        return `${label} musí být platné ID.`;
      }
      return `Hodnota ${label} nemá platný formát.`;
    }
    case z.ZodIssueCode.invalid_enum_value: {
      const options = issue.options.map((o) => String(o)).join(", ");
      return options
        ? `Zvol platnou hodnotu pro ${label} (možnosti: ${options}).`
        : `Zvol platnou hodnotu pro ${label}.`;
    }
    case z.ZodIssueCode.invalid_type: {
      if (issue.received === "undefined" || issue.received === "null") {
        if (isModelIssue(issue)) return "Vyber nebo zadej model.";
        return `Vyplň ${label}.`;
      }
      return `Hodnota ${label} je ve špatném formátu.`;
    }
    case z.ZodIssueCode.unrecognized_keys: {
      return `${CZECH_VALIDATION_FALLBACK}`;
    }
    default:
      return null;
  }
}

/**
 * Převede ZodError na jednu českou hlášku pro UI. První rozpoznaná issue
 * určuje text; nerozpoznané issues padají na obecnou záložní hlášku.
 */
export function zodErrorToCzech(error: z.ZodError): string {
  const first = error.issues.map(issueToCzech).find((m): m is string => m !== null);
  return first ?? CZECH_VALIDATION_FALLBACK;
}

/**
 * Odpoví 400 s českou validační hláškou místo surového Zod JSON.
 * Nahrazuje vzor `reply.code(400).send({ error: parsed.error.message })`.
 */
export function sendZodError(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return reply.code(400).send({ error: zodErrorToCzech(error) });
}
