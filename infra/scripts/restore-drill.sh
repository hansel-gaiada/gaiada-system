#!/bin/sh
# WS9 / D15 — RESTORE DRILL. An untested backup is not a backup. This restores the most-recent
# nightly dumps (from backup.sh) into an ISOLATED throwaway Postgres, runs integrity checks, and
# MEASURES the restore time (RTO) and the backup age (RPO), then tears the isolated instance down.
# On any failure it exits non-zero AND pings the alert transports, so a broken backup pages instead
# of being discovered during a real disaster.
#
# Install weekly via crontab (see infra/runbooks/restore-drill.md):
#   30 4 * * 0 TELEGRAM_BOT_TOKEN=... ALERT_CHAT_ID=... DEADMANSSWITCH_URL=... \
#     /path/to/gaiada-system/infra/scripts/restore-drill.sh >> /var/log/gaiada-restore-drill.log 2>&1
#
# It NEVER touches the live databases — the restore target is a disposable container on a random
# port with its own volume, removed at the end (trap). Safe to run on the production box.
set -eu

BACKUP_DIR="${BACKUP_DIR:-$HOME/gaiada-backups}"
STAMP="$(date +%Y-%m-%dT%H:%M:%S)"
PGIMAGE="${PGIMAGE:-postgres:17-alpine}"
CONTAINER="gaiada-restore-drill-$$"
# Which dumps to verify. Each must exist in BACKUP_DIR (newest by glob).
DBS="${DRILL_DBS:-gaiada_platform gaiada_knowledge gaiada_bot}"

fail() {
  msg="🔴 gaiada RESTORE DRILL FAILED ($STAMP): $1"
  echo "$msg"
  # Independent transports (D15): Telegram + email (via sendmail if present). Best-effort.
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ALERT_CHAT_ID:-}" ]; then
    curl -fsS -m 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${ALERT_CHAT_ID}" --data-urlencode "text=${msg}" >/dev/null 2>&1 || true
  fi
  if [ -n "${ALERT_EMAIL_TO:-}" ] && command -v sendmail >/dev/null 2>&1; then
    printf 'Subject: gaiada restore drill FAILED\n\n%s\n' "$msg" | sendmail "$ALERT_EMAIL_TO" || true
  fi
  exit 1
}

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fail "docker not found"
[ -d "$BACKUP_DIR" ] || fail "backup dir $BACKUP_DIR missing"

# Spin up an isolated Postgres (random host port, throwaway).
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=drill -P "$PGIMAGE" >/dev/null \
  || fail "could not start isolated postgres"

# Wait for readiness (max ~30s).
i=0
until docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 30 ] && fail "isolated postgres never became ready"; sleep 1
done

# Pre-create the cluster's roles as no-login stubs. backup.sh dumps WITH ownership + GRANTs (plain
# pg_dump), so a restore into a fresh instance references these roles; without them the restore errors
# under ON_ERROR_STOP. This mirrors the production role set (see infra/db/init-cluster.sh) so the drill
# validates the dump restores cleanly given the standard roles — not a role-less blank slate.
ROLES="${DRILL_ROLES:-platform_owner platform_app knowledge_owner knowledge_app sync_app bot_owner bot_app keycloak n8n}"
for role in $ROLES; do
  docker exec "$CONTAINER" psql -U postgres -c \
    "DO \$\$ BEGIN CREATE ROLE $role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;" >/dev/null 2>&1 || true
done

WORST_RPO_HOURS=0
DRILL_START=$(date +%s)

for DB in $DBS; do
  DUMP="$(ls -t "$BACKUP_DIR/$DB"-*.sql.gz 2>/dev/null | head -1 || true)"
  [ -n "$DUMP" ] || fail "no dump found for $DB in $BACKUP_DIR"

  # RPO: how old is this backup (hours since it was written)?
  DUMP_EPOCH=$(date -r "$DUMP" +%s 2>/dev/null || echo "$DRILL_START")
  AGE_H=$(( (DRILL_START - DUMP_EPOCH) / 3600 ))
  [ "$AGE_H" -gt "$WORST_RPO_HOURS" ] && WORST_RPO_HOURS=$AGE_H

  echo "restoring $DB from $DUMP (age ${AGE_H}h) ..."
  docker exec "$CONTAINER" psql -U postgres -c "CREATE DATABASE \"$DB\";" >/dev/null 2>&1 \
    || fail "create db $DB failed"
  if ! gunzip -c "$DUMP" | docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>&1; then
    fail "restore of $DB reported SQL errors (ON_ERROR_STOP)"
  fi

  # Integrity check: the restored DB must have at least one table with data OR a known schema.
  TABLES=$(docker exec "$CONTAINER" psql -U postgres -d "$DB" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo 0)
  [ "${TABLES:-0}" -ge 1 ] || fail "restored $DB has no public tables — dump is empty/corrupt"
  echo "  ok: $DB restored with $TABLES public tables"
done

RTO_S=$(( $(date +%s) - DRILL_START ))
echo "✅ restore drill OK ($STAMP) — RTO=${RTO_S}s, worst RPO=${WORST_RPO_HOURS}h across [$DBS]"

# Success heartbeat to the dead-man's-switch so a SKIPPED drill (cron dead, box off) is detectable:
# the external monitor expects a periodic ping and alarms on its absence.
if [ -n "${DEADMANSSWITCH_URL:-}" ]; then
  curl -fsS -m 15 "$DEADMANSSWITCH_URL" >/dev/null 2>&1 || true
fi
