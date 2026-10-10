#!/usr/bin/env bash
# WSK-58 -- one Linux gate script for the WebDesk proof's suites.
#
# Runs, in throwaway containers, the same steps CI runs (.github/workflows/ci.yml: jobs
# `webdesk-light`, `webdesk-api`) plus the WSK-64 vocabulary suites that CI does not run:
#   webdesk-root    npm ci; npm test (migration lint + RLS selftest); compose port gate (+selftest)
#   webdesk-blocks  webdesk/blocks: npm ci; npm run build
#   webdesk-api     Postgres(init-roles.sh)+Redis+RustFS(digest-pinned)+ClamAV+Mailpit; npm ci;
#                   storage-bootstrap; npm ci + migrate in webdesk/; typecheck; npm test (full CI env)
#   vocabulary      payload/test: wsk64-classifier, wsk64-item-fields, vocabulary, envelope-contract
#                   (run from webdesk/api so `--import tsx` resolves from webdesk/api/node_modules;
#                   needs the DB prepared for webdesk-api)
#
# Design: no host paths, no host ports. The source tar is untarred into a per-run docker VOLUME that
# every container mounts; one docker network per run; services are reached by container DNS name.
# Everything is torn down in an EXIT trap (containers, network, volume).
#
# Usage:   bash linux-gate.sh <run-id> <source.tar> [suite,suite,...]
#   suites: webdesk-root,webdesk-blocks,webdesk-api,vocabulary (default: all)
#   The tar MUST come from:  git -c core.autocrlf=false archive --format=tar <ref>
#   (a Windows checkout has CRLF blobs, which break init-roles.sh).
# Logs:    ~/wg58-<id>/<suite>.log on the host running this script.
# Last stdout line is exactly "### done <id> PASS" or "### done <id> FAIL"; exit 0 only on PASS.
#
# On sumopod:
#   git -c core.autocrlf=false archive --format=tar <ref> | ssh sumopod 'cat > ~/wg58-<id>.tar'
#   scp webdesk/qa/linux-gate.sh sumopod:~/linux-gate.sh
#   ssh sumopod 'nohup bash ~/linux-gate.sh <id> ~/wg58-<id>.tar > ~/wg58-<id>.out 2>&1 & echo started'
#   then poll:  ssh sumopod 'tail -3 ~/wg58-<id>.out'   until a "### done <id> ..." line appears.
# Local Docker Desktop (Git Bash):
#   git -c core.autocrlf=false archive --format=tar HEAD > /tmp/src.tar
#   MSYS_NO_PATHCONV=1 bash webdesk/qa/linux-gate.sh myrun /tmp/src.tar
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'   # Git Bash must not rewrite container paths

ID="${1:-}"; TAR="${2:-}"; SUITES_ARG="${3:-webdesk-root,webdesk-blocks,webdesk-api,vocabulary}"
if [ -z "$ID" ] || [ -z "$TAR" ]; then
  echo "usage: bash linux-gate.sh <run-id> <source.tar> [suite,suite,...]"
  echo "### done ${ID:-?} FAIL"; exit 2
fi
case "$ID" in *[!a-zA-Z0-9_.-]*) echo "SETUP FAILED: run-id must match [a-zA-Z0-9_.-]"; echo "### done $ID FAIL"; exit 2;; esac

P="wg58-$ID"
NET="$P"; VOL="$P-src"
PG="$P-pg"; REDIS="$P-redis"; RUSTFS="$P-rustfs"; CLAM="$P-clamav"; MAILPIT="$P-mailpit"; MAILNS="$P-mailns"; RUNNER="$P-runner"
LOGDIR="$HOME/wg58-$ID"
NODE_IMG="node:22-bookworm"
RUSTFS_IMG="rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff"
mkdir -p "$LOGDIR"

declare -a RESULT_LINES=()
OVERALL=PASS
DB_READY=0
SUITE_T0=0

selected() { case ",$SUITES_ARG," in *",$1,"*) return 0;; *) return 1;; esac; }

cleanup() {
  set +e
  echo "--- teardown"
  docker rm -f "$PG" "$REDIS" "$RUSTFS" "$CLAM" "$MAILPIT" "$MAILNS" "$RUNNER" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  docker volume rm -f "$VOL" >/dev/null 2>&1
  echo "--- summary (run $ID, logs in $LOGDIR)"
  for l in "${RESULT_LINES[@]:-}"; do [ -n "$l" ] && echo "$l"; done
  echo "### done $ID $OVERALL"
  [ "$OVERALL" = PASS ] && exit 0 || exit 1
}
trap cleanup EXIT

setup_failed() { echo "SETUP FAILED: $*"; OVERALL=FAIL; exit 1; }
mark() { RESULT_LINES+=("$1"); echo "$1"; }  # one summary line per suite

# ---- sanity + source volume --------------------------------------------------------------------
[ -f "$TAR" ] || setup_failed "source tar not found: $TAR"
docker info >/dev/null 2>&1 || setup_failed "docker daemon not reachable"
for s in ${SUITES_ARG//,/ }; do
  case "$s" in webdesk-root|webdesk-blocks|webdesk-api|vocabulary) ;; *) setup_failed "unknown suite: $s";; esac
done
echo "run $ID  suites=$SUITES_ARG  tar=$TAR"
docker network create "$NET" >/dev/null || setup_failed "docker network create failed"
docker volume create "$VOL" >/dev/null || setup_failed "docker volume create failed"
docker run --rm -i -v "$VOL:/src" alpine tar -x -C /src < "$TAR" || setup_failed "untar into volume failed"
docker run --rm -v "$VOL:/src" alpine test -f /src/webdesk/postgres/init-roles.sh \
  || setup_failed "tar has no webdesk/postgres/init-roles.sh (wrong archive?)"
if docker run --rm -v "$VOL:/src" alpine grep -q "$(printf '\r')" /src/webdesk/postgres/init-roles.sh; then
  setup_failed "init-roles.sh has CRLF -- build the tar with: git -c core.autocrlf=false archive --format=tar <ref>"
fi

# ---- runner helper -----------------------------------------------------------------------------
# rr <workdir-under-/src> <bash script>   (env from the RENV array)
declare -a RENV=()
rr() {
  local wd="$1"; shift
  docker run --rm --name "$RUNNER" --network "$NET" -v "$VOL:/src" -w "/src/$wd" \
    -e CI=true -e FORCE_COLOR=0 -e NO_COLOR=1 ${RENV[@]+"${RENV[@]}"} "$NODE_IMG" bash -c "set -eo pipefail; $*"
}

strip_ansi() { sed 's/\x1b\[[0-9;]*m//g' "$1"; }

# Parse a vitest "Tests  N passed | M failed | K skipped" line, else count PASS/FAIL lines (plain-node suites).
counts_of() { # file -> "P F S"
  local f="$1" line p=0 fl=0 s=0
  line=$(strip_ansi "$f" | grep -E '^[[:space:]]*Tests[[:space:]]' | tail -1 || true)
  if [ -n "$line" ]; then
    p=$(echo "$line" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || true)
    fl=$(echo "$line" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || true)
    s=$(echo "$line" | grep -oE '[0-9]+ skipped' | grep -oE '[0-9]+' || true)
  else
    # plain-node suites: "  PASS name" / "  FAIL name" lines, plus node:test TAP summaries ("# pass N").
    local tp tf ts
    p=$(grep -cE '^[[:space:]]*PASS ' "$f" || true); fl=$(grep -cE '^[[:space:]]*FAIL ' "$f" || true)
    tp=$(awk '/^# pass [0-9]+/{n+=$3} END{print n+0}' "$f")
    tf=$(awk '/^# fail [0-9]+/{n+=$3} END{print n+0}' "$f")
    ts=$(awk '/^# skipped [0-9]+/{n+=$3} END{print n+0}' "$f")
    p=$(( ${p:-0} + ${tp:-0} )); fl=$(( ${fl:-0} + ${tf:-0} )); s=${ts:-0}
  fi
  echo "${p:-0} ${fl:-0} ${s:-0}"
}

finish_suite() { # name rc logfile
  local name="$1" rc="$2" log="$3" c p f s secs
  c=$(counts_of "$log"); read -r p f s <<<"$c"
  secs=$(( SECONDS - SUITE_T0 ))
  if [ "$rc" -eq 0 ] && [ "$f" -eq 0 ]; then
    mark "PASS  $name  passed=$p failed=$f skipped=$s  (${secs}s)"
  else
    OVERALL=FAIL
    mark "FAIL  $name  rc=$rc passed=$p failed=$f skipped=$s  (${secs}s)"
    echo "  failing files/tests:"
    strip_ansi "$log" | grep -E '^[[:space:]]*(FAIL|×)[[:space:]]' | sort -u | head -15 | sed 's/^/    /' || true
    echo "  last lines of $log:"; tail -n 12 "$log" | sed 's/^/    /'
  fi
}

run_suite() { # name workdir script   (RENV set by caller)
  local name="$1" wd="$2" script="$3" log="$LOGDIR/$1.log" rc=0
  echo "=== $name"
  SUITE_T0=$SECONDS
  rr "$wd" "$script" > "$log" 2>&1 || rc=$?
  finish_suite "$name" "$rc" "$log"
}

# ---- 1. webdesk-root ---------------------------------------------------------------------------
if selected webdesk-root; then
  RENV=()
  run_suite webdesk-root webdesk 'npm ci
npm test
node scripts/check-compose-ports.mjs --selftest
node scripts/check-compose-ports.mjs docker-compose.yml'
fi

# ---- 2. webdesk-blocks -------------------------------------------------------------------------
if selected webdesk-blocks; then
  RENV=()
  run_suite webdesk-blocks webdesk/blocks 'npm ci
npm run build'
fi

# ---- 3/4. services + DB prep (shared by webdesk-api and vocabulary) ----------------------------
NEED_DB=0; NEED_API=0
selected webdesk-api && { NEED_DB=1; NEED_API=1; }
selected vocabulary && NEED_DB=1

APP_URL="postgres://webdesk_app:throwaway_app@$PG:5432/webdesk"
MIG_URL="postgres://webdesk_migrator:throwaway_migrator@$PG:5432/webdesk"
STORAGE_ENDPOINT="http://$RUSTFS:9000"
RUSTFS_ROOT_USER=webdesk_root
RUSTFS_ROOT_PASSWORD=ci-throwaway-root-password

if [ "$NEED_DB" = 1 ]; then
  echo "=== starting services"
  docker run -d --name "$PG" --network "$NET" \
    -e POSTGRES_PASSWORD=throwaway_superuser -e POSTGRES_DB=webdesk \
    -e POSTGRES_OWNER_USER=webdesk_owner -e POSTGRES_OWNER_PASSWORD=throwaway_owner \
    -e POSTGRES_MIGRATOR_USER=webdesk_migrator -e POSTGRES_MIGRATOR_PASSWORD=throwaway_migrator \
    -e POSTGRES_APP_USER=webdesk_app -e POSTGRES_APP_PASSWORD=throwaway_app \
    -v "$VOL:/src:ro" --entrypoint sh postgres:16-alpine \
    -c 'cp /src/webdesk/postgres/init-roles.sh /docker-entrypoint-initdb.d/10-init-roles.sh && chmod +x /docker-entrypoint-initdb.d/10-init-roles.sh && exec docker-entrypoint.sh postgres' \
    >/dev/null || setup_failed "could not start postgres"
  docker run -d --name "$REDIS" --network "$NET" redis:7-alpine >/dev/null || setup_failed "could not start redis"
  if [ "$NEED_API" = 1 ]; then
    docker run -d --name "$RUSTFS" --network "$NET" -e "RUSTFS_ROOT_USER=$RUSTFS_ROOT_USER" \
      -e "RUSTFS_ROOT_PASSWORD=$RUSTFS_ROOT_PASSWORD" "$RUSTFS_IMG" >/dev/null || setup_failed "could not start rustfs"
    # Mailpit runs INSIDE the network namespace of a tiny holder container ($MAILNS, the SMTP/HTTP host
    # name). mail-retry-backoff.spec.ts does `docker stop <mailpit>`; with a plain container the name stops
    # resolving and every connect fails slowly (DNS timeout, ~6s on Docker Desktop), so the spec cannot see
    # 2 attempts in its 9s window. With the namespace held open the port just REFUSES instantly, like
    # 127.0.0.1 in CI.
    docker run -d --name "$MAILNS" --network "$NET" alpine sleep 86400 >/dev/null || setup_failed "could not start mailpit netns holder"
    docker run -d --name "$MAILPIT" --network "container:$MAILNS" axllent/mailpit:latest >/dev/null || setup_failed "could not start mailpit"
    docker run -d --name "$CLAM" --network "$NET" -e CLAMAV_NO_FRESHCLAMD=true clamav/clamav:stable >/dev/null \
      || setup_failed "could not start clamav"
  fi

  # Over TCP (127.0.0.1) on purpose: during initdb the temp server only listens on the unix socket.
  ok=0; for i in $(seq 1 60); do
    docker exec "$PG" pg_isready -h 127.0.0.1 -U webdesk_owner -d webdesk >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
  [ "$ok" = 1 ] || { docker logs "$PG" 2>&1 | tail -20; setup_failed "postgres never became ready"; }
  ok=0; for i in $(seq 1 30); do docker exec "$REDIS" redis-cli ping >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
  [ "$ok" = 1 ] || setup_failed "redis never became ready"
  if [ "$NEED_API" = 1 ]; then
    ok=0; for i in $(seq 1 30); do
      docker exec "$RUSTFS" curl -sf http://127.0.0.1:9000/health >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
    [ "$ok" = 1 ] || { docker logs "$RUSTFS" 2>&1 | tail -20; setup_failed "rustfs never became healthy"; }
    ok=0; for i in $(seq 1 30); do
      docker exec "$MAILNS" sh -c 'nc -z 127.0.0.1 8025' >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
    [ "$ok" = 1 ] || setup_failed "mailpit never became ready"
    ok=0; for i in $(seq 1 200); do
      docker exec "$CLAM" sh -c 'nc -z 127.0.0.1 3310' >/dev/null 2>&1 && { ok=1; break; }; sleep 2; done
    [ "$ok" = 1 ] || { docker logs "$CLAM" 2>&1 | tail -20; setup_failed "clamav never opened 3310 (signature load)"; }
    # mail-retry-backoff.spec.ts shells out to `docker stop|start <MAILPIT_CONTAINER_NAME>`: give the
    # runner the docker CLI (static binary from docker:cli, kept in the volume) and the host socket.
    docker run --rm -v "$VOL:/src" --entrypoint sh docker:cli \
      -c 'mkdir -p /src/.gate-bin && cp /usr/local/bin/docker /src/.gate-bin/docker' \
      || setup_failed "could not fetch the docker CLI binary (docker:cli image)"
  fi

  # Shared prep: api deps, storage bootstrap (api only), migrations. Logged to prep.log.
  RENV=(-e "RUSTFS_ROOT_USER=$RUSTFS_ROOT_USER" -e "RUSTFS_ROOT_PASSWORD=$RUSTFS_ROOT_PASSWORD"
        -e "STORAGE_ENDPOINT=$STORAGE_ENDPOINT" -e STORAGE_ACCESS_KEY_ID=webdesk_api
        -e STORAGE_SECRET_ACCESS_KEY=ci-throwaway-api-secret-key -e STORAGE_BUCKET_MEDIA=media
        -e STORAGE_BUCKET_VIDEO=video -e STORAGE_BUCKET_UPLOADS=uploads -e STORAGE_BUCKET_ARTIFACTS=artifacts
        -e "MIGRATE_DATABASE_URL=$MIG_URL")
  echo "=== prep (npm ci, storage bootstrap, migrate)"
  PREP_SCRIPT='npm ci'
  [ "$NEED_API" = 1 ] && PREP_SCRIPT="$PREP_SCRIPT && node ../scripts/storage-bootstrap.mjs"
  PREP_SCRIPT="$PREP_SCRIPT && cd /src/webdesk && npm ci && npm run migrate"
  if rr webdesk/api "$PREP_SCRIPT" > "$LOGDIR/prep.log" 2>&1; then
    DB_READY=1
  else
    tail -n 15 "$LOGDIR/prep.log" | sed 's/^/    /'
    echo "SETUP FAILED: prep (npm ci / storage-bootstrap / migrate) failed, see $LOGDIR/prep.log"
    OVERALL=FAIL
    selected webdesk-api && mark "FAIL  webdesk-api  setup failed (prep.log)"
    selected vocabulary && mark "FAIL  vocabulary  setup failed (prep.log)"
  fi
fi

# ---- webdesk-api: typecheck + npm test with the full CI env ------------------------------------
if selected webdesk-api && [ "$DB_READY" = 1 ]; then
  RENV=(
    -e "STORAGE_ENDPOINT=$STORAGE_ENDPOINT"
    -e "RUSTFS_ROOT_USER=$RUSTFS_ROOT_USER" -e "RUSTFS_ROOT_PASSWORD=$RUSTFS_ROOT_PASSWORD"
    -e STORAGE_ACCESS_KEY_ID=webdesk_api -e STORAGE_SECRET_ACCESS_KEY=ci-throwaway-api-secret-key
    -e STORAGE_BUCKET_MEDIA=media -e STORAGE_BUCKET_VIDEO=video
    -e STORAGE_BUCKET_UPLOADS=uploads -e STORAGE_BUCKET_ARTIFACTS=artifacts
    -e "APP_DATABASE_URL=$APP_URL" -e "MIGRATE_DATABASE_URL=$MIG_URL"
    -e "WSK05_TEST_DATABASE_URL=$APP_URL"
    -e "REDIS_URL=redis://$REDIS:6379"
    -e API_KEY_PEPPER=ci-throwaway-pepper
    -e "WSK21_TEST_DATABASE_URL=$APP_URL" -e "WSK21_MIGRATE_DATABASE_URL=$MIG_URL"
    -e "WSK25_TEST_DATABASE_URL=$APP_URL" -e "WSK25_MIGRATE_DATABASE_URL=$MIG_URL"
    -e "WSK25_TARGET_APP_DATABASE_URL=$APP_URL" -e "WSK25_TARGET_MIGRATE_DATABASE_URL=$MIG_URL"
    -e "WSK33_TEST_DATABASE_URL=$APP_URL" -e "WSK33_MIGRATE_DATABASE_URL=$MIG_URL"
    -e TENANT_WEBHOOK_SECRET_PEPPER=ci-throwaway-webhook-pepper
    -e WEBDESK_EVENT_SECRET=ci-throwaway-event-secret
    -e WEBDESK_APPROVAL_ASSERTION_KEY=ci-throwaway-ws4-key
    -e "CLAMAV_HOST=$CLAM" -e CLAMAV_PORT=3310
    -e MAIL_ENABLED=true -e MAIL_PROVIDER=smtp -e "MAIL_SMTP_HOST=$MAILNS" -e MAIL_SMTP_PORT=1025
    -e "MAILPIT_HTTP_URL=http://$MAILNS:8025" -e "MAILPIT_CONTAINER_NAME=$MAILPIT"
    -e WEBDESK_MEDIA_MAX_UPLOAD_BYTES=65536
    -v /var/run/docker.sock:/var/run/docker.sock
  )
  # /src/.gate-bin/docker is the docker CLI for mail-retry-backoff.spec.ts. MAIL_FROM_* stay unset (CI rule).
  run_suite webdesk-api webdesk/api 'export PATH=/src/.gate-bin:$PATH
npm run typecheck
npm test'
fi

# ---- vocabulary: WSK-64 suites + envelope-contract ---------------------------------------------
if selected vocabulary && [ "$DB_READY" = 1 ]; then
  RENV=(-e "DATABASE_URI=$APP_URL" -e "MIGRATE_DATABASE_URL=$MIG_URL" -e API_KEY_PEPPER=ci-throwaway-pepper)
  # cwd = webdesk/api so `--import tsx` resolves from its node_modules; `pg` resolves from webdesk/node_modules.
  run_suite vocabulary webdesk/api 'rc=0
for t in wsk64-classifier wsk64-item-fields vocabulary envelope-contract; do
  echo "##### $t"
  node --import tsx ../payload/test/$t.test.mjs || { echo "FAIL  $t exited non-zero"; rc=1; }
done
exit $rc'
fi
