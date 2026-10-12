#!/usr/bin/env bash
# WebDesk M4 (F2/F3/F4) - compose boot proof: do the REAL aicenter compose files boot with
# cap_drop ALL, the pinned images and a pinned subnet?
#
# Run on a Linux Docker host (the orchestrator runs it on sumopod, never on aicenter):
#
#   bash webdesk/ops/probes/compose-boot-proof.sh                 # boot, check, tear down
#   bash webdesk/ops/probes/compose-boot-proof.sh --resolve-only  # generate + `compose config` only
#
# Exit 0 only if every check passes.
#
# WHAT IT DOES
#   * Uses the repo's webdesk/docker-compose.yml + docker-compose.aicenter.yml UNCHANGED (the
#     release overlay is deliberately not used), plus ONE generated override file. The override only:
#       - replaces the api's `build:` with node:22-alpine running a tiny `node -e` HTTP listener on :3000.
#         CHOICE: nothing is built (never build on a production-adjacent box); the api's real image
#         needs the whole npm build and adds nothing to a cap_drop/boot proof. The api's securing
#         settings from the overlay (cap_drop, read_only, tmpfs, no-new-privileges) stay in force.
#       - points the api's host bind mounts and env_file at throwaway files in a mktemp dir (the
#         overlay mounts /etc/webdesk/...; this script NEVER touches /etc),
#       - moves the default network to a throwaway free 10.x/24 (never the live 172.19.0.0/16).
#   * Throwaway project name m4boot-<epoch>, loopback proxy port in 18380+ (never the live 8380).
#   * Writes a throwaway env file (random secrets for every `:?` variable in the two files, plus the
#     rest the stack reads) under the temp dir, mode 0600. Values are never printed.
#   * Starts proxy, api, postgres, redis, rustfs, waits for running/healthy, then checks per service:
#     running, no restarts, HostConfig.CapDrop == [ALL], HostConfig.CapAdd == expected, effective
#     capabilities of PID 1 (/proc/1/status CapEff) == expected mask, plus functional checks.
#   * ALWAYS tears down (trap): compose down -v --remove-orphans, leftover network, temp dir.
set -uo pipefail

RESOLVE_ONLY=0
[ "${1:-}" = "--resolve-only" ] && RESOLVE_ONLY=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WD="$(cd "$HERE/../.." && pwd)"                 # the webdesk/ tree
BASE="$WD/docker-compose.yml"
OVERLAY="$WD/docker-compose.aicenter.yml"
for f in "$BASE" "$OVERLAY"; do [ -f "$f" ] || { echo "FAIL  missing $f"; exit 1; }; done
command -v docker >/dev/null || { echo "FAIL  docker not found"; exit 1; }

PROJECT="m4boot-$(date +%s)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/m4boot.XXXXXX")"
chmod 700 "$TMP"
STARTED=0
FAILS=0
PASSES=0

dc() {
  docker compose -p "$PROJECT" --project-directory "$WD" --env-file "$TMP/proof.env" \
    -f "$BASE" -f "$OVERLAY" -f "$TMP/override.yml" "$@"
}

cleanup() {
  local rc=$?
  set +e
  if [ "$STARTED" = 1 ]; then
    dc down -v --remove-orphans >/dev/null 2>&1
  fi
  # belt and braces: only objects carrying THIS project's label/name
  docker network rm "${PROJECT}_default" >/dev/null 2>&1
  docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | xargs -r docker rm -f >/dev/null 2>&1
  docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | xargs -r docker volume rm -f >/dev/null 2>&1
  rm -rf "$TMP"
  echo "teardown: project $PROJECT removed (containers, volumes, network, temp dir)"
  exit $rc
}
trap cleanup EXIT INT TERM

pass() { echo "PASS  $1"; PASSES=$((PASSES + 1)); }
fail() { echo "FAIL  $1${2:+  -- $2}"; FAILS=$((FAILS + 1)); }
check() { # check "name" cmd...   (cmd success = pass)
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi
}

rand_hex() { # 32 random bytes as hex, no openssl dependency
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# --- 1. a free loopback port and a free subnet ---------------------------------------------------
PORT=""
for p in $(seq 18380 18480); do
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then PORT="$p"; break; fi
done
[ -n "$PORT" ] || { echo "FAIL  no free loopback port in 18380-18480"; exit 1; }

USED_NETS="$( (docker network ls -q | xargs -r docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null; ip -4 route 2>/dev/null | awk '{print $1}') | tr '\n' ' ')"
SUBNET=""
for _ in $(seq 1 40); do
  a=$((200 + RANDOM % 50)); b=$((RANDOM % 250))
  case " $USED_NETS " in *" 10.$a."*) continue ;; esac
  SUBNET="10.$a.$b.0/24"; break
done
[ -n "$SUBNET" ] || { echo "FAIL  could not find a free 10.200-249.x.0/24 subnet"; exit 1; }
echo "project=$PROJECT  proxy=127.0.0.1:$PORT  subnet=$SUBNET  (throwaway; live uses 172.19.0.0/16 and :8380)"

# --- 2. throwaway env file: random secrets for every `:?` variable -------------------------------
APP_PW="$(rand_hex)"
{
  for v in $(grep -ohE '\$\{[A-Z0-9_]+:\?' "$BASE" "$OVERLAY" | sed -E 's/^\$\{//; s/:\?$//' | sort -u); do
    case "$v" in
      APP_DATABASE_URL) echo "$v=postgres://webdesk_app:${APP_PW}@postgres:5432/webdesk" ;;
      *) echo "$v=$(rand_hex)" ;;
    esac
  done
  echo "POSTGRES_APP_PASSWORD=$APP_PW"
  echo "POSTGRES_OWNER_PASSWORD=$(rand_hex)"
  echo "POSTGRES_MIGRATOR_PASSWORD=$(rand_hex)"
  echo "POSTGRES_SUPERUSER_PASSWORD=$(rand_hex)"
  echo "RUSTFS_ROOT_PASSWORD=$(rand_hex)"
  echo "API_KEY_PEPPER=$(rand_hex)"
  echo "TENANT_WEBHOOK_SECRET_PEPPER=$(rand_hex)"
  echo "WEBDESK_EDGE_VERIFY_SECRET=$(rand_hex)"
  echo "MAIL_FROM_ADDRESS=proof@example.invalid"
  echo "REDIS_URL=redis://redis:6379"
  echo "STORAGE_ENDPOINT=http://rustfs:9000"
  echo "WEBDESK_PROXY_HTTP_PORT=$PORT"
} > "$TMP/proof.env"
chmod 600 "$TMP/proof.env"
echo "env file: $(wc -l < "$TMP/proof.env") variables generated (values not shown)"

# --- 3. throwaway bind-mount sources + the one override file ------------------------------------
: > "$TMP/.env.control"
printf '%s\n' '-----BEGIN CERTIFICATE-----' 'throwaway' '-----END CERTIFICATE-----' > "$TMP/ca-cert.pem"
printf '%s\n' '{"keys":[]}' > "$TMP/editorial.jwks.json"
printf '%s\n' '{"keys":[]}' > "$TMP/ws4.jwks.json"
chmod 644 "$TMP/ca-cert.pem" "$TMP/editorial.jwks.json" "$TMP/ws4.jwks.json" "$TMP/.env.control"

cat > "$TMP/override.yml" <<YAML
services:
  api:
    build: !reset null
    image: node:22-alpine
    command: !override
      - node
      - -e
      - "require('http').createServer((q,r)=>r.end('ok')).listen(3000,'0.0.0.0')"
    env_file: !override
      - $TMP/.env.control
    volumes: !override
      - $TMP/ca-cert.pem:/etc/webdesk/certs/ca-cert.pem:ro
      - $TMP/editorial.jwks.json:/etc/webdesk/editorial/editorial.jwks.json:ro
      - $TMP/ws4.jwks.json:/etc/webdesk/ws4/ws4.jwks.json:ro
networks:
  default:
    ipam:
      config: !override
        - subnet: $SUBNET
YAML

# --- 4. resolve and audit the merged config ------------------------------------------------------
if ! dc config --format json > "$TMP/resolved.json" 2> "$TMP/config.err"; then
  fail "compose config resolves" "$(grep -v 'level=warning' "$TMP/config.err" | tail -2 | tr '\n' ' ')"
  exit 1
fi
pass "compose config resolves (base + aicenter + throwaway override)"
echo "resolved services: $(dc config --services 2>/dev/null | sort | tr '\n' ' ')"
if [ "$RESOLVE_ONLY" = 1 ]; then
  echo "--resolve-only: not booting."
  echo "SUMMARY  $PASSES passed, $FAILS failed (resolve-only)"
  [ "$FAILS" = 0 ]; exit $?
fi

# --- 5. boot -------------------------------------------------------------------------------------
STARTED=1
if dc up -d --no-build proxy api postgres redis rustfs > "$TMP/up.log" 2>&1; then
  pass "docker compose up -d (proxy api postgres redis rustfs)"
else
  fail "docker compose up -d" "$(tail -3 "$TMP/up.log" | tr '\n' ' ')"
  tail -20 "$TMP/up.log"
fi

SERVICES="proxy api postgres redis rustfs"
declare -A CID
for s in $SERVICES; do CID[$s]="$(dc ps -aq "$s" 2>/dev/null | head -1)"; done

wait_ready() { # service -> 0 when running and (no healthcheck or healthy), 120s budget
  local cid="${CID[$1]}" i st
  [ -n "$cid" ] || return 1
  for i in $(seq 1 60); do
    st="$(docker inspect -f '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null)"
    case "$st" in "true healthy" | "true none") return 0 ;; esac
    sleep 2
  done
  return 1
}

for s in $SERVICES; do
  if wait_ready "$s"; then pass "$s running$(docker inspect -f '{{if .State.Health}} and healthy{{end}}' "${CID[$s]}")"
  else fail "$s running/healthy" "state: $(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} exit={{.State.ExitCode}}' "${CID[$s]:-none}" 2>&1 | head -1); last log: $(docker logs --tail 3 "${CID[$s]:-none}" 2>&1 | tr '\n' ' ' | cut -c1-300)"; fi
done
sleep 5   # let a crash-loop show itself before the restart-count check

# --- 6. hardening checks from `docker inspect` ---------------------------------------------------
# expected CapAdd per service (sorted) and expected effective-capability mask of PID 1
# (NET_BIND_SERVICE = bit 10 = 0x400; every other service ends with an EMPTY effective set).
declare -A WANT_ADD=(
  [proxy]="NET_BIND_SERVICE"
  [api]=""
  [postgres]="CHOWN DAC_OVERRIDE FOWNER SETGID SETUID"
  [redis]="CHOWN SETGID SETUID"
  [rustfs]=""
)
declare -A WANT_EFF=([proxy]="0000000000000400" [api]="0000000000000000" [postgres]="0000000000000000" [redis]="0000000000000000" [rustfs]="0000000000000000")

norm() { tr ' ' '\n' | sed -E 's/^CAP_//' | grep -v '^$' | sort | tr '\n' ' ' | sed 's/ $//'; }

for s in $SERVICES; do
  cid="${CID[$s]}"
  [ -n "$cid" ] || { fail "$s CapDrop/CapAdd" "no container"; continue; }
  drop="$(docker inspect -f '{{range .HostConfig.CapDrop}}{{.}} {{end}}' "$cid" | norm)"
  add="$(docker inspect -f '{{range .HostConfig.CapAdd}}{{.}} {{end}}' "$cid" | norm)"
  want="$(echo "${WANT_ADD[$s]}" | norm)"
  [ "$drop" = "ALL" ] && pass "$s CapDrop=ALL" || fail "$s CapDrop=ALL" "got '$drop'"
  [ "$add" = "$want" ] && pass "$s CapAdd=[${want:-none}]" || fail "$s CapAdd=[${want:-none}]" "got '$add'"
  nnp="$(docker inspect -f '{{range .HostConfig.SecurityOpt}}{{.}} {{end}}' "$cid")"
  case "$nnp" in *no-new-privileges*) pass "$s no-new-privileges" ;; *) fail "$s no-new-privileges" "got '$nnp'" ;; esac
  rc="$(docker inspect -f '{{.RestartCount}}' "$cid")"
  [ "$rc" = 0 ] && pass "$s RestartCount=0" || fail "$s RestartCount=0" "got $rc"
  eff="$(docker exec "$cid" sh -c "grep ^CapEff /proc/1/status | cut -f2" 2>/dev/null)"
  [ "$eff" = "${WANT_EFF[$s]}" ] && pass "$s PID1 effective caps = ${WANT_EFF[$s]}" || fail "$s PID1 effective caps = ${WANT_EFF[$s]}" "got '${eff:-unreadable}'"
done

# privilege-drop evidence: the entrypoint-dropping services must end up non-root
for s in postgres redis rustfs; do
  uid="$(docker exec "${CID[$s]}" sh -c "grep ^Uid /proc/1/status | cut -f2" 2>/dev/null)"
  [ -n "$uid" ] && [ "$uid" != 0 ] && pass "$s PID1 runs as non-root (uid $uid)" || fail "$s PID1 runs as non-root" "uid '${uid:-unreadable}'"
done

# --- 7. functional checks -----------------------------------------------------------------------
check "postgres accepts connections (pg_isready)" docker exec "${CID[postgres]}" pg_isready -U postgres -d webdesk
# the first-boot init runs a temporary server that already satisfies pg_isready, so poll (<= 60s)
roles_ok() {
  local i
  for i in $(seq 1 30); do
    docker exec "${CID[postgres]}" sh -c "psql -U postgres -d webdesk -tAc \"select 1 from pg_roles where rolname='webdesk_app'\" | grep -q 1" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
check "postgres init-roles ran (webdesk_app exists)" roles_ok
check "redis answers PING" docker exec "${CID[redis]}" sh -c 'redis-cli ping | grep -q PONG'
check "api stub answers on :3000" docker exec "${CID[api]}" node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
check "api rootfs is read-only" sh -c "[ \"\$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' ${CID[api]})\" = true ]"
body="$(curl -s -m 5 -o - -w ' %{http_code}' "http://127.0.0.1:$PORT/healthz" 2>/dev/null)"
case "$body" in *"webdesk proxy ok"*" 200") pass "proxy answers /healthz on 127.0.0.1:$PORT (200)" ;; *) fail "proxy answers /healthz on 127.0.0.1:$PORT" "got '$body'" ;; esac
pub="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}} {{.Ports}}' | grep -E '0\.0\.0\.0|:::' || true)"
[ -z "$pub" ] && pass "no service publishes on 0.0.0.0 / ::" || fail "no service publishes on 0.0.0.0 / ::" "$pub"
got_net="$(docker network inspect "${PROJECT}_default" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null)"
[ "$got_net" = "$SUBNET" ] && pass "default network carries the pinned subnet ($SUBNET)" || fail "default network carries the pinned subnet" "got '$got_net', want $SUBNET"
ip_ok=1
for s in $SERVICES; do
  ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${CID[$s]}")"
  case "$ip" in "${SUBNET%.0/24}".*) ;; *) ip_ok=0 ;; esac
done
[ "$ip_ok" = 1 ] && pass "every service address is inside the pinned subnet" || fail "every service address is inside the pinned subnet"

echo "SUMMARY  $PASSES passed, $FAILS failed"
[ "$FAILS" = 0 ]
