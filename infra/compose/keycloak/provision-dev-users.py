#!/usr/bin/env python3
"""Provision Keycloak dev users for local SSO (matches the platform's seeded accounts).

The committed realm (gaiada-realm.json) defines roles + clients but no users, and users carry
passwords so they don't belong in the committed export. Run this once after the realm is imported
to create login users that the platform auto-links to its seeded accounts by verified email.

    KEYCLOAK_ADMIN_PASSWORD=... python provision-dev-users.py            # KC at localhost:8080
    KC_URL=http://localhost:8080 DEV_USER_PASSWORD='Passw0rd!' python provision-dev-users.py

Idempotent: re-running resets each user's password and clears pending required actions.
RBAC comes from the platform DB (linked by email), so no Keycloak realm-role assignment is needed.
"""
import json, os, sys, urllib.request, urllib.parse, urllib.error

KC = os.environ.get("KC_URL", "http://localhost:8080")
REALM = os.environ.get("KC_REALM", "gaiada")
ADMIN_PW = os.environ.get("KEYCLOAK_ADMIN_PASSWORD") or os.environ.get("KC_ADMIN_PASSWORD")
DEV_PW = os.environ.get("DEV_USER_PASSWORD", "Passw0rd!")
if not ADMIN_PW:
    sys.exit("set KEYCLOAK_ADMIN_PASSWORD (the Keycloak bootstrap admin password)")

# Emails MUST match the platform's seeded users (see platform-nest seed) for email-linking to work.
USERS = [
    ("owner@gaiada-creative.test", "Ayu"),
    ("pm@gaiada-creative.test", "Budi"),
    ("design@gaiada-creative.test", "Citra"),
    ("copy@gaiada-creative.test", "Dewi"),
    ("approver@gaiada-creative.test", "Eka"),
    ("exec@gaiada.test", "Gaiada"),
]


def req(method, path, token=None, data=None, form=False):
    headers, body = {}, None
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode(); headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            body = json.dumps(data).encode(); headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        with urllib.request.urlopen(urllib.request.Request(KC + path, data=body, headers=headers, method=method)) as r:
            raw = r.read().decode(); return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


st, tok = req("POST", f"/realms/master/protocol/openid-connect/token", form=True,
              data={"client_id": "admin-cli", "username": "admin", "password": ADMIN_PW, "grant_type": "password"})
if st != 200:
    sys.exit(f"admin login failed: {st} {tok}")
T = tok["access_token"]

for email, first in USERS:
    u = {"username": email, "email": email, "emailVerified": True, "enabled": True,
         "firstName": first, "requiredActions": [],
         "credentials": [{"type": "password", "value": DEV_PW, "temporary": False}]}
    st, _ = req("POST", f"/admin/realms/{REALM}/users", token=T, data=u)
    if st == 201:
        print(f"created {email}")
    elif st == 409:
        _, users = req("GET", f"/admin/realms/{REALM}/users?email={urllib.parse.quote(email)}&exact=true", token=T)
        uid = users[0]["id"]
        users[0].update({"emailVerified": True, "enabled": True, "requiredActions": []})
        req("PUT", f"/admin/realms/{REALM}/users/{uid}", token=T, data=users[0])
        req("PUT", f"/admin/realms/{REALM}/users/{uid}/reset-password", token=T,
            data={"type": "password", "value": DEV_PW, "temporary": False})
        print(f"updated {email}")
    else:
        print(f"FAILED {email}: {st}")
print("done")
