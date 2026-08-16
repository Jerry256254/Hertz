---
schema_version: 1
app_name: Hertz
package_id: kuclab-hertz
version_name: "0.6.0"
version_code: 6
last_updated: 2026-08-15
license: MIT
category: Developer Tools
short_description: >-
  Self-hosted agent development platform with a WebUI, distributed via npm.
full_description: |-
  Hertz is a self-hosted agent development platform. A single command
  (`npx kuclab-hertz`) installs, sets up, and starts a local server with a
  WebUI where one or more AI agents work on real projects on disk — even
  after you close the browser.

  Every project has a Manager agent that hires employees with real roles,
  delegates tasks, and reports results to the user. Employees have their own
  persistent memory and working folder on disk, talk to each other directly
  and in meetings (always visible to the user), and can be connected to
  external tools via MCP or set to work on a schedule (routines).

  You bring your own API key and provider of choice (Anthropic, OpenAI,
  Google, or any OpenAI-compatible endpoint), with automatic model scanning.
  Sessions, history, and memory are stored locally on the machine where the
  server runs.
tags:
  - ai-agent
  - developer-tools
  - self-hosted
  - cli
repository_url: https://github.com/Jerry256254/Hertz
download_url: https://github.com/Jerry256254/Hertz/releases/latest
logo: store/logo.png
screenshots:
  - store/screenshots/01_login.png
  - store/screenshots/02_session.png
changelog:
  - version: "0.6.0"
    date: 2026-08-15
    notes:
      - "Agenti si teď průběžně ukládají krátké poznámky do vlastní paměti po každém tahu (co jim kdo řekl, co zjistili), ne jen když si na remember vzpomenou sami"
      - "Manažer si před najímáním vždy nejdřív prohlédne stávající tým (list_employees) a radši přidělí práci jemu, než aby najímal duplicitu"
      - "Nový nástroj list_provider_models — manažer vybírá zaměstnanci model podle potřeby úkolu (levný/rychlý vs. silnější), místo aby vždy kopíroval svůj vlastní"
      - "CEO může kdykoliv změnit model i providera libovolného zaměstnance přímo v jeho detailu"
      - "Nový nástroj view_employee_memory — manažer vidí paměť všech svých zaměstnanců"
      - "Přepínač 'Auto-approve' na projektu — když je zapnutý, manažerovy žádosti o najmutí i propuštění se schválí automaticky, jinak čekají na CEO"
      - "Nový nástroj fire_employee s workflow schválení propuštění (stejně jako u najímání), mirror v UI na detailu zaměstnance i na projektu"
      - "API klíče a OAuth client secrets se teď při uložení ořezávají (trim) — vyřazuje běžnou chybu, kdy zkopírovaný klíč s mezerou navíc vypadá jako neplatný (401)"
  - version: "0.5.0"
    date: 2026-08-15
    notes:
      - "Manažer už nemá write_file/edit_file/shell_exec — musí najmout a delegovat práci zaměstnancům, ne ji dělat sám (vynuceno i na úrovni nástrojů, ne jen promptem)"
      - "Víc uživatelských účtů: admin zakládá účty a nastavuje jim přístup k projektům, každý si mění vlastní heslo"
      - "Opravena chyba v katalogu MCP konektorů, kdy připojení jednoho npx-based serveru falešně označilo i ostatní jako připojené"
      - "Mobilní sidebar jde nyní skutečně zavřít, nescrolluje se pod něj a zůstává dosažitelný i dole v dlouhém chatu; panel souborů v chatu je na mobilu plnoobrazovkový s vlastním zavíráním"
  - version: "0.4.0"
    date: 2026-08-15
    notes:
      - "Gmail, Google Drive a Slack se připojují přes skutečný OAuth 2.0 flow (opravdová přihlašovací obrazovka), ne ruční vkládání tokenů"
      - "Nový first-party MCP server @kuclab-hertz/mcp-google (Gmail + Drive) místo spoléhání na neověřený balíček třetí strany"
      - "WebUI plně responzivní pro telefony — sidebar jako výsuvné menu, layout se přizpůsobí úzkým obrazovkám"
  - version: "0.3.0"
    date: 2026-08-15
    notes:
      - "Nová najmutí manažerem čekají na schválení uživatele (CEO) — hire_employee vytvoří žádost s popisem práce, ne rovnou funkčního zaměstnance"
      - "Persistentní, sdílitelný Linux shell pro každého zaměstnance (víc pojmenovaných shellů, ne jen jednorázový shell_exec)"
      - "MCP Integrace přepracované na katalog dlaždic (GitHub, Slack, Postgres, Google Drive…) s jedním Connect, scoped i per zaměstnanec"
      - "Nová stránka detailu zaměstnance: popis práce, paměť, osobní prostor na disku, MCP, shelly — jedno místo pro CEO dohled"
      - "Kompletní redesign na Material You (M3) — tonální paleta, zaoblené plochy, nahrazuje předchozí černobílou identitu"
  - version: "0.2.0"
    date: 2026-08-15
    notes:
      - "MCP support: připojení externích MCP serverů (stdio/sse) globálně nebo per zaměstnanec, nástroje se automaticky sloučí do agentova toolsetu"
      - "Vlastní pracovní složka pro každého zaměstnance na disku (notes/materials/data), registrovaná jako sandbox root vedle sdíleného project rootu"
      - "Přímá komunikace mezi zaměstnanci (message_employee) s viditelným feedem pro uživatele, ne jen delegace přes manažera"
      - "Routines: opakující se úkoly na DB-backed scheduleru (jednou/denně/týdně/vlastní cron), přežije restart serveru"
      - "Jednořádkový status zaměstnance po každém běhu, barevné avatary napříč UI, sloučený checklist nástrojových kroků místo syrových tool-call/tool-result párů"
  - version: "0.1.0"
    date: 2026-08-14
    notes:
      - "M1: bootstrap CLI, setup wizard, auth, jeden project root, agent loop se 4 provider adaptéry, streamovaný WebUI chat"
---

# Hertz

Self-hosted agent development platform with a WebUI, distributed via npm.

## Description

Hertz is a self-hosted agent development platform. A single command
(`npx kuclab-hertz`) installs, sets up, and starts a local server with a
WebUI where one or more AI agents work on real projects on disk — even
after you close the browser.

You bring your own API key and provider of choice (Anthropic, OpenAI,
Google, or any OpenAI-compatible endpoint), with automatic model scanning.
Sessions, history, and memory are stored locally on the machine where the
server runs.

## Logo

![Hertz logo](store/logo.png)

## Screenshots

| Login | Session |
|---|---|
| ![Login](store/screenshots/01_login.png) | ![Session](store/screenshots/02_session.png) |

## Links

- Source code: <https://github.com/Jerry256254/Hertz>
- Download the latest release: <https://github.com/Jerry256254/Hertz/releases/latest>
- Licence: [MIT](LICENSE)
