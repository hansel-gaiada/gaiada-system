# Runbook — Upgrade Keycloak (PID-1c: 26.0.8 → 26.8.1)

**Ticket:** PID-1c, plan `docs/plans/2026-10-30-phone-identity.md` (passkeys need Keycloak 26.3+).
**Status: PLANNED.**
- **Rehearsed (PID-1b, 2026-10-30, DEV-VERIFIED on sumopod)** against a copy of the live `gaiada_keycloak`.
- **Not yet applied to live.**
- The live change is the compose line `image: quay.io/keycloak/keycloak:26.8.1` (plus an explicit `KC_HTTP_HOST`). It
  takes effect in **whichever release carries it**: `deploy.yml`'s `up -d` recreates the `keycloak` service, because
  the `auth` profile is in `COMPOSE_PROFILES`. So steps 1 and 2 happen **before that release is tagged**.

## What the rehearsal proved

`infra/scripts/keycloak-upgrade-rehearsal.sh copy`. The live copy was restored on an internal docker network with no
egress. Then 26.0.8 → 26.8.1 → revert:

| Check | Result |
|---|---|
| Schema migration | Liquibase plus model steps 26.1.0 … 26.8.0 in about 7 s; Keycloak ready in 33 s |
| Realm, flows, required actions, clients, roles, groups, IdPs, 75 accounts and their credentials | Identical before and after. The one expected difference: the migration adds the built-in required action `idp_link` |
| Password login (direct grant, test user) | Works on 26.0.8, on 26.8.1, and after the revert |
| `gaiada-provisioner` (client credentials with the secret in the POST body, as `platform-nest/src/core/keycloak-admin.ts` sends it) | Token OK, list users **200**, before and after |
| `webdesk-control` | Token OK, list users **403** (it holds no user rights), before and after |
| Organizations | Off on live (endpoint 404), so 26.8's organization/IdP link change does not apply |
| Passkeys switch (`webAuthnPolicyPasswordlessPasskeysEnabled`) | Settable on 26.8.1. Note: it is omitted from the realm JSON until set |
| Revert (restore the pre-upgrade dump, start 26.0.8) | Identical to before; logins work |

The copy was shredded afterwards (`… purge`).

## Upgrade notes 26.0 → 26.8 that matter here (Keycloak upgrading guide)

- **26.6 `start-dev` listens on localhost only by default.** Live runs `start-dev`. The rehearsal container was still
  reachable over the docker network, but the compose file now states `KC_HTTP_HOST: "0.0.0.0"` so a dev-mode
  heuristic never decides whether nginx and platform-nest can reach the IdP.
- **26.6 / 26.7 service accounts:**
  - the secret method is enforced as registered;
  - admin roles must be assigned directly, not through mappers.
  - The rehearsal proved both service accounts unchanged.
- **26.5 / 26.8 sessions:**
  - client session limits must not exceed the realm's;
  - refresh tokens are capped by the session idle time;
  - sessions are persisted (they survive this restart).
  - These matter for PID-2e (the 7-day "This is my own device").
- **26.6 / 26.8 brute force:**
  - a "secondary authentication failures" lockout that can lock **permanently** even in temporary mode;
  - failures are stored in the database.
  - These matter for PID-2i: set `maxSecondaryAuthFailures` deliberately.
- **26.3 upgraded realms keep their old browser flow**: WebAuthn/passkeys go into our own flow copy (PID-2c).
- **26.4 `session_state`/`sid` are no longer UUIDs**: `platform-nest` reads them as opaque strings (`auth/step-up.ts`),
  so no change.

## 0. Before: the window

- **Window:** pick a quiet time. Sign-in is unavailable while the container restarts and migrates (about 1 minute).
  People already signed in stay signed in: sessions are persisted and platform-nest caches the JWKS.
- **Release:** this compose change **rides its own release**, with no other car. A failed sign-in afterwards then has
  exactly one cause (the same discipline as `keycloak-production-mode.md`).
- **Notice:** tell the live sessions (`ListAgents`) before tagging. Nobody else tags until step 4 passes.

## 1. Backup (the owner runs it; read-only on live)

```bash
ssh gda-aicenter 'set -e; umask 077; mkdir -p ~/gaiada-realm-backups; F=~/gaiada-realm-backups/gaiada_keycloak-before-pid1c-$(date -u +%Y%m%dT%H%M%SZ).dump
  cd /tmp && sudo -u postgres pg_dump -Fc gaiada_keycloak > "$F"
  echo "$F"; ls -l "$F"; sudo -u postgres pg_restore -l "$F" | grep -c "TABLE DATA"
  docker inspect gaiada-keycloak-1 --format "image={{.Config.Image}} id={{.Image}}"'
```

Expect about 87 tables with data (the 2026-10-30 copy had 87). Keep the printed file name and image id. They are the revert.

## 2. Release

Land the PID-1c branch as the only car, tag it, and let `deploy.yml` run. The deploy log shows `keycloak` recreated.

## 3. Checks after the deploy (each must pass; any failure → step 5)

```bash
ssh gda-aicenter '
  docker inspect gaiada-keycloak-1 --format "image={{.Config.Image}} health={{.State.Health.Status}}"   # 26.8.1, healthy
  docker logs gaiada-keycloak-1 2>&1 | grep -E "Migrating older model to 26.8.0|ERROR" | head        # the migration line, no ERROR
  curl -s https://erp.gaiada.com/idp/realms/gaiada/.well-known/openid-configuration | grep -o "\"issuer\":\"[^\"]*\""'
# expect "issuer":"https://erp.gaiada.com/idp/realms/gaiada"
```

- **Sign in as the owner, once** (never retry a failed login), then call `/api/me` on platform-nest's loopback. The
  token travels over stdin, never on a command line:

  ```bash
  TOKEN=$(bash scripts/sso-login.sh hansel@gaiada.com "$PW")
  printf '%s\n' "$TOKEN" | ssh gda-aicenter 'umask 077; IFS= read -r t; H=$(mktemp); printf "authorization: Bearer %s\n" "$t" > "$H"; unset t
    curl -s -o /dev/null -w "api/me %{http_code}\n" -H @"$H" http://127.0.0.1:3004/api/me; rm -f "$H"'      # expect 200
  ```
- **The provisioner** (the secret is read from its file on the box and sent over stdin):

  ```bash
  ssh gda-aicenter 'B=http://127.0.0.1:8080/idp
    T=$(printf "grant_type=client_credentials&client_id=gaiada-provisioner&client_secret=%s" "$(cat ~/.gaiada-provisioner-secret)" \
      | curl -s --data @- "$B/realms/gaiada/protocol/openid-connect/token" | sed -n "s/.*\"access_token\":\"\([^\"]*\)\".*/\1/p")
    printf "authorization: Bearer %s\n" "$T" | curl -s -o /dev/null -w "provisioner list-users %{http_code}\n" -H @- "$B/admin/realms/gaiada/users?max=1"'   # expect 200
  ```
- **IT → Sign-ins** in the ERP lists the sign-in just made (`view-events` still works).
- `docker logs gaiada-platform-1 --since 10m 2>&1 | grep -i -E "jwks|oidc:" | head` shows no new errors.

## 4. Afterwards

- Announce "Keycloak 26.8.1 live" to the sessions.
- Tick PID-1c and PID-5a on the board.
- Keep the step-1 dump 14 days, then shred it.

## 5. Revert (only if a check in step 3 fails)

Keycloak has **no down-migration**. Restore the database **and** put the old image back, together.

```bash
ssh gda-aicenter 'set -e; F=<the step-1 file>
  cd ~/gaiada/infra/compose && C="docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml"
  COMPOSE_PROFILES=auth $C stop keycloak
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE gaiada_keycloak WITH (FORCE)" -c "CREATE DATABASE gaiada_keycloak OWNER keycloak"
  sudo -u postgres pg_restore -d gaiada_keycloak "$F"
  sed -i "s|image: quay.io/keycloak/keycloak:26.8.1|image: quay.io/keycloak/keycloak:26.0.8|" docker-compose.vps.yml
  COMPOSE_PROFILES=auth $C up -d --no-build keycloak'
```

- Run step 3's checks again against 26.0.8.
- Then fix forward on main: revert the compose line, so the next release does not upgrade again.
- What the revert loses: anything Keycloak wrote after the step-1 dump (sign-ins, sessions, password changes in those
  minutes).

⚠ **Never re-run an older release's deploy job after the upgrade.** It rsyncs the old compose file and starts 26.0 on
the migrated database. `infra/scripts/rollback-to.sh` is safe: it keeps the compose file on the box and changes only
`GAIADA_TAG`.

## Rehearsing a future upgrade

On sumopod, one gate at a time (the script takes `~/e2e.lock`):

```bash
scp infra/scripts/keycloak-upgrade-rehearsal.sh sumopod: && scp infra/compose/keycloak/gaiada-realm.json sumopod:kc-rehearsal-realm.json
ssh sumopod 'FROM=quay.io/keycloak/keycloak:<live> TO=quay.io/keycloak/keycloak:<target> bash ~/keycloak-upgrade-rehearsal.sh synthetic'
# then the owner copies the live database to sumopod ~/kc-rehearsal/kc.dump (step 1's pg_dump, piped through ssh to sumopod),
# run the same with `copy`, read every FAIL, and finish with `purge` (it shreds the copy).
```
