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
- **MCP integrace** — připojení externích MCP serverů (stdio i sse) globálně nebo per zaměstnanec, jejich nástroje se sloučí do agentova toolsetu automaticky.
- **`/compact`** — jedním příkazem v chatu se historie session shrne do jedné souhrnné zprávy, další tahy čtou jen ji.
- **Vlastní API klíč, výběr providera, pool klíčů** — Anthropic, OpenAI, Google, nebo libovolný OpenAI-compatible endpoint (Ollama, OpenRouter, vLLM, LM Studio…), s automatickým skenem modelů a rotací mezi více klíči při rate limitu.
- **Sessions běží nezávisle na prohlížeči** — zavřete tab, agent pokračuje, po návratu vidíte celý průběh.
- **WebUI pro telefon i desktop** — přihlášení, správa projektů, streamovaný chat, file explorer, checklist zobrazení nástrojových kroků.
- **Token-efficiency jako priorita** — rozsahové čtení souborů, prompt caching, telemetrie tokenů/ceny na každý request.
- **Bezpečnost** — API klíče i MCP secrets šifrované at-rest, shell allowlist (včetně `gh`), agent nesmí opustit povolené project rooty, audit log na každou akci.

## Design

Hustá informační vrstva, klidná typografie, tmavý i světlý režim, klávesnice na prvním místě — cíl je profesionální nástroj pro každodenní práci, ne "AI startup" landing page.

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
