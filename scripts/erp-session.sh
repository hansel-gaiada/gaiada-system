#!/usr/bin/env bash
# Drive the REAL browser SSO flow end to end and keep the resulting app session,
# so authenticated pages can be fetched as server-rendered HTML.
#
# scripts/sso-login.sh stops at a bearer token: it starts the authorize request
# ITSELF, so Next never sets its PKCE cookie and never completes /auth/callback.
# That yields an API token but no `gaiada_session`, and therefore no page.
# This starts at /auth/login instead, exactly as a browser does.
#
# Never echoes the password. Prints only status lines and writes the cookie jar.
set -euo pipefail

BASE="https://erp.gaiada.online"
EMAIL="${1:?email required}"
PASSWORD="${2:?password required}"
JAR="${3:?cookie jar path required}"
: > "$JAR"

CURL=(curl -sS --max-time 45 -c "$JAR" -b "$JAR")

# 1. App-initiated authorize. Next stashes verifier+state in an httpOnly cookie
#    and 302s to Keycloak.
KC_URL="$("${CURL[@]}" -o /dev/null -w '%{redirect_url}' "$BASE/auth/login")"
[ -n "$KC_URL" ] || { echo "FAIL: /auth/login did not redirect" >&2; exit 1; }
echo "1. /auth/login -> Keycloak authorize   OK"

# 2. Keycloak login page (sets its own session cookies in the same jar).
PAGE="$("${CURL[@]}" -L "$KC_URL")"
ACTION="$(printf '%s' "$PAGE" | grep -oE 'action="[^"]+"' | head -1 | sed 's/^action="//; s/"$//; s/&amp;/\&/g')"
[ -n "$ACTION" ] || { echo "FAIL: no login form (already authenticated, or page shape changed)" >&2; exit 1; }
echo "2. login form captured                 OK"

# 3. Submit credentials -> 302 back to the app's /auth/callback carrying ?code=
CB="$("${CURL[@]}" -o /dev/null -w '%{redirect_url}' -X POST "$ACTION" \
      --data-urlencode "username=$EMAIL" --data-urlencode "password=$PASSWORD" \
      --data-urlencode "credentialId=")"
case "$CB" in
  *code=*) echo "3. credentials accepted                OK" ;;
  *) echo "FAIL: no authorization code (bad credentials, or an OTP/consent interstitial)" >&2; exit 1 ;;
esac

# 4. Let the APP consume the code. This is the step sso-login.sh skips, and the
#    one that mints the session cookie: `__Host-gaiada_session` in production (B0, the
#    `__Host-` prefix), plain `gaiada_session` on a `next dev` stack. Matched on the jar's
#    NAME column (field 6) exactly, so either spelling counts and nothing else does.
"${CURL[@]}" -o /dev/null -w '' -L "$CB" || true
if awk -F'\t' '$6 == "__Host-gaiada_session" || $6 == "gaiada_session" { found = 1 } END { exit !found }' "$JAR"; then
  echo "4. /auth/callback -> session cookie    OK"
else
  echo "FAIL: callback set no session cookie" >&2; exit 1
fi
echo "session ready"
