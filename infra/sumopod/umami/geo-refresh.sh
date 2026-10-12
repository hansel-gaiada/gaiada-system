#!/usr/bin/env bash
# Monthly refresh of the DB-IP Lite City database (CC BY 4.0; published monthly) that Umami reads from
# ./geo/dbip-city-lite.mmdb (GEOLITE_DB_PATH), and (M5-V2-c) of the DB-IP ASN Lite database the insights-collector
# reads from ./geo/dbip-asn-lite.mmdb. Runs on the HOST, which has egress; the containers have none.
# Why not MaxMind GeoLite2: its EULA requires a refresh within 30 days; this is refreshed monthly by timer.
# ATTRIBUTION: CC BY 4.0 requires a visible credit ("IP Geolocation by DB-IP", https://db-ip.com) on the
# privacy page of the site that uses the data. Flagged for the owner/counsel in the runbook.
#
# Safe by construction: download to a temp name, gunzip, sanity-check size and marker, atomic rename, restart
# the app and the collector (both open the file once per process). Each edition is fetched and checked on its
# own; a failed edition leaves its old file in place and the run exits non-zero AFTER the other was handled.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEO_DIR="${UMAMI_GEO_DIR:-$HERE/geo}"
MIN_BYTES_CITY=$((20 * 1024 * 1024))
MIN_BYTES_ASN=$((2 * 1024 * 1024))   # deliberately low: the real size of the ASN Lite edition is UNVERIFIED (V2-d records it); the floor only catches a truncated or HTML download
mkdir -p "$GEO_DIR"
WORK="$(mktemp -d "$GEO_DIR/.dl.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# refresh <edition: city|asn> <min bytes> -- prints one ok line; returns 1 (message on stderr) on any failure
refresh() {
  local ED="$1" MIN="$2" FOUND="" OFFSET YM URL SIZE
  for OFFSET in 0 1; do  # this month's file, else last month's (DB-IP publishes early in the month)
    YM="$(date -u -d "$(date -u +%Y-%m-01) -${OFFSET} month" +%Y-%m)"
    URL="https://download.db-ip.com/free/dbip-${ED}-lite-${YM}.mmdb.gz"
    if curl -fsSL --max-time 300 -o "$WORK/$ED.gz" "$URL"; then FOUND="$YM"; break; fi
  done
  [ -n "$FOUND" ] || { echo "geo-refresh FAILED ($ED): no DB-IP Lite file for this or last month" >&2; return 1; }

  gzip -t "$WORK/$ED.gz" || { echo "geo-refresh FAILED ($ED): gzip -t rejected the download" >&2; return 1; }
  gunzip -c "$WORK/$ED.gz" > "$WORK/$ED.mmdb"
  SIZE="$(wc -c < "$WORK/$ED.mmdb" | tr -d ' ')"
  [ "$SIZE" -gt "$MIN" ] || { echo "geo-refresh FAILED ($ED): $SIZE bytes is too small to be a $ED database" >&2; return 1; }
  grep -qa "binary_format_major_version" "$WORK/$ED.mmdb" || { echo "geo-refresh FAILED ($ED): no MMDB metadata marker" >&2; return 1; }

  chmod 644 "$WORK/$ED.mmdb"
  mv "$WORK/$ED.mmdb" "$GEO_DIR/dbip-$ED-lite.mmdb"
  if [ "$ED" = city ]; then echo "$FOUND" > "$GEO_DIR/VERSION"; else echo "$FOUND" > "$GEO_DIR/VERSION-asn"; fi
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') geo-refresh ok edition=$ED month=$FOUND bytes=$SIZE"
}

RC=0
CHANGED=0
refresh city "$MIN_BYTES_CITY" && CHANGED=1 || RC=1
refresh asn "$MIN_BYTES_ASN" && CHANGED=1 || RC=1

# Reload: only the containers that are already running (first deploy runs this BEFORE `up`). Both open the
# files once per process, so a restart is what makes the new month take effect.
if [ "$CHANGED" = 1 ]; then
  for C in umami-app-1 umami-collector-1; do
    if docker ps --format '{{.Names}}' | grep -qx "$C"; then
      docker restart "$C" > /dev/null && echo "restarted $C"
    fi
  done
fi
exit "$RC"
