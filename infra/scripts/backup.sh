#!/bin/sh
# Nightly Postgres backup for the gaiada VPS stack. Install via crontab (see the runbook):
#   0 3 * * * /path/to/gaiada-system/infra/scripts/backup.sh >> /var/log/gaiada-backup.log 2>&1
#
# CRYPTO-SHRED RULE: this backs up the DATABASE ONLY. Never add the bot's data volume
# (it contains data/keys.json — key material must never live in the same backup set,
# or destroyed keys become recoverable and the shred is void).
set -eu

BACKUP_DIR="${BACKUP_DIR:-$HOME/gaiada-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"
docker compose -f "$(dirname "$0")/../compose/docker-compose.vps.yml" exec -T postgres \
  pg_dump -U postgres gaiada | gzip > "$BACKUP_DIR/gaiada-$STAMP.sql.gz"

# Rotate
find "$BACKUP_DIR" -name 'gaiada-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
echo "backup ok: $BACKUP_DIR/gaiada-$STAMP.sql.gz"
