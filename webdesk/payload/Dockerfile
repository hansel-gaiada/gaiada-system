# WSK-29 — webdesk/payload's own image. Follows platform-ui/Dockerfile's Next.js standalone-output
# shape (the house pattern for this repo's other Next app) rather than inventing a new one.
#
# TWO PROCESSES CAN RUN FROM THIS ONE IMAGE — WSK-02's own design (payload/README.md, public-
# gateway.mjs's header): the internal Payload/Next admin app (this Dockerfile's default CMD) and
# the public gateway (`node src/public-gateway.mjs`, a separate plain-Node process with no Next/
# Payload import — the enforcement story for /admin never being reachable publicly). The gateway
# needs no build step at all; a deploying compose file overrides CMD for that service rather than
# this image needing two Dockerfiles for one codebase.
#
# NOT wired into release.yml's build matrix yet — same reason as webdesk/api/Dockerfile's header:
# no Zone B target exists yet (A-12). This Dockerfile is also currently RED at the type-check step
# (`next build`) — see this ticket's report and ci.yml's `webdesk-payload` job comment for the exact
# 4 files / TS2578 errors, which are outside this ticket's file ownership and were reported, not
# fixed. `docker build` on this file will fail until that lands; kept as source-of-truth for the
# eventual image shape rather than omitted, so the fix is a one-command verification, not a
# from-scratch Dockerfile write.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PAYLOAD_INTERNAL_PORT=3100
# Standalone output (next.config.mjs). platform-ui/Dockerfile's equivalent third copy is its own
# `public/` dir; this project has none today (no `webdesk/payload/public/` exists) — add it back
# here if that changes, exactly as platform-ui's Dockerfile does.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# The public gateway is a separate plain-Node script (no build step) — copied alongside the
# standalone server output so a compose `command:` override can select it without a second image.
COPY --from=build /app/src/public-gateway.mjs ./src/public-gateway.mjs
EXPOSE 3100
CMD ["node", "server.js"]
