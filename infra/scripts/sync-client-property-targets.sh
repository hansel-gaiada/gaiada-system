#!/bin/sh
# MON-01 wiring, 2026-08-31 rollout — runs the generator (gen-client-property-targets.mjs) on
# gda-aicenter and ships ONLY the resulting minimal JSON to SumoPod's Prometheus, which does the
# actual probing.
#
# WHY THIS SPLIT, EXPLICITLY (reconciles two constraints that look like they conflict):
#   1. The client inventory (search_properties — full rows, DATABASE_URL, everything the platform
#      knows about a client) must NEVER need to live on SumoPod. A compromise of the observability
#      host must not hand over an inventory of the entire client estate.
#   2. Standing outbound scrape traffic to ~63 third-party domains should NOT originate from
#      gda-aicenter — that box is Zone A, holds the platform DB, and has no business making
#      scheduled connections to other people's infrastructure (see proposed-client-properties-
#      job.yml's own "THE ONE DECISION THAT MUST BE MADE BEFORE APPLYING").
# Both hold at once because they constrain DIFFERENT THINGS: (1) is about where the DATABASE_URL /
# full inventory lives (stays on gda-aicenter, which already has it); (2) is about which box's IP
# shows up in 63 clients' access logs making a GET every 60s (SumoPod, not gda-aicenter). This
# script is the seam between them — it runs the DB query HERE, then ships across the wire only the
# already-curated, minimal file toFileSd() produces (domain/tenant_id/client_id/site_url, nothing
# else from the row) — never the DATABASE_URL, never a full properties export.
#
# Install via crontab on gda-aicenter (see infra/runbooks/enable-estate-blackbox-and-alert-routing.md):
#   */5 * * * * DATABASE_URL=... /path/to/infra/scripts/sync-client-property-targets.sh \
#     >> /var/log/gaiada-client-targets.log 2>&1
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GENERATOR="$SCRIPT_DIR/../observability/scripts/gen-client-property-targets.mjs"
LOCAL_OUT="/tmp/gaiada-client-properties-targets.json"
REMOTE_HOST="${OBS_HUB_SSH_ALIAS:-sumopod}"
# Path INSIDE the SumoPod box's own checkout (infra/runbooks §"THIS BOX IS NOT OURS" — it is a
# hand-maintained, non-tag-deployed checkout at ~/gaiada-obs, not the tag-deploy path).
REMOTE_PATH="\${HOME}/gaiada-obs/infra/observability/prometheus/targets/client-properties.json"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "sync-client-property-targets: DATABASE_URL is not set — refusing to run." >&2
  exit 2
fi

node "$GENERATOR" --out "$LOCAL_OUT"
gen_status=$?
if [ "$gen_status" -ne 0 ]; then
  echo "sync-client-property-targets: generator failed (exit $gen_status) — NOT syncing a stale/partial file." >&2
  exit "$gen_status"
fi

# rsync, not scp: --checksum avoids a no-op transfer (and a needless Prometheus file_sd reload
# churn) when nothing changed since the last run. Ships ONLY this one file, over the same
# WireGuard-reachable SSH path already used for the relocation's own operator access — no new
# credential, no new port.
rsync --checksum -e ssh "$LOCAL_OUT" "${REMOTE_HOST}:${REMOTE_PATH}"

echo "sync-client-property-targets: synced $(date +%Y-%m-%dT%H:%M:%S)"
