# Runbook — Deploy the Trial Stack to the Personal VPS

One box, one compose file, five services: Postgres, WAHA, ai-gateway, mcp-hub, the bot.

## Prerequisites

- Ubuntu/Debian VPS with Docker + the compose plugin (`curl -fsSL https://get.docker.com | sh`).
- The `gaiada-system` folder on the box (git clone or rsync).
- Nothing needs to be publicly reachable. Telegram uses outbound long-polling; WAHA's
  dashboard binds to localhost (reach it with `ssh -L 3000:localhost:3000 user@vps`).

## First deploy

```bash
cd gaiada-system/infra/compose
cp .env.example .env            # fill in: openssl rand -hex 16 for every token/password
cp groups.example.yaml groups.yaml   # edit once you know the real group ids
docker compose -f docker-compose.vps.yml up -d --build
docker compose -f docker-compose.vps.yml ps    # everything Up?
docker compose -f docker-compose.vps.yml logs -f bot   # watch it come up
```

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

Database only. **Never back up the bot's data volume** — it holds `keys.json` (LocalKms);
key material in the backup set voids crypto-shred (see `../../docs/runbooks/erasure-divestiture.md`).
Copy the newest `~/gaiada-backups/*.sql.gz` off-box weekly (e.g. `scp` to your laptop).

## Health checks

```bash
docker compose -f docker-compose.vps.yml exec bot wget -qO- http://localhost:3001/health
docker compose -f docker-compose.vps.yml exec bot wget -qO- http://ai-gateway:3002/health
docker compose -f docker-compose.vps.yml exec bot wget -qO- http://mcp-hub:3003/health
```

## Security notes

- All service tokens are distinct random values; the only exposed port is localhost-bound.
- Provider keys exist only in the `ai-gateway` service env (D8).
- OpenBao replaces the file-based LocalKms before real-data ingestion (checklist 0.4) — it
  belongs on a SEPARATE VPS from this stack, per the day-one spec.
