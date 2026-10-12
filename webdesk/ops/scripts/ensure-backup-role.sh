#!/bin/sh
# WSK-68 -- create / verify the read-only BYPASSRLS backup role on an EXISTING WebDesk cluster.
#
# New clusters get `webdesk_backup` from webdesk/postgres/init-roles.sh. That script only runs at
# first cluster init, so the live cluster (and any older dev one) needs this instead. Idempotent:
# a second run changes nothing and says so.
#
# Why the role exists (owner ruling WSK-D48 (6)): every WebDesk tenant table is FORCE RLS, so a
# pg_dump as webdesk_owner / webdesk_migrator / webdesk_app reads zero rows or errors. A read-only
# BYPASSRLS role is the narrowest identity that yields a REAL dump without disarming RLS and
# without handing the backup job the cluster superuser. It has no password (cannot log in over TCP);
# the only way in is the unix socket inside the container.
#
# Run on the docker host, as a user that can `docker exec`:
#   sh webdesk/ops/scripts/ensure-backup-role.sh
# Env (all optional):
#   WEBDESK_PG_CONTAINER   default webdesk-postgres-1
#   WEBDESK_DB             default: the container's POSTGRES_DB
#   WEBDESK_MIGRATOR_ROLE  default webdesk_migrator (the role whose future tables get SELECT for backup)
#   WEBDESK_DOCKER_HOST    M4 F6: the daemon that runs WebDesk; unset = /etc/default/webdesk-docker (written by
#                          the rootless cut-over), else the rootful daemon
#
# Connects as the cluster superuser, read from the container's own POSTGRES_USER (no credential
# is passed or stored: the official image keeps `local all all trust` on the socket).
#
# Exit: 0 = role is in the desired state (created, repaired, or already fine)
#       1 = REFUSED: the role exists with a write grant or a dangerous attribute -- it is NOT
#           touched; a human must look (someone widened it)
#       2 = usage / environment problem (container missing, bad name)
set -eu

ROLE=webdesk_backup
CONTAINER="${WEBDESK_PG_CONTAINER:-webdesk-postgres-1}"
MIGRATOR="${WEBDESK_MIGRATOR_ROLE:-webdesk_migrator}"

die() { echo "ensure-backup-role: $*" >&2; exit 2; }
refuse() { echo "ensure-backup-role: REFUSED: $*" >&2; exit 1; }

safe_ident() { # <what> <value>
  case "$2" in
    "" | *[!A-Za-z0-9_]*) die "$1 '$2' is not a plain identifier ([A-Za-z0-9_]+)" ;;
  esac
}

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

WD_DOCKER_HOST="$(wd_docker_host)" || die "WEBDESK_DOCKER_HOST (or /etc/default/webdesk-docker) must be unix:///run/user/<uid>/docker.sock"
if [ -n "$WD_DOCKER_HOST" ]; then DOCKER_HOST="$WD_DOCKER_HOST"; export DOCKER_HOST; fi

docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || die "container $CONTAINER is not running"

SU="$(docker exec "$CONTAINER" printenv POSTGRES_USER 2>/dev/null || true)"
[ -n "$SU" ] || SU=postgres   # the image's own default when POSTGRES_USER is unset
DB="${WEBDESK_DB:-$(docker exec "$CONTAINER" printenv POSTGRES_DB 2>/dev/null || true)}"
[ -n "$DB" ] || DB="$SU"      # the image defaults POSTGRES_DB to POSTGRES_USER
safe_ident "superuser" "$SU"
safe_ident "database" "$DB"
safe_ident "migrator role" "$MIGRATOR"

# One psql per statement/batch: -X no psqlrc, -q quiet, -A -t unaligned tuples only.
q() { docker exec -i "$CONTAINER" psql -U "$SU" -d "$DB" -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }

# 1. Does it exist, and is it safe to touch? --------------------------------------------------------
ATTRS="$(q -c "SELECT concat(rolsuper::int, rolcreaterole::int, rolcreatedb::int, rolreplication::int)
                 FROM pg_roles WHERE rolname = '$ROLE'")"
EXISTS=0
if [ -n "$ATTRS" ]; then
  EXISTS=1
  [ "$ATTRS" = "0000" ] || refuse "role $ROLE exists with a dangerous attribute (super/createrole/createdb/replication = $ATTRS). Not touching it."

  # Any privilege that is not SELECT, on any relation outside the system schemas. has_table_privilege
  # also sees PUBLIC grants; the column-level probes catch a column-scoped INSERT/UPDATE/REFERENCES.
  WRITES="$(q <<EOSQL
SELECT n.nspname || '.' || c.relname || ' ' || p.priv
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
   AND has_table_privilege('$ROLE', c.oid, p.priv)
UNION ALL
SELECT n.nspname || '.' || c.relname || ' (column) ' || p.priv
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(priv)
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
   AND has_any_column_privilege('$ROLE', c.oid, p.priv)
UNION ALL
SELECT n.nspname || '.' || c.relname || ' (sequence) UPDATE'
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
   AND c.relkind = 'S'
   AND has_table_privilege('$ROLE', c.oid, 'UPDATE')
UNION ALL
SELECT 'member of role ' || g.rolname
  FROM pg_auth_members m
  JOIN pg_roles g ON g.oid = m.roleid
  JOIN pg_roles r ON r.oid = m.member
 WHERE r.rolname = '$ROLE'
EOSQL
)"
  if [ -n "$WRITES" ]; then
    echo "ensure-backup-role: $ROLE holds more than read access:" >&2
    printf '%s\n' "$WRITES" | sed 's/^/  /' >&2
    refuse "role $ROLE is not read-only. Not touching it; find out who widened it and why."
  fi
fi

# 2. Is everything already in the desired state? ----------------------------------------------------
# Prints 'ok' only when the role, its attributes, its role setting, CONNECT, schema USAGE, SELECT on
# every existing table/sequence in public, and the migrator's default privileges are ALL in place.
state_ok() {
  [ "$EXISTS" = 1 ] || return 1
  OK="$(q <<EOSQL
SELECT CASE WHEN
      EXISTS (SELECT 1 FROM pg_roles
               WHERE rolname = '$ROLE' AND rolcanlogin AND NOT rolsuper AND rolbypassrls AND NOT rolinherit
                 AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
                 AND 'default_transaction_read_only=on' = ANY (rolconfig))
  AND has_database_privilege('$ROLE', current_database(), 'CONNECT')
  AND has_schema_privilege('$ROLE', 'public', 'USAGE')
  AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                     AND NOT has_table_privilege('$ROLE', c.oid, 'SELECT'))
  AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relkind = 'S'
                     AND NOT has_table_privilege('$ROLE', c.oid, 'SELECT'))
  AND (SELECT count(DISTINCT d.defaclobjtype)
         FROM pg_default_acl d
         CROSS JOIN LATERAL aclexplode(d.defaclacl) a
         JOIN pg_roles mr ON mr.oid = d.defaclrole
         JOIN pg_roles br ON br.oid = a.grantee
        WHERE mr.rolname = '$MIGRATOR' AND d.defaclnamespace = 'public'::regnamespace
          AND br.rolname = '$ROLE' AND a.privilege_type = 'SELECT'
          AND d.defaclobjtype IN ('r', 'S')) = 2
  THEN 'ok' ELSE 'drift' END
EOSQL
)"
  [ "$OK" = ok ]
}

if state_ok; then
  echo "ensure-backup-role: unchanged -- $ROLE already in the desired state on $CONTAINER/$DB"
  exit 0
fi

# 3. Create / repair. Every statement is idempotent. ------------------------------------------------
# No PASSWORD, ever: scram-sha-256 over TCP then fails for this role, leaving the unix socket inside
# the container as the only way in.
q <<EOSQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$ROLE') THEN
    CREATE ROLE $ROLE LOGIN NOSUPERUSER BYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
\$\$;
ALTER ROLE $ROLE LOGIN NOSUPERUSER BYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE $ROLE SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE "$DB" TO $ROLE;
GRANT USAGE ON SCHEMA public TO $ROLE;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO $ROLE;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO $ROLE;
ALTER DEFAULT PRIVILEGES FOR ROLE $MIGRATOR IN SCHEMA public GRANT SELECT ON TABLES TO $ROLE;
ALTER DEFAULT PRIVILEGES FOR ROLE $MIGRATOR IN SCHEMA public GRANT SELECT ON SEQUENCES TO $ROLE;
EOSQL

# 4. Prove it took (a repair that silently did not apply is the failure this guards against). --------
state_ok_after() { EXISTS=1; state_ok; }
if state_ok_after; then
  if [ "$ATTRS" = "" ]; then
    echo "ensure-backup-role: CHANGED -- created $ROLE (read-only BYPASSRLS, no password) on $CONTAINER/$DB"
  else
    echo "ensure-backup-role: CHANGED -- repaired $ROLE (attributes/grants had drifted) on $CONTAINER/$DB"
  fi
  exit 0
fi
refuse "applied the grants but $ROLE is still not in the desired state; inspect it with \\du+ and \\ddp"
