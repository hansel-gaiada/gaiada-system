# Two stages so the runtime image carries no toolchain and no dev dependencies.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
# `npm install` rather than `npm ci`: this project's only dependencies are typescript and the node
# types, and requiring a committed lockfile for two devDependencies buys nothing while breaking the
# build whenever the lockfile lags package.json.
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npx tsc

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The compiled driver, plus the generated cast list it refuses to run without. The roster is data,
# not code, so it sits beside dist/ exactly where src/roster.ts resolves it from.
COPY --from=build /app/dist ./dist
COPY roster.generated.json ./roster.generated.json
# No package.json dependencies to install: the driver is deliberately dependency-free at runtime and
# uses only node built-ins plus global fetch.
RUN printf '{"type":"module"}\n' > package.json
# Unprivileged, and the log volume is chowned by compose. A harness that writes a corpus as root
# leaves files the owner cannot read without sudo.
USER node
CMD ["node", "dist/main.js"]
