#!/bin/sh
# Uptime alerting for the gaiada VPS stack — the WS9 D15 OUT-OF-BAND alerter, deliberately
# independent of the Prometheus/Alertmanager pipeline: if the whole observability stack is down,
# THIS still runs from cron and pages. Pings every service's /health from inside the compose
# network and, on any failure, alerts across ≥2 INDEPENDENT transports (Telegram + email). On
# success it pings an external dead-man's-switch so a dark box (cron dead, host off) is detectable.
#
# Install via crontab (see runbooks/deploy-vps.md):
#   */5 * * * * TELEGRAM_BOT_TOKEN=... ALERT_CHAT_ID=... ALERT_EMAIL_TO=... DEADMANSSWITCH_URL=... \
#     SUMOPOD_OBS_URL=http://10.88.0.2:9093/-/healthy SUMOPOD_DEADMANSSWITCH_URL=... \
#     /path/to/infra/scripts/healthcheck.sh >> /var/log/gaiada-health.log 2>&1
#
# Silent when everything is healthy (logs a one-line OK + pings the switch(es)). No external deps
# beyond the bot container's wget and the host's curl / optional sendmail.
set -eu

COMPOSE="$(dirname "$0")/../compose/docker-compose.vps.yml"
STAMP="$(date +%Y-%m-%dT%H:%M:%S)"

# "label|url" — reached over the internal compose network via the bot container.
CHECKS="
gateway|http://ai-gateway:3002/health
bot|http://bot:3001/health
mcp-hub|http://mcp-hub:3003/health
platform|http://platform:3004/health
knowledge|http://knowledge:3005/health
platform-ui|http://platform-ui:3005/
"

failures=""
for entry in $CHECKS; do
  [ -z "$entry" ] && continue
  label="${entry%%|*}"
  url="${entry#*|}"
  if ! docker compose -f "$COMPOSE" exec -T bot wget -q -T 8 -O /dev/null "$url" 2>/dev/null; then
    failures="$failures $label"
  fi
done

# 2026-08-31 rollout — the OUTSIDE-SUMOPOD leg of the observability dead-man's-switch
# (docs/plans/2026-08-31-helios-delphi-plane-a-rollout.md §5). The 2026-08-18 relocation moved
# storage/alerting to SumoPod specifically so gda-aicenter dying no longer takes the alerter with
# it; that inverted the risk without closing it — now, if SUMOPOD dies, the box that would have
# noticed is the box that died. SumoPod's own Watchdog->DEADMANSSWITCH_URL heartbeat covers "did
# Prometheus/Alertmanager stop running", the same way it always has — but that heartbeat itself
# runs FROM the box that might be dark, so a total box/network failure (not just the alerting
# containers) could in principle take the heartbeat with it before a webhook fires. This check is
# the second, genuinely OUTSIDE observer: gda-aicenter (a DIFFERENT box, DIFFERENT provider,
# reached over its own live WireGuard link) actively polls SumoPod's Alertmanager every 5 minutes
# via the HOST's curl (NOT the bot container — 10.88.0.2 is on the host's wg0 interface, not the
# container network namespace, so an exec-based check would silently always fail here).
#
# On failure: alert immediately over the SAME Telegram/email transports as the local checks —
# do not wait for SumoPod's own external heartbeat to go silent first, that is strictly slower.
# On success: ping a SEPARATE dead-man's-switch (SUMOPOD_DEADMANSSWITCH_URL, its own
# healthchecks.io/Cronitor check, NOT the same URL as DEADMANSSWITCH_URL above) — keeping the two
# heartbeats distinct means "gda-aicenter's cron died" and "gda-aicenter can't reach SumoPod" stay
# individually diagnosable instead of both silently dropping the one shared check.
sumopod_failure=""
if [ -n "${SUMOPOD_OBS_URL:-}" ]; then
  if ! curl -fsS -m 10 -o /dev/null "$SUMOPOD_OBS_URL"; then
    sumopod_failure="SumoPod Alertmanager unreachable at ${SUMOPOD_OBS_URL} (WireGuard link or the box itself may be down)"
  fi
fi

if [ -n "$failures" ] || [ -n "$sumopod_failure" ]; then
  msg="🔴 gaiada health check FAILED ($STAMP)"
  [ -n "$failures" ] && msg="$msg — down:$failures"
  [ -n "$sumopod_failure" ] && msg="$msg — $sumopod_failure"
  echo "$msg"
  sent=0
  # Transport 1: Telegram.
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ALERT_CHAT_ID:-}" ]; then
    curl -fsS -m 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${ALERT_CHAT_ID}" \
      --data-urlencode "text=${msg}" >/dev/null \
      && sent=$((sent + 1)) || echo "warn: Telegram alert send failed"
  fi
  # Transport 2 (independent): email via sendmail, if configured.
  if [ -n "${ALERT_EMAIL_TO:-}" ] && command -v sendmail >/dev/null 2>&1; then
    printf 'Subject: gaiada health check FAILED\n\n%s\n' "$msg" | sendmail "$ALERT_EMAIL_TO" \
      && sent=$((sent + 1)) || echo "warn: email alert send failed"
  fi
  [ "$sent" -eq 0 ] && echo "warn: no alert transport configured — set TELEGRAM_* and/or ALERT_EMAIL_TO"
  # Deliberately DO NOT ping either dead-man's-switch on failure — its silence is the signal.
  exit 1
fi

echo "health ok ($STAMP)"
# Success heartbeat(s): tell the external dead-man's-switch(es) we're alive. If cron/host/network
# die, the switch stops seeing this and raises the alarm out-of-band (D15).
if [ -n "${DEADMANSSWITCH_URL:-}" ]; then
  curl -fsS -m 15 "$DEADMANSSWITCH_URL" >/dev/null 2>&1 || echo "warn: dead-man's-switch ping failed"
fi
if [ -n "${SUMOPOD_OBS_URL:-}" ] && [ -n "${SUMOPOD_DEADMANSSWITCH_URL:-}" ]; then
  curl -fsS -m 15 "$SUMOPOD_DEADMANSSWITCH_URL" >/dev/null 2>&1 || echo "warn: SumoPod dead-man's-switch ping failed"
fi
