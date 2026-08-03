#!/bin/sh
# Recreate one or more VPS services so they pick up variables freshly written to
# infra/compose/.env. Born on the box as ~/gaiada/wire-automation.sh (it wired the
# AUTOMATION_* / N8N_* vars into `platform`); generalised and brought into the repo
# 2026-08-03 so the next operator does not have to rediscover the two traps below.
#
#   ./infra/scripts/wire-env.sh                    # default: platform
#   ./infra/scripts/wire-env.sh platform platform-ui
#   VERIFY='RENDERER_TOKEN|REPORT_RENDERER_URL' ./infra/scripts/wire-env.sh platform
#
# TRAP 1 — compose env is baked at container CREATE time. `restart` re-runs the SAME
# container with the SAME environment, so editing .env and restarting looks like it worked
# and changes nothing. Only `up -d --no-deps <svc>` (which RECREATES) re-reads .env.
#
# TRAP 2 — the overlay + profiles are NOT optional. docker-compose.hostdata.yml's header
# explains it: on the VPS, postgres/redis are host-run and their compose services are
# profile-disabled. Invoke the vps file alone and compose rejects the whole project with an
# unsatisfied `depends_on`. Both `--profile bot` and `--profile auth` are likewise required
# or the bot/keycloak services vanish from the project and their dependents fail to resolve.
#
# Verification is part of the script on purpose: the failure this guards against is a var
# that silently stayed unset, which is invisible in `docker ps` and in the logs.
set -eu

COMPOSE_DIR="$(cd "$(dirname "$0")/../compose" && pwd)"
SERVICES="${*:-platform}"
# Extended-regex alternation of the var names to echo back after recreating. The default
# covers the automation wiring this script was originally written for.
VERIFY="${VERIFY:-AUTOMATION_URL|N8N_WEBHOOK_BASE_URL}"

cd "$COMPOSE_DIR"

# shellcheck disable=SC2086  # SERVICES is a deliberate word-split list
docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml \
  --profile bot --profile auth up -d --no-deps $SERVICES

for svc in $SERVICES; do
  echo "--- ${svc} env (${VERIFY}) ---"
  # A var that is absent prints NOTHING rather than an empty value — that absence IS the
  # finding, so say so explicitly instead of leaving a blank line to be misread as "set".
  found=$(docker inspect "gaiada-${svc}-1" \
    --format "{{range .Config.Env}}{{println .}}{{end}}" \
    | grep -E "^(${VERIFY})=" || true)
  if [ -z "$found" ]; then
    echo "  (NONE of ${VERIFY} are present in this container — the passthrough is missing"
    echo "   from docker-compose.vps.yml, not just unset in .env)"
  else
    echo "$found" | sed 's/^/  /'
  fi
done
echo "DONE"
