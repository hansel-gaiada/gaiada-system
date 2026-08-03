# Runbook — Deploy the Trial Stack to the Personal VPS

One box, one compose file. Services: Postgres, Redis, WAHA, ai-gateway (Go), Keycloak, Cerbos,
platform-nest (API) + platform-ui, whisper, knowledge, mcp-hub, the bot + media-worker, and the
idle `sync-central` (waits on a real second site). Only WAHA's dashboard, Keycloak's admin
console (both localhost-bound), and the UI (`:3005`) are reachable; everything else is
box-internal.

> **The VPS no longer builds anything.** Every first-party service is pinned to a signed
> GHCR image (`GAIADA_TAG`), and routine deploys are one command — `git push --tags` — run
> by `.github/workflows/deploy.yml`. See `../../docs/blueprints/deployment-strategy.md`.
> What follows is the **one-time bootstrap** and the **manual/break-glass** path.

## Prerequisites

- Ubuntu/Debian VPS with Docker + the compose plugin (`curl -fsSL https://get.docker.com | sh`).
- The `gaiada-system` folder on the box — but only `infra/` is needed now; CI rsyncs compose
  files and scripts on every deploy. No application source, no Go/Node toolchain.
- Nothing needs to be publicly reachable. Telegram uses outbound long-polling; WAHA's
  dashboard binds to localhost (reach it with `ssh -L 3000:localhost:3000 user@vps`).
- `docker login ghcr.io` works on the box (CI re-authenticates per deploy with a
  short-lived job token; images are private because the repo is private).

## First deploy

```bash
cd gaiada-system/infra/compose
cp .env.example .env            # fill in: openssl rand -hex 16 for every token/password
                                # (UI_SESSION_SECRET is REQUIRED — compose aborts if it's blank)
cp groups.example.yaml groups.yaml   # edit once you know the real group ids

export GAIADA_TAG=v0.6.0        # the release you want; must exist in GHCR
docker compose -f docker-compose.vps.yml pull
docker compose -f docker-compose.vps.yml run --rm --no-deps platform node dist/db/migrate.js
docker compose -f docker-compose.vps.yml up -d --no-build
docker compose -f docker-compose.vps.yml ps    # everything Up + healthy?
docker compose -f docker-compose.vps.yml logs -f bot   # watch it come up
```

To build from your working tree instead (local dev, or a box with no registry access),
layer the build override — this is the ONLY supported way to compile from source:

```bash
docker compose -f docker-compose.vps.yml -f docker-compose.local.yml \
               -f docker-compose.build.yml up -d --build
```

Keycloak imports the `gaiada` realm from `keycloak/gaiada-realm.json` on first boot, but the
platform stays in `AUTH_MODE=dev` until you set client secrets + MFA and flip
`PLATFORM_AUTH_MODE=oidc` (see `../../docs/runbooks/idp-keycloak.md`).

Then per surface:

- **Telegram (works immediately):** set `TELEGRAM_BOT_TOKEN` in `.env`, `up -d` again.
  DM the bot; group ids appear in the logs → add to `groups.yaml` (hot-reloads, no restart).
- **WhatsApp:** tunnel to the WAHA dashboard, start the `default` session, scan the QR with
  the spare number (once — the session persists in a volume).

## Update to a new version

**Normal path — one point, from your laptop:**

```bash
git tag v0.6.1 && git push --tags
```

That builds + signs every image, then `deploy.yml` backs up the databases, pulls, migrates,
starts, and health-checks the box. Watch it in the Actions tab. Nothing to do on the VPS.

**Rollback:** re-run the `deploy` workflow with the previous tag (Actions → deploy → Run
workflow). Images are already on the box, so this is a container restart, not a rebuild.
Schema is *not* reverted — migrations are forward-only; the pre-deploy backup is the
escape hatch.

**Break-glass (CI unavailable), on the box:**

```bash
cd gaiada-system/infra/compose
export GAIADA_TAG=v0.6.1
../scripts/backup.sh
docker compose -f docker-compose.vps.yml pull
docker compose -f docker-compose.vps.yml run --rm --no-deps platform node dist/db/migrate.js
docker compose -f docker-compose.vps.yml up -d --no-build
```

## Changing a variable in `.env` on a running box

```bash
./infra/scripts/wire-env.sh platform          # recreates + echoes the vars back
VERIFY='RENDERER_TOKEN|REPORT_RENDERER_URL' ./infra/scripts/wire-env.sh platform
```

`docker compose restart` does **not** pick up an edited `.env` — compose bakes the environment
at container *create* time, so a restart re-runs the old environment while looking like it
worked. Only a recreate (`up -d --no-deps <svc>`) re-reads the file. The script also carries the
non-obvious invocation the VPS needs (`-f docker-compose.hostdata.yml --profile bot --profile
auth`); without those, postgres/redis are profile-disabled and compose rejects the project.

## Backups (nightly)

```bash
chmod +x ../scripts/backup.sh
crontab -e   # add:
# 0 3 * * * /home/<user>/gaiada-system/infra/scripts/backup.sh >> /var/log/gaiada-backup.log 2>&1
```

Backs up all three application DBs (`gaiada`, `gaiada_platform`, `gaiada_knowledge`) — one
`*.sql.gz` each. **Never back up any data volume** — the bot's holds `keys.json` (LocalKms);
key material in the backup set voids crypto-shred (see `../../docs/runbooks/erasure-divestiture.md`).
Copy the newest `~/gaiada-backups/*.sql.gz` off-box weekly (e.g. `scp` to your laptop).

## Uptime alerting (optional)

`scripts/healthcheck.sh` pings each service's `/health` and, on any failure, sends a Telegram
message (set `TELEGRAM_BOT_TOKEN` + `ALERT_CHAT_ID`). Add to cron alongside the backup:

```bash
# */5 * * * * TELEGRAM_BOT_TOKEN=... ALERT_CHAT_ID=... /home/<user>/gaiada-system/infra/scripts/healthcheck.sh >> /var/log/gaiada-health.log 2>&1
```

## Health checks (manual)

```bash
C=docker compose -f docker-compose.vps.yml exec -T bot wget -qO-
$C http://bot:3001/health
$C http://ai-gateway:3002/health
$C http://mcp-hub:3003/health
$C http://platform:3004/health
$C http://knowledge:3005/health
$C http://platform-ui:3005/         # UI is also published on the host at :3005
$C http://report-renderer:3007/health   # TR-19 sidecar; internal-network only, no published port
```

Auth-gate smoke check (TR-19 acceptance criterion — a token-less request must 401; run from a
container on the same compose network, since `report-renderer` has no published port):

```bash
docker compose -f docker-compose.vps.yml exec -T platform \
  wget -qO- --header="Content-Type: application/json" \
  --post-data='{"url":"http://platform-ui:3005/"}' http://report-renderer:3007/render
# expect: HTTP 401 (busybox wget prints the body on error with -qO- but exits non-zero;
# check the response body / use curl -i from a debug shell if you need the status line)
```

## Known caveats — builds unverified in this dev environment

No Docker is available in the day-to-day dev environment these components were authored in.
**Validate the following on a real Docker host before any deploy that includes them** — do not
assume a passing local `npm test`/`go test` means the container builds or runs:

- `ai-gateway-go` — `docker build` and `docker compose config` never run against Docker locally.
- `render-gateway-go` — planned; same caveat will apply once it's built.
- ~~**`report-renderer` (TR-19)**~~ — **CLEARED 2026-08-03 on the production VPS itself**
  (`gda-aicenter`, Docker 29.7.0, linux/amd64). `docker build` of the pinned
  `mcr.microsoft.com/playwright:v1.61.1-noble` image succeeded, and a container on the live
  `gaiada_default` network returned: `/health` → `{"status":"ok"}`; an authorised render of
  `http://platform-ui:3005/` → **200 `application/pdf`, 16 624 bytes starting `%PDF-`** (a real
  `chromium.launch()` → `page.pdf()`, not a stub); a foreign origin → **403** (SSRF guard); no
  token → **401**. Nothing about this image remains unverified on the target host. The earlier
  Docker-Desktop-only verification is in `docs/modules/CHANGELOG.md`'s report-renderer entry.

## Security notes

- All service tokens are distinct random values; the only exposed port is localhost-bound.
- Provider keys exist only in the `ai-gateway` service env (D8).
- OpenBao replaces the file-based LocalKms before real-data ingestion (checklist 0.4) — it
  belongs on a SEPARATE VPS from this stack, per the day-one spec.
- `report-renderer` (TR-19) holds only the shared `RENDERER_TOKEN`, never a tenant credential, and
  is origin-locked to `PLATFORM_UI_INTERNAL_URL` (`report-renderer/src/auth.ts`) so a leaked token
  cannot be used to make it fetch arbitrary internal or external hosts.
