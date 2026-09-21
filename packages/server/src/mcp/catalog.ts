import type { OAuthService } from "../oauth/oauth-service.js";

export type ConnectorId = "google" | "notion" | "github" | "presentation";

/** OAuth služba, nebo "local" pro konektory bez přihlášení (běží na serveru). */
export type ConnectorService = OAuthService | "local";

export interface ConnectorDefinition {
  id: ConnectorId;
  service: ConnectorService;
  /**
   * Lokální konektor: nepotřebuje OAuth aplikaci ani přihlášení, zapíná se
   * jedním kliknutím (spustí se přibalený MCP server na tomto stroji).
   */
  local?: boolean;
  /** Display name, e.g. "Google". */
  name: string;
  /** One-line Czech pitch shown on the card. */
  tagline: string;
  /** Longer Czech description of what the agent can do once connected. */
  description: string;
  /** Czech list of capability hints shown on the card. */
  capabilities: string[];
  /** Where to create the OAuth app (client ID + secret). Not needed for local connectors. */
  setupUrl?: string;
  setupUrlLabel?: string;
  /** Czech step-by-step for obtaining the client ID/secret. Not needed for local connectors. */
  setupHelp?: string;
  /** Matches the MCP server package this connector spawns (…/dist/server.js suffix). */
  serverDistSuffix: string;
  /** catalogId used for the OAuth start/callback round-trip. */
  catalogId: string;
}

/**
 * The on-demand catalog: connectors the agent (and the user, in
 * Nastavení → Konektory) can see and connect one by one. Nothing here is
 * wired up until the user clicks "Připojit" (or "Zapnout" for local
 * connectors) — that's the whole point: the agent lists this catalog via the
 * `mcp__catalog` tool and only asks for what the current task actually needs.
 *
 * Rule: every entry must be fully functional end-to-end (OAuth → token
 * storage → working MCP tools, or a working local server for local entries).
 * A half-working connector doesn't belong here.
 */
export const CONNECTOR_CATALOG: ConnectorDefinition[] = [
  {
    id: "google",
    service: "google",
    name: "Google",
    tagline: "Gmail, Kalendář, Disk, Tabulky a Dokumenty v jednom připojení",
    description:
      "Po jednom kliknutí umí agent číst a prohledávat vaše e-maily, pracovat s kalendářem (číst i zakládat události), hledat a číst soubory na Google Disku, číst a upravovat tabulky (Sheets) a číst i vytvářet dokumenty (Docs).",
    capabilities: ["Hledání a čtení e-mailů", "Odesílání e-mailů", "Čtení a zakládání událostí v kalendáři", "Hledání souborů na Disku", "Čtení obsahu dokumentů", "Čtení a zápis do tabulek (Sheets)", "Čtení a tvorba dokumentů (Docs)"],
    setupUrl: "https://console.cloud.google.com/apis/credentials",
    setupUrlLabel: "Google Cloud Console → Credentials",
    setupHelp:
      "1. V Google Cloud Console vytvořte projekt a OAuth klienta typu „Webová aplikace“. " +
      "2. Jako autorizovanou redirect URI přidejte adresu tohoto serveru + /api/oauth/google/callback (např. https://vase-domena/api/oauth/google/callback). " +
      "3. Povolte API: Gmail API, Google Calendar API, Google Drive API, Google Sheets API, Google Docs API. " +
      "4. Client ID a Client secret vložte níže a uložte. " +
      "Pokud jste Google připojili před přidáním Tabulek a Dokumentů, klikněte u karty na „Znovu připojit“ — Google se zeptá na rozšířená oprávnění.",
    serverDistSuffix: "mcp-google/dist/server.js",
    catalogId: "google",
  },
  {
    id: "notion",
    service: "notion",
    name: "Notion",
    tagline: "Stránky a databáze z vašeho Notion workspace",
    description:
      "Agent umí prohledávat váš Notion, číst stránky, dotazovat se databází a zakládat nové stránky. Připojení probíhá přes oficiální Notion OAuth — tokeny se ukládají šifrovaně.",
    capabilities: ["Hledání stránek a databází", "Čtení obsahu stránek", "Dotazy nad databázemi", "Zakládání nových stránek"],
    setupUrl: "https://www.notion.so/my-integrations",
    setupUrlLabel: "Notion → My integrations",
    setupHelp:
      "1. Na stránce My integrations vytvořte novou „public“ integraci. " +
      "2. Jako redirect URI nastavte adresu tohoto serveru + /api/oauth/notion/callback. " +
      "3. V nastavení integrace přidejte capabilities: čtení i zápis obsahu, čtení uživatelů. " +
      "4. OAuth client ID a client secret vložte níže a uložte.",
    serverDistSuffix: "mcp-notion/dist/server.js",
    catalogId: "notion",
  },
  {
    id: "github",
    service: "github",
    name: "GitHub",
    tagline: "Repozitáře, issues a pull requesty",
    description:
      "Agent umí prohledávat GitHub repozitáře, číst issues a pull requesty, zakládat issues a číst soubory z repozitářů, ke kterým máte přístup.",
    capabilities: ["Hledání repozitářů", "Výpis a zakládání issues", "Výpis pull requestů", "Čtení souborů z repozitářů"],
    setupUrl: "https://github.com/settings/developers",
    setupUrlLabel: "GitHub → Settings → Developer settings → OAuth Apps",
    setupHelp:
      "1. V Developer settings vytvořte novou OAuth App. " +
      "2. Jako Authorization callback URL nastavte adresu tohoto serveru + /api/oauth/github/callback. " +
      "3. Client ID a Client secret vložte níže a uložte.",
    serverDistSuffix: "mcp-github/dist/server.js",
    catalogId: "github",
  },
  {
    id: "presentation",
    service: "local",
    local: true,
    name: "Prezentace",
    tagline: "Tvorba prezentací — PPTX i HTML, bez externího účtu",
    description:
      "Agent umí na požádání („vyrob prezentaci o …“) vytvořit prezentaci z nadpisu a slidů (nadpis, text, odrážky, obrázky) a předat vám soubory: PPTX pro další úpravy a samostatné HTML, které se prezentuje přímo v prohlížeči. Běží lokálně na tomto serveru, žádné přihlášení ani placená služba není potřeba.",
    capabilities: ["Vytvoření prezentace z tématu", "Export do PPTX a HTML", "Přidávání slidů", "Výběr ze tří vzhledů"],
    serverDistSuffix: "mcp-presentation/dist/server.js",
    catalogId: "presentation",
  },
];

export function getConnector(id: string): ConnectorDefinition | undefined {
  return CONNECTOR_CATALOG.find((c) => c.id === id);
}

/**
 * Maps an mcp_servers row back to its catalog connector by the server binary
 * it spawns. Also matches legacy per-service Google rows ("Gmail",
 * "Google Drive") since they spawn the same binary.
 */
export function connectorForServerArgs(args: string[] | null | undefined): ConnectorDefinition | undefined {
  if (!args || args.length === 0) return undefined;
  const main = args[0] ?? "";
  return CONNECTOR_CATALOG.find((c) => main.endsWith(c.serverDistSuffix));
}
