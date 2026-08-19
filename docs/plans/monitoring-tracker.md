# Monitoring programme — running tracker

**Updated:** 2026-08-19 · **Status vocabulary:** PLANNED · IN PROGRESS · PROTOTYPED · DEV-VERIFIED
(nothing here is production). Design: [`monitoring-program.md`](../blueprints/monitoring-program.md).

Two planes, and they never merge. **Plane A** = our own infrastructure (staff-only, not sellable).
**Plane B** = the tenant's clients' websites (tenant-scoped, Cerbos-gated, sellable).

---

## ✅ DONE — Plane A (our infrastructure)

| Ticket | What | State |
|---|---|---|
| — | Deployed the observability stack on `gda-aicenter` (exporters, cAdvisor, blackbox, Grafana, Tempo, ntfy) | DEV-VERIFIED — Prometheus targets went **2/14 → 14/14** |
| — | Added `DiskSpaceLow` + `DiskWillFillIn24h` — **there were no disk alerts at all** | DEV-VERIFIED |
| MON-09e | Rollback that survives a release adding a service (`infra/scripts/rollback-to.sh`) + a bad-tag safety gate | DEV-VERIFIED |
| MON-09f | `synthetic-prober` built/pushed by `release.yml`; compose declares `image:` | DEV-VERIFIED |
| MON-09g | Infra drift committed and shipped in a tag (it had been reverted by a deploy once) | CLOSED |
| MON-09i | ERP **Systems → Observability** console + `GET /api/admin/observability` | DEV-VERIFIED |
| MON-09j | Exporter DSNs repointed at the real host DB/role (they pointed at containers that never run here) | DEV-VERIFIED |
| MON-09k | `PostgresDown` / `RedisDown` alerts — **nothing was watching `pg_up`/`redis_up`** | DEV-VERIFIED |
| MON-09l | Grafana **Host & Infrastructure** dashboard, 9 panels, every query verified live | DEV-VERIFIED |
| MON-09m | Dedicated read-only `gaiada_exporter` role holding only `pg_monitor` | DEV-VERIFIED |
| MON-09q | Log pipeline: uid-10001 could not list the docker log dir **+** a deploy had reverted the collector config | DEV-VERIFIED |
| MON-09r | `RemoteWriteStalled` — closes the blind spot the relocation itself created | DEV-VERIFIED |
| — | **Relocated storage+alerting to the SumoPod VPS** over WireGuard; metrics, logs and traces all confirmed | DEV-VERIFIED |
| — | Removed 8 junk labels from every series (`resource_to_telemetry_conversion`) | DEV-VERIFIED |
| — | Tempo retention 168h → 72h after measuring what actually consumed disk | DEV-VERIFIED |
| — | Fixed the runbook's stale container baseline (said 19, actually 37) | CLOSED |

## ✅ DONE — Plane B (client monitoring)

| Ticket | What | State |
|---|---|---|
| — | UI: `/monitoring` board, detail, editor, channels + `lib/monitoring.ts` + demo fixtures + nav + contract §20 | PROTOTYPED (browser-driven) |
| MON-10 | Schema `0116`: 9 tables, FORCE RLS on all, `monitor_results` partitioned | DEV-VERIFIED (applied to a throwaway DB) |
| MON-10b | IAM `0117`: 9 permissions, 2 roles, 32 bundles + module contract + boot registration | DEV-VERIFIED (idempotency proven) |
| — | Cerbos policies for 5 resource kinds (role arms) | PROTOTYPED — needs a Cerbos restart + probe |
| MON-11a | Driver registry: absent-not-inert, no default branch, registration pin | DEV-VERIFIED |
| MON-11b | SSRF egress floor + **closed an IP-literal bypass** found by probing Node | DEV-VERIFIED (mutation-probed) |
| MON-11c | `http` + `keyword` drivers, manual redirect re-validation | DEV-VERIFIED |
| MON-13 | `heartbeat` driver (the inverse check — silence is the signal) | DEV-VERIFIED |
| — | Controller: 6 read endpoints + unauthenticated heartbeat ingest | IN PROGRESS (untested against a live DB) |
| MON-12 | Runner: pure decisions + DB shell, allowlist from **verified** properties only | DEV-VERIFIED (decisions mutation-probed) |
| MON-12c | Runner LOOP, chained `setTimeout`, **dark by default** (`MONITORING_RUNNER_ENABLED=1`) | DEV-VERIFIED (tsc + 69 tests; not yet switched on anywhere) |

---

## ⬜ NOT DONE

### Immediate — finishes what is already built

| Ticket | What | Why it matters |
|---|---|---|

| MON-12d | Backfill `monitors.uptime24h/30d` from `monitor_results` | Board shows `—` today. Deliberate (null ≠ 0), but it is a gap. |
| MON-12b | Persist egress audit decisions | Currently a documented no-op rather than a log nobody reads. |
| — | **Deploy** | None of the Plane B backend is live. `/monitoring` renders "backend not connected" in production. |
| — | Cerbos **permission arm** (`perm_monitoring_*`) | A principal holding only a fine-grained `monitoring.*` grant is DENIED until it lands. Fail-closed. Needs 9 scope-cascade blocks in a 2,000-line security file + the parity suites. |
| — | Controller tests against a live DB | The read paths have never executed against real RLS. |

### Plane B feature work

| Ticket | What |
|---|---|
| MON-14 | Assertions API (validate against the kind's declared capabilities) |
| MON-15 | `tls` + `dns` drivers (cert expiry, DNS drift) |
| MON-16 | Maintenance-window write API (K7) |
| MON-17 | Channels + routes write API, outbound **webhook egress** (SSRF in the other direction, HMAC-signed) |
| MON-18 | Outbox event taxonomy + registration pin — the agentic/Hermes seam |
| MON-19 | Monitor write API (create/update/delete) wired to the existing editor |
| MON-20 | Incident acknowledge endpoint |
| MON-21 | Status pages: portal + public `/status/:slug` route group (the ERP's only unauthenticated surface) |
| MON-22 | MCP Hub tool registration + Hermes read path |
| MON-23 | QA: SSRF adversarial both directions, cross-tenant leak, public-page field allowlist |

### Gated / decisions for you

| Ticket | What | Blocker |
|---|---|---|
| **MON-00** | Cross-root boundary rule + a test that fails on a foreign root's row | **Architect ruling.** Gates the cross-client board before a second tenant sees it. |
| MON-09o | Disk sizing on `gda-aicenter` (~19 G of images for 2 tags on a 49 G disk) | Owner decision — cleanup is exhausted |
| MON-09n | cAdvisor per-container discovery | 5 hypotheses eliminated; narrowed to the daemon query |
| MON-09p | Durable metrics queue | Attempted + reverted; needs a resource/transform processor first |
| — | Re-ratify the no-RLS shared `search_data_cache` for unrelated SaaS tenants | Owner decision |

### The Nexus harvest — the original ask, still open

| Ticket | What | Note |
|---|---|---|
| **SM-70** | Import the **126 audit + SEO documents** → `search_audits` + RAG corpus | Biggest single value item, and **cutover-blocking**: Nexus is decommissioned at prod |
| SM-71 | Portfolio report compiler (versioned runs, MD + PDF via `report-renderer`) | |
| SM-72 | Content gate loop (draft → format → vet → revise) for `ai-drafts.ts` | |
| SM-73 | Wave/engagement model (Wave 0–3 as engagement phases) | |
| SM-74 | Hosting-topology fields on `search_properties` | Feeds MON-01 target inventory |
| — | **Wave 1 security backlog** across 63 live client sites: missing HSTS, shared WP auth salts, default `wp_` prefixes, exposed debug flags | Unremediated since June. **This is client-facing exposure and belongs in security triage, not an SEO queue.** |
