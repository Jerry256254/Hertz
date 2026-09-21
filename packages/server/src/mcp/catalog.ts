import { createRequire } from "node:module";
import type { OAuthService } from "../oauth/oauth-service.js";
import { oauthRelayBounceUrl } from "../oauth/relay-state.js";

export type ConnectorId = "google" | "notion" | "github" | "presentation" | "gitlab" | "todoist" | "openweather" | "rss";

/** OAuth služba, nebo "local" pro konektory bez přihlášení (běží na serveru). */
export type ConnectorService = OAuthService | "local";

/**
 * Jak konektor získává přihlašovací údaje:
 * - "oauth" — přihlášení jedním kliknutím u poskytovatele (Google, Notion,
 *   GitHub). Přihlašovací údaje aplikace řeší server (správce je nastaví
 *   jednou přes /api/oauth/apps nebo proměnné prostředí) — běžný uživatel
 *   jen klikne na „Připojit“ a potvrdí souhlas.
 * - "apiKey" — uživatel vloží jeden klíč do pole „Vlož klíč“, uloží se šifrovaně,
 * - "none" — lokální konektor bez přihlášení (karta „Připojit").
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
  /** Where to create the OAuth app or find the API key. Shown to admins / as "Kde klíč najdu?". */
  setupUrl?: string;
  setupUrlLabel?: string;
  /**
   * Czech step-by-step for the USER — plain human language, no technical
   * jargon (no "redirect URI", "OAuth client", "scopes", "client ID/secret",
   * "callback", "token"). Target: "klikni na Připojit, přihlas se, hotovo".
   */
  setupHelp?: string;
  /**
   * Varianta setupHelp pro případ, že je zapnutý OAuth relay
   * (HERTZ_OAUTH_RELAY_URL): krátký návod bez zmínek o SSH tunelu —
   * přihlášení přes relay prostě projde jedním kliknutím.
   */
  relaySetupHelp?: string;
  /**
   * One-off setup instructions for the SERVER ADMIN (enabling OAuth login).
   * Shown only to admins, may use technical terms. Not needed when the
   * server already has the credentials (env vars or saved app).
   */
  adminSetupHelp?: string;
  /**
   * Varianta adminSetupHelp pro OAuth relay: návod pro správce, kam patří
   * bounce URL relay jako redirect URI u poskytovatele. Může obsahovat
   * zástupný text `{bounce}`, který se nahradí skutečnou bounce URL.
   */
  relayAdminSetupHelp?: string;
  /** Matches the MCP server package this connector spawns (…/dist/server.js suffix). */
  serverDistSuffix: string;
  /** catalogId used for the OAuth start/callback round-trip. */
  catalogId: string;
}

/**
 * The on-demand catalog: connectors the agent (and the user, in
 * Nastavení → Konektory) can see and connect one by one. Connectors that
 * need a login stay unwired until the user clicks "Připojit"; connectors
 * without any login (credentialKind "none", see authlessConnectors) are
 * enabled by default at server startup and can be turned off — that's the
 * whole point: the agent lists this catalog via the `mcp__catalog` tool
 * and only asks for what the current task actually needs.
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
    setupUrlLabel: "Otevřít Google Cloud Console",
    setupHelp:
      "Klikni na „Připojit“, přihlas se svým Googlem a potvrď souhlas. " +
      "Pozor: jedním kliknutím to projde jen tehdy, když Hertz otevíráš přes localhost nebo přes veřejnou adresu. " +
      "Když se k Hertzi připojuješ přes lokální síť (adresa jako 192.168.x.x), Google takové přihlášení odmítne — " +
      "pak pomůže SSH tunel (otevři Hertz na http://localhost:4173) nebo veřejná adresa se zabezpečeným spojením (https); " +
      "návratovou adresu pak přidej v Google Cloud Console.",
    relaySetupHelp:
      "Klikni na „Připojit“, přihlas se Googlem a potvrď souhlas — propojení proběhne samo.",
    relayAdminSetupHelp:
      "Jednorázové nastavení pro správce serveru: " +
      "1. V Google Cloud Console vytvoř projekt a OAuth klienta typu „Webová aplikace“. " +
      "2. Jako autorizovanou adresu pro návrat přidej {bounce} — přihlášení probíhá přes OAuth relay, protože tento Hertz běží na lokální síti (přímou adresu serveru by Google odmítl). " +
      "3. Povol API: Gmail, Calendar, Drive, Sheets, Docs a Slides. " +
      "4. Client ID a Client secret vlož níže a ulož — nebo je nastav přímo na serveru přes proměnné prostředí HERTZ_OAUTH_GOOGLE_CLIENT_ID a HERTZ_OAUTH_GOOGLE_CLIENT_SECRET. " +
      "5. Na serveru musí být nastavené HERTZ_OAUTH_RELAY_URL a HERTZ_OAUTH_STATE_SECRET (stejný klíč jako na relay serveru).",
    adminSetupHelp:
      "Jednorázové nastavení pro správce serveru: " +
      "1. V Google Cloud Console vytvoř projekt a OAuth klienta typu „Webová aplikace“. " +
      "2. Jako autorizovanou adresu pro návrat přidej adresu tohoto serveru + /api/oauth/google/callback (např. https://vase-domena/api/oauth/google/callback). " +
      "Google přijímá jen veřejné adresy se zabezpečeným spojením (https) nebo http://localhost — adresy z lokální sítě (např. 192.168.x.x) odmítá, " +
      "pak je potřeba SSH tunel (návratová adresa http://localhost:4173/api/oauth/google/callback) nebo veřejná doména. " +
      "3. Povol API: Gmail, Calendar, Drive, Sheets, Docs a Slides. " +
      "4. Client ID a Client secret vlož níže a ulož — nebo je nastav přímo na serveru přes proměnné prostředí HERTZ_OAUTH_GOOGLE_CLIENT_ID a HERTZ_OAUTH_GOOGLE_CLIENT_SECRET.",
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
      "Agent umí prohledávat váš Notion, číst stránky, dotazovat se databází a zakládat nové stránky. Přihlásíš se bezpečně přímo u Notionu — přihlašovací údaje se ukládají šifrovaně.",
    capabilities: ["Hledání stránek a databází", "Čtení obsahu stránek", "Dotazy nad databázemi", "Zakládání nových stránek"],
    setupUrl: "https://www.notion.so/my-integrations",
    setupUrlLabel: "Otevřít Notion → My integrations",
    setupHelp:
      "Klikni na „Připojit“, vyber svůj Notion pracovní prostor a potvrď. " +
      "Pozor: funguje to jen přes localhost nebo veřejnou adresu se zabezpečeným spojením (https) — " +
      "přes lokální síť (adresa jako 192.168.x.x) Notion přihlášení odmítne, pak pomůže SSH tunel nebo veřejná doména.",
    relaySetupHelp:
      "Klikni na „Připojit“, vyber svůj Notion pracovní prostor a potvrď — propojení proběhne samo.",
    relayAdminSetupHelp:
      "Jednorázové nastavení pro správce serveru: " +
      "1. Na stránce My integrations vytvoř novou „public“ integraci. " +
      "2. Jako adresu pro návrat nastav {bounce} — přihlášení probíhá přes OAuth relay, protože tento Hertz běží na lokální síti (přímou adresu serveru by Notion odmítlo). " +
      "3. V nastavení integrace povol čtení i zápis obsahu a čtení uživatelů. " +
      "4. Client ID a Client secret vlož níže a ulož — nebo je nastav přímo na serveru přes proměnné prostředí HERTZ_OAUTH_NOTION_CLIENT_ID a HERTZ_OAUTH_NOTION_CLIENT_SECRET. " +
      "5. Na serveru musí být nastavené HERTZ_OAUTH_RELAY_URL a HERTZ_OAUTH_STATE_SECRET (stejný klíč jako na relay serveru).",
    adminSetupHelp:
      "Jednorázové nastavení pro správce serveru: " +
      "1. Na stránce My integrations vytvoř novou „public“ integraci. " +
      "2. Jako adresu pro návrat nastav adresu tohoto serveru + /api/oauth/notion/callback — Notion přijímá jen https adresy nebo http://localhost, " +
      "adresy z lokální sítě (např. 192.168.x.x) odmítá (pak pomůže SSH tunel nebo veřejná doména). " +
      "3. V nastavení integrace povol čtení i zápis obsahu a čtení uživatelů. " +
      "4. Client ID a Client secret vlož níže a ulož — nebo je nastav přímo na serveru přes proměnné prostředí HERTZ_OAUTH_NOTION_CLIENT_ID a HERTZ_OAUTH_NOTION_CLIENT_SECRET.",
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
    setupUrlLabel: "Otevřít GitHub → Developer settings",
    setupHelp:
      "Klikni na „Připojit“, přihlas se na GitHubu a potvrď. " +
      "Hotovo — nic dalšího nastavovat nemusíš.",
    adminSetupHelp:
      "Jednorázové nastavení pro správce serveru: " +
      "1. V Developer settings vytvoř novou OAuth App. " +
      "2. Jako adresu pro návrat nastav adresu tohoto serveru + /api/oauth/github/callback. " +
      "3. Client ID a Client secret vlož níže a ulož — nebo je nastav přímo na serveru přes proměnné prostředí HERTZ_OAUTH_GITHUB_CLIENT_ID a HERTZ_OAUTH_GITHUB_CLIENT_SECRET.",
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
        label: "Vlož klíč",
        hint: "Osobní klíč z GitLabu: klikni na svůj obrázek vpravo nahoře → Preferences → Access Tokens → vytvoř nový klíč. Nikomu ho neukazuj — je to jako heslo.",
        secret: true,
      },
      {
        env: "GITLAB_API_ROOT",
        label: "Adresa vlastního GitLabu",
        hint: "Vyplň jen pokud nepoužíváš gitlab.com, např. https://git.vase-firma.cz/api/v4. Jinak nech prázdné.",
        secret: false,
        required: false,
      },
    ],
    name: "GitLab",
    tagline: "Projekty, issues a merge requesty z GitLabu (gitlab.com i vlastní instance)",
    description:
      "Agent umí vypsat vaše projekty, číst a zakládat issues, procházet merge requesty a číst soubory z repozitářů. Přihlásíš se svým osobním klíčem z GitLabu — klíč se ukládá šifrovaně a nikomu se nezobrazuje.",
    capabilities: ["Výpis projektů", "Čtení a zakládání issues", "Výpis merge requestů", "Čtení souborů z repozitářů"],
    setupUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    setupUrlLabel: "Kde klíč najdu?",
    setupHelp:
      "1. Na gitlab.com klikni na svůj obrázek vpravo nahoře → Preferences → Access Tokens a vytvoř nový klíč " +
      "(stačí zaškrtnout „read_api“; když chceš, aby agent uměl i zakládat úkoly, přidej „write_api“). " +
      "2. Klíč zkopíruj a vlož ho sem do pole „Vlož klíč“. " +
      "3. Klikni na „Uložit a připojit“ — hotovo.",
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
        label: "Vlož klíč",
        hint: "Najdeš ho v aplikaci Todoist: Nastavení → Integrace → záložka Vývojář → zkopíruj svůj osobní klíč. Je zdarma i na bezplatném tarifu.",
        secret: true,
      },
    ],
    name: "Todoist",
    tagline: "Úkoly a projekty z Todoistu",
    description:
      "Agent umí vypsat vaše úkoly (i podle filtru „dnes“ či projektu), zakládat nové úkoly s termínem a hotové odškrtávat. Přihlásíš se svým osobním klíčem z Todoistu — klíč se ukládá šifrovaně a nikomu se nezobrazuje.",
    capabilities: ["Výpis úkolů a filtrů", "Zakládání úkolů s termínem", "Odškrtávání hotových úkolů", "Výpis projektů"],
    setupUrl: "https://todoist.com/app/settings/integrations/developer",
    setupUrlLabel: "Kde klíč najdu?",
    setupHelp:
      "1. V Todoistu otevři Nastavení → Integrace → záložku Vývojář. " +
      "2. Zkopíruj svůj osobní klíč. " +
      "3. Vlož ho sem a klikni na „Uložit a připojit“ — hotovo.",
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
        label: "Vlož klíč",
        hint: "Zdarma ho získáš na openweathermap.org: zaregistruj se a v sekci API keys zkopíruj svůj klíč. Nový klíč začne fungovat do několika minut.",
        secret: true,
      },
    ],
    name: "OpenWeather",
    tagline: "Aktuální počasí a předpověď (OpenWeather, česky)",
    description:
      "Agent umí zjistit aktuální počasí a předpověď na 5 dní pro libovolné město nebo souřadnice — česky, v metrických jednotkách. Pouze čtení, nic se nikam neposílá. Bezplatný tarif bohatě stačí.",
    capabilities: ["Aktuální počasí pro město", "Předpověď až na 5 dní", "Vyhledávání podle souřadnic", "České popisy, metrické jednotky"],
    setupUrl: "https://home.openweathermap.org/api_keys",
    setupUrlLabel: "Kde klíč najdu?",
    setupHelp:
      "1. Zdarma se zaregistruj na openweathermap.org. " +
      "2. V sekci API keys zkopíruj svůj klíč (nový klíč začne fungovat do pár minut). " +
      "3. Vlož ho sem a klikni na „Uložit a připojit“ — hotovo.",
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
 * Konektory, které nepotřebují žádný klíč ani přihlášení (credentialKind
 * "none"): jsou pro nového uživatele / po instalaci rovnou aktivní, bez
 * nutnosti cokoliv zapínat. Server je při startu automaticky zapne
 * (viz backfillAuthlessConnectors v db/migrate.ts), pokud je uživatel
 * explicitně nevypnul.
 */
export function authlessConnectors(): ConnectorDefinition[] {
  return CONNECTOR_CATALOG.filter((c) => c.credentialKind === "none");
}

const require = createRequire(import.meta.url);

/**
 * Absolutní cesta ke spustitelnému MCP serveru konektoru. Líně, až když je
 * potřeba: chybějící balíček nesmí rozbít volající modul.
 */
export function resolveConnectorServerPath(def: { id: string }): string | null {
  const pkgs: Record<string, string> = {
    presentation: "@kuclab-hertz/mcp-presentation/dist/server.js",
    gitlab: "@kuclab-hertz/mcp-gitlab/dist/server.js",
    todoist: "@kuclab-hertz/mcp-todoist/dist/server.js",
    openweather: "@kuclab-hertz/mcp-openweather/dist/server.js",
    rss: "@kuclab-hertz/mcp-rss/dist/server.js",
  };
  const pkg = pkgs[def.id];
  if (!pkg) return null;
  try {
    return require.resolve(pkg);
  } catch {
    return null;
  }
}

/**
 * Návod pro běžného uživatele s ohledem na OAuth relay: když je relay
 * zapnutý (HERTZ_OAUTH_RELAY_URL) a konektor má relay variantu textu
 * (google/notion), použije se zkrácený návod bez SSH tunelu — přihlášení
 * přes relay prostě projde jedním kliknutím. Jinak původní text.
 */
export function setupHelpFor(def: ConnectorDefinition): string | undefined {
  if (oauthRelayBounceUrl() && def.relaySetupHelp) return def.relaySetupHelp;
  return def.setupHelp;
}

/**
 * Návod pro správce serveru s ohledem na OAuth relay: když je relay
 * zapnutý, patří do konzole poskytovatele bounce URL relay jako redirect
 * URI (zástupný text `{bounce}` se nahradí skutečnou adresou).
 */
export function adminSetupHelpFor(def: ConnectorDefinition): string | undefined {
  const bounce = oauthRelayBounceUrl();
  if (bounce && def.relayAdminSetupHelp) return def.relayAdminSetupHelp.split("{bounce}").join(bounce);
  return def.adminSetupHelp;
}

/**
 * Bounce URL OAuth relay pro daný konektor (data pro UI — adresa, která
 * patří do Google Cloud Console / Notion integrace jako redirect URI;
 * tlačítko pro zkopírování řeší frontend). Jen google/notion umí relay,
 * jinak null.
 */
export function relayBounceUrlFor(def: ConnectorDefinition): string | null {
  if (def.service !== "google" && def.service !== "notion") return null;
  return oauthRelayBounceUrl() ?? null;
}

/** Jedna URL ke zkopírování v UI — tvar očekávaný frontendem (copyableUrls). */
export interface CopyableConnectorUrl {
  /** Lidský popisek, např. „Redirect URI pro Google Cloud Console“. */
  label: string;
  /** URL, kterou má správce zkopírovat a vložit do konzole poskytovatele. */
  url: string;
}

/**
 * URL k zobrazení s tlačítkem pro zkopírování v Nastavení → Konektory:
 * když je zapnutý OAuth relay (HERTZ_OAUTH_RELAY_URL), je to bounce URL
 * jako redirect URI pro konzoli poskytovatele. Jinak prázdné pole.
 */
export function copyableRelayUrlsFor(def: ConnectorDefinition): CopyableConnectorUrl[] {
  const bounce = relayBounceUrlFor(def);
  if (!bounce) return [];
  const label =
    def.service === "notion" ? "Redirect URI pro Notion integraci" : "Redirect URI pro Google Cloud Console";
  return [{ label, url: bounce }];
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

/**
 * Raw MCP connection errors are developer-speak ("401 Unauthorized",
 * "spawn ENOENT"). Map the common ones to a plain-Czech reason the user
 * can act on. Never returns raw technical detail.
 */
export function humanizeConnectorError(error: string | undefined | null): string {
  if (!error) return "Neznámá chyba — zkus konektor odpojit a připojit znovu.";
  const e = error.toLowerCase();
  if (/401|unauthorized|invalid_token|invalid_grant|expired|bad_verification/.test(e)) {
    return "Přihlášení vypršelo nebo je neplatné. Odpoj konektor a připoj ho znovu.";
  }
  if (/403|forbidden/.test(e)) {
    return "Služba přístup odmítla. Zkontroluj oprávnění u poskytovatele a připoj konektor znovu.";
  }
  if (/enoent|spawn/.test(e)) {
    return "Na serveru chybí pomocný program tohoto konektoru. Zkus server aktualizovat, nebo kontaktuj jeho správce.";
  }
  if (/etimedout|econnrefused|enotfound|network|fetch failed|timed out|timeout/.test(e)) {
    return "Službu se nepodařilo zastihnout. Zkontroluj připojení k internetu a zkus to za chvíli znovu.";
  }
  return "Služba teď neodpovídá správně. Zkus konektor odpojit a připojit znovu — když to nepomůže, kontaktuj správce serveru.";
}
