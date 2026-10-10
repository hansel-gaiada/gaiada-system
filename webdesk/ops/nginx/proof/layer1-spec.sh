#!/bin/sh
# WSK-63a proof: webdesk/api Layer 1 specs, in node:22-bookworm, against a throwaway Postgres (gw-pg).
set -eu
cd /repo/webdesk
npm ci --no-audit --no-fund --ignore-scripts >/dev/null 2>&1
MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@gw-pg:5432/webdesk" node migrations/migrate.mjs | tail -2
cd api
npm ci --no-audit --no-fund --ignore-scripts >/dev/null 2>&1
export WSK21_TEST_DATABASE_URL="postgres://webdesk_app:throwaway_app@gw-pg:5432/webdesk"
export WSK21_MIGRATE_DATABASE_URL="postgres://webdesk_migrator:throwaway_migrator@gw-pg:5432/webdesk"
npx vitest run test/mtls-verifier.spec.ts test/control-auth-layers.spec.ts 2>&1 | tail -45
