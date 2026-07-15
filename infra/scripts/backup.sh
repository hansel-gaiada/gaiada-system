#!/bin/sh
# Nightly Postgres backup for the gaiada VPS stack. Install via crontab (see the runbook):
#   0 3 * * * /path/to/gaiada-system/infra/scripts/backup.sh >> /var/log/gaiada-backup.log 2>&1
#
# Backs up every application database, across BOTH instances (DB topology plan):
#   core instance (service `postgres`):
#     gaiada_platform  — the platform / ERP (clients, deliverables, agency, audit, sync outbox)
#     gaiada_knowledge — the WS8 derived knowledge store
#     gaiada_keycloak  — the IdP (realm, users, sessions)
#     gaiada_n8n       — automation workflow defs + execution history
#   bot instance (service `pg-bot`, isolated):
#     gaiada_bot       — the WhatsApp bot store (messages, schedule)
# Missing any one silently loses that surface's data.
#
# CRYPTO-SHRED RULE: this backs up the DATABASES ONLY. Never add the bot's data volume
# (it contains data/keys.json — key material must never live in the same backup set,
# or destroyed keys become recoverable and the shred is void).
set -eu

BACKUP_DIR="${BACKUP_DIR:-$HOME/gaiada-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
COMPOSE="$(dirname "$0")/../compose/docker-compose.vps.yml"

dump() { # <compose-service> <db>
  OUT="$BACKUP_DIR/$2-$STAMP.sql.gz"
  docker compose -f "$COMPOSE" exec -T "$1" pg_dump -U postgres "$2" | gzip > "$OUT"
  echo "backup ok: $OUT"
}

mkdir -p "$BACKUP_DIR"
for DB in gaiada_platform gaiada_knowledge gaiada_keycloak gaiada_n8n; do dump postgres "$DB"; done
dump pg-bot gaiada_bot

# Rotate all dumps on the same schedule.
find "$BACKUP_DIR" -name 'gaiada*-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
