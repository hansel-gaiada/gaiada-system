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
# Plus ONE volume — the WAHA session store (see waha_sessions() below for why it is safe).
#
# CRYPTO-SHRED RULE: this backs up the DATABASES ONLY (plus the WAHA volume). Never add the
# bot's data volume (it contains data/keys.json — key material must never live in the same
# backup set, or destroyed keys become recoverable and the shred is void). The WAHA volume is
# a DIFFERENT volume and holds no crypto-shred key material, so it does not breach the rule.
set -eu

BACKUP_DIR="${BACKUP_DIR:-$HOME/gaiada-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
COMPOSE="$(dirname "$0")/../compose/docker-compose.vps.yml"
# Compose project is `gaiada` (see the compose `name:`), so the volume is prefixed.
WAHA_VOLUME="${WAHA_VOLUME:-gaiada_waha-sessions}"

dump() { # <compose-service> <db>
  OUT="$BACKUP_DIR/$2-$STAMP.sql.gz"
  docker compose -f "$COMPOSE" exec -T "$1" pg_dump -U postgres "$2" | gzip > "$OUT"
  echo "backup ok: $OUT"
}

# The WAHA session store (Baileys pairing credentials). Losing this volume forces a fresh QR
# scan — and a re-pair is NOT reliably available on demand: on 2026-07-29 WhatsApp refused the
# registration handshake for hours after a reconnect storm, leaving no way back in. That makes
# this volume the most operationally valuable thing on the box.
#
# SECURITY: the contents are full WhatsApp ACCOUNT credentials — anyone holding them can act as
# the number. Treat the artifact as a secret: 0600, and never sync it anywhere shared/unencrypted.
#
# CONSISTENCY: Baileys writes creds continuously, so this is a crash-consistent snapshot. It
# restores in practice but is not guaranteed; for a clean copy, stop the session first
# (POST /api/sessions/{s}/stop — keeps auth, no re-scan) and re-run.
waha_sessions() {
  OUT="$BACKUP_DIR/waha-sessions-$STAMP.tar.gz"
  if ! docker volume inspect "$WAHA_VOLUME" >/dev/null 2>&1; then
    echo "backup SKIPPED: volume $WAHA_VOLUME not found (set WAHA_VOLUME to override)" >&2
    return 0
  fi
  # tar to stdout (no host bind-mount) so this works identically on Linux, WSL and Docker Desktop.
  docker run --rm -v "$WAHA_VOLUME":/src:ro alpine tar czf - -C /src . > "$OUT"
  chmod 600 "$OUT"
  echo "backup ok: $OUT"
}

mkdir -p "$BACKUP_DIR"
for DB in gaiada_platform gaiada_knowledge gaiada_keycloak gaiada_n8n; do dump postgres "$DB"; done
dump pg-bot gaiada_bot
waha_sessions

# Rotate all dumps on the same schedule.
find "$BACKUP_DIR" -name 'gaiada*-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'waha-sessions-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
