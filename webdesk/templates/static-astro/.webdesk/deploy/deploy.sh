#!/usr/bin/env bash
# deploy.sh - the WebDesk site deploy transport (M6-P6e). Runs in a site repo's CI deploy job.
# Docs, inputs and the limits of every control: README.md next to this file.
#
# One run = one transport (sftp | ftps), one site, one environment. Modes: deploy (default), rollback.
#   deploy:   verify the local artifact against the manifest -> take the remote lock -> upload to
#             <base>/releases/.tmp-<id> -> read EVERYTHING back and compare sha256 -> rename to
#             releases/<id> -> swap into <base>/<docroot> -> read the build stamp over HTTPS and require
#             the expected build id (else swap back) -> prune to the last N releases -> release the lock.
#   rollback: take the lock -> swap the newest older release back in -> require ITS stamp -> release.
#
# Exit codes: 0 ok | 1 unexpected | 2 refused before touching the host (config, pinning, artifact)
#             3 lock held | 4 verification refused (read-back, counts) | 5 activation failed, rolled back
#             6 build stamp mismatch, rolled back | 7 the host refused an operation (permissions, quota)
#
# SECRETS: the password arrives in DEPLOY_PASSWORD (or a key in DEPLOY_SSH_KEY), is handed to lftp only
# through its environment (never argv), is never written to a file other than a 0600 key file in a 0700
# temp dir, and every line lftp prints passes through a redactor. xtrace is refused.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$-" in *x*) echo "deploy: refusing to run with xtrace on (secrets are in scope)" >&2; exit 2 ;; esac

log() { printf '%s deploy: %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { local code="$1"; shift; printf '%s deploy: FAILED (%s): %s\n' "$(date -u +%H:%M:%S)" "$code" "$*" >&2; exit "$code"; }

# ---------------------------------------------------------------- inputs
MODE="${DEPLOY_MODE:-deploy}"
TRANSPORT="${DEPLOY_TRANSPORT:-}"
HOST="${DEPLOY_HOST:-}"
PORT="${DEPLOY_PORT:-}"
USER_="${DEPLOY_USER:-}"
SECRET="${DEPLOY_PASSWORD:-}"       # shell variable, never exported; handed to lftp per command
SSH_KEY="${DEPLOY_SSH_KEY:-}"
KNOWN_HOSTS="${DEPLOY_SFTP_KNOWN_HOSTS:-}"
FTPS_PIN="${DEPLOY_FTPS_CERT_SHA256:-}"
FTPS_CA_PEM="${DEPLOY_FTPS_CA_PEM:-}"
FTPS_CHECK_HOSTNAME="${DEPLOY_FTPS_CHECK_HOSTNAME:-yes}"
TLS_PRIORITY="${DEPLOY_FTPS_TLS_PRIORITY:-NORMAL:-VERS-SSL3.0:-VERS-TLS1.0:-VERS-TLS1.1}"
BASE="${DEPLOY_REMOTE_BASE:-}"
DOCROOT="${DEPLOY_DOCROOT:-}"
DOCROOT_PARENT="${DEPLOY_DOCROOT_PARENT:-}"   # optional: the directory that holds the docroot, when it is not BASE itself (M6-P6f, wp)
CREATE_BASE="${DEPLOY_CREATE_BASE:-no}"         # yes: create BASE (its last component only) when it does not exist
ARTIFACT="${DEPLOY_ARTIFACT_DIR:-}"
MANIFEST="${DEPLOY_MANIFEST:-}"
MANIFEST_SHA="${DEPLOY_MANIFEST_SHA256:-}"
STAMP_URL="${DEPLOY_STAMP_URL:-}"
STAMP_FILE="${DEPLOY_STAMP_FILE:-webdesk-build.json}"
STAMP_FIELD="${DEPLOY_STAMP_FIELD:-buildId}"
STAMP_CA="${DEPLOY_STAMP_CA_FILE:-}"
STAMP_TIMEOUT="${DEPLOY_STAMP_TIMEOUT:-60}"
BUILD_ID="${DEPLOY_BUILD_ID:-}"
MIN_FILES="${DEPLOY_MIN_FILES:-1}"
MIN_PAGES="${DEPLOY_MIN_PAGES:-1}"
KEEP="${DEPLOY_KEEP:-3}"
LOCK_STALE="${DEPLOY_LOCK_STALE_SECONDS:-1800}"
LOCK_WAIT="${DEPLOY_LOCK_WAIT_SECONDS:-0}"
PARALLEL="${DEPLOY_PARALLEL:-2}"
RATE_LIMIT="${DEPLOY_RATE_LIMIT:-0}"        # bytes/second per connection; 0 = unlimited
ROLLBACK_TO="${DEPLOY_ROLLBACK_TO:-}"
RELEASE_ID="${DEPLOY_RELEASE_ID:-}"
HOOK_AFTER_UPLOAD="${DEPLOY_TEST_HOOK_AFTER_UPLOAD:-}"
TEST_FAIL_ACTIVATION="${DEPLOY_TEST_FAIL_ACTIVATION:-}"
TEST_ECHO_SECRET="${DEPLOY_TEST_ECHO_SECRET:-}"
unset DEPLOY_PASSWORD DEPLOY_SSH_KEY

# ---------------------------------------------------------------- refusals (exit 2, nothing touched)
case "$MODE" in deploy | rollback) ;; *) die 2 "DEPLOY_MODE must be deploy or rollback" ;; esac
case "$TRANSPORT" in
  sftp) PORT="${PORT:-22}" ;;
  ftps) PORT="${PORT:-21}" ;;
  ftp | ftpes-plain | plain) die 2 "plain FTP is refused: this script speaks SFTP or explicit-TLS FTPS only" ;;
  "") die 2 "DEPLOY_TRANSPORT is required (sftp | ftps)" ;;
  *) die 2 "unknown DEPLOY_TRANSPORT '$TRANSPORT' (sftp | ftps)" ;;
esac
[[ "$HOST" =~ ^[A-Za-z0-9.-]+$ ]] || die 2 "DEPLOY_HOST is missing or has odd characters"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || die 2 "DEPLOY_PORT must be a number"
[[ "$USER_" =~ ^[A-Za-z0-9._@-]+$ ]] || die 2 "DEPLOY_USER is missing or has odd characters"
[[ "$BASE" =~ ^[A-Za-z0-9._/~-]+$ && "$BASE" != "/" && "$BASE" != *..* ]] || die 2 "DEPLOY_REMOTE_BASE is missing or unsafe"
BASE="${BASE%/}"
[[ "$DOCROOT" =~ ^[A-Za-z0-9._-]+$ && "$DOCROOT" != "." && "$DOCROOT" != ".." && "$DOCROOT" != "releases" && "$DOCROOT" != .* ]] \
  || die 2 "DEPLOY_DOCROOT must be a plain directory name (not releases, not hidden)"
if [ -n "$DOCROOT_PARENT" ]; then
  [[ "$DOCROOT_PARENT" =~ ^[A-Za-z0-9._/~-]+$ && "$DOCROOT_PARENT" != "/" && "$DOCROOT_PARENT" != *..* ]] || die 2 "DEPLOY_DOCROOT_PARENT is unsafe"
  DOCROOT_PARENT="${DOCROOT_PARENT%/}"
  [ "$DOCROOT_PARENT" != "$BASE/releases" ] && [ "$DOCROOT_PARENT" != "$BASE/.deploy-lock" ] || die 2 "DEPLOY_DOCROOT_PARENT must not be the releases or lock directory"
fi
[[ "$CREATE_BASE" == yes || "$CREATE_BASE" == no ]] || die 2 "DEPLOY_CREATE_BASE must be yes or no"
[[ "$KEEP" =~ ^[0-9]+$ && "$KEEP" -ge 2 ]] || die 2 "DEPLOY_KEEP must be a number >= 2 (the live release plus a rollback target)"
[[ "$LOCK_STALE" =~ ^[0-9]+$ && "$LOCK_WAIT" =~ ^[0-9]+$ && "$STAMP_TIMEOUT" =~ ^[0-9]+$ && "$PARALLEL" =~ ^[1-9][0-9]?$ ]] \
  || die 2 "a numeric option is malformed"
[[ "$RATE_LIMIT" =~ ^[0-9]+$ ]] || die 2 "DEPLOY_RATE_LIMIT must be a number"
[[ "$STAMP_FILE" =~ ^[A-Za-z0-9._/-]+$ && "$STAMP_FILE" != *..* ]] || die 2 "DEPLOY_STAMP_FILE is unsafe"
[[ "$STAMP_FIELD" =~ ^[A-Za-z0-9_]+$ ]] || die 2 "DEPLOY_STAMP_FIELD is unsafe"
[[ "$STAMP_URL" == https://* ]] || die 2 "DEPLOY_STAMP_URL must be an https:// URL (the read-back is HTTPS only)"
[[ -z "$ROLLBACK_TO" || "$ROLLBACK_TO" =~ ^[A-Za-z0-9._-]+$ ]] || die 2 "DEPLOY_ROLLBACK_TO is unsafe"
[[ "$FTPS_CHECK_HOSTNAME" == yes || "$FTPS_CHECK_HOSTNAME" == no ]] || die 2 "DEPLOY_FTPS_CHECK_HOSTNAME must be yes or no"

if [ -n "$SSH_KEY" ] && [ "$TRANSPORT" != sftp ]; then die 2 "DEPLOY_SSH_KEY only applies to sftp"; fi
if [ -z "$SECRET" ] && [ -z "$SSH_KEY" ]; then die 2 "no credential: set DEPLOY_PASSWORD (or DEPLOY_SSH_KEY for sftp)"; fi
if [ -n "$HOOK_AFTER_UPLOAD$TEST_FAIL_ACTIVATION$TEST_ECHO_SECRET" ]; then
  [ "${DEPLOY_ALLOW_TEST_HOOKS:-}" = "I-am-the-harness" ] || die 2 "test hooks are set but not allowed"
  [ "${GITHUB_ACTIONS:-}" != "true" ] || die 2 "test hooks are never honoured on a GitHub runner"
  log "WARNING: TEST HOOKS ACTIVE (harness run, not a real deploy)"
fi

if [ "$TRANSPORT" = sftp ]; then
  [ -n "$KNOWN_HOSTS" ] || die 2 "host key not pinned: DEPLOY_SFTP_KNOWN_HOSTS is empty (trust on first use is never allowed)"
else
  [ -n "$FTPS_PIN" ] || [ -n "$FTPS_CA_PEM" ] || die 2 "certificate not pinned: set DEPLOY_FTPS_CERT_SHA256 and/or DEPLOY_FTPS_CA_PEM"
  if [ -n "$FTPS_PIN" ]; then
    FTPS_PIN="$(printf '%s' "$FTPS_PIN" | tr -d ': ' | tr 'A-F' 'a-f')"
    [[ "$FTPS_PIN" =~ ^[0-9a-f]{64}$ ]] || die 2 "DEPLOY_FTPS_CERT_SHA256 is not a sha-256 fingerprint"
  fi
fi

if [ "$MODE" = deploy ]; then
  [ -d "$ARTIFACT" ] || die 2 "DEPLOY_ARTIFACT_DIR is not a directory"
  [ -f "$MANIFEST" ] || die 2 "DEPLOY_MANIFEST is not a file"
  [[ "$BUILD_ID" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die 2 "DEPLOY_BUILD_ID is required (letters, digits, . _ -)"
  [[ "$MIN_FILES" =~ ^[0-9]+$ && "$MIN_PAGES" =~ ^[0-9]+$ ]] || die 2 "DEPLOY_MIN_FILES / DEPLOY_MIN_PAGES must be numbers"
  if [ -z "$RELEASE_ID" ]; then RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-${BUILD_ID//[^A-Za-z0-9]/}"; RELEASE_ID="${RELEASE_ID:0:48}"; fi
  [[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die 2 "release id is unsafe"
fi

# ---------------------------------------------------------------- scratch space and the lftp rc file
TMP="$(mktemp -d)"
chmod 700 "$TMP"
RC="$TMP/lftp.rc"
LOCK_DIR="$BASE/.deploy-lock"
RELEASES="$BASE/releases"
LIVE_PARENT="${DOCROOT_PARENT:-$BASE}"   # where the docroot lives: BASE itself, or (a subdirectory deploy) another directory of the same host
LIVE="$LIVE_PARENT/$DOCROOT"
LOCK_HELD=0
TMP_REMOTE=""
RUN_TAG="$(printf "%s" "${GITHUB_RUN_ID:-local}" | tr -cd "A-Za-z0-9")-$$"

redact() {
  # Defence in depth: replace the literal secret wherever it shows up in lftp's output.
  REDACT_SECRET="$SECRET" awk 'BEGIN{s=ENVIRON["REDACT_SECRET"]} { if (s != "") { while ((i = index($0, s)) > 0) $0 = substr($0, 1, i-1) "[REDACTED]" substr($0, i+length(s)) } print }'
}

# rl "<lftp commands>"  - runs one lftp session. stdout in $TMP/out, stderr in $TMP/err; returns lftp's status.
rl() {
  LFTP_PASSWORD="$SECRET" lftp -c "source $RC; $1" >"$TMP/out.raw" 2>"$TMP/err.raw"
  local rc=$?
  redact <"$TMP/out.raw" >"$TMP/out"
  redact <"$TMP/err.raw" >"$TMP/err"
  rm -f "$TMP/out.raw" "$TMP/err.raw"
  return $rc
}
show_err() { sed "s/^/    host: /" "$TMP/err" 2>/dev/null | head -${1:-8} >&2; }
# names directly under a remote directory, one per line, directories with a trailing slash
# Only plain names come back: a hostile or odd file name must never reach a later lftp command line.
r_names() { rl "cls -1 -a -F $1/" || return 1; awk -F/ '{ if ($NF == "") { if (NF > 1) print $(NF-1) "/" } else print $NF }' "$TMP/out" | grep -E '^[A-Za-z0-9._-]+/?$' | grep -vxE '[.]{1,2}/?' || true; }
r_has() { r_names "$1" | grep -qxF -- "$2"; }   # r_has <dir> <name-or-name/>

epoch() { date +%s; }
now_ns() { date +%s%N; }

cleanup() {
  local rc=$?
  trap - EXIT
  if [ -n "$TMP_REMOTE" ] && [ "$LOCK_HELD" = 1 ]; then
    rl "rm -r $TMP_REMOTE" >/dev/null 2>&1 || true
  fi
  if [ "$LOCK_HELD" = 1 ]; then
    rl "rm $LOCK_DIR/owner; rmdir $LOCK_DIR" >/dev/null 2>&1 && log "lock released" || log "WARNING: could not release the remote lock; it goes stale after ${LOCK_STALE}s"
  fi
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT
trap 'log "signal received, cleaning up"; exit 143' INT TERM HUP

# ---------------------------------------------------------------- transport setup
if [ "$TRANSPORT" = sftp ]; then
  printf '%s\n' "$KNOWN_HOSTS" >"$TMP/known_hosts"
  chmod 600 "$TMP/known_hosts"
  kh_name="$HOST"; [ "$PORT" != 22 ] && kh_name="[$HOST]:$PORT"
  ssh-keygen -F "$kh_name" -f "$TMP/known_hosts" >/dev/null 2>&1 \
    || die 2 "host key not pinned: DEPLOY_SFTP_KNOWN_HOSTS has no entry for $kh_name"
  ssh_opts="-a -x -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$TMP/known_hosts -o GlobalKnownHostsFile=/dev/null -o CheckHostIP=no -o UpdateHostKeys=no -o IdentitiesOnly=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=20"
  if [ -n "$SSH_KEY" ]; then
    printf '%s\n' "$SSH_KEY" >"$TMP/key"; chmod 600 "$TMP/key"
    ssh_opts="$ssh_opts -i $TMP/key -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no"
    open_cmd="open -p $PORT -u $USER_, sftp://$HOST"
  else
    ssh_opts="$ssh_opts -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive"
    open_cmd="open -p $PORT -u $USER_ --env-password sftp://$HOST"
  fi
  unset SSH_KEY
  proto_cfg="set sftp:connect-program \"ssh $ssh_opts\"
set sftp:auto-confirm no"
else
  # Explicit TLS only: AUTH TLS is forced for the control channel, the data channel and listings.
  ca_cfg=""
  if [ -n "$FTPS_CA_PEM" ]; then printf '%s\n' "$FTPS_CA_PEM" >"$TMP/ca.pem"; ca_cfg="set ssl:ca-file $TMP/ca.pem"; fi
  proto_cfg="set ftp:ssl-allow yes
set ftp:ssl-force yes
set ftp:ssl-auth TLS
set ftp:ssl-protect-data yes
set ftp:ssl-protect-list yes
set ftp:passive-mode yes
set ftp:list-options -a
set ssl:verify-certificate yes
set ssl:check-hostname $FTPS_CHECK_HOSTNAME
set ssl:priority $TLS_PRIORITY
$ca_cfg"
  open_cmd="open -p $PORT -u $USER_ --env-password ftp://$HOST"
fi
cat >"$RC" <<RCEOF
set cmd:fail-exit yes
set cmd:verify-path no
set cache:enable no
set net:max-retries 2
set net:persist-retries 0
set net:reconnect-interval-base 3
set net:timeout 25
set net:limit-rate 0:$RATE_LIMIT
set xfer:clobber yes
set mirror:parallel-transfer-count $PARALLEL
$proto_cfg
$open_cmd
RCEOF
export DEPLOY_LFTP_RC="$RC"   # for the harness hook only; holds no secret

if [ "$TRANSPORT" = ftps ] && [ -n "$FTPS_PIN" ]; then
  seen="$(timeout 30 openssl s_client -starttls ftp -connect "$HOST:$PORT" -servername "$HOST" </dev/null 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256 2>/dev/null | sed 's/.*=//' | tr -d ':' | tr 'A-F' 'a-f')"
  [ -n "$seen" ] || die 2 "FTPS: could not read the server certificate for the pin check"
  [ "$seen" = "$FTPS_PIN" ] || die 2 "FTPS certificate does not match the pinned fingerprint (server presented sha256 $seen)"
  log "FTPS certificate matches the pinned fingerprint"
fi

# ---------------------------------------------------------------- local artifact checks (deploy)
if [ "$MODE" = deploy ]; then
  if [ -n "$MANIFEST_SHA" ]; then
    [ "$(sha256sum "$MANIFEST" | cut -c1-64)" = "$MANIFEST_SHA" ] || die 2 "the manifest does not match DEPLOY_MANIFEST_SHA256"
  fi
  "$HERE/make-manifest.sh" "$ARTIFACT" >"$TMP/local.manifest" 2>"$TMP/mm.err" || { cat "$TMP/mm.err" >&2; die 2 "the artifact tree is not uploadable"; }
  TAB=$'\t'
  LC_ALL=C sort -t "$TAB" -k3,3 "$MANIFEST" >"$TMP/expected.manifest"
  LC_ALL=C sort -t "$TAB" -k3,3 "$TMP/local.manifest" -o "$TMP/local.manifest"
  if ! cmp -s "$TMP/expected.manifest" "$TMP/local.manifest"; then
    diff <(cut -f3 "$TMP/expected.manifest") <(cut -f3 "$TMP/local.manifest") | head -10 >&2 || true
    die 2 "the artifact on disk does not match its manifest (a file differs, is missing or is extra); nothing uploaded"
  fi
  nfiles="$(wc -l <"$TMP/expected.manifest" | tr -d ' ')"
  npages="$(cut -f3 "$TMP/expected.manifest" | grep -ciE '\.html?$' || true)"
  [ "$nfiles" -ge "$MIN_FILES" ] || die 2 "the artifact has $nfiles files; the minimum is $MIN_FILES"
  [ "$npages" -ge "$MIN_PAGES" ] || die 2 "the artifact has $npages pages; the minimum is $MIN_PAGES"
  [ -f "$ARTIFACT/$STAMP_FILE" ] || die 2 "the artifact has no $STAMP_FILE (the build stamp the read-back needs)"
  [ "$(jq -r --arg f "$STAMP_FIELD" '.[$f] // empty' "$ARTIFACT/$STAMP_FILE" 2>/dev/null)" = "$BUILD_ID" ] \
    || die 2 "the stamp inside the artifact does not carry build id $BUILD_ID in .$STAMP_FIELD"
  log "artifact ok: $nfiles files, $npages pages, build $BUILD_ID, release $RELEASE_ID"
fi

# ---------------------------------------------------------------- remote primitives
classify_failure() { # after a failed rl: a refusal by the host, not a bug of ours
  show_err 6
  die 7 "$1 (the host refused it; its message is above)"
}

# r_read <remote file>: the file lands in $TMP/read (lftp "cat" hangs on a missing file, so we use get)
r_read() { rm -f "$TMP/read"; rl "get $1 -o $TMP/read"; }
read_live_id() { if r_read "$LIVE/.webdesk-release"; then head -1 "$TMP/read" | tr -cd 'A-Za-z0-9._-'; fi; return 0; }

stamp_read() { # echoes the build id the site serves, empty on any failure
  local extra=() body
  [ -n "$STAMP_CA" ] && extra=(--cacert "$STAMP_CA")
  body="$(curl -sS --fail --proto =https --proto-redir =https --max-redirs 3 --tlsv1.2 --max-time 10 \
    -H 'Cache-Control: no-cache' "${extra[@]}" "${STAMP_URL}?t=$(now_ns)" 2>"$TMP/curl.err")" || return 1
  printf '%s' "$body" | jq -r --arg f "$STAMP_FIELD" '.[$f] // empty' 2>/dev/null
}
stamp_wait() { # stamp_wait <expected id>: poll until the site serves it or the timeout
  local want="$1" t0 got; t0="$(epoch)"
  while :; do
    got="$(stamp_read || true)"
    if [ "$got" = "$want" ]; then return 0; fi
    [ $(( $(epoch) - t0 )) -ge "$STAMP_TIMEOUT" ] && { log "stamp read-back: wanted '$want', the site served '${got:-nothing}'"; return 1; }
    sleep 2
  done
}

connect_check() {
  # The first session: it proves the pinned identity, then the login. Identity failures are refusals (2).
  if rl "cls -1 $BASE/"; then return 0; fi   # a real listing: lftp connects lazily, so pwd would prove nothing
  if grep -qiE 'host key verification failed|certificate|not trusted|does not support or allow SSL|ssl:|gnutls|unexpected TLS' "$TMP/err" "$TMP/out"; then
    show_err 6
    die 2 "the host's identity does not match the pin (host key or certificate); nothing was sent"
  fi
  # A subdirectory deploy (wp) owns a directory of its own beside the docroot's parent; the first run creates it, and only it.
  if [ "$CREATE_BASE" = yes ] && grep -qiE 'no such file|not found|does not exist|550' "$TMP/err" "$TMP/out"; then
    log "the base directory $BASE does not exist; creating it (DEPLOY_CREATE_BASE=yes, its last component only)"
    if rl "mkdir $BASE" && rl "cls -1 $BASE/"; then return 0; fi
  fi
  show_err 6
  die 7 "could not log in or list the base directory $BASE (the host's message is above)"
}

lock_acquire() {
  local t0 owner age epoch_owner
  t0="$(epoch)"
  connect_check
  r_has "$BASE" "releases/" || rl "mkdir $RELEASES" || classify_failure "cannot create $RELEASES"
  while :; do
    if rl "mkdir $LOCK_DIR"; then
      rl "put $TMP/owner.txt -o $LOCK_DIR/owner" || log "WARNING: could not write the lock owner file (the lock still holds)"
      LOCK_HELD=1
      log "lock taken ($LOCK_DIR)"
      return 0
    fi
    # mkdir failed: either the lock exists (held) or the host refused. Tell them apart by looking.
    if ! r_has "$BASE" ".deploy-lock/"; then classify_failure "cannot take the lock"; fi
    owner=""; age=""
    if r_read "$LOCK_DIR/owner"; then owner="$(head -1 "$TMP/read" | tr -cd 'A-Za-z0-9._= -')"; fi
    epoch_owner="$(printf '%s' "$owner" | sed -n 's/.*epoch=\([0-9]\{1,12\}\).*/\1/p')"
    if [ -z "$epoch_owner" ] && rl "cls -l --time-style=%s -d $LOCK_DIR/"; then epoch_owner="$(awk '{print $6; exit}' "$TMP/out" | grep -E '^[0-9]+$' || true)"; fi
    [ -n "$epoch_owner" ] && age=$(( $(epoch) - epoch_owner ))
    if [ -n "$age" ] && [ "$age" -ge "$LOCK_STALE" ]; then
      log "lock is stale (${age}s old, limit ${LOCK_STALE}s; holder: ${owner:-unknown}); breaking it"
      if rl "mv $LOCK_DIR $BASE/.deploy-lock.stale-$RUN_TAG"; then
        rl "rm -r $BASE/.deploy-lock.stale-$RUN_TAG" >/dev/null 2>&1 || true
      fi
      continue
    fi
    if [ $(( $(epoch) - t0 )) -ge "$LOCK_WAIT" ]; then
      die 3 "another deploy holds the lock (holder: ${owner:-unknown}, age: ${age:-unknown}s, stale after ${LOCK_STALE}s)"
    fi
    sleep 5
  done
}

# swap_in <release dir name under releases/> <name to give the displaced live dir>
# Two renames in ONE lftp session: live -> releases/<park>, releases/<target> -> live; if the second
# fails the first is undone in the same session. Sets WINDOW_MS (upper bound of the gap between them).
swap_in() {
  local target="$1" park="$2" src="$RELEASES/$1" win_ms
  if [ -n "$TEST_FAIL_ACTIVATION" ] && [ "$MODE" = deploy ] && [ "$target" = "${RELEASE_ID:-}" ]; then src="$RELEASES/.does-not-exist"; fi
  if ! r_has "$LIVE_PARENT" "$DOCROOT/"; then
    rl "mv $src $LIVE" || return 1          # nothing is being served yet, so there is no window to lose
    WINDOW_MS=0
    return 0
  fi
  rm -f "$TMP/t0" "$TMP/t1"
  # lftp's `!cmd` takes the rest of its line, so each local timestamp command gets a line of its own.
  rl "cls -1 $BASE/ > /dev/null
!date +%s%N > $TMP/t0
mv $LIVE $RELEASES/$park && (mv $src $LIVE || mv $RELEASES/$park $LIVE)
!date +%s%N > $TMP/t1" \
    || {
      show_err 4
      # The one state that must never persist: no docroot. If the session died between the two renames, undo the first now.
      if ! r_has "$LIVE_PARENT" "$DOCROOT/" && r_has "$RELEASES" "$park/"; then
        log "docroot is MISSING after a failed swap; restoring $park"
        rl "mv $RELEASES/$park $LIVE" || log "CRITICAL: could not restore the docroot; run: mv $RELEASES/$park $LIVE"
      fi
      return 1
    }
  if [ -s "$TMP/t0" ] && [ -s "$TMP/t1" ]; then WINDOW_MS=$(( ($(cat "$TMP/t1") - $(cat "$TMP/t0")) / 1000000 )); else WINDOW_MS=-1; fi
  # The compound command exits 0 even when it undid itself, so ask the host who is live now.
  [ "$(read_live_id)" = "$target" ] || return 1
  return 0
}

prune_old() {
  local names keep_n=$(( KEEP - 1 )) n=0 name
  names="$(r_names "$RELEASES" | grep -v '^\.' | sed 's|/$||' | LC_ALL=C sort -r)" || return 0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    n=$(( n + 1 ))
    if [ "$n" -gt "$keep_n" ]; then
      log "pruning old release $name"
      rl "rm -r $RELEASES/$name" || log "WARNING: could not prune $name"
    fi
  done <<<"$names"
}

# ---------------------------------------------------------------- the run
printf 'epoch=%s run=%s mode=%s release=%s\n' "$(epoch)" "$RUN_TAG" "$MODE" "${RELEASE_ID:-n/a}" >"$TMP/owner.txt"
log "mode=$MODE transport=$TRANSPORT host=$HOST user=$USER_ base=$BASE docroot=$DOCROOT"

lock_acquire

# A run killed between the two renames leaves no docroot. We hold the lock, so nobody is mid-swap: put the newest release back.
if ! r_has "$LIVE_PARENT" "$DOCROOT/"; then
  newest="$(r_names "$RELEASES" | grep -v '^\.' | sed 's|/$||' | LC_ALL=C sort -r | head -1)"
  if [ -n "$newest" ]; then
    log "WARNING: the docroot is missing (an earlier run died between its two renames); restoring release $newest"
    rl "mv $RELEASES/$newest $LIVE" || classify_failure "cannot restore the docroot"
  fi
fi

if [ -n "$TEST_ECHO_SECRET" ]; then   # harness only: make lftp itself print the secret, to prove the redactor catches it
  rl '!echo "leak-test: $LFTP_PASSWORD"' && cat "$TMP/out"
fi

if [ "$MODE" = rollback ]; then
  live_id="$(read_live_id)"; [ -n "$live_id" ] || live_id="0000-legacy-$(epoch)"
  if [ -n "$ROLLBACK_TO" ]; then target="$ROLLBACK_TO"
  else target="$(r_names "$RELEASES" | grep -v '^\.' | sed 's|/$||' | LC_ALL=C sort -r | head -1)"; fi
  [ -n "$target" ] || die 4 "rollback: there is no older release to go back to"
  r_has "$RELEASES" "$target/" || die 4 "rollback: no such release '$target'"
  r_read "$RELEASES/$target/$STAMP_FILE" || die 4 "rollback: release $target has no $STAMP_FILE to prove itself with"
  want="$(jq -r --arg f "$STAMP_FIELD" '.[$f] // empty' "$TMP/read" 2>/dev/null)"
  [ -n "$want" ] || die 4 "rollback: the stamp of release $target has no .$STAMP_FIELD"
  log "rollback: live=$live_id -> $target (build $want)"
  swap_in "$target" "$live_id" || die 5 "rollback: the swap failed and was undone; the previous release still serves"
  log "rollback: activated $target, window <= ${WINDOW_MS} ms"
  if ! stamp_wait "$want"; then
    log "rollback: the stamp does not show build $want; swapping back"
    swap_in "$live_id" "$target" || die 5 "rollback verification failed AND the swap back failed; check the docroot by hand"
    die 6 "rollback: the stamp did not show build $want; the previous release is live again"
  fi
  log "ROLLBACK OK release=$target build=$want window_ms<=${WINDOW_MS}"
  exit 0
fi

# ---- deploy
r_has "$RELEASES" "$RELEASE_ID/" && die 4 "release $RELEASE_ID already exists on the host"
# Anything named .tmp-* under releases/ is an upload some earlier run never finished; we hold the lock, so it is orphaned.
for orphan in $(r_names "$RELEASES" | grep '^\.tmp-' | sed 's|/$||'); do
  log "removing the orphaned partial upload $orphan"
  rl "rm -r $RELEASES/$orphan" || log "WARNING: could not remove $orphan"
done

TMP_REMOTE="$RELEASES/.tmp-$RELEASE_ID"
t_up="$(epoch)"
log "uploading $nfiles files to ${TMP_REMOTE#$BASE/}"
rl "mirror -R --no-perms --no-umask --parallel=$PARALLEL --verbose=0 $ARTIFACT $TMP_REMOTE" \
  || classify_failure "the upload failed"
printf '%s\n' "$RELEASE_ID" >"$TMP/marker"
rl "put $TMP/marker -o $TMP_REMOTE/.webdesk-release" || classify_failure "could not write the release marker"
log "upload done in $(( $(epoch) - t_up ))s"

if [ -n "$HOOK_AFTER_UPLOAD" ]; then
  log "TEST HOOK after upload"
  LFTP_PASSWORD="$SECRET" DEPLOY_REMOTE_RELEASE="$TMP_REMOTE" bash -c "$HOOK_AFTER_UPLOAD" || die 1 "the test hook failed"
fi

# Read EVERYTHING back and compare sha256: a size check would not see a flipped byte.
mkdir -p "$TMP/rb"
t_rb="$(epoch)"
rl "mirror --no-perms --parallel=$PARALLEL --verbose=0 $TMP_REMOTE $TMP/rb" || classify_failure "the read-back failed"
if [ "$(tr -d '\r\n' <"$TMP/rb/.webdesk-release" 2>/dev/null)" != "$RELEASE_ID" ]; then die 4 "read-back: the release marker is wrong or missing"; fi
rm -f "$TMP/rb/.webdesk-release"
"$HERE/make-manifest.sh" "$TMP/rb" >"$TMP/remote.manifest" 2>"$TMP/mm.err" || { cat "$TMP/mm.err" >&2; die 4 "read-back: the host's tree is not a plain file tree"; }
LC_ALL=C sort -t "$TAB" -k3,3 "$TMP/remote.manifest" -o "$TMP/remote.manifest"
if ! cmp -s "$TMP/expected.manifest" "$TMP/remote.manifest"; then
  log "read-back MISMATCH against the manifest (paths only, never contents):"
  diff "$TMP/expected.manifest" "$TMP/remote.manifest" | grep '^[<>]' | cut -f3 | sort -u | head -10 | sed 's/^/    /' >&2
  die 4 "the uploaded tree does not match the manifest byte for byte; activation refused, the previous release still serves"
fi
log "read-back verified: $nfiles files, sha256 matched, in $(( $(epoch) - t_rb ))s"

rl "mv $TMP_REMOTE $RELEASES/$RELEASE_ID" || classify_failure "could not finalise the release directory"
TMP_REMOTE=""

live_id="$(read_live_id)"
if r_has "$LIVE_PARENT" "$DOCROOT/"; then
  [ -n "$live_id" ] || live_id="0000-legacy-$(epoch)"
  if r_has "$RELEASES" "$live_id/"; then live_id="$live_id.dup$(epoch)"; fi
else
  live_id=""
fi
log "activating $RELEASE_ID (displaced: ${live_id:-nothing, first deploy})"
if ! swap_in "$RELEASE_ID" "${live_id:-x}"; then
  rl "rm -r $RELEASES/$RELEASE_ID" >/dev/null 2>&1 || true
  die 5 "activation failed; the first rename was undone, the previous release still serves"
fi
log "activated: docroot swap window <= ${WINDOW_MS} ms"

if ! stamp_wait "$BUILD_ID"; then
  if [ -n "$live_id" ]; then
    log "the stamp does not show build $BUILD_ID; rolling back to $live_id"
    if swap_in "$live_id" "$RELEASE_ID.failed"; then
      rl "rm -r $RELEASES/$RELEASE_ID.failed" >/dev/null 2>&1 || true
      die 6 "the stamp did not show build $BUILD_ID; rolled back to $live_id"
    fi
    die 6 "the stamp did not show build $BUILD_ID AND the rollback failed; check the docroot by hand"
  fi
  die 6 "the stamp did not show build $BUILD_ID and there is no previous release to roll back to"
fi
log "stamp read-back ok: the site serves build $BUILD_ID"

prune_old
log "DEPLOY OK release=$RELEASE_ID build=$BUILD_ID window_ms<=${WINDOW_MS}"
exit 0
