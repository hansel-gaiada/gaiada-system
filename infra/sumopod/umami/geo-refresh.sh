#!/usr/bin/env bash
# Monthly refresh of the DB-IP Lite City database (CC BY 4.0; published monthly) that Umami reads from
# ./geo/dbip-city-lite.mmdb (GEOLITE_DB_PATH). Runs on the HOST, which has egress; the Umami container has none.
# Why not MaxMind GeoLite2: its EULA requires a refresh within 30 days; this is refreshed monthly by timer.
# ATTRIBUTION: CC BY 4.0 requires a visible credit ("IP Geolocation by DB-IP", https://db-ip.com) on the
# privacy page of the site that uses the data. Flagged for the owner/counsel in the runbook.
#
# Safe by construction: download to a temp name, gunzip, sanity-check size and marker, atomic rename, restart
# the app (maxmind opens the file once per process). A failed run leaves the old file in place.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEO_DIR="${UMAMI_GEO_DIR:-$HERE/geo}"
MIN_BYTES=$((20 * 1024 * 1024))
mkdir -p "$GEO_DIR"
WORK="$(mktemp -d "$GEO_DIR/.dl.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FOUND=""
for OFFSET in 0 1; do  # this month's file, else last month's (DB-IP publishes early in the month)
  YM="$(date -u -d "$(date -u +%Y-%m-01) -${OFFSET} month" +%Y-%m)"
  URL="https://download.db-ip.com/free/dbip-city-lite-${YM}.mmdb.gz"
  if curl -fsSL --max-time 300 -o "$WORK/db.gz" "$URL"; then FOUND="$YM"; break; fi
done
[ -n "$FOUND" ] || { echo "geo-refresh FAILED: no DB-IP Lite file for this or last month" >&2; exit 1; }

gzip -t "$WORK/db.gz"
gunzip -c "$WORK/db.gz" > "$WORK/db.mmdb"
SIZE="$(wc -c < "$WORK/db.mmdb" | tr -d ' ')"
[ "$SIZE" -gt "$MIN_BYTES" ] || { echo "geo-refresh FAILED: $SIZE bytes is too small to be a city database" >&2; exit 1; }
grep -qa "binary_format_major_version" "$WORK/db.mmdb" || { echo "geo-refresh FAILED: no MMDB metadata marker" >&2; exit 1; }

chmod 644 "$WORK/db.mmdb"
mv "$WORK/db.mmdb" "$GEO_DIR/dbip-city-lite.mmdb"
echo "$FOUND" > "$GEO_DIR/VERSION"
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') geo-refresh ok month=$FOUND bytes=$SIZE"

# Reload: only if the app is already running (first deploy runs this BEFORE `up`).
if docker ps --format '{{.Names}}' | grep -qx umami-app-1; then
  docker restart umami-app-1 > /dev/null && echo "restarted umami-app-1"
fi
