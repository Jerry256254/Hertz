---
schema_version: 1
app_name: KucLab Hertz CLI
package_id: kuclab-hertz
version_name: "0.4.0"
version_code: 4
last_updated: 2026-08-15
license: MIT
category: Developer Tools
short_description: >-
  Self-hosted agentní vývojová platforma s WebUI, distribuovaná přes npm.
full_description: |-
  KucLab Hertz je self-hosted agentní vývojová platforma. Jedním příkazem
  (`npx kuclab-hertz`) se nainstaluje, nastaví a spustí lokální server
  s WebUI, ve kterém běží jeden nebo více AI agentů pracujících na reálných
  projektech na disku — i po zavření prohlížeče.

  Každý projekt má Manager Agenta, který najímá zaměstnance s reálnou rolí,
  deleguje jim úkoly a hlásí výsledky uživateli. Zaměstnanci mají vlastní
  persistentní paměť i pracovní složku na disku, komunikují mezi sebou
  přímo i na schůzkách (vždy viditelně pro uživatele), a lze jim připojit
  externí nástroje přes MCP nebo je nechat pracovat na plánu (routines).

  Uživatel používá vlastní API klíč a providera dle výběru (Anthropic,
  OpenAI, Google, nebo libovolný OpenAI-compatible endpoint), s automatickým
  skenem dostupných modelů. Sessions, historie a paměť se ukládají lokálně
  na stroji, kde server běží.
tags:
  - ai-agent
  - developer-tools
  - self-hosted
  - cli
repository_url: https://github.com/Jerry256254/HertzCli
download_url: https://github.com/Jerry256254/HertzCli/releases/latest
logo: store/logo.png
screenshots:
  - store/screenshots/01_login.png
  - store/screenshots/02_session.png
changelog:
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

# KucLab Hertz CLI

Self-hosted agentní vývojová platforma s WebUI, distribuovaná přes npm.

## Popis

KucLab Hertz je self-hosted agentní vývojová platforma. Jedním příkazem
(`npx kuclab-hertz`) se nainstaluje, nastaví a spustí lokální server
s WebUI, ve kterém běží jeden nebo více AI agentů pracujících na reálných
projektech na disku — i po zavření prohlížeče.

Uživatel používá vlastní API klíč a providera dle výběru (Anthropic,
OpenAI, Google, nebo libovolný OpenAI-compatible endpoint), s automatickým
skenem dostupných modelů. Sessions, historie a paměť se ukládají lokálně
na stroji, kde server běží.

## Logo

![KucLab Hertz CLI logo](store/logo.png)

## Screenshoty

| Login | Session |
|---|---|
| ![Login](store/screenshots/01_login.png) | ![Session](store/screenshots/02_session.png) |

## Odkazy

- Zdrojový kód: <https://github.com/Jerry256254/HertzCli>
- Stažení nejnovější verze: <https://github.com/Jerry256254/HertzCli/releases/latest>
- Licence: [MIT](LICENSE)
