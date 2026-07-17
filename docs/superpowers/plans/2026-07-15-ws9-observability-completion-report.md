# WS9 — Observability: completion report

**Date:** 2026-07-15 (re-verified full-estate 2026-07-16)
**Status:** ✅ COMPLETE **and verified end-to-end on a live Docker stack (2026-07-15; re-verified as
part of a full 31-container estate bring-up on 2026-07-16 — see "Full-estate local re-verification").**
Full-estate
OpenTelemetry + self-hosted Grafana stack + SLOs + dashboards + functional synthetic journeys + the
D15 resilience carry-overs. The pipeline was stood up for real (`docker compose … -f
docker-compose.observability.yml up`), traffic driven, and traces/metrics/alerts/restore-drill
observed working — which caught **three runtime bugs that builds/tests did not** (see "Bugs found by
running it"). Not reproducible in this env: filelog→Loki log shipping (Docker Desktop denies the
`/var/lib/docker/containers` bind; works on the Linux VPS) and actual external alert delivery (needs
real Telegram/SMTP creds — routing to the receivers is verified).
**Plan:** `2026-07-15-ws9-observability-plan.md`. **Spec:** `../specs/2026-07-04-ws9-observability.md`.

---

## What shipped

### Pillar 1 — Instrumentation (all 7 services)
Each service carries its **own** telemetry bootstrap (no shared package — separate-projects rule),
**fail-soft** (no-op unless `OTEL_ENABLED`), emitting OTLP traces+metrics and trace-correlated JSON
logs with **W3C `traceparent` propagation** (automatic via HTTP instrumentation once every service
runs it).

- **ai-gateway-go** — `internal/telemetry` (OTel init + slog trace correlation) + `internal/metrics`
  (egress counter/latency histogram + budget observable gauges + DR-mode gauge, wrapping the existing
  egress audit + cost budget). `otelhttp` on the inbound handler + outbound transport.
- **sync-engine-go** — copied telemetry pkg + `internal/metrics` (applied/rejected/conflicts/cycles
  counters + the `sync_seconds_since_last_success` freshness SLI). `otelhttp` on the central server +
  the mTLS push/pull client. Anomaly-path rejections now increment a metric.
- **platform-nest** — `src/telemetry.ts` (NodeSDK, loaded before AppModule) + `src/metrics.ts`
  (event-backbone: consumed/dead-lettered counters + processing-lag histogram). Fastify logger →
  pino JSON with trace ids when OTEL is on. **The dead-letter path that used to be a greppable log
  line is now an alertable metric** (closing the TODO that comment left for WS9).
- **mcp-hub** — `src/telemetry.ts` + `src/metrics.ts` (tool-call counter mirrored from the audit).
- **wa-chat-bot (+ media-worker)** — `src/telemetry.ts` + `src/metrics.ts` (PII-free discovery
  counter + media enqueued/processed counters).
- **ai-agents** — `src/telemetry.ts` (knowledge service + CLI) + `src/obs/otel-bridge.ts`, the
  **WS8→WS9 feed**: the existing `ObservabilityCollector` rollup (success rate, alerts, and the D13
  "wrote on un-evaled provider" detective control) exported as OTel observable gauges.

### Pillar 2 — The stack (`infra/observability/` + `docker-compose.observability.yml`)
OTel Collector (OTLP in; filelog tail of container logs) → **Prometheus** (metrics) / **Tempo**
(traces) / **Loki** (logs); **Grafana** with provisioned datasources (trace↔log correlation) +
dashboards; **Alertmanager**; exporters (postgres×2, redis×2, node, cadvisor, blackbox); self-hosted
**ntfy**. Opt-in second compose file merged into the `gaiada` project; OTEL is switched on for the
core services via merge-override env in that file, so the data plane never depends on the collector.

### Pillar 3 — Reliability
- **SLOs**: multi-window multi-burn-rate rules (`rules/slo.yml`) for availability + gateway success;
  operational alerts (`rules/alerts.yml`) for dead-letters, sync staleness, budget, DR-mode, agent
  quality, and the D13 detective. Targets documented in `runbooks/observability-slo.md`.
- **Dashboards**: exec health overview + WS3 gateway + WS1 platform/sync + WS8 agents/hub/bot.
- **Synthetic checks**: blackbox HTTP probes of every service `/health` (→ availability SLI).

### Pillar 4 — D15 carry-overs (LOCKED)
1. **Alert diversity + dead-man's-switch** — Alertmanager fans to Telegram + email + ntfy + webhook;
   the always-firing `Watchdog` routes to an external dead-man's-switch. `healthcheck.sh` upgraded to
   a second, **out-of-band** alerter (≥2 transports + switch ping) independent of the Prometheus path.
2. **Restore drills** — `restore-drill.sh`: restores the nightly dumps into an isolated throwaway
   Postgres, integrity-checks, and **measures RTO/RPO**; alerts on failure, pings the switch on
   success. Weekly cron; runbook `restore-drill.md`.
3. **DR-burst budget** — a bounded, time-boxed AI-cost burst in `ai-gateway-go/internal/budget`,
   unlocked only on a declared failover (`DR_MODE` env or `POST /admin/dr-mode`); metered + alerted.

---

## Static verification

- **Go**: `go build/vet/test` green both services (incl. DR-burst budget, telemetry no-op, sync
  freshness-metric tests). DB-backed sync suite runs in CI.
- **TS**: `tsc --noEmit` clean all four; suites green (mcp-hub 51, wa-chat-bot 187 non-DB, ai-agents 87
  incl. the collector→OTel bridge test); platform-nest `build` green.
- **Config-linters (real tools)**: `promtool check rules` (17 rules incl. the synthetic-journey
  alert) + `promtool check config` ✓; `amtool check-config` ✓; `otelcol validate` ✓; YAML/JSON parse
  ✓; `dash -n` all scripts ✓. Wired into `lint-observability.sh` + a CI `observability-lint` job.
- **Bonus fix**: normalized `infra/scripts/*.sh` to LF — `backup.sh`/`test-all.sh` had CRLF that
  would break them under Linux `sh`/dash.

## End-to-end verification on a live Docker stack (2026-07-15)

Brought the observability stack up alongside the running core stack and drove real traffic:

- **Docker builds**: the WS9-instrumented **Go gateway** and **TS mcp-hub** images build and run.
- **Metrics**: drove 6 successful + 1 auth-blocked `/complete` calls across 2 tenants →
  Prometheus shows `gateway_egress_requests_total{ok="true"}=6`, `{blocked="auth"}=1`,
  `gateway_budget_calls_used=6`, `gateway_budget_active_tenants=2` — exact match. OTLP → collector →
  Prometheus proven.
- **Traces**: Tempo holds spans from `ai-gateway` (Go), `mcp-hub` + `platform` (TS NodeSDK) — both
  instrumentation stacks confirmed.
- **Observable gauges + DR-burst**: `POST /admin/dr-mode {enable:true}` → `gateway_dr_mode` flipped
  1 in Prometheus; disabling flipped it back.
- **Synthetic journeys**: the prober's 4 journeys (incl. a real AI completion through the provider
  chain) all report `synthetic_journey_up=1` in Prometheus.
- **SLO + operational alerts fired on real data** — `Watchdog`, `ServiceDown`, `SLOAvailabilityFastBurn`
  (a service was intentionally absent) — and **Alertmanager received + routed them to the correct
  D15 receivers** (`Watchdog → deadmansswitch`, page → `page-all` = all four transports). The
  env-templated Alertmanager config renders + loads (via the init-render container).
- **Grafana**: provisioned Prometheus/Tempo/Loki datasources (trace↔log correlation) confirmed.
- **Restore drill**: created a real dump of `gaiada_platform`, ran `restore-drill.sh` → restored into
  an isolated throwaway Postgres, integrity-checked (37 tables), **RTO=2s, RPO=0h**.

### Bugs found by running it (that builds/tests did NOT catch)
1. **Go resource schema-URL conflict** — `resource.Merge(Default(), NewWithAttributes(semconv.SchemaURL,…))`
   errored at runtime (`conflicting Schema URL 1.41.0 vs 1.26.0`), so telemetry silently fell back to
   no-op and exported nothing. Fixed: use `resource.NewSchemaless(…)`. (gateway + sync)
2. **Alertmanager envsubst render** — the entrypoint did `apk add gettext` but `prom/alertmanager`
   isn't Alpine, so `envsubst` was missing and it wrote an empty config ("no route provided"). Fixed:
   a dedicated `alertmanager-render` init container (alpine + gettext) renders into a shared volume.
3. **Restore into isolation failed on missing roles** — `backup.sh` dumps WITH ownership/GRANTs, so a
   restore into a role-less instance errored under `ON_ERROR_STOP`. Fixed: the drill pre-creates the
   cluster's roles as no-login stubs before restore.

### Not reproducible in this env (works on the Linux VPS target)
- **filelog → Loki**: Docker Desktop denies the `/var/lib/docker/containers` bind mount
  (`permission denied`); the Linux VPS has no such restriction. Metrics/traces (OTLP push) are
  unaffected and proven above.
- **External alert delivery**: routing to the receivers is verified; actual send needs real
  Telegram/SMTP/webhook creds.

## Full-estate local re-verification (2026-07-16)

The observability stack was brought up again as part of running the **entire** platform locally in
Docker — **31 containers**: the full core/data plane (postgres×2, redis×2, cerbos, ai-gateway,
keycloak, platform, knowledge, mcp-hub, bot+media-worker, waha, whisper, sync-central), the separate
n8n automation stack, and the complete observability stack. Layered as
`-f docker-compose.vps.yml -f docker-compose.local.yml -f docker-compose.devui.yml
-f docker-compose.observability.yml -f docker-compose.obs-local.yml`.

- **Telemetry flowing, all targets green:** Prometheus **14/14 scrape targets UP**; the collector's
  `prometheusexporter` actively processing OTLP metrics from the core services; Grafana (`:3001`) +
  Prometheus (`:9090`) healthy. (`platform-ui` runs as a host `next dev` hot-reload server, so its
  container is intentionally stopped — the UI role is still served.)

### Additional bugs found by running it (that builds/tests did NOT catch)
4. **otel-collector self-metrics unreachable** — `service.telemetry.metrics.address` was unset, so the
   collector bound its own metrics to `localhost:8888`; Prometheus (which scrapes `otel-collector:8888`
   per `prometheus.yml`) got connection-refused → 1 target permanently down. Fixed: set
   `address: 0.0.0.0:8888` in `otel-collector/config.yaml` (a real fix — applies on the VPS too). 14/14 after.
5. **node-exporter mount rejected on Docker Desktop** — `/:/host:ro,rslave` propagation errors
   ("path / is mounted on / but it is not a shared or slave mount") on Docker Desktop/WSL2, which
   aborted the compose `up`. Fixed locally in `docker-compose.obs-local.yml` (`!override` drops
   `rslave`); the committed VPS file keeps `rslave` for real Linux hosts.
6. **Alertmanager crash-loop with no creds** — the prod `alertmanager.yml` requires
   Telegram/SMTP/dead-man's-switch secrets absent on a dev box → "missing bot_token" load failure,
   restart loop. Fixed for local with `alertmanager.local.yml` (routes to the self-hosted ntfy, no
   creds), mounted via `docker-compose.obs-local.yml`; the prod multi-transport config is untouched.

New local-only override files added this session: `infra/compose/docker-compose.obs-local.yml`,
`infra/observability/alertmanager/alertmanager.local.yml`. The `filelog → Loki` limitation is
unchanged (Docker Desktop denies the container-logs bind; unaffected on the Linux VPS).

> Same 2026-07-16 bring-up also stood up the rest of the estate and added **hybrid OIDC/SSO**
> (Keycloak) alongside dev-login — outside WS9 scope; documented separately (identity/authz).

## Known follow-ups (not blockers)

- Copy measured per-tier RTO/RPO into `observability-slo.md` after a few real weekly drills.
- Metric cardinality/retention budget at multi-site scale (spec §5 open item).
- Off-box backup shipping (P5f) and the WS10 zero-trust/GitOps items remain open.
