# Runbook — Keycloak `start-dev` → `start` cutover (fault register finding 07)

Scope: the single change in `infra/compose/docker-compose.vps.yml`'s `keycloak` service —
`command: ["start-dev", "--import-realm"]` → `["start", "--import-realm"]`, plus `KC_HOSTNAME`,
`KC_HTTP_RELATIVE_PATH`, and `KC_PROXY_HEADERS` moving from empty defaults to the real production
shape (`https://erp.gaiada.online/idp`, `/idp`, `xforwarded`), and a new `KC_HTTP_ENABLED=true`.

**Read this whole runbook before deploying that change. Do not deploy it without running §2.**

## Why this is riskier than a normal compose bump

`start-dev` tolerates almost any config and still boots. `start` does not:

- It refuses to boot at all without either TLS terminated at Keycloak itself or an explicit
  HTTP + proxy-headers configuration (`KC_HTTP_ENABLED` + `KC_PROXY_HEADERS`, both now set).
- With `KC_HOSTNAME_STRICT` at its default (`true`), a **wrong** `KC_HOSTNAME` does not fail to
  boot — it boots fine and mints issuer/auth/token URLs from the wrong value. The platform's
  `OIDC_ISSUER` check then rejects every token it verifies. **The container reports healthy the
  whole time** (`KC_HEALTH_ENABLED` only proves the JVM answered `/health/ready`; it says nothing
  about whether the issuer it mints is the one every other service expects).

So the failure mode this runbook exists to catch is specifically: **container healthy, SSO dead**.
`docker compose ps` / `docker ps` alone will not show it. Only a real login attempt will.

## 1. Values this change ships, and where they came from

Read (not guessed) from the live `gaiada-keycloak-1` container's own environment on gda-aicenter,
2026-09-08 (`docker exec gaiada-keycloak-1 env`, read-only, no changes made by that read):

```
KC_HOSTNAME=https://erp.gaiada.online/idp
KC_HTTP_RELATIVE_PATH=/idp
KC_PROXY_HEADERS=xforwarded
```

These were previously **not in `.env.example` at all**, and the compose file defaulted all three
to empty — meaning the box's real `.env` already carried the correct override, but a fresh
`.env` copied from the example would not have. This ticket makes the compose **default** match
what is already live, and adds the three to `.env.example` so a fresh box gets the right value
without anyone having to know the SumoPod/aicenter-specific magic string.

Also confirmed live before writing this runbook (all read-only):

- No `curl`/`wget`/`nc`/`python3` in this Keycloak image, but `bash` is present and `/bin/sh` is a
  symlink to it (so `CMD-SHELL` healthchecks get bash's `/dev/tcp` pseudo-device).
- `GET /idp/health/ready` on the **management port 9000** (not 8080) returns
  `{"status":"UP","checks":[]}` — the same path without the `/idp` prefix, and the same path on
  8080, both 404. This is the exact probe the new `keycloak` healthcheck in the compose file uses.

## 2. Post-deploy verification checklist — RUN ALL OF THIS, in order

Do not consider the deploy done until every step below passes. If any step fails, go straight to
§3 (rollback) rather than debugging forward on a live IdP.

### 2.1 Container actually started with the new command and is healthy

```bash
ssh gda-aicenter
docker inspect gaiada-keycloak-1 --format '{{.Path}} {{.Args}}'
# expect: /opt/keycloak/bin/kc.sh start --import-realm   (NOT start-dev)
docker compose -f ~/gaiada/infra/compose/docker-compose.vps.yml ps keycloak
# expect: State "healthy", not "starting" past ~3 minutes (start_period is 180s) and not
# "unhealthy". "starting" forever past 3 min means the healthcheck itself is failing — check
# `docker inspect gaiada-keycloak-1 --format '{{json .State.Health}}'` for the last probe output.
```

### 2.2 The management health endpoint answers on the real prefix

```bash
docker exec gaiada-keycloak-1 bash -c \
  'exec 3<>/dev/tcp/127.0.0.1/9000 && printf "GET /idp/health/ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n" >&3 && cat <&3'
# expect: HTTP/1.1 200 OK ... {"status": "UP", "checks": []}
```

### 2.3 The public vhost path resolves and the realm login page renders

```bash
curl -sk -o /dev/null -w '%{http_code}\n' \
  'https://erp.gaiada.online/idp/realms/gaiada/protocol/openid-connect/auth?client_id=gaiada-ui&response_type=code&scope=openid&redirect_uri=https://erp.gaiada.online/auth/callback'
# expect: 200 (Keycloak's own hosted login form HTML), not a redirect to http://localhost or an
# error page. A 200 here that renders "invalid redirect_uri" is fine (proves the realm/issuer is
# alive); a connection error or a redirect to a non-erp.gaiada.online host is NOT.
```

### 2.4 The decisive check — decode a REAL token's issuer

This is the one check that actually proves the platform will accept the token, not just that
Keycloak booted. Use a real browser (same method as the `enable-mfa.md` / `idp-keycloak.md`
runbooks' own precedent) or `scripts/sso-login.sh` if `AUTH_MODE=oidc` is compatible with it:

```bash
# From a real browser login, or from sso-login.sh's captured access_token:
echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | python3 -m json.tool
# expect: "iss": "https://erp.gaiada.online/idp/realms/gaiada"
# NOT "iss": "http://localhost:8080/realms/gaiada" or any container-internal address — that
# exact shape (a syntactically valid but WRONG issuer) is what a misconfigured KC_HOSTNAME
# produces while the container still reports healthy.
```

### 2.5 A full staff login actually works end to end

```bash
# hansel@gaiada.com (or any known-good live login, per `who-can-log-in-live` memory) signs into
# https://erp.gaiada.online/ through the real SSO flow and lands on the authenticated ERP shell,
# not stuck on a login loop or an "invalid_redirect_uri"/"invalid issuer" error page.
```

### 2.6 Sibling containers on the same box are undisturbed

```bash
docker compose -f ~/gaiada/infra/compose/docker-compose.vps.yml ps
# expect: platform, platform-ui, mcp-hub, cerbos, ai-gateway all still Up/healthy at their
# PRE-deploy uptime (this change only recreates `keycloak`; if `up -d` recreated siblings too,
# something else drove that — see the `--remove-orphans` / stale-.env traps in infra/CLAUDE.md).
```

## 3. Rollback — one line, no data loss

The change is entirely in `command:` + three env defaults; nothing here touches the
`gaiada_keycloak` Postgres database or the realm import, so rolling back is safe and instant:

```bash
# Revert the compose file's keycloak `command:` back to:
#   command: ["start-dev", "--import-realm"]
# and KC_HOSTNAME / KC_HTTP_RELATIVE_PATH / KC_PROXY_HEADERS back to their old empty defaults
# (or just unset them in .env if they were only overridden there), then:
cd ~/gaiada/infra/compose
docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml up -d --no-deps keycloak
```

`--no-deps` (and naming `keycloak` explicitly, never a bare `up -d`) avoids the `--remove-orphans`
trap and the stale-`.env` rollback trap this repo's `infra/CLAUDE.md` already documents — scope
the rollback to exactly the one container this ticket touched.

After rolling back, re-run §2.4 and §2.5 once more against the reverted container to confirm the
pre-existing (dev-mode) behavior is restored, then treat the cutover as blocked pending a fix to
whichever check in §2 failed.

## 4. What this ticket deliberately did not touch

- Keycloak realm/flow configuration (MFA, required actions, reset-password flow) — see
  `docs/runbooks/idp-keycloak.md` for that history; this ticket is `start`-vs-`start-dev` only.
- `--optimized` — not used; see the compose file's own comment on `keycloak.command` for why
  (requires a pre-built image this repo does not produce).
- Any change to `KC_HOSTNAME_STRICT` or `KC_HOSTNAME_STRICT_BACKCHANNEL` — both stay at their
  Keycloak defaults (`true`), which is what makes a wrong `KC_HOSTNAME` fail loud in §2 rather
  than silently accepting a bad value.
