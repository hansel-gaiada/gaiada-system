#!/bin/sh
# WebDesk (Zone B) — bootstrap the owner/migrator/app role split (WSK-01/03, design §04).
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
# None of the three gets BYPASSRLS: that is the entire point of the split (design §04 —
# "roles webdesk_owner / webdesk_migrator / webdesk_app (NOBYPASSRLS)"), and it is what makes the
# migration-backfill RLS lint (../scripts/lint-migration-rls.mjs) a real guard rather than a
# no-op — a migrator with BYPASSRLS would never hit the silent-zero-rows trap that lint exists
# to catch.
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
	END
	\$\$;

	-- Hand the bootstrap database to the owner role; lock PUBLIC out (platform-nest's own
	-- REVOKE ALL ... FROM PUBLIC precedent).
	ALTER DATABASE ${POSTGRES_DB} OWNER TO ${POSTGRES_OWNER_USER};
	REVOKE ALL ON DATABASE ${POSTGRES_DB} FROM PUBLIC;
	GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${POSTGRES_MIGRATOR_USER}, ${POSTGRES_APP_USER};

	REVOKE ALL ON SCHEMA public FROM PUBLIC;
	GRANT USAGE, CREATE ON SCHEMA public TO ${POSTGRES_MIGRATOR_USER};
	GRANT USAGE ON SCHEMA public TO ${POSTGRES_APP_USER};

	-- New tables/sequences the migrator creates become usable by the app role WITHOUT a
	-- per-migration GRANT statement, mirroring platform-nest's migrations/README.md "you
	-- normally do not need to write GRANTs in a migration" rule.
	ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_MIGRATOR_USER} IN SCHEMA public
	  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_APP_USER};
	ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_MIGRATOR_USER} IN SCHEMA public
	  GRANT USAGE, SELECT ON SEQUENCES TO ${POSTGRES_APP_USER};
EOSQL
