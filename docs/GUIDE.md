# Hertz Jobs — Complete Guide (Grok-Bot Mode)

This guide explains how to turn Hertz Jobs into a Grok-Bot-style autonomous platform: bots with their own computers that work 24/7, wake themselves up on heartbeats, learn repeatable procedures as skills, ask you before sensitive actions, and stay reachable through Telegram and Discord.

---

## 1. Installation

### Option A: ready-made package

```bash
npx kuclab-hertz
```

The first run opens the setup wizard (in your browser): create your admin account (CEO), connect an LLM provider (API key), and the server starts at `http://localhost:3000` (or the port chosen in the wizard). All data lives in `~/.kuclab-hertz/`.

For servers, running inside tmux is recommended so work continues after you log out:

```bash
sudo apt install tmux        # Debian/Ubuntu; Fedora: sudo dnf install tmux
tmux new -s hertz
npx kuclab-hertz
# detach: Ctrl-B then D; reattach: tmux attach -t hertz
```

### Option B: build from source

Requires Node.js >= 20 and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/Jerry256254/Hertz.git
cd Hertz
pnpm install
pnpm build
pnpm setup   # first run only — network config
pnpm start   # server + WebUI (or: pnpm hertz start)
```

---

## 2. Concept: agents = bots with their own computers

Every project has a **manager** and its **employees**. From this version on, every employee is a fully autonomous bot:

| Capability | How it works |
|---|---|
| Own computer | A Docker container per bot (section 3) |
| Proactivity | Heartbeat — scheduled self-wakeups (section 4) |
| Safe actions | request_approval — the bot asks first (section 5) |
| Learning | Skills — bots save learned procedures (section 6) |
| Reachability | Telegram/Discord channels (sections 7 and 8) |
| Working with websites | Browser automation inside the container (section 9) |

Every bot run goes through a **durable job queue backed by SQLite**. If the server process crashes or is restarted, Hertz automatically resumes interrupted work exactly where it stopped — including repairing half-finished tool calls. Nothing gets lost.

---

## 3. The bot's own computer (Docker backend)

By default bots run as plain processes next to the server (`local` backend). For Grok-Bot-style isolation give each bot its own container.

### Step 1: Build the computer image

On the machine where Hertz runs:

```bash
docker build -t kuclab-hertz-computer:latest -f docker/computer.Dockerfile .
```

The image ships Node.js, Python 3, git/gh, ripgrep, jq, sqlite3 and Playwright with Chromium (for browser automation).

### Step 2: Switch the bot to Docker

1. Open a project → employee detail page.
2. Tab **Overview** → section **Bot computer**.
3. Switch `local` → `docker`. A status badge shows container state (`running`, `stopped`, ...).
4. **Restart** recreates the container (e.g. after changing the image).

What the container gets:

- its own filesystem; the project root and the bot's personal folder are bind-mounted at the same paths as on the host, so every tool works unchanged,
- limits: 2 GB RAM, 2 CPUs, 512 processes, `no-new-privileges`,
- `--restart unless-stopped` — after a full machine reboot the bots' computers come back on their own,
- the bot's persistent shells run **inside** the container.

Requirement: a working Docker daemon on the host. If Docker isn't available, Hertz fails soft back to `local` (with a warning in the log).

---

## 4. Heartbeat — proactive bots

A heartbeat means the bot **wakes itself up** on an interval, reviews what it owns, and decides: keep working, prepare something useful, report — or answer just `(idle)` and stay quiet.

Configuration: employee detail → **Heartbeat**:

- **Interval (minutes)** — `0` disables it; e.g. `60` means hourly.
- **Standing instructions** — what to do at every heartbeat, e.g.:
  ```
  Check my e-mail (Gmail connector) and summarize anything important.
  Write new form leads into leads.md.
  If there's nothing to do, reply only (idle).
  ```

All heartbeats of one bot live in a single inspectable session titled "Heartbeat" — easy to audit what the bot did on its own initiative. Heartbeats don't pollute the bot's memory (auto-captured notes are skipped for them).

Tip: combine with routines (Project → Routines) when you need exact cron schedules instead of intervals.

---

## 5. Action approvals (human-in-the-loop)

Before sensitive actions — sending e-mail or messages on your behalf, spending money, publishing, deleting, contacting third parties — the bot calls `request_approval`, describes precisely what it intends to do, and **waits**:

1. Its session parks in `awaiting_input`.
2. The request appears in the WebUI → **Approvals** (sidebar item).
3. **Approve** or **Reject** — the verdict is delivered back into the session and the bot resumes automatically: on approval it performs the action exactly as described; on rejection it skips it (and proposes an alternative only if essential).

Approvals work in autonomous mode too — that's exactly the point: autonomy with a safety gate. Ordinary decisions (how to implement a step, which library to use) the bot makes by itself; approvals are only for actions with real-world consequences.

---

## 6. Skills — bots that learn procedures

When a bot solves something repeatable (a report, a deployment dance, a data pull with quirks), it can save the recipe as a skill:

- `save_skill {name, description, instructions, script?}` — stores SKILL.md (+ optional script.sh),
- `list_skills` — index: name + when to use,
- `read_skill {name}` — full step-by-step procedure,
- `delete_skill {name}` — remove an outdated one.

Only a lightweight index reaches the bot's prompt; the full text loads via `read_skill` when the situation matches. Skills follow the bot across all projects (they're its personal library), and you can see them under employee detail → **Skills**.

In practice: tell the bot "save this procedure as a weekly-report skill" — next time it will simply follow it.

---

## 7. Telegram channel

Message your bots from your phone; an inbound message wakes them wherever you are.

1. In Telegram, talk to [@BotFather](https://t.me/BotFather) → `/newbot`, name it, copy the token (`123456:ABC-DEF...`).
2. Hertz → **Channels** (admin sidebar item) → **Connect a bot**:
   - type: Telegram,
   - label: anything (e.g. "My assistant"),
   - token from BotFather,
   - **default agent**: which bot answers when the chat isn't bound to a session yet,
   - **allowed chats**: comma-separated chat IDs (recommended!). Empty = anyone who finds the bot may talk to it. Get your chat ID by messaging the bot once and checking the audit log, or via @userinfobot.
3. Message the bot on Telegram — a new session appears in the WebUI as a regular chat, and the reply comes back into Telegram.

The same chat stays bound to the same session, so conversation history persists. Multiple bots/channels can run in parallel.

---

## 8. Discord channel

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application → **Bot** tab → Reset Token → copy the token.
2. **Important:** enable **MESSAGE CONTENT INTENT** (Bot tab, Privileged Gateway Intents) — without it the bot cannot read message text.
3. Invite the bot via OAuth2 → URL Generator (scope `bot`; permissions Read Messages + Send Messages).
4. Hertz → **Channels** → Discord type, token, default agent. Put channel IDs into "allowed chats" (right-click a channel → Copy ID; enable Developer Mode in Discord settings first).
5. Write in the channel — the reply arrives in the same channel.

---

## 9. Browser automation

Bots with the docker backend get `browser_navigate`, `browser_click`, `browser_type`, `browser_press`, `browser_snapshot` and `browser_screenshot`.

Key property: the browser is a **persistent daemon inside the container** — log in once (e.g. to Zendesk or a hosting admin panel) and the login persists for later calls, just like a human's session. Typical workflow stated naturally:

> "Log into my Zendesk (credentials are in your notes/ vault), go through open tickets and draft replies. Before sending anything, ask me for approval."

Screenshots land in the bot's personal folder (`self/materials/...`) — visible both to you (file explorer) and to the bot itself via `read_file`.

Note: browser tools are offered only to docker-backend bots; `local` bots get a clear message asking you to switch the backend.

---

## 10. Running 24/7 & reliability

- **Crash recovery**: the job queue lives in SQLite. After a restart Hertz requeues interrupted jobs and resumes sessions by itself. You'll see `[hertz] recovered after restart: N session(s) resumed, M job(s) requeued` in the log.
- **Provider retries**: 429/5xx/network failures retry with exponential backoff (2 s -> 5 s -> 15 s) without failing the session.
- **Auto-continuation**: long autonomous work doesn't die at the turn budget — the run extends itself and only finalizes honestly at a generous safety ceiling.
- **Pause/resume survive restarts**: a paused session can be resumed from the UI even after the server was rebooted.
- **Hard stop**: the Stop button in a chat aborts the in-flight model call and finalizes the run cleanly.

---

## 11. Security

- Secrets (API keys, channel tokens, MCP secrets) are encrypted at rest with AES-256-GCM under a master key at `~/.kuclab-hertz/master.key` (mode 0600). Back it up — without it the data is unreadable.
- A bot's container has only the privileges it needs (resource caps, no-new-privileges); only the project root and its personal folder are mounted.
- The `shell_exec` allowlist applies inside containers too; the persistent shell is deliberately unrestricted bash — every execution goes to the audit log.
- PathGuard contains paths for all tools including browser screenshot writes.
- Always fill in allowed chats for channels; otherwise anyone who finds the bot can talk to it.
- Bots cannot reach outside the permitted project roots and their personal folder; everything else is denied and audited.

---

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Docker backend: status `unavailable` | No Docker daemon on the host (`docker info`). Start it, or keep the bot on `local`. |
| Docker backend: container dies immediately | Missing `kuclab-hertz-computer:latest` image — build it per section 3, then Restart. |
| Browser tools say a computer is required | Switch the bot to the docker backend. |
| Discord bot doesn't react to messages | MESSAGE CONTENT INTENT not enabled in the Developer Portal. |
| Telegram: "No default agent" | Set a default agent on the Channels page. |
| Channel broken after token change | Saving via PATCH restarts the gateway automatically; check the live badge on the Channels page. |
| Session stuck in `active` after a crash | Shouldn't happen — reconciliation handles it. Manual fix: open the session → Stop, or send a new message. |
| Heartbeat spams memory | It shouldn't — heartbeats skip auto-notes; noise means bad standing instructions (add "nothing to do -> (idle)"). |

---

## 13. What changed under the hood (for developers)

- `packages/core/src/agent/agent-loop.ts` — AbortSignal, event-driven pause, `stop()`, retry/backoff, chunk auto-continuation, `repairSessionHistory()`, `suppressAutoMemory`.
- `packages/server/src/queue/job-queue.ts` — durable queue (`jobs` table) with concurrency limit and backoff.
- `packages/server/src/runtime/run-jobs.ts` — single entry point for all runs (the `agent_run` job); rebuilds sandbox/prompt from the DB right before executing.
- `packages/server/src/runtime/reconcile.ts` — boot reconciliation (requeue running jobs, resume active sessions).
- `packages/server/src/computer/` — ComputerManager (containers) + BrowserSession (Playwright daemon) + the browser.mjs daemon source.
- `packages/server/src/channels/` — Telegram long-poll gateway, Discord gateway client, ChannelManager (chat<->session routing).
- `packages/server/src/heartbeats/heartbeat-scheduler.ts` — interval-based bot self-wakeups.
- `packages/server/src/tools/{approval,skill,browser}-tools.ts` — request_approval, skills, browser_*.
- New tables: `jobs`, `approvals`, `channel_configs`, `channel_bindings`; new `agents` columns: `computer_backend`, `computer_image`, `heartbeat_minutes`, `heartbeat_prompt`, `last_heartbeat_at`.
