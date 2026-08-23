# KucLab Hertz — "computer" image for docker-backend agents.
#
# Each agent with computer_backend = "docker" gets a container from this image:
# its own filesystem workspace, shells, a full desktop environment (Xfce on a
# virtual display, watchable/streamable from the WebUI), and preinstalled
# Playwright Chromium for browser automation that runs ON that desktop.
# Project roots and the agent's personal directory are bind-mounted at their
# host-absolute paths by the server, so tool code needs no path translation.
#
# Build once on the host running Hertz:
#   docker build -t kuclab-hertz-computer:latest -f docker/computer.Dockerfile .
FROM mcr.microsoft.com/playwright:v1.49.0-noble

ENV DEBIAN_FRONTEND=noninteractive

# Core CLI tooling agents expect: build tools, VCS/GitHub CLI, search, scripting,
# plus the desktop stack: Xvfb (virtual display), x11vnc (VNC server),
# noVNC/websockify (browser client), and a lightweight Xfce desktop.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gh jq ripgrep python3 python3-pip python3-venv \
      build-essential sqlite3       unzip zip tree procps net-tools scrot \
      xvfb x11vnc novnc websockify \
      xfce4 xfce4-terminal thunar \
      dbus-x11 x11-utils xdotool wmctrl \
      fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Playwright browsers are baked into the base image at /ms-playwright.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /workspace

# Long-lived "computer": the server exec's into it; the entrypoint just idles.
CMD ["sleep", "infinity"]
