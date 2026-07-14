#!/bin/sh
# Nightly Postgres backup for the gaiada VPS stack. Install via crontab (see the runbook):
#   0 3 * * * /path/to/gaiada-system/infra/scripts/backup.sh >> /var/log/gaiada-backup.log 2>&1
#
# Backs up ALL THREE application databases the stack creates (wa-chat-bot/db/init.sh):
#   gaiada           — the bot (messages, schedule)
#   gaiada_platform  — the platform / ERP (clients, deliverables, agency, audit, sync outbox)
#   gaiada_knowledge — the WS8 derived knowledge store
# Missing any one of these silently loses that surface's data.
#
# CRYPTO-SHRED RULE: this backs up the DATABASES ONLY. Never add the bot's data volume
# (it contains data/keys.json — key material must never live in the same backup set,
# or destroyed keys become recoverable and the shred is void).
set -eu

BACKUP_DIR="${BACKUP_DIR:-$HOME/gaiada-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
COMPOSE="$(dirname "$0")/../compose/docker-compose.vps.yml"

mkdir -p "$BACKUP_DIR"
for DB in gaiada gaiada_platform gaiada_knowledge; do
  OUT="$BACKUP_DIR/$DB-$STAMP.sql.gz"
  docker compose -f "$COMPOSE" exec -T postgres pg_dump -U postgres "$DB" | gzip > "$OUT"
  echo "backup ok: $OUT"
done

# Rotate all three DBs' dumps on the same schedule.
find "$BACKUP_DIR" -name 'gaiada*-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
