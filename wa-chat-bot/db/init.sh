#!/bin/sh
# Runs once on first `docker compose --profile db up` (fresh volume only).
# Creates the app role the bot connects as. NOBYPASSRLS is what makes the
# messages-table RLS policy actually bind (superusers bypass RLS).
set -e
psql -v ON_ERROR_STOP=1 -U postgres -d gaiada <<EOF
CREATE ROLE gaiada_app LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
GRANT ALL ON SCHEMA public TO gaiada_app;
CREATE DATABASE gaiada_platform OWNER gaiada_app;
CREATE DATABASE gaiada_knowledge OWNER gaiada_app;
EOF
