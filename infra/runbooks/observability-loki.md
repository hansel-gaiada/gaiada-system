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
  --data-urlencode 'query={service_name=~".+"}' \
  --data-urlencode 'start='$(date -d '-15 min' +%s)000000000 \
  --data-urlencode 'end='$(date +%s)000000000 | jq .

# Magic-link audit lines only. Correct exclusion filter REQUIRED (see OBS-04 below) — without
# it, a search for any string also matches Loki's own query-log lines that echo that string
# back in their `query=` field, producing a false positive.
curl -sG http://localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={service_name=~".+"} |= "magic-link:audit"' \
  --data-urlencode 'start='$(date -d '-1 hour' +%s)000000000 \
  --data-urlencode 'end='$(date +%s)000000000 | jq .
```

Add Grafana later as a drop-in (bind loopback-only, exactly like this) if a UI becomes worth the
extra image size and one more tunneled port.

## Per-container query (OBS-04, fixed 2026-08-07)

**`{container=~".*cerbos.*"}` (this runbook's previous example) does not run — no `container`
label has ever existed.** The only labels Loki has ever actually indexed here are `service_name`
(set by services that push real OTLP, e.g. `platform`) and, as of OBS-04, `container_name` (set
by the collector for containers whose compose service opts in — currently just `cerbos`; see
`docker-compose.vps.yml`'s `cerbos` service and `config.tier2-logs.yaml`'s `container.name` lift).
Verified working:

```sh
curl -sG http://localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={container_name=~".*cerbos.*"}' \
  --data-urlencode 'start='$(date -d '-15 min' +%s)000000000 \
  --data-urlencode 'end='$(date +%s)000000000 | jq .

# List every label Loki currently indexes, to check before writing a new query
curl -sG http://localhost:3100/loki/api/v1/labels \
  --data-urlencode 'start='$(date -d '-24 hour' +%s)000000000 \
  --data-urlencode 'end='$(date +%s)000000000 | jq .
```

To get `container_name` on another container, add the same two things `cerbos` has: (1) that
service's compose entry gets `logging: {driver: json-file, options: {labels:
"com.docker.compose.service"}}`, and (2) nothing else — the collector's existing `container.name`
lift operator (guarded, no-op for containers without the label) picks it up automatically.
Recreating that one service (`docker compose ... up -d --no-deps <service>`) is required for the
new logging driver option to take effect.

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

## Self-ingestion false positives (OBS-04, fixed 2026-08-07)

Loki logged every query it received, including the query string itself
(`caller=metrics.go ... query="<search term>"`), and — before this fix — the collector's filelog
receiver tailed Loki's own container log too. Net effect: searching for `X` could "find" `X` for
no reason other than Loki having just logged the search for `X`. This produced a real false
positive during verification of this ticket (a search for `mint.unknown_address` "found" two
hits that were both Loki's own query-log lines; the genuine application record existed but was a
separate, buried line).

**Fix:** `gaiada-loki`'s `loki` service (`docker-compose.loki.yml`) now runs with
`logging: {driver: local}` instead of Docker's default `json-file`. The `local` driver does not
produce a `*-json.log` file at all, so the collector's filelog glob
(`/var/lib/docker/containers/*/*-json.log`) structurally cannot see it — no query-string filter
is needed, and none should be relied on as the primary defense. `docker logs gaiada-loki-loki-1`
still works.

**If you're ever unsure whether a hit is real:** confirm it doesn't have `caller=metrics.go` or
`caller=engine.go` in it. Post-OBS-04, on a healthy box, it never will.

## Structured-metadata overhead (OBS-04, fixed 2026-08-07)

The collector previously parsed every container's **entire** JSON log body into OTel log
attributes (`parse_to: attributes`). For Cerbos's audit-decision lines — which embed the full
`checkResources` inputs/outputs payload — every nested field got flattened (Loki's OTLP ingestion
joins nested keys with `_`, e.g. `checkResources_inputs`, `auditTrail_effectivePolicies_*`) and
shipped again as Loki structured metadata, on top of the same content already sitting in the log
body. Measured before the fix: ~94% of ingested bytes per Cerbos audit line were this redundant
structured-metadata overhead. After the fix (`config.tier2-logs.yaml` only lifts `level` for
severity detection and discards the rest of the parsed tree — the raw JSON stays in `body`,
queryable with `|= "..."` or `| json` at query time): ~3.6% overhead on the same kind of line
(measured: 152249 bytes total / 5488 bytes structured metadata over 50 lines). This is a
collector/Loki plumbing change only — Cerbos's own log content and audit fields are untouched.

These fields were never real Loki **index labels** (cardinality was never actually exploding —
`{service_name}` was always the only real label until `container_name` was added above); the
`checkResources_inputs`-as-label appearance in raw `query_range` JSON responses is Loki's API
merging per-line structured metadata into the same `stream` object as true labels for display
convenience. `/loki/api/v1/labels` is the source of truth for what's actually indexed.

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
