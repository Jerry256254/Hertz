#!/usr/bin/env bash
# In-place self-update used by the WebUI "Update" button and the installer.
# Never touches ~/.kuclab-hertz data. Restarts the systemd service at the end
# when one is installed (passwordless via sudoers rule created by install.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[hertz-update] $(date -Is) updating from origin/main ..."
git fetch origin main --quiet
git reset --hard origin/main --quiet
pnpm install --frozen-lockfile --silent || pnpm install --silent
pnpm build --silent

if command -v systemctl >/dev/null 2>&1; then
  if sudo -n systemctl restart hertz 2>/dev/null || systemctl restart hertz 2>/dev/null; then
    echo "[hertz-update] service restarted"
  else
    echo "[hertz-update] WARNING: could not restart the service automatically."
    echo "[hertz-update] Run manually:  sudo systemctl restart hertz"
    exit 2
  fi
else
  echo "[hertz-update] no systemd — restart the server process manually to load the new build."
fi
echo "[hertz-update] $(date -Is) done"
