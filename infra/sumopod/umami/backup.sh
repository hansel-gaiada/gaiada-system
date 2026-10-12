#!/usr/bin/env bash
# M5-A3 / WSK-D66 -- nightly Umami Postgres backup on sumopod, with an OFF-BOX copy.
# Zoning rule (2026-08-31): nothing on sumopod may be the only copy. So every dump is
#   pg_dump -> verified -> age-encrypted (to the SAME recipient as the ERP offsite set) -> pushed to gda-aicenter.
# sumopod cannot decrypt these files. The private key lives only where erp-offsite-backup.md says it does.
#
# Plaintext never touches sumopod's disk: scratch space is /dev/shm (RAM), 0700, removed on exit.
# A push that fails leaves the encrypted file locally WITHOUT a `.pushed` marker; the next run retries it.
#
# The collector's `vdb` is dumped too (vdb-<stamp>.sql.gz.age) WITHOUT the data of its personal-data tables.
#
# Exit 0 = a verified dump was written AND every pending file is off the box. Non-zero otherwise (the reason
# is on stderr), including an empty or table-less dump.
#
# Env (all optional):
#   UMAMI_DB_CONTAINER  default umami-db-1
#   VDB_CONTAINER       default umami-vdb-1   (the collector's database)
#   VDB_BACKUP          default 1; 0 skips vdb (only while the collector is not deployed); anything else refuses
#   UMAMI_BACKUP_DIR    default $HOME/umami-backup/data
#   AGE_RECIPIENT_FILE  default $HOME/erp-offsite/recipient.pub
#   OFFBOX_TARGET       default Hansel@10.88.0.1   (gda-aicenter over wg0)
#   OFFBOX_KEY          default $HOME/.ssh/umami_push_ed25519
#   KEEP_LOCAL_DAYS     default 7
#   TEXTFILE_DIR        default /var/lib/node_exporter/textfile (metrics are best-effort)
set -euo pipefail
umask 077

CONTAINER="${UMAMI_DB_CONTAINER:-umami-db-1}"
VDB_CONTAINER="${VDB_CONTAINER:-umami-vdb-1}"
VDB_BACKUP="${VDB_BACKUP:-1}"
DIR="${UMAMI_BACKUP_DIR:-$HOME/umami-backup/data}"
RECIPIENT="${AGE_RECIPIENT_FILE:-$HOME/erp-offsite/recipient.pub}"
TARGET="${OFFBOX_TARGET:-Hansel@10.88.0.1}"
KEY="${OFFBOX_KEY:-$HOME/.ssh/umami_push_ed25519}"
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS:-7}"
TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/node_exporter/textfile}"
MIN_FREE_KB=$((5 * 1024 * 1024))   # refuse to run with < 5 GB free: sumopod's disk moves fast

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log() { printf '%s umami-backup %s\n' "$(ts)" "$*"; }

metrics() { # $1 = 1 ok / 0 failed ; best-effort node_exporter textfile
  [ -d "$TEXTFILE_DIR" ] && [ -w "$TEXTFILE_DIR" ] || return 0
  {
    if [ "$1" = 1 ]; then echo "umami_backup_last_success_timestamp_seconds $(date +%s)"; fi
    echo "umami_backup_last_run_ok $1"
  } > "$TEXTFILE_DIR/umami_backup.prom.$$" 2> /dev/null && mv "$TEXTFILE_DIR/umami_backup.prom.$$" "$TEXTFILE_DIR/umami_backup.prom"
}
fail() { printf '%s umami-backup FAILED: %s\n' "$(ts)" "$*" >&2; metrics 0 || true; exit 1; }

case "$VDB_BACKUP" in 0 | 1) ;; *) fail "VDB_BACKUP must be 0 or 1" ;; esac
case "$KEEP_LOCAL_DAYS" in '' | *[!0-9]*) fail "KEEP_LOCAL_DAYS is not a whole number" ;; esac
command -v age > /dev/null || fail "age is not installed"
[ -r "$RECIPIENT" ] || fail "age recipient file $RECIPIENT is missing"
[ -r "$KEY" ] || fail "push key $KEY is missing"
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || fail "container $CONTAINER is not running"
mkdir -p "$DIR"
FREE_KB="$(df -Pk "$DIR" | awk 'NR==2 {print $4}')"
[ "$FREE_KB" -gt "$MIN_FREE_KB" ] || fail "only ${FREE_KB} KB free on $DIR (need > $MIN_FREE_KB)"

WORK="$(mktemp -d /dev/shm/umami-backup.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

STAMP="$(date -u '+%Y%m%d-%H%M%S')"

# gz_encrypt_publish <prefix> -- $WORK/dump.sql (already verified) -> gzip -> age -> $DIR/<prefix>-<stamp>.sql.gz.age
gz_encrypt_publish() {
  local NAME="$1-$STAMP.sql.gz.age"
  # gzip, test, encrypt (age output is a file; its exit status is checked directly).
  gzip -c "$WORK/dump.sql" > "$WORK/dump.sql.gz" || fail "gzip failed ($1)"
  gzip -t "$WORK/dump.sql.gz" || fail "gzip -t rejected the dump ($1)"
  age -R "$RECIPIENT" -o "$WORK/out.age" "$WORK/dump.sql.gz" || fail "age encryption failed ($1)"
  [ -s "$WORK/out.age" ] || fail "encrypted file is empty ($1)"
  # Publish locally (atomic rename, same filesystem) with its sha256.
  cp "$WORK/out.age" "$DIR/.$NAME.tmp" && mv "$DIR/.$NAME.tmp" "$DIR/$NAME"
  ( cd "$DIR" && sha256sum "$NAME" > "$NAME.sha256" )
  rm -f "$WORK/dump.sql" "$WORK/dump.sql.gz" "$WORK/out.age"
  log "dump ok file=$DIR/$NAME bytes=$(wc -c < "$DIR/$NAME" | tr -d ' ')"
}

# ---- 1. Umami's database ----------------------------------------------------------------------------------
# Plain pg_dump to a file (never `pg_dump | gzip`: this exit status must be pg_dump's own).
docker exec "$CONTAINER" pg_dump -U umami -d umami --no-owner > "$WORK/dump.sql" 2> "$WORK/err" \
  || fail "pg_dump failed: $(tr '\n' ' ' < "$WORK/err" | cut -c1-300)"
[ -s "$WORK/dump.sql" ] || fail "pg_dump exited 0 but wrote nothing"

# 2. Verify the content BEFORE publishing: real Umami tables, and the admin user row exists.
for T in '"user"' website session website_event; do
  grep -q "^CREATE TABLE public\.$T " "$WORK/dump.sql" || fail "dump has no CREATE TABLE public.$T -- wrong database or a broken dump"
done
USERS="$(awk '/^COPY public\."user" /{c=1; next} c && $0=="\\."{c=0} c{n++} END{print n+0}' "$WORK/dump.sql")"
[ "$USERS" -gt 0 ] || fail "dump has ZERO rows in public.\"user\" -- not a seeded Umami database"
log "umami dump verified user_rows=$USERS"
gz_encrypt_publish umami

# ---- 1b. vdb (the collector's database; M5-V2-c, design 6.2 + O2) -------------------------------------------
# Deliberately NOT backed up: the DATA of consented_events (72 h buffer, V3-b), replay_sessions and replay_chunks
# (30-day recordings, V6-a). A backup would outlive their retention promise, and losing them stops no company
# function (O2: nothing on sumopod is the only copy, EXCEPT these). They are excluded by --exclude-table-data, so
# the schema is still dumped (a restore gets empty tables) and the names may not exist yet (pg_dump does not
# error on a pattern that matches nothing, since we do not pass --strict-names). What IS backed up is bot_counts
# (aggregate) and tombstones (SHA-256 hashes only: they are what stops a forgotten visitor coming back after a restore).
if [ "$VDB_BACKUP" = 1 ]; then
  docker ps --format '{{.Names}}' | grep -qx "$VDB_CONTAINER" || fail "container $VDB_CONTAINER is not running (set VDB_BACKUP=0 only if the collector is not deployed)"
  docker exec "$VDB_CONTAINER" pg_dump -U vdb -d vdb --no-owner \
    --exclude-table-data=consented_events --exclude-table-data=replay_sessions --exclude-table-data=replay_chunks \
    > "$WORK/dump.sql" 2> "$WORK/err" \
    || fail "vdb pg_dump failed: $(tr '\n' ' ' < "$WORK/err" | cut -c1-300)"
  [ -s "$WORK/dump.sql" ] || fail "vdb pg_dump exited 0 but wrote nothing"
  for T in bot_counts tombstones; do
    grep -q "^CREATE TABLE public\.$T " "$WORK/dump.sql" || fail "vdb dump has no CREATE TABLE public.$T -- wrong database or a broken dump"
  done
  # The guard that matters: personal-data tables must carry no data in the dump.
  if grep -qE '^COPY public\.(consented_events|replay_sessions|replay_chunks) ' "$WORK/dump.sql"; then
    fail "vdb dump contains a COPY block for a personal-data table (consented_events / replay_*) -- refusing to publish"
  fi
  gz_encrypt_publish vdb
else
  log "vdb backup skipped (VDB_BACKUP=0)"
fi

# 5. Push EVERY file (umami-* and vdb-*) without a .pushed marker (retries earlier failures). The receiver on aicenter is a
#    forced command that verifies the hash and refuses to overwrite (see umami-backup-receive.sh).
PUSHED=0; PENDING=0
for F in "$DIR"/umami-*.sql.gz.age "$DIR"/vdb-*.sql.gz.age; do
  [ -f "$F" ] || continue
  B="$(basename "$F")"
  [ -f "$DIR/$B.pushed" ] && continue
  PENDING=$((PENDING + 1))
  SUM="$(cut -d' ' -f1 "$DIR/$B.sha256")"
  if ssh -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 "$TARGET" "put $B $SUM" < "$F"; then
    date -u +%s > "$DIR/$B.pushed"; PUSHED=$((PUSHED + 1))
  else
    printf '%s umami-backup push FAILED for %s (will retry next run)\n' "$(ts)" "$B" >&2
  fi
done

# 6. Local retention: only files already pushed are ever pruned. Unpushed ones stay until they are off the box.
find "$DIR" -maxdepth 1 -type f \( -name 'umami-*.sql.gz.age' -o -name 'vdb-*.sql.gz.age' \) -mtime "+$KEEP_LOCAL_DAYS" | while read -r OLD; do
  if [ -f "$OLD.pushed" ]; then rm -f "$OLD" "$OLD.sha256" "$OLD.pushed"; fi
done

if [ "$PUSHED" -ne "$PENDING" ]; then
  fail "off-box copy incomplete: pushed $PUSHED of $PENDING pending file(s)"
fi
metrics 1
log "ok pushed=$PUSHED"
