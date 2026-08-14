---
schema_version: 1
app_name: KucLab Hertz CLI
package_id: kuclab-hertz
version_name: "0.1.0"
version_code: 1
last_updated: 2026-08-14
license: MIT
category: Developer Tools
short_description: >-
  Self-hosted agentní vývojová platforma s WebUI, distribuovaná přes npm.
full_description: |-
  KucLab Hertz je self-hosted agentní vývojová platforma. Jedním příkazem
  (`npx kuclab-hertz`) se nainstaluje, nastaví a spustí lokální server
  s WebUI, ve kterém běží jeden nebo více AI agentů pracujících na reálných
  projektech na disku — i po zavření prohlížeče.

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
