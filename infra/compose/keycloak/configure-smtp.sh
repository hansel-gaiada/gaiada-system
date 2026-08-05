#!/usr/bin/env bash
# MAIL-03 — push the realm's smtpServer config via kcadm, reading the same KC_SMTP_* env the
# keycloak service container sees (docker-compose.vps.yml). Idempotent (kcadm update, not create).
#
# WHY THIS SCRIPT EXISTS (ex-Q-V6, settled 2026-08-04): Keycloak's realm-import (--import-realm)
# does NOT substitute ${env.*} placeholders anywhere in the imported JSON — proven by importing a
# throwaway realm with smtpServer.host="${env.ZZZ_TEST}" and finding the literal, unexpanded
# string in the persisted realm afterwards. gaiada-realm.json's committed smtpServer block is
# therefore a working DEV DEFAULT (the Mailpit sink), not a template Keycloak fills in. Run this
# script once after a fresh `--import-realm` boot if you need anything other than that default —
# e.g. a different sink host/port, or (in staging) real relay credentials.
#
# Usage: KEYCLOAK_ADMIN_PASSWORD=<pw> ./configure-smtp.sh [base_url] [realm]
#   base_url defaults to http://localhost:8080/idp (in-container); realm defaults to gaiada.
set -euo pipefail

BASE_URL="${1:-http://localhost:8080/idp}"
REALM="${2:-gaiada}"
KC_SMTP_HOST="${KC_SMTP_HOST:-mailpit}"
KC_SMTP_PORT="${KC_SMTP_PORT:-1025}"
KC_SMTP_FROM="${KC_SMTP_FROM:-no-reply@auth.gaiada.invalid}"
KC_SMTP_FROM_DISPLAY_NAME="${KC_SMTP_FROM_DISPLAY_NAME:-Gaiada Auth (dev)}"
KC_SMTP_AUTH="${KC_SMTP_AUTH:-false}"
KC_SMTP_SSL="${KC_SMTP_SSL:-false}"
KC_SMTP_STARTTLS="${KC_SMTP_STARTTLS:-false}"

if [ -z "${KEYCLOAK_ADMIN_PASSWORD:-}" ]; then
  echo "KEYCLOAK_ADMIN_PASSWORD must be set (same value as the keycloak service's bootstrap admin)." >&2
  exit 1
fi

KCADM=/opt/keycloak/bin/kcadm.sh
"$KCADM" config credentials --server "$BASE_URL" --realm master --user admin --password "$KEYCLOAK_ADMIN_PASSWORD"

"$KCADM" update "realms/$REALM" \
  -s "smtpServer.host=$KC_SMTP_HOST" \
  -s "smtpServer.port=$KC_SMTP_PORT" \
  -s "smtpServer.from=$KC_SMTP_FROM" \
  -s "smtpServer.fromDisplayName=$KC_SMTP_FROM_DISPLAY_NAME" \
  -s "smtpServer.auth=$KC_SMTP_AUTH" \
  -s "smtpServer.ssl=$KC_SMTP_SSL" \
  -s "smtpServer.starttls=$KC_SMTP_STARTTLS"

echo "Realm '$REALM' smtpServer set: host=$KC_SMTP_HOST port=$KC_SMTP_PORT from=$KC_SMTP_FROM auth=$KC_SMTP_AUTH ssl=$KC_SMTP_SSL starttls=$KC_SMTP_STARTTLS"
