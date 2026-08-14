# KucLab Hertz CLI

Self-hosted agentní vývojová platforma — jeden příkaz nastartuje server s WebUI, ve kterém AI agenti pracují na reálných projektech na disku i po zavření prohlížeče.

[![Stáhnout nejnovější verzi](https://img.shields.io/github/v/release/Jerry256254/HertzCli?label=St%C3%A1hnout&style=for-the-badge&color=D97757)](https://github.com/Jerry256254/HertzCli/releases/latest)

**➡️ Spuštění: `npx kuclab-hertz`** — nainstaluje, provede setupem a spustí lokální server s WebUI. Žádná registrace, žádný cloud účet.

## Funkce

- **Agentní smyčka** — čtení/zápis/editace souborů, shell, grep/glob, web fetch, todo/plán, vše nad sandboxovaným project rootem.
- **Vlastní API klíč, výběr providera** — Anthropic, OpenAI, Google, nebo libovolný OpenAI-compatible endpoint (Ollama, OpenRouter, vLLM, LM Studio…), s automatickým skenem dostupných modelů.
- **Sessions běží nezávisle na prohlížeči** — zavřete tab, agent pokračuje, po návratu vidíte celý průběh.
- **WebUI pro telefon i desktop** — přihlášení, správa projektů, streamovaný chat, file explorer.
- **Token-efficiency jako priorita** — rozsahové čtení souborů, prompt caching, telemetrie tokenů/ceny na každý request.
- **Bezpečnost** — API klíče šifrované at-rest, shell allowlist, agent nesmí opustit povolené project rooty, audit log.

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
