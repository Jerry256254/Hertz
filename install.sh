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
export GIT_CONFIG_GLOBAL="$(mktemp)"
printf '[safe]\n\tdirectory = *\n' > "$GIT_CONFIG_GLOBAL"
INSTALL_DIR="${HERTZ_INSTALL_DIR:-$HOME/Hertz}"
# Sanitize service name to [a-z0-9-] only to prevent path traversal
SERVICE_NAME_RAW="${HERTZ_SERVICE_NAME:-hertz}"
SERVICE_NAME="$(printf '%s' "$SERVICE_NAME_RAW" | tr -cd 'a-z0-9-' | head -c 32)"
[ -z "$SERVICE_NAME" ] && SERVICE_NAME="hertz"
PORT="${HERTZ_PORT:-4173}"
BRANCH="${HERTZ_BRANCH:-main}"

log()  { printf '\033[1;32m[hertz]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[hertz]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[hertz]\033[0m %s\n' "$*" >&2; exit 1; }

# --- privilege helpers -------------------------------------------------------
RUN_AS_USER_ORIG="$(id -un)"
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 && SUDO="sudo" || die "Run as root or install sudo."
fi

as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else $SUDO "$@"; fi; }

# --- 1. prerequisites --------------------------------------------------------
# systemd can't reliably exec home-managed Node (nvm/fnm under ~) — Permission
# denied at EXEC step. Prefer a SYSTEM node; only fall back to a login-shell
# wrapper when no system node can be installed.
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

SYSTEM_NODE=""
for cand in /usr/bin/node /usr/local/bin/node /opt/node/bin/node; do
  if [ -x "$cand" ] && [ "$(node_major "$cand")" -ge 20 ]; then SYSTEM_NODE="$cand"; break; fi
done

if [ -z "$SYSTEM_NODE" ]; then
  log "Installing system-wide Node.js 22 (NodeSource)..."
  if command -v apt-get >/dev/null 2>&1; then
    as_root bash -c "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs" || true
  elif command -v dnf >/dev/null 2>&1; then
    (curl -fsSL https://rpm.nodesource.com/setup_22.x | as_root bash -) || true
    as_root dnf install -y nodejs || true
  elif command -v pacman >/dev/null 2>&1; then
    as_root pacman -Sy --noconfirm nodejs npm || true
  fi
  for cand in /usr/bin/node /usr/local/bin/node /opt/node/bin/node; do
    if [ -x "$cand" ] && [ "$(node_major "$cand")" -ge 20 ]; then SYSTEM_NODE="$cand"; break; fi
  done
fi

USE_WRAPPER=0
if [ -n "$SYSTEM_NODE" ]; then
  NODE_BIN="$SYSTEM_NODE"
else
  # Fall back to the user's own Node (nvm/fnm/...) executed via a login shell.
  if command -v node >/dev/null 2>&1 && [ "$(node_major "$(command -v node)")" -ge 20 ]; then
    NODE_BIN="$(command -v node)"
    USE_WRAPPER=1
    warn "Using home-managed Node ($NODE_BIN) via a login-shell wrapper."
  else
    die "No Node.js >= 20 available and system install failed. Install Node from https://nodejs.org and re-run."
  fi
fi
log "Using Node: $NODE_BIN"

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

# --- docker access -----------------------------------------------------------
# The service (and image build) must be able to talk to Docker. If the current
# user can't, add them to the docker group (applies to the restarted service
# immediately) and fall back to sudo for the one-time image build below.
DOCKER="docker"
if command -v docker >/dev/null 2>&1; then
  if ! docker info >/dev/null 2>&1; then
    log "Granting Docker access to user '$RUN_AS_USER_ORIG' (docker group)..."
    as_root usermod -aG docker "${RUN_AS_USER_ORIG}" || true
    DOCKER="sudo -n -E docker"
    warn "Docker commands below use sudo; the background service gets group access on restart."
  fi
fi

# --- 2. clone or update ------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating existing checkout at $INSTALL_DIR ..."
  if [ -n "$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null)" ]; then
    warn "Local changes in $INSTALL_DIR will be discarded (stash them first if needed)."
    git -C "$INSTALL_DIR" stash push -m "hertz-install auto-stash $(date -Is)" 2>/dev/null || true
  fi
  git -C "$INSTALL_DIR" fetch origin "$BRANCH" --quiet
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH" --quiet
else
  log "Cloning Hertz into $INSTALL_DIR ..."
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

# --- 3. build ----------------------------------------------------------------
DATA_DIR="${HOME}/.kuclab-hertz"
mkdir -p "$DATA_DIR"
log "Installing dependencies & building (this can take a few minutes)..."
cd "$INSTALL_DIR"
pnpm install --frozen-lockfile > /tmp/hertz-install.log 2>&1 || { tail -30 /tmp/hertz-install.log; die "pnpm install failed — see /tmp/hertz-install.log"; }
pnpm build > /tmp/hertz-build.log 2>&1 || { tail -40 /tmp/hertz-build.log; die "build failed — see /tmp/hertz-build.log"; }

# Build the agent-computer image too (desktop + browser inside every bot).
# Best-effort: agents fall back to local backend when Docker/image is missing.
# Rebuild if missing OR Dockerfile newer than image
NEED_IMAGE=0
if command -v docker >/dev/null 2>&1; then
  if ! $DOCKER image inspect kuclab-hertz-computer:latest >/dev/null 2>&1; then NEED_IMAGE=1
  elif [ docker/computer.Dockerfile -nt "$DATA_DIR/.hertz-image-built" 2>/dev/null ]; then NEED_IMAGE=1
  fi
fi
if [ "$NEED_IMAGE" -eq 1 ]; then
  log "Building agent computer image (kuclab-hertz-computer) ..."
  if $DOCKER build -t kuclab-hertz-computer:latest -f docker/computer.Dockerfile . > /tmp/hertz-image.log 2>&1; then
    date -Is > "$DATA_DIR/.hertz-image-built" 2>/dev/null || true
    log "Computer image ready."
  else
    warn "Computer image build failed — last lines:"
    tail -15 /tmp/hertz-image.log || true
    warn "Full log: /tmp/hertz-image.log — fix and re-run this installer."
  fi
fi

# --- 4. non-interactive network config --------------------------------------
if [ ! -f "$DATA_DIR/config.json" ]; then
  # Network-accessible by default (LAN/Tailscale). Change later in this file.
  printf '{\n  "host": "0.0.0.0",\n  "port": %s\n}\n' "$PORT" > "$DATA_DIR/config.json"
  log "Network config written: 0.0.0.0:${PORT} (all interfaces — LAN/Tailscale reachable)"
else
  log "Keeping existing network config ($(cat "$DATA_DIR/config.json" | tr -d '\n'))"
fi

# Actual port from config.json (the service will bind there)
if [ -f "$DATA_DIR/config.json" ] && [ -n "$SYSTEM_NODE$NODE_BIN" ]; then
  _NODE="${SYSTEM_NODE:-$NODE_BIN}"
  CFG_PORT="$(HERTZ_DATA_DIR="$DATA_DIR" "$_NODE" -p "try{JSON.parse(require('fs').readFileSync(process.env.HERTZ_DATA_DIR+'/config.json','utf8')).port}catch{}" 2>/dev/null || true)"
  [ -n "$CFG_PORT" ] && PORT="$CFG_PORT"
fi

# --- 5. systemd service ------------------------------------------------------
RUN_AS_USER="${RUN_AS_USER_ORIG}"

if command -v systemctl >/dev/null 2>&1 && as_root true 2>/dev/null; then
  log "Installing systemd service '${SERVICE_NAME}' ..."
  # Unit fragments across ALL layers silently override ExecStart — a leftover
  # from older manual setups would keep pointing at a dead path:
  #   /etc/systemd/system/<svc>.service.d/   (drop-ins)
  #   /run/systemd/system/<svc>*             (runtime units — survive daemon-reload!)
  as_root systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
  as_root rm -rf "/etc/systemd/system/${SERVICE_NAME}.service.d" 2>/dev/null || true
  as_root rm -rf "/run/systemd/system/${SERVICE_NAME}.service.d" 2>/dev/null || true
  as_root rm -f  "/run/systemd/system/${SERVICE_NAME}.service" 2>/dev/null || true
  as_root rm -rf "/run/systemd/transient/${SERVICE_NAME}.service" 2>/dev/null || true
  if [ "$USE_WRAPPER" -eq 1 ]; then
    _ESCAPED_DIR="$(printf '%q' "$INSTALL_DIR")"
    EXEC_LINE="/bin/bash -lc 'cd ${_ESCAPED_DIR} && exec node packages/cli/dist/bin.js start'"
  else
    EXEC_LINE="${NODE_BIN} ${INSTALL_DIR}/packages/cli/dist/bin.js start"
  fi
  as_root tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null << UNIT
[Unit]
Description=KucLab Hertz (autonomous agent platform)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${RUN_AS_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${EXEC_LINE}
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=HERTZ_DATA_DIR=${DATA_DIR}

[Install]
WantedBy=multi-user.target
UNIT
  as_root systemctl daemon-reload
  as_root systemctl enable "${SERVICE_NAME}" --quiet
  log "Verifying the effective unit definition..."
  EFFECTIVE_UNIT="$(as_root systemctl cat "${SERVICE_NAME}" 2>/dev/null || true)"

  # SELF-HEAL: if ANY fragment layer still carries an .nvm ExecStart, rewrite
  # that exact fragment in place: systemctl cat marks each fragment with a
  # "# /path" header, so we know precisely which file to fix.
  if echo "${EFFECTIVE_UNIT}" | grep -q "\.nvm"; then
    warn "An .nvm ExecStart leaked into the unit — self-healing the offending fragments..."
    echo "${EFFECTIVE_UNIT}" | grep '^# ' | awk '{print $2}' | while read -r frag; do
      [ -f "$frag" ] || continue
      if grep -q "\.nvm" "$frag" 2>/dev/null; then
        warn "  fixing ${frag}"
        as_root sed -i "s|^ExecStart=.*|ExecStart=${EXEC_LINE}|" "$frag" || true
      fi
    done
    as_root systemctl daemon-reload
    EFFECTIVE_UNIT="$(as_root systemctl cat "${SERVICE_NAME}" 2>/dev/null || true)"
  fi

  if echo "${EFFECTIVE_UNIT}" | grep -q "\.nvm"; then
    warn "An .nvm ExecStart STILL leaks after self-healing — hunting every layer:"
    echo "--- on-disk /etc unit:";   grep -n "ExecStart" "/etc/systemd/system/${SERVICE_NAME}.service" 2>/dev/null || true
    echo "--- /run fragments:";      ls -la /run/systemd/system/ 2>/dev/null | grep -i hertz || echo "  (none)"
    echo "--- systemd-delta:";       as_root systemd-delta --type=extended 2>/dev/null | grep -i hertz || echo "  (none)"
    echo "--- unit file type:";      ls -la "/etc/systemd/system/${SERVICE_NAME}.service"
    warn "If nothing above shows nvm but systemd still uses it:  sudo reboot  (clears /run) — then re-run this installer."
    die "Refusing to continue with a broken unit definition."
  fi
  log "Unit OK: $(echo "${EFFECTIVE_UNIT}" | grep -m1 '^ExecStart' || echo 'ExecStart set')"
  as_root systemctl reset-failed "${SERVICE_NAME}" 2>/dev/null || true
  # A manually-started server (pnpm start) would hold the port and crash-loop the service.
  pkill -f "packages/cli/dist/bin.js start" 2>/dev/null || true
  as_root pkill -u "$RUN_AS_USER" -f "packages/cli/dist/bin.js start" 2>/dev/null || true
  sleep 1
  as_root systemctl restart "${SERVICE_NAME}"

  log "Waiting for the WebUI to answer on port ${PORT} ..."
  up=0
  for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then up=1; break; fi
    sleep 1
  done

  if [ "$up" -ne 1 ]; then
    # Most common crash after switching Node versions: native modules built for
    # a different ABI. Rebuild once and give it a second chance.
    warn "WebUI not answering yet — rebuilding native modules for this Node and retrying..."
    (cd "$INSTALL_DIR" && pnpm rebuild >/dev/null 2>&1 || true)
    as_root systemctl restart "${SERVICE_NAME}"
    for i in $(seq 1 30); do
      code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
      if [ "$code" = "200" ]; then up=1; break; fi
      sleep 1
    done
  fi

  if [ "$up" -eq 1 ]; then
    log "Service '${SERVICE_NAME}' is running in the background (survives reboot: enabled)."
  else
    warn "WebUI still not reachable — what the OS sees:"
    ss -ltnp 2>/dev/null | grep -E ":${PORT}\b" || echo "  (nothing is listening on port ${PORT})"
    warn "Service logs (last 40 lines):"
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
