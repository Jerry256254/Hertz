# Hertz Jobs

Self-hosted autonomous agent platform — a server with a WebUI where AI bots work on real projects **24/7**: they run on their own computers, wake themselves up on heartbeats, ask for approval before sensitive actions, learn repeatable procedures as skills, and you can talk to them from Telegram or the WebUI.

**Quick start (Linux server, recommended):**

```bash
curl -fsSL https://raw.githubusercontent.com/Jerry256254/Hertz/main/install.sh | bash
```

That single command installs everything (Node.js if missing), builds Hertz, registers it as a **systemd service that starts on boot**, binds it to all interfaces so it is reachable over your LAN or Tailscale, and prints the address to open. Re-run the exact same command anytime to **update in place** — your data is never reset.

Prefer manual control? [Clone and run it yourself](#4-installing-hertz-jobs-git-clone).

---

## Contents

1. [What is this?](#1-what-is-this)
2. [What you need before installing](#2-what-you-need-before-installing)
3. [Installing Node.js and pnpm](#3-installing-nodejs-and-pnpm)
4. [Installing Hertz Jobs (git clone)](#4-installing-hertz-jobs-git-clone)
5. [First run — the setup wizard](#5-first-run--the-setup-wizard)
6. [Your first project and your first bot](#6-your-first-project-and-your-first-bot)
7. [Making bots autonomous (the Grok-Bot features)](#7-making-bots-autonomous-the-grok-bot-features)
8. [Running 24/7 (so work survives closing the terminal)](#8-running-247-so-work-survives-closing-the-terminal)
9. [Updating](#9-updating)
10. [Where your data lives](#10-where-your-data-lives)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. What is this?

Think of Hertz Jobs as a small company living on your computer:

- You are the **CEO**.
- Every project has a **manager** — an AI that plans, hires other AI **employees**, and delegates work to them.
- Employees are real autonomous **bots**: they read and write files, run shell commands, browse websites, use your connected apps (Gmail, Slack…), and keep working after you close the browser.
- Everything happens **on your machine**. You bring your own AI API key; there is no subscription and no vendor lock-in.

Typical things people ask their team to do:
"Research these 20 companies and draft a personalized e-mail to each", "Fix the failing tests in my repo", "Every Friday, generate a sales report from this folder".

---

## 2. What you need before installing

| Requirement | Minimum | Notes |
|---|---|---|
| Operating system | Linux, macOS, or Windows | Windows works best through [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) |
| RAM | 4 GB free | More = more parallel bots |
| Disk | ~1 GB + your projects | The database grows slowly over time |
| Internet | Required | Bots call AI providers and fetch web pages |
| Git | Any recent version | To clone this repository ([download](https://git-scm.com/downloads)) |
| An AI API key | Any ONE of: Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, OpenRouter… or a local Ollama | This pays the AI provider directly for what the bots think |

> **Where do I get an API key?**
> Create an account at your chosen provider (e.g. [console.anthropic.com](https://console.anthropic.com), [platform.openai.com](https://platform.openai.com), [aistudio.google.com](https://aistudio.google.com), [openrouter.ai](https://openrouter.ai)) and create an "API key" in their dashboard. It looks like `sk-...`. Copy it — you'll paste it into the setup wizard in step 5. You only pay the provider for actual usage; Hertz itself is free.

Optional extras (all set up later, none required to start):
- **Docker** — gives each bot its own isolated container ("its own computer") and enables browser automation,
- a **Telegram** bot token — so you can message your bots from your phone.

---

## 3. Installing Node.js and pnpm

Hertz needs **Node.js version 20 or newer** and the **pnpm** package manager.

### Check what you already have

```bash
node --version
pnpm --version
```

- If `node` prints **v20 or higher** (e.g. `v22.11.0`) and `pnpm` prints a number — skip to step 4.
- If either prints "command not found" — continue below.

### Install Node.js

- **Windows:** download the LTS installer from <https://nodejs.org>, run it, click Next until done. (Or use WSL2 and follow the Linux steps inside it.)
- **macOS:** download the LTS installer from <https://nodejs.org>, or run `brew install node` if you use Homebrew.
- **Linux (Debian/Ubuntu):**
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
  ```
- **Linux (Fedora/RHEL):** `sudo dnf install nodejs`

### Install pnpm

```bash
corepack enable
```

(`corepack` ships with Node.js. If that fails, fall back to: `npm install -g pnpm`.)

Verify both again:

```bash
node --version   # v20+ expected
pnpm --version   # any 9+ version is fine
```

---

## 4. Installing Hertz Jobs (git clone)

Open a terminal, pick a folder where you want the app to live, and run:

```bash
git clone https://github.com/Jerry256254/Hertz.git
cd Hertz
pnpm install     # downloads dependencies (~1–2 minutes)
pnpm build       # compiles everything (~1 minute)
```

Now do the one-time network setup (asks where the server should listen — just press **Enter** twice to accept the defaults):

```bash
pnpm setup
```

And start the server:

```bash
pnpm start
```

You'll see something like `KucLab Hertz is running at http://127.0.0.1:4173`. Open that address (**http://127.0.0.1:4173**) in your browser — on the same machine. That's the whole product — there is no desktop app.

> **Running Hertz on a server and browsing from your laptop/phone?** (LAN or Tailscale) Then during `pnpm setup` choose **"All interfaces (0.0.0.0)"**, not "This machine only" — otherwise the WebUI is unreachable from anywhere else. If you already picked the wrong one, just run `pnpm setup` again, or set `"host": "0.0.0.0"` in `~/.kuclab-hertz/config.json`, and restart. The server prints all reachable addresses on startup.

Everyday routine from now on is just:

```bash
cd Hertz
pnpm start
```

> Keep this terminal window open! Closing it stops the server (see [section 8](#8-running-247-so-work-survives-closing-the-terminal) for running it permanently).

---

## 5. First run — the setup wizard

The browser shows a short wizard. Two screens:

**Screen 1 — CEO account.** Enter your e-mail and pick a password (min. 8 characters). This account is stored locally; the e-mail is just a login name, nothing is sent anywhere.

**Screen 2 — Connect an AI provider.**
1. Pick a provider from the list (e.g. Anthropic, OpenAI, Google, OpenRouter, Ollama).
2. Paste the API key you created in step 2.
3. Click scan/save — Hertz lists the models available on your key automatically.

That's it — you land on the dashboard.

---

## 6. Your first project and your first bot

1. Click **New project**, give it a name, and point it at a folder on disk (you can also create a fresh empty folder here). This folder is the bots' shared workspace — they will read and edit real files in it.
2. Hertz creates a **manager** for the project automatically. Open the project and just type into the chat:
   > *"Find out what's in this folder and summarize it."*
   
   The manager reads files with tools and answers — you see every step live.
3. Ask the manager for real work:
   > *"Hire an implementer and have them build a simple landing page in index.html."*
   
   The manager hires an employee (picking a suitable model), assigns the task, and reports back when it's done. You watch everything transparently — including agent-to-agent chats.
4. Useful controls while a bot works: **Pause** (it finishes its current step and waits) and **Stop** (hard-stop now). Every bot runs autonomously by default — it works until done and only asks when input can come only from you; hiring is instant too, and new employees automatically start on the manager's model (change it anytime on their page).

From here you can add the autonomy features below whenever you want them.

---

## 7. Making bots autonomous (the Grok-Bot features)

All of these are optional. Each takes a few minutes.

### 7.1 Give each bot its own computer (Docker)

By default bots run next to the server. With Docker, each bot gets an isolated container with its own filesystem and shells:

```bash
docker build -t kuclab-hertz-computer:latest -f docker/computer.Dockerfile .
```

(Install Docker first: <https://docs.docker.com/get-docker/>. The build takes a few minutes.)

Then: open an employee's page → **Overview** tab → **Bot computer** card → switch to `docker` → **Restart**. A green `running` badge means the bot's computer is up.

### 7.2 Browser automation

Bots on the Docker backend get a persistent Chromium: `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_screenshot`. Log in once and the login persists across calls — so you can say *"log into my Zendesk and go through open tickets"* and it works like a human session.

### 7.3 Heartbeats — bots that wake themselves up

On the employee page → **Heartbeat** card, set an interval (e.g. 60 minutes) and standing instructions, e.g.:

```
Check my inbox via the Gmail connector and summarize anything urgent.
No news? Reply exactly (idle).
```

The bot now wakes itself hourly, acts on what it owns, and stays silent when there's nothing to report. All self-initiated work lands in one inspectable "Heartbeat" chat.

### 7.4 Approvals — bots ask before doing anything risky

Before sending an e-mail on your behalf, spending money, publishing or deleting anything, a bot calls `request_approval`. Its request appears in the sidebar under **Approvals** with Approve/Reject buttons — your decision is delivered straight back into the bot's work. Nothing risky happens without you.

### 7.5 Skills — bots remember procedures

When a bot figures out something repeatable (a weekly report, a deployment dance), tell it: *"save this as a skill"*. Next time it follows its own saved recipe (`save_skill` / `read_skill`). Skills appear on the employee page and follow the bot across projects.

### 7.6 Talk to your bots from your phone (Telegram)

**Telegram (easiest):**
1. In Telegram, message [@BotFather](https://t.me/BotFather): `/newbot`, follow prompts, copy the token.
2. Hertz sidebar → **Channels** (admin) → **Connect a bot** → paste token → pick a default agent.
3. Message your bot on Telegram. Replies come back to the same chat.

Set the "allowed chats" field to your own chat/channel IDs so only you can talk to the bots.

### 7.5.1 Group chats (messenger style)

Project → Team → **New group chat**: pick two or more bots and they share one thread with you — like a messenger group. Every participant answers in turn and sees what the others said; type `@Name your request` to address a specific bot. The same thread also works over Telegram if you bind it there.

### 7.7 Routines, tasks, MCP integrations

- **Routines** (project page) — cron-style recurring briefings: *"every weekday at 8:00, triage the inbox folder"*.
- **Tasks** — hand one brief to several employees at once; each gets its own session.
- **Integrations** — Gmail, Google Drive, Slack (with a real OAuth login screen), GitHub, Postgres and more via MCP.

---

## 8. Running 24/7 (so work survives closing the terminal)

The server keeps working as long as its process lives — but closing the terminal kills it. Run it inside **tmux** so it keeps going in the background:

```bash
sudo apt install tmux        # Debian/Ubuntu    (Fedora: sudo dnf install tmux)
tmux new -s hertz            # create a background workspace named "hertz"
cd /path/to/Hertz            # wherever you cloned the repository
pnpm start                   # start the server inside tmux
```

Detach (leave it running): press **Ctrl-B**, then **D**. You're back in a normal terminal; the server lives on.

Come back anytime: `tmux attach -t hertz`.

And because of the durable job queue, even a crash or reboot isn't a problem: on the next start Hertz resumes interrupted sessions exactly where they stopped.

---

## 9. Updating

```bash
cd /path/to/Hertz
git pull
pnpm install
pnpm build
```

Restart the server afterwards (`pnpm start`). Database migrations run automatically on boot, your data stays.

---

## 10. Where your data lives

Everything is local, in `~/.kuclab-hertz/`:

| File/folder | What it is |
|---|---|
| `config.json` | Host/port settings from the wizard |
| `master.key` | Encryption key for stored secrets (**back this up** — without it saved keys/tokens are unreadable) |
| `hertz.db` | The whole database: accounts, chats, memory, queue |
| `projects/` | Bot personal folders (notes/materials/data per employee) |
| `logs/` | Server and audit logs |
| `agents/<id>/skills/` | Bots' learned skills |

---

## 11. Troubleshooting

| Problem | Fix |
|---|---|
| `pnpm: command not found` | pnpm missing — see [section 3](#3-installing-nodejs-and-pnpm) (`corepack enable`) |
| `node: command not found` or old version | Node.js missing or too old — see [section 3](#3-installing-nodejs-and-pnpm) |
| `pnpm install` fails on a native module (argon2) | Install build tools: Debian/Ubuntu `sudo apt install -y build-essential python3`, macOS `xcode-select --install` |
| Browser shows nothing at localhost:4173 | Check the terminal for the exact address/port; make sure the server is still running |
| Can't reach the WebUI from another machine (LAN/Tailscale) | The server binds to 127.0.0.1 only. Run `pnpm setup` and choose "All interfaces (0.0.0.0)", or set `"host": "0.0.0.0"` in `~/.kuclab-hertz/config.json`, restart — then open `http://<server-ip>:4173`. If a firewall still blocks it: `sudo ufw allow 4173/tcp` (Ubuntu) or `sudo firewall-cmd --add-port=4173/tcp --permanent && sudo firewall-cmd --reload` (Fedora) |
| Forgot password | For now ask on the project's issues page; future versions get a reset CLI |
| Provider scan finds no models | Double-check the API key and that the provider isn't blocked by a firewall/proxy |
| A bot seems stuck | Open its session and press **Stop**, then send a new message; the durable queue never loses the work |
| Session shows `active` after a crash | Rebooting the server auto-resumes it (look for `[hertz] recovered after restart` in the log) |
| Docker backend badge says `unavailable` | Docker isn't running on the host — start Docker Desktop/the daemon |
| Browser tools say a computer is required | Switch that bot to the `docker` backend (section 7.1) |
| Port already in use | Rerun `pnpm setup`, or edit `~/.kuclab-hertz/config.json` |

Found a bug? Please [open an issue](https://github.com/Jerry256254/Hertz/issues).

---

## Monorepo layout (for contributors)

Requires Node.js ≥ 20 and pnpm (see above); `git clone && pnpm install && pnpm build` is all you need.

Packages: `packages/{cli,core,tools,sandbox,providers,mcp,mcp-google,server,standard,web}`. Useful scripts: `pnpm dev` (watch builds), `pnpm typecheck`, `pnpm lint`, `pnpm test`. A smoke test against built packages lives in `.smoke-test/` (fake LLM provider + scripted end-to-end checks).

## Stack

Node.js + TypeScript, Fastify + WebSocket, SQLite (libSQL) + Drizzle ORM, React + Vite + Tailwind, Docker (optional bot computers), Playwright (optional browser automation).

## License

Licensed under the **Apache License, Version 2.0** — see [LICENSE](LICENSE). You are free to use, modify, and distribute this software (including commercially) under the terms of that license.
