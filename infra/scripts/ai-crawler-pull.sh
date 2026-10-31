#!/usr/bin/env bash
# ai-crawler-pull.sh - the ERP PULLS AI-crawler access-log lines from every site we host (M5-P5b2).
#
# STATUS: PROTOTYPED. Not installed anywhere. Runbook: infra/runbooks/ai-crawler-log.md. Run by
# infra/systemd/ai-crawler-pull.timer every 15 minutes, as root on the ERP host.
#
# For every enabled source in sources.json and every log path of it, ONE ssh call runs a small POSIX sh script on the web
# host. It prints "<inode> <size>" and then ONLY the lines added since the stored offset, already filtered on the web host
# with grep on the SAME UA tokens the parser uses (fetched once per run from the platform container), so no human
# visitor's line ever leaves the web host. The lines are piped into
#   docker exec -i <platform container> node dist/seed/ai-crawler-ingest.js --tenant <uuid> --property <uuid>
# and the stored offset moves ONLY when that exits 0. A failed source logs one line (name, path, reason; never a log
# line) and the run goes on; the exit status is non-zero if any source failed.
#
# Config (env, all optional):
#   AI_CRAWLER_SOURCES      sources.json                 default /etc/gaiada/ai-crawler/sources.json
#   AI_CRAWLER_KEY          the job's private key        default /etc/gaiada/ai-crawler/id_ed25519
#   AI_CRAWLER_KNOWN_HOSTS  pinned host keys             default /etc/gaiada/ai-crawler/known_hosts
#   AI_CRAWLER_STATE        offsets                      default /var/lib/gaiada/ai-crawler
#   AI_CRAWLER_LOCK         flock file                   default /run/lock/gaiada-ai-crawler-pull.lock
#   AI_CRAWLER_CONTAINER    platform container           default gaiada-platform-1
#   AI_CRAWLER_SSH          ssh command (test stub)      default ssh
#   AI_CRAWLER_INGEST       ingest command (test stub)   default docker exec -i $AI_CRAWLER_CONTAINER node dist/seed/ai-crawler-ingest.js
#   AI_CRAWLER_CONNECT_TIMEOUT (s, 20) and AI_CRAWLER_CALL_TIMEOUT (s, 300)
# A new host key is NEVER accepted automatically (StrictHostKeyChecking=yes): an unpinned host fails its source.
set -uo pipefail

SOURCES="${AI_CRAWLER_SOURCES:-/etc/gaiada/ai-crawler/sources.json}"
KEY="${AI_CRAWLER_KEY:-/etc/gaiada/ai-crawler/id_ed25519}"
KNOWN_HOSTS="${AI_CRAWLER_KNOWN_HOSTS:-/etc/gaiada/ai-crawler/known_hosts}"
STATE="${AI_CRAWLER_STATE:-/var/lib/gaiada/ai-crawler}"
LOCK="${AI_CRAWLER_LOCK:-/run/lock/gaiada-ai-crawler-pull.lock}"
CONTAINER="${AI_CRAWLER_CONTAINER:-gaiada-platform-1}"
SSH="${AI_CRAWLER_SSH:-ssh}"
INGEST="${AI_CRAWLER_INGEST:-docker exec -i $CONTAINER node dist/seed/ai-crawler-ingest.js}"
CONNECT_TIMEOUT="${AI_CRAWLER_CONNECT_TIMEOUT:-20}"
CALL_TIMEOUT="${AI_CRAWLER_CALL_TIMEOUT:-300}"

log() { printf 'ai-crawler-pull: %s\n' "$*" >&2; }

command -v jq >/dev/null 2>&1 || { log "jq is not installed"; exit 1; }
command -v flock >/dev/null 2>&1 || { log "flock is not installed"; exit 1; }
# A jq build for Windows ends lines with CRLF; strip it so a value never carries a stray CR (a no-op on Linux).
# pipefail (set above) keeps jq's own exit status.
jq() { command jq "$@" | tr -d '\r'; }

# One run at a time. A run that finds the lock held is not a failure: the next tick comes anyway.
mkdir -p "$(dirname "$LOCK")" 2>/dev/null || true
exec 9>"$LOCK" || { log "cannot open lock file"; exit 1; }
flock -n 9 || { log "another run holds the lock, skipping this tick"; exit 0; }

[ -r "$SOURCES" ] || { log "sources file not readable"; exit 1; }
jq -e 'type == "array"' "$SOURCES" >/dev/null 2>&1 || { log "sources file is not a JSON array"; exit 1; }

enabled="$(jq -c '.[] | select(type == "object" and .enabled == true)' "$SOURCES")" || { log "sources file unreadable"; exit 1; }
[ -n "$enabled" ] || exit 0   # empty array or every source disabled: nothing to do

TMP="$(mktemp -d)" || { log "no temp dir"; exit 1; }
trap 'rm -rf "$TMP"' EXIT

# The bots' UA tokens: the parser's own list, the single source of truth. Fetched once per run.
# shellcheck disable=SC2086
PATTERN="$($INGEST --grep-pattern 2>"$TMP/pattern.err")" || PATTERN=""
if [ -z "$PATTERN" ]; then log "cannot read the bot pattern from the platform container"; exit 1; fi

# Single-quote a value for a POSIX shell on the far side.
q() { local sq="'" bs='\'; printf "'%s'" "${1//$sq/$sq$bs$sq$sq}"; }

# The remote script. $1 path, $2 stored offset, $3 stored inode, $4 grep pattern. Prints "<inode> <size>" and then only
# the bot lines added since the offset. Exit 4: the file is missing or unreadable.
REMOTE_SCRIPT='f=$1; o=$2; i=$3; p=$4
[ -r "$f" ] || exit 4
ino=$(stat -c %i "$f") || exit 5
size=$(stat -c %s "$f") || exit 5
echo "$ino $size"
if [ "$ino" != "$i" ] || [ "$size" -lt "$o" ]; then o=0; fi
if [ "$size" -gt "$o" ]; then
  tail -c +$((o + 1)) "$f" | head -c $((size - o)) | grep -aiE -e "$p" || true
fi'

failed=0
fail() { # name path reason
  log "FAIL source=$1 log=$2 reason=$3"
  failed=1
}

pull_one() { # entry-json log-path
  local entry="$1" path="$2" name tenant property host port user jump
  name="$(jq -r '.name // ""' <<<"$entry")"
  tenant="$(jq -r '.tenantId // ""' <<<"$entry")"
  property="$(jq -r '.propertyId // ""' <<<"$entry")"
  host="$(jq -r '.host // ""' <<<"$entry")"
  port="$(jq -r '.port // 22' <<<"$entry")"
  user="$(jq -r '.user // ""' <<<"$entry")"
  jump="$(jq -r '.proxyJump // ""' <<<"$entry")"

  # Everything below ends up in a path or an ssh argument: refuse anything that is not plainly a name, an id or a host.
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { fail "${name:-?}" "$path" "bad source name"; return; }
  [[ "$tenant" =~ ^[0-9a-fA-F-]{36}$ && "$property" =~ ^[0-9a-fA-F-]{36}$ ]] || { fail "$name" "$path" "tenantId or propertyId is not a uuid"; return; }
  [[ "$host" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { fail "$name" "$path" "bad host"; return; }
  [[ "$user" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ ]] || { fail "$name" "$path" "bad user"; return; }
  [[ "$port" =~ ^[0-9]{1,5}$ ]] || { fail "$name" "$path" "bad port"; return; }
  [[ -z "$jump" || "$jump" =~ ^[A-Za-z0-9_][A-Za-z0-9._@:,-]*$ ]] || { fail "$name" "$path" "bad proxyJump"; return; }
  [[ "$path" == /* && "$path" =~ ^[A-Za-z0-9._/+@=-]+$ ]] || { fail "$name" "$path" "log path must be absolute and plain"; return; }

  local dir="$STATE/$name" hash sf s_ino="" s_size=0
  hash="$(printf '%s' "$path" | sha256sum | cut -d' ' -f1)"
  sf="$dir/$hash.state"
  mkdir -p "$dir" || { fail "$name" "$path" "cannot create state dir"; return; }
  if [ -r "$sf" ]; then
    read -r s_ino s_size <"$sf" || true
    [[ "$s_ino" =~ ^[0-9]+$ && "$s_size" =~ ^[0-9]+$ ]] || { s_ino=""; s_size=0; }
  fi

  local out="$TMP/out.$$" err="$TMP/err.$$" lines="$TMP/lines.$$" rc
  local -a opts=(-i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes
                 -o "UserKnownHostsFile=$KNOWN_HOSTS" -o "ConnectTimeout=$CONNECT_TIMEOUT"
                 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -p "$port")
  [ -n "$jump" ] && opts+=(-J "$jump")
  local remote="sh -c $(q "$REMOTE_SCRIPT") sh $(q "$path") $s_size ${s_ino:-0} $(q "$PATTERN")"

  # shellcheck disable=SC2086
  if command -v timeout >/dev/null 2>&1; then
    timeout "$CALL_TIMEOUT" $SSH "${opts[@]}" "$user@$host" "$remote" >"$out" 2>"$err"
  else
    $SSH "${opts[@]}" "$user@$host" "$remote" >"$out" 2>"$err"
  fi
  rc=$?
  if [ "$rc" -eq 4 ]; then
    log "SKIP source=$name log=$path reason=log file missing or unreadable on the host"
    return
  fi
  if [ "$rc" -ne 0 ]; then
    local why; why="$(head -n1 "$err" | tr -cd '[:print:]' | cut -c1-160)"
    fail "$name" "$path" "ssh exit $rc${why:+ ($why)}"
    return
  fi

  local meta n_ino n_size
  meta="$(head -n1 "$out")"
  read -r n_ino n_size <<<"$meta"
  [[ "$n_ino" =~ ^[0-9]+$ && "$n_size" =~ ^[0-9]+$ ]] || { fail "$name" "$path" "unexpected first line from the host"; return; }
  tail -n +2 "$out" >"$lines"

  if [ -s "$lines" ]; then
    # shellcheck disable=SC2086
    $INGEST --tenant "$tenant" --property "$property" <"$lines" >"$TMP/ingest.out" 2>"$TMP/ingest.err"
    rc=$?
    if [ "$rc" -ne 0 ]; then
      fail "$name" "$path" "ingest exit $rc"
      return
    fi
  fi
  printf '%s %s\n' "$n_ino" "$n_size" >"$sf.tmp" && mv "$sf.tmp" "$sf" || fail "$name" "$path" "cannot write state"
}

while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  nlogs="$(jq '(.logs // []) | if type == "array" then length else 0 end' <<<"$entry")"
  if [ "$nlogs" -eq 0 ]; then
    fail "$(jq -r '.name // "?"' <<<"$entry")" "-" "no logs listed"
    continue
  fi
  while IFS= read -r path; do
    pull_one "$entry" "$path"
  done < <(jq -r '.logs[] | strings' <<<"$entry")
done <<<"$enabled"

exit "$failed"
