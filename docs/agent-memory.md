# Layered agent memory (L0 → L3 + short-term symbols)

Every agent in Hertz owns a private, layered memory inspired by
[TencentDB Agent Memory](https://github.com/TencentCloud/tencentdb-agent-memory):
instead of one flat pile of notes, knowledge distills up a pyramid and every
abstraction stays traceable back to the raw evidence it came from.

```
L3 persona.md ......... who the agent serves, how it works (first person)
 │                       agents/<agentId>/memory/persona.md
L2 scenarios .......... topic blocks ("friday sales reports")
 │                       DB + mirror agents/<agentId>/memory/scenarios/*.md
L1 atoms .............. single self-contained facts (DB agent_memory_atoms)
 │                       each → source session/message (L0) + scenario (L2)
L0 conversations ...... raw chat history (DB messages) — never rewritten
```

Short-term memory per session (symbols, not dumps):

```
agents/<agentId>/memory/sessions/<sessionId>/
  canvas.mmd .......... Mermaid task map injected into the prompt
  steps.jsonl ......... one compact line per tool call
  refs/<nodeId>.md .... full text of offloaded tool outputs
```

## How it behaves

- **Capture (L0 → L1).** After each run, the pipeline distills the session's new
  turns into atomic facts with importance 1–5, using the agent's own model.
  Near-duplicates are dropped; nothing is ever rewritten or deleted behind the
  agent's back.
- **Cluster (L1 → L2).** Every ~20 new atoms are grouped into scenario blocks
  (new or existing slugs), mirrored as Markdown for inspection.
- **Persona (L2 → L3).** Every ~25 new atoms (at most hourly) the persona
  profile is re-distilled from scenarios + top facts.
- **Recall.** Prompts carry persona + top-ranked scenarios/atoms for the current
  conversation (keyword relevance + importance + recency fusion) plus the live
  session canvas. The agent digs deeper with tools instead of re-asking the user.
- **Offload.** Tool results over ~6 KB spill to `refs/<nodeId>.md`; history keeps
  an excerpt + pointer. Full text is always one `read_memory_ref` call away —
  compression without evidence loss.

## Agent tools

| Tool | Layer | Purpose |
|---|---|---|
| `remember` | L1 | Save a durable fact / preference |
| `recall_memory` | L2+L1 | Search memory, returns `persona › scenario › atom` traces |
| `read_memory_ref` | short-term | Recover full text of an offloaded `nodeId` |
| `list_memory` | L3+L2+L1 | Layered overview with ids |
| `forget` | L1 | Delete one atom by id |
| `save_note` | files | Long material in `notes/` (not prompt-injected) |

## White-box inspection

Everything an agent "believes" is inspectable without SQL:

- `~/.kuclab-hertz/agents/<agentId>/memory/persona.md`
- `~/.kuclab-hertz/agents/<agentId>/memory/scenarios/*.md`
- `~/.kuclab-hertz/agents/<agentId>/memory/sessions/*/canvas.mmd`
- WebUI → agent → memory dialog (persona / scenarios / facts)

## Tuning

All thresholds live in `packages/server/src/memory/config.ts` and can be
overridden with `HERTZ_MEMORY_*` env vars (cadences, prompt budgets, offload
threshold). Defaults run zero-config on plain local SQLite — no vector
database, no cloud dependency.

## Migration notes

- Legacy `agent_memory` rows are backfilled into L1 atoms once (flagged in
  `memory/state.json`); the old table is left untouched for rollback.
- Legacy `agents/<agentId>/soul.md` seeds `persona.md` on first read.
