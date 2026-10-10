#!/bin/sh
# wd-backup-sentinel -- WSK-28. Staleness alarm for webdesk-backup-local.sh.
#
# Mirrors the estate's infra/scripts/restore-drill.sh dead-man's-switch discipline: two
# independent alert transports on failure, a positive ping on success so a SILENTLY STOPPED job
# is itself detectable (a backup cron that stops running looks identical to a healthy quiet system
# unless something is watching the silence itself).
#
# Checks, each run:
#   1. The local sentinel file (written by webdesk-backup-local.sh) shows exit_code=0 and a
#      finished_at within WD_BACKUP_MAX_AGE_HOURS.
#   2. The newest object under <bucket>/pg/ in object storage (RustFS, WSK-D42) is younger than the
#      same window (catches the case where the local script ran but the upload step silently
#      produced an empty/stale mirror
#      -- the sentinel file alone can't see that, only the bucket listing can).
#
# Run (compose service `wd-backup-sentinel`, looped; or standalone cron):
#   WEBDESK_BACKUP_SENTINEL_FILE=... STORAGE_ENDPOINT=... \
#   WEBDESK_BACKUP_ACCESS_KEY_ID=... WEBDESK_BACKUP_SECRET_ACCESS_KEY=... \
#   WD_BACKUP_MAX_AGE_HOURS=26 DEADMANSSWITCH_URL=... TELEGRAM_BOT_TOKEN=... ALERT_CHAT_ID=... ALERT_EMAIL_TO=... \
#     ./wd-backup-sentinel.sh
set -eu

SENTINEL_FILE="${WEBDESK_BACKUP_SENTINEL_FILE:-/var/lib/webdesk-backups/.last-run}"
MAX_AGE_HOURS="${WD_BACKUP_MAX_AGE_HOURS:-26}"
STORAGE_REGION="${STORAGE_REGION:-us-east-1}"
BACKUP_BUCKET="${WEBDESK_BACKUP_BUCKET:-backups}"

now_epoch="$(date -u +%s)"
max_age_seconds=$((MAX_AGE_HOURS * 3600))

alert() {
  reason="$1"
  echo "wd-backup-sentinel ALERT: $reason" >&2
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ALERT_CHAT_ID:-}" ]; then
    curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${ALERT_CHAT_ID}" \
      -d "text=[webdesk-backup] ALERT: ${reason}" >/dev/null 2>&1 || true
  fi
  if [ -n "${ALERT_EMAIL_TO:-}" ] && command -v mail >/dev/null 2>&1; then
    echo "$reason" | mail -s "[webdesk-backup] ALERT" "$ALERT_EMAIL_TO" || true
  fi
}

fail() {
  alert "$1"
  exit 1
}

# --- 1. Sentinel file check -----------------------------------------------------------------
[ -f "$SENTINEL_FILE" ] || fail "no sentinel file at $SENTINEL_FILE -- the backup job has never run, or its output path is misconfigured"

exit_code_line="$(grep -o 'exit_code=[0-9]*' "$SENTINEL_FILE" || true)"
finished_at_line="$(grep -o 'finished_at=[0-9TZ:-]*' "$SENTINEL_FILE" || true)"

[ -n "$exit_code_line" ] || fail "sentinel file at $SENTINEL_FILE is malformed (no exit_code=)"
[ "$exit_code_line" = "exit_code=0" ] || fail "last backup run recorded a non-zero exit ($exit_code_line)"

finished_at="${finished_at_line#finished_at=}"
[ -n "$finished_at" ] || fail "sentinel file at $SENTINEL_FILE is malformed (no finished_at=)"

finished_epoch="$(date -u -d "$finished_at" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$finished_at" +%s 2>/dev/null || echo 0)"
[ "$finished_epoch" != "0" ] || fail "could not parse finished_at=$finished_at from sentinel file"

age_seconds=$((now_epoch - finished_epoch))
if [ "$age_seconds" -gt "$max_age_seconds" ]; then
  fail "last successful backup is $((age_seconds / 3600))h old (max ${MAX_AGE_HOURS}h) -- the nightly job appears to have stopped running"
fi

# --- 2. Bucket-side freshness check (optional -- only if backup-writer creds are provided) ----
# WSK-52: no `mc` (RustFS ships none). ListObjectsV2 over curl --aws-sigv4 with the dedicated
# backup-writer key (never root). Keys are pg/webdesk-YYYYMMDD-HHMMSS.sql.gz; the newest object is
# the maximum LastModified across every page of the listing.
if [ -n "${STORAGE_ENDPOINT:-}" ] && [ -n "${WEBDESK_BACKUP_ACCESS_KEY_ID:-}" ] && [ -n "${WEBDESK_BACKUP_SECRET_ACCESS_KEY:-}" ]; then
  list_page() { # $1 = continuation token, or empty for the first page
    if [ -n "$1" ]; then
      curl -sS -f -G --aws-sigv4 "aws:amz:$STORAGE_REGION:s3" \
        --user "$WEBDESK_BACKUP_ACCESS_KEY_ID:$WEBDESK_BACKUP_SECRET_ACCESS_KEY" \
        --data-urlencode "list-type=2" --data-urlencode "prefix=pg/" --data-urlencode "continuation-token=$1" \
        "${STORAGE_ENDPOINT%/}/$BACKUP_BUCKET"
    else
      curl -sS -f -G --aws-sigv4 "aws:amz:$STORAGE_REGION:s3" \
        --user "$WEBDESK_BACKUP_ACCESS_KEY_ID:$WEBDESK_BACKUP_SECRET_ACCESS_KEY" \
        --data-urlencode "list-type=2" --data-urlencode "prefix=pg/" \
        "${STORAGE_ENDPOINT%/}/$BACKUP_BUCKET"
    fi
  }
  token=""
  newest_mod=""
  while :; do
    page="$(list_page "$token")" || fail "listing $BACKUP_BUCKET/pg/ failed during the freshness check"
    page_newest="$(printf '%s' "$page" | grep -o '<LastModified>[^<]*' | sed 's/<LastModified>//' | sort | tail -1)"
    # ISO-8601 timestamps sort lexically; blank lines sort first and lose.
    newest_mod="$(printf '%s\n%s\n' "$newest_mod" "$page_newest" | sort | tail -1)"
    if printf '%s' "$page" | grep -q '<IsTruncated>true</IsTruncated>'; then
      token="$(printf '%s' "$page" | grep -o '<NextContinuationToken>[^<]*' | sed 's/<NextContinuationToken>//')"
      [ -n "$token" ] || break
    else
      break
    fi
  done
  if [ -z "$newest_mod" ]; then
    fail "no objects found under $BACKUP_BUCKET/pg/ -- the local sentinel file says success but the bucket is empty. This is exactly the case #4/section 4 exists to catch: a job that exits 0 without actually having mirrored anything."
  fi
  newest_iso="$(printf '%s' "$newest_mod" | sed 's/\.[0-9]*Z$/Z/')"
  newest_epoch="$(date -u -d "$newest_iso" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$newest_iso" +%s 2>/dev/null || echo 0)"
  [ "$newest_epoch" != "0" ] || fail "could not parse newest object LastModified=$newest_mod"
  bucket_age=$((now_epoch - newest_epoch))
  if [ "$bucket_age" -gt "$max_age_seconds" ]; then
    fail "newest object under $BACKUP_BUCKET/pg/ is $((bucket_age / 3600))h old (max ${MAX_AGE_HOURS}h) -- the sentinel file says success but the bucket copy is stale"
  fi
fi

echo "wd-backup-sentinel OK: last backup $((age_seconds / 60)) minutes old"
if [ -n "${DEADMANSSWITCH_URL:-}" ]; then
  curl -sS -o /dev/null "$DEADMANSSWITCH_URL" || true
fi
exit 0
