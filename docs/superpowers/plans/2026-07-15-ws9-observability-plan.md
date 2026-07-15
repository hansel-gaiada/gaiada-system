# WS9 — Observability: build plan (full-estate, code-complete)

## Context

Workstream 9 (Observability) is the last major workstream still a **design stub**
(`docs/superpowers/specs/2026-07-04-ws9-observability.md`, "not being built yet"). Every other
workstream now emits home-grown telemetry (health endpoints, JSONL audit logs, an in-memory
agent-run collector, a gateway cost-cap, an HLC event backbone, a cron uptime alerter) but there
is **zero** OpenTelemetry, no `/metrics`, no trace-context propagation between services, and no
Prometheus/Grafana/Tempo/Loki/Alertmanager stack. Debugging the multi-layer, multi-agent flows
today means grepping disparate JSONL files with no correlation across the surface→Gateway→MCP→
platform→sync hops.

This plan builds WS9 to spec: OpenTelemetry (metrics + distributed traces + structured logs)
across the whole estate, a self-hosted Grafana-stack backend, SLOs/burn-rate alerting, per-workstream
+ exec dashboards, synthetic checks, and the **D15 resilience carry-overs (LOCKED)** — ≥2 independent
alert transports + dead-man's-switch, restore drills, and a DR-burst AI-cost budget.

**Decisions locked with the user:** full estate in one pass, code-complete (no Docker in this dev env
→ verified by builds/tests/config-lint; running the Grafana stack + E2E trace/alert/restore checks are
**deferred to a Docker host**, the same precedent as the Go-gateway cutover). Second-transport alerting
wires **all four**: Email/SMTP, self-hosted ntfy, generic webhook, and an external dead-man's-switch.

**Non-negotiables honored:** components stay **separate standalone projects** — no shared telemetry
package; each service carries its own small bootstrap module (as each Go service already does). Every
instrumented service stays runnable bare (SDK is **fail-soft / no-op when `OTEL_ENABLED` is unset**) so
tests and local dev don't need a collector. Local-first, self-hostable, OTel-based.

---

## Architecture at a glance

```
 each service (SDK)  ──OTLP traces+metrics──▶  otel-collector  ──▶ Prometheus (metrics)
   + JSON logs to stdout ──filelog──────────▶       │          ──▶ Tempo      (traces)
                                                     │          ──▶ Loki       (logs)
 exporters: postgres/redis/node/cadvisor/blackbox ──scrape──▶ Prometheus
                                                     ▼
                              Grafana (datasources + provisioned dashboards)
                              Alertmanager ──▶ Telegram · Email · ntfy · webhook · dead-man's-switch
```

W3C `traceparent` propagation is automatic via HTTP auto-instrumentation once every service runs the
SDK — no bespoke header plumbing. Logs correlate to traces via injected `trace_id`/`span_id`.

---

## Phase 1 — Per-service instrumentation (traces + metrics + logs + propagation)

**Pattern (TS services — `platform-nest`, `mcp-hub`, `wa-chat-bot` [+ `media-worker`], `ai-agents`
[knowledge service + agent runner]):**
- Add deps: `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`
  (http, undici, pg, ioredis, fastify, nestjs-core), OTLP trace + metric exporters,
  `@opentelemetry/resources` + semantic-conventions, `pino`.
- New per-project `src/telemetry.ts`: builds a `NodeSDK` (service.name resource, OTLP endpoint from
  `OTEL_EXPORTER_OTLP_ENDPOINT`, W3C propagator) and **starts only when `OTEL_ENABLED=1`**; otherwise
  exports a no-op. Loaded FIRST — `--import ./src/telemetry.ts` (tsx services) / top of
  `main.ts` before Nest bootstrap (`platform-nest`, which today runs `logger:false` +
  `console.log`, `platform-nest/src/main.ts`).
- Structured logs: pino JSON to stdout with `trace_id`/`span_id` from `@opentelemetry/api`
  active span. Replace bare `console.log` (`mcp-hub/src/server.ts:81`, platform-nest) and point
  Fastify's logger (`wa-chat-bot/src/server.ts:46`, `wa-chat-bot/src/gateway/server.ts:26`) at the
  shared pino config. Log **shipping** is via the collector's filelog receiver (Docker stdout) — services
  stay decoupled from Loki.

**Pattern (Go services — `ai-gateway-go`, `sync-engine-go`):**
- Add `go.opentelemetry.io/otel` + `otel/sdk` + `otlptracehttp`/`otlpmetrichttp` +
  `contrib/instrumentation/net/http/otelhttp`.
- New `internal/telemetry` package: Tracer+Meter providers, W3C propagator, resource, shutdown hook,
  gated on `OTEL_ENABLED`.
- Wrap the inbound handler with `otelhttp.NewHandler` (server spans + context extraction) at
  `ai-gateway-go/internal/server/server.go` and `sync-engine-go/internal/server/server.go`; wrap
  **outbound** clients (gateway→providers + central-forward; sync push/pull) with
  `otelhttp.NewTransport` so `traceparent` propagates.
- `slog` JSON handler enriched with `trace_id`/`span_id` from context; replace stdlib `log`.

**Domain metrics — wrap existing sources, don't rebuild:**
- Gateway `budget.State()` → cost/tokens/calls gauges (global + per-tenant); egress audit
  (`ai-gateway-go/internal/audit/audit.go`) → `egress_total{capability,provider,ok,blocked_reason}`
  counter + latency histogram; circuit-breaker state gauge.
- `ai-agents/src/obs/collector.ts` `ObservabilityCollector` → export `agent_success_rate`,
  `agent_refusal_rate`, by-provider, tool_failures, and `writesOnUnevaledProvider` (D13) as OTel
  observable gauges (add an `exportMetrics()` bridge; keep the in-memory collector as the source).
- mcp-hub tool audit (`mcp-hub/src/audit.ts`) → `tool_calls_total{tool,decision,ok}`.
- Sync engine `AnomalyFunc` (`sync-engine-go/internal/server/server.go:21`) → `sync_acl_rejected_total`;
  add `sync_lag_seconds` (watermark age) + `sync_conflicts_total`.
- Event backbone (`platform-nest/src/events/`) → outbox lag + dead-letter gauges.
- Bot → BullMQ media-queue depth gauge + pipeline counters; discovery events counter
  (`wa-chat-bot/src/discovery.ts`).

**Reuse the existing aggregator:** `platform-nest/src/admin/admin-systems.controller.ts` already probes
every `/health` — extend the Systems console to surface a link/deep-links into Grafana (thin), not a
reimplementation.

---

## Phase 2 — The self-hosted stack (`infra/observability/` + a second compose file)

New `infra/compose/docker-compose.observability.yml` (merged into the `gaiada` project alongside
`docker-compose.vps.yml`: `docker compose -f docker-compose.vps.yml -f docker-compose.observability.yml
up -d` — same network, opt-in, keeps the core stack lean like the separate `automation` stack). Services:

- `otel-collector` (contrib) — receivers otlp (4317/4318) + filelog (Docker logs, JSON parse,
  trace_id correlation); processors batch + resourcedetection; exporters →
  Prometheus / Tempo (otlp) / Loki. Config `infra/observability/otel-collector/config.yaml`.
- `prometheus` — scrapes the collector + exporters; loads recording + SLO alerting rules.
  `infra/observability/prometheus/{prometheus.yml, rules/*.yml}`.
- `tempo`, `loki` — trace + log backends. `infra/observability/{tempo/tempo.yaml, loki/loki.yaml}`.
- `grafana` — provisioned datasources (Prometheus/Tempo/Loki, trace↔log correlation) + provisioned
  dashboards. `infra/observability/grafana/provisioning/**` + `dashboards/*.json`.
- `alertmanager` — routes to Telegram + Email + ntfy + generic webhook; `Watchdog` route to the
  external dead-man's-switch. `infra/observability/alertmanager/alertmanager.yml`.
- Exporters: `postgres_exporter` (postgres + pg-bot), `redis_exporter` (redis + redis-bot),
  `node_exporter`, `cadvisor`, `blackbox_exporter`.
- `ntfy` — self-hosted push (chosen transport).
- `.env.example` additions: `OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, SMTP creds, ntfy topic,
  webhook URL, dead-man's-switch ping URL, Grafana admin creds. Set `OTEL_ENABLED=1` +
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` on each instrumented service in
  `docker-compose.vps.yml`.

---

## Phase 3 — Reliability engineering (SLOs, dashboards, synthetic checks)

- **SLOs**: per critical service (gateway availability+latency, platform API errors+latency, bot reply
  success, sync freshness, agent success-rate) as Prometheus recording rules (SLI) +
  **multi-window multi-burn-rate** error-budget alerts. `infra/observability/prometheus/rules/slo.yml`.
  Targets documented in `infra/runbooks/observability-slo.md`.
- **Dashboards** (Grafana JSON, provisioned): one per workstream (WS1 platform+sync, WS2 hub, WS3
  gateway, WS4 automation, WS8 agents, bot surface) + an **exec health overview**.
- **Synthetic checks**: `blackbox_exporter` for endpoint uptime probes + a small `synthetic-prober`
  service running key user journeys on a timer (bot reply, assistant skill, login) and emitting OTel
  metrics/logs. Journey failures feed SLO alerts.

---

## Phase 4 — D15 resilience carry-overs (LOCKED)

1. **Alert diversity + dead-man's-switch** — Alertmanager fans to Telegram + Email + ntfy + webhook
   (independent paths, not all on the WhatsApp/Telegram transport). An always-firing `Watchdog` alert
   routes to an **external** dead-man's-switch (healthchecks.io/Cronitor ping) so a fully-dark box
   (Prometheus/AM themselves down) is still caught. Upgrade `infra/scripts/healthcheck.sh` into a
   second, **out-of-band** heartbeat+alerter (independent of the collector) that also pings the
   dead-man's-switch and can send on a second transport.
2. **Restore drills** — `infra/scripts/restore-drill.sh`: restores the nightly encrypted backup
   (`infra/scripts/backup.sh`) into an **isolated ephemeral Postgres**, runs integrity checks, measures
   + records **RPO/RTO**, emits a success heartbeat (a skipped/failed drill alerts). Weekly cron +
   `infra/runbooks/restore-drill.md`; publish per-tier RPO/RTO once measured.
3. **DR-burst budget** — add a bounded, time-boxed burst cap to `ai-gateway-go/internal/budget/budget.go`,
   **separate** from the steady daily cap, auto-unlocked on a declared failover via an admin toggle
   (`POST /admin/dr-mode` + `DR_MODE` env). Still capped (no runaway); a metric + alert fires while DR
   mode is active. Prevents a multi-day outage from instantly degrading to placeholders.

---

## Verification (no Docker in dev env)

- **TS**: `npm run typecheck` + `npm run test` in each instrumented service (SDK no-op path keeps tests
  green with no collector). New unit tests: collector→OTel metrics bridge, pino trace-id injection,
  budget DR-mode.
- **Go**: per-service `wsl.ps1` → `go build ./... && go vet ./... && go test ./...` (WSL Go 1.26).
  New tests: telemetry init no-op, DR-burst budget accounting, sync-lag metric.
- **Config-lint** (best-effort in-env; full run on Docker host): YAML/JSON structural validation for all
  collector/Prometheus/Tempo/Loki/Grafana/Alertmanager configs + dashboard JSON; run
  `promtool check`, `otelcol validate`, `amtool check-config` if the binaries are fetchable. Add a
  config-lint job to `infra/scripts/test-all.sh` + the GH Actions workflow.
- **Deferred to a Docker host** (documented checklist in the completion report + runbook, mirroring the
  gateway cutover): `compose up` the merged stack; confirm a request traces end-to-end
  surface→Gateway→MCP→platform in Tempo; dashboards populate from Prometheus; logs correlate in Loki;
  fire a test alert to **all four** transports + verify the dead-man's-switch; run one restore drill and
  record RPO/RTO; exercise DR-mode.

---

## Docs & discipline (on completion)

- This plan → `docs/superpowers/plans/2026-07-15-ws9-observability-plan.md`.
- Flip the WS9 spec status; close **P5f** items in `2026-07-05-phase-5-full-fidelity.md`; update
  `CLAUDE.md` status + `README.md`; write a completion report with the deferred-verification checklist.
- Runbooks: `infra/runbooks/observability.md` (operate the stack), `observability-slo.md`,
  `restore-drill.md`, DR-mode notes in `deploy-vps.md`.
- New memory file `ws9-observability-*.md` + `MEMORY.md` pointer.

## Build order

Phase 1 (instrument, one service at a time, builds/tests green each) → Phase 2 (stack + configs) →
Phase 3 (SLOs/dashboards/synthetics) → Phase 4 (D15) → verification + docs. Instrument the **gateway
first** (richest existing telemetry: budget + egress audit) as the end-to-end template, then fan out.
