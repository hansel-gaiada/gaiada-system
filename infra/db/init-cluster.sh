#!/bin/sh
# CORE-instance provisioning (runs ONCE on a fresh Postgres volume via docker-entrypoint-initdb.d).
# Industry-standard role model (DB topology plan 2026-07-15):
#   * one OWNER/migrator role per FIRST-PARTY database — owns objects, runs migrations/DDL (incl
#     CREATE EXTENSION), never used at runtime.
#   * one restricted RUNTIME role per service — NOSUPERUSER NOBYPASSRLS, NOT the owner, DML only.
# Because runtime != owner, both RLS *and* GRANT/REVOKE are real boundaries (fixes the shared
# gaiada_app root cause). sync_app's tight grants are applied POST-migrate by the platform migrate
# runner (RUNTIME_GRANTS_SQL). ALTER DEFAULT PRIVILEGES makes the owner's future tables auto-grant
# to the broad app roles.
#
# THIRD-PARTY apps (Keycloak, n8n) self-manage their schema (they run their own migrations), so
# each gets a SINGLE role that owns its own database — no owner/app split there.
#
# The WhatsApp bot's database lives on a SEPARATE instance (pg-bot / init-bot.sh) for PII
# blast-radius + compliance isolation (DB topology plan Phase E) — it is NOT provisioned here.
set -e

req() { eval "v=\$$1"; [ -n "$v" ] || { echo "init-cluster: \$$1 is required" >&2; exit 1; }; }
for k in PLATFORM_OWNER_PASSWORD PLATFORM_APP_PASSWORD SYNC_APP_PASSWORD \
         KNOWLEDGE_OWNER_PASSWORD KNOWLEDGE_APP_PASSWORD KEYCLOAK_DB_PASSWORD N8N_DB_PASSWORD; do req "$k"; done

# --- Roles (cluster-global) + databases (owned by their owner) ---
psql -v ON_ERROR_STOP=1 -U postgres -d "${POSTGRES_DB:-postgres}" <<SQL
CREATE ROLE platform_owner  LOGIN PASSWORD '${PLATFORM_OWNER_PASSWORD}'  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE knowledge_owner LOGIN PASSWORD '${KNOWLEDGE_OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE platform_app    LOGIN PASSWORD '${PLATFORM_APP_PASSWORD}'    NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE sync_app        LOGIN PASSWORD '${SYNC_APP_PASSWORD}'        NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE knowledge_app   LOGIN PASSWORD '${KNOWLEDGE_APP_PASSWORD}'   NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
-- Third-party self-migrating apps: one role each, owns its own DB (needs DDL for its own schema).
CREATE ROLE keycloak        LOGIN PASSWORD '${KEYCLOAK_DB_PASSWORD}'     NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE n8n             LOGIN PASSWORD '${N8N_DB_PASSWORD}'          NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

CREATE DATABASE gaiada_platform  OWNER platform_owner;
CREATE DATABASE gaiada_knowledge OWNER knowledge_owner;
CREATE DATABASE gaiada_keycloak  OWNER keycloak;
CREATE DATABASE gaiada_n8n       OWNER n8n;
SQL

# --- gaiada_platform: platform_app broad (rw on owner's current+future tables); sync_app narrow ---
psql -v ON_ERROR_STOP=1 -U postgres -d gaiada_platform <<SQL
REVOKE ALL ON DATABASE gaiada_platform FROM PUBLIC;  -- no default PUBLIC connect/temp
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE gaiada_platform TO platform_app, sync_app;
GRANT USAGE ON SCHEMA public TO platform_app, sync_app;
ALTER DEFAULT PRIVILEGES FOR ROLE platform_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_app;
ALTER DEFAULT PRIVILEGES FOR ROLE platform_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO platform_app;
SQL

# --- gaiada_knowledge: knowledge_app broad on owner's tables; vector extension best-effort ---
psql -U postgres -d gaiada_knowledge -c "CREATE EXTENSION IF NOT EXISTS vector" || echo "init-cluster: pgvector unavailable — knowledge will use array fallback"
psql -v ON_ERROR_STOP=1 -U postgres -d gaiada_knowledge <<SQL
REVOKE ALL ON DATABASE gaiada_knowledge FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE gaiada_knowledge TO knowledge_app;
GRANT USAGE ON SCHEMA public TO knowledge_app;
ALTER DEFAULT PRIVILEGES FOR ROLE knowledge_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO knowledge_app;
ALTER DEFAULT PRIVILEGES FOR ROLE knowledge_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO knowledge_app;
SQL

# --- gaiada_keycloak / gaiada_n8n: owned by their app role; lock PUBLIC out (the owner has full rights) ---
psql -v ON_ERROR_STOP=1 -U postgres -d gaiada_keycloak -c "REVOKE ALL ON DATABASE gaiada_keycloak FROM PUBLIC"
psql -v ON_ERROR_STOP=1 -U postgres -d gaiada_n8n      -c "REVOKE ALL ON DATABASE gaiada_n8n FROM PUBLIC"

echo "init-cluster: core provisioned (platform/knowledge owners+apps, sync_app narrow, keycloak+n8n self-owned; bot DB is on pg-bot)"
