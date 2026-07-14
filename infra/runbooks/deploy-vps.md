# Runbook — Deploy the Trial Stack to the Personal VPS

One box, one compose file. Services: Postgres, Redis, WAHA, ai-gateway (Go), Keycloak, Cerbos,
platform-nest (API) + platform-ui, whisper, knowledge, mcp-hub, the bot + media-worker, and the
idle `sync-central` (waits on a real second site). Only WAHA's dashboard, Keycloak's admin
console (both localhost-bound), and the UI (`:3005`) are reachable; everything else is
box-internal.

## Prerequisites

- Ubuntu/Debian VPS with Docker + the compose plugin (`curl -fsSL https://get.docker.com | sh`).
- The `gaiada-system` folder on the box (git clone or rsync).
- Nothing needs to be publicly reachable. Telegram uses outbound long-polling; WAHA's
  dashboard binds to localhost (reach it with `ssh -L 3000:localhost:3000 user@vps`).

## First deploy

```bash
cd gaiada-system/infra/compose
cp .env.example .env            # fill in: openssl rand -hex 16 for every token/password
                                # (UI_SESSION_SECRET is REQUIRED — compose aborts if it's blank)
cp groups.example.yaml groups.yaml   # edit once you know the real group ids
docker compose -f docker-compose.vps.yml up -d --build
docker compose -f docker-compose.vps.yml ps    # everything Up?
docker compose -f docker-compose.vps.yml logs -f bot   # watch it come up
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

```bash
cd gaiada-system && git pull
cd infra/compose && docker compose -f docker-compose.vps.yml up -d --build
```

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
```

## Security notes

- All service tokens are distinct random values; the only exposed port is localhost-bound.
- Provider keys exist only in the `ai-gateway` service env (D8).
- OpenBao replaces the file-based LocalKms before real-data ingestion (checklist 0.4) — it
  belongs on a SEPARATE VPS from this stack, per the day-one spec.
