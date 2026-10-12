#!/usr/bin/env bash
# proof-env.sh - build the PROOF project's env files from the live ones, with every secret replaced
# (M4 F6 P2, plan §9; run as root on gda-aicenter, before a4-copy-rehearsal.sh).
#
#   sudo bash proof-env.sh [--force]
#
# Writes (root 0600 each; the first is compose's --env-file, the second the overlay's relative `env_file: .env.control`):
#   /srv/wdproof/env
#   /srv/wdproof/webdesk/.env.control
# Reads (read-only, never written): /etc/webdesk/.env and /etc/webdesk/.env.control. NEVER prints a value: only
# variable NAMES and counts. Refuses to overwrite an existing proof env unless --force; --force REGENERATES every
# secret, so it is only valid BEFORE a4-copy-rehearsal.sh (afterwards the proof databases would hold the old passwords).
#
# HOW EACH LIVE VARIABLE IS CLASSIFIED (first matching rule wins; the NAME decides, never the value):
#   1. DROPPED          PAYLOAD_*                     (the Payload app was deleted, WSK-48b; nothing reads them)
#   2. FORCED           MAIL_ENABLED=false  WEBDESK_ZONEB_EVENTS_ENABLED=false  OTEL_ENABLED=false
#                       WEBDESK_OTEL_ZONEA_PUSH_ENABLED=false  COMPOSE_PROJECT_NAME=wdproof
#                       WEBDESK_PROXY_HTTP_PORT=18380            (appended when the live file lacks them)
#   3. BLANKED          OTEL_EXPORTER_OTLP_HEADERS  WD_BACKUP_ALERT_*  WD_BACKUP_DEADMANSSWITCH_URL
#                       MAIL_SMTP_PASSWORD  WEBDESK_ZONEB_BRIDGE_URL  IMGPROXY_KEY  IMGPROXY_SALT
#   4. REBUILT          OWNER_DATABASE_URL MIGRATE_DATABASE_URL APP_DATABASE_URL (password swapped for the matching
#                       POSTGRES_*_PASSWORD; scheme, user, host, port, db and query kept) and REDIS_URL (host and port
#                       kept; a password in it, if any, is replaced)
#   5. REGENERATED      every other name matching  PASSWORD | SECRET | PEPPER | TOKEN | CREDENTIAL | PRIVATE |
#                       (^|_)KEY($|_) | ACCESS_KEY | KEY_ID | ^RUSTFS_ROOT_ | ^STORAGE_(ACCESS|SECRET)
#                       with a fresh `openssl rand -hex 24` (48 chars). Exceptions, sized for what consumes them:
#                         *GATE_SECRET, *EDGE_VERIFY_SECRET   hex 32 (64 chars; the proxy wants 64 hex)
#                         *ACCESS_KEY_ID, RUSTFS_ROOT_USER    hex 10 (20 chars; S3 access-key length limits)
#                         *SECRET_ACCESS_KEY, RUSTFS_ROOT_PASSWORD  hex 16 (32 chars; S3 secret-key length limits)
#                       A secret-class variable that is EMPTY live stays empty (empty means "feature off", e.g. the
#                       retired WS4 HMAC key); inventing a value would switch the feature on.
#   6. COPIED VERBATIM  everything else (hostnames, ports, limits, bucket names, image refs, public URLs, user names,
#                       the public mTLS CA PEM). Any copied value that LOOKS like a token (>=32 chars of [A-Za-z0-9+/=_-],
#                       no ':' or '/') is listed by NAME as a WARN so a human can reclassify it: this is the only
#                       backstop against a secret with an unexpected name.
# Comments and blank lines are not copied. A multi-line quoted value (the CA PEM) is carried or dropped as one unit.
#
# Exit 0 only if every check passes ("passed=N failed=M").
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=proof-lib.sh
. "$HERE/proof-lib.sh"

LIVE_ENV=/etc/webdesk/.env
LIVE_CONTROL=/etc/webdesk/.env.control
OUT_ENV="$PROOF_ENV"
OUT_CONTROL="$PROOF_TREE/.env.control"

declare -A FORCED=(
  [MAIL_ENABLED]=false
  [WEBDESK_ZONEB_EVENTS_ENABLED]=false
  [OTEL_ENABLED]=false
  [WEBDESK_OTEL_ZONEA_PUSH_ENABLED]=false
  [COMPOSE_PROJECT_NAME]=wdproof
  [WEBDESK_PROXY_HTTP_PORT]=18380
)
FORCED_ORDER=(MAIL_ENABLED WEBDESK_ZONEB_EVENTS_ENABLED OTEL_ENABLED WEBDESK_OTEL_ZONEA_PUSH_ENABLED COMPOSE_PROJECT_NAME WEBDESK_PROXY_HTTP_PORT)
BLANK_RE='^(OTEL_EXPORTER_OTLP_HEADERS|WD_BACKUP_ALERT_.*|WD_BACKUP_DEADMANSSWITCH_URL|MAIL_SMTP_PASSWORD|WEBDESK_ZONEB_BRIDGE_URL|IMGPROXY_KEY|IMGPROXY_SALT)$'
SECRET_RE='(PASSWORD|SECRET|PEPPER|TOKEN|CREDENTIAL|PRIVATE|(^|_)KEY($|_)|ACCESS_KEY|KEY_ID|^RUSTFS_ROOT_|^STORAGE_(ACCESS|SECRET))'
URL_KEYS=(OWNER_DATABASE_URL MIGRATE_DATABASE_URL APP_DATABASE_URL REDIS_URL)

rand_hex() { openssl rand -hex "$1"; }

# gen_for <name>: a fresh value sized for the variable's consumer.
gen_for() {
  case "$1" in
    *GATE_SECRET | *EDGE_VERIFY_SECRET) rand_hex 32 ;;
    *ACCESS_KEY_ID | RUSTFS_ROOT_USER) rand_hex 10 ;;
    *SECRET_ACCESS_KEY | RUSTFS_ROOT_PASSWORD) rand_hex 16 ;;
    *) rand_hex 24 ;;
  esac
}

# parse_env <file>: fills ORDER (names in file order), RAW[name] (the whole entry, continuation lines included)
# and VAL[name] (the first line's value, quotes stripped). A value that opens a quote it does not close on the same
# line continues until a line that closes it.
declare -a ORDER
declare -A RAW VAL
parse_env() {
  local line key rest q cur="" open=""
  ORDER=() RAW=() VAL=()
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [ -n "$open" ]; then
      RAW[$cur]+=$'\n'"$line"
      case "$line" in *"$open") open="" ;; esac
      continue
    fi
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      rest="${BASH_REMATCH[2]}"
      cur="$key"
      if [ -z "${RAW[$key]+x}" ]; then ORDER+=("$key"); fi
      RAW[$key]="$key=$rest"
      q="${rest:0:1}"
      if [ "$q" = '"' ] || [ "$q" = "'" ]; then
        if [ "${#rest}" -ge 2 ] && [ "${rest: -1}" = "$q" ]; then VAL[$key]="${rest:1:${#rest}-2}"
        else open="$q"; VAL[$key]="${rest:1}"; fi
      else
        VAL[$key]="$rest"
      fi
    fi
  done <"$1"
  [ -z "$open" ]
}

# transform_env <mode env|control> <live-file> <out-file>: classify and write. Prints NAME lists, never values.
# Sets T_WARN (names of copied token-looking values), T_REGEN, T_BLANK, T_COPY, T_DROP counts.
transform_env() {
  local mode=$1 in=$2 out=$3 key val new u pw m rc=0
  local -A FINAL KIND
  local -a regen=() blank=() copied=() dropped=() warns=() forced_added=()
  parse_env "$in" || { fail "$in: a quoted value is never closed"; return 1; }
  [ "${#ORDER[@]}" -gt 0 ] || { fail "$in holds no VAR=value lines"; return 1; }

  for key in "${ORDER[@]}"; do
    val="${VAL[$key]}"
    if [[ "$key" == PAYLOAD_* ]]; then KIND[$key]=drop; dropped+=("$key"); continue; fi
    if [ "$mode" = env ] && [ -n "${FORCED[$key]+x}" ]; then FINAL[$key]="${FORCED[$key]}"; KIND[$key]=forced; continue; fi
    if [[ "$key" =~ $BLANK_RE ]]; then FINAL[$key]=""; KIND[$key]=blank; blank+=("$key"); continue; fi
    if [ "$mode" = env ]; then
      case "$key" in OWNER_DATABASE_URL | MIGRATE_DATABASE_URL | APP_DATABASE_URL | REDIS_URL) KIND[$key]=url; continue ;; esac
    fi
    if [[ "$key" =~ $SECRET_RE ]]; then
      if [ -z "$val" ]; then FINAL[$key]=""; KIND[$key]=emptysecret; else FINAL[$key]="$(gen_for "$key")"; KIND[$key]=regen; regen+=("$key"); fi
      continue
    fi
    KIND[$key]=copy
    copied+=("$key")
    if [[ "$val" =~ ^[A-Za-z0-9+/=_-]{32,}$ ]]; then warns+=("$key"); fi
  done

  if [ "$mode" = env ]; then
    # The three database URLs and REDIS_URL, rebuilt from the new passwords (hostnames and ports stay).
    declare -A UPW=([OWNER_DATABASE_URL]=POSTGRES_OWNER_PASSWORD [MIGRATE_DATABASE_URL]=POSTGRES_MIGRATOR_PASSWORD [APP_DATABASE_URL]=POSTGRES_APP_PASSWORD)
    declare -A UUSR=([OWNER_DATABASE_URL]=POSTGRES_OWNER_USER [MIGRATE_DATABASE_URL]=POSTGRES_MIGRATOR_USER [APP_DATABASE_URL]=POSTGRES_APP_USER)
    for key in "${URL_KEYS[@]}"; do
      [ "${KIND[$key]:-}" = url ] || { if [ "$key" != REDIS_URL ]; then fail "$key is missing from $in"; rc=1; fi; continue; }
      val="${VAL[$key]}"
      if [ "$key" = REDIS_URL ]; then
        if [[ "$val" =~ ^([A-Za-z][A-Za-z0-9+.-]*://[^:@/]*):[^@]*@(.*)$ ]]; then
          FINAL[$key]="${BASH_REMATCH[1]}:$(rand_hex 24)@${BASH_REMATCH[2]}"; regen+=("$key")
        else FINAL[$key]="$val"; copied+=("$key"); fi
        continue
      fi
      if ! [[ "$val" =~ ^([A-Za-z][A-Za-z0-9+.-]*://)([^:@/]+):[^@]*@(.*)$ ]]; then fail "$key has no user:password@host form: cannot rebuild it"; rc=1; continue; fi
      u="${BASH_REMATCH[2]}"
      if [ "$u" != "${FINAL[${UUSR[$key]}]:-${VAL[${UUSR[$key]}]:-}}" ]; then fail "$key's user does not match ${UUSR[$key]}: refusing to guess"; rc=1; continue; fi
      pw="${FINAL[${UPW[$key]}]:-}"
      [ -n "$pw" ] || { fail "${UPW[$key]} was not regenerated: cannot rebuild $key"; rc=1; continue; }
      FINAL[$key]="${BASH_REMATCH[1]}$u:$pw@${BASH_REMATCH[3]}"
      regen+=("$key")
    done
    # Required and never blank.
    for key in WEBDESK_API_IMAGE POSTGRES_SUPERUSER POSTGRES_SUPERUSER_PASSWORD POSTGRES_DB POSTGRES_OWNER_USER POSTGRES_MIGRATOR_USER POSTGRES_APP_USER \
               RUSTFS_ROOT_USER RUSTFS_ROOT_PASSWORD STORAGE_ACCESS_KEY_ID STORAGE_SECRET_ACCESS_KEY WEBDESK_CONTROL_GATE_SECRET API_KEY_PEPPER; do
      if [ -z "${KIND[$key]:-}" ]; then fail "$key is missing from $in"; rc=1
      elif [ "${KIND[$key]}" != copy ] && [ -z "${FINAL[$key]:-}" ]; then fail "$key came out empty"; rc=1; fi
    done
    [ -n "${VAL[WEBDESK_API_IMAGE]:-}" ] || { fail "WEBDESK_API_IMAGE is empty live"; rc=1; }
  fi
  [ "$rc" = 0 ] || return 1

  : >"$out" || { fail "cannot write $out"; return 1; }
  chmod 0600 "$out"
  for key in "${ORDER[@]}"; do
    case "${KIND[$key]}" in
      drop) ;;
      copy) printf '%s\n' "${RAW[$key]}" >>"$out" ;;
      url) printf '%s=%s\n' "$key" "${FINAL[$key]}" >>"$out" ;;
      *) printf '%s=%s\n' "$key" "${FINAL[$key]}" >>"$out" ;;
    esac
  done
  if [ "$mode" = env ]; then
    for key in "${FORCED_ORDER[@]}"; do
      if [ -z "${KIND[$key]:-}" ]; then printf '%s=%s\n' "$key" "${FORCED[$key]}" >>"$out"; forced_added+=("$key"); fi
    done
  fi

  info "$(basename "$in") -> $(basename "$out"): ${#ORDER[@]} variables"
  info "regenerated (${#regen[@]}): ${regen[*]:-none}"
  info "blanked (${#blank[@]}): ${blank[*]:-none}"
  info "dropped (${#dropped[@]}): ${dropped[*]:-none}"
  [ "${#forced_added[@]}" = 0 ] || info "forced values appended (live lacked them): ${forced_added[*]}"
  info "copied verbatim: ${#copied[@]}"
  if [ "${#warns[@]}" -gt 0 ]; then warn "copied values that look like tokens (reclassify by name if any is a secret): ${warns[*]}"; fi
  T_REGEN=${#regen[@]}
  return 0
}

# verify_output <env-file> <control-file>: nothing sensitive survived, and the forced values hold. Prints names only.
verify_output() {
  local env=$1 ctl=$2 k want got bad=0
  for k in "${FORCED_ORDER[@]}"; do
    want="${FORCED[$k]}"
    got="$(cfg_get "$env" "$k")"
    if [ "$got" = "$want" ]; then pass "forced: $k=$want"; else fail "forced: $k is not $want"; fi
  done
  for k in OTEL_EXPORTER_OTLP_HEADERS WD_BACKUP_DEADMANSSWITCH_URL MAIL_SMTP_PASSWORD WEBDESK_ZONEB_BRIDGE_URL IMGPROXY_KEY IMGPROXY_SALT; do
    if [ -z "$(cfg_get "$env" "$k")" ]; then pass "blank: $k"; else fail "$k is not blank"; bad=1; fi
  done
  if grep -Eq '^WD_BACKUP_ALERT_[A-Z_]*=.' "$env"; then fail "a WD_BACKUP_ALERT_* variable is not blank"; else pass "blank: WD_BACKUP_ALERT_*"; fi
  # No regenerated value may equal the live one (a copy that slipped through): compare secret-class names, by hash.
  if [ -r "$LIVE_ENV" ]; then
    local n same=0
    while IFS= read -r n; do
      [[ "$n" =~ $SECRET_RE ]] || continue
      [[ "$n" == PAYLOAD_* ]] && continue
      got="$(cfg_get "$env" "$n")"
      want="$(cfg_get "$LIVE_ENV" "$n")"
      [ -n "$got" ] && [ -n "$want" ] || continue
      [ "$got" != "$want" ] || { fail "$n still holds the LIVE value"; same=1; }
    done < <(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$env")
    for n in OWNER_DATABASE_URL MIGRATE_DATABASE_URL APP_DATABASE_URL; do
      [ "$(cfg_get "$env" "$n")" != "$(cfg_get "$LIVE_ENV" "$n")" ] || { fail "$n still holds the LIVE value"; same=1; }
    done
    [ "$same" = 0 ] && pass "no secret-class variable and no database URL equals its live value"
  fi
  for k in "$env" "$ctl"; do
    if [ "$(stat -c '%a %U' "$k")" = "600 root" ]; then pass "$k is root 0600"; else fail "$k is not root 0600 ($(stat -c '%a %U' "$k"))"; fi
  done
}

main() {
  local force=0
  case "${1:-}" in "") ;; --force) force=1 ;; *) die "usage: $0 [--force]" ;; esac
  hdr "preflight"
  require_proof_context
  [ -r "$LIVE_ENV" ] || die "cannot read $LIVE_ENV"
  [ -r "$LIVE_CONTROL" ] || die "cannot read $LIVE_CONTROL"
  [ -d "$PROOF_TREE" ] || die "$PROOF_TREE is missing"
  command -v openssl >/dev/null 2>&1 || die "openssl is required"
  if [ -e "$OUT_ENV" ] || [ -e "$OUT_CONTROL" ]; then
    if [ "$force" = 0 ]; then die "REFUSED: $OUT_ENV or $OUT_CONTROL exists (--force regenerates every secret; only valid before A4)"; fi
    if dr volume inspect wdproof_webdesk_pgdata >/dev/null 2>&1 || dp volume inspect wdproof_webdesk_pgdata >/dev/null 2>&1; then
      die "REFUSED even with --force: a proof Postgres volume exists, and new passwords would not match it. Undo A4 first (a4-copy-rehearsal.sh reset --yes)"
    fi
    warn "--force: replacing the existing proof env files with freshly generated secrets"
  fi
  umask 077
  local tenv tctl
  tenv="$(mktemp -p "$PROOF_ROOT" .env.new.XXXXXX)" || die "cannot create a temp file in $PROOF_ROOT"
  tctl="$(mktemp -p "$PROOF_ROOT" .envc.new.XXXXXX)" || die "cannot create a temp file in $PROOF_ROOT"
  TMPFILES+=("$tenv" "$tctl")

  hdr "classify and rewrite (names only; no value is printed)"
  transform_env env "$LIVE_ENV" "$tenv" && pass "the proof env was written" || die "could not build the proof env"
  transform_env control "$LIVE_CONTROL" "$tctl" && pass "the proof .env.control was written" || die "could not build the proof .env.control"
  mv -f "$tenv" "$OUT_ENV" && mv -f "$tctl" "$OUT_CONTROL" || die "could not move the files into place"
  chown root:root "$OUT_ENV" "$OUT_CONTROL"
  chmod 0600 "$OUT_ENV" "$OUT_CONTROL"

  hdr "verify"
  verify_output "$OUT_ENV" "$OUT_CONTROL"
  [ "$(cfg_get "$OUT_ENV" WEBDESK_API_IMAGE)" = "$(cfg_get "$LIVE_ENV" WEBDESK_API_IMAGE)" ] && pass "WEBDESK_API_IMAGE equals live's" || fail "WEBDESK_API_IMAGE differs from live's"
  info "next: bash $HERE/a4-copy-rehearsal.sh"
  summary
}

if [ -z "${PROOF_ENV_SOURCE_ONLY:-}" ]; then main "$@"; fi
