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
COUNT="$(find "${BACKUP_DIR:-$HOME/gaiada-backups}" -name "gaiada_*-$STAMP_GLOB-*.sql.gz" | wc -l)"
if [ "$COUNT" -lt 5 ]; then
  echo "backup WARNING: only $COUNT DB dumps for $STAMP_GLOB (expected >=5)" >&2
fi
