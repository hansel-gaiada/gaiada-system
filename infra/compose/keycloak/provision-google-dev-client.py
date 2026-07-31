#!/usr/bin/env python3
"""Provision the Keycloak `google-dev` realm client — SM-51's local OAuth issuer (design addendum §A12.3).

WHAT THIS IS FOR. The search-marketing module needs Google Search Console / GA4 / Ads access, which is
per-client OAuth. Obtaining a Google OAuth client gates ACCEPTANCE (SM-41G), not construction: the
authorization-code + PKCE machine path is fully exercisable against a real, standards-compliant issuer,
and this stack already runs one. This script creates a confidential realm client whose contract matches
what a Google web-server client presents: authorization-code flow, an exactly-registered redirect URI,
PKCE S256 REQUIRED, refresh tokens issued, and RFC-7009 revocation available.

WHAT IT DELIBERATELY DOES NOT AND CANNOT DO — SM-41G's clauses, restated here because this script is
where an operator forms their expectations:
  * Google's consent screen, incremental consent, and what a Google scope STRING actually grants. The
    client below is given scope names that MIRROR Google's; a mirrored name proves serialization, never
    semantics.
  * refresh-token longevity under an OAuth app's publish status. A Google app in Testing mode has
    refresh tokens that expire after 7 DAYS. Keycloak's lifespans are unrelated and cannot rehearse it.
  * Google-side revocation behaviour, quota/429 behaviour, and the Ads developer-token approval +
    MCC/login-customer-id semantics.
A green round trip against this client means our OAuth machinery is correct against a real issuer. It
does not mean the Google integration works.

USAGE (idempotent — re-running updates the client in place and re-prints the secret):

    KEYCLOAK_ADMIN_PASSWORD=... python provision-google-dev-client.py
    KC_URL=http://localhost:8080 GOOGLE_DEV_REDIRECT_URI=http://localhost:3004/api/search/google/oauth/callback \\
      KEYCLOAK_ADMIN_PASSWORD=... python provision-google-dev-client.py

Then point the platform's seams at it (platform-nest/.env):

    GOOGLE_OAUTH_CLIENT_ID=google-dev
    GOOGLE_OAUTH_CLIENT_SECRET=<printed below>
    GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3004/api/search/google/oauth/callback
    GOOGLE_OAUTH_AUTHORIZE_URL=http://localhost:8080/realms/gaiada/protocol/openid-connect/auth
    GOOGLE_OAUTH_TOKEN_URL=http://localhost:8080/realms/gaiada/protocol/openid-connect/token
    GOOGLE_OAUTH_REVOKE_URL=http://localhost:8080/realms/gaiada/protocol/openid-connect/revoke
    SEARCH_ALLOW_PRIVATE_GOOGLE_ENDPOINT=1   # REQUIRED: the §A10.4/§A12.3 boot guard refuses a private
                                             # issuer in live mode precisely so this cannot happen by
                                             # accident. Setting it is the deliberate local opt-in.
"""
import json, os, sys, urllib.request, urllib.parse, urllib.error

KC = os.environ.get("KC_URL", "http://localhost:8080")
REALM = os.environ.get("KC_REALM", "gaiada")
ADMIN_PW = os.environ.get("KEYCLOAK_ADMIN_PASSWORD") or os.environ.get("KC_ADMIN_PASSWORD")
CLIENT_ID = os.environ.get("GOOGLE_DEV_CLIENT_ID", "google-dev")
CLIENT_SECRET = os.environ.get("GOOGLE_DEV_CLIENT_SECRET", "google-dev-secret")
REDIRECT_URI = os.environ.get(
    "GOOGLE_DEV_REDIRECT_URI", "http://localhost:3004/api/search/google/oauth/callback"
)
if not ADMIN_PW:
    sys.exit("set KEYCLOAK_ADMIN_PASSWORD (the Keycloak bootstrap admin password)")


def req(method, path, token=None, data=None, form=False):
    headers, body = {}, None
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        with urllib.request.urlopen(
            urllib.request.Request(KC + path, data=body, headers=headers, method=method)
        ) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


st, tok = req(
    "POST", "/realms/master/protocol/openid-connect/token", form=True,
    data={"client_id": "admin-cli", "username": "admin", "password": ADMIN_PW, "grant_type": "password"},
)
if st != 200:
    sys.exit(f"admin login failed: {st} {tok}")
T = tok["access_token"]

# A CONFIDENTIAL client (publicClient=false, client_secret_post) with PKCE S256 REQUIRED — the same
# posture token-endpoint-client.ts sends for Google. `directAccessGrantsEnabled` is off: the whole point
# is to exercise the authorization-code path, and leaving the password grant on would let a lazy test
# skip the flow this client exists to prove.
client = {
    "clientId": CLIENT_ID,
    "name": "SM-51 Google-surface dev issuer (NOT Google)",
    # Keycloak stores CLIENT.DESCRIPTION as varchar(255) — a longer string aborts the whole insert
    # batch with an opaque HTTP 500 ("unknown_error"), which is only diagnosable from the container log.
    # Same field-length class as the realm-import comment-field fix. Keep this under 255 chars; the full
    # statement of what this client does and does not rehearse is in this file's module docstring.
    "description": (
        "SM-51 local stand-in for a Google OAuth client (addendum A12.3): auth-code + PKCE + refresh "
        "rotation + RFC-7009 revoke. NOT Google: consent/scope semantics, 7-day Testing refresh "
        "expiry, Google-side revoke, quota and Ads dev-token/MCC are all SM-41G."
    ),
    "enabled": True,
    "protocol": "openid-connect",
    "publicClient": False,
    "secret": CLIENT_SECRET,
    "standardFlowEnabled": True,
    "implicitFlowEnabled": False,
    "directAccessGrantsEnabled": False,
    "serviceAccountsEnabled": False,
    # EXACT redirect URI, no wildcard — matching Google's own rule, so a redirect-URI bug cannot hide
    # locally and then appear in staging.
    "redirectUris": [REDIRECT_URI],
    "webOrigins": [],
    "attributes": {
        "pkce.code.challenge.method": "S256",
        "client_credentials.use_refresh_token": "false",
    },
}

st, body = req("POST", f"/admin/realms/{REALM}/clients", token=T, data=client)
if st == 201:
    print(f"created client {CLIENT_ID}")
elif st == 409:
    _, existing = req(
        "GET", f"/admin/realms/{REALM}/clients?clientId={urllib.parse.quote(CLIENT_ID)}", token=T
    )
    uid = existing[0]["id"]
    merged = {**existing[0], **client}
    st2, b2 = req("PUT", f"/admin/realms/{REALM}/clients/{uid}", token=T, data=merged)
    if st2 not in (204, 200):
        sys.exit(f"failed to update {CLIENT_ID}: {st2} {b2}")
    print(f"updated client {CLIENT_ID}")
else:
    sys.exit(f"failed to create {CLIENT_ID}: {st} {body}")

_, found = req("GET", f"/admin/realms/{REALM}/clients?clientId={urllib.parse.quote(CLIENT_ID)}", token=T)
uid = found[0]["id"]
st, sec = req("GET", f"/admin/realms/{REALM}/clients/{uid}/client-secret", token=T)
secret = sec.get("value") if isinstance(sec, dict) else CLIENT_SECRET

print("")
print(f"  GOOGLE_OAUTH_CLIENT_ID={CLIENT_ID}")
print(f"  GOOGLE_OAUTH_CLIENT_SECRET={secret}")
print(f"  GOOGLE_OAUTH_REDIRECT_URI={REDIRECT_URI}")
print(f"  GOOGLE_OAUTH_AUTHORIZE_URL={KC}/realms/{REALM}/protocol/openid-connect/auth")
print(f"  GOOGLE_OAUTH_TOKEN_URL={KC}/realms/{REALM}/protocol/openid-connect/token")
print(f"  GOOGLE_OAUTH_REVOKE_URL={KC}/realms/{REALM}/protocol/openid-connect/revoke")
print("  SEARCH_ALLOW_PRIVATE_GOOGLE_ENDPOINT=1   # deliberate local opt-in; the boot guard refuses otherwise")
print("")
print("REMINDER: a green round trip against this client validates OUR OAuth machinery against a real")
print("issuer. It does NOT validate the Google integration — see SM-41G (docs/blueprints/")
print("seo-sem-execution-tracker.md §6x.3) for exactly what still requires a real Google OAuth client.")
