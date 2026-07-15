# Workstream 9 — Observability

**Date:** 2026-07-04
**Status:** ✅ BUILT (code-complete 2026-07-15). All 7 services instrumented with OpenTelemetry
(traces + metrics + trace-correlated logs, W3C context propagation); self-hosted stack
(OTel Collector → Prometheus/Tempo/Loki + Grafana + Alertmanager + exporters + ntfy) as an opt-in
compose file; SLOs + multi-burn-rate alerts; per-workstream + exec dashboards; blackbox synthetic
probes; and the **D15 carry-overs** (≥2 independent alert transports + dead-man's-switch, a measured
restore drill, and a DR-burst AI budget). Verified by builds/tests + real config-linters
(promtool/amtool/otelcol validate); the live `compose up` E2E run is deferred to a Docker host (no
Docker in the dev env — same precedent as the Go-gateway cutover). Plan:
`../plans/2026-07-15-ws9-observability-plan.md`; report:
`../plans/2026-07-15-ws9-observability-completion-report.md`.
**Parent:** `2026-07-04-gaiada-ai-platform-roadmap.md` (Workstream 9)
**Scope:** System-wide observability — distinct from the WS7 security SIEM. How we see, measure, and operate the whole estate at top-tier grade.

---

## 1. Pillars (OpenTelemetry-based)

- **Metrics** — service + business KPIs (latency, throughput, error rates, queue depth, sync lag, AI cost/tokens).
- **Distributed tracing** — end-to-end across surfaces → Gateway → MCP → platform → sync; **critical for debugging the multi-layer, multi-agent flows**. Agent runs are traced (WS8).
- **Structured logs** — correlated by trace/span IDs; shipped centrally.

## 2. Reliability engineering

- **SLOs + error budgets** per critical service; alerting on burn rate.
- **Dashboards** per workstream + an exec health view.
- **Synthetic checks** for key user journeys (bot reply, assistant skill, login).

## 3. Stack (candidates, all self-hostable / all-local)

- OpenTelemetry SDKs → collector.
- Metrics: Prometheus + Grafana. Traces: Tempo/Jaeger. Logs: Loki. (Grafana stack, or unified alt.)
- Alerting: Alertmanager → shared alert path (management group + on-call), same channel family as sync-lag / cost / security alerts.

## 4. Ties to other workstreams

- **WS8 AI evals/traces** flow here (agent quality, hallucination, cost).
- **WS7 security** consumes/overlaps telemetry but keeps its own SIEM for detection; observability is for operating, SIEM is for defending.
- **Gateway/MCP/sync** all emit standardized telemetry.

## 4b. D15 — resilience carry-overs for v1 (LOCKED, adversarial review)

Managed infra covers HA/backups; these are the gaps it does NOT:

- **Alert diversity + dead-man's-switch:** ≥2 **independent** alert transports (NOT only the WhatsApp management group, which shares the failing path) + a heartbeat so a dark/silent system is detectable rather than looking healthy.
- **Restore drills:** a scheduled, actually-executed restore of the managed backups into isolation — an untested backup is not a backup. Publish a per-tier RPO/RTO once measured.
- **DR-burst budget:** a bounded AI-cost burst budget separate from the steady cost-cap, auto-unlocked on a declared failover, so a real multi-day outage doesn't instantly degrade to placeholders (nor run away unbounded).

## 5. Open items
- Metrics cardinality/retention budget across many sites.
- Per-tenant vs global dashboards.
- Edge/offline telemetry buffering + backfill (sites lose connectivity).
- Unified vs Grafana-stack final choice.
