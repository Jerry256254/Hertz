import type { OAuthService } from "../oauth/oauth-service.js";

export type ConnectorId = "google" | "notion" | "github" | "presentation" | "gitlab" | "todoist" | "openweather" | "rss";

/** OAuth služba, nebo "local" pro konektory bez přihlášení (běží na serveru). */
export type ConnectorService = OAuthService | "local";

/**
 * Jak konektor získává přihlašovací údaje:
 * - "oauth" — klasický OAuth flow přes Client ID/secret (karta „Připojit"),
 * - "apiKey" — uživatel vloží API klíč/token do formuláře, uloží se šifrovaně,
 * - "none" — lokální konektor bez přihlášení (karta „Zapnout").
 */
export type CredentialKind = "oauth" | "apiKey" | "none";

/** Jeden údaj, který uživatel vyplní pro apiKey konektor (uloží se jako env proměnná MCP serveru). */
export interface CredentialField {
  /** Název env proměnné, např. "GITLAB_TOKEN". */
  env: string;
  /** Český popisek pole. */
  label: string;
  /** Česká nápověda, kde údaj získat. */
  hint: string;
  /** Zda jde o tajný údaj (pole typu password, nikdy se nevrací v API). */
  secret: boolean;
  /** Zda je údaj povinný. Výchozí true. */
  required?: boolean;
}

export interface ConnectorDefinition {
  id: ConnectorId;
  service: ConnectorService;
  /** Jak se konektor přihlašuje: OAuth, API klíč zadaný uživatelem, nebo vůbec. */
  credentialKind: CredentialKind;
  /** Pole formuláře pro credentialKind === "apiKey". */
  credentialFields?: CredentialField[];
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
    credentialKind: "oauth",
    name: "Google",
    tagline: "Gmail, Kalendář, Disk, Tabulky, Dokumenty a Prezentace v jednom připojení",
    description:
      "Po jednom kliknutí umí agent číst a prohledávat vaše e-maily, pracovat s kalendářem (číst i zakládat události), hledat a číst soubory na Google Disku, číst a upravovat tabulky (Sheets), číst i vytvářet dokumenty (Docs) a vytvářet i číst prezentace (Slides).",
    capabilities: ["Hledání a čtení e-mailů", "Odesílání e-mailů", "Čtení a zakládání událostí v kalendáři", "Hledání souborů na Disku", "Čtení obsahu dokumentů", "Čtení a zápis do tabulek (Sheets)", "Čtení a tvorba dokumentů (Docs)", "Tvorba a čtení prezentací (Slides)"],
    setupUrl: "https://console.cloud.google.com/apis/credentials",
    setupUrlLabel: "Google Cloud Console → Credentials",
    setupHelp:
      "1. V Google Cloud Console vytvořte projekt a OAuth klienta typu „Webová aplikace“. " +
      "2. Jako autorizovanou redirect URI přidejte adresu tohoto serveru + /api/oauth/google/callback (např. https://vase-domena/api/oauth/google/callback). " +
      "3. Povolte API: Gmail API, Google Calendar API, Google Drive API, Google Sheets API, Google Docs API, Google Slides API. " +
      "4. Client ID a Client secret vložte níže a uložte. " +
      "Pokud jste Google připojili před přidáním Tabulek, Dokumentů a Prezentací, klikněte u karty na „Znovu připojit“ — Google se zeptá na rozšířená oprávnění.",
    serverDistSuffix: "mcp-google/dist/server.js",
    catalogId: "google",
  },
  {
    id: "notion",
    service: "notion",
    credentialKind: "oauth",
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
    credentialKind: "oauth",
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
    credentialKind: "none",
    local: true,
    name: "Prezentace",
    tagline: "Tvorba prezentací — PPTX i HTML, bez externího účtu",
    description:
      "Agent umí na požádání („vyrob prezentaci o …“) vytvořit prezentaci z nadpisu a slidů (nadpis, text, odrážky, obrázky) a předat vám soubory: PPTX pro další úpravy a samostatné HTML, které se prezentuje přímo v prohlížeči. Běží lokálně na tomto serveru, žádné přihlášení ani placená služba není potřeba.",
    capabilities: ["Vytvoření prezentace z tématu", "Export do PPTX a HTML", "Přidávání slidů", "Výběr ze tří vzhledů"],
    serverDistSuffix: "mcp-presentation/dist/server.js",
    catalogId: "presentation",
  },
  {
    id: "gitlab",
    service: "local",
    credentialKind: "apiKey",
    credentialFields: [
      {
        env: "GITLAB_TOKEN",
        label: "Personal Access Token",
        hint: "Vytvořte na gitlab.com → avatar → Preferences → Access Tokens (scopes: read_api, write_api pro zakládání issues). Zdarma.",
        secret: true,
      },
      {
        env: "GITLAB_API_ROOT",
        label: "API adresa (volitelné)",
        hint: "Pro vlastní GitLab instanci, např. https://git.vase-firma.cz/api/v4. Pro gitlab.com nechte prázdné.",
        secret: false,
        required: false,
      },
    ],
    name: "GitLab",
    tagline: "Projekty, issues a merge requesty z GitLabu (gitlab.com i vlastní instance)",
    description:
      "Agent umí vypsat vaše projekty, číst a zakládat issues, procházet merge requesty a číst soubory z repozitářů. Přihlášení přes Personal Access Token — token se ukládá šifrovaně. GitLab API je zdarma.",
    capabilities: ["Výpis projektů", "Čtení a zakládání issues", "Výpis merge requestů", "Čtení souborů z repozitářů"],
    setupUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    setupUrlLabel: "GitLab → Preferences → Access Tokens",
    setupHelp:
      "1. Na gitlab.com otevřete avatar → Preferences → Access Tokens. " +
      "2. Vytvořte token se scopes „read_api“ (čtení) a „write_api“ (zakládání issues). " +
      "3. Token vložte níže a uložte — dál už nic nastavovat nemusíte.",
    serverDistSuffix: "mcp-gitlab/dist/server.js",
    catalogId: "gitlab",
  },
  {
    id: "todoist",
    service: "local",
    credentialKind: "apiKey",
    credentialFields: [
      {
        env: "TODOIST_TOKEN",
        label: "API token",
        hint: "Najdete v Todoist → Nastavení → Integrace → API token (záložka Vývojář). Zdarma i na free tarifu.",
        secret: true,
      },
    ],
    name: "Todoist",
    tagline: "Úkoly a projekty z Todoistu",
    description:
      "Agent umí vypsat vaše úkoly (i podle filtru „dnes“ či projektu), zakládat nové úkoly s termínem a hotové odškrtávat. Přihlášení přes osobní API token — ukládá se šifrovaně. Todoist API je zdarma.",
    capabilities: ["Výpis úkolů a filtrů", "Zakládání úkolů s termínem", "Odškrtávání hotových úkolů", "Výpis projektů"],
    setupUrl: "https://todoist.com/app/settings/integrations/developer",
    setupUrlLabel: "Todoist → Nastavení → Integrace",
    setupHelp:
      "1. V Todoist otevřete Nastavení → Integrace → záložka Vývojář. " +
      "2. Zkopírujte „API token“. " +
      "3. Token vložte níže a uložte.",
    serverDistSuffix: "mcp-todoist/dist/server.js",
    catalogId: "todoist",
  },
  {
    id: "openweather",
    service: "local",
    credentialKind: "apiKey",
    credentialFields: [
      {
        env: "OPENWEATHER_API_KEY",
        label: "API klíč",
        hint: "Registrace zdarma na openweathermap.org → API keys (free tarif: 1 000 000 volání/měsíc). Aktivace klíče trvá pár minut.",
        secret: true,
      },
    ],
    name: "OpenWeather",
    tagline: "Aktuální počasí a předpověď (OpenWeather, česky)",
    description:
      "Agent umí zjistit aktuální počasí a předpověď na 5 dní pro libovolné město nebo souřadnice — česky, v metrických jednotkách. Pouze čtení, nic se nikam neposílá. Free tarif OpenWeather (1 000 000 volání měsíčně) bohatě stačí.",
    capabilities: ["Aktuální počasí pro město", "Předpověď až na 5 dní", "Vyhledávání podle souřadnic", "České popisy, metrické jednotky"],
    setupUrl: "https://home.openweathermap.org/api_keys",
    setupUrlLabel: "OpenWeather → API keys",
    setupHelp:
      "1. Zdarma se registrujte na openweathermap.org. " +
      "2. V sekci API keys zkopírujte svůj klíč (aktivace může trvat pár minut). " +
      "3. Klíč vložte níže a uložte.",
    serverDistSuffix: "mcp-openweather/dist/server.js",
    catalogId: "openweather",
  },
  {
    id: "rss",
    service: "local",
    credentialKind: "none",
    local: true,
    name: "RSS",
    tagline: "Čtení RSS a Atom kanálů — zprávy a blogy bez účtu",
    description:
      "Agent umí na požádání přečíst libovolný veřejný RSS 2.0 nebo Atom kanál a shrnout nejnovější články (titulek, datum, odkaz, perex). Běží lokálně na tomto serveru, žádné přihlášení ani API klíč není potřeba.",
    capabilities: ["Čtení RSS 2.0 kanálů", "Čtení Atom kanálů", "Nejnovější články s perexem", "Bez přihlášení a klíčů"],
    serverDistSuffix: "mcp-rss/dist/server.js",
    catalogId: "rss",
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
