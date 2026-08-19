# Monitoring program — Plane A operations + Plane B property monitoring

**Date:** 2026-08-13 · **Status:** Plane A **DEV-VERIFIED** · Plane B **UI PROTOTYPED, backend PLANNED** · **Owner decisions:** ratified 2026-08-13
**Companion:** [`docs/plans/2026-08-13-gaia-nexus-harvest.md`](../plans/2026-08-13-gaia-nexus-harvest.md) (why this exists)

---

## 0. What this program is

The ERP replaces Gaia Nexus at prod cutover. Nexus's monitoring was a hash function; ours is
partly-running-and-watching-nothing. This program closes both halves:

- **Plane A — platform observability.** ✅ **DEPLOYED 2026-08-13** — consolidated into one compose
  project, 14/14 targets up, 19 alert rules, Watchdog firing. See §2 (and §2.0 for a claim in the
  first draft of this document that turned out to be wrong).
- **Plane B — property monitoring.** UI **PROTOTYPED 2026-08-13** (`/monitoring` + `/monitoring/[id]`,
  driven in a browser under `DEMO_MODE`); **backend not started**. Build it natively, at Uptime Kuma
  parity or better, as a tenant-scoped ERP module. See §3–§5.

Non-negotiable framing: **A and B never merge.** A watches our containers and is staff-only and not
sellable. B watches customers' websites and services, is RLS-scoped, Cerbos-gated, and *is* product.
Nexus conflated them; that is the root cause of its fake gauges.

---

## 1. Tenancy — DnA Holding

**Owner ruling 2026-08-13:** the root company is **DnA Holding**; every operating business (GDA and
siblings) is a company beneath it; the platform is being adapted for use by unrelated businesses (SaaS).

### 1.1 Verified — the schema already supports this

Both of my open questions from the harvest doc resolve **in our favour**. Verified in the migrations,
not assumed:

- `companies.parent_company_id uuid REFERENCES companies(id)` — [`0001_core.sql:12`](../../platform-nest/migrations/0001_core.sql). Company hierarchy is **native**. DnA Holding is simply the row with `parent_company_id IS NULL`.
- `search_properties` already carries **both** `tenant_id → companies(id)` **and** `client_id → clients(id) NOT NULL`, unique on `(tenant_id, client_id, domain)` — [`0034_module_search.sql:44-62`](../../platform-nest/migrations/0034_module_search.sql). The two-level `company → client → property` model I flagged as a risk **is already enforced**. No migration needed, no import-shape decision outstanding.

So the direction is right and the foundation is laid. Migration head is **0107** committed, but **0108 is already taken** by an in-flight session (`0108_iam_gap_02_invoice_self_approval_deny_and_revisions.sql`, uncommitted at the time of writing). MON schema starts at **0109 or later** — re-check `ls platform-nest/migrations` immediately before writing it, because this checkout is shared and the next free number moves.

### 1.2 The three-level reality, and where the sharp edge is

```
DnA Holding                    ← companies, parent_company_id IS NULL
  └── Gaia Digital Agency      ← companies, parent = DnA
        └── Viceroy Bali       ← clients (of GDA)
              └── viceroybali.com   ← search_properties / monitors
```

For SaaS, `DnA Holding` is one root among many. That is fine — *provided nothing is allowed to read
across a root.* The sharp edge is **hierarchy-aware rollups**: `rollups.view` and the Company report
already aggregate upward. The moment DnA Holding can roll up its children, the mechanism to roll up
across a root exists, and the only thing keeping tenant Acme's data out of DnA's rollup is a correct
scope predicate. That is exactly the class of bug [[role-bundles-overstate-reach]] and the RLS
zero-row trap are about.

**MON-00 (architect, gating):** ratify the boundary rule — *hierarchy traversal may never cross a
root company* — and pin it with a cross-root test that fails if a rollup ever returns a foreign root's
row. Do this **before** Plane B ships, because monitoring adds the first genuinely cross-client
aggregate surface ("all properties, all clients, one status board").

### 1.3 Second SaaS item, carried forward unresolved

The no-RLS shared `search_data_cache` (§10 of the harvest doc) still needs re-ratification for
unrelated paying tenants. Not blocking this program; do not let it surface first in a sales call.

---

## 2. Plane A — DEPLOYED 2026-08-13 (was: "deploy what we already built")

### 2.0 What was actually true, versus what §0 first claimed

The original draft of this document said Plane A was "not running in production". **That was wrong.**
It was inferred from the `com.docker.compose.project.config_files` label of a *single* container. In
fact Prometheus, Loki, Alertmanager and the OTel collector had been running for 6–8 days as **three
separate compose projects** — `gaiada-otel-metrics`, `gaiada-loki`, `gaiada-alertmanager` — a
deliberate design (see the header of `docker-compose.alertmanager-mail.yml`) from when the full WS9
stack was still opt-in.

What was genuinely missing was **everything that produces data**: no node-exporter, no cAdvisor, no
postgres/redis exporters, no blackbox-exporter, no Grafana, no Tempo, no ntfy, no synthetic-prober.
**12 of 14 Prometheus targets were DOWN.** Prometheus was scraping almost nothing and nobody knew,
which is its own lesson: *a monitoring stack that is up is not the same as a monitoring stack that
is watching something.*

### 2.1 Delivered state (verified)

| | Before | After |
|---|---|---|
| Prometheus targets | 2/14 up | **14/14 up** |
| Alert rules | 14 (no disk rule at all) | **19** (+`DiskSpaceLow`, `DiskWillFillIn24h`, +SLO group) |
| Compose projects owning observability | 3 standalone + partial `gaiada` | **1 — `gaiada`** |
| Grafana / Tempo / ntfy / exporters / cAdvisor / blackbox / synthetic-prober | absent | running |
| Containers | 22 | **33** |
| Disk | 28 G used (60 %) | **31 G used (65 %)** |
| Alertmanager receivers | 3 (separate project) | **3, preserved** (`default-multi`, `page-all`, `deadmansswitch`) |
| Alertmanager transports | email + telegram + webhook | **preserved**, Watchdog firing |
| Prometheus history | 45 MB in a standalone volume | **migrated**, 5-day-old samples verified present |

Consolidation moved the transport secrets from `.env.alertmanager-mail` into `infra/compose/.env`
(the two files use the same `&am_env` shape and the same `alertmanager.yml` template, so parity is
exact), then migrated `prometheus-data` (45 MB), `loki-data` (33 MB) and `alertmanager-data` across
to the `gaiada_*` volumes before starting the consolidated services — so no metrics or log history
was lost in the swap.

### 2.2 Disk: the estimate was wrong in the safe direction

The pre-deploy estimate was 8–15 G. The real cost of the full stack was **~3 G** (images ~2 G plus
initial data). The box sits at 65 % with 17 G free.

**But `docker system df` reported ~0 reclaimable**, so the "prune first" mitigation this document
originally leaned on **does not exist on this box** — every image is in use. That is precisely why
the two new disk rules matter: they are now the *only* warning before the disk fills, and a full
disk has already rolled back a healthy release once ([[deploy-disk-fills-and-rolls-back]]).

### 2.3 Three traps hit during the deploy — all now closed

1. **`COMPOSE_PROFILES` must not include `jobs`.** `search-crawl` is a job-mode worker
   (`profiles: ["jobs"]`, `restart: "no"`, "never starts with a plain `up -d`"). Including it makes
   compose try to pull an image that was never published, and the pull failure **aborts the whole
   `up`** — after compose has already stopped services for recreate. That is how `ai-gateway` and
   `bot-media-worker` ended up down for ~1 minute. The repo variable is correct
   (`bot,auth,whisper,mail-dev,scan`); the error was adding `jobs` by hand from a runbook example.
2. **`synthetic-prober` is build-only** (`build:` with no `image:`), and the pipeline runs
   `up -d --no-build`. With no pre-built image the deploy dies at the last service. Fixed by
   building `gaiada-synthetic-prober:latest` on the box. ⚠ **This is durable-fragile** — see MON-09f.
3. **Alertmanager lost its published port.** `observability.yml`'s alertmanager had **no `ports:`
   block** while `alertmanager-mail.yml` published `127.0.0.1:9093`. Consolidating therefore removed
   the operator's only route to the Alertmanager UI — silently, because alerting kept working over
   the compose network. **Silencing an alert is done through that UI, and an alerting system you
   cannot silence gets muted at the source instead.** Fixed in `observability.yml`.

### 2.4 Remaining Plane A tickets

| Ticket | Scope | Tier |
|---|---|---|
| **MON-09e** | ✅ **DEV-VERIFIED.** `infra/scripts/rollback-to.sh` replaces the bare `up -d` in `deploy.yml`'s rollback: it starts what existed at `<prev>` and **removes** what did not. Carries a safety gate — see §2.6. | devops |
| **MON-09f** | ✅ **DEV-VERIFIED.** Added to `release.yml`'s matrix (with a `context:` override — it is the only component not at `./<component>`), and the compose service now declares `image:` alongside `build:` so `--no-build` has something to start. | devops |
| **MON-09g** | ✅ **CLOSED.** Committed (`966a17a`), shipped in `alpha-01.042.0095a`, and verified present on the box **from the tag** rather than by hand. Zero drift. ⚠ The predicted revert happened first — §2.5. | devops |
| **MON-09h** | Retire `docker-compose.alertmanager-mail.yml`, `otel-metrics.yml`, `loki.yml`, `obs-local.yml` or mark them dev-only — they now describe projects that no longer exist and would re-create port collisions on 9090/9093 if anyone ran them. | devops |

### 2.7 Making the server visible, and the three blind collectors (2026-08-18)

The question "how does the live system show the monitored server?" had an uncomfortable answer: it
did not. All four provisioned Grafana dashboards are application-level; grepping every one of them
for `node_*`, `container_*`, `pg_*`, `redis_*` returned **zero matches**. Server metrics had been
collected for weeks and rendered nowhere, readable only by SSH-tunnelling to Prometheus and writing
PromQL by hand.

That was not merely a missing view. It is *why* the following survived unnoticed.

**Three collectors were UP and collecting nothing.** Each had a green scrape target:

| Collector | Looked | Actually |
|---|---|---|
| `postgres-exporter` | target up | `pg_up=0` — DSN used `POSTGRES_SUPER_PASSWORD` against database `gaiada`; on this box the host serves `gaiada_platform` via per-service roles. Authenticated as nobody against nothing. |
| `redis-exporter` | target up | `redis_up=0` — addressed `redis://redis:6379`, a container deliberately never started here. |
| `postgres-exporter-bot` | target up | Monitored database `gaiada` on pg-bot while the bot uses `gaiada_bot`. It connected, so it produced confident numbers about a database nothing uses. Also broken on PG17 (`checkpoints_timed` moved to `pg_stat_checkpointer`). |
| `cadvisor` | target up | Only host cgroup series, no `name` label ⇒ **no per-container metrics at all** (MON-09n, still open). |

And **no alert rule read `pg_up` or `redis_up`**, so the fault was invisible from both directions.

**The binding rule, stated once:** *a green scrape target means the exporter answered. It says
nothing about whether the thing being measured is reachable.* Target-count health — including the
"14/14 up" recorded earlier in this document — is not evidence that the checks mean anything.

Delivered: exporters repointed at the credentials the platform itself uses (one source of truth for
"where is the database"), `PostgresDown`/`RedisDown` alerts, a **Host & Infrastructure** Grafana
dashboard (9 panels, every query verified against live Prometheus before shipping), and
**Systems → Observability** in the ERP — admin-gated, read-only, deliberately a summary.

**Disk, measured rather than assumed.** The plan said trim Prometheus retention. Measurement said
otherwise: `prometheus-data` 400 MB, `loki-data` 29 MB, **`tempo-data` 4.0 GB**. Traces — the least
consulted signal — dominated by 10×. Tempo retention cut 168h → 72h; Prometheus left alone, since
trimming it would have freed almost nothing and lost the series the alerts run on. Dangling images
and build cache reclaimed 1.1 GB. Only two release tags exist on the box and **both must stay** (the
older one is the rollback target), so image pruning is exhausted.

⚠ **The box is structurally undersized for this stack**: ~19 GB of images for two release tags on a
49 GB disk, at 82% used. That is a sizing decision, not a cleanup task (MON-09o).

### 2.8 Open after this pass

| Ticket | Scope |
|---|---|
| **MON-09n** | cAdvisor: **errors eliminated, discovery still absent.** `cgroup: host` was the real missing piece — on cgroup v2 Docker gives each container a PRIVATE cgroup namespace, so cadvisor could not see `/system.slice/docker-<id>.scope` at all and logged `Failed to create existing container` per container. That noise is now gone and host-cgroup coverage is intact (50 series), but no series carries a `name` label, so per-container CPU/memory still does not exist. The Docker factory registers and `docker.sock` is readable, so the remaining suspect is the daemon query itself. ⚠ `--docker_only=true` was tried and **reverted**: it cut cadvisor from 49 series to 1, trading a partial signal for none — an optimisation that reduces coverage while the underlying fault is unfixed is a regression. The dashboard continues to state the gap rather than show empty graphs. |
| **MON-09m** | Dedicated read-only `pg_monitor` role. The exporter now uses `platform_app`, which is intentionally `NOBYPASSRLS`, so some collectors return nothing. Granting `pg_monitor` needs rights not held in this session. |
| **MON-09o** | Disk sizing: 49 GB carrying ~19 GB of images for two tags. Grow the volume or reduce what a release retains. |

### 2.6 The rollback safety gate, and how it was found (see also §2.5 below)

`rollback-to.sh` classifies each service by whether its image exists at the target tag: present =>
bring it up, absent-and-ours => it is new in the failed release, so remove it. That logic is correct
and was verified against the live compose config.

It is also, on its own, capable of destroying the estate. **Testing it with a deliberately bogus tag
classified all nine of our services as "new"** — because none of our images exist at a tag that was
never built — and the next thing it would have done is delete every application container. The run
survived only because the output was piped through `head`, and SIGPIPE killed the script before the
removal step. Luck, not design.

The missing insight: **"this service is new" and "this tag is wrong" are indistinguishable from a
single missing image.** Only the *proportion* separates them — a real release adds one or two
services; a wrong tag is missing all of them. So the script now refuses when none of our images
exist at the target, and refuses when more of ours are missing than present, and it has a
`--dry-run` that prints the plan without acting. Verified both ways: bogus tag => refuses, exit 1,
nothing changed; real tag => plans 32 services up, 0 removed.

The general lesson is not about rollback. It is that **a recovery tool needs a bad-input gate more
than a normal tool does**, because it runs only when something has already gone wrong, and it runs
unattended.

### 2.5 The MON-09g revert happened, and is worth keeping

While this work was in progress another session tagged and deployed `alpha-01.040.0093c`. That
deploy rsynced `infra/` from the tag — which predated the two fixes — and **silently reverted both
on the box**:

- `alerts.yml` lost `DiskSpaceLow` + `DiskWillFillIn24h`. Prometheus kept serving them *from memory*
  because it had not reloaded, so `/api/v1/rules` still listed them. **The rules would have vanished
  at the next restart, with nothing to indicate they had ever been there.** A file check and a
  runtime check disagreed, and only the file was telling the truth about the future.
- `docker-compose.observability.yml` lost the alertmanager `ports:` block, so `:9093` went
  unreachable again — the same silent loss of the silencing UI described in §2.3.

Both were re-applied by hand and verified (`alertmanager=200`, both rules loaded, file on box
contains them). They are committed, so the next release carries them permanently.

**The general rule this proves:** on this estate, *a hand-applied infra change has a maximum lifetime
of one deploy by anyone else*, and the shared checkout means "anyone else" is routine. Hand-apply to
restore service; commit in the same session or accept that it will be undone without warning.

**`COMPOSE_FILES` repo variable updated** to include `docker-compose.observability.yml`, so the
pipeline keeps OTEL enabled and treats the observability services as owned rather than as orphans.
Verified: `docker compose config -q` parses clean, and the box `.env` is still bash-sourceable (the
deploy's backup gate sources it, and a value with an unquoted space fails that gate).

## 3. Plane B — the native monitoring module

New module `monitoring` in `platform-nest`. Not inside `search` (that welds site ops to a department a
SaaS buyer may not license) and not inside `webdev` (monitoring outlives the build engagement).
`webdev` and `search` both **consume** it.

### 3.1 Architectural ruling: two stores, one meaning

| | Postgres (`monitor_results`, RLS) | Prometheus |
|---|---|---|
| Role | **the record** — tenant-facing history, UI, SLA reports, audit | the **alerting index** — rule evaluation, staff dashboards |
| Retention | long (per-plan) | short (7–15 d) |
| Who reads | tenants, clients, account managers, agents | us, Alertmanager |

The runner writes results to Postgres **and** exposes `/metrics`. Prometheus scrapes it. Rules evaluate
there. **Postgres is never derived from Prometheus** — no double source of truth for anything a customer
sees or is billed against.

**Tenant-facing notifications do NOT go through Alertmanager.** They ride our outbox (§4). Alertmanager
stays Plane A, staff-only. Mixing them would put customer alerting behind an SRE-only config file.

### 3.2 Monitor-type driver registry — the extensibility answer

MQTT and Steam are named as future wants, and DNS matters now. So the type list must be **data plus a
driver**, never a hardcoded switch. Reuse the pattern that is already proven twice in this codebase
(`SearchDataProvider`, and `provision-provider.ts`):

```ts
interface MonitorDriver {
  kind: MonitorKind;                       // 'http' | 'tcp' | 'dns' | 'tls' | 'heartbeat' | 'mqtt' | ...
  capabilities: MonitorCapability[];       // what assertions this kind supports
  validate(config: unknown): MonitorConfig;      // parse-don't-validate, throws on unknown shape
  probe(cfg: MonitorConfig, ctx: ProbeCtx): Promise<ProbeResult>;
}
```

Rules carried over from the search-provider lessons, because they were each learned the hard way:

- **A driver with no registered implementation is ABSENT, not silently inert.** (`unset unit rate ⇒ driver not registered` — the $0-rate lesson. A monitor whose driver is missing must refuse loudly, never report "up".)
- **No default branch in `parseKind()`.** Return `MonitorKind | null` and make callers handle null explicitly — the SM-61 cadence pattern, which caught two callers silently inventing different defaults.
- **Registration pin.** A correct-but-unwired driver is indistinguishable from an absent one — that pattern has now bitten six times. Ship a test that asserts the registry's contents by name.

**v1 kinds:** `http`, `tcp`, `dns`, `tls`, `heartbeat`, `keyword` (http + body assertion).
**v2 (drop-in, no core change):** `mqtt`, `grpc`, `snmp`, `steam`, `docker`, `database`.

### 3.3 Kuma parity — the seven items, natively

| Kuma | Our build | Notes |
|---|---|---|
| K1 heartbeat / push | `heartbeat` driver + `POST /api/:t/monitoring/heartbeat/:token` | **Highest value.** Closes the proven-recurring silent-dead-job class (n8n flows darkened; mcp-hub served zero tools for days). Wire the pull-scheduler, n8n flows, collectors, nightly sweeps. |
| K2 body assertions | `keyword` driver: expected-string, absent-string, JSON-path, shared defacement/pharma-spam signature list | The real agency failure mode — hacked WP serves 200. |
| K3 monitor breadth | driver registry §3.2 | MQTT/Steam become config + one file, never a core change. |
| K4 notifications (94) | §4 — outbox → channel drivers | We need **fewer channels but real routing**: per-tenant, per-client, per-severity, RBAC'd, audited. Kuma has none of that. |
| K5 non-engineer CRUD | monitors are ERP rows; the blackbox target file is **generated** from them | Strictly better than Kuma — a monitor cannot drift from the property registry. |
| K6 public status pages | per-client public page in the client portal | Billable deliverable. Public = unauthenticated: see §3.5. |
| K7 maintenance windows | `monitor_maintenance` rows, Cerbos-gated, audit-logged, suppress both alerting and SLA math | Without this, planned WP updates page people and alerting gets muted permanently. |

### 3.4 Schema sketch (migration 0109+ — verify the next free number first, see §1.1)

```
monitors                 id, tenant_id, client_id→clients, property_id→search_properties (nullable),
                         kind, name, config jsonb, interval_s, enabled, severity, created_by, …
monitor_assertions       id, monitor_id, type, expr, negate            -- K2, evaluated in-driver
monitor_results          id, tenant_id, monitor_id, checked_at, status, latency_ms,
                         detail jsonb, PARTITIONED BY RANGE (checked_at)
monitor_incidents        id, tenant_id, monitor_id, opened_at, closed_at, cause, ack_by, ack_at
monitor_maintenance      id, tenant_id, scope, starts_at, ends_at, reason, created_by   -- K7
monitor_channels         id, tenant_id, kind, config jsonb (secret-ref, never inline), enabled
monitor_routes           id, tenant_id, match jsonb (client/severity/kind), channel_id  -- §4
monitor_heartbeats       id, tenant_id, monitor_id, token_hash, last_seen_at, grace_s   -- K1
status_pages             id, tenant_id, client_id, slug UNIQUE, visibility, theme jsonb  -- K6
```

Every table RLS-scoped on `tenant_id` (FORCE), `monitor_results` partitioned — it is the only table
here with unbounded growth, and retention becomes a partition drop rather than a `DELETE` that bloats.

**`monitor_channels.config` holds secret *references*, never secrets.** A webhook URL with an embedded
token is a credential; it must not sit in a jsonb column that any `monitoring.read` holder can select.

### 3.5 Security — three things that are not optional

1. **SSRF.** Every driver dials a target the customer names. This is an SSRF primitive by construction.
   Reuse `search-crawl-go/internal/egress` **as the only dial path**: per-monitor allowlist resolved from
   verified `search_properties`, DNS→IP re-validation on the address actually dialed, private/reserved
   denial, JSONL audit of every attempt. A monitoring module that can hit `169.254.169.254` is a cloud
   credential exfiltration tool with a dashboard.
2. **Outbound webhooks are SSRF in the other direction** (§4.4).
3. **Public status pages are an unauthenticated read surface on tenant data** — the only one in the ERP.
   Explicit allowlist of exposed fields (monitor display name, status, uptime %, incident note). Never
   the URL, never `config`, never the assertion string, never latency detail. Default `visibility='private'`;
   going public is an audited action requiring `status_page.publish`.

---

## 4. Notification + webhook bus — the Hermes/agentic seam

Owner intent: notifications and webhooks matter because they feed the agentic system and will connect to
Hermes as the orchestrating brain. So this is **not** a Kuma-style "94 integrations" checkbox — it is an
event bus that agents subscribe to.

### 4.1 Ruling: ride the outbox, do not build a second path

`events/outbox.service.ts` already exists — a transactional outbox with HLC stamping, an n8n bridge, a
relay, and consumers. Monitoring emits through `emitEvent()` **in the same transaction** as the incident
write. That buys us, for free: exactly-once-ish delivery, HLC ordering, the n8n bridge, sync-engine
compatibility, and dead-lettering.

```
monitor_results ─▶ incident open/close ─┬─▶ emitEvent(tenant, 'monitor_incident', id, 'monitoring.incident.opened', …)
   (same txn) ─────────────────────────┘
                                         │
        outbox relay ──▶ consumers ──────┼──▶ channel drivers  (email, WA/TG bot, ntfy, webhook, Slack)
                                         ├──▶ n8n bridge       (existing — automation flows)
                                         └──▶ agent/Hermes seam (§4.3)
```

**A monitoring alert that is not in the outbox does not exist.** No driver may notify directly.

### 4.2 Event taxonomy (stable contract — agents will bind to these)

```
monitoring.incident.opened      monitoring.incident.closed      monitoring.incident.acknowledged
monitoring.heartbeat.missed     monitoring.cert.expiring        monitoring.domain.expiring
monitoring.dns.changed          monitoring.assertion.failed     monitoring.maintenance.started|ended
```

Name them once and treat them as a published contract from day one — the `N8N_BRIDGE_ENTITY_TYPES`
incident showed that a silently-unregistered entity type darkens every downstream flow with no error.
**Ship the registration pin with the taxonomy, not after it.**

### 4.3 The Hermes seam

Hermes routes and agents execute ([[hermes-orchestration-program]]). Monitoring is the highest-value
event source to hand it: an incident is a *fact with a required response*, which is exactly the shape
agentic triage needs.

- **Read path (v1, safe):** monitoring events reach agents via the existing n8n bridge and MCP Hub. An
  agent can read incidents, correlate with recent deploys, draft a diagnosis, propose a remediation
  ticket. All read-only, no approval needed.
- **Write path (v2, gated):** an agent proposing a remediation goes through **ASST-23 write proposals**
  → D14 approval → execute. Never direct.
- **Two hard rules carried from the search program, which apply verbatim:**
  - **Automation may never trigger a paid or state-changing action without a standing human authorization.**
    A monitor definition written by a verified human under `monitoring.write` **is** that authorization
    for probing. It is *not* authorization to restart a client's server.
  - **No allow-list may include a money-spending or externally-destructive tool.**
- **MCP Hub registration:** monitoring tools registered with real `pathTemplate`s. 14 of 18 `search.*`
  tools shipped as pathTemplate-less stubs and were silently uncallable — do not repeat that.

### 4.4 Webhook egress — the part everyone gets wrong

Outbound webhooks are **SSRF with a customer-supplied URL**, and they carry our data outward.

- Same egress guard, inverted: deny private/reserved/link-local destinations; re-validate the resolved IP.
- Per-tenant rate cap + exponential backoff + circuit break; a dead endpoint must not become a retry storm.
- **HMAC-sign every payload** (`X-Gaiada-Signature`, timestamped, replay window) so receivers can verify.
- Delivery attempts are audited rows, not logs — "did the client's webhook fire" is a support question.
- Payloads follow the §3.5 field allowlist. An incident webhook must not leak the assertion string
  (it can encode what we consider a compromise signature).

---

## 5. UI — Plane B is the product surface

Nav owner of truth is `platform-ui/src/components/shell/nav.ts`; the human index is
[`docs/sidebar-nav-map.md`](../sidebar-nav-map.md) — **update both in the same commit** or the move is
treated as an accident.

### 5.1 Placement

| Audience | Where | Gate |
|---|---|---|
| Staff — cross-client operations board | **Business → Monitoring** `/monitoring` | `monitoring.read` |
| Per-property detail | tab on the existing property/client surfaces | `monitoring.read` |
| Client (portal) | **Portal → Status** `/portal/status` | `isClientOnly` |
| Public | `/status/:slug` — own route group, **no shell, no auth** | none |
| Plane A (us) | **Systems → Observability** `/admin/observability` — deep-links to Grafana, does **not** re-implement it | `admin.access` |

That last row matters: the Systems group already holds AI Gateway / MCP Hub / Automation. Plane A gets a
*link and health summary* there — we are not rebuilding Grafana in React.

### 5.2 Pages

1. **`/monitoring` — Operations board.** The one screen that replaces Nexus's fabricated dashboard.
   Status tiles (up / degraded / down / in-maintenance), sorted by severity then client. Filter by client,
   kind, tag. Dense table, virtualized — 63 properties today, thousands at SaaS scale.
2. **`/monitoring/:id` — Monitor detail.** Uptime bar (90 d), latency trend, incident timeline,
   assertion results, cert/domain expiry, "why it failed" with the actual probe detail.
3. **`/monitoring/new` — Monitor editor.** Kind picker driven by the **driver registry's declared
   capabilities**, so adding the MQTT driver makes MQTT appear in the UI with no frontend change.
4. **`/monitoring/channels` + `/routes`** — notification channels and routing rules; test-send button.
5. **`/monitoring/maintenance`** — schedule a window (K7), see what it will suppress *before* saving.
6. **`/monitoring/status-pages`** — configure the per-client public page; explicit publish confirmation
   naming exactly which fields become public.
7. **`/portal/status`** and **`/status/:slug`** — the client-facing views.

### 5.3 Design constraints (from what already bit us)

- **`role="log"` is an aria-live region** — a live-updating incident feed will spam a screen reader.
  Batch updates, never `assertive`. [[role-log-is-a-live-region]]
- **Dark theme + responsive from the first commit**, not a later polish pass.
- **Provenance is visible.** Every number states its source and freshness ("checked 40 s ago"). A stale
  probe must *look* stale. This is the single discipline that separates us from Nexus's hash function,
  and it is a UI property, not just a data property.
- **Empty states are real states.** "No monitors configured" must not render as a green all-clear —
  that is precisely how a fabricated dashboard feels correct.

---

## 6. Sequence

```
MON-00  boundary rule + cross-root test        ← architect, gates everything tenant-facing
MON-09e rollback fix                            ← gates any multi-service deploy
   │
MON-09a ─▶ MON-09b (A1) ─▶ MON-09c (A2) ─▶ MON-09d (A3)      Plane A, 72h gates
   │
MON-10  module skeleton + schema 0109+ + RLS + Cerbos          ← senior-be + senior-db
MON-11  driver registry + http/tcp/tls drivers (egress-guarded) ← senior-be
MON-12  runner service + /metrics + result partitioning        ← senior-be
MON-13  heartbeat driver + ingest endpoint (K1)                ← medior   ⭐ do early, standalone value
MON-14  keyword/assertion driver + signature list (K2)         ← medior
MON-15  dns + domain/tls expiry drivers (K3 subset)            ← medior
MON-16  outbox event taxonomy + registration pin (§4.2)        ← senior-integrator
MON-17  channel drivers + routes (§4.3) + webhook egress (§4.4) ← senior-integrator
MON-18  maintenance windows (K7)                               ← medior
MON-19  UI: operations board + monitor detail                  ← senior-fe
MON-20  UI: editor, channels, routes, maintenance              ← medior
MON-21  status pages: portal + public route group (K6)         ← senior-fe + senior-uiux
MON-22  MCP Hub tool registration + Hermes read path           ← senior-integrator
MON-23  QA: SSRF adversarial (both directions), cross-tenant leak, public-page field allowlist ← qa
```

**Critical path to "better than Nexus on cutover day":** MON-00 → MON-10 → MON-11 → MON-12 → MON-19.
**Highest value per unit of effort, and independent of all of it:** **MON-13** (heartbeat) — it fixes a
failure class that has already hurt us twice in production and needs no UI to be useful.

Plane A (MON-09*) runs in parallel throughout; it shares no code with Plane B.

---

## 7. Risks

| Risk | Why it is real here | Mitigation |
|---|---|---|
| **Disk exhaustion on gda-aicenter** | 20 G free; full stack wants 8–15 G; [[deploy-disk-fills-and-rolls-back]] is a recorded failure | tiered A1→A3 with measured deltas; prune first; reduced retention at A1 |
| **Full ERP restart** | observability.yml merge-overrides env on 7 core services | declared window; MON-09e first |
| **SSRF, inbound and outbound** | every probe and every webhook dials a customer-named target | single egress choke-point; adversarial QA is a merge gate (MON-23) |
| **Cross-root leak via hierarchy rollup** | monitoring adds the first cross-client aggregate board | MON-00 boundary rule + a test that fails on a foreign root |
| **Public status page leaks** | the ERP's only unauthenticated read surface | field allowlist, default private, audited publish |
| **Alert fatigue** | without maintenance windows, planned work pages people and alerting gets muted forever | K7 (MON-18) is not optional polish |
| **A monitor that lies** | "up" from a missing driver or a stale result is worse than no monitoring — it is Nexus's failure exactly | absent-not-inert rule, registration pin, visible freshness in UI |

---

## 8. Provenance

Capacity figures are from SSH probes of `gda-aicenter` on 2026-08-13. Schema claims are read from the
migration files named inline (head = 0107 committed). Compose behaviour is read from
`infra/compose/docker-compose.observability.yml`.

**§2 records work that WAS executed** against the live box on 2026-08-13: the observability stack was
consolidated and deployed, and every figure in §2.1 was verified by query, not estimated. §3–§7 remain
design; no backend code exists. The Plane B UI in §5 was built and driven in a browser under
`DEMO_MODE=1`, but has never run against a real backend, because there is not one.

---

## 13. MON-10b — the IAM unit that must land as ONE change (spec, 2026-08-19)

MON-10's schema is committed (migration `0116_module_monitoring.sql`, verified against a throwaway
database). The module **cannot be registered** until the IAM layer knows about it, and the pieces below
must ship together — because the failure mode is **boot**, not a red test.

### The three non-obvious constraints, found by reading 0106 (social) rather than assuming

1. **`validateModulePermissions()` refuses boot** if any `ModuleContract.permissions` key does not
   resolve to a `class='grantable'` row in the `permissions` catalog. So a contract shipped without its
   catalog migration does not fail a test — **the platform will not start with the module compiled in.**
   The catalog rows land *before* the module shell, never after.
2. **Cerbos role names are not a choice.** `derived_roles.yaml` string-composes them at request time
   from `resource.attr.module`: `module_staff` → `<module>_staff`, `module_manager` →
   `<module>_manager`. The module key is `monitoring`, so the only names Cerbos will ever look for are
   **`monitoring_staff`** and **`monitoring_manager`**. Any other name silently never matches — an
   authz surface that denies everything while looking configured.
3. **Key format is dotted** `<domain>.<resource>.<action>`, matching the catalog. Colon-style keys from
   older designs are obsolete.

### The permission set

| Key | Notes |
|---|---|
| `monitoring.monitor.read` | The broad grant. Everything on the board is visible to it — which is why `monitor_channels.config` and `monitor_results.detail` hold no secrets and no public-page content. |
| `monitoring.monitor.create` / `.update` / `.delete` | Authoring a monitor. Per §4.3 this IS the standing authorization to probe on a schedule, and is NOT authorization to act on the target. |
| `monitoring.incident.acknowledge` | Deliberately separate from `.update`: acknowledging is an accountability record, not an edit. |
| `monitoring.maintenance.create` | K7. Suppresses alerting *and* SLA math, so it is a real grant, not a convenience. |
| `monitoring.status_page.publish` | **`sensitive: true`.** It moves tenant data onto the ERP's only unauthenticated read surface. |

### Order of work

1. Migration `0117_iam_monitoring_permissions.sql` — catalog rows (idiom: `INSERT … SELECT FROM
   (VALUES …) ON CONFLICT (key) DO UPDATE`, so re-running is a metadata sync and never churns ids that
   `role_permissions` references), the two roles, and the role→permission bundles.
2. `cerbos/policies/resource_monitor.yaml` (+ incident / maintenance / status_page resources).
   **Cerbos does not hot-reload — restart it and prove the new decision with a probe.** A healthy
   Cerbos container has served two-day-stale policy on this estate before.
3. `src/modules/monitoring/index.ts` — the `ModuleContract` (key `monitoring`, `migrations: ['0116…',
   '0117…']`, the permissions above, MCP tools with real `pathTemplate`s).
4. Bootstrap registration, then `array_append` `monitoring` to the demo company's `enabled_modules` —
   without it every route 404s, which cost the search module a debugging session.

### Then, in order

**MON-11** driver registry (http/keyword/tcp/dns/tls/heartbeat) behind `search-crawl-go`'s egress
guard — every probe dials a customer-named target, so that guard is mandatory, not optional.
**MON-12** runner + `/metrics` + partition roll-forward. **MON-13** the heartbeat slice, which is the
highest value per unit of effort and needs no vendor credential: it closes a class of failure that has
silently bitten this estate twice.
