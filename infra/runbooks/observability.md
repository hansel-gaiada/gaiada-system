# Runbook — WS9 Observability (operate the stack)

The observability stack (OpenTelemetry Collector + Prometheus + Grafana + Tempo + Loki +
Alertmanager + exporters + ntfy) is a **separate, opt-in compose file** merged into the `gaiada`
project. It adds **no runtime dependency** to the data plane: services export telemetry only when
`OTEL_ENABLED=1`, which the observability compose file sets per-service — so bringing the core stack
up *without* this file leaves every service running exactly as before.

## Bring it up

```sh
cd infra/compose
cp .env.example .env         # fill in GRAFANA_ADMIN_PASSWORD + the alert transports you want
docker compose -f docker-compose.vps.yml -f docker-compose.observability.yml up -d --build
```

Everything binds to localhost only. Reach the UIs over an SSH tunnel:

| UI | Local URL (after tunnel) | Notes |
|----|--------------------------|-------|
| Grafana | http://localhost:3001 | login `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD`; dashboards under the **Gaiada** folder |
| Prometheus | http://localhost:9090 | targets, rules, `/alerts` |

```sh
ssh -L 3001:localhost:3001 -L 9090:localhost:9090 user@vps
```

## What flows where

- Every service pushes **OTLP traces + metrics** to `otel-collector:4318`. The collector fans out:
  metrics → Prometheus (scraped off `:8889`), traces → Tempo, logs → Loki.
- **Logs**: services log JSON to stdout with `trace_id`/`span_id`; the collector's `filelog` receiver
  tails the Docker container logs and ships them to Loki. In Grafana a Tempo span links to its Loki
  logs and back (configured in the datasource provisioning).
- **Infra**: postgres/redis/node/cadvisor exporters + blackbox synthetic probes are scraped directly
  by Prometheus.

## Alerting (D15 — ≥2 independent transports + dead-man's-switch)

`alertmanager.yml` is an **env template**; the compose service renders it with `envsubst` at start,
so set the transport secrets in `.env`:

- **Telegram** (`TELEGRAM_BOT_TOKEN` + `ALERT_CHAT_ID`) — transport #1.
- **Email/SMTP** (`SMTP_*` + `ALERT_EMAIL_TO`) — independent path.
- **ntfy** — self-hosted push (the `ntfy` service); Alertmanager posts to `http://ntfy/gaiada-alerts`.
- **Generic webhook** (`ALERT_WEBHOOK_URL`) — Slack/Discord/custom.
- **External dead-man's-switch** (`DEADMANSSWITCH_URL`, e.g. a healthchecks.io/Cronitor ping URL) —
  the always-firing `Watchdog` alert is routed here every minute. If Prometheus/Alertmanager (or the
  whole box) die, the external monitor stops seeing the heartbeat and pages **out-of-band**.

The cron `healthcheck.sh` is the **second, independent** liveness alerter (it does not depend on the
observability stack at all) and also pings the dead-man's-switch on success. Wire it per
`deploy-vps.md`.

## Validate config before deploy

```sh
sh infra/scripts/lint-observability.sh   # promtool + amtool + otelcol validate (if installed) + YAML/JSON parse
```

## Retention (trial scale)

Prometheus 15d, Tempo/Loki 7d. Bump the `--storage.tsdb.retention.time` flag and the Tempo/Loki
`retention_period` as the estate grows; watch metric cardinality (WS9 spec §5 open item).

## Alertmanager config rendering

`alertmanager.yml` is env-templated (`${VAR}`). The `prom/alertmanager` image has no `envsubst`, so a
one-shot **`alertmanager-render`** init container (alpine + gettext) renders it into a shared volume
before Alertmanager starts. Each transport you declare in the config must have its secret set — e.g.
an empty `TELEGRAM_BOT_TOKEN` makes Alertmanager reject the telegram receiver. Set the transports you
use in `.env`; comment out the receivers you don't.

## Synthetic journeys

`synthetic-prober` (`infra/observability/synthetic-prober/`) runs **functional** journeys (a real AI
completion through the Gateway, the hub tool-catalog, platform/knowledge reads) on a timer and exports
`synthetic_journey_up` / `_duration_ms`. Edit `journeys.json` to add probes (config, not code); secrets
are injected via `${ENV}` in header values. The `SyntheticJourneyFailing` alert pages on a 3-minute
failure.

## Verified end-to-end (2026-07-15)

The stack was run for real on a Docker host: metrics land in Prometheus with exact counts, traces from
Go + TS services appear in Tempo, the DR-burst gauge flips, the 4 synthetic journeys pass, SLO +
operational alerts fire and route to the correct receivers, and a restore drill completed (RTO=2s).
See the completion report for details. **One caveat**: on Docker **Desktop** the collector's filelog
receiver can't read `/var/lib/docker/containers` (permission denied), so logs→Loki only works on the
Linux VPS; metrics + traces are unaffected.
