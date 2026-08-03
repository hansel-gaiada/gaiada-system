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
# Compose file list, as ready-made `-f` flags (intentionally unquoted at use so multiple files
# expand). On a host-Postgres box (gda-aicenter) the base file ALONE is an invalid project —
# postgres/redis are profile-disabled there, so every `depends_on` naming them fails resolution,
# `docker compose ps` errors out, and the running-check below then matches nothing and "skips
# cleanly". That silently produced a backup set with NO gaiada_bot dump while exiting 0.
#
# 2026-08-03: this used to require the CALLER to pass both files, and the caller that matters most
# didn't. deploy.yml has COMPOSE_FILES in its job env but never forwarded it over the `ssh vps`
# that runs this script, so the deploy got the single-file default and died at the backup gate —
# `service "knowledge" depends on undefined service "postgres": invalid compose project` — which
# is a HARD FAIL for the whole deploy, since the backup is deliberately the gate for migrations.
# It surfaced only after deploy.yml's rsync step (which runs BEFORE the backup) put a newer
# vps.yml on the box; the previous run had backed up fine minutes earlier against the older file.
#
# So the overlay is now picked up AUTOMATICALLY whenever it sits next to the base file, rather
# than depending on every call site remembering. Explicitly setting COMPOSE_FILES still wins.
_compose_dir="$(dirname "$0")/../compose"
if [ -z "${COMPOSE_FILES:-}" ]; then
  COMPOSE_FILES="-f $_compose_dir/docker-compose.vps.yml"
  # hostdata = the host-Postgres topology. Present on gda-aicenter, absent on an all-in-compose
  # box, and harmless to layer when the services it disables are the ones it also defines.
  [ -f "$_compose_dir/docker-compose.hostdata.yml" ] &&
    COMPOSE_FILES="$COMPOSE_FILES -f $_compose_dir/docker-compose.hostdata.yml"
fi
# Compose project is `gaiada` (see the compose `name:`), so the volume is prefixed.
WAHA_VOLUME="${WAHA_VOLUME:-gaiada_waha-sessions}"

# PG_HOST set (and not the compose service name) means the core cluster lives on the HOST, not in
# compose — the gda-aicenter topology, where Postgres is shared with other projects. There is no
# container to `exec` into, so dump straight from the host cluster as the postgres superuser via
# peer auth. The bot instance stays containerized either way and keeps the compose path.
CORE_ON_HOST=false
case "${PG_HOST:-postgres}" in postgres|"") ;; *) CORE_ON_HOST=true ;; esac

dump() { # <compose-service> <db>
  OUT="$BACKUP_DIR/$2-$STAMP.sql.gz"
  if [ "$1" = "postgres" ] && [ "$CORE_ON_HOST" = true ]; then
    sudo -n -u postgres pg_dump "$2" | gzip > "$OUT"
  else
    # Skip cleanly when the service isn't part of the active profile set (e.g. pg-bot with the
    # `bot` profile off) — a missing optional lane must not fail the backup that gates migrations.
    # Distinguish "this optional lane is off" (skip, fine) from "compose can't read the project
    # at all" (FAIL loudly). The old code swallowed stderr and treated both as a clean skip, so a
    # broken invocation reported success while backing up nothing.
    if ! RUNNING="$(docker compose $COMPOSE_FILES ps --status running --format '{{.Service}}' 2>&1)"; then
      echo "backup FAILED: cannot read compose project (service $1): $RUNNING" >&2
      return 1
    fi
    if ! printf '%s\n' "$RUNNING" | grep -qx "$1"; then
      echo "backup SKIPPED: service $1 not running (profile off?)" >&2
      return 0
    fi
    docker compose $COMPOSE_FILES exec -T "$1" pg_dump -U postgres "$2" | gzip > "$OUT"
  fi
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
