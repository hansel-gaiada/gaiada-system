# Runbook — Keycloak security events, no email reset, and the `view-events` role (DW-7h)

**Ticket:** DW-7h, BFF contract `docs/FRONTEND-BFF-CONTRACT.md` §52.8 and §52.9. **Status: APPLIED on the live realm 2026-10-15** by the DW-7 session.
It used one kcadm sign-in with the container's own `KC_BOOTSTRAP_ADMIN_*` env, so the password never left the container. A backup was taken first
(`~/gaiada-realm-backups/*-before-dw7h-20261015-144600.json` on gda-aicenter). Every check below passed: the events API answers 200, and the live
login page has no "Forgot password?". Before: events off (all types listed, jboss-logging listener), `resetPasswordAllowed: true`, and the provisioner
held `view-users` and `manage-users`.
Every command below is a **live Keycloak change** on gda-aicenter. Nothing here has been run against any server. The owner (or whoever holds
`KEYCLOAK_ADMIN_PASSWORD`) reviews and runs each step. The repo realm file `infra/compose/keycloak/gaiada-realm.json` already carries the same
settings for a fresh install; a running realm is not changed by it (the importer runs once, on first boot).

## What this turns on, and what happens until it is done

| Step | Setting | Why |
|---|---|---|
| 1 | `eventsEnabled: true`, `eventsExpiration: 2592000` (30 days), `enabledEventTypes: LOGIN, LOGIN_ERROR, LOGOUT` | IT's Sign-ins and Alerts pages read these events (BFF §52.6). |
| 2 | `resetPasswordAllowed: false` | Most staff addresses are Google Workspace aliases, so a reset email lands in someone else's inbox. IT hands over a temporary password instead (§52.8). |
| 3 | realm-management role `view-events` on the service account of client `gaiada-provisioner` | The ERP reads events with that account. It already holds `manage-users`, which covers ending a user's sessions. |

Until steps 1 and 3 are done, the Sign-ins read answers `state: "off"` or `state: "unavailable"` (with the reason), and everything else on the IT
security pages works. Step 2 changes what every person sees on the login page ("Forgot password?" disappears), so tell staff first.

## 0. Set up kcadm (no secret is ever printed)

```bash
ssh gda-aicenter
# KEYCLOAK_ADMIN_PASSWORD comes from ~/gaiada/infra/compose/.env. Read it into the shell without echoing it:
read -rs KEYCLOAK_ADMIN_PASSWORD; export KEYCLOAK_ADMIN_PASSWORD

KC=gaiada-keycloak-1
# The password is expanded INSIDE the container (single-quoted sh -c), so it never appears in the host's process list.
# KC_HTTP_RELATIVE_PATH is /idp on the live box (infra/compose/docker-compose.vps.yml), hence the /idp in the server URL.
docker exec -e KEYCLOAK_ADMIN_PASSWORD "$KC" sh -c \
  '/opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080/idp --realm master --user admin --password "$KEYCLOAK_ADMIN_PASSWORD"'
kcadm() { docker exec "$KC" /opt/keycloak/bin/kcadm.sh "$@"; }
```

If `config credentials` answers 404, the relative path differs: read it with `docker exec "$KC" printenv KC_HTTP_RELATIVE_PATH` and use that.

Take a rollback point first, and record the current values for the revert (the output holds no secret):

```bash
kcadm get events/config -r gaiada > ~/gaiada-realm-backups/events-config-before-dw7h-$(date +%Y%m%d-%H%M%S).json
kcadm get realms/gaiada --fields resetPasswordAllowed,eventsEnabled,eventsExpiration,enabledEventTypes
```

## 1. Record sign-in events

`events/config` is the endpoint that owns these settings. `kcadm update` reads the current configuration and merges these fields into it, so the
existing `eventsListeners` and the admin-events settings are left as they are.

```bash
kcadm update events/config -r gaiada \
  -s eventsEnabled=true \
  -s eventsExpiration=2592000 \
  -s 'enabledEventTypes=["LOGIN","LOGIN_ERROR","LOGOUT"]'
```

**Check:**

```bash
kcadm get events/config -r gaiada
# expect: "eventsEnabled" : true, "eventsExpiration" : 2592000, "enabledEventTypes" : [ "LOGIN", "LOGIN_ERROR", "LOGOUT" ]
```

Events are recorded from now on; there is no back-fill, so the Sign-ins page starts empty and fills as people sign in.

## 2. Turn off the email reset

```bash
kcadm update realms/gaiada -s resetPasswordAllowed=false
```

**Check:**

```bash
kcadm get realms/gaiada --fields resetPasswordAllowed
# expect: "resetPasswordAllowed" : false
# and in a private browser window: the ERP login page no longer shows "Forgot password?".
```

## 3. Let the ERP read events: `view-events` for the provisioner

The service account user of client `gaiada-provisioner` is `service-account-gaiada-provisioner`. The role belongs to the built-in `realm-management`
client.

```bash
kcadm add-roles -r gaiada \
  --uusername service-account-gaiada-provisioner \
  --cclientid realm-management \
  --rolename view-events
```

**Check:**

```bash
# the role is on the account
kcadm get-roles -r gaiada --uusername service-account-gaiada-provisioner --cclientid realm-management
# expect view-events in the list, next to manage-users and view-users

# and it works: the admin API now answers 200 for events (an empty list is fine, a 403 is not)
kcadm get events -r gaiada -q type=LOGIN -q max=1
```

That last command runs as the master admin, so it proves the events API and the settings, not the service account. The proof for the account itself is
the ERP: open IT, Network, Sign-ins. It reads `on` (or `off` if step 1 was skipped). If it says `unavailable` and names `view-events`, the role did not
stick. The role takes effect on the next token the provisioner fetches, within a few minutes at most.

## Revert

Each step is undone by itself. Use the values recorded in the "before" file from step 0 if they were not the defaults below.

```bash
# 3. remove the role (the ERP's Sign-ins read answers "unavailable" again; nothing else changes)
kcadm remove-roles -r gaiada --uusername service-account-gaiada-provisioner --cclientid realm-management --rolename view-events

# 2. bring the email reset back ("Forgot password?" returns on the login page)
kcadm update realms/gaiada -s resetPasswordAllowed=true

# 1. stop recording events (what was already recorded stays until it expires)
kcadm update events/config -r gaiada -s eventsEnabled=false
```

Check each revert with the same `get` command as its step.

## Notes

- Events expire after 30 days (`eventsExpiration`). The ERP never stores them: every read of Sign-ins asks Keycloak.
- The ERP asks for at most 5000 events per read. A realm busier than that shows the newest ones.
- A person whose account is disabled by IT ("Block login") is also logged out of Keycloak by the ERP (`POST /users/{id}/logout`, covered by `manage-users`).
  No extra role is needed for that or for ending a single session (`DELETE /sessions/{id}`).
- Existing runbooks for the same box: `infra/runbooks/enable-mfa.md` (kcadm access and rollback habit) and `infra/runbooks/keycloak-production-mode.md`
  (why the server URL carries `/idp`).
