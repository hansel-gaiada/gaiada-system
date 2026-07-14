#!/bin/sh
# Uptime alerting for the gaiada VPS stack. Pings every service's /health from inside the
# compose network and, if any is down, sends ONE Telegram message listing the failures.
# Install via crontab (see runbooks/deploy-vps.md):
#   */5 * * * * TELEGRAM_BOT_TOKEN=... ALERT_CHAT_ID=... /path/to/infra/scripts/healthcheck.sh >> /var/log/gaiada-health.log 2>&1
#
# Silent when everything is healthy (only logs a one-line OK). No external deps beyond the
# bot container's wget (already present) and the host's curl for the Telegram call.
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
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ALERT_CHAT_ID:-}" ]; then
    curl -fsS -m 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${ALERT_CHAT_ID}" \
      --data-urlencode "text=${msg}" >/dev/null \
      || echo "warn: Telegram alert send failed"
  else
    echo "warn: TELEGRAM_BOT_TOKEN/ALERT_CHAT_ID unset — not alerting"
  fi
  exit 1
fi

echo "health ok ($STAMP)"
