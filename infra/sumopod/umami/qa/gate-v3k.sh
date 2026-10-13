#!/usr/bin/env bash
# M5 V3-k, the ERP half: run ONE platform-nest DB test against a REAL insights-collector (the throwaway
# ~/umami-v3k stack), with throwaway postgres/redis/cerbos. Based on ~/gate-files.sh.
#   usage: bash gate-v3k.sh <ID> <patchfile> <base-sha> <test-path-under-platform-nest>
# Keys and the website id are read from ~/umami-v3k (0600 files) and never printed.
set -uo pipefail
ID="${1:?id}"; P="${2:?patch}"; BASE="${3:?base}"; TEST="${4:?test path}"
D="$HOME/gv-$ID"; NET="gv-$ID"; QA="${QA:-$HOME/umami-v3k}"
cleanup() { docker rm -f "pg-gv-$ID" "redis-gv-$ID" "cerbos-gv-$ID" "node-gv-$ID" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; sudo -n rm -rf "$D" 2>/dev/null; }
trap cleanup EXIT
echo "### gate-v3k $ID $(date -Is)"
sudo -n rm -rf "$D" 2>/dev/null || rm -rf "$D"
git clone --quiet --filter=blob:none https://github.com/hansel-gaiada/gaiada-system.git "$D" || { echo "CLONE FAILED"; exit 1; }
git -C "$D" checkout --quiet "$BASE" || { echo "BASE NOT FOUND"; exit 1; }
git -C "$D" apply --whitespace=nowarn "$P" || { echo "PATCH FAILED"; exit 2; }
echo "base $(git -C "$D" rev-parse --short HEAD); patch files: $(grep -c '^+++ b/' "$P"), new: $(grep -c '^--- /dev/null' "$P")"
docker network create "$NET" >/dev/null
docker run -d --name "pg-gv-$ID" --network "$NET" -e POSTGRES_PASSWORD=postgres postgres:17-alpine \
  -c max_connections=200 -c fsync=off -c full_page_writes=off -c synchronous_commit=off >/dev/null
docker run -d --name "redis-gv-$ID" --network "$NET" redis:7-alpine >/dev/null
docker run -d --name "cerbos-gv-$ID" --network "$NET" \
  -v "$D/platform-nest/cerbos:/config:ro" -v "$D/platform-nest/cerbos/policies:/policies:ro" \
  ghcr.io/cerbos/cerbos:0.54.0 server --config=/config/cerbos.yaml >/dev/null
for i in $(seq 1 40); do docker exec "pg-gv-$ID" pg_isready -q && break; sleep 2; done
docker exec "pg-gv-$ID" pg_isready -q || { echo "PG NEVER CAME UP"; exit 3; }
RK=$(cat "$QA/.read-key"); FK=$(cat "$QA/.forget-key"); W=$(cat "$QA/.website")
ENVF=$(mktemp); chmod 600 "$ENVF"
cat > "$ENVF" <<EOF
DATABASE_URL_TEST=postgres://postgres:postgres@pg-gv-$ID:5432/postgres
DATABASE_URL=postgres://postgres:postgres@pg-gv-$ID:5432/postgres
CERBOS_URL=http://cerbos-gv-$ID:3592
REDIS_URL_TEST=redis://redis-gv-$ID:6379
REDIS_URL=redis://redis-gv-$ID:6379
CI=1
INSIGHTS_E2E=1
INSIGHTS_E2E_COLLECT_URL=http://collector:8080
INSIGHTS_BASE_URL=http://collector:8081
INSIGHTS_READ_KEY=$RK
INSIGHTS_FORGET_KEY=$FK
INSIGHTS_E2E_WEBSITE=$W
EOF
unset RK FK
docker create --name "node-gv-$ID" --network "$NET" --env-file "$ENVF" -v "$D:/w" -w /w/platform-nest node:22-bookworm \
  bash -lc "npm ci --no-audit --no-fund >/dev/null 2>&1 && npx tsc --noEmit && echo 'tsc ok' && npx vitest run $TEST 2>&1 | tail -80" >/dev/null
rm -f "$ENVF"
docker network connect umami-v3k_internal "node-gv-$ID"
docker start -a "node-gv-$ID"
echo "### done $ID $(date -Is)"
