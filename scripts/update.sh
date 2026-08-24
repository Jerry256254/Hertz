#!/usr/bin/env bash
# In-place self-update used by the WebUI "Update" button and the installer.
# - backs up DB + config + master key first (rollback point)
# - pulls origin/main, rebuilds, restarts the systemd service
# - logs the version transition (old -> new sha)
# Works headless under systemd: fixes PATH, pnpm availability and git
# safe.directory without assuming an interactive shell.
set -euo pipefail
cd "$(dirname "$0")/.."

export HOME="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
export PATH="$HOME/.local/share/pnpm:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/snap/bin:$PATH"
export GIT_CONFIG_GLOBAL="$(mktemp)"
printf '[safe]\n\tdirectory = *\n' > "$GIT_CONFIG_GLOBAL"

command -v pnpm >/dev/null 2>&1 || npm install -g pnpm >/dev/null 2>&1 || sudo -n npm install -g pnpm

DATA_DIR="${HERTZ_DATA_DIR:-$HOME/.kuclab-hertz}"
TS="$(date +%Y%m%d-%H%M%S)"
OLD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
OLD_VER="$(node -p "require('./packages/cli/package.json').version" 2>/dev/null || echo '?')"

echo "[hertz-update] $(date -Is) update started"
echo "[hertz-update] current: v${OLD_VER} (${OLD_SHA})"

BACKUP_DIR="${DATA_DIR}/backups/${TS}"
mkdir -p "$BACKUP_DIR"
for f in hertz.db hertz.db-journal config.json master.key; do
  [ -f "${DATA_DIR}/${f}" ] && cp "${DATA_DIR}/${f}" "$BACKUP_DIR/" || true
done
echo "[hertz-update] backup -> ${BACKUP_DIR}"

git fetch origin main --quiet
git reset --hard origin/main --quiet
NEW_SHA="$(git rev-parse --short HEAD)"
pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install
if ! pnpm build >/dev/null; then
  echo "[hertz-update] BUILD FAILED — rolling code back to ${OLD_SHA}. Data untouched."
  git reset --hard "$OLD_SHA" --quiet
  pnpm install --silent || true
  pnpm build --silent || true
  exit 3
fi

NEW_VER="$(node -p "require('./packages/cli/package.json').version")"
echo "[hertz-update] updated: v${OLD_VER} (${OLD_SHA}) -> v${NEW_VER} (${NEW_SHA})"

ls -1dt "${DATA_DIR}/backups/"* 2>/dev/null | tail -n +6 | xargs -r rm -rf

if command -v systemctl >/dev/null 2>&1; then
  if sudo -n systemctl restart hertz 2>/dev/null || systemctl restart hertz 2>/dev/null; then
    echo "[hertz-update] service restarted"
  else
    echo "[hertz-update] WARNING: could not restart the service automatically."
    echo "[hertz-update] Run manually:  sudo systemctl restart hertz"
    exit 2
  fi
else
  echo "[hertz-update] no systemd — restart the server process manually."
fi
echo "[hertz-update] $(date -Is) done"
