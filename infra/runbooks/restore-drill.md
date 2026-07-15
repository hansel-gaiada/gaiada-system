# Runbook — WS9 / D15 restore drill

An untested backup is not a backup. `infra/scripts/restore-drill.sh` restores the most-recent
nightly dumps (from `backup.sh`) into an **isolated throwaway Postgres** container, runs integrity
checks, measures RTO/RPO, and tears it down. It never touches the live databases (disposable
container on a random port, removed via a trap).

## Install (weekly, after the nightly backup)

```cron
# 03:00 backup (existing), 04:30 Sunday restore drill:
30 4 * * 0 TELEGRAM_BOT_TOKEN=... ALERT_CHAT_ID=... ALERT_EMAIL_TO=... DEADMANSSWITCH_URL=... \
  BACKUP_DIR=/home/USER/gaiada-backups \
  /path/to/gaiada-system/infra/scripts/restore-drill.sh >> /var/log/gaiada-restore-drill.log 2>&1
```

## What it does

1. Starts `postgres:17-alpine` isolated, waits for readiness.
2. For each DB in `DRILL_DBS` (default `gaiada_platform gaiada_knowledge gaiada_bot`): finds the
   newest `*.sql.gz`, restores it with `psql -v ON_ERROR_STOP=1`, and asserts the restored DB has
   ≥1 public table (empty/corrupt dumps fail the drill).
3. Logs **RTO** (total restore seconds) and worst **RPO** (age of the oldest dump used).
4. On success, pings `DEADMANSSWITCH_URL` so a *skipped* drill (dead cron / powered-off box) is
   itself detectable. On **any** failure it exits non-zero and alerts via Telegram + email
   (independent transports) — a broken backup pages instead of being discovered during a real
   disaster.

## After a few runs

Copy the observed RTO/RPO from the log into the table in `observability-slo.md` so recovery
expectations are documented per tier.

## Notes

- Requires Docker on the host (it starts a throwaway container). Safe on the production box — it
  reads only the backup files and writes only to its own disposable instance.
- The crypto-shred rule still holds: backups contain **databases only**, never the bot's key
  material — so a restored `gaiada_bot` has ciphertext whose keys were shredded on erasure, exactly
  as intended.
