# Runbook — WS9 SLOs & error budgets

SLIs are Prometheus recording rules; alerts are **multi-window multi-burn-rate** (Google SRE method)
so a fast burn pages and a slow burn tickets. Rules live in
`infra/observability/prometheus/rules/slo.yml`; operational alerts in `.../alerts.yml`.

## Targets (v1, trial scale — revise once real traffic data exists)

| SLO | Target | SLI source | Alert |
|-----|--------|-----------|-------|
| Service availability (per probed endpoint) | 99% | `probe_success` (blackbox synthetic) | `SLOAvailabilityFastBurn` (page, 14.4x/1h+5m), `SLOAvailabilitySlowBurn` (ticket, 6x/6h+30m) |
| Gateway request success | 99% | `gateway_egress_requests_total{ok}` | `SLOGatewayErrorFastBurn` (page) |
| Sync freshness | < 15 min since last success | `sync_seconds_since_last_success` | `SyncStale` (ticket) |
| Event backbone integrity | 0 dead-letters | `platform_events_dead_lettered_total` | `EventBackboneDeadLetters` (ticket) |
| Agent quality | per-agent floor | `agent_success_rate` / `agent_quality_alert` | `AgentQualityAlert` (ticket) |

## Burn-rate math

Availability SLO 99% ⇒ error budget = 1%. A **14.4x** burn over both a 1h and a 5m window exhausts a
30-day budget in ~2 days → **page**. A **6x** burn over 6h+30m → **ticket**. The two-window
requirement suppresses flapping (a blip won't page unless it's sustained across both windows).

## RPO / RTO (publish once measured)

The D15 restore drill (`infra/scripts/restore-drill.sh`, weekly cron) measures and logs **RTO**
(restore duration) and **RPO** (backup age) on every run. After a few cycles, record the observed
per-tier numbers here so recovery expectations are documented, not assumed:

| Tier | Databases | RPO (measured) | RTO (measured) |
|------|-----------|----------------|----------------|
| Platform | gaiada_platform | _TBD — fill from drill logs_ | _TBD_ |
| Knowledge | gaiada_knowledge | _TBD_ | _TBD_ |
| Bot | gaiada_bot | _TBD_ | _TBD_ |

## DR-burst budget (D15)

On a declared failover the steady daily AI-call cap would otherwise degrade the estate to
placeholders within hours. The gateway carries a **separate, bounded, time-boxed** DR-burst
allowance, unlocked only on declaration:

- Boot-time (env-declared failover): `DR_MODE=true` (+ `DR_BURST_CAP`, `DR_DURATION_MIN`).
- Runtime: `POST /admin/dr-mode` (bearer `GATEWAY_TOKEN`), body `{"enable":true,"durationMinutes":720}`.
- While active, `gateway_dr_mode=1` and the `GatewayDRModeActive` alert fires (so an unlock is never
  silent). The burst is finite and expires — it cannot run away.
