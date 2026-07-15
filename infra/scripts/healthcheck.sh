#!/bin/sh
# Uptime alerting for the gaiada VPS stack — the WS9 D15 OUT-OF-BAND alerter, deliberately
# independent of the Prometheus/Alertmanager pipeline: if the whole observability stack is down,
# THIS still runs from cron and pages. Pings every service's /health from inside the compose
# network and, on any failure, alerts across ≥2 INDEPENDENT transports (Telegram + email). On
# success it pings an external dead-man's-switch so a dark box (cron dead, host off) is detectable.
#
# Install via crontab (see runbooks/deploy-vps.md):
#   */5 * * * * TELEGRAM_BOT_TOKEN=... ALERT_CHAT_ID=... ALERT_EMAIL_TO=... DEADMANSSWITCH_URL=... \
#     /path/to/infra/scripts/healthcheck.sh >> /var/log/gaiada-health.log 2>&1
#
# Silent when everything is healthy (logs a one-line OK + pings the switch). No external deps
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

if [ -n "$failures" ]; then
  msg="🔴 gaiada health check FAILED ($STAMP) — down:$failures"
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
  # Deliberately DO NOT ping the dead-man's-switch on failure — its silence is the signal.
  exit 1
fi

echo "health ok ($STAMP)"
# Success heartbeat: tell the external dead-man's-switch we're alive. If cron/host/network die,
# the switch stops seeing this and raises the alarm out-of-band (D15).
if [ -n "${DEADMANSSWITCH_URL:-}" ]; then
  curl -fsS -m 15 "$DEADMANSSWITCH_URL" >/dev/null 2>&1 || echo "warn: dead-man's-switch ping failed"
fi
