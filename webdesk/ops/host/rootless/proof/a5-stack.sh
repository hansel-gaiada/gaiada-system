#!/usr/bin/env bash
# a5-stack.sh - P2 acceptance row A5: the whole proof stack, real images, then the rebased containment probe
# (M4 F6; plan §9 A5). Run after a4-copy-rehearsal.sh.
#
#   sudo bash a5-stack.sh
#
# 1. stages the private api image on the proof daemon (docker save | docker load; REFUSES unless the loaded id equals
#    the digest in WEBDESK_API_IMAGE, which is read from the proof env, i.e. live's value at proof-env.sh time);
# 2. starts postgres, redis and rustfs first and compares the per-table row counts to A4's BEFORE the api can write
#    anything (strict: any difference FAILs); checks the three application roles log in with the PROOF passwords over
#    the compose network (password on stdin, never argv), and that a wrong password and the passwordless webdesk_backup
#    role are refused over TCP (controls);
# 3. `compose up -d --no-build` for the whole stack; waits for the api's "listening on :3000", the editorial JWKS, the
#    first content tick with errors=0, and for `curl -H 'Host: api.erp.gaiada.com' http://127.0.0.1:18380/healthz` = 200
#    plus /v1/t/<random>/collections = 401 application/problem+json;
# 4. asserts the api container really runs with MAIL_ENABLED / WEBDESK_ZONEB_EVENTS_ENABLED / OTEL_ENABLED = false;
# 5. runs the rebased containment probe once per probe number: 1, 3, 4, 5, 6 must pass. Probe 2 (host nginx routes to the
#    loopback Caddy) is N/A, because no nginx vhost routes to 18380; the probe has no skip switch but honours PROBE_ONLY,
#    so 2 is simply not counted. It IS run once, and its FAIL lines are listed as INFO so that "fails only for that reason"
#    can be read, not assumed;
# 6. compares the row counts again after the api has run (informational: a running api may legitimately write; only a
#    table that LOST rows FAILs).
# Evidence (root 0700): /srv/wdproof/evidence/a5/. Leaves the stack RUNNING (A7 and A8 need it).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=proof-lib.sh
. "$HERE/proof-lib.sh"

A4_COUNTS="$PROOF_EVID/a4/counts.rootful.txt"
PUBLIC_HOST="${WEBDESK_PUBLIC_HOST:-api.erp.gaiada.com}"
EV=""
PGCT=wdproof-postgres-1
APICT=wdproof-api-1

proof_healthy() { [ "$(dp inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ]; }
healthz_200() { [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Host: $PUBLIC_HOST" "http://127.0.0.1:$PROOF_PORT/healthz")" = 200 ]; }
api_listening() { dp logs "$APICT" 2>&1 | grep -q 'listening on :3000'; }
api_jwks() { dp logs "$APICT" 2>&1 | grep -q 'editorial JWKS loaded'; }
api_tick0() { dp logs "$APICT" 2>&1 | grep -E 'content tick @ .* errors=[0-9]+' | tail -n 1 | grep -Eq 'errors=0([^0-9]|$)'; }
problem401() {
  local r p
  p="/v1/t/wd-proof-$(head -c6 /dev/urandom | od -An -tx1 | tr -d ' \n')/collections"
  r="$(curl -s -m 10 -o /dev/null -w '%{http_code} %{content_type}' -H "Host: $PUBLIC_HOST" "http://127.0.0.1:$PROOF_PORT$p" || true)"
  [[ "$r" == "401 application/problem+json"* ]]
}
svc_running() { [ "$(dp inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }

counts_proof() { dp exec "$PGCT" psql -U "$(envget POSTGRES_SUPERUSER)" -d "$(envget POSTGRES_DB)" -X -A -t -c "$COUNTS_SQL" 2>/dev/null; }

# role_login <user> <password> <expect ok|refused>: TCP login from inside the postgres container over the compose network.
# The password goes in on stdin; psql reads it from the environment of a shell that read it, so it is never on argv.
role_login() {
  local u=$1 pw=$2 want=$3 db out rc
  db="$(envget POSTGRES_DB)"
  out="$(printf '%s\n' "$pw" | dp exec -i "$PGCT" sh -c 'IFS= read -r PGPASSWORD; export PGPASSWORD; psql -h postgres -U "$0" -d "$1" -X -A -t -w -c "select current_user"' "$u" "$db" 2>&1)"
  rc=$?
  if [ "$want" = ok ]; then [ "$rc" = 0 ] && [ "$out" = "$u" ]; else [ "$rc" != 0 ]; fi
}

# probe_run <n>: one containment-probe number, rebased onto the proof project/daemon/tree/env.
probe_run() {
  local n=$1
  PROBE_ONLY="$n" WS4_HMAC_RETIRED=1 WEBDESK_PROJECT="$PROOF_PROJECT" WEBDESK_DOCKER_HOST="$PROOF_SOCK" WEBDESK_DIR="$PROOF_TREE" \
    WEBDESK_ENV_FILE="$PROOF_ENV" bash "$PROOF_TREE/ops/probes/containment-probe.sh" >"$EV/probe-$n.out" 2>&1
}

main() {
  hdr "preflight"
  require_proof_context
  require_daemons
  require_proof_files
  [ -f "$A4_COUNTS" ] || die "REFUSED: $A4_COUNTS is missing (run a4-copy-rehearsal.sh first)"
  local v
  for v in wdproof_webdesk_pgdata wdproof_webdesk_rustfsdata wdproof_webdesk_redisdata; do
    dp volume inspect "$v" >/dev/null 2>&1 || die "REFUSED: proof volume $v is missing (run a4-copy-rehearsal.sh first)"
  done
  [ -r "$PROOF_TREE/ops/probes/containment-probe.sh" ] || die "the proof tree has no containment-probe.sh"
  EV="$(ev_dir a5)"
  stage_api_image || die "the api image is not staged"

  hdr "start the data tier first (so the counts can be compared before the api writes anything)"
  wdc up -d --no-build --no-deps postgres redis rustfs >/dev/null 2>&1 && pass "postgres, redis, rustfs started" || die "could not start the data tier"
  wait_until 120 proof_healthy "$PGCT" && pass "postgres healthy" || die "postgres is not healthy"
  wait_until 120 proof_healthy wdproof-rustfs-1 && pass "rustfs healthy" || die "rustfs is not healthy"
  counts_proof >"$EV/counts.proof-pre-api.txt"
  if diff -q "$A4_COUNTS" "$EV/counts.proof-pre-api.txt" >/dev/null; then pass "row counts equal A4's ($(grep -c . "$A4_COUNTS") tables, before the api runs)"
  else fail "row counts differ from A4's:"; diff "$A4_COUNTS" "$EV/counts.proof-pre-api.txt" | head -n 10 | sed 's/^/        /'; fi
  [ "$(dp exec "$PGCT" psql -U "$(envget POSTGRES_SUPERUSER)" -d "$(envget POSTGRES_DB)" -X -A -t -c 'SELECT count(*) FROM public.tenant_webhooks WHERE enabled' 2>/dev/null)" = 0 ] \
    && pass "no tenant webhook is enabled in the proof DB" || fail "an enabled tenant webhook exists in the proof DB"

  hdr "the application roles use the PROOF passwords (TCP over the compose network)"
  role_login "$(envget POSTGRES_OWNER_USER)" "$(envget POSTGRES_OWNER_PASSWORD)" ok && pass "owner role logs in with the proof password" || fail "owner role cannot log in with the proof password"
  role_login "$(envget POSTGRES_MIGRATOR_USER)" "$(envget POSTGRES_MIGRATOR_PASSWORD)" ok && pass "migrator role logs in with the proof password" || fail "migrator role cannot log in with the proof password"
  role_login "$(envget POSTGRES_APP_USER)" "$(envget POSTGRES_APP_PASSWORD)" ok && pass "app role logs in with the proof password" || fail "app role cannot log in with the proof password"
  role_login "$(envget POSTGRES_APP_USER)" "not-the-password" refused && pass "control: the app role is refused with a wrong password" || fail "control: a wrong password was ACCEPTED"
  role_login webdesk_backup "" refused && pass "control: webdesk_backup (no password) cannot log in over TCP" || fail "control: webdesk_backup logged in over TCP"

  hdr "the whole stack: compose up -d --no-build"
  wdc up -d --no-build >/dev/null 2>&1 && pass "compose up -d --no-build" || die "compose up failed"
  local s
  for s in proxy api postgres redis rustfs; do
    wait_until 90 svc_running "wdproof-$s-1" && pass "wdproof-$s-1 is running" || fail "wdproof-$s-1 is not running"
  done
  wdc ps 2>&1 | sed 's/^/        /'
  wait_until 120 api_listening && pass "api log: listening on :3000" || fail "api log: no 'listening on :3000' within 120 s"
  wait_until 120 api_jwks && pass "api log: editorial JWKS loaded" || fail "api log: no 'editorial JWKS loaded' within 120 s"
  wait_until 120 healthz_200 && pass "GET http://127.0.0.1:$PROOF_PORT/healthz (Host: $PUBLIC_HOST) = 200" || fail "healthz did not return 200 within 120 s"
  wait_until 60 problem401 && pass "GET /v1/t/<random>/collections = 401 application/problem+json" || fail "the /v1 route did not answer 401 problem+json"
  wait_until 150 api_tick0 && pass "api log: content tick errors=0 (the app roles work end to end)" || fail "api log: no 'content tick ... errors=0' within 150 s"
  [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PROOF_PORT/healthz")" != 000 ] && pass "the published loopback port $PROOF_PORT answers from the host" || fail "nothing answers on 127.0.0.1:$PROOF_PORT"

  hdr "the proof api cannot reach out: mail / Zone-B events / OTLP are off in the container"
  local k val
  for k in MAIL_ENABLED WEBDESK_ZONEB_EVENTS_ENABLED OTEL_ENABLED WEBDESK_OTEL_ZONEA_PUSH_ENABLED; do
    val="$(dp exec "$APICT" printenv "$k" 2>/dev/null || true)"
    [ "$val" = false ] && pass "$APICT: $k=false" || fail "$APICT: $k='$val' (expected false)"
  done
  [ -z "$(dp exec "$APICT" printenv WEBDESK_ZONEB_BRIDGE_URL 2>/dev/null || true)" ] && pass "$APICT: WEBDESK_ZONEB_BRIDGE_URL is empty" || fail "$APICT: WEBDESK_ZONEB_BRIDGE_URL is set"

  hdr "rebased containment probe (probe 2 is N/A: no nginx vhost routes to $PROOF_PORT)"
  local n np nf
  for n in 1 3 4 5 6; do
    probe_run "$n"
    np="$(grep -c '^  PASS' "$EV/probe-$n.out" || true)"
    nf="$(grep -c '^  FAIL' "$EV/probe-$n.out" || true)"
    if [ "${nf:-0}" = 0 ] && [ "${np:-0}" -gt 0 ]; then pass "containment probe $n: $np check(s) passed, 0 failed"
    else fail "containment probe $n: $np passed, $nf failed (raw output: $EV/probe-$n.out)"; grep '^  FAIL' "$EV/probe-$n.out" | head -n 8 | cut -c1-200 | sed 's/^/        /'; fi
  done
  probe_run 2
  nf="$(grep -c '^  FAIL' "$EV/probe-2.out" || true)"
  info "probe 2 (N/A, not counted): $nf FAIL line(s), exactly the ones that need a host nginx vhost:"
  grep '^  FAIL' "$EV/probe-2.out" | cut -c1-200 | sed 's/^/        /'

  hdr "row counts after the api has run (informational)"
  counts_proof >"$EV/counts.proof-post-api.txt"
  if diff -q "$EV/counts.proof-pre-api.txt" "$EV/counts.proof-post-api.txt" >/dev/null; then pass "row counts unchanged by the running api"
  else
    local lost
    lost="$(join -j1 <(awk '{print $1, $2}' "$EV/counts.proof-pre-api.txt" | sort) <(awk '{print $1, $2}' "$EV/counts.proof-post-api.txt" | sort) | awk '$3 < $2 { print $1 " " $2 "->" $3 }')"
    if [ -z "$lost" ]; then pass "the api added rows in: $(diff "$EV/counts.proof-pre-api.txt" "$EV/counts.proof-post-api.txt" | grep '^>' | awk '{print $2}' | tr '\n' ' ') (none lost)"
    else fail "tables that LOST rows while the api ran: $lost"; fi
  fi
  info "evidence: $EV    the proof stack is left RUNNING for A7/A8"
  info "next: bash $HERE/a7-backup.sh"
  summary
}

main "$@"
