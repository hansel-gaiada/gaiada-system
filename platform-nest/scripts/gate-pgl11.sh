#!/usr/bin/env bash
# PGL-11 gate: tsc + ONLY the listed platform-nest vitest files against a pinned base sha, with throwaway
# postgres / redis / cerbos / MAILPIT containers on a private network. No host ports published. Tears down on exit.
# Derived from gate-files.sh. usage: bash gate-pgl11.sh <ID> <patchfile> <base-sha> nest:<path-under-platform-nest>...
set -uo pipefail
ID="${1:?need an ID}"; P="${2:?need a patch}"; BASE="${3:?need a base sha}"; shift 3
NEST=()
for a in "$@"; do case "$a" in nest:*) NEST+=("${a#nest:}");; *) echo "ignoring arg $a";; esac; done
D="$HOME/gp-$ID"; NET="gp-$ID"
cleanup() { docker rm -f "pg-gp-$ID" "redis-gp-$ID" "cerbos-gp-$ID" "mailpit-gp-$ID" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; sudo -n rm -rf "$D" 2>/dev/null; }
trap cleanup EXIT
echo "### gate-pgl11 $ID $(date -Is) nest=${#NEST[@]}"
sudo -n rm -rf "$D" 2>/dev/null || rm -rf "$D"
git clone --quiet --filter=blob:none https://github.com/hansel-gaiada/gaiada-system.git "$D" || { echo "CLONE FAILED"; exit 1; }
git -C "$D" checkout --quiet "$BASE" || { echo "BASE $BASE NOT FOUND"; exit 1; }
git -C "$D" apply --whitespace=nowarn "$P" || { echo "PATCH FAILED"; exit 2; }
echo "base: $(git -C "$D" rev-parse --short HEAD) patch files: $(grep -c '^+++ b/' "$P")"
docker network create "$NET" >/dev/null 2>&1
docker run -d --name "pg-gp-$ID" --network "$NET" --memory 1g -e POSTGRES_PASSWORD=postgres postgres:17-alpine \
  -c max_connections=200 -c fsync=off -c full_page_writes=off -c synchronous_commit=off >/dev/null
docker run -d --name "redis-gp-$ID" --network "$NET" --memory 256m redis:7-alpine >/dev/null
docker run -d --name "cerbos-gp-$ID" --network "$NET" --memory 512m \
  -v "$D/platform-nest/cerbos:/config:ro" -v "$D/platform-nest/cerbos/policies:/policies:ro" \
  ghcr.io/cerbos/cerbos:0.54.0 server --config=/config/cerbos.yaml >/dev/null
docker run -d --name "mailpit-gp-$ID" --network "$NET" --memory 256m axllent/mailpit:latest >/dev/null
for i in $(seq 1 40); do docker exec "pg-gp-$ID" pg_isready -q && break; sleep 2; done
docker exec "pg-gp-$ID" pg_isready -q || { echo "PG NEVER CAME UP"; exit 3; }
echo "mailpit: $(docker inspect -f '{{.State.Status}}' mailpit-gp-$ID)"
run() { # run <pkgdir> <cmd>
  docker run --rm --network "$NET" --memory 5g -v "$D:/w" -w "/w/$1" \
    -e DATABASE_URL_TEST="postgres://postgres:postgres@pg-gp-$ID:5432/postgres" \
    -e DATABASE_URL="postgres://postgres:postgres@pg-gp-$ID:5432/postgres" \
    -e CERBOS_URL="http://cerbos-gp-$ID:3592" \
    -e REDIS_URL_TEST="redis://redis-gp-$ID:6379" -e REDIS_URL="redis://redis-gp-$ID:6379" \
    -e MAIL_ENABLED=1 -e CLIENT_MAIL_ENABLED=1 \
    -e MAIL_STREAM_NOTIFY_RELAY_HOST="mailpit-gp-$ID" -e MAIL_STREAM_NOTIFY_RELAY_PORT=1025 \
    -e MAIL_STREAM_NOTIFY_FROM="Gaiada QA <no-reply@notify.pgl11.test>" \
    -e MAIL_LINK_BASE_URL="https://erp.pgl11.test" \
    -e PGL11_MAILPIT_URL="http://mailpit-gp-$ID:8025" \
    -e CI=1 -e NODE_OPTIONS=--max-old-space-size=4096 node:22-bookworm bash -lc "$2"
}
echo "=== platform-nest: tsc + ${NEST[*]}"
run platform-nest "npm ci --no-audit --no-fund >/dev/null 2>&1 && npx tsc --noEmit && echo 'tsc ok' && npx vitest run --reporter=verbose ${NEST[*]} 2>&1 | tail -150"
echo "### done $ID $(date -Is)"
