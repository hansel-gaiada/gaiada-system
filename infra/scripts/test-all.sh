#!/bin/sh
# Local CI: typecheck + test every component. Run from anywhere:
#   sh infra/scripts/test-all.sh
set -eu
# NOTE: the platform suite needs Postgres (DATABASE_URL_TEST) AND a running Cerbos
# (CERBOS_URL, default :3592). Start Cerbos: docker run -p 3592:3592 -v <repo>/platform-nest/cerbos:/config -v <repo>/platform-nest/cerbos/policies:/policies ghcr.io/cerbos/cerbos server --config=/config/cerbos.yaml
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

for proj in wa-chat-bot mcp-hub platform-nest ai-agents; do
  echo "=== $proj ==="
  cd "$ROOT/$proj"
  [ -d node_modules ] || npm ci
  npm run typecheck
  # A1: withTenants() tenant-scoping lint — platform-nest only (the choke-point it guards).
  [ "$proj" = "platform-nest" ] && npm run lint:withtenants
  # 2026-07-30 migration-backfill RLS lint — platform-nest only (it owns migrations/).
  [ "$proj" = "platform-nest" ] && npm run lint:migration-rls
  npm test
done

# P3-12: platform-ui build gate (tsc + vitest passed while `next build` broke on a server-only
# import reaching a client component and routes 500'd — `next build` is the real gate for that).
# DEMO_MODE=1 so no backend is needed. Playwright smoke check is optional locally (not run here
# by default — needs a browser install); CI runs it. To run it yourself:
#   cd platform-ui && DEMO_MODE=1 npx playwright test --project=smoke --grep @smoke
echo "=== platform-ui ==="
cd "$ROOT/platform-ui"
[ -d node_modules ] || npm ci
npm run typecheck
npm test
DEMO_MODE=1 npm run build

# ai-gateway is the Go service (ai-gateway-go/); it replaced the retired Node gateway.
echo "=== ai-gateway-go ==="
cd "$ROOT/ai-gateway-go"
go build ./...
go vet ./...
go test ./...

# sync-engine-go (WS1 T2 cross-site reconciliation). Build + vet always; DB-backed tests
# (apply/convergence/chaos) run only when DATABASE_URL_TEST etc. point at migrated databases
# with a NOBYPASSRLS role — otherwise they self-skip. See sync-engine-go/README.md.
echo "=== sync-engine-go ==="
cd "$ROOT/sync-engine-go"
go build ./...
go vet ./...
go test ./...

# WS9 observability config-lint (promtool/amtool/otelcol if present, else YAML/JSON parse).
echo "=== observability configs ==="
sh "$ROOT/infra/scripts/lint-observability.sh"

echo "=== ALL GREEN ==="
