#!/bin/sh
# ISOLATED bot-instance provisioning (pg-bot). The WhatsApp bot's store holds raw-WA PII +
# crypto-shred keys — a different sensitivity/lifecycle from the ERP, so it lives on its OWN
# Postgres instance (DB topology plan Phase E: blast-radius + DPIA/employee-monitoring isolation).
# Same owner/migrator + runtime split as the core: bot_owner runs DDL, bot_app is DML-only.
set -e

req() { eval "v=\$$1"; [ -n "$v" ] || { echo "init-bot: \$$1 is required" >&2; exit 1; }; }
for k in BOT_OWNER_PASSWORD BOT_APP_PASSWORD; do req "$k"; done

psql -v ON_ERROR_STOP=1 -U postgres -d "${POSTGRES_DB:-postgres}" <<SQL
CREATE ROLE bot_owner LOGIN PASSWORD '${BOT_OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE bot_app   LOGIN PASSWORD '${BOT_APP_PASSWORD}'   NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE gaiada_bot OWNER bot_owner;
SQL

psql -v ON_ERROR_STOP=1 -U postgres -d gaiada_bot <<SQL
REVOKE ALL ON DATABASE gaiada_bot FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE gaiada_bot TO bot_app;
GRANT USAGE ON SCHEMA public TO bot_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bot_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bot_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bot_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO bot_app;
SQL

echo "init-bot: isolated bot instance provisioned (bot_owner migrator + bot_app runtime; gaiada_bot)"
