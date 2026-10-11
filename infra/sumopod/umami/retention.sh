#!/usr/bin/env bash
# WSK-D67: scheduled delete of Umami events/sessions older than RETENTION_MONTHS (default 14).
# Timer: systemd/umami-retention.timer. Prints one summary line (counts only, no visitor data).
# Note: deleted rows stay in already-taken backups until those expire (90 days; monthly ones 12 months).
set -euo pipefail
CONTAINER="${UMAMI_DB_CONTAINER:-umami-db-1}"
MONTHS="${RETENTION_MONTHS:-14}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$MONTHS" in '' | *[!0-9]*) echo "RETENTION_MONTHS must be a whole number" >&2; exit 1 ;; esac
[ "$MONTHS" -ge 1 ] || { echo "RETENTION_MONTHS must be >= 1" >&2; exit 1; }
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || { echo "container $CONTAINER is not running" >&2; exit 1; }
OUT="$(docker exec -i "$CONTAINER" psql -U umami -d umami -X -q -A -t -v ON_ERROR_STOP=1 -v months="$MONTHS" < "$HERE/retention.sql")"
printf '%s umami-retention months=%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$MONTHS" "$(printf '%s\n' "$OUT" | tail -n 1)"
