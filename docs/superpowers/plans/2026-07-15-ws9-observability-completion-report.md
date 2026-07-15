# WS9 — Observability: completion report

**Date:** 2026-07-15
**Status:** ✅ CODE-COMPLETE. Full-estate OpenTelemetry + self-hosted Grafana stack + SLOs +
dashboards + synthetic checks + the D15 resilience carry-overs. Verified by builds/tests + the real
config-linters; the live `compose up` E2E run is **deferred to a Docker host** (no Docker in the dev
env — the same precedent as the Go-gateway cutover).
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

## Verification done here

- **Go**: `go build ./... && go vet ./... && go test ./...` green for both services (incl. new
  DR-burst budget, telemetry no-op, and sync freshness-metric tests). DB-backed sync suite runs in CI.
- **TS**: `tsc --noEmit` clean for all four projects; test suites green
  (mcp-hub 51, wa-chat-bot 187 non-DB, ai-agents 87 incl. the new collector→OTel bridge test);
  platform-nest `npm run build` green. Postgres/Cerbos/Redis-dependent suites run in CI as before.
- **Config-linters (real tools, via WSL)**: `promtool check rules` (16 rules) + `promtool check
  config` ✓; `amtool check-config` (env-rendered) ✓; `otelcol-contrib validate` ✓; YAML/JSON parse
  for tempo/loki/grafana/blackbox/ntfy/compose ✓; `dash -n` for all scripts ✓. Wired into
  `infra/scripts/lint-observability.sh`, `test-all.sh`, and a new CI `observability-lint` job.
- **Bonus fix**: normalized `infra/scripts/*.sh` to LF — `backup.sh`/`test-all.sh` had CRLF that
  would have broken them under Linux `sh`/dash.

## Deferred to a Docker host (checklist)

The dev env has no Docker, so the stack was not run end-to-end. Before relying on it in prod:

- [ ] `docker compose -f docker-compose.vps.yml -f docker-compose.observability.yml up -d --build`
      (also run `otelcol validate` there if not already).
- [ ] Confirm a single request traces **end-to-end** surface→Gateway→MCP→platform→(sync) in Tempo,
      with logs correlated by `trace_id` in Loki.
- [ ] Confirm all four Grafana dashboards populate from Prometheus.
- [ ] Fire a test alert and confirm delivery on **every** configured transport
      (Telegram/email/ntfy/webhook) + that the external dead-man's-switch registers the heartbeat.
- [ ] Run `restore-drill.sh` once; copy the measured RTO/RPO into `observability-slo.md`.
- [ ] Exercise DR-mode (`POST /admin/dr-mode`) and confirm the `GatewayDRModeActive` alert.

## Known follow-ups (not blockers)

- Synthetic **journeys** beyond HTTP liveness (authenticated bot-reply / assistant-skill / login
  probes) — needs test credentials; staged as a follow-up.
- Metric cardinality/retention budget at multi-site scale (spec §5 open item).
- Off-box backup shipping (P5f) and the WS10 zero-trust/GitOps items remain open.
