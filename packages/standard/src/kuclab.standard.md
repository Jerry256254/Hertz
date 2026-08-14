# KucLab standard (condensed, agent-facing)

Apply this to every KucLab-flagged project unless `kuclab.config.json` overrides a field.

**Root files, in this priority order:** `README.md`, `LICENSE`, `.gitignore`, `store.md`.

**License:** MIT by default, copyright holder "KucLab" (not a personal name), unless the project's `kuclab.config.json` says otherwise (e.g. GPL-3.0 for copyleft).

**`.gitignore`:** always keep `.idea/ *.iml .vscode/ .DS_Store Thumbs.db *.log .claude/` regardless of stack; add ecosystem-specific ignores on top (`node_modules/`, `__pycache__/`, `.venv/`, `dist/`, ...).

**`README.md` section order (no extra sections without reason):**
1. Title + one-line description
2. Download/release badge or link, right under the title
3. `## Funkce` / `## Features` — bullet list
4. `## Design` — only if the app has its own visual identity, else omit
5. `## Sestavení ze zdrojového kódu` / `## Build from source` — exact build commands
6. `## Technologie` / `## Technology` — one line
7. `## Licence` / `## License` — link to `LICENSE`

**`store.md`:** YAML frontmatter (`schema_version`, `app_name`, `version_name`, `version_code`, `last_updated`, `license`, `short_description`, `full_description`, `tags`, `repository_url`, `download_url`, `changelog`) + a markdown body that mirrors it for GitHub readability. On every release: bump version, set `last_updated`, unshift (not push) a new `changelog` entry.

**Commits:** English, imperative mood ("Fix widget…", "Add …" — not "Fixed"/"Adding"). First line ≤~70 chars; body (if any) explains *why*, not *what* — especially for bug fixes, name the symptom and the actual root cause. Never `--amend` already-pushed commits, never force-push `main` without explicit approval. Never commit generated/binary build output.

**Versioning/releases:** git tags always `vMAJOR.MINOR.PATCH` (semver-valid even if the app itself only tracks MAJOR.MINOR). Release title `"{APP_NAME} vMAJOR.MINOR"`. Release notes: one line on package nature + `## Novinky`/`## What's new` bullets pulled from `store.md`'s latest changelog entry. Download links always point at `/releases/latest`, never a specific tag.

**Scope:** this governs the GitHub/repo layer (files, format, process) — not the application's own design language, which follows that project's specific requirements.
