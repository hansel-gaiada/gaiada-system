# TR-19 — report-renderer sidecar. The ONLY image in the estate carrying Chromium; every other
# service (incl. platform-ui, which is a browser-free Next standalone build) stays browser-free.
#
# Base image is pinned to the repo's actual `@playwright/test` version (platform-ui/package.json:
# "@playwright/test": "^1.61.1"), NOT a guessed number. The `playwright` npm dependency in
# package.json is pinned to the EXACT same version (no `^`) — the launcher's `chromium.launch()`
# looks for a browser build matching the installed `playwright` package version, and this base
# image only ships the browser revision that shipped with v1.61.1. A caret range here would let
# `npm ci` resolve a newer patch whose bundled browser isn't preinstalled, and `chromium.launch()`
# would fail at runtime looking for a browser executable that was never downloaded (no network
# egress is intended for this container beyond the internal platform-ui origin).
#
# VERIFIED 2026-07-31: `docker build .` succeeds and a real container (`docker run`, and
# separately via `docker compose ... up --no-deps report-renderer`) launches Chromium, navigates,
# and returns a real multi-KB PDF — see docs/modules/CHANGELOG.md's report-renderer entry for the
# exact commands/output. That verification ran on Docker Desktop (Windows, Linux-VM backend), NOT
# the production Linux VPS this image will actually deploy to — re-confirm `docker compose ps`
# shows this service healthy on the real target host before relying on it there, same discipline
# as every other component in this estate.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src

# Playwright base images run as the non-root `pwuser` by default, which is correct here — this
# service holds only the shared RENDERER_TOKEN, never tenant credentials, and needs no root
# capability.
USER pwuser

EXPOSE 3007
CMD ["npx", "tsx", "src/server.ts"]
