# KucLab Hertz — "computer" image for docker-backend agents.
#
# Each agent with computer_backend = "docker" gets a container from this image:
# its own filesystem workspace, shells, and (preinstalled) Playwright Chromium
# for browser automation. Project roots and the agent's personal directory are
# bind-mounted at their host-absolute paths by the server, so tool code needs
# no path translation.
#
# Build once on the host running Hertz:
#   docker build -t kuclab-hertz-computer:latest -f docker/computer.Dockerfile .
FROM mcr.microsoft.com/playwright:v1.49.0-noble

# Core CLI tooling agents expect: build tools, VCS/GitHub CLI, search, scripting.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gh jq ripgrep python3 python3-pip python3-venv \
      build-essential sqlite3 unzip zip tree procps net-tools \
    && rm -rf /var/lib/apt/lists/*

# Playwright browsers are baked into the base image at /ms-playwright.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /workspace

# Long-lived "computer": the server exec's into it; the entrypoint just idles.
CMD ["sleep", "infinity"]
