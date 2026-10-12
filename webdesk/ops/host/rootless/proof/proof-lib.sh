#!/usr/bin/env bash
# proof-lib.sh - shared helpers for the P2 proof rehearsal scripts (M4 F6, WSK-D73; plan §9 rows A4/A5/A7/A8).
# SOURCED by proof-env.sh, a4-copy-rehearsal.sh, a5-stack.sh, a7-backup.sh and a8-reboot-standin.sh. Never run alone.
#
# SAFETY MODEL (the scripts run as root next to the LIVE ERP and WebDesk, so this is the first requirement):
#   * every script calls require_proof_context first: root, the proof guard config says role proof and uid 941,
#     the proof daemon's socket exists and really IS a rootless daemon, the rootful daemon is NOT.
#   * the project is the constant "wdproof". A WEBDESK_PROJECT or COMPOSE_PROJECT_NAME that says otherwise is refused.
#   * the proof daemon is reached only through dp()/wdc(); the rootful daemon only through dr(). Every rootful
#     MUTATION (rm/stop/run/volume/network) goes through a wrapper that refuses any name that is not a whitelisted
#     proof throwaway: containers and networks wdproof-a<N>-*, volumes wdproof_webdesk_{pgdata,rustfsdata,redisdata}.
#     The live "webdesk" and "gaiada" projects, their volumes and networks cannot be named by these wrappers.
#   * /etc/webdesk is only READ (proof-env.sh copies non-secret values); nothing here writes there.
#   * secrets are never printed: values travel through 0600 temp files, stdin and heredocs, never argv or stdout.
#
# Output contract: PASS/FAIL lines, then "passed=N failed=M"; exit 0 only if M=0.

PROOF_USER=wdproof-rootless
PROOF_UID=941
PROOF_PROJECT=wdproof
PROOF_SOCK="unix:///run/user/941/docker.sock"
PROOF_SOCK_PATH=/run/user/941/docker.sock
PROOF_ROOT=/srv/wdproof
PROOF_TREE=/srv/wdproof/webdesk
PROOF_ENV=/srv/wdproof/env
PROOF_EVID=/srv/wdproof/evidence
PROOF_CONF=/etc/default/webdesk-rootless-wdproof-rootless
PROOF_PORT=18380
PROOF_GUARD_UNIT=webdesk-rootless-guard@wdproof-rootless.service
PROOF_GUARD_BIN=/usr/local/sbin/webdesk-rootless-guard.sh

# --- result bookkeeping ---------------------------------------------------------------------------------------

PASSED=0
FAILED=0
_SUMMARY_DONE=0
TMPFILES=()
RUN_TMP=""   # per-run 0700 scratch directory under the evidence dir; created by require_proof_context, removed at exit

pass() { printf '  PASS  %s\n' "$*"; PASSED=$((PASSED + 1)); }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
info() { printf '  INFO  %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; }
hdr() { printf '\n== %s\n' "$*"; }
# check <description> <command...>: PASS if the command succeeds (its output is discarded).
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then pass "$d"; else fail "$d"; fi; }
# die <message>: a failed precondition. Counts as a FAIL, runs the script's cleanup(), prints the summary, exit 1.
die() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); exit 1; }

_on_exit() {
  local rc=$?
  trap - EXIT
  if declare -F cleanup >/dev/null; then cleanup || true; fi
  local f
  for f in "${TMPFILES[@]:-}"; do [ -z "$f" ] || rm -f -- "$f"; done
  [ -z "$RUN_TMP" ] || rm -rf -- "$RUN_TMP"
  if [ "$_SUMMARY_DONE" = 0 ]; then
    if [ "$rc" != 0 ] && [ "$FAILED" = 0 ]; then printf '  FAIL  script aborted (exit %s)\n' "$rc"; FAILED=$((FAILED + 1)); fi
    printf '\npassed=%d failed=%d\n' "$PASSED" "$FAILED"
    _SUMMARY_DONE=1
  fi
  if [ "$FAILED" = 0 ]; then exit 0; else exit 1; fi
}
trap _on_exit EXIT
trap 'exit 130' INT TERM HUP

# --- parsing helpers (config and env files are PARSED, never sourced) -----------------------------------------

# cfg_get <file> <KEY>: last KEY=value line, one pair of surrounding double quotes stripped.
cfg_get() {
  local v
  v="$(sed -n "s/^[[:space:]]*$2=//p" "$1" 2>/dev/null | tail -n 1 || true)"
  v="${v#\"}"
  printf '%s' "${v%\"}"
}
# envget <KEY> [file]: value of KEY in an env file (default the proof env), quotes stripped. Never echo it casually.
envget() { cfg_get "${2:-$PROOF_ENV}" "$1"; }
is_ident() { [[ "${1:-}" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; }

# --- the two daemons ------------------------------------------------------------------------------------------

# dp: the PROOF (rootless) daemon.   dr: the ROOTFUL daemon (reads, and mutations only through the rf_* wrappers).
dp() { env -u DOCKER_CONTEXT DOCKER_HOST="$PROOF_SOCK" docker "$@"; }
dr() { env -u DOCKER_HOST -u DOCKER_CONTEXT docker "$@"; }

# wdc: docker compose against the proof project, on the proof daemon, with the proof env and the proof tree.
wdc() {
  env -u DOCKER_CONTEXT -u COMPOSE_FILE -u COMPOSE_PROFILES -u COMPOSE_PROJECT_NAME -u COMPOSE_PATH_SEPARATOR \
    DOCKER_HOST="$PROOF_SOCK" docker compose -p "$PROOF_PROJECT" --project-directory "$PROOF_TREE" --env-file "$PROOF_ENV" \
    -f "$PROOF_TREE/docker-compose.yml" -f "$PROOF_TREE/docker-compose.aicenter.yml" \
    -f "$PROOF_TREE/docker-compose.aicenter-release.yml" "$@"
}

# --- rootful throwaway wrappers (the ONLY way these scripts mutate the rootful daemon) -------------------------

rf_name_ok() { [[ "${1:-}" =~ ^wdproof-a[0-9]+-[a-z0-9][a-z0-9-]*$ ]]; }
rf_vol_ok() { case "${1:-}" in wdproof_webdesk_pgdata | wdproof_webdesk_rustfsdata | wdproof_webdesk_redisdata) return 0 ;; esac; return 1; }
rf_exists() { dr container inspect "$1" >/dev/null 2>&1; }
rf_rm() { rf_name_ok "$1" || die "internal: refusing to remove rootful container '$1' (not a wdproof-a<N>-* throwaway)"; dr rm -f "$1" >/dev/null 2>&1; }
rf_stop() { rf_name_ok "$1" || die "internal: refusing to stop rootful container '$1'"; local t=$1; shift; dr stop "$@" "$t"; }
rf_net_create() { rf_name_ok "$1" || die "internal: refusing network '$1'"; dr network create --internal "$1"; }
rf_net_rm() { rf_name_ok "$1" || die "internal: refusing to remove network '$1'"; dr network rm "$1" >/dev/null 2>&1; }
rf_vol_create() { rf_vol_ok "$1" || die "internal: refusing rootful volume '$1'"; dr volume create "$1"; }
rf_vol_rm() { rf_vol_ok "$1" || die "internal: refusing to remove rootful volume '$1'"; dr volume rm "$1"; }
# rf_run <name> <docker run args...>: `docker run` on the rootful daemon, name checked, always with --name.
rf_run() { local n=$1; shift; rf_name_ok "$n" || die "internal: refusing rootful container name '$n'"; dr run --name "$n" "$@"; }

# --- the gate every script passes first -----------------------------------------------------------------------

require_proof_context() {
  [ "$(id -u)" = 0 ] || die "must run as root"
  # The project is fixed. A script that was handed another one is being misused.
  [ "${WEBDESK_PROJECT:-$PROOF_PROJECT}" = "$PROOF_PROJECT" ] || die "REFUSED: WEBDESK_PROJECT='${WEBDESK_PROJECT}'; only '$PROOF_PROJECT' is allowed"
  [ "${COMPOSE_PROJECT_NAME:-$PROOF_PROJECT}" = "$PROOF_PROJECT" ] || die "REFUSED: COMPOSE_PROJECT_NAME='${COMPOSE_PROJECT_NAME}'; only '$PROOF_PROJECT' is allowed"
  [ -r "$PROOF_CONF" ] || die "REFUSED: $PROOF_CONF is missing (the proof install, install-rootless.sh --profile proof, is not there)"
  [ "$(cfg_get "$PROOF_CONF" RL_ROLE)" = proof ] || die "REFUSED: $PROOF_CONF does not say RL_ROLE=proof"
  [ "$(cfg_get "$PROOF_CONF" RL_UID)" = "$PROOF_UID" ] || die "REFUSED: $PROOF_CONF does not say RL_UID=$PROOF_UID"
  [ "$(getent passwd "$PROOF_UID" | cut -d: -f1)" = "$PROOF_USER" ] || die "REFUSED: uid $PROOF_UID is not $PROOF_USER"
  install -d -m 0700 "$PROOF_EVID" || die "cannot create $PROOF_EVID"
  RUN_TMP="$(mktemp -d -p "$PROOF_EVID" .run.XXXXXX)" || die "cannot create a scratch directory in $PROOF_EVID"
  pass "proof context: role proof, user $PROOF_USER (uid $PROOF_UID), project $PROOF_PROJECT"
}

# require_daemons: the proof socket must be a rootless daemon, and the default one must not be.
require_daemons() {
  [ -S "$PROOF_SOCK_PATH" ] || die "REFUSED: $PROOF_SOCK_PATH is not a socket (is user@$PROOF_UID running?)"
  local so
  so="$(dp info --format '{{json .SecurityOptions}}' 2>/dev/null || true)"
  case "$so" in *rootless*) pass "proof daemon at $PROOF_SOCK is rootless" ;; *) die "REFUSED: the daemon at $PROOF_SOCK does not report rootless (SecurityOptions=$so)" ;; esac
  so="$(dr info --format '{{json .SecurityOptions}}' 2>/dev/null || true)"
  [ -n "$so" ] || die "the rootful daemon does not answer"
  case "$so" in *rootless*) die "REFUSED: the default daemon reports rootless: DOCKER_HOST/context is not what these scripts expect" ;; *) pass "the default (rootful) daemon is rootful" ;; esac
}

require_proof_files() {
  [ -f "$PROOF_ENV" ] || die "REFUSED: $PROOF_ENV is missing (run proof-env.sh first)"
  [ -f "$PROOF_TREE/.env.control" ] || die "REFUSED: $PROOF_TREE/.env.control is missing (run proof-env.sh first)"
  [ -f "$PROOF_TREE/docker-compose.aicenter-release.yml" ] || die "REFUSED: $PROOF_TREE is not a webdesk tree"
  [ "$(envget COMPOSE_PROJECT_NAME)" = "$PROOF_PROJECT" ] || die "REFUSED: $PROOF_ENV does not say COMPOSE_PROJECT_NAME=$PROOF_PROJECT"
  [ "$(envget WEBDESK_PROXY_HTTP_PORT)" = "$PROOF_PORT" ] || die "REFUSED: $PROOF_ENV does not say WEBDESK_PROXY_HTTP_PORT=$PROOF_PORT"
}

# --- small utilities ------------------------------------------------------------------------------------------

# wait_until <seconds> <command...>: poll every 2 s; 0 as soon as the command succeeds.
wait_until() {
  local end=$((SECONDS + $1))
  shift
  while :; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    [ "$SECONDS" -lt "$end" ] || return 1
    sleep 2
  done
}

# mk_tmp: a 0600 temp file inside the per-run scratch dir (removed at exit with the dir), path on stdout. Safe to call in
# $(...): the removal does not depend on any variable set in the subshell. Needs require_proof_context first.
mk_tmp() {
  [ -n "$RUN_TMP" ] && [ -d "$RUN_TMP" ] || { echo "mk_tmp: no scratch dir (call require_proof_context first)" >&2; return 1; }
  mktemp -p "$RUN_TMP" f.XXXXXX
}

# ev_dir <name>: the evidence subdirectory (root 0700), path on stdout.
ev_dir() {
  install -d -m 0700 "$PROOF_EVID" "$PROOF_EVID/$1"
  printf '%s\n' "$PROOF_EVID/$1"
}

# The per-table row-count query of plan §10 (public tables, exact counts), one "<table> <n>" line each.
COUNTS_SQL="SELECT format('%s %s', c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1"

# proof_image <service>: the image the compose project resolves for a service (digest-pinned in the overlays).
proof_image() { wdc config --images 2>/dev/null | grep -E "$1" | head -n 1; }

# stage_api_image: the private api image lives on the rootful daemon only. Save it into the proof daemon and refuse
# unless the loaded id equals the digest (plan §9 A5 / §10 P3). Idempotent: skipped when it is already there.
stage_api_image() {
  local api dig have out id
  api="$(envget WEBDESK_API_IMAGE)"
  [[ "$api" =~ ^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]] || { fail "WEBDESK_API_IMAGE in $PROOF_ENV is not a digest-pinned ref"; return 1; }
  dig="${api##*@}"
  have="$(dp image inspect --format '{{.Id}}' "$api" 2>/dev/null || true)"
  if [ "$have" = "$dig" ]; then pass "api image already on the proof daemon (id = digest ${dig:0:19})"; return 0; fi
  dr image inspect "$api" >/dev/null 2>&1 || { fail "the api image is not on the rootful daemon ($api)"; return 1; }
  out="$(dr save "$api" | dp load 2>&1)" || { fail "docker save | docker load failed: $(printf '%s' "$out" | tail -n 2 | tr '\n' ' ')"; return 1; }
  id="$(dp image inspect --format '{{.Id}}' "$api" 2>/dev/null || true)"
  if [ -z "$id" ]; then id="$(grep -oE 'sha256:[0-9a-f]{64}' <<<"$out" | tail -n 1 || true)"; fi
  if [ "$id" = "$dig" ]; then pass "api image staged on the proof daemon: loaded id equals the digest ($dig)"; return 0; fi
  fail "loaded api image id '${id:-none}' != digest '$dig': REFUSING (do not run this image)"
  return 1
}

# summary: end of script. The EXIT trap prints "passed=N failed=M"; this only exits through it.
summary() { exit 0; }
