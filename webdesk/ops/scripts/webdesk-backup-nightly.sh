#!/usr/bin/env bash
# WSK-68 -- nightly WebDesk Postgres dump on the live box (gda-aicenter). Owner ruling WSK-D48 (6).
#
# Dumps the WebDesk database as the read-only BYPASSRLS role `webdesk_backup` (created by
# webdesk/postgres/init-roles.sh on new clusters, ops/scripts/ensure-backup-role.sh on existing
# ones) over the unix socket inside the container (`local all all trust`; the role has no password).
# Every tenant table is FORCE RLS, so a dump by any other non-superuser role is empty or fails; that
# is the failure this script verifies against, loudly, on every run.
#
# The file lands in the SAME directory the ERP backup uses, with the same name shape
# (`<db>-<UTC YYYYmmdd-HHMMSS>.sql.gz`, as infra/scripts/backup.sh writes), so sumopod's existing
# nightly pull (04:15 UTC, infra/scripts/erp-backup-read.sh: top-level *.sql.gz, names
# [A-Za-z0-9_.-], no leading dot; age-encrypted, kept 90 days) picks it up with no change there.
# Exactly one file is written: no .meta sidecar, because the puller only takes *.sql.gz/*.tar.gz.
#
# Install (03:05 UTC, ten minutes before the ERP's 03:15 run):
#   5 3 * * * $HOME/gaiada-webdesk/webdesk/ops/scripts/webdesk-backup-nightly.sh >> $HOME/gaiada-backups/webdesk-backup.log 2>&1
#
# Env (all optional):
#   WEBDESK_PG_CONTAINER  default webdesk-postgres-1
#   WEBDESK_DB            default: the container's POSTGRES_DB (else "webdesk")
#   WEBDESK_BACKUP_DIR    default $HOME/gaiada-backups
#   KEEP_DAYS             default 14 (this script's own webdesk-*.sql.gz only)
#   WEBDESK_DOCKER_HOST   M4 F6: the daemon that runs WebDesk; unset = /etc/default/webdesk-docker (written by the
#                         rootless cut-over), else the rootful daemon. The cron line needs no change.
#
# Exit 0 = a verified dump was written. Non-zero = nothing was published; the reason is on stderr.
# One summary line on success:  ... webdesk-backup ok file=<path> bytes=<n> tables=<n> tenants=<n>
set -euo pipefail
umask 077

# M4 F6 (WSK-D73): the Docker daemon that runs WebDesk. Empty = the rootful daemon, exactly as before.
# WEBDESK_DOCKER_HOST, when SET (even to ""), wins; else the host switch /etc/default/webdesk-docker, which
# the rootless cut-over writes and its rollback deletes; else empty. Only a rootless socket path is accepted.
# POSIX sh, and byte-identical in every script that resolves the daemon (test-rootless.sh compares them).
wd_docker_host() {
  _wdh_f="${WEBDESK_DOCKER_SWITCH:-/etc/default/webdesk-docker}"
  if [ -n "${WEBDESK_DOCKER_HOST+set}" ]; then _wdh_v="$WEBDESK_DOCKER_HOST"
  elif [ -r "$_wdh_f" ]; then _wdh_v="$(sed -n 's/^WEBDESK_DOCKER_HOST=//p' "$_wdh_f" | tail -n 1)"
  else _wdh_v=""
  fi
  _wdh_v="${_wdh_v%\"}"; _wdh_v="${_wdh_v#\"}"
  case "$_wdh_v" in
    "") return 0 ;;
    unix:///run/user/*/docker.sock)
      _wdh_u="${_wdh_v#unix:///run/user/}"; _wdh_u="${_wdh_u%/docker.sock}"
      case "$_wdh_u" in "" | 0* | *[!0-9]*) return 1 ;; esac ;;
    *) return 1 ;;
  esac
  printf '%s\n' "$_wdh_v"
}

CONTAINER="${WEBDESK_PG_CONTAINER:-webdesk-postgres-1}"
BACKUP_ROLE=webdesk_backup
BACKUP_DIR="${WEBDESK_BACKUP_DIR:-$HOME/gaiada-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
# Tables whose COPY block MUST be present, and the one that must also carry rows.
REQUIRED_TABLES="tenants content_items"
ROWS_TABLE=tenants

log() { printf '%s webdesk-backup %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { printf '%s webdesk-backup FAILED: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; exit 1; }

case "$KEEP_DAYS" in '' | *[!0-9]*) fail "KEEP_DAYS '$KEEP_DAYS' is not a whole number" ;; esac
WD_DOCKER_HOST="$(wd_docker_host)" || fail "WEBDESK_DOCKER_HOST (or /etc/default/webdesk-docker) must be unix:///run/user/<uid>/docker.sock"
[ -z "$WD_DOCKER_HOST" ] || export DOCKER_HOST="$WD_DOCKER_HOST"
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || fail "container $CONTAINER is not running${WD_DOCKER_HOST:+ on $WD_DOCKER_HOST}"

DB="${WEBDESK_DB:-$(docker exec "$CONTAINER" printenv POSTGRES_DB 2>/dev/null || true)}"
DB="${DB:-webdesk}"
case "$DB" in *[!A-Za-z0-9_]*) fail "database name '$DB' is not a plain identifier" ;; esac

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u '+%Y%m%d-%H%M%S')"
FINAL="$BACKUP_DIR/webdesk-$STAMP.sql.gz"

# Scratch space inside the backup dir (same filesystem, so the final rename is atomic). The leading
# dot keeps it invisible to the puller, which refuses dot-names and only lists *.sql.gz anyway.
WORK="$(mktemp -d "$BACKUP_DIR/.webdesk-backup.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# 1. pg_dump to a plain file. Never `pg_dump | gzip`: this exit status must be pg_dump's own.
#    --no-owner: the restore target will not have webdesk_migrator (roles are in the globals dump).
if ! docker exec "$CONTAINER" pg_dump -U "$BACKUP_ROLE" -d "$DB" --no-owner > "$WORK/dump.sql" 2> "$WORK/pg_dump.err"; then
  fail "pg_dump as $BACKUP_ROLE failed on $CONTAINER/$DB: $(tr '\n' ' ' < "$WORK/pg_dump.err" | cut -c1-400). Does the role exist and have BYPASSRLS? Run webdesk/ops/scripts/ensure-backup-role.sh"
fi
[ -s "$WORK/dump.sql" ] || fail "pg_dump exited 0 but wrote nothing"

# 2. gzip to a temp name.
gzip -c "$WORK/dump.sql" > "$WORK/out.gz" || fail "gzip failed"

# 3. Verify BEFORE publishing, so a bad dump never becomes a file the puller can take.
gzip -t "$WORK/out.gz" || fail "gzip -t rejected the compressed dump"

# One pass over the dump: every COPY public.<t> block, and the row count of each (the lines between
# `COPY public.<t> ...` and the terminating `\.`). Prints "<table> <rows>" per block.
COUNTS="$(gzip -dc "$WORK/out.gz" | awk '
  incopy { if ($0 == "\\.") incopy = 0; else rows[name]++; next }
  /^COPY public\./ { name = $2; sub(/^public\./, "", name); gsub(/"/, "", name); rows[name] += 0; incopy = 1; next }
  END { for (t in rows) print t, rows[t] }
')" || fail "could not read back the compressed dump"

TABLES="$(printf '%s\n' "$COUNTS" | grep -c . || true)"
for T in $REQUIRED_TABLES; do
  printf '%s\n' "$COUNTS" | grep "^$T " > /dev/null || fail "dump has no 'COPY public.$T' data block ($TABLES COPY block(s) found) -- an RLS-blinded or wrong-database dump"
done
TENANTS="$(printf '%s\n' "$COUNTS" | awk -v t="$ROWS_TABLE" '$1 == t { print $2 }')"
[ "${TENANTS:-0}" -gt 0 ] || fail "dump has ZERO rows in public.$ROWS_TABLE -- the backup role is not bypassing RLS (is $BACKUP_ROLE BYPASSRLS? run ensure-backup-role.sh)"

# 3b. The cluster's ROLES, without password hashes (owner ruling 2026-10-12, M4: the ERP's backup.sh no longer dumps
#     WebDesk at all, neither data nor globals, so this script is WebDesk's only backup). `pg_dumpall --globals-only
#     --no-role-passwords` reads pg_roles, which a non-superuser may read. It carries every role and its attributes
#     (BYPASSRLS on webdesk_backup, the read-only default), so a restore rebuilds the policies' roles. The passwords
#     come from /etc/webdesk/.env at restore time. The file name keeps the offsite per-source metric
#     (source "globals-webdesk") fresh.
GLOBALS_FINAL="$BACKUP_DIR/globals-webdesk-$STAMP.sql.gz"
if ! docker exec "$CONTAINER" pg_dumpall -U "$BACKUP_ROLE" --globals-only --no-role-passwords > "$WORK/globals.sql" 2> "$WORK/globals.err"; then
  fail "pg_dumpall --globals-only as $BACKUP_ROLE failed: $(tr '\n' ' ' < "$WORK/globals.err" | cut -c1-300)"
fi
for R in webdesk_owner webdesk_migrator webdesk_app webdesk_backup; do
  grep -q "^CREATE ROLE $R;" "$WORK/globals.sql" || fail "the globals dump lacks role $R"
done
! grep -qi 'SCRAM-SHA-256\$' "$WORK/globals.sql" || fail "the globals dump carries a password hash (it must not)"
gzip -c "$WORK/globals.sql" > "$WORK/globals.gz" && gzip -t "$WORK/globals.gz" || fail "gzip of the globals dump failed"

# 4. Publish: atomic renames within one filesystem (both verified above).
chmod 600 "$WORK/out.gz" "$WORK/globals.gz"
mv "$WORK/out.gz" "$FINAL"
mv "$WORK/globals.gz" "$GLOBALS_FINAL"
BYTES="$(wc -c < "$FINAL" | tr -d ' ')"

# 5. Prune this script's own old dumps (data and globals). Since 2026-10-12 nothing else writes these globs.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'webdesk-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'globals-webdesk-*.sql.gz' -mtime "+$KEEP_DAYS" -delete

log "ok file=$FINAL bytes=$BYTES tables=$TABLES tenants=$TENANTS globals=${GLOBALS_FINAL##*/}"
