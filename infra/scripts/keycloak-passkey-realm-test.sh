#!/usr/bin/env bash
# PID-2 proof harness, for a TEST server only (sumopod). Throwaway Keycloak + Postgres on an INTERNAL docker network
# (nothing can call out), the repo realm file (no live data), then keycloak-passkey-realm.sh and a Playwright run with
# Chrome's virtual authenticator. Never touches live.
#
#   keycloak-passkey-realm-test.sh all          # up, apply, e2e, revert-check, down (one run, cleans up on exit)
#   keycloak-passkey-realm-test.sh up|apply|e2e|revert-check|down   # the same steps one at a time (iteration)
#
# Files expected next to it in ~/kc-pid2: keycloak-passkey-realm.sh, keycloak-passkey-realm.e2e.cjs,
# gaiada-realm.json (the repo's infra/compose/keycloak/gaiada-realm.json), pw/node_modules/playwright-core (1.56.0,
# installed once: see the e2e file's header). The lock ~/e2e.lock is held from `up` to `down`.
#
# Like live, the realm is born on 26.0.8 and upgraded to 26.8.1 (so the copied `browser` flow has live's shape).
# The test realm uses SHORT brute-force waits (15 s instead of 60/900 s) and failureFactor 3, so the lockout and its
# recovery can be driven in a minute; the script's defaults are the live values.
set -uo pipefail
MODE=${1:?usage: keycloak-passkey-realm-test.sh all|up|apply|e2e|revert-check|down}
D=$HOME/kc-pid2; ST=$D/state.env; LOCK=$HOME/e2e.lock
NET=pid2-net; PGC=pid2-pg; KC=pid2-kc
OLD=quay.io/keycloak/keycloak:26.0.8; NEW=quay.io/keycloak/keycloak:26.8.1; PGI=postgres:15.18
PWI=mcr.microsoft.com/playwright:v1.56.0-noble
USERS="alice bob nina carl sam tess ivan"
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; }

kc_env() { printf -- '-e KC_DB=postgres -e KC_DB_URL=jdbc:postgresql://%s:5432/kc -e KC_DB_USERNAME=kc -e KC_DB_PASSWORD=%s -e KC_HTTP_RELATIVE_PATH=/idp -e KC_HEALTH_ENABLED=true' "$PGC" "$PGPW"; }
kc_up() {
  # shellcheck disable=SC2046
  docker run -d --name "$KC" --network "$NET" --memory 1500m $(kc_env) -e KC_BOOTSTRAP_ADMIN_USERNAME=pid2-admin \
    -e KC_BOOTSTRAP_ADMIN_PASSWORD="$ADMPW" "$1" start-dev >/dev/null || return 1
  for _ in $(seq 150); do
    docker exec "$KC" bash -c 'exec 3<>/dev/tcp/127.0.0.1/9000 && printf "GET /idp/health/ready HTTP/1.1\r\nHost: l\r\nConnection: close\r\n\r\n" >&3 && cat <&3' 2>/dev/null | grep -q '"status": "UP"' && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$KC" 2>/dev/null)" = true ] || return 1; sleep 2
  done; return 1
}
K() { docker exec "$KC" /opt/keycloak/bin/kcadm.sh "$@" --config /tmp/h.cfg; }
kc_login() { docker exec -e P="$ADMPW" "$KC" sh -c '/opt/keycloak/bin/kcadm.sh config credentials --config /tmp/h.cfg --server http://localhost:8080/idp --realm master --user pid2-admin --password "$P"' >/dev/null 2>&1; }
load() { [ -f "$ST" ] || { echo "STOP: no $ST (run up first)"; exit 2; }; set -a; . "$ST"; set +a; }
script_env() { # the realm script with the test parameters
  KC_CONTAINER=$KC KC_SERVER=http://localhost:8080/idp KC_ADMIN_USER=pid2-admin KC_ADMIN_PASSWORD=$ADMPW \
  REALM=gaiada BACKUP_DIR=$D/backups RP_ID=localhost RP_NAME="Gaiada (test)" BIND=realm \
  AMR_CLIENTS="gaiada-ui gaiada-platform pid-test" BF_FAILURE_FACTOR=3 BF_WAIT_INCREMENT=15 BF_MAX_WAIT=15 BF_MIN_QUICK_WAIT=15 \
  "$@"
}
export_norm() { # normalised partial export of the realm (sorted keys) -> stdout
  # -o: kcadm create prints the response body only with -o (an empty export must never compare equal)
  K create realms/gaiada/partial-export -q exportClients=true -q exportGroupsAndRoles=true -o | jq -e -S 'del(.clients[]?.secret)' \
    || { echo "FAIL partial export empty or not JSON" >&2; return 1; }
}

down() {
  docker rm -f "$KC" "$PGC" pid2-pw >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1
  [ -f "$ST" ] && shred -u "$ST"; rm -rf "$D/backups" "$D/exports"
  [ -d "$LOCK" ] && grep -q PID-2 "$LOCK/owner" 2>/dev/null && rm -rf "$LOCK"
  echo "down: $(docker ps -a --filter name=pid2- --format '{{.Names}}' | wc -l) pid2 containers left, network $(docker network ls --filter name=$NET -q | wc -l), lock $([ -d "$LOCK" ] && echo held || echo free)"
}

up() {
  mkdir "$LOCK" 2>/dev/null || { echo "STOP: $LOCK is held by: $(cat "$LOCK"/* 2>/dev/null)"; exit 2; }
  echo "PID-2 passkey realm proof by $(whoami), $(date -u +%FT%TZ) (containers pid2-*)" > "$LOCK/owner"
  for i in "$OLD" "$NEW" "$PGI" "$PWI"; do docker image inspect "$i" >/dev/null 2>&1 || docker pull -q "$i" >/dev/null || { echo "STOP: cannot pull $i"; exit 2; }; done
  ( umask 077; : > "$ST" )
  PGPW=$(openssl rand -hex 16); ADMPW=$(openssl rand -hex 16)
  { echo "PGPW=$PGPW"; echo "ADMPW=$ADMPW"; for u in $USERS; do echo "PW_${u^^}=$(openssl rand -hex 10)Aa1!"; done; } >> "$ST"
  load
  docker network create --internal "$NET" >/dev/null
  docker run -d --name "$PGC" --network "$NET" --memory 512m -e POSTGRES_USER=kc -e POSTGRES_PASSWORD="$PGPW" -e POSTGRES_DB=kc "$PGI" >/dev/null
  for _ in $(seq 60); do docker exec "$PGC" pg_isready -U kc -d kc >/dev/null 2>&1 && break; sleep 1; done
  kc_up "$OLD" && kc_login && pass "26.0.8 up" || { fail "26.0.8 up"; docker logs "$KC" 2>&1 | tail -20; exit 1; }
  docker cp "$D/gaiada-realm.json" "$KC":/tmp/realm.json && K create realms -f /tmp/realm.json >/dev/null && pass "repo realm imported on 26.0.8" || { fail "realm import"; exit 1; }
  for u in $USERS; do
    K create users -r gaiada -s username="pid.$u@example.invalid" -s email="pid.$u@example.invalid" -s firstName=Pid -s lastName="${u^}" -s enabled=true -s emailVerified=true >/dev/null || fail "user $u"
    v=PW_${u^^}; docker exec -e P="${!v}" -e U="pid.$u@example.invalid" "$KC" sh -c '/opt/keycloak/bin/kcadm.sh set-password -r gaiada --username "$U" --new-password "$P" --config /tmp/h.cfg' >/dev/null || fail "password $u"
  done
  pass "7 seed users (username = email, password only, no phone), like live's 75"
  docker rm -f "$KC" >/dev/null
  kc_up "$NEW" && kc_login && pass "upgraded to 26.8.1 (schema migrated)" || { fail "26.8.1 up"; docker logs "$KC" 2>&1 | grep -E 'ERROR|Exception' | head; exit 1; }
  K create clients -r gaiada -b '{"clientId":"pid-test","publicClient":true,"standardFlowEnabled":true,"directAccessGrantsEnabled":false,"redirectUris":["http://localhost:8080/pid-cb/*"],"webOrigins":["+"],"attributes":{"pkce.code.challenge.method":"S256"}}' >/dev/null \
    && pass "test client pid-test (public, standard flow, PKCE S256)" || fail "test client"
  echo "browser flow as migrated from 26.0.8:"; K get authentication/flows/browser/executions -r gaiada | jq -r '.[]|"  \("  "*.level)\(.displayName) \(.requirement)"'
  echo "required actions: $(K get authentication/required-actions -r gaiada | jq -r '[.[]|"\(.alias)=\(.enabled)"]|join(" ")')"
}

apply() {
  load; kc_login || { fail "admin login"; exit 1; }
  mkdir -p "$D/exports"; export_norm > "$D/exports/before.json"
  echo "== dry run"
  script_env bash "$D/keycloak-passkey-realm.sh" apply --dry-run; rc=$?
  export_norm > "$D/exports/after-dry.json"
  [ $rc = 0 ] && cmp -s "$D/exports/before.json" "$D/exports/after-dry.json" && pass "dry run wrote nothing (partial export identical)" || fail "dry run (rc $rc, export changed: $(diff "$D/exports/before.json" "$D/exports/after-dry.json" | head -5))"
  echo "== apply"
  script_env bash "$D/keycloak-passkey-realm.sh" apply; rc=$?
  [ $rc = 0 ] && pass "apply" || { fail "apply rc $rc"; return 1; }
  export_norm > "$D/exports/after-apply.json"
  echo "== apply again (idempotence)"
  script_env bash "$D/keycloak-passkey-realm.sh" apply | grep -E 'change|DRY|created|add |register|enable|bind|STOP|BACKUP' ; rc=${PIPESTATUS[0]}
  export_norm > "$D/exports/after-apply2.json"
  [ $rc = 0 ] && cmp -s "$D/exports/after-apply.json" "$D/exports/after-apply2.json" && pass "second apply changed nothing (partial export identical)" || fail "idempotence: $(diff "$D/exports/after-apply.json" "$D/exports/after-apply2.json" | head -10)"
  script_env bash "$D/keycloak-passkey-realm.sh" status
  # The live way to run it: no password on the host at all; kcadm signs in with the container's own bootstrap admin.
  KC_CONTAINER=$KC KC_SERVER=http://localhost:8080/idp KC_ADMIN_USER= KC_ADMIN_PASSWORD= REALM=gaiada \
    AMR_CLIENTS="gaiada-ui gaiada-platform pid-test" bash "$D/keycloak-passkey-realm.sh" status >/dev/null \
    && pass "status signs in with the container's own bootstrap admin (no host password)" || fail "container-credential sign-in"
}

e2e() {
  load
  # shellcheck disable=SC2046
  docker run --rm --name pid2-pw --network container:"$KC" --memory 1500m -v "$D/pw":/w:ro -v "$D":/e2e:ro -e NODE_PATH=/w/node_modules \
    -e ADMPW -e PW_ALICE -e PW_BOB -e PW_NINA -e PW_CARL -e PW_SAM -e PW_TESS -e PW_IVAN -e KC_BASE=http://localhost:8080/idp \
    "$PWI" node /e2e/keycloak-passkey-realm.e2e.cjs
}

revert_check() {
  load; kc_login || { fail "admin login"; exit 1; }
  local b; b=$(ls -d "$D"/backups/pid2-gaiada-* | sort | head -1)
  echo "== revert from the FIRST backup ($b)"
  script_env bash "$D/keycloak-passkey-realm.sh" revert "$b"; rc=$?
  export_norm > "$D/exports/after-revert.json"
  # Compare the realm settings, flows, configs, required actions, profile and clients before apply vs after revert.
  if [ $rc = 0 ] && diff <(jq -S 'del(.users)' "$D/exports/before.json") <(jq -S 'del(.users)' "$D/exports/after-revert.json") > "$D/exports/diff-revert.txt"; then
    pass "revert: partial export identical to before apply"
  else fail "revert rc $rc; $(grep -c '^[<>]' "$D/exports/diff-revert.txt") differing lines:"; cut -c1-220 "$D/exports/diff-revert.txt" | head -60; rc=1; fi
  echo "localization en after revert: $(K get localization/en -r gaiada)"
  [ "$rc" = 0 ]
}

case "$MODE" in
  up) up ;; apply) apply ;; e2e) e2e ;; revert-check) revert_check ;; down) down ;;
  all) trap down EXIT; up && apply && { e2e; e=$?; revert_check; r=$?; echo "RESULT: e2e exit $e, revert-check exit $r"; [ "$e" = 0 ] && [ "$r" = 0 ]; } ;;
  *) echo "unknown mode"; exit 2 ;;
esac
