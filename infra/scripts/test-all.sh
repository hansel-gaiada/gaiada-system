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
  npm test
done

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

echo "=== ALL GREEN ==="
