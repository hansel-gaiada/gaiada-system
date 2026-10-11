#!/bin/sh
# WebDesk (Zone B) — bootstrap the owner/migrator/app role split (WSK-01/03, design §04) plus the
# read-only backup role (WSK-68).
#
# Runs once, on first cluster init, via docker-entrypoint-initdb.d, connected as the CLUSTER
# SUPERUSER ($POSTGRES_USER — a Postgres-image bootstrap identity, never used by any application
# code or migration). It creates three ordinary, NOSUPERUSER, **NOBYPASSRLS** roles and hands the
# target database to them — mirroring platform-nest's `infra/db/init-cluster.sh` pattern
# (`CREATE ROLE ... NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, run by the cluster
# superuser, never by an app-visible role):
#
#   - webdesk_owner    — nominal database owner (custody role; WSK-03 refines what, if anything,
#                        it does at runtime beyond owning the database itself).
#   - webdesk_migrator — runs migrations/*.sql (MIGRATE_DATABASE_URL). Granted CREATE on schema
#                        public so it can execute DDL; the objects it creates are owned by IT
#                        (WSK-03 may reassign ownership to webdesk_owner as schema work matures —
#                        not done here, this ticket only stands the roles up).
#   - webdesk_app      — the runtime role every service connects as. DML only, via
#                        ALTER DEFAULT PRIVILEGES on webdesk_migrator's future objects (the same
#                        "you don't normally write GRANTs in a migration" hand-off platform-nest
#                        uses) — never DDL, never BYPASSRLS.
#
# None of those three gets BYPASSRLS: that is the entire point of the split (design §04 —
# "roles webdesk_owner / webdesk_migrator / webdesk_app (NOBYPASSRLS)"), and it is what makes the
# migration-backfill RLS lint (../scripts/lint-migration-rls.mjs) a real guard rather than a
# no-op — a migrator with BYPASSRLS would never hit the silent-zero-rows trap that lint exists
# to catch.
#
# THE FOURTH ROLE (WSK-68, owner ruling WSK-D48 (6)) is the one deliberate BYPASSRLS role:
#
#   - webdesk_backup   — read-only, socket-only, for the nightly pg_dump
#                        (ops/scripts/webdesk-backup-nightly.sh). Every tenant table is FORCE RLS,
#                        so a dump by any of the three roles above reads ZERO rows (or fails with
#                        "query would be affected by row-level security policy"); a superuser dump
#                        works but hands the backup job the keys to the whole cluster. BYPASSRLS
#                        without write access is the narrowest identity that produces a real dump.
#                        It holds NO password: scram-sha-256 over TCP therefore fails for it, and
#                        the only way in is the unix socket inside the container (`docker exec`,
#                        where the official image keeps `local all all trust`) — i.e. only someone
#                        who already controls the docker daemon. Read-only is enforced twice: it is
#                        granted SELECT and nothing else (default privileges below, GRANT SELECT
#                        for existing objects by ops/scripts/ensure-backup-role.sh), and
#                        `default_transaction_read_only = on` is set on the role. It is NOINHERIT
#                        and a member of nothing. scripts/check-rls-integrity.mjs permits exactly
#                        this role to hold BYPASSRLS, and only while it stays read-only.
#                        Existing clusters (init scripts do not re-run) get it from
#                        ops/scripts/ensure-backup-role.sh.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	DO \$\$
	BEGIN
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${POSTGRES_OWNER_USER}') THEN
	    CREATE ROLE ${POSTGRES_OWNER_USER}
	      LOGIN PASSWORD '${POSTGRES_OWNER_PASSWORD}'
	      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${POSTGRES_MIGRATOR_USER}') THEN
	    CREATE ROLE ${POSTGRES_MIGRATOR_USER}
	      LOGIN PASSWORD '${POSTGRES_MIGRATOR_PASSWORD}'
	      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${POSTGRES_APP_USER}') THEN
	    CREATE ROLE ${POSTGRES_APP_USER}
	      LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}'
	      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
	  END IF;
	  -- WSK-68: the one BYPASSRLS role. No PASSWORD on purpose (see header).
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'webdesk_backup') THEN
	    CREATE ROLE webdesk_backup
	      LOGIN NOSUPERUSER BYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
	  END IF;
	END
	\$\$;

	ALTER ROLE webdesk_backup SET default_transaction_read_only = on;

	-- Hand the bootstrap database to the owner role; lock PUBLIC out (platform-nest's own
	-- REVOKE ALL ... FROM PUBLIC precedent).
	ALTER DATABASE ${POSTGRES_DB} OWNER TO ${POSTGRES_OWNER_USER};
	REVOKE ALL ON DATABASE ${POSTGRES_DB} FROM PUBLIC;
	GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${POSTGRES_MIGRATOR_USER}, ${POSTGRES_APP_USER};
	GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO webdesk_backup;

	REVOKE ALL ON SCHEMA public FROM PUBLIC;
	GRANT USAGE, CREATE ON SCHEMA public TO ${POSTGRES_MIGRATOR_USER};
	GRANT USAGE ON SCHEMA public TO ${POSTGRES_APP_USER};
	GRANT USAGE ON SCHEMA public TO webdesk_backup;

	-- New tables/sequences the migrator creates become usable by the app role WITHOUT a
	-- per-migration GRANT statement, mirroring platform-nest's migrations/README.md "you
	-- normally do not need to write GRANTs in a migration" rule.
	ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_MIGRATOR_USER} IN SCHEMA public
	  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_APP_USER};
	ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_MIGRATOR_USER} IN SCHEMA public
	  GRANT USAGE, SELECT ON SEQUENCES TO ${POSTGRES_APP_USER};

	-- WSK-68: the backup role reads whatever the migrator creates, and nothing else (SELECT only,
	-- on tables and sequences; pg_dump reads sequence state with SELECT).
	ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_MIGRATOR_USER} IN SCHEMA public
	  GRANT SELECT ON TABLES TO webdesk_backup;
	ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_MIGRATOR_USER} IN SCHEMA public
	  GRANT SELECT ON SEQUENCES TO webdesk_backup;
EOSQL
