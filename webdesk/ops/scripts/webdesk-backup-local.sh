#!/bin/sh
# WSK-28 / WSK-52 -- local Zone B backup: PG dump + object-storage mirror into the versioned/
# object-locked `backups` bucket (RustFS, WSK-D42). See ../../infra/runbooks/webdesk-zoneb-backups.md
# section 2 for the full design.
#
# This is the LOCAL half only. It never talks to the offsite target -- Zone B holds no
# credential for that target and this script does not either (see the runbook section 1 for why).
#
# WSK-52: RustFS ships no `mc`, and this script needs no other S3 client either: it uses `curl`
# (--aws-sigv4, curl >= 7.75) plus `sha256sum`, both already on the host. The bucket itself
# (object lock, versioning, GOVERNANCE default retention) is created by
# webdesk/scripts/storage-bootstrap.mjs, and this script authenticates with the dedicated
# backup-writer key that script creates (put/get/list on the backups bucket ONLY) -- never root.
#
# Install (nightly, before the offsite pull job runs on the target):
#   0 2 * * * WEBDESK_BACKUP_DIR=/var/lib/webdesk-backups \
#     OWNER_DATABASE_URL=... STORAGE_ENDPOINT=... \
#     WEBDESK_BACKUP_ACCESS_KEY_ID=... WEBDESK_BACKUP_SECRET_ACCESS_KEY=... \
#     /path/to/webdesk/ops/scripts/webdesk-backup-local.sh >> /var/log/webdesk-backup.log 2>&1
set -eu

BACKUP_DIR="${WEBDESK_BACKUP_DIR:-/var/lib/webdesk-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
SENTINEL_FILE="${WEBDESK_BACKUP_SENTINEL_FILE:-$BACKUP_DIR/.last-run}"
STORAGE_REGION="${STORAGE_REGION:-us-east-1}"
BACKUP_BUCKET="${WEBDESK_BACKUP_BUCKET:-backups}"

mkdir -p "$BACKUP_DIR/pg"

fail() {
  echo "backup FAILED: $1" >&2
  echo "exit_code=1 finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SENTINEL_FILE"
  exit 1
}

# --- 1. Postgres dump (Zone B's OWN database, via the owner role -- never the app runtime role,
# same discipline as the estate's infra/scripts/backup.sh) ---------------------------------------
: "${OWNER_DATABASE_URL:?OWNER_DATABASE_URL must be set (webdesk_owner connection string)}"
PG_OUT="$BACKUP_DIR/pg/webdesk-$STAMP.sql.gz"
# Dump to a temp file first: in a `pg_dump | gzip` pipeline POSIX sh reports only gzip's exit status,
# so a failed pg_dump would still produce a valid (empty) .gz, be mirrored and recorded as success.
PG_RAW="$PG_OUT.tmp"
pg_dump "$OWNER_DATABASE_URL" > "$PG_RAW" || { rm -f "$PG_RAW"; fail "pg_dump failed"; }
gzip -c "$PG_RAW" > "$PG_OUT" || { rm -f "$PG_RAW" "$PG_OUT"; fail "gzip failed"; }
rm -f "$PG_RAW"
echo "backup ok: $PG_OUT"

# Prune local uncompressed copies older than KEEP_DAYS -- the versioned/locked bucket copy (below)
# is the durable record; local disk is a staging area, not the archive.
KEEP_DAYS="${WEBDESK_BACKUP_KEEP_DAYS:-7}"
find "$BACKUP_DIR/pg" -name '*.sql.gz' -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true

# --- 2. Mirror into the local versioned/object-locked backups bucket -----------------------------
: "${STORAGE_ENDPOINT:?STORAGE_ENDPOINT must be set}"
: "${WEBDESK_BACKUP_ACCESS_KEY_ID:?WEBDESK_BACKUP_ACCESS_KEY_ID must be set (backup-writer key from storage-bootstrap.mjs)}"
: "${WEBDESK_BACKUP_SECRET_ACCESS_KEY:?WEBDESK_BACKUP_SECRET_ACCESS_KEY must be set}"

command -v curl >/dev/null 2>&1 || fail "curl not found on PATH"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum not found on PATH"

s3curl() {
  curl -sS -f --aws-sigv4 "aws:amz:$STORAGE_REGION:s3" \
    --user "$WEBDESK_BACKUP_ACCESS_KEY_ID:$WEBDESK_BACKUP_SECRET_ACCESS_KEY" "$@"
}

BASE="${STORAGE_ENDPOINT%/}/$BACKUP_BUCKET"
OBJ_KEY="pg/$(basename "$PG_OUT")"

# The bucket must already exist (storage-bootstrap.mjs creates it with object lock -- lock can only
# be enabled at creation, see the runbook section 2). HEAD it so a missing bootstrap fails loudly here.
s3curl -I -o /dev/null "$BASE" || fail "backups bucket not reachable at $BASE (run webdesk/scripts/storage-bootstrap.mjs)"

PG_SHA="$(sha256sum "$PG_OUT" | cut -d' ' -f1)"
PG_SIZE="$(wc -c < "$PG_OUT" | tr -d ' ')"
s3curl -o /dev/null -H "x-amz-content-sha256: $PG_SHA" -H "Content-Type: application/gzip" \
  -T "$PG_OUT" "$BASE/$OBJ_KEY" || fail "upload to $BASE/$OBJ_KEY failed"

# Verify the object really landed with the right size -- an exit-0 upload is not proof.
REMOTE_SIZE="$(s3curl -I "$BASE/$OBJ_KEY" | tr -d '\r' | awk 'tolower($1)=="content-length:" {print $2}')"
[ "$REMOTE_SIZE" = "$PG_SIZE" ] || fail "uploaded object size mismatch (local $PG_SIZE, remote ${REMOTE_SIZE:-none})"
echo "mirrored ok: $BACKUP_BUCKET/$OBJ_KEY ($PG_SIZE bytes)"

echo "exit_code=0 finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ) file=$PG_OUT" > "$SENTINEL_FILE"
echo "backup complete"
