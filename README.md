# Hertz Jobs

Self-hosted autonomous agent platform — one command starts a server with a WebUI where AI bots work on real projects **24/7**: they run on their own computers, wake themselves up on heartbeats, ask for approval before sensitive actions, learn repeatable procedures as skills, and you can talk to them from Telegram or Discord.

**➡️ Run: `npx kuclab-hertz`** — installs, runs the setup wizard, and starts the local server with WebUI. No registration, no cloud account.

## Features

- **Agent loop** — read/write/edit files, shell, grep/glob, web fetch, todo/plan, all scoped to a sandboxed project root.
- **A durable 24/7 runtime** — every bot's work is a job in a database-backed queue: a server crash or reboot costs at most the current turn, never the intent to work. On boot Hertz reconciles automatically and resumes exactly where interrupted runs stopped (including repairing half-finished tool calls). Pause/resume survive restarts; provider hiccups (429/5xx) retry with exponential backoff; long autonomous runs auto-extend past the turn budget instead of stalling.
- **Each bot has its own computer (Docker)** — switch any agent to the `docker` backend and it gets a dedicated container with its own filesystem workspace, shells, resource caps (`--memory 2g --cpus 2 --pids-limit 512`, no-new-privileges), and auto-restart. Project and personal directories are mounted at identical host paths so every tool works unchanged.
- **Browser automation inside the bot's computer** — docker-backend bots get a persistent Playwright/Chromium daemon (`browser_navigate/click/type/press/snapshot/screenshot`): log into your apps once and the login persists across calls, Grok-Bot-style. Screenshots land in the bot's personal folder where both of you can see them.
- **Heartbeats (proactive bots)** — give a bot an interval plus standing instructions ("check my inbox hourly") and it wakes itself up on schedule, acts on what it owns, reports only when there is something worth reporting, and stays quiet otherwise.
- **Human-in-the-loop approvals** — before sending e-mail on your behalf, spending money, publishing or deleting anything real, a bot files a request ("Should I send this e-mail?"), its session parks, and the decision from the Approvals inbox resumes it automatically with the verdict.
- **Skills — bots that learn workflows** — after solving something repeatable, a bot saves the exact procedure as a personal skill (`save_skill`); every later prompt carries just the skill index and `read_skill` pulls full steps only when relevant. Skills follow the bot across all projects.
- **Chat channels: Telegram & Discord** — connect a bot token and message your agents from your phone; inbound messages route to a bound session thread and replies are delivered back into the same chat. Optional chat-ID allowlist.
- **An organization, not just a chat** — every project has a Manager agent that first reviews the existing team and prefers delegating work over hiring duplicates; when it hires, it picks an employee model based on the task from available providers (list_provider_models), not just a copy of its own. Managers have no file-write or shell access, so they cannot do the work themselves; employees can work across multiple projects and the manager sees the memory of the whole team.
- **Multiple user accounts** — admins create additional accounts and grant project access per account (non-admin users only see the projects they were given); everyone can change their own password.
- **Persistent employee memory** — every agent manages its own memory (remember/list_memory/forget) and its own folder on disk (notes/materials/data) outside the shared project root, both visible to the user.
- **Employees talk to each other** — direct messages (message_employee) land in a real per-pair chat thread with its own context window, and group meetings are supported — all transparently visible to the user, not just one-way delegation. Agents answer even while mid-work, and you can message an agent while it is working without stopping it.
- **Pause/resume/hard-stop** — pause between turns, resume later (works across restarts), or abort the in-flight model call entirely with Stop.
- **Tasks and routines** — a task can be assigned to a chosen subset of the team; routines re-brief the same agent on a schedule (daily/weekly/custom cron); everything goes through the durable queue, so scheduled work survives restarts too.
- **MCP integration with real OAuth** — Gmail, Google Drive, and Slack connect through a real login screen (the CEO registers their own OAuth app once), not manual token pasting; Gmail/Drive run on our own first-party MCP server (`@kuclab-hertz/mcp-google`). A tile catalog also covers GitHub/Postgres/etc., globally or per employee.
- **Hire and termination approvals** — the manager may request a new employee (hire_employee) or a termination (fire_employee), but both only take effect after user (CEO) approval — like a real company; a per-project "Auto-approve" toggle can approve both automatically. The CEO can change any employee's model/provider at any time.
- **A real Linux shell per employee** — a persistent bash process (not a one-shot spawn), multiple named shells, access sharing between colleagues, transcript visible to the user; docker-backend employees' shells run inside their container.
- **Employee detail page** — one page for CEO oversight: job description, memory, personal disk space, MCP settings, shells, computer status/restart, heartbeat configuration, skills.
- **`/compact`** — one chat command summarizes the session history into a single summary message; later turns only read that.
- **Bring your own API key, provider choice, key pool** — Anthropic, OpenAI, Google, or any OpenAI-compatible endpoint (Ollama, OpenRouter, vLLM, LM Studio…), with automatic model scanning and rotation across multiple keys on rate limits.
- **Sessions run independently of the browser** — close the tab, the agent keeps working; come back and see the full progress.
- **WebUI for phone and desktop** — login, project management, streamed chat, file explorer, tool-step checklist rendering, sidebar that becomes a slide-out menu on mobile.
- **Token-efficiency first** — scoped file reads, prompt caching, token/cost telemetry on every request.
- **Security** — API keys, channel tokens and MCP secrets encrypted at rest (AES-256-GCM under a master key), shell allowlist (including `gh`) enforced also for container execution, PathGuard containment including browser screenshot writes, audit log for every action.

## Your bot's own computer (Docker backend)

The default `local` backend runs everything as plain processes next to the server. For Grok-Bot-style isolation, build the computer image once and switch agents to Docker:

```bash
docker build -t kuclab-hertz-computer:latest -f docker/computer.Dockerfile .
```

Then open an employee's page → **Bot computer** → backend `docker`. The container mounts the project root and the employee's personal directory at their host paths, keeps running across server restarts (`--restart unless-stopped`), and hosts the persistent shell and the browser daemon. Requires Docker on the host machine.

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