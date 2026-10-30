#!/usr/bin/env bash
# Rehearse a Keycloak upgrade FROM -> TO on a test server (sumopod), then the revert, before doing it live.
# Written for PID-1b (26.0.8 -> 26.8.1, 2026-10-30); runbook: infra/runbooks/keycloak-upgrade.md.
# Throwaway containers on an INTERNAL docker network (no egress: the copy cannot mail or call out). Nothing touches live.
#   synthetic : empty DB + the repo realm file at $REALM_JSON (no live data)
#   copy      : restores ~/kc-rehearsal/kc.dump (a pg_dump -Fc of live gaiada_keycloak, made by the owner; runbook §1)
#   purge     : shreds ~/kc-rehearsal and removes the rehearsal images
# FROM / TO override the two images; PGI should match the live Postgres major.minor.
# Prints PASS/FAIL per check and a final RESULT line. Never prints a password.
set -uo pipefail
MODE=${1:?usage: keycloak-upgrade-rehearsal.sh synthetic|copy|purge}
FROM=${FROM:-quay.io/keycloak/keycloak:26.0.8}
TO=${TO:-quay.io/keycloak/keycloak:26.8.1}
PGI=postgres:15.18
CURLI=curlimages/curl:8.11.1
W=$HOME/kc-rehearsal; NET=kc-reh-net; PGC=kc-reh-pg; KC=kc-reh-kc
LOCK=$HOME/e2e.lock
FAILS=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS+1)); }

if [ "$MODE" = purge ]; then
  docker rm -f "$KC" "$PGC" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1
  find "$W" -type f -exec shred -u {} \; 2>/dev/null; rm -rf "$W"
  docker rmi "$FROM" "$TO" "$PGI" "$CURLI" >/dev/null 2>&1
  echo "purged: $(ls -d "$W" 2>/dev/null || echo 'no ~/kc-rehearsal')"; exit 0
fi

mkdir "$LOCK" 2>/dev/null || { echo "STOP: $LOCK is held by: $(cat "$LOCK"/* 2>/dev/null)"; exit 2; }
echo "keycloak upgrade rehearsal ($MODE, $FROM -> $TO) by $(whoami), $(date -u +%FT%TZ)" > "$LOCK/owner"
umask 077; mkdir -p "$W"
cleanup() {
  docker rm -f "$KC" "$PGC" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1
  [ -f "$W/pre-upgrade.dump" ] && shred -u "$W/pre-upgrade.dump"
  rm -f "$W"/*.cfg; rm -rf "$LOCK"
}
trap cleanup EXIT

PGPW=$(openssl rand -hex 16); ADMU=kc-reh-admin; ADMPW=$(openssl rand -hex 16); TPW=$(openssl rand -hex 12)
TUSER=kc-reh.test@example.invalid

echo "== images"
for i in "$FROM" "$TO" "$PGI" "$CURLI"; do docker pull -q "$i" >/dev/null || { echo "STOP: cannot pull $i"; exit 2; }; done
pass "pulled $FROM $TO $PGI"

pg_up() {
  docker network create --internal "$NET" >/dev/null
  docker run -d --name "$PGC" --network "$NET" --memory 512m -e POSTGRES_USER=keycloak -e POSTGRES_PASSWORD="$PGPW" \
    -e POSTGRES_DB=gaiada_keycloak "$PGI" >/dev/null
  for _ in $(seq 60); do docker exec "$PGC" pg_isready -U keycloak -d gaiada_keycloak >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
db_reset() {
  docker exec "$PGC" psql -q -U keycloak -d postgres -c 'DROP DATABASE gaiada_keycloak WITH (FORCE)' -c 'CREATE DATABASE gaiada_keycloak' >/dev/null
}
kc_env() {
  printf -- '-e KC_DB=postgres -e KC_DB_URL=jdbc:postgresql://%s:5432/gaiada_keycloak -e KC_DB_USERNAME=keycloak -e KC_DB_PASSWORD=%s -e KC_HTTP_RELATIVE_PATH=/idp -e KC_HEALTH_ENABLED=true -e KC_HTTP_ENABLED=true' "$PGC" "$PGPW"
}
kc_up() { # $1 image -> echoes seconds to ready, or returns 1
  local t0=$(date +%s)
  # shellcheck disable=SC2046
  docker run -d --name "$KC" --network "$NET" --memory 1500m $(kc_env) \
    -e KC_BOOTSTRAP_ADMIN_USERNAME="$ADMU" -e KC_BOOTSTRAP_ADMIN_PASSWORD="$ADMPW" "$1" start-dev >/dev/null || return 1
  for _ in $(seq 240); do
    if docker exec "$KC" bash -c 'exec 3<>/dev/tcp/127.0.0.1/9000 && printf "GET /idp/health/ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n" >&3 && cat <&3' 2>/dev/null | grep -q '"status": "UP"'; then
      echo $(( $(date +%s) - t0 )); return 0; fi
    [ "$(docker inspect -f '{{.State.Running}}' "$KC" 2>/dev/null)" = true ] || return 1
    sleep 2
  done
  return 1
}
kc_down() { docker rm -f "$KC" >/dev/null 2>&1; }
K() { docker exec "$KC" /opt/keycloak/bin/kcadm.sh "$@" --config /tmp/k.cfg; }
kc_login() {
  docker exec -e U="$ADMU" -e P="$ADMPW" "$KC" sh -c '/opt/keycloak/bin/kcadm.sh config credentials --config /tmp/k.cfg --server http://localhost:8080/idp --realm master --user "$U" --password "$P"' >/dev/null 2>&1
}
bootstrap_admin() { # $1 image, $2 username; for a copy, whose master realm already has live's admin (unknown password)
  # shellcheck disable=SC2046
  docker run --rm --network "$NET" --memory 1000m $(kc_env) -e KC_REH_PW="$ADMPW" "$1" \
    bootstrap-admin user --username "$2" --password:env KC_REH_PW --no-prompt >"$W/bootstrap.log" 2>&1
}
token_ok() { # login of the test user through a direct-grant test client
  docker run --rm --network "$NET" "$CURLI" -s -d grant_type=password -d client_id=kc-reh-test \
    --data-urlencode "username=$TUSER" --data-urlencode "password=$TPW" \
    "http://$KC:8080/idp/realms/gaiada/protocol/openid-connect/token" | grep -q '"access_token"'
}
snapshot() { # $1 label -> $W/$1.txt
  {
    echo "realms: $(K get realms --fields realm --format csv --noquotes | sort | tr '\n' ' ')"
    K get realms/gaiada --fields loginWithEmailAllowed,registrationAllowed,duplicateEmailsAllowed,editUsernameAllowed,resetPasswordAllowed,verifyEmail,rememberMe,ssoSessionIdleTimeout,ssoSessionMaxLifespan,accessTokenLifespan,browserFlow,resetCredentialsFlow,registrationFlow,directGrantFlow,bruteForceProtected,otpPolicyType,eventsEnabled --format csv --noquotes
    echo "flows:"; K get authentication/flows -r gaiada --fields alias --format csv --noquotes | sort
    echo "browser:"; K get authentication/flows/browser/executions -r gaiada --fields level,index,displayName,requirement --format csv --noquotes
    echo "required actions:"; K get authentication/required-actions -r gaiada --fields alias,enabled --format csv --noquotes | sort
    echo "clients:"; K get clients -r gaiada --fields clientId,publicClient,standardFlowEnabled,directAccessGrantsEnabled,serviceAccountsEnabled --format csv --noquotes | sort
    echo "realm roles: $(K get roles -r gaiada --fields name --format csv --noquotes | wc -l)"
    echo "groups: $(K get groups -r gaiada --fields id --format csv --noquotes | wc -l)"
    echo "identity providers: $(K get identity-provider/instances -r gaiada --fields alias --format csv --noquotes | wc -l)"
    echo "users: $(K get users/count -r gaiada)"
    echo "credential sets:"
    # one container, plain HTTP: a kcadm call per user costs a JVM start each
    docker run --rm --network "$NET" --entrypoint sh -e U="$ADMU" -e P="$ADMPW" -e B="http://$KC:8080/idp" "$CURLI" -c '
      T=$(curl -s -d grant_type=password -d client_id=admin-cli --data-urlencode "username=$U" --data-urlencode "password=$P" \
        "$B/realms/master/protocol/openid-connect/token" | sed -n "s/.*\"access_token\":\"\([^\"]*\)\".*/\1/p")
      curl -s -H "Authorization: Bearer $T" "$B/admin/realms/gaiada/users?max=5000&briefRepresentation=true" \
        | grep -o "\"id\":\"[0-9a-f-]\{36\}\"" | cut -d\" -f4 | while read -r id; do
          curl -s -H "Authorization: Bearer $T" "$B/admin/realms/gaiada/users/$id/credentials" \
            | grep -o "\"type\":\"[^\"]*\"" | cut -d\" -f4 | sort | tr "\n" "+"; echo
        done' | sort | uniq -c
    echo "service accounts (token the way platform-nest does: client_secret in the POST body; then list users):"
    docker run --rm --network "$NET" --entrypoint sh -e U="$ADMU" -e P="$ADMPW" -e B="http://$KC:8080/idp" "$CURLI" -c '
      T=$(curl -s -d grant_type=password -d client_id=admin-cli --data-urlencode "username=$U" --data-urlencode "password=$P" \
        "$B/realms/master/protocol/openid-connect/token" | sed -n "s/.*\"access_token\":\"\([^\"]*\)\".*/\1/p")
      for c in gaiada-provisioner webdesk-control; do
        id=$(curl -s -H "Authorization: Bearer $T" "$B/admin/realms/gaiada/clients?clientId=$c" | grep -o "\"id\":\"[0-9a-f-]\{36\}\"" | head -1 | cut -d\" -f4)
        [ -n "$id" ] || { echo "$c: absent"; continue; }
        s=$(curl -s -H "Authorization: Bearer $T" "$B/admin/realms/gaiada/clients/$id/client-secret" | sed -n "s/.*\"value\":\"\([^\"]*\)\".*/\1/p")
        st=$(curl -s -d grant_type=client_credentials -d "client_id=$c" --data-urlencode "client_secret=$s" "$B/realms/gaiada/protocol/openid-connect/token" \
          | sed -n "s/.*\"access_token\":\"\([^\"]*\)\".*/\1/p")
        [ -n "$st" ] && tok=ok || tok=FAILED
        code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $st" "$B/admin/realms/gaiada/users?max=1")
        echo "$c: token=$tok list-users=$code"
      done
      echo "organizations endpoint: $(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $T" "$B/admin/realms/gaiada/organizations")"'
  } > "$W/$1.txt" 2>&1
}

echo "== start $FROM"
pg_up && pass "postgres $PGI up on internal network $NET" || { fail "postgres up"; exit 1; }
if [ "$MODE" = copy ]; then
  [ -s "$W/kc.dump" ] || { echo "STOP: $W/kc.dump missing (the owner's dump step)"; exit 2; }
  docker exec -i "$PGC" pg_restore -U keycloak -d gaiada_keycloak --no-owner --no-privileges < "$W/kc.dump" 2>"$W/restore.log" \
    && pass "restored live copy" || { fail "restore (see $W/restore.log)"; tail -5 "$W/restore.log"; }
  bootstrap_admin "$FROM" "$ADMU" && pass "temporary admin created in the copy (bootstrap-admin)" || { fail "bootstrap-admin"; tail -5 "$W/bootstrap.log"; exit 1; }
fi
S=$(kc_up "$FROM") && pass "$FROM ready in ${S}s" || { fail "$FROM did not become ready"; docker logs "$KC" 2>&1 | tail -20; exit 1; }
kc_login && pass "admin login (copy-only admin)" || { fail "admin login"; exit 1; }
if [ "$MODE" = synthetic ]; then
  docker cp "${REALM_JSON:-$HOME/kc-rehearsal-realm.json}" "$KC":/tmp/realm.json && K create realms -f /tmp/realm.json >/dev/null && pass "imported the repo's realm" || { fail "realm import"; exit 1; }
  for n in 1 2 3; do K create users -r gaiada -s username="seed$n@example.invalid" -s email="seed$n@example.invalid" -s firstName=Seed -s lastName="$n" -s enabled=true -s emailVerified=true >/dev/null; done
  # synthetic only: also prove the bootstrap-admin command works on this version, as the copy run needs it
  kc_down; bootstrap_admin "$FROM" kc-reh-boot && pass "bootstrap-admin command works on $FROM" || { fail "bootstrap-admin on $FROM"; tail -5 "$W/bootstrap.log"; }
  S=$(kc_up "$FROM") && kc_login || { fail "restart after bootstrap-admin"; exit 1; }
fi
K create clients -r gaiada -s clientId=kc-reh-test -s publicClient=true -s directAccessGrantsEnabled=true -s standardFlowEnabled=false >/dev/null \
  && K create users -r gaiada -s username="$TUSER" -s email="$TUSER" -s firstName=Pid -s lastName=Test -s enabled=true -s emailVerified=true >/dev/null \
  && docker exec -e P="$TPW" -e U="$TUSER" "$KC" sh -c '/opt/keycloak/bin/kcadm.sh set-password -r gaiada --username "$U" --new-password "$P" --config /tmp/k.cfg' >/dev/null \
  && pass "test client + test user created (in the rehearsal DB only)" || fail "test client/user"
token_ok && pass "login on $FROM" || fail "login on $FROM"
snapshot before

echo "== backup, then upgrade to $TO"
kc_down
docker exec "$PGC" pg_dump -U keycloak -Fc gaiada_keycloak > "$W/pre-upgrade.dump" && pass "pre-upgrade dump ($(du -h "$W/pre-upgrade.dump" | cut -f1))" || { fail "pre-upgrade dump"; exit 1; }
S=$(kc_up "$TO") && pass "$TO ready in ${S}s (schema migrated)" || { fail "$TO did not become ready"; docker logs "$KC" 2>&1 | grep -E 'ERROR|Exception' | head -20; exit 1; }
echo "-- upgrade log (migration, warnings, errors):"
docker logs "$KC" 2>&1 | grep -E -i 'liquibase|migrat|updating database|ERROR|WARN' | grep -v -i 'dev mode' | cut -c1-220 | head -40
kc_login && pass "admin login on $TO" || { fail "admin login on $TO"; exit 1; }
snapshot after
# Known, expected: 26.x registers the new built-in required action `idp_link`.
diff "$W/before.txt" "$W/after.txt" > "$W/diff-upgrade.txt"
grep -E '^[<>]' "$W/diff-upgrade.txt" | grep -v -x '> idp_link,true' > "$W/diff-unexpected.txt"
grep -q -x '> idp_link,true' "$W/diff-upgrade.txt" && echo "INFO expected difference: new required action idp_link (added by the 26.x migration)"
if [ ! -s "$W/diff-unexpected.txt" ]; then pass "realm, flows, clients, users, credentials and service accounts identical after the upgrade"
else fail "unexpected differences after the upgrade:"; cat "$W/diff-unexpected.txt"; fi
token_ok && pass "login on $TO (password hashes survived)" || fail "login on $TO"
K get realms/gaiada --fields bruteForceStrategy,maxSecondaryAuthFailures,organizationsEnabled,webAuthnPolicyPasswordlessResidentKey,webAuthnPolicyPasswordlessUserVerificationRequirement 2>/dev/null | tr -d '\n ' ; echo
# The passkeys switch is omitted from the realm until set: set it on the rehearsal DB and read it back (the revert restores the DB anyway).
K update realms/gaiada -s webAuthnPolicyPasswordlessPasskeysEnabled=true >/dev/null 2>&1
PK=$(K get realms/gaiada --fields webAuthnPolicyPasswordlessPasskeysEnabled --format csv --noquotes 2>/dev/null | tail -1)
[ "$PK" = true ] && pass "passkeys switch works on $TO (set and read back)" || fail "passkeys switch on $TO (read back: '$PK')"
K get authentication/required-actions -r gaiada --fields alias --format csv --noquotes | grep -q -i webauthn \
  && pass "WebAuthn required actions present" || echo "INFO webauthn required actions not yet registered in the realm (expected; PID-2c registers them)"

echo "== revert: restore the pre-upgrade dump, start $FROM again"
kc_down; db_reset
docker exec -i "$PGC" pg_restore -U keycloak -d gaiada_keycloak --no-owner --no-privileges < "$W/pre-upgrade.dump" 2>/dev/null \
  && pass "pre-upgrade dump restored" || fail "restore of the pre-upgrade dump"
S=$(kc_up "$FROM") && pass "$FROM ready again in ${S}s" || { fail "$FROM after revert"; exit 1; }
kc_login && snapshot reverted
if diff "$W/before.txt" "$W/reverted.txt" > "$W/diff-revert.txt"; then pass "revert identical to before"
else fail "differences after the revert:"; cat "$W/diff-revert.txt"; fi
token_ok && pass "login after revert" || fail "login after revert"

echo "== snapshot (before) for the record"
sed -n '1,4p' "$W/before.txt"; grep -A3 '^credential sets' "$W/before.txt"
[ "$FAILS" -eq 0 ] && echo "RESULT: PASS ($MODE, $FROM -> $TO -> revert)" || echo "RESULT: FAIL ($FAILS checks)"
