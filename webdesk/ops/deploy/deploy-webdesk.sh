#!/usr/bin/env bash
# WebDesk (Zone B) live deploy, run ON gda-aicenter by .github/workflows/deploy-webdesk.yml (M4 T4).
# It automates infra/runbooks/webdesk-live-swap.md. The signed image is verified by the WORKFLOW
# (cosign) and arrives here as a digest; this script never builds anything (the box is the live ERP box).
#
#   deploy-webdesk.sh plan     <tag> <digest> <tree.tar>   changes nothing live; exit 0 only if every check passes
#   deploy-webdesk.sh apply    <tag> <digest> <tree.tar>   plan, then pull/backup/swap/migrate/up/health; rolls the
#                                                          api image + tree back on a health failure
#   deploy-webdesk.sh rollback                             re-pin the most recent pre-* image and tree
#
# Env (all optional except GHCR_OWNER): GHCR_OWNER (lowercase registry owner), WEBDESK_DIR, WEBDESK_ENV_FILE,
#   WEBDESK_TOOLS_IMAGE, WEBDESK_PROXY_HTTP_PORT, WEBDESK_PUBLIC_HOST, WEBDESK_HEALTH_TIMEOUT (120),
#   WEBDESK_TICK_TIMEOUT (150; the content tick runs every 60 s by default, 15-300 allowed),
#   WEBDESK_SUDO (default "sudo -n"; empty in the test harness).
# M4 F6 (rootless, docs/plans/2026-10-12-webdesk-rootless-plan.md). Unset, all three behave exactly as before:
#   WEBDESK_DOCKER_HOST  the daemon that runs WebDesk (unix:///run/user/<uid>/docker.sock). Unset: the host switch
#                        /etc/default/webdesk-docker (written by the rootless cut-over), else the rootful daemon.
#   WEBDESK_PROJECT      compose project (default webdesk). The rootless PROOF runs as another project, so a proof
#                        command that reached the wrong daemon finds no such project and fails its plan.
#   WEBDESK_HEALTH_VIA   nginx (default: the public vhost on 127.0.0.1:443) | direct (127.0.0.1:<proxy port>, for a
#                        proof stack that no nginx vhost routes to).
#
# Secrets: /etc/webdesk/.env is only ever read through sudo, and only by (a) a filter that writes a 0600 temp
# --env-file for the throwaway tools container, (b) compose --env-file, (c) set_env_var / remove_env_var, which
# never print values. No function here echoes a variable from that file.
set -euo pipefail

WD_DIR="${WEBDESK_DIR:-/home/Hansel/gaiada-webdesk/webdesk}"
ENV_FILE="${WEBDESK_ENV_FILE:-/etc/webdesk/.env}"
PROJECT="${WEBDESK_PROJECT:-webdesk}"
NET="${PROJECT}_default"
API_CT="${WEBDESK_API_CONTAINER:-${PROJECT}-api-1}"
PG_CT="${WEBDESK_PG_CONTAINER:-${PROJECT}-postgres-1}"
HEALTH_VIA="${WEBDESK_HEALTH_VIA:-nginx}"
WD_DOCKER_HOST=""
TOOLS_IMAGE="${WEBDESK_TOOLS_IMAGE:-node:22-bookworm}"
PROXY_PORT="${WEBDESK_PROXY_HTTP_PORT:-8380}"
PUBLIC_HOST="${WEBDESK_PUBLIC_HOST:-api.erp.gaiada.com}"
HEALTH_TIMEOUT="${WEBDESK_HEALTH_TIMEOUT:-120}"
TICK_TIMEOUT="${WEBDESK_TICK_TIMEOUT:-150}"
BACKUP_ROOT="${WEBDESK_BACKUP_ROOT:-$HOME/webdesk-backups}"
DEPLOYED_TAG_FILE="${WEBDESK_DEPLOYED_TAG_FILE:-$(dirname "$WD_DIR")/.deployed-tag}"
IMAGE_NAME=gaiada-webdesk-api
read -r -a SUDO <<<"${WEBDESK_SUDO-sudo -n}"

# Keys copied from the env file into the throwaway tools container (migrate / RLS gate / storage bootstrap).
TOOL_KEYS="MIGRATE_DATABASE_URL OWNER_DATABASE_URL STORAGE_ENDPOINT RUSTFS_ROOT_USER RUSTFS_ROOT_PASSWORD
STORAGE_ACCESS_KEY_ID STORAGE_SECRET_ACCESS_KEY STORAGE_REGION STORAGE_BUCKET_MEDIA STORAGE_BUCKET_VIDEO
STORAGE_BUCKET_UPLOADS STORAGE_BUCKET_ARTIFACTS WEBDESK_STORAGE_LOCK_DAYS WEBDESK_BACKUP_RETENTION_DAYS
WEBDESK_BACKUP_BUCKET WEBDESK_STORAGE_PUBLIC_READ WEBDESK_BACKUP_ACCESS_KEY_ID WEBDESK_BACKUP_SECRET_ACCESS_KEY"
REQUIRED_KEYS="MIGRATE_DATABASE_URL OWNER_DATABASE_URL STORAGE_ENDPOINT RUSTFS_ROOT_USER RUSTFS_ROOT_PASSWORD
STORAGE_ACCESS_KEY_ID STORAGE_SECRET_ACCESS_KEY"

say() { printf '%s\n' "$*"; }
ok() { say "  PASS  $*"; }
bad() { say "  FAIL  $*"; PLAN_FAILS=$((PLAN_FAILS + 1)); }
die() { say "deploy-webdesk: $*" >&2; exit 1; }
hdr() { say ""; say "== $*"; }

PLAN_FAILS=0
MODE="" TAG="" DIGEST="" TAR="" OWNER="" IMAGE_REF="" STAGE="" WORK="" OLD_TREE="" BACKUP_DIR="" PRE_TAG=""
PREV_MODE="" PREV_IMAGE_REF="" SWAPPED=0 UP_STARTED=0 SUCCESS=0 SINCE=""

# --- pure helpers (unit-tested by test-deploy-webdesk.sh) ----------------------------------------------------

valid_tag() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$ ]]; }
valid_digest() { [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]; }
valid_project() { [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; }

# M4 F6 (WSK-D73): the Docker daemon that runs WebDesk. Empty = the rootful daemon, exactly as before.
# WEBDESK_DOCKER_HOST, when SET (even to ""), wins; else the host switch /etc/default/webdesk-docker, which
# the rootless cut-over writes and its rollback deletes; else empty. Only a rootless socket path is accepted.
# POSIX sh, and byte-identical in every script that resolves the daemon (test-rootless.sh compares them).
wd_docker_host() {
  _wdh_f="${WEBDESK_DOCKER_SWITCH:-/etc/default/webdesk-docker}"
  if [ -n "${WEBDESK_DOCKER_HOST+set}" ]; then _wdh_v="$WEBDESK_DOCKER_HOST"
  elif [ -r "$_wdh_f" ]; then _wdh_v="$(sed -n 's/^WEBDESK_DOCKER_HOST=//p' "$_wdh_f" | tail -n 1)"
  else _wdh_v=""
  fi
  _wdh_v="${_wdh_v%\"}"; _wdh_v="${_wdh_v#\"}"
  case "$_wdh_v" in
    "") return 0 ;;
    unix:///run/user/*/docker.sock)
      _wdh_u="${_wdh_v#unix:///run/user/}"; _wdh_u="${_wdh_u%/docker.sock}"
      case "$_wdh_u" in "" | 0* | *[!0-9]*) return 1 ;; esac ;;
    *) return 1 ;;
  esac
  printf '%s\n' "$_wdh_v"
}

# With the containerd image store a pulled image's ID equals its manifest digest. Equal or refuse.
image_matches_digest() { [ -n "$1" ] && [ "$1" = "$2" ]; }

# Prints the files (names only) under <dir> that contain a CR byte. Returns 1 when there are any.
check_no_cr() {
  local f hits=""
  while IFS= read -r -d '' f; do
    [ "$(tr -cd '\r' <"$f" | wc -c)" -eq 0 ] || hits="$hits$f"$'\n'
  done < <(find "$1" -type f -print0)
  if [ -n "$hits" ]; then printf '%s' "$hits"; return 1; fi
  return 0
}

# Migration files in <migrations-dir> that are not in the ledger file (one name per line). Sorted, C locale.
pending_migrations() {
  local dir=$1 ledger=$2
  LC_ALL=C comm -23 \
    <(cd "$dir" && LC_ALL=C ls -1 -- *.sql 2>/dev/null | LC_ALL=C sort) \
    <(LC_ALL=C sort "$ledger")
}

# set_env_var <file> <key> <value>: replace the KEY= line(s) or append one. NEVER prints a value.
# Written in place through `tee` so the file keeps its owner and mode (it is 0600, owned by another user).
set_env_var() {
  local file=$1 key=$2 val=$3 tmp
  tmp="$(mktemp)"
  chmod 600 "$tmp"
  "${SUDO[@]}" cat "$file" | K="$key" V="$val" awk '
    BEGIN { pre = ENVIRON["K"] "="; v = ENVIRON["V"]; seen = 0 }
    index($0, pre) == 1 { if (!seen) { print pre v; seen = 1 } ; next }
    { print }
    END { if (!seen) print pre v }' >"$tmp" || { rm -f "$tmp"; return 1; }
  "${SUDO[@]}" tee "$file" <"$tmp" >/dev/null || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
}

remove_env_var() {
  local file=$1 key=$2 tmp
  tmp="$(mktemp)"
  chmod 600 "$tmp"
  "${SUDO[@]}" cat "$file" | K="$key" awk 'BEGIN { pre = ENVIRON["K"] "=" } index($0, pre) != 1 { print }' >"$tmp" \
    || { rm -f "$tmp"; return 1; }
  "${SUDO[@]}" tee "$file" <"$tmp" >/dev/null || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
}

# Names (not values) of the keys defined in the env file, one per line.
env_key_names() {
  "${SUDO[@]}" cat "$ENV_FILE" | awk '{ l = $0; sub(/^[ \t]*(export[ \t]+)?/, "", l) } l ~ /^[A-Za-z_][A-Za-z0-9_]*=/ { i = index(l, "="); print substr(l, 1, i - 1) }'
}

# Value of one key. Only used for NON-secret keys (WEBDESK_API_IMAGE).
env_get_var() {
  "${SUDO[@]}" cat "$ENV_FILE" | K="$1" awk 'BEGIN { pre = ENVIRON["K"] "=" } index($0, pre) == 1 { print substr($0, length(pre) + 1); exit }'
}

# Writes the --env-file for the tools container to <out> (mode 600): only TOOL_KEYS, surrounding quotes
# stripped (docker run does not parse them), the two DB URLs re-pointed at postgres:5432 on the project
# network (the env file's host:port is the host-published one, which the overlay removes and the egress
# guard would block anyway). Prints nothing.
make_tools_envfile() {
  local out=$1
  umask 077
  "${SUDO[@]}" cat "$ENV_FILE" | KEYS="$TOOL_KEYS" awk '
    BEGIN { n = split(ENVIRON["KEYS"], a, /[ \n]+/); for (i = 1; i <= n; i++) want[a[i]] = 1 }
    /^[ \t]*#/ { next }
    {
      l = $0; sub(/^[ \t]*(export[ \t]+)?/, "", l); sub(/\r$/, "", l)
      i = index(l, "="); if (i < 2) next
      k = substr(l, 1, i - 1); v = substr(l, i + 1)
      if (!(k in want)) next
      if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v = substr(v, 2, length(v) - 2)
      if (k == "MIGRATE_DATABASE_URL" || k == "OWNER_DATABASE_URL") sub(/@[^@\/]+\//, "@postgres:5432/", v)
      print k "=" v
    }' >"$out"
}

# --- compose -------------------------------------------------------------------------------------------------

# compose <dir> <release:0|1> <WEBDESK_API_IMAGE or ""> <compose args...>
compose() {
  local dir=$1 rel=$2 img=$3
  shift 3
  local files=(-f docker-compose.yml -f docker-compose.aicenter.yml)
  local envs=()
  # sudo resets the environment, so the rootless daemon is named explicitly (empty: the rootful one, as before).
  [ -z "$WD_DOCKER_HOST" ] || envs+=("DOCKER_HOST=$WD_DOCKER_HOST")
  if [ "$rel" = 1 ]; then
    files+=(-f docker-compose.aicenter-release.yml)
    envs+=("WEBDESK_API_IMAGE=$img")
  fi
  (cd "$dir" && "${SUDO[@]}" env "${envs[@]}" docker compose --env-file "$ENV_FILE" -p "$PROJECT" "${files[@]}" "$@")
}

running_image_id() { docker inspect --format '{{.Image}}' "$API_CT" 2>/dev/null; }
running_image_ref() { docker inspect --format '{{.Config.Image}}' "$API_CT" 2>/dev/null; }
running_config_files() { docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$API_CT" 2>/dev/null; }

# Is the live api already exactly this release? Pure (arguments only), so the harness can drive it.
# Used by WEBDESK_SKIP_IF_CURRENT=1, the automatic path release.yml takes after every ERP deploy: most releases
# do not touch WebDesk, and recreating the api for nothing would blip /v1 on every release (M4, 2026-10-12).
already_current() { # <running-image-id> <digest> <running-config-files> <pending-migrations-file> <stage> <live>
  local rid=$1 dig=$2 files=$3 pend=$4 stage=$5 live=$6 e
  image_matches_digest "$rid" "$dig" || return 1
  case "$files" in *docker-compose.aicenter-release.yml*) ;; *) return 1 ;; esac
  [ -f "$pend" ] && [ ! -s "$pend" ] || return 1
  for e in "$stage"/* "$stage"/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    case "${e##*/}" in .env*) continue ;; esac
    diff -rq --no-dereference "$e" "$live/${e##*/}" >/dev/null 2>&1 || return 1
  done
  return 0
}

# --- plan ----------------------------------------------------------------------------------------------------

prepare_stage() {
  local lst
  STAGE="${WD_DIR}.stage-${TAG}"
  rm -rf "$STAGE"
  [ -f "$TAR" ] || { bad "tree tar not found: $TAR"; return 1; }
  lst="$(tar -tf "$TAR")" || { bad "cannot list the tree tar"; return 1; }
  if grep -Eq '(^/|(^|/)\.\.(/|$))' <<<"$lst"; then bad "tree tar has an absolute or .. path"; return 1; fi
  mkdir -p "$STAGE"
  tar -xf "$TAR" -C "$STAGE" --no-same-owner || { bad "tar extraction failed"; return 1; }
  ok "untarred $(grep -c . <<<"$lst") entries into the staging dir ${STAGE##*/}"
  local hits
  if hits="$(check_no_cr "$STAGE")"; then ok "no file in the release tree contains CR"; else
    bad "files with CR (refuse): $(tr '\n' ' ' <<<"$hits")"
  fi
  # The env symlinks (.env.control -> /etc/webdesk/.env.control) are box state, not release content.
  local f
  for f in "$WD_DIR"/.env*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    cp -P "$f" "$STAGE/"
  done
  [ -e "$STAGE/.env.control" ] || [ -L "$STAGE/.env.control" ] || bad "live tree has no .env.control to carry over (the api's env_file)"
}

plan_checks() {
  hdr "plan · $TAG · ${DIGEST:0:19}…"
  say "  daemon: ${WD_DOCKER_HOST:-rootful (default)} · project: $PROJECT · health via: $HEALTH_VIA"
  valid_tag "$TAG" && ok "tag shape" || bad "tag '$TAG' is not a plain tag"
  valid_digest "$DIGEST" && ok "digest shape" || bad "digest is not sha256:<64 hex>"
  [ -n "$OWNER" ] || bad "GHCR_OWNER is not set"
  [ "$PLAN_FAILS" -eq 0 ] || return 1
  IMAGE_REF="ghcr.io/${OWNER}/${IMAGE_NAME}@${DIGEST}"

  hdr "release tree"
  prepare_stage || true

  hdr "env file (key names only, values are never read out)"
  local names missing=""
  names="$(env_key_names)" || { bad "cannot read $ENV_FILE through sudo"; names=""; }
  local k
  for k in $REQUIRED_KEYS; do grep -qx "$k" <<<"$names" || missing="$missing $k"; done
  [ -z "$missing" ] && ok "every key the tools container needs is defined" || bad "missing from the env file:$missing"

  hdr "compose config (three files, against the real env file)"
  if [ -d "$STAGE" ] && compose "$STAGE" 1 "$IMAGE_REF" config -q >"$WORK/config.out" 2>&1; then
    ok "compose config -q passes with the release overlay and WEBDESK_API_IMAGE=…@${DIGEST:0:19}…"
  else
    bad "compose config -q failed: $(tail -3 "$WORK/config.out" 2>/dev/null | tr '\n' ' ')"
  fi

  hdr "running api vs the signed digest"
  local rid
  rid="$(running_image_id || true)"
  if [ -z "$rid" ]; then bad "api container $API_CT is not present"; else
    PREV_IMAGE_REF="$(running_image_ref || true)"
    if image_matches_digest "$rid" "$DIGEST"; then ok "running image id = digest: no swap needed (apply still re-pins, migrates and health-checks)"; else
      ok "running image id differs from the digest: swap needed (running ${rid:0:19}…)"
    fi
  fi

  hdr "migrations"
  local su db
  su="$(docker exec "$PG_CT" printenv POSTGRES_USER 2>/dev/null || true)"; [ -n "$su" ] || su=postgres
  db="$(docker exec "$PG_CT" printenv POSTGRES_DB 2>/dev/null || true)"; [ -n "$db" ] || db="$su"
  if docker exec "$PG_CT" psql -U "$su" -d "$db" -X -q -A -t -c "SELECT to_regclass('schema_migrations') IS NOT NULL" 2>/dev/null | grep -x t >/dev/null; then
    docker exec "$PG_CT" psql -U "$su" -d "$db" -X -q -A -t -c "SELECT name FROM schema_migrations" >"$WORK/ledger" 2>/dev/null \
      || { bad "cannot read the ledger"; : >"$WORK/ledger"; }
    if [ -d "$STAGE/migrations" ]; then
      pending_migrations "$STAGE/migrations" "$WORK/ledger" >"$WORK/pending"
      ok "ledger read (read-only); pending: $(grep -c . "$WORK/pending" || true) -> $(tr '\n' ' ' <"$WORK/pending")"
    else bad "release tree has no migrations/ dir"; fi
  else
    bad "the schema_migrations ledger is not readable in $PG_CT (container down, or the table is missing)"
  fi

  hdr "live tree vs release tree (information)"
  local e dropped=""
  for e in "$WD_DIR"/* "$WD_DIR"/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    [ -e "$STAGE/${e##*/}" ] || [ -L "$STAGE/${e##*/}" ] || dropped="$dropped ${e##*/}"
  done
  say "  live entries NOT in the release (they move to the old-tree copy on apply):${dropped:- none}"
  local d
  for d in proxy postgres; do
    if [ -d "$WD_DIR/$d" ] && [ -d "$STAGE/$d" ] && ! diff -rq "$WD_DIR/$d" "$STAGE/$d" >/dev/null 2>&1; then
      say "  NOTE  $d/ differs from the live copy: apply recreates ONLY api; a changed $d/ needs a manual recreate"
    fi
  done

  hdr "backup + disk"
  if docker exec "$PG_CT" psql -U "$su" -d "$db" -X -q -A -t -c "SELECT 1 FROM pg_roles WHERE rolname='webdesk_backup'" 2>/dev/null | grep -x 1 >/dev/null; then
    ok "pg_dump will run as webdesk_backup"
  else
    ok "no webdesk_backup role: pg_dump will run as the container's POSTGRES_USER"
  fi
  local freekb
  freekb="$(df -Pk "$(dirname "$WD_DIR")" | awk 'NR==2 { print $4 }')"
  [ "${freekb:-0}" -ge 3145728 ] && ok "free disk >= 3 GiB" || bad "free disk below 3 GiB (${freekb:-0} KiB): prune before deploying"

  hdr "plan"
  say "  1 pull ${IMAGE_REF%%@*}@${DIGEST:0:19}…; refuse unless the image id = digest"
  say "  2 tag the running image webdesk-api:pre-$TAG"
  say "  3 pg_dump -Fc + compose files + migrations/ -> $BACKUP_ROOT/pre-$TAG-<UTC>/"
  say "  4 swap the staging tree in by rename (old tree kept next to it)"
  say "  5 migrate as webdesk_migrator twice (second applies 0), RLS-integrity gate, storage-bootstrap"
  say "  6 up -d --no-deps --no-build api with the release overlay"
  say "  7 health (${HEALTH_TIMEOUT}s; tick ${TICK_TIMEOUT}s): listening, JWKS, /healthz, /v1 401 problem+json, tick errors=0, port audit"
  say "  8 on success write WEBDESK_API_IMAGE to the env file and $DEPLOYED_TAG_FILE; on failure re-pin pre-$TAG + old tree"
  [ "$PLAN_FAILS" -eq 0 ]
}

# --- apply ---------------------------------------------------------------------------------------------------

restore_tree() {
  [ "$SWAPPED" = 1 ] || return 0
  say "restoring the old tree"
  if [ -d "$OLD_TREE" ]; then
    mv "$WD_DIR" "${WD_DIR}.failed-${TAG}-$(date -u +%Y%m%dT%H%M%SZ)" && mv "$OLD_TREE" "$WD_DIR" && SWAPPED=0
  else
    say "!! old tree $OLD_TREE is missing; the failed tree stays live, restore by hand from $BACKUP_DIR"
  fi
}

# Re-pin the pre-<tag> image under the previous compose arrangement (tree must already be the old one).
repin_previous() {
  docker image inspect "webdesk-api:pre-$PRE_TAG" >/dev/null 2>&1 || { say "!! webdesk-api:pre-$PRE_TAG not found"; return 1; }
  if [ "$PREV_MODE" = release ]; then
    compose "$WD_DIR" 1 "webdesk-api:pre-$PRE_TAG" up -d --no-deps --no-build api
  else
    docker tag "webdesk-api:pre-$PRE_TAG" webdesk-api:latest
    compose "$WD_DIR" 0 "" up -d --no-deps --no-build api
  fi
}

rollback_after_failure() {
  say ""
  say "== HEALTH FAILED: rolling the api image and tree back (migrations are NEVER rolled back)"
  restore_tree
  if repin_previous; then
    SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    DEADLINE=$((SECONDS + 60))
    PLAN_FAILS=0
    chk_listening && chk_healthz || say "!! the rolled-back api is not healthy either: check by hand"
    say "rolled back to webdesk-api:pre-$PRE_TAG ($PREV_MODE mode)"
  else
    say "!! automatic re-pin failed: use 'deploy-webdesk.sh rollback' or the runbook's manual rollback"
  fi
}

on_exit() {
  local rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ] && [ "$MODE" = apply ] && [ "$SUCCESS" != 1 ]; then
    if [ "$UP_STARTED" = 1 ]; then rollback_after_failure || true
    elif [ "$SWAPPED" = 1 ]; then restore_tree || true; fi
  fi
  [ -n "$STAGE" ] && [ -d "$STAGE" ] && rm -rf "$STAGE"
  [ -n "$WORK" ] && rm -rf "$WORK"
  if [ "$MODE" = plan ] || [ "$MODE" = apply ]; then
    if [ "$rc" -eq 0 ]; then say ""; say "RESULT: $MODE OK ($TAG)"; else say ""; say "RESULT: $MODE FAILED ($TAG) exit $rc"; fi
  fi
  exit "$rc"
}

# Health ----------------------------------------------------------------------------------------------------

DEADLINE=0
wait_until() { # <description> <fn>
  local d=$1 fn=$2
  while :; do
    if "$fn"; then ok "$d"; return 0; fi
    if [ "$SECONDS" -ge "$DEADLINE" ]; then bad "$d (timed out)"; return 1; fi
    sleep 3
  done
}
api_logs() { docker logs --since "$SINCE" "$API_CT" 2>&1; }
chk_listening() { local l; l="$(api_logs)"; grep -q 'listening on :3000' <<<"$l"; }
chk_jwks() { local l; l="$(api_logs)"; grep -q 'editorial JWKS loaded' <<<"$l"; }
chk_healthz() { [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PROXY_PORT}/healthz")" = 200 ]; }
chk_problem401() {
  local r path
  path="/v1/t/wd-deploy-$(head -c6 /dev/urandom | od -An -tx1 | tr -d ' \n')/collections"
  if [ "$HEALTH_VIA" = direct ]; then
    r="$(curl -s -m 10 -o /dev/null -w '%{http_code} %{content_type}' -H "Host: ${PUBLIC_HOST}" \
      "http://127.0.0.1:${PROXY_PORT}${path}" || true)"
  else
    r="$(curl -s -m 10 -o /dev/null -w '%{http_code} %{content_type}' --resolve "${PUBLIC_HOST}:443:127.0.0.1" \
      "https://${PUBLIC_HOST}${path}" || true)"
  fi
  [[ "$r" == "401 application/problem+json"* ]]
}
chk_tick() {
  local line
  line="$(api_logs | grep -E 'content tick @ .* errors=[0-9]+' | tail -1 || true)"
  [[ "$line" =~ errors=0([^0-9]|$) ]]
}
chk_probe() {
  PROBE_ONLY=1 WEBDESK_DIR="$WD_DIR" WEBDESK_ENV_FILE="$ENV_FILE" WEBDESK_PROJECT="$PROJECT" WEBDESK_DOCKER_HOST="$WD_DOCKER_HOST" \
    bash "$WD_DIR/ops/probes/containment-probe.sh" >"$WORK/probe.out" 2>&1 \
    || { tail -15 "$WORK/probe.out"; return 1; }
}

health_check() {
  hdr "health (api ${API_CT}, logs since $SINCE)"
  local before=$PLAN_FAILS
  DEADLINE=$((SECONDS + HEALTH_TIMEOUT))
  wait_until "api log: listening on :3000" chk_listening || true
  wait_until "api log: editorial JWKS loaded" chk_jwks || true
  wait_until "proxy GET /healthz -> 200" chk_healthz || true
  wait_until "GET /v1/t/<random>/collections via $HEALTH_VIA -> 401 application/problem+json" chk_problem401 || true
  DEADLINE=$((SECONDS + TICK_TIMEOUT))
  wait_until "next content tick logged errors=0" chk_tick || true
  if chk_probe; then ok "containment probe 1 (resolved-config port audit)"; else bad "containment probe 1 failed"; fi
  [ "$PLAN_FAILS" -eq "$before" ]
}

# Tools container -------------------------------------------------------------------------------------------

# Runs as the deploy user's uid, not root: with --cap-drop ALL, root cannot preserve ownership (`cp -a`
# exits 1, "failed to preserve ownership", proven on sumopod 2026-10-11), and nothing here needs root.
TOOLS_SCRIPT='
set -euo pipefail
W=/tmp/work
mkdir -p "$W" && cp -R /src/. "$W/" && cd "$W"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
(cd api && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
echo "-- migrate (run 1)"; node migrations/migrate.mjs | tee /tmp/m1
echo "-- migrate (run 2, must apply 0)"; node migrations/migrate.mjs | tee /tmp/m2
grep -Eq "[,] 0 applied," /tmp/m2 || { echo "SECOND MIGRATE RUN APPLIED SOMETHING"; exit 1; }
echo "-- RLS integrity gate (owner)"; DATABASE_URL="$OWNER_DATABASE_URL" node scripts/check-rls-integrity.mjs
echo "-- storage-bootstrap"; node scripts/storage-bootstrap.mjs
'

run_tools() {
  local envf="$WORK/tools.env"
  make_tools_envfile "$envf"
  docker run --rm --name "wdeploy-tools-$$" --network "$NET" --env-file "$envf" \
    --user "$(id -u):$(id -g)" -e HOME=/tmp \
    --cpus 1 --memory 768m --pids-limit 512 --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$WD_DIR:/src:ro" -w /tmp "$TOOLS_IMAGE" bash -c "$TOOLS_SCRIPT"
}

# Apply -----------------------------------------------------------------------------------------------------

do_apply() {
  local stamp rid
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  PRE_TAG="$TAG"
  BACKUP_DIR="$BACKUP_ROOT/pre-${TAG}-${stamp}"
  OLD_TREE="${WD_DIR}.old-${TAG}-${stamp}"

  hdr "pull"
  docker pull "$IMAGE_REF" >/dev/null
  rid="$(docker image inspect --format '{{.Id}}' "$IMAGE_REF")"
  image_matches_digest "$rid" "$DIGEST" || die "pulled image id (${rid:0:19}…) != signed digest: refusing to swap"
  ok "pulled; image id = signed digest"

  hdr "rollback anchor"
  local running_id
  running_id="$(running_image_id)"
  PREV_IMAGE_REF="$(running_image_ref)"
  case "$PREV_IMAGE_REF" in ghcr.io/*|*@sha256:*) PREV_MODE=release ;; *) PREV_MODE=local ;; esac
  if image_matches_digest "$running_id" "$DIGEST" && docker image inspect "webdesk-api:pre-$PRE_TAG" >/dev/null 2>&1; then
    say "  running image is already the release and webdesk-api:pre-$PRE_TAG exists: keeping it"
  else
    docker tag "$running_id" "webdesk-api:pre-$PRE_TAG"
    say "  tagged the running image webdesk-api:pre-$PRE_TAG (previous arrangement: $PREV_MODE)"
  fi

  hdr "backup -> $BACKUP_DIR"
  umask 077
  mkdir -p "$BACKUP_DIR"
  local su db role
  su="$(docker exec "$PG_CT" printenv POSTGRES_USER 2>/dev/null || true)"; [ -n "$su" ] || su=postgres
  db="$(docker exec "$PG_CT" printenv POSTGRES_DB 2>/dev/null || true)"; [ -n "$db" ] || db="$su"
  role="$su"
  if docker exec "$PG_CT" psql -U "$su" -d "$db" -X -q -A -t -c "SELECT 1 FROM pg_roles WHERE rolname='webdesk_backup'" 2>/dev/null | grep -x 1 >/dev/null; then role=webdesk_backup; fi
  docker exec "$PG_CT" pg_dump -Fc -U "$role" -d "$db" >"$BACKUP_DIR/webdesk.dump"
  [ -s "$BACKUP_DIR/webdesk.dump" ] || die "pg_dump produced an empty file"
  [ "$(docker exec -i "$PG_CT" pg_restore -l <"$BACKUP_DIR/webdesk.dump" | grep -c .)" -gt 5 ] || die "the dump has no readable table of contents"
  ok "pg_dump -Fc as $role: $(wc -c <"$BACKUP_DIR/webdesk.dump") bytes, TOC readable"
  cp -a "$WD_DIR"/docker-compose*.yml "$BACKUP_DIR/"
  cp -a "$WD_DIR/migrations" "$BACKUP_DIR/migrations"
  {
    echo "TAG=$TAG"
    echo "PRE_TAG=$PRE_TAG"
    echo "PREV_MODE=$PREV_MODE"
    echo "PREV_IMAGE_REF=$PREV_IMAGE_REF"
    echo "OLD_TREE=$OLD_TREE"
    echo "PREV_DEPLOYED_TAG=$(cat "$DEPLOYED_TAG_FILE" 2>/dev/null || true)"
    echo "PREV_ENV_IMAGE=$(env_get_var WEBDESK_API_IMAGE || true)"
  } >"$BACKUP_DIR/state.env"
  ok "compose files, migrations/ and rollback state saved"

  hdr "swap the release tree in (rename; the old tree is kept)"
  mv "$WD_DIR" "$OLD_TREE"
  SWAPPED=1
  mv "$STAGE" "$WD_DIR"
  STAGE=""
  ok "live tree = release tree; old tree at ${OLD_TREE##*/}"

  hdr "migrate / RLS gate / storage bootstrap (throwaway $TOOLS_IMAGE on $NET)"
  run_tools || die "the tools step failed: tree restored, api untouched, migrations not rolled back"

  hdr "up -d --no-deps --no-build api (release overlay)"
  SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  UP_STARTED=1
  compose "$WD_DIR" 1 "$IMAGE_REF" up -d --no-deps --no-build api
  health_check || die "health check failed"

  hdr "record"
  set_env_var "$ENV_FILE" WEBDESK_API_IMAGE "$IMAGE_REF"
  printf '%s\n' "$TAG" >"$DEPLOYED_TAG_FILE"
  SUCCESS=1
  ok "WEBDESK_API_IMAGE written to the env file (value not shown); $DEPLOYED_TAG_FILE = $TAG"
}

do_rollback() {
  local last
  last="$(ls -1dt "$BACKUP_ROOT"/pre-*/ 2>/dev/null | head -1 || true)"
  [ -n "$last" ] || die "no $BACKUP_ROOT/pre-* backup dir to roll back to"
  last="${last%/}"
  say "rolling back using ${last##*/}"
  # shellcheck disable=SC1091
  . "$last/state.env"
  [ -d "$OLD_TREE" ] || [ "$(readlink -f "$WD_DIR")" = "$(readlink -f "$OLD_TREE")" ] || die "old tree $OLD_TREE is gone"
  if [ -d "$OLD_TREE" ]; then
    mv "$WD_DIR" "${WD_DIR}.rolledback-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$OLD_TREE" "$WD_DIR"
  fi
  repin_previous
  SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  DEADLINE=$((SECONDS + 60))
  chk_listening && chk_healthz || die "the rolled-back api is not healthy"
  if [ -n "${PREV_ENV_IMAGE:-}" ]; then set_env_var "$ENV_FILE" WEBDESK_API_IMAGE "$PREV_ENV_IMAGE"; else remove_env_var "$ENV_FILE" WEBDESK_API_IMAGE; fi
  if [ -n "${PREV_DEPLOYED_TAG:-}" ]; then printf '%s\n' "$PREV_DEPLOYED_TAG" >"$DEPLOYED_TAG_FILE"; else rm -f "$DEPLOYED_TAG_FILE"; fi
  say "rolled back to webdesk-api:pre-$PRE_TAG. Migrations were NOT rolled back."
}

main() {
  MODE="${1:-}"
  case "$MODE" in
    plan | apply)
      [ $# -eq 4 ] || die "usage: $0 $MODE <tag> <digest> <tree.tar>"
      TAG=$2 DIGEST=$3 TAR=$4
      ;;
    rollback) ;;
    *) die "usage: $0 plan|apply <tag> <digest> <tree.tar> | rollback" ;;
  esac
  OWNER="$(printf '%s' "${GHCR_OWNER:-}" | tr '[:upper:]' '[:lower:]')"
  valid_project "$PROJECT" || die "WEBDESK_PROJECT '$PROJECT' is not a compose project name"
  case "$HEALTH_VIA" in nginx | direct) ;; *) die "WEBDESK_HEALTH_VIA must be nginx or direct" ;; esac
  WD_DOCKER_HOST="$(wd_docker_host)" || die "WEBDESK_DOCKER_HOST (or /etc/default/webdesk-docker) must be unix:///run/user/<uid>/docker.sock"
  if [ -n "$WD_DOCKER_HOST" ]; then
    # Every plain `docker` call below now talks to the rootless daemon; compose gets it through sudo explicitly.
    export DOCKER_HOST="$WD_DOCKER_HOST"
    docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q 'name=rootless' \
      || die "$WD_DOCKER_HOST does not answer as a rootless Docker daemon"
  fi
  WORK="$(mktemp -d)"
  trap on_exit EXIT
  case "$MODE" in
    plan) plan_checks ;;
    apply)
      plan_checks || die "plan failed; nothing live was changed"
      if [ "${WEBDESK_SKIP_IF_CURRENT:-0}" = 1 ] \
        && already_current "$(running_image_id)" "$DIGEST" "$(running_config_files)" "$WORK/pending" "$STAGE" "$WD_DIR"; then
        hdr "already current"
        say "  running image = signed digest, release overlay in place, 0 pending migrations, tree identical:"
        say "  nothing to deploy; the api was not touched. Recording $TAG as the deployed tag (same bytes)."
        printf '%s\n' "$TAG" >"$DEPLOYED_TAG_FILE"
        SUCCESS=1
      else
        do_apply
      fi
      ;;
    rollback) do_rollback ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
