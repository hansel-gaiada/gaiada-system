#!/bin/sh
# WSK-28 -- local Zone B backup: PG dump + MinIO mirror into the versioned/object-locked
# `backups` bucket. See ../../infra/runbooks/webdesk-zoneb-backups.md §2 for the full design.
#
# This is the LOCAL half only. It never talks to the offsite target -- Zone B holds no
# credential for that target and this script does not either (see the runbook §1 for why).
#
# Install (nightly, before the offsite pull job runs on the target):
#   0 2 * * * WEBDESK_BACKUP_DIR=/var/lib/webdesk-backups \
#     APP_DATABASE_URL=... MINIO_ROOT_USER=... MINIO_ROOT_PASSWORD=... MINIO_ENDPOINT=... \
#     /path/to/webdesk/ops/scripts/webdesk-backup-local.sh >> /var/log/webdesk-backup.log 2>&1
set -eu

BACKUP_DIR="${WEBDESK_BACKUP_DIR:-/var/lib/webdesk-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
SENTINEL_FILE="${WEBDESK_BACKUP_SENTINEL_FILE:-$BACKUP_DIR/.last-run}"
MINIO_ALIAS="${WEBDESK_MC_ALIAS:-webdesk}"
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
pg_dump "$OWNER_DATABASE_URL" | gzip > "$PG_OUT" || fail "pg_dump failed"
echo "backup ok: $PG_OUT"

# Prune local uncompressed copies older than KEEP_DAYS -- the versioned/locked bucket copy (below)
# is the durable record; local disk is a staging area, not the archive.
KEEP_DAYS="${WEBDESK_BACKUP_KEEP_DAYS:-7}"
find "$BACKUP_DIR/pg" -name '*.sql.gz' -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true

# --- 2. Mirror into the local versioned/object-locked MinIO bucket ------------------------------
: "${MINIO_ENDPOINT:?MINIO_ENDPOINT must be set}"
: "${MINIO_ROOT_USER:?MINIO_ROOT_USER must be set}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD must be set}"

command -v mc >/dev/null 2>&1 || fail "mc (MinIO client) not found on PATH"

mc alias set "$MINIO_ALIAS" "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null \
  || fail "mc alias set failed"

# Idempotent bucket setup -- see the runbook §2 for why --with-lock must be set at creation time.
if ! mc ls "$MINIO_ALIAS/$BACKUP_BUCKET" >/dev/null 2>&1; then
  mc mb --with-lock "$MINIO_ALIAS/$BACKUP_BUCKET" || fail "mc mb --with-lock failed"
  mc version enable "$MINIO_ALIAS/$BACKUP_BUCKET" || fail "mc version enable failed"
  mc retention set --default GOVERNANCE "${WEBDESK_BACKUP_RETENTION_DAYS:-30}d" "$MINIO_ALIAS/$BACKUP_BUCKET" \
    || fail "mc retention set failed"
fi

mc cp "$PG_OUT" "$MINIO_ALIAS/$BACKUP_BUCKET/pg/$(basename "$PG_OUT")" || fail "mc cp failed"
echo "mirrored ok: $MINIO_ALIAS/$BACKUP_BUCKET/pg/$(basename "$PG_OUT")"

echo "exit_code=0 finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ) file=$PG_OUT" > "$SENTINEL_FILE"
echo "backup complete"
