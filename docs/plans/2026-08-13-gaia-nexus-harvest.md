# Gaia Nexus harvest — monitoring + SEO comparison and adoption plan

**Date:** 2026-08-13 · **Status:** PLANNED (nothing built) · **Source repo:** `Gaia-Digital-Agency/gaia-nexus` @ default branch (shallow clone, 2026-08-13)

---

## 0. Headline

1. **Gaia Nexus contains no server monitoring system.** The "Monitor" label is a *frontend nav group*
   (`frontend/src/App.jsx:8` — Dashboard / Directory / Focus / Lighthouse), i.e. **website** health, not
   infrastructure. There is no agent, no metrics store, no alerting, no probe scheduler. The single
   infra-facing thing in the whole repo is `GET /api/health` returning `SELECT 1` against Postgres
   (`backend/server.js:24`).
2. **Its Lighthouse/PABS tab is fabricated data.** `getLighthouseData()` (`frontend/src/App.jsx:384-413`)
   derives Performance/Accessibility/Best-Practices/SEO scores and FCP/LCP/INP from a hash of the site
   name (`(seed % 20) + 75`). Same for competitor DA, backlinks, traffic share, GSC clicks/impressions,
   GTM container IDs and the "AI-driven" weekly report summary. Roughly the whole dashboard is
   deterministic mock; 22 real `/api` calls exist in a 3,689-line single-file SPA.
3. **Our SEO module is a generation ahead of theirs** on architecture and safety, and behind on nothing
   except *portfolio-scale operational content* — which is exactly what Nexus does have and we should take.
4. **Our server monitoring is already the best-in-class stack.** Nothing in Nexus, and nothing on GitHub,
   improves on it. The real gap it exposes is **external/client-site monitoring**, which we genuinely lack.

---

## 1. What Gaia Nexus actually is

| Layer | Reality |
|---|---|
| Stack | "PRVTN": Postgres 18 + React 19 + Vite 6 + Express + Nginx, pm2 on `gda-s01`, single-tenant |
| Backend | 1,595 LOC across 8 files: `server.js` (69), `create.js` (825 — Content Studio), `pdf.js`, `audit.js`, `auth.js`, `chat.js`, `init-db.js`, `sync-semrush.js` |
| Schema | 5 tables: `sites`, `chat_history`, `audit_runs`, `content_images`, `content_submissions`, `content_projects`. No tenancy, no RLS, no migrations (idempotent `CREATE TABLE IF NOT EXISTS` on boot) |
| Data pipeline | `pipeline/collect.py` is a 17-line **stub** that prints a DSN. `traffic_7d` / `roas` were never populated |
| Real data | Exactly one live integration: `sync-semrush.js` — `type=domain_ranks`, 6 columns, country-DB fallback, writes `semrush_rank/organic_keywords/organic_traffic/organic_cost` |
| AI | Gemini 2.5 Flash, read-only Q&A capped at 1,550 in / 150 out; plus Content Studio (draft → format → vet → revise → export) with banned-word + en-GB spelling scans and an SEO-check gate |
| Content | **63 technical audits + 63 SEO analyses** (`docs/audits/`, `docs/seo/`) + `docs/plan/{action_summary,todo}.md` — a 4-wave programme, Wave 0 complete |
| Auth | Single shared session table, `readOnlyGuard`. No SSO, no RBAC, no authz engine |

**The valuable part of that repo is `docs/`, not `backend/` or `frontend/`.**

---

## 2. Server monitoring

### 2.1 Three-way comparison

| Capability | Gaia Nexus | Best-in-class OSS | **Our ERP (`infra/observability/`)** |
|---|---|---|---|
| Host metrics (CPU/RAM/disk/IO) | ✗ | Netdata / Prometheus + node-exporter | ✅ node-exporter + cAdvisor |
| Container metrics | ✗ | cAdvisor | ✅ cAdvisor |
| DB / cache metrics | ✗ | postgres-exporter, redis-exporter | ✅ both, ×2 instances each (platform + bot) |
| Metrics store + query | ✗ | Prometheus / Mimir | ✅ Prometheus, 15d retention |
| Logs | ✗ | Loki / Elastic | ✅ Loki via OTel `filelog` |
| Traces | ✗ | Tempo / Jaeger | ✅ Tempo, trace↔log correlation both ways |
| Dashboards | fabricated gauges | Grafana | ✅ Grafana, provisioned from YAML |
| Alert rules | ✗ | Prometheus rules + Alertmanager | ✅ 15 rules + Alertmanager |
| Multi-transport alerting | ✗ | Alertmanager receivers | ✅ 4 transports (Telegram, SMTP, ntfy, webhook) |
| Dead-man's switch | ✗ | Watchdog → healthchecks.io | ✅ `Watchdog` + independent cron `healthcheck.sh` |
| Synthetic journeys | ✗ | Blackbox / Checkly | ✅ `synthetic-prober` — *functional* journeys (real AI completion, hub catalog), config-driven |
| Uptime probes | ✗ | **Uptime Kuma (89.6k★)** / Gatus (11.6k★) | ✅ blackbox-exporter `http_2xx` — internal targets only |
| **External client-site monitoring** | mock only | Uptime Kuma / Gatus / Unlighthouse | ❌ **none** |

### 2.2 Verdict

Our stack is the industry-standard composition (OTel → Prometheus/Loki/Tempo → Grafana + Alertmanager)
and materially **exceeds** the popular self-hosted options on traces, log↔trace correlation and
functional synthetic journeys. Uptime Kuma wins only on breadth of monitor types (31) and notification
integrations (94) and on point-and-click ergonomics — neither is a reason to add a second monitoring
system beside the one we run.

**Take nothing from Nexus here. Take nothing wholesale from Uptime Kuma either.** Instead close the one
real gap — see MON-01/02/03 in §5.

> Concretely: the ~63 managed client properties are monitored by **nobody today**. If
> `viceroybali.com` goes down, or its TLS cert expires, or its LCP triples after a WordPress update,
> the first signal is a client phone call. Nexus pretended to solve this with a hash function.

---

## 3. SEO

### 3.1 Gaia Nexus vs our `search-marketing` module

| Dimension | Gaia Nexus | Our `platform-nest/src/modules/search` |
|---|---|---|
| Tenancy | single-tenant, one portfolio | multi-tenant, FORCE-RLS, third-wall scope gate |
| Data providers | Semrush only, 1 endpoint, hardcoded | `SearchDataProvider` driver layer — DataForSEO + Semrush + Ahrefs, per-capability routing (SM-36) |
| Cost control | none | 4-gate fail-closed money path: pillar → tool-scope → ordered budget stop-loss → provider capability; `search_provider_calls` ledger; unit→USD conversion; per-provider ceiling |
| Provenance | none | `simulated` flag on ledger + cache; boot guards against minting false `simulated=false` rows |
| Rank tracking | ✗ | SM-14, append-only history, scheduler with cadence parsing |
| Crawler / audit | markdown docs written by an agent | `search-crawl-go` with a real SSRF egress guard (per-job allowlist, DNS→IP re-validation, JSONL audit sink, per-host rate cap), robots.txt RFC 9309 |
| Backlinks / GEO-AEO | ✗ (AEO is mock UI) | `backlinks.ts`, `ai-visibility.ts` — first-class pillar |
| Keyword clustering | ✗ | `clustering.ts` + pgvector plan |
| SEM / Ads | blocked, never built | `sem-drafts`, `sem-apply`, `sem-executor-google-ads`, export + live-write behind WS4 approval |
| GSC / GA4 | blocked on OAuth, never built | SM-25a/25b landed — real Keycloak PKCE verified, freshness clamped, GA4 `sampled` denormalized |
| Authz | shared session cookie | Keycloak + Cerbos, `search:scope:write` |
| Tests | none | ~112 files / 1,335 tests; adversarial + mutation-probed |
| **Reporting** | ✅ MD + PDF compiler, versioned runs, 24h rate limit | `reports.ts` exists; no PDF, no portfolio roll-up |
| **Portfolio content** | ✅ 126 real audit/SEO documents + prioritised backlog | none — we have zero real client analyses |
| **Content Studio** | ✅ 825-LOC guided create→vet→gate→export with brand-voice + en-GB enforcement | `ai-drafts.ts` only; no image path, no gate loop, no iteration ledger |

### 3.2 vs best-in-class OSS

| Repo | What it's best at | Our stance |
|---|---|---|
| `towfiqi/serpbear` | rank tracking + GSC/Ads integration | reference-only (already ruled); we have SM-14 |
| `stjude/seonaut` (Go) | technical crawl audit | adapt job-mode — still the plan for SM-08+ |
| `every-app/open-seo` | all-in-one, MCP server exposed | data-model reference; "don't-run" verdict stands |
| `harakeishi/unlighthouse` | site-wide Lighthouse sweep | **adopt as a CLI job** — this is the honest version of Nexus's fake PABS tab |
| SEO Panel | keyword tracking + automated audits | dated PHP; skip |
| RustySEO | deep audits + log-file analysis | watch; log-file SEO analysis is a genuine future pillar |

Nothing in that list changes the architecture verdict from the 2026-07-23 design. The one addition is
**Unlighthouse**, which now has a clear home (MON-02).

---

## 4. What is actually worth taking from Gaia Nexus

Ranked by value-to-effort. Everything else in that repo is either mock, or something we do better.

| # | Take | Why | Effort |
|---|---|---|---|
| H1 | **The 126 audit + SEO documents** (`docs/audits/`, `docs/seo/`) and `docs/plan/todo.md` | Real analyst output for 63 live properties. Becomes seed data for `search_audits`/`search_audit_findings` and RAG corpus for the knowledge store. We have *nothing* real today. | M |
| H2 | **Versioned audit-run + report compiler** (`audit.js` + `pdf.js`) — run → version → MD + PDF, rate-limited, only-latest-downloadable | Our `reports.ts` has no portfolio roll-up and no PDF. The 24h cooldown against a ~2h pass is a sound cost/abuse control that mirrors our budget-gate thinking. | S |
| H3 | **Content Studio gate loop** (`create.js`): draft → format → AI comments → revise → **vet** → export, with `scanBanned` / `scanUsSpellings` / `computeSeoChecks` and an iteration ledger (`iteration`, `iterations jsonb`, `fix_count`, `gate_count`) | This is a genuinely good pattern and better than our `ai-drafts.ts`. The append-only iteration timeline is exactly our provenance style. Route the LLM via `ai-gateway-go`, not Gemini direct. | M |
| H4 | **The 4-wave programme model** (Wave 0 diagnose → 1 technical → 2 SEO → 3 GBP/Ads) + the earners-vs-portfolio split (63 audited, ~7 carry the traffic) | Gives the SEO department a delivery shape and a defensible way to concentrate effort. Maps onto engagement scope config (D-4). | S |
| H5 | **Per-site hosting-topology mapping** (gda-ce01 / hostinger-wp / gda-pn01) | Directly feeds MON-01's target inventory and the IT/device contract. | S |
| — | Semrush sync, Gemini chat, PRVTN stack, auth, the SPA, Lighthouse tab | Superseded, mock, or actively worse than what we run. **Do not port.** | — |

**Do not import the code.** Import the *documents*, the *report-compiler shape*, and the *content gate
state machine*. The Nexus backend has no tenancy, no migrations, no authz and no tests; porting it would
be a regression against every rule in `CLAUDE.md`.

---

## 5. Implementation plan

Two independent tracks. Neither blocks the other. All tickets PLANNED.

### Track A — external monitoring (new; closes a real gap)

| Ticket | Scope | Tier | Notes |
|---|---|---|---|
| **MON-01** | Extend `blackbox-exporter` to **external client properties**: a generated `targets.yml` from `search_properties` (verified rows only), `http_2xx` + `ssl_expiry` probes, `probe_ssl_earliest_cert_expiry` alert at 21/7 days, `probe_success` alert at 3m | devops | Reuses the stack we already run — **no second monitoring system**. Target list is *generated*, so it can't drift from the property registry. |
| **MON-02** | **Unlighthouse** as a scheduled job container → writes real PABS + CWV into a new `search_lighthouse_runs` table (tenant-scoped, RLS) | medior | The honest replacement for Nexus's fabricated gauges. Job-mode, same shape as `search-crawl-go`. Egress guard applies. |
| **MON-03** | Domain + TLS **expiry registry** — WHOIS/registrar expiry per property, alert at 60/30/7 days | junior | Nexus tracked this in prose only. Cheap, high-consequence. |
| **MON-04** | Grafana dashboard **"Client Properties"** — uptime, cert days-remaining, LCP/INP trend, per-property drill-down; provisioned YAML | junior | Depends on MON-01+02. |

**Guardrail:** MON-01/02 probe third-party hosts. The `search-crawl-go` egress rules (allowlist resolved
from verified `search_properties`, private-IP denial, audit sink) are **mandatory** here too — a
monitoring probe is an SSRF primitive if the target list is attacker-influenced.

### Track B — SEO harvest (extends the existing module)

| Ticket | Scope | Tier | Notes |
|---|---|---|---|
| **SM-70** | **Import the 126 Nexus documents**: parser → `search_audits` + `search_audit_findings` rows, stamped `source='nexus-import'`, `simulated=false` (real analyst output, real provenance), plus RAG ingest into the D9 knowledge store | medior | Biggest single value item. Needs a tenant/company mapping decision — see §6. |
| **SM-71** | **Portfolio report compiler**: versioned `search_report_runs` (technical / SEO / plan), cooldown gate, MD + PDF via `report-renderer`, only-latest downloadable | medior | Port the *shape* of `audit.js`/`pdf.js`; use our existing `report-renderer`, not `pdfkit`. |
| **SM-72** | **Content gate loop** for `ai-drafts.ts`: draft → format → comments → revise → vet, with banned-word + en-GB scans, SEO checks, and an append-only `iterations jsonb` ledger. LLM via `ai-gateway-go`; bulk via local Hermes ($0) | medior | Sits behind the existing WS4 approval flow. **No paid pull** may be triggered by the loop (§A13 ruling). |
| **SM-73** | **Wave/engagement model**: encode Wave 0–3 as engagement phases on the client scope config, with the earners-vs-portfolio split driving cadence + budget tiers | senior-be | Makes H4 operational rather than a doc. |
| **SM-74** | **Property hosting topology** field set on `search_properties` (host, control panel, stack, plugin surface) — seeded from the Nexus directory | junior | Feeds MON-01 and the IT module. |

### Sequence

```
MON-01 ─┬─ MON-03 ─┐
        └─ MON-02 ─┴─ MON-04          (Track A, independent)

SM-74 ── SM-70 ── SM-71
              └── SM-73               (Track B)
SM-72                                 (independent)
```

Suggested first cut: **MON-01 + SM-74 + SM-70** — they turn 63 real properties from a markdown folder
into monitored, queryable, tenant-scoped platform data.

---

## 6. Decisions — RESOLVED by owner 2026-08-13

1. **Nexus is decommissioned at ERP prod cutover.** No dual-run, no read-only freeze period. The ERP must
   therefore be **best-in-kind on the day it replaces Nexus**, not "better architected but thinner".
   Consequence: SM-70/71 and MON-01/02 are **cutover-blocking**, not nice-to-have.
2. **Tenancy: GDA is a tenant, not *the* tenant.** The ERP is multi-tenant for the holding's other
   businesses and is planned for SaaS. See §10 for the shape ruling this forces.
3. **`gda-s01` is fully retired as of 2026-08-13.** Question 3 is void. See §11 — this has a data
   consequence that needs checking today.
4. **Wave 1 is not a backlog to burn down — it is the class of problem the ERP must end permanently.**
   Recast as a continuous property-compliance baseline. See §12.

---

## 8. Where the monitoring actually lives today — nowhere

The honest answer to "I see no such UI in the ERP": **there is none, and the stack is not running.**

- `docker-compose.observability.yml` is a **separate, opt-in compose file** (18 services). The live
  deploy is `docker-compose.vps.yml` + `docker-compose.hostdata.yml` — **16 containers, none of which
  are prometheus / grafana / loki / tempo / alertmanager / any exporter.**
- Even when brought up, everything binds to **localhost only** and is reached over an SSH tunnel
  (`ssh -L 3001:localhost:3001 …`). Grafana at `:3001`, Prometheus at `:9090`. That was a deliberate
  choice, and it is why no ERP page exists.
- So the §2.1 table describes **capability that is built and lint-validated, not capability that is
  observing production.** Production `erp.gaiada.online` currently has: `GET /health`, the cron
  `healthcheck.sh`, and nothing else.

That is a defensible state for a trial. It is **not** a defensible state for a prod cutover that
retires the system the business was using, nor for a SaaS.

### 8.1 The ruling this forces: two planes, never one

Nexus conflated them and that is precisely why its "Monitor" tab was a hash function. Uptime Kuma is
only ever the second plane. Keep them separate:

| | **Plane A — Platform observability** | **Plane B — Property monitoring** |
|---|---|---|
| Subject | our own containers, DB, queues, gateway | the tenant's / client's websites |
| Audience | us (SRE/staff) | tenants, account managers, and clients |
| Surface | Grafana, SSH-tunnelled, staff-only | **an ERP module surface**, tenant-scoped, Cerbos-gated |
| Tenancy | none needed — it is one estate | RLS-scoped per company, per client |
| Sellable | never | **yes — this is product** |
| Tech | Prometheus/Loki/Tempo/Grafana (built) | new module, fed by blackbox + job workers |

**Plane A must be deployed** (it exists; it is just switched off). **Plane B must be built** — it has
no code today, and it is the thing the ERP is missing that Nexus at least gestured at.

---

## 9. Uptime Kuma — where it genuinely beats us, and what we do

I said it "wins on breadth and ergonomics". Unpacking that properly, because three of the seven items
are product features we would have to ship anyway.

| # | What Kuma has | Why it matters here | Our answer |
|---|---|---|---|
| K1 | **Push / heartbeat monitors** — a job pings a URL; no ping in N minutes ⇒ alert | We run n8n flows, cron sweeps, the pull-scheduler, the Semrush/GSC collectors. Today **a silently dead scheduled job is invisible.** Memory already records this failure mode twice (`N8N_BRIDGE_ENTITY_TYPES` darkened every event flow; mcp-hub served zero tools for days). This is our single biggest monitoring hole. | **MON-05.** Build it — Prometheus `pushgateway` + a `job_last_success_timestamp` rule. Small, and it closes a proven-recurring class of outage. |
| K2 | **Body-content assertions** — keyword present/absent, JSON-path match, not just HTTP 200 | A hacked WordPress serves 200 with pharma spam. A blank-white-screen PHP fatal serves 200. `http_2xx` sees both as healthy. For an agency this is the *actual* failure mode. | **MON-06.** blackbox `http_2xx` already supports `fail_if_body_matches_regexp` / `fail_if_body_not_matches_regexp` — config, not code. Per-property expected-string + spam-signature deny list. |
| K3 | **~31 monitor types** (DNS record, TCP port, gRPC, MQTT, SNMP, DB conn, Docker) | Mostly irrelevant to us — we are not monitoring MQTT or Steam servers. The two that matter are **DNS record drift** (a client repoints their nameservers and we find out weeks later) and TCP. | Adopt DNS only → folded into **MON-03**. Ignore the rest; breadth for its own sake is not value. |
| K4 | **94 notification integrations** vs our 4 | Genuinely more, but we already have Telegram + SMTP + ntfy + generic webhook, and the generic webhook reaches anything. Not a real gap. | No action. |
| K5 | **Non-engineer CRUD** — an account manager adds a client site in the UI, no deploy | This is the real ergonomic gap. Our blackbox targets live in a YAML file in git. | Solved by design in **MON-01**: targets are **generated from `search_properties`**, so adding a property in the ERP *is* adding a monitor. Better than Kuma — it cannot drift from the registry. |
| K6 | **Per-client public status pages** | An agency deliverable we could bill for. Kuma ships it; we have nothing. | **MON-07.** Real product feature. Needs the client-portal shell (already deployed) + a per-client public read surface. |
| K7 | **Maintenance windows** — suppress alerts during planned work | We deploy client WordPress updates. Without this, every maintenance window pages someone and alerting gets muted permanently — the classic path to an ignored alerting system. | **MON-08.** Alertmanager silences exist; needs an ERP-side UI + API so a non-SRE can schedule one, with an audit trail. |

**We do not run Uptime Kuma.** It is single-estate with no tenancy, no RLS, no Cerbos, no audit trail and
no company scoping — dropping it into a SaaS would either leak every tenant's monitors to every tenant, or
require one Kuma instance per client. The correct read is: **Kuma is the feature spec for Plane B, not the
implementation.** K1, K2, K6 and K7 are the four worth building; K3/K4 are noise; K5 we beat by generating
from the registry.

### 9.1 Added tickets

| Ticket | Scope | Tier |
|---|---|---|
| **MON-05** | Heartbeat/dead-job monitoring — pushgateway + `job_last_success_timestamp` + alert rule; wire the pull-scheduler, n8n flows, collectors, and the nightly sweeps | devops |
| **MON-06** | Content assertions on property probes — per-property expected string, plus a shared defacement/spam-signature deny list | medior |
| **MON-07** | Per-client **public status page** in the client portal — uptime history, incident notes, no auth | senior-fe |
| **MON-08** | Maintenance windows — ERP UI/API over Alertmanager silences, Cerbos-gated, audit-logged | medior |
| **MON-09** | **Deploy Plane A to production** — bring `docker-compose.observability.yml` up on gda-aicenter, verify all 15 rules fire, wire the dead-man's switch | devops |

**MON-09 is the highest-priority monitoring ticket on this page.** Everything else in Track A assumes a
running Prometheus/Alertmanager. Today there isn't one.

---

## 10. SaaS tenancy — is the direction right?

Direction is right; there is **one shape decision** that must be made before SM-70, because it is
expensive to unpick after 63 properties are imported.

GDA's 63 sites are the agency's own portfolio. In the SaaS model the buyer is *another agency* with
*their* clients' sites. So the relationship is two levels deep, not one:

```
company (tenant)  →  client  →  property  →  {audits, ranks, monitors, engagements}
   "GDA"            "Viceroy"   viceroybali.com
```

**Do not import the 63 as bare properties hanging off the GDA company.** Even where GDA owns the site,
give it a `client` row (GDA-as-its-own-client, flagged `internal`). Reasons:

1. It is the shape every other tenant will need. A one-level import teaches the codebase the wrong model,
   and the first real SaaS customer forces a migration of the largest table set we have.
2. Billing, engagement scope, cost metering and the SEO tool-scope config are all **per-client**, not
   per-tenant — that is already how the money path is designed (D-4, tool-scope). A property with no
   client has nowhere to hang its scope.
3. The client portal, Cerbos policies, and `isClientOnly` all already assume a client entity.

Two things to verify against the existing `clients` module before SM-70 (do not assume):
- does `search_properties` already carry a client FK, or only a company FK?
- can a client be flagged `internal` without appearing in billing?

**Second SaaS check — the shared market-data cache.** `search_data_cache` is deliberately no-RLS shared
market data, and that is what makes the ~$8–10/client cost model work. That ruling was made when all
tenants were us. **It must be re-ratified for SaaS**: tenant A's paid SERP pull warming a cache that
tenant B reads for free is correct inside one holding and is a *cross-customer data and billing question*
between unrelated paying companies. It is not a leak of private data (SERPs are public), but it is a
value transfer, and a competitor pair on the same instance may object. Flagging now; not urgent, but it
must not be discovered during a sales conversation.

---

## 11. ⚠️ gda-s01 retired today — check this before anything else

The box is gone. What survives in git and what does not:

| Asset | Survives? |
|---|---|
| 126 audit + SEO markdown docs (`docs/audits/`, `docs/seo/`) | ✅ in git — the main asset is safe |
| `docs/plan/{action_summary,todo}.md` | ✅ in git |
| `docs/data/sites_backup_20260611.sql` | ✅ in git — but see below |
| **Live `sites` table with the Semrush pull** (`semrush_rank`, `organic_keywords`, `organic_traffic`, `organic_cost`, `semrush_db`, `semrush_synced_at` for 54 sites) | ❌ **only ever existed on gda-s01's Postgres** |
| `chat_history`, `audit_runs`, `content_projects` / `content_submissions` / `content_images` + generated media | ❌ same |
| `backend/.env`, `docs/key.txt`, `docs/keys/` (chmod 600, never committed) | ❌ same |

The committed backup is **dated 2026-06-11, contains 20 rows, and has zero `semrush_*` columns** — it
predates the sync entirely. Worse, its `traffic_7d` / `ad_spend` / `roas` values are **invented seed
data**: the README states plainly that those columns were never populated, yet the dump carries
`traffic_7d=14500, roas=4.80` for Viceroy. **Do not import that file as real metrics.**

**Action today:** confirm whether a `pg_dump` of `gaia_nexus` was taken before the box was wiped, and
whether `docs/keys/` was copied off. If not: the Semrush pull is re-runnable (we hold a Semrush
subscription) and is a small loss; the **Content Studio output and generated media are not recoverable**,
and any credential that lived only in `key.txt` is now unrecoverable and must be reissued rather than
rotated. This is a question, not a claim — I cannot see the box.

---

## 12. Wave 1 recast — "fix it forever" as a continuous baseline

Owner intent: these are not 63 tickets to burn down, they are the *class* of defect the ERP exists to
eliminate. That converts a backlog into a **property compliance baseline** — a policy set, evaluated
continuously, producing findings with severity, owner and remediation, and tracking drift over time.

The Wave 1 findings map cleanly onto checks:

| Nexus finding | Continuous check | Signal |
|---|---|---|
| HSTS missing portfolio-wide | response header assertion | header absent / `max-age` too low |
| Shared WordPress auth keys/salts across installs | provisioning invariant + attestation at handover | reused salt fingerprint across properties |
| Default `wp_` table prefix | recorded at provisioning; audited on change | prefix == `wp_` |
| `WP_DEBUG` / debug flags exposed | body + header assertion (MON-06) | debug output reachable |
| Dual/duplicated plugin cleanup | plugin inventory diff | two plugins in the same role |
| WordPress + PHP version currency | version inventory vs EOL feed | unsupported or N-2 |
| TLS + domain expiry | MON-01 / MON-03 | days remaining |

Design notes that matter:

- **Owner is WebDev, consumer is SEO.** WebDev owns the sites and the provisioning path; SEO consumes
  the findings as audit input. Do not build this inside `modules/search` — it belongs with `webdev`,
  with `search_audit_findings` reading across. Getting this wrong welds site operations into a
  department module that a SaaS buyer may not even license.
- **Prevention beats detection.** The `wp_` prefix and shared-salt findings should be *impossible* to
  create through our own provisioning path (`provisioning.service.ts`), not merely detected afterwards.
  Detection is for sites we inherit; prevention is for sites we build. Ship both.
- **A finding must be able to become a ticket** — findings that only render on a dashboard get ignored,
  which is exactly how they sat in a markdown file from June to August.
- **Severity is not SEO severity.** Exposed debug flags and shared auth salts are security findings.
  Route them to security triage with their own SLA, per §6.4.

**New ticket: WD-xx "Property compliance baseline"** — senior-be + architect. Policy set as data
(so a new check is config, not a release), evaluation via the MON-01/02/06 probe results plus the
provisioning inventory, findings → severity → owner → ticket. Sequence it **after MON-01/06** (which
supply the signal) and **before the Nexus cutover** (it is the thing that makes Wave 1 permanent).

---

## 13. Provenance of this document

Every claim above is from a shallow clone of `gaia-nexus` read on 2026-08-13 (181 files) and from the
working tree of `gaiada-system`. Line references are to the clone's default branch as of that date.
Nothing here has been executed, deployed, or verified against a running Nexus instance.
