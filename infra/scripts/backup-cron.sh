#!/bin/sh
# Cron entry point for backup.sh on a HOST-POSTGRES box (gda-aicenter topology).
#
# Why a wrapper instead of calling backup.sh straight from crontab: backup.sh needs two pieces
# of environment that only exist in infra/compose/.env and in the deploy invocation, and if
# EITHER is missing it still exits 0 while backing up nothing —
#
#   PG_HOST         unset => backup.sh assumes a containerized `postgres` service, finds none,
#                   and "skips cleanly" all four core DBs.
#   COMPOSE_FILES   base file alone is an INVALID compose project here (postgres/redis are
#                   profile-disabled), so `docker compose ps` errors and pg-bot is skipped —
#                   which is how gaiada_bot went un-backed-up entirely.
#   COMPOSE_PROFILES  pg-bot lives behind the `bot` profile.
#
# Install (runs 03:15 daily):
#   (crontab -l 2>/dev/null; echo '15 3 * * * $HOME/gaiada/infra/scripts/backup-cron.sh >> $HOME/gaiada-backups/backup.log 2>&1') | crontab -
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"

# shellcheck disable=SC1091
set -a
. "$ROOT/infra/compose/.env"
set +a

COMPOSE_PROFILES=bot,auth
COMPOSE_FILES="-f $ROOT/infra/compose/docker-compose.vps.yml -f $ROOT/infra/compose/docker-compose.hostdata.yml"
export COMPOSE_PROFILES COMPOSE_FILES

echo "=== backup run $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
sh "$ROOT/infra/scripts/backup.sh"

# Fail loudly if a run produced fewer than the 5 expected DB dumps — a silent partial backup is
# the failure mode this whole wrapper exists to prevent.
STAMP_GLOB="$(date -u '+%Y%m%d')"
BDIR="${BACKUP_DIR:-$HOME/gaiada-backups}"
COUNT="$(find "$BDIR" -name "gaiada_*-$STAMP_GLOB-*.sql.gz" | wc -l)"
if [ "$COUNT" -lt 5 ]; then
  echo "backup WARNING: only $COUNT DB dumps for $STAMP_GLOB (expected >=5)" >&2
fi

# The guard above counts `gaiada_*` ONLY, and that is exactly how the consolidated stacks went
# unnoticed: webdesk and postiz dumps are named after their own databases, so zero of them would
# still satisfy it and the run would report success. Each consolidated stack is therefore checked
# by name, and only when its container is actually on this host — a box that does not host a stack
# must not warn about it forever.
for PAIR in 'webdesk-postgres-1 webdesk' \
            'gaiada-social-social-postgres-1 postiz' \
            'gaiada-social-social-temporal-postgres-1 temporal' \
            'gaiada-social-social-temporal-postgres-1 temporal_visibility'; do
  set -- $PAIR
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$1" || continue
  if [ "$(find "$BDIR" -name "$2-$STAMP_GLOB-*.sql.gz" | wc -l)" -eq 0 ]; then
    echo "backup WARNING: $1 is running but no '$2' dump exists for $STAMP_GLOB" >&2
  fi
done
