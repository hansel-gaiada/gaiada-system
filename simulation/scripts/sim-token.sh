#!/usr/bin/env bash
# Mint a real ERP access token for one seeded staff account, WITHOUT the password ever leaving the
# server.
#
# This is `scripts/sso-login.sh` (the verified authorization_code + PKCE flow) relocated to run ON
# the box, reading the shared simulation password from the root-only /etc/gaiada/sim-staff.pw that
# `enable-staff-logins.sh` created. The caller gets one thing on stdout: an access token that
# expires on its own. That is the whole point — a developer machine driving 19 identities never
# needs, and never receives, 19 passwords.
#
# Requires `enable-staff-logins.sh` to have run first (otherwise Keycloak answers with the
# UPDATE_PASSWORD interstitial and there is no authorization code to exchange).
#
# Usage:  ./sim-token.sh reva@gaiada.com
#         SSH_HOST=gda-aicenter ./sim-token.sh reva@gaiada.com
set -euo pipefail

EMAIL="${1:?email required, e.g. reva@gaiada.com}"
SSH_HOST="${SSH_HOST:-gda-aicenter}"

ssh -o ConnectTimeout=30 "$SSH_HOST" "EMAIL='$EMAIL' bash -s" <<'REMOTE'
set -euo pipefail

PASSWORD="$(sudo -n cat /etc/gaiada/sim-staff.pw)"
[ -n "$PASSWORD" ] || { echo "ERR: /etc/gaiada/sim-staff.pw missing or empty — run enable-staff-logins.sh" >&2; exit 1; }

# Loopback rather than the public hostname: the box can reach its own nginx, and this keeps the
# whole exchange off the public internet. KC_HOSTNAME is set to the public URL, so Keycloak still
# issues an issuer/redirect matching what the UI uses.
BASE="https://erp.gaiada.online"
REALM="$BASE/idp/realms/gaiada"
CLIENT_ID="gaiada-ui"
REDIRECT="$BASE/auth/callback"
CJ="$(mktemp)"; trap 'rm -f "$CJ"' EXIT

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
VERIFIER="$(openssl rand -hex 48)"
CHALLENGE="$(printf '%s' "$VERIFIER" | openssl dgst -binary -sha256 | b64url)"
STATE="$(openssl rand -hex 12)"

LOGIN_PAGE="$(curl -s -c "$CJ" -b "$CJ" -G "$REALM/protocol/openid-connect/auth" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=$REDIRECT" \
  --data-urlencode "response_type=code" \
  --data-urlencode "scope=openid profile email" \
  --data-urlencode "state=$STATE" \
  --data-urlencode "code_challenge=$CHALLENGE" \
  --data-urlencode "code_challenge_method=S256" --max-time 30)"

ACTION="$(printf '%s' "$LOGIN_PAGE" | grep -oE 'action="[^"]+"' | head -1 | sed 's/^action="//; s/"$//' | sed 's/&amp;/\&/g')"
[ -n "$ACTION" ] || { echo "ERR: no login form (already authenticated, or page shape changed)" >&2; exit 1; }

LOC="$(curl -s -o /dev/null -c "$CJ" -b "$CJ" -w '%{redirect_url}' -X POST "$ACTION" \
  --data-urlencode "username=$EMAIL" --data-urlencode "password=$PASSWORD" \
  --data-urlencode "credentialId=" --max-time 30)"
CODE="$(printf '%s' "$LOC" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')"
if [ -z "$CODE" ]; then
  # The single most likely cause, called out by name because the generic message cost a real
  # session once (see sso-login.sh's own note): a pending required action.
  echo "ERR: no authorization code for $EMAIL — most likely UPDATE_PASSWORD is still pending (run enable-staff-logins.sh), or the password file no longer matches Keycloak" >&2
  exit 1
fi

curl -s -X POST "$REALM/protocol/openid-connect/token" \
  -d "grant_type=authorization_code" -d "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "code=$CODE" \
  --data-urlencode "code_verifier=$VERIFIER" --max-time 30 \
| python3 -c "import sys,json
# newline='' — the same Windows CRLF trap sso-login.sh documents: a trailing \r on the token
# produces a malformed Authorization header, rejected BELOW Fastify's logger, so the caller sees a
# bare 400 and the server logs nothing at all.
sys.stdout.reconfigure(newline='')
d=json.load(sys.stdin)
print(d['access_token']) if 'access_token' in d else (sys.stderr.write('ERR: '+json.dumps(d)[:200]+chr(10)), sys.exit(1))"
REMOTE
