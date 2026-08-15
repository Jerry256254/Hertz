# KucLab Hertz CLI

Self-hosted agentní vývojová platforma — jeden příkaz nastartuje server s WebUI, ve kterém AI agenti pracují na reálných projektech na disku i po zavření prohlížeče.

[![Stáhnout nejnovější verzi](https://img.shields.io/github/v/release/Jerry256254/HertzCli?label=St%C3%A1hnout&style=for-the-badge&color=D97757)](https://github.com/Jerry256254/HertzCli/releases/latest)

**➡️ Spuštění: `npx kuclab-hertz`** — nainstaluje, provede setupem a spustí lokální server s WebUI. Žádná registrace, žádný cloud účet.

## Funkce

- **Agentní smyčka** — čtení/zápis/editace souborů, shell, grep/glob, web fetch, todo/plán, vše nad sandboxovaným project rootem.
- **Organizace, ne jen chat** — každý projekt má Manager Agenta, který smí najímat zaměstnance s reálnou rolí (architekt/implementer/reviewer/tester/researcher), delegovat úkoly a hlásit výsledky; zaměstnanci mohou pracovat napříč více projekty.
- **Persistentní paměť zaměstnanců** — každý agent si sám spravuje vlastní paměť (remember/list_memory/forget) i vlastní složku na disku (notes/materials/data) mimo sdílený project root, obojí vidí i uživatel.
- **Zaměstnanci komunikují mezi sebou** — přímé zprávy (message_employee) i skupinové schůzky (meetings), transparentně viditelné uživateli, ne jen jednosměrné delegování.
- **Úkoly a routines** — úkol lze zadat jen vybrané podmnožině týmu; routines re-briefují stejného agenta na plán (jednou/denně/týdně/vlastní cron), scheduler je DB-backed a přežije restart serveru.
- **MCP integrace se skutečným OAuth** — Gmail, Google Drive a Slack se připojují přes opravdovou přihlašovací obrazovku (CEO jednou zaregistruje vlastní OAuth app), ne přes ruční vkládání tokenů; Gmail/Drive běží na vlastním first-party MCP serveru (`@kuclab-hertz/mcp-google`). Katalog dlaždic i pro GitHub/Postgres/atd., globálně nebo per zaměstnanec.
- **Schvalování nových najmutí** — manažer smí požádat o nového zaměstnance (hire_employee) i s popisem práce, ale skutečně funkční se stane až po schválení uživatelem (CEO) — jako u reálné firmy.
- **Vlastní Linux shell pro každého zaměstnance** — reálný persistentní bash proces (ne jednorázový spawn), víc pojmenovaných shellů, sdílení přístupu mezi kolegy, transkript viditelný uživateli.
- **Detail zaměstnance** — jedna stránka na CEO dohled: popis práce, paměť, osobní prostor na disku, MCP nastavení, shelly.
- **`/compact`** — jedním příkazem v chatu se historie session shrne do jedné souhrnné zprávy, další tahy čtou jen ji.
- **Vlastní API klíč, výběr providera, pool klíčů** — Anthropic, OpenAI, Google, nebo libovolný OpenAI-compatible endpoint (Ollama, OpenRouter, vLLM, LM Studio…), s automatickým skenem modelů a rotací mezi více klíči při rate limitu.
- **Sessions běží nezávisle na prohlížeči** — zavřete tab, agent pokračuje, po návratu vidíte celý průběh.
- **WebUI pro telefon i desktop** — přihlášení, správa projektů, streamovaný chat, file explorer, checklist zobrazení nástrojových kroků, sidebar jako výsuvné menu na mobilu.
- **Token-efficiency jako priorita** — rozsahové čtení souborů, prompt caching, telemetrie tokenů/ceny na každý request.
- **Bezpečnost** — API klíče i MCP secrets šifrované at-rest, shell allowlist (včetně `gh`), agent nesmí opustit povolené project rooty, audit log na každou akci.

## Design

Material You (M3) — tonální paleta odvozená z jednoho seed odstínu, zaoblené plochy, jemné vrstvení, tmavý i světlý režim. Hustá informační vrstva a klávesnice na prvním místě zůstávají — cíl je profesionální nástroj pro každodenní práci, ne "AI startup" landing page.

## Sestavení ze zdrojového kódu

Vyžaduje Node.js ≥20 a [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js start
```

Výsledný publikovatelný balíček najdete v `packages/cli/dist`.

## Technologie

Node.js + TypeScript, Fastify + WebSocket, SQLite (libSQL) + Drizzle ORM, React + Vite + Tailwind.

## Licence

[MIT](LICENSE)
