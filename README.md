# Hertz

Self-hosted agent development platform — one command starts a server with a WebUI in which AI agents work on real projects on disk, even after you close the browser.

[![Download latest release](https://img.shields.io/github/v/release/Jerry256254/Hertz?label=Download&style=for-the-badge&color=D97757&cacheSeconds=86400)](https://github.com/Jerry256254/Hertz/releases/latest)

**➡️ Run: `npx kuclab-hertz`** — installs, runs the setup wizard, and starts the local server with WebUI. No registration, no cloud account.

## Features

- **Agent loop** — read/write/edit files, shell, grep/glob, web fetch, todo/plan, all scoped to a sandboxed project root.
- **An organization, not just a chat** — every project has a Manager agent that first reviews the existing team and prefers delegating work over hiring duplicates; when it hires, it picks an employee model based on the task from available providers (list_provider_models), not just a copy of its own. Managers have no file-write or shell access, so they cannot do the work themselves; employees can work across multiple projects and the manager sees the memory of the whole team.
- **Multiple user accounts** — admins create additional accounts and grant project access per account (non-admin users only see the projects they were given); everyone can change their own password.
- **Persistent employee memory** — every agent manages its own memory (remember/list_memory/forget) and its own folder on disk (notes/materials/data) outside the shared project root, both visible to the user.
- **Employees talk to each other** — direct messages (message_employee) land in a real per-pair chat thread with its own context window, and group meetings are supported — all transparently visible to the user, not just one-way delegation. Agents answer even while mid-work, and you can message an agent while it is working without stopping it.
- **Pause/resume** — pause an agent's work between turns and resume it later; a paused agent keeps waiting until you say go.
- **Tasks and routines** — a task can be assigned to a chosen subset of the team; routines re-brief the same agent on a schedule (daily/weekly/custom cron); the scheduler is DB-backed and survives server restarts.
- **MCP integration with real OAuth** — Gmail, Google Drive, and Slack connect through a real login screen (the CEO registers their own OAuth app once), not manual token pasting; Gmail/Drive run on our own first-party MCP server (`@kuclab-hertz/mcp-google`). A tile catalog also covers GitHub/Postgres/etc., globally or per employee.
- **Hire and termination approvals** — the manager may request a new employee (hire_employee) or a termination (fire_employee), but both only take effect after user (CEO) approval — like a real company; a per-project "Auto-approve" toggle can approve both automatically. The CEO can change any employee's model/provider at any time.
- **A real Linux shell per employee** — a persistent bash process (not a one-shot spawn), multiple named shells, access sharing between colleagues, transcript visible to the user.
- **Employee detail page** — one page for CEO oversight: job description, memory, personal disk space, MCP settings, shells.
- **`/compact`** — one chat command summarizes the session history into a single summary message; later turns only read that.
- **Bring your own API key, provider choice, key pool** — Anthropic, OpenAI, Google, or any OpenAI-compatible endpoint (Ollama, OpenRouter, vLLM, LM Studio…), with automatic model scanning and rotation across multiple keys on rate limits.
- **Sessions run independently of the browser** — close the tab, the agent keeps working; come back and see the full progress.
- **WebUI for phone and desktop** — login, project management, streamed chat, file explorer, tool-step checklist rendering, sidebar that becomes a slide-out menu on mobile.
- **Token-efficiency first** — scoped file reads, prompt caching, token/cost telemetry on every request.
- **Security** — API keys and MCP secrets encrypted at rest, shell allowlist (including `gh`), agents cannot leave the permitted project roots, audit log for every action.

## Recommended: run it in tmux

The server keeps running as long as the process lives, but a terminal that closes (SSH drop, reboot, laptop lid) takes it down. Install tmux and run Hertz in the background so it survives disconnects:

```bash
# install tmux (Debian/Ubuntu):
sudo apt install tmux
# Fedora:
sudo dnf install tmux

tmux new -s hertz          # create a named session
npx kuclab-hertz           # start the server inside tmux
# detach with Ctrl-B D — the server keeps running; reattach anytime:
tmux attach -t hertz
```

## Download

Clone the repository and build it (see below), or grab the latest release assets from the [releases page](https://github.com/Jerry256254/Hertz/releases/latest).

```bash
git clone https://github.com/Jerry256254/Hertz.git
cd Hertz
```

## Build from source

Requires Node.js ≥20 and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/Jerry256254/Hertz.git
cd Hertz
pnpm install
pnpm build
```

Then run it (the `kuclab-hertz` binary is only on your PATH after a global install — from a checkout use the pnpm scripts):

```bash
pnpm setup   # first run only — creates the network config
pnpm start   # starts the server + WebUI (or: pnpm hertz)
```

`pnpm hertz` passes through to the CLI, so `pnpm hertz setup` / `pnpm hertz start` work too. Everything lives in `~/.kuclab-hertz` (config, database, projects).

## Stack

Node.js + TypeScript, Fastify + WebSocket, SQLite (libSQL) + Drizzle ORM, React + Vite + Tailwind.

## License

[Hertz License](LICENSE) — personal use is free, but production, commercial,
or distributed use (including modified versions) requires prior written
consent from KucLab, obtainable via [kuclab.org/podpora](https://kuclab.org/podpora).
You may not remove the copyright notices or present this software (or a
modified version of it) as your own work.