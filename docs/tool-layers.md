# Tool layers: text tools vs desktop/browser autonomy

Hertz tools form two layers. The agent must use the right layer for the job —
never drive layer 1 work through layer 2.

## Layer 1 — text tools (terminal and files)

`shell_exec`, persistent shells (`create_shell` / `run_in_shell`), the file
tools (`read_file`, `write_file`, `edit_file`, `glob`, `grep`), and `save_note`.
These are argv calls and file reads/writes: fast, precise, fully audited, and
contained in the agent's VM. **All terminal and file work lives here.**

## Layer 2 — desktop / browser autonomy

`desktop_*` (mouse, keyboard, screenshots on the agent's visible computer) and
`browser_*` (Playwright-driven web automation). These exist for work that is
inherently visual or interactive: clicking through a web app, reading a page
that needs eyes, logging in via takeover. They are slower, flakier, and harder
to audit than text calls.

## The rule

- Terminal work → `shell_exec` / persistent shells. Never open xterm (or any
  terminal emulator) via `desktop_open_app` and type commands into it.
- File work → the file tools. Never open a GUI editor or file manager
  (`desktop_open_app`) to read or change files.
- `desktop_open_app` xterm/thunar-style apps are for the *user's* takeover
  view, not for agent work.

The tool descriptions carry the same guardrails, so the model sees them at
every call; this doc is the durable statement of intent.
