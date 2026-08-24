#!/usr/bin/env bash
# KucLab Hertz — one-command installer / updater.
#
#   curl -fsSL https://raw.githubusercontent.com/Jerry256254/Hertz/main/install.sh | bash
#
# Safe to re-run any time: installs missing prerequisites, clones or updates
# the repository, rebuilds, (re)installs and restarts the systemd service.
# Your data in ~/.kuclab-hertz is never touched or reset.
set -euo pipefail

REPO_URL="${HERTZ_REPO_URL:-https://github.com/Jerry256254/Hertz.git}"
INSTALL_DIR="${HERTZ_INSTALL_DIR:-$HOME/Hertz}"
SERVICE_NAME="${HERTZ_SERVICE_NAME:-hertz}"
PORT="${HERTZ_PORT:-4173}"
BRANCH="${HERTZ_BRANCH:-main}"

log()  { printf '\033[1;32m[hertz]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[hertz]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[hertz]\033[0m %s\n' "$*" >&2; exit 1; }

# --- privilege helpers -------------------------------------------------------
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 && SUDO="sudo" || die "Run as root or install sudo."
fi

as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else $SUDO "$@"; fi; }

# --- 1. prerequisites --------------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 20 ] && need_node=0
fi

if [ "$need_node" -eq 1 ]; then
  log "Installing Node.js 22.x ..."
  if command -v apt-get >/dev/null 2>&1; then
    as_root bash -c "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y nodejs
  elif command -v pacman >/dev/null 2>&1; then
    as_root pacman -Sy --noconfirm nodejs npm
  else
    die "No supported package manager found. Install Node.js >= 20 manually from https://nodejs.org"
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  log "Enabling pnpm (corepack)..."
  corepack enable >/dev/null 2>&1 || npm install -g pnpm >/dev/null 2>&1 || as_root npm install -g pnpm
fi

command -v git >/dev/null 2>&1 || {
  log "Installing git..."
  if command -v apt-get >/dev/null 2>&1; then as_root apt-get update -y && as_root apt-get install -y git;
  elif command -v dnf >/dev/null 2>&1; then as_root dnf install -y git;
  fi
}

# --- 2. clone or update ------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating existing checkout at $INSTALL_DIR ..."
  git -C "$INSTALL_DIR" fetch origin "$BRANCH" --quiet
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH" --quiet
else
  log "Cloning Hertz into $INSTALL_DIR ..."
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

# --- 3. build ----------------------------------------------------------------
log "Installing dependencies & building (this can take a few minutes)..."
cd "$INSTALL_DIR"
pnpm install --frozen-lockfile > /tmp/hertz-install.log 2>&1 || { tail -30 /tmp/hertz-install.log; die "pnpm install failed — see /tmp/hertz-install.log"; }
pnpm build > /tmp/hertz-build.log 2>&1 || { tail -40 /tmp/hertz-build.log; die "build failed — see /tmp/hertz-build.log"; }

# Build the agent-computer image too (desktop + browser inside every bot).
# Best-effort: agents fall back to local backend when Docker/image is missing.
if command -v docker >/dev/null 2>&1 && ! docker image inspect kuclab-hertz-computer:latest >/dev/null 2>&1; then
  log "Building agent computer image (kuclab-hertz-computer) ..."
  docker build -t kuclab-hertz-computer:latest -f docker/computer.Dockerfile . > /tmp/hertz-image.log 2>&1 \
    && log "Computer image ready." \
    || warn "Computer image build failed — see /tmp/hertz-image.log (agents will run local until it succeeds)"
fi

# --- 4. non-interactive network config --------------------------------------
DATA_DIR="${HOME}/.kuclab-hertz"
mkdir -p "$DATA_DIR"
if [ ! -f "$DATA_DIR/config.json" ]; then
  # Network-accessible by default (LAN/Tailscale). Change later in this file.
  printf '{\n  "host": "0.0.0.0",\n  "port": %s\n}\n' "$PORT" > "$DATA_DIR/config.json"
  log "Network config written: 0.0.0.0:${PORT} (all interfaces — LAN/Tailscale reachable)"
else
  log "Keeping existing network config ($(cat "$DATA_DIR/config.json" | tr -d '\n'))"
fi

# --- 5. systemd service ------------------------------------------------------
RUN_AS_USER="$(id -un)"
NODE_BIN="$(command -v node)"

if command -v systemctl >/dev/null 2>&1 && as_root true 2>/dev/null; then
  log "Installing systemd service '${SERVICE_NAME}' ..."
  as_root tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null << UNIT
[Unit]
Description=KucLab Hertz (autonomous agent platform)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${RUN_AS_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/packages/cli/dist/bin.js start
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=HERTZ_DATA_DIR=${DATA_DIR}

[Install]
WantedBy=multi-user.target
UNIT
  as_root systemctl daemon-reload
  as_root systemctl enable "${SERVICE_NAME}" --quiet
  as_root systemctl restart "${SERVICE_NAME}"

  log "Waiting for the service to come up ..."
  up=0
  for i in $(seq 1 20); do
    if systemctl is-active --quiet "${SERVICE_NAME}"; then up=1; break; fi
    sleep 1
  done
  if [ "$up" -eq 1 ]; then
    log "Service '${SERVICE_NAME}' is running in the background (survives reboot: enabled)."
  else
    warn "Service did not come up — recent logs:"
    as_root journalctl -u "${SERVICE_NAME}" -n 40 --no-pager || true
    die "Fix the issue above and run: sudo systemctl restart ${SERVICE_NAME}"
  fi

  # Allow the WebUI "Update" button to restart the service without a password.
  SUDOERS_FILE="/etc/sudoers.d/hertz-${SERVICE_NAME}-restart"
  SUDOERS_RULE="${RUN_AS_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl restart ${SERVICE_NAME}, /bin/systemctl restart ${SERVICE_NAME}"
  if [ ! -f "$SUDOERS_FILE" ] || ! grep -qF "$SUDOERS_RULE" "$SUDOERS_FILE" 2>/dev/null; then
    echo "$SUDOERS_RULE" | as_root tee "$SUDOERS_FILE" > /dev/null
    as_root chmod 440 "$SUDOERS_FILE"
  fi

else
  warn "systemd not available — starting in foreground. Install tmux/systemd for background operation."
  exec node packages/cli/dist/bin.js start
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
log "Done. Open the WebUI at:"
[ -n "$IP" ] && log "  http://${IP}:${PORT}   (LAN/Tailscale)"
log "  http://127.0.0.1:${PORT}   (this machine)"
log ""
log "Re-run this same curl command anytime to update in place (data is preserved)."
