#!/usr/bin/env bash
# Headless ERP login via the REAL authorization_code + PKCE flow — the same exchange a browser
# performs. Requires NO Keycloak config change: direct-grant stays disabled, which is correct.
#
# Usage:  ./sso-login.sh <email> <password>
# Prints ONLY the access token on stdout. Never echoes the password.
set -euo pipefail

EMAIL="${1:?email required}"
PASSWORD="${2:?password required}"

BASE="https://erp.gaiada.online"
REALM="$BASE/idp/realms/gaiada"
CLIENT_ID="gaiada-ui"
REDIRECT="$BASE/auth/callback"
CJ="$(mktemp)"; trap 'rm -f "$CJ"' EXIT

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
VERIFIER="$(openssl rand -hex 48)"
CHALLENGE="$(printf '%s' "$VERIFIER" | openssl dgst -binary -sha256 | b64url)"
STATE="$(openssl rand -hex 12)"

# 1. Authorization request -> Keycloak login page (captures KC_RESTART / AUTH_SESSION cookies)
LOGIN_PAGE="$(curl -s -c "$CJ" -b "$CJ" -G "$REALM/protocol/openid-connect/auth" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=$REDIRECT" \
  --data-urlencode "response_type=code" \
  --data-urlencode "scope=openid profile email" \
  --data-urlencode "state=$STATE" \
  --data-urlencode "code_challenge=$CHALLENGE" \
  --data-urlencode "code_challenge_method=S256" --max-time 30)"

# 2. Extract the login form action (it carries the session_code/execution/tab_id Keycloak needs)
ACTION="$(printf '%s' "$LOGIN_PAGE" | grep -oE 'action="[^"]+"' | head -1 | sed 's/^action="//; s/"$//' \
  | sed 's/&amp;/\&/g')"
[ -n "$ACTION" ] || { echo "ERR: no login form found (already authenticated, or page shape changed)" >&2; exit 1; }

# 3. Submit credentials; Keycloak 302s to the redirect_uri carrying ?code=
LOC="$(curl -s -o /dev/null -c "$CJ" -b "$CJ" -w '%{redirect_url}' -X POST "$ACTION" \
  --data-urlencode "username=$EMAIL" --data-urlencode "password=$PASSWORD" \
  --data-urlencode "credentialId=" --max-time 30)"
CODE="$(printf '%s' "$LOC" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')"
[ -n "$CODE" ] || { echo "ERR: no authorization code (bad credentials, or an interstitial such as OTP/consent)" >&2; exit 1; }

# 4. Exchange code + verifier for tokens (public client -> no secret needed)
curl -s -X POST "$REALM/protocol/openid-connect/token" \
  -d "grant_type=authorization_code" -d "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "code=$CODE" \
  --data-urlencode "code_verifier=$VERIFIER" --max-time 30 \
| python -c "import sys,json
# newline='' disables Windows' text-mode LF->CRLF translation. Without it, running this from Git
# Bash on Windows emitted the token with a trailing \r: '\$(cat tokenfile)' strips only the \n, so
# every request built from it carried 'Authorization: Bearer <token>\r'. That header is malformed,
# and it is rejected BELOW Fastify's request logger — so the caller sees a bare
# 400 {\"error\":\"Bad Request\",\"message\":\"Client Error\"} and the server logs NOTHING at all.
# On 2026-08-07 that cost a QA agent its run and produced a confident report that the platform was
# 400-ing every authenticated request, when the platform was entirely healthy.
sys.stdout.reconfigure(newline='')
d=json.load(sys.stdin)
print(d['access_token']) if 'access_token' in d else (sys.stderr.write('ERR: '+json.dumps(d)[:200]+chr(10)), sys.exit(1))"
