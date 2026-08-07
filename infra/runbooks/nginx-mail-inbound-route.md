# Runbook — Apply the `/api/mail/` nginx route (NET-01)

Makes Brevo's two mail webhooks (`POST /api/mail/inbound/brevo`, MAIL-13; `POST
/api/mail/webhooks/brevo`, MAIL-04) reachable from the internet. Today they are not: this vhost
has no `/api/*` location, so both fall through to `location /` (platform-ui, `:3005`), which
307-redirects anything it doesn't recognise to `/login` — confirmed live twice.

This was designed and validated offline only (`nginx -t` in a throwaway container + a real
routing proof against stub upstreams — see the NET-01 report for output).

## ✅ APPLIED to gda-aicenter 2026-08-07

Backup taken at `/etc/nginx/sites-available/erp.gaiada.online.bak-20260807040201` (the rollback
point). `nginx -t` passed, `systemctl reload nginx`, no dropped connections. Evidence:

| Check | Before | After |
|---|---|---|
| `POST /api/mail/inbound/brevo` | **307** (fell through to platform-ui) | **401** (reached the app, token wall held) |
| `POST /api/mail/webhooks/brevo` | 307 | **401** |
| `/idp/…/openid-configuration` | 200 | 200 (no regression) |
| `/n8n/` | 302 | 302 (no regression) |
| Rate limit (40 rapid POSTs) | n/a | **15×401 + 25×429** — exactly `burst=15`, zone live |
| `:3004` binding | `127.0.0.1` only | `127.0.0.1` only |

Two corrections to the checks written above, both worth keeping:

1. **The prerequisite curl below is missing `-H "Content-Type: application/json"`.** Without it the
   endpoint returns **500**, not 401 — Fastify raises `Unsupported Media Type` and it escapes as an
   unhandled exception. That is a logging nit, not a gate failure (real Brevo always sends JSON),
   but the bare curl makes a healthy endpoint look broken. Always send the content-type.
2. **The `docker port` prerequisite was already satisfied** — `ports: ["127.0.0.1:3004:3004"]` rode
   the normal deploy pipeline in `alpha-01.026.0067a`, so no manual compose step was needed.

`MAIL_INBOUND_TRUSTED_PROXIES=172.18.0.1` was appended to the box `.env` and platform recreated
(scoped, blast radius 1). 172.18.0.1 is the docker bridge gateway = the host where nginx runs, i.e.
the peer address the app actually observes; MAIL-37's resolver is **exact-IP, no CIDR** by design.
Verified *at the process* (`docker exec … echo $MAIL_INBOUND_TRUSTED_PROXIES` → `172.18.0.1`), not
merely in the file — see the compose-passthrough trap.

⚠ Recreating any service on this box needs **both** compose files
(`-f docker-compose.vps.yml -f docker-compose.hostdata.yml`); the vps file alone is an invalid
project because Postgres/Redis run on the host. See `infra/runbooks/deploy-vps.md`.

Still open (pre-existing, not introduced here): platform-ui's `:3005` is bound `0.0.0.0` and the box
has **no host firewall** (no `ufw`, empty `DOCKER-USER` chain). It is unreachable from off-box, so
the protection is a provider-level network filter rather than a host control.

## Prerequisite — confirm BEFORE touching nginx

This route's `proxy_pass` targets `http://127.0.0.1:3004` (platform-nest). That port is **not
published** in the committed production compose today — `infra/compose/docker-compose.vps.yml`'s
`platform:` service has no `ports:` (its own comment says "Internal-only... by design,
sibling-reachable only"); only the dev-only `docker-compose.local.yml` override publishes
`127.0.0.1:3004:3004`, and that override is not meant to ship to production (it also publishes
Cerbos/pg-bot/a disposable Redis, none of which belong on the internet-facing box).

Check first:

```bash
ssh <box> "docker port gaiada-platform-1"
```

If that prints nothing, this route will 502 the moment it's installed. Add a loopback-only
publish to the **production** compose (same pattern as every other proxied service in this
vhost — Keycloak, n8n, platform-ui all bind `127.0.0.1:<port>`, never `0.0.0.0`):

```yaml
# infra/compose/docker-compose.vps.yml, under the platform: service
    ports:
      - "127.0.0.1:3004:3004"
```

then recreate just that container (`docker compose -f docker-compose.vps.yml up -d platform`) and
re-check `docker port gaiada-platform-1` before proceeding. This rides the normal deploy pipeline
once merged (`deploy.yml` ships compose files) — unlike the nginx step below, which does not.

Confirm sibling-reachability before touching nginx at all:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3004/api/mail/inbound/brevo
# expect 401 (fail-closed, no token) — NOT "connection refused"
```

## Apply

**The server keeps its own copy of this file; the repo copy does not deploy automatically**
(`deploy.yml` ships compose + mounted config, not host nginx — see `infra/nginx/README.md`).
Installing this is always a manual step, and another session may have changed the on-box copy
since this repo file was last synced — diff before overwriting, don't blind-copy:

```bash
ssh <box>
sudo diff /etc/nginx/sites-available/erp.gaiada.online <(cat) <<'EOF'
# paste the repo's infra/nginx/erp.gaiada.online.conf here, or scp it up first and diff the file
EOF
```

Once you're sure you're not clobbering an unrelated concurrent edit:

```bash
sudo cp /etc/nginx/sites-available/erp.gaiada.online \
        /etc/nginx/sites-available/erp.gaiada.online.bak-$(date +%Y%m%d%H%M%S)   # rollback point
sudo cp infra/nginx/erp.gaiada.online.conf /etc/nginx/sites-available/erp.gaiada.online
sudo nginx -t                              # MUST pass before the next line — do not skip
sudo systemctl reload nginx                # reload, not restart — no dropped connections
```

## Confirm it worked

```bash
# 1. The webhook is reachable and fail-closed (401, not a 307 to /login):
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://erp.gaiada.online/api/mail/inbound/brevo
# expect 401

# 2. A real token gets through (expect 204; use a throwaway/no-op body — this hits the real
#    ingest path):
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://erp.gaiada.online/api/mail/inbound/brevo \
  -H "x-gaiada-mail-inbound-token: $MAIL_INBOUND_TOKEN" -d '{}'
# expect 204 (or 400 malformed-payload if the body isn't a real Brevo shape — either proves it's
# reaching the app, which is the point)

# 3. Nothing else regressed — spot-check one path from each existing location:
curl -s -o /dev/null -w '%{http_code}\n' https://erp.gaiada.online/idp/realms/gaiada/.well-known/openid-configuration
curl -s -o /dev/null -w '%{http_code}\n' https://erp.gaiada.online/            # platform-ui, unchanged
```

## Rollback

```bash
sudo cp /etc/nginx/sites-available/erp.gaiada.online.bak-<timestamp> \
        /etc/nginx/sites-available/erp.gaiada.online
sudo nginx -t
sudo systemctl reload nginx
```

## What this does NOT prove, and can only be settled by applying it

- Whether `platform` is actually reachable at `127.0.0.1:3004` in production **as deployed**
  (the prerequisite above is a recommendation, not a verified fact about the live box).
- Real Brevo traffic shape/volume against the `limit_req` (30r/m, burst 15) and
  `client_max_body_size 8m` settings — both are judgment calls sized from the design doc's stated
  volume ("a handful of mails/day"), not measured production traffic. Watch
  `mail_inbound_rejected_total` and nginx's own access log for 429/413s after go-live and retune
  if either fires on legitimate traffic.
- Whether `checkInboundRate`'s per-source key (`x-forwarded-for`, currently trusted unconditionally
  — see the NET-01 report) needs the same trusted-proxy allowlist fix MAIL-24 already applied to
  the magic-link limiter. That is a platform-nest change, out of this ticket's scope, and is not
  fixed by anything here — nginx's `limit_req` (keyed on the real socket peer, not spoofable) is a
  backstop for the gap, not a fix for it.
