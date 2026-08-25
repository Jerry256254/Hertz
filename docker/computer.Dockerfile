# KucLab Hertz — "computer" image for docker-backend agents.
#
# Each agent with computer_backend = "docker" gets a container from this image:
# its own filesystem workspace, shells, a minimal lightweight desktop
# (openbox + tint2, terminal + file manager + browser only), and preinstalled
# Playwright Chromium + Google Chrome for reliable Google sign-in.
# Project roots and the agent's personal directory are bind-mounted at their
# host-absolute paths by the server.

FROM mcr.microsoft.com/playwright:v1.49.0-noble

ENV DEBIAN_FRONTEND=noninteractive

# Core CLI tools + minimal desktop stack:
# - Xvfb/x11vnc/novnc/websockify for streaming
# - openbox (window manager, ~1 MB) + tint2 (panel) — NO full xfce4
# - xterm + thunar (terminal + file manager only)
# - dbus/xdotool for automation
# - Google Chrome stable for Google sign-in (Chromium is often blocked as insecure)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg wget git gh jq ripgrep python3 python3-pip python3-venv \
      build-essential sqlite3 unzip zip tree procps net-tools scrot \
      xvfb x11vnc novnc websockify \
      openbox tint2 xterm thunar \
      dbus-x11 x11-utils xdotool wmctrl menu \
      fonts-liberation fonts-noto-color-emoji \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/google-chrome-stable /usr/bin/chromium \
    && ln -sf /usr/bin/google-chrome-stable /usr/bin/chromium-browser \
    && ln -sf /usr/bin/google-chrome-stable /usr/bin/google-chrome

# Playwright browsers baked at /ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN npm i -g playwright@1.49.0 --no-audit --no-fund

WORKDIR /workspace
CMD ["sleep", "infinity"]
