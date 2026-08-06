# Runbook — OBS-02 Loki (logs tier)

Loki runs as its own compose project (`gaiada-loki`, `infra/compose/docker-compose.loki.yml`),
following the same "separate project survives `--remove-orphans`" precedent as
`gaiada-alertmanager` and `gaiada-otel-metrics`. It is **not** merged into the main `gaiada`
project and needs no `COMPOSE_PROFILES` change.

The `gaiada-otel-metrics` project's `otel-collector` was promoted from
`config.tier1-metrics.yaml` (metrics only) to `config.tier2-logs.yaml` (metrics + logs, still no
traces/Tempo) to re-add the filelog receiver and ship container stdout to Loki over the shared
`gaiada_default` external network.

## Why no Grafana

Skipped to keep the footprint small on a disk-constrained box. Query Loki directly over its HTTP
API through the SSH tunnel — same loopback-only pattern as every other admin surface here
(Mailpit `:8025`, Prometheus `:9090`, Alertmanager `:9093`).

```sh
ssh -L 3100:localhost:3100 user@gda-aicenter
```

```sh
# Range query, last 15 minutes, all streams
curl -sG http://localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={compose_project=~".+"}' \
  --data-urlencode 'start='$(date -d '-15 min' +%s)000000000 \
  --data-urlencode 'end='$(date +%s)000000000 | jq .

# Magic-link audit lines only
curl -sG http://localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={container=~".*platform.*"} |= "magic-link:audit"' \
  --data-urlencode 'start='$(date -d '-1 hour' +%s)000000000 \
  --data-urlencode 'end='$(date +%s)000000000 | jq .
```

Add Grafana later as a drop-in (bind loopback-only, exactly like this) if a UI becomes worth the
extra image size and one more tunneled port.

## Retention

`infra/observability/loki/loki.yaml`: `retention_period: 168h` (7 days) with the compactor
**enabled** (`compaction_interval: 10m`, `retention_enabled: true`,
`delete_request_store: filesystem`). Retention alone in `limits_config` does nothing without the
compactor actually running — this bit us in spirit already (see
`infra/runbooks/observability.md`'s note on the disk-fills-then-rollback deploy failure); logs are
the last thing this box needs unbounded growth from again.

**Sizing basis (measured on gda-aicenter, 2026-08-06):** raw Docker json-file logs across the
fleet totalled ~19MB, overwhelmingly dominated by `cerbos` (16MB in ~2h — call it ~190MB/day if
sustained) and `platform` (~1.3MB in ~2h, ~16MB/day); every other container was under 1MB/day.
Budgeting generously for the noisy `cerbos` rate: ~210MB/day raw ingested x 7 days ≈ 1.5GB raw.
Loki's TSDB chunks compress structured/JSON log lines well (typically 8-15x); expect **steady-state
Loki storage in the 150-350MB range** for the 7-day window, well inside the box's current ~12GB
free. If `cerbos`'s log volume keeps climbing, revisit its log level (out of scope for OBS-02 —
that's a Cerbos config change, not a Loki-plumbing one) before extending retention further.

## Deploy-survival

Loki (`gaiada-loki`) and the collector's logs pipeline (`gaiada-otel-metrics`) are separate
projects from `gaiada`. `deploy.yml`'s `up -d --remove-orphans` only ever targets the `gaiada`
project's own compose files, so it cannot see or reap containers in `gaiada-loki` or
`gaiada-otel-metrics` — verified by running a deploy-shaped
`docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml up -d --remove-orphans`
against the live box and confirming all four non-`gaiada` projects (`gaiada-alertmanager`,
`gaiada-automation`, `gaiada-otel-metrics`, `gaiada-loki`) were untouched.

## Known gap (2026-08-06, OBS-02)

The magic-link audit lines this ticket exists to make findable
(`platform-nest/src/mail/magic-link/service.ts`'s `logMagicLinkAudit`) do **not** carry the
address for the two branches this ticket names:

- `consume.rejected` logs only `{ reason }` — no IP, no address (consume only ever has a token,
  never an email, so there is no address to log on that path by construction).
- `mint.rate_limited` logs `{ ip }` — the source IP IS present, but the `email` variable in scope
  at that call site is deliberately not passed into the log detail.

Loki plumbing makes the emitted lines durable and searchable exactly as documented — that part of
OBS-02 is done and verified — but it cannot manufacture fields the emitter never writes. Getting
the address onto the `mint.rate_limited` line (and, if wanted, the IP onto `consume.rejected` via
the same detail object) is a one-line change in `service.ts`, which is out of scope for OBS-02 by
the ticket's own guardrail (that file is owned by a concurrent session). Flag this to whoever owns
`platform-nest/src/mail/**` next.
