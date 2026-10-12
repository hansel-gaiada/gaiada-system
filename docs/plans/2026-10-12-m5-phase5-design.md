# M5 phase 5: enrichment collector, consented profiles, A/B tests, own replay (design)

**Status:** PLANNED. This is a design; nothing in it is built. **Date:** 2026-10-12. **Plan rows:** M5-V2, V3, V5, V6 in
[`2026-10-11-webdesk-m5-plan.md`](./2026-10-11-webdesk-m5-plan.md). **Rulings:** WSK-D66, WSK-D67 ([`webdesk-design-v2.md`](../blueprints/webdesk-design-v2.md) §14).
**Builds on:** M5-V1 ([geo review](./2026-10-11-m5-geo-and-company-data-review.md): DB-IP Lite), M5-A3 (Umami 3.4.0 on `sumopod`, deployed 2026-10-12),
M5-A4 (`search/umami-client.ts`, `umami-reads.ts`), M5-G6 (WebDesk `consent_records`, migration 0017), M5-L2/L4 (`visitor_consent.consentId` on
submissions and on `agency_leads.visitor_consent`), M5-W8b (vocabulary 1.4.0), M5-G5 (`core/agency-privacy*.ts`), the P1 design flag (c).
**Read for this design:** `infra/sumopod/umami/**`, `infra/sumopod/erp-edge/{traefik.yml.template,dynamic/erp-insights.yml}`, `infra/runbooks/umami-sumopod.md`,
`webdesk/api/src/{consent,forms/attribution.ts,privacy,control/command-types.ts,control/content/search-text.ts,delivery/router.ts}`,
`webdesk/delivery/vocabulary/{blocks,item-fields,client-editable,envelope,version}.ts`, `webdesk/api/src/codegen/generator/openapi-builder.mts`,
`platform-nest/src/modules/search/{umami-client,umami-reads,search-analytics.controller,content-decay-job,egress-inventory.test}.ts`,
`cerbos/policies/resource_search_property.yaml`, `core/agency-{web-leads,lead-pipeline,privacy}.service.ts`, the Website workspace in platform-ui,
the site's `src/scripts/tracking/{consent,events,vendors}.ts` and `src/lib/forms/payload.ts` (gaiada-web-revamp branches `m5/umami`, `m5/l1s-forms`),
and `legal/website-visitor-addendum.md` (F3–F9, §3.6, §5, §9, R-V1/R-V6/R-V8/R-V18, open items 5, 10, 15, 20).

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The collector is a new Go component, `insights-collector/`, run as service `collector` with its own Postgres `vdb`, **inside the existing `umami` compose project** on `sumopod`, on the `internal` network only | It must sit between the nginx `edge` and Umami (`app:3000`), which only `internal` reaches; a separate project would need cross-project networks. `internal: true` has no gateway, so no egress by construction and no new guard rule. Go: one small static binary on a box measured at load ~21 with ~4 GiB free |
| D2 | The collector resolves each request's IP once and then gives Umami a **daily-keyed pseudonym** instead of the IP, plus country/region/city as headers | Umami then never sees a raw IP (A3 leans on an UNCONFIRMED "IP never stored"). The key is random, held only in memory and replaced at 00:00 UTC, so nobody can test guessed IPs against it: that closes the unkeyed-salt weakness the V1 review found (R-V6). Fallback if V2-d shows Umami 3.4.0 mishandles it: pass the real IP over `internal`, as today |
| D3 | Two browser channels. **Aggregate** (everyone): Umami's tracker, unchanged, now through the collector. **Consented**: the site's own small client posts to `/lib/kestrel/v` only with analytics consent and a logged `consentId` | Umami stays the cookieless store and never receives a visitor id (R-V6: separate stores). Network and company are derived only on the consented channel, so with no consent there is only aggregate geo |
| D4 | **Profiles live in the ERP** (platform-nest, `search` module), not on `sumopod`. The collector only buffers consented events for 72 h; the ERP pulls them through the existing WireGuard `read-gate` | Keeps D66's direction (the ERP pulls; sumopod holds no credential into the ERP). Narrows R-V18 from 14-month profiles to a 72-hour buffer on the personally contracted box. Gives the Visitors tab Cerbos, RLS, G5's privacy flow and the lead join in one database |
| D5 | Consent is proven by WebDesk's log, never by the browser: a new control read **`consent.status`** returns each consent id's latest record. Ingest and an hourly sweep use it; an absent id or `analytics !== true` means no profile | A browser claim can be forged; the log is the evidence (R-V3). The site records an analytics-only withdrawal as `action:"update"` with `analytics:false` (`consentAction` in `src/lib/forms/payload.ts`), so every consumer keys on `analytics`, never on `action`. The same read lets P2 re-check a lead's consent just before an upload (P1 design flag (c)) |
| D6 | The ERP sends the collector exactly one write: **`forget`**, delete-only, its own key, through the same gate | Withdrawal and erasure must reach the buffer and the recordings. **Needs a narrow amendment of D66's "pushes nothing"** (O1) |
| D7 | `CompanyResolver` is a plug-in in the collector. The default, `network-only`, returns the ASN organisation labelled **Network**, never Company. Only local-file resolvers can exist: the collector has no egress | V2 and V3 ship without O-12. An API vendor (Snitcher-type) would need a ruling and a network change, which matches the V1 review's "local file preferred" |
| D8 | A/B variants ride a new block type, `experiment`, inside `blocks`: **vocabulary 1.4.0 → 1.5.0 (MINOR), no WebDesk migration** (this corrects the plan row's "WebDesk next") | Variant content is versioned, reviewed, previewed and published with its item through the existing WS4 publish (D46). An older renderer renders nothing for the block and shows the control |
| D9 | Assignment: with a visitor id, `hash(visitorId, key)`; without, session-only (`sessionStorage`; no id leaves the browser). Each experiment's `enrolment` defaults to `consented`; `all` only after counsel confirms F9's basis | Stable arms where an id lawfully exists; nothing persistent without consent |
| D10 | Results: **frequentist, fixed horizon**, pre-registered n, α 0.05 two-sided, power 0.8, 14–56 days. The API returns no effect estimate before the horizon | §5.4 |
| D11 | Replay: rrweb on the site for consented, sampled visitors; forms blocked and inputs never recorded (checked in the browser and on the server); kept 30 days in `vdb`, not backed up; viewed in the ERP behind a separate action, `view_replay`; every viewing audited | §6 |

## 2. The shape

```
visitor ─443─> mimi (TLS passthrough, PROXY v2) ─> erp-edge Traefik ─> 172.17.0.1:18742 nginx `edge` ─┐   umami project, `internal: true`
   /lib/kestrel.js ─────────────────────────────────────────────────────────────────> app (Umami)    │   (no gateway, no egress)
   /lib/kestrel/e  aggregate, everyone ─> collector:8080 ─ pseudonym + geo headers ─> app (Umami)    │
   /lib/kestrel/v  consented events    ─> collector ─> vdb.consented_events (72 h)                   │
   /lib/kestrel/r  replay chunks (V6)  ─> collector ─> vdb.replay_* (30 d)                           │
   /lib/kestrel/f  forget              ─> collector ─> delete + tombstone                            ┘
gda-aicenter platform-nest ─wg0─> 10.88.0.2:18743 `read-gate` ─> /api/websites/*  (Umami, A4, GET only)
                                                              └> /ops/v1/*        (collector:8081: GET reads, one POST: forget)
platform-nest ─control channel (mTLS + Keycloak)─> WebDesk `consent.status`
```

## 3. V2: the enrichment collector

### 3.1 Placement, limits, egress, geo refresh

| Service | Image | Networks | Limits | Holds |
|---|---|---|---|---|
| `collector` (new) | `ghcr.io/<org>/insights-collector:<ver>@sha256:…`, built and cosign-signed by CI (V2-b) | `internal` | cpus 0.5, mem 192m, pids 64, `read_only`, `cap_drop: ALL`, no-new-privileges, non-root | nothing writable; `./geo` mounted read-only (DB-IP City Lite + **ASN Lite**) |
| `vdb` (new) | `postgres:16.15-alpine`, the digest `db` already pins | `internal` | cpus 0.25, mem 256m, pids 128 | buffer, tombstones, bot counts, recordings (V6) |
| `edge` (exists) | unchanged | `internal` + `edge` | unchanged | the collect path now proxies to `collector:8080`; new exact locations `/lib/kestrel/v`, `/f`, `/r` |
| `read-gate` (exists, profile `erp-read`) | unchanged | as now, on wg0 | unchanged | adds `/ops/v1/` → `collector:8081`; `POST` allowed on `/ops/v1/forget` only |

- **Egress:** both new services sit only on `internal`. `egress-guard.sh`'s two rules are unchanged; nothing new is published.
- **Preflight** (runbook step 0) adds ~450 MiB of limits: `free -m` must show ≥ 2 GiB available; V6 adds `df` ≥ 25 GB free (81 % used when measured).
- **Geo refresh:** `geo-refresh.sh` also fetches `dbip-asn-lite-YYYY-MM.mmdb.gz` with the same checks (gzip test, size floor, MMDB marker, atomic rename) and restarts `umami-collector-1` beside `umami-app-1`. Attribution stays the privacy-page line ("IP Geolocation by DB-IP"); vendor row ¹¹ already covers the ASN edition.
- **Umami config:** `SKIP_LOCATION_HEADERS` is removed **only if V2-d proves D2**, so Umami reads the `cf-ipcountry`, `cf-region-code` and `cf-ipcity` that only the collector sets. The edge keeps stripping them from public requests (`proxy-common.inc`). Umami stays stock: this is configuration, not a fork.

### 3.2 One request on the aggregate channel (`/lib/kestrel/e`)

1. The `edge` forwards to `collector:8080` with `X-Real-IP`, which it already overwrites from erp-edge's trusted `X-Forwarded-For`. Port 8080 trusts `X-Real-IP`; port 8081 never reads it.
2. Body ≤ 32 KB (as erp-edge and the edge cap it). Accept only `type:"event"`; drop `identify` and every other type, so Umami's session data and its own replay (3.1+) stay unused. Delete `payload.id` (Umami's distinct id: a persistent id must never reach Umami). `payload.website` must be in `INSIGHTS_WEBSITES` (compose `:?` required, so an empty list cannot silently block or admit everything).
3. Resolve once: City → country, region, city; ASN → number, organisation. **Bot** = the vendored `isbot` pattern list (MIT, data file with its notice) on the UA, **or** the ASN is in `data/datacenter-asns.txt` (reviewed data file; compute clouds only, see §9 trap 1).
4. Bot: not forwarded; `bot_counts(website, day, reason) += 1`; answer as Umami answers a bot (`{"beep":"boop"}`). The bot result is used to drop, because Umami has no bot field and LIA C's purpose is exclusion.
5. Not a bot: forward to `app:3000` + `COLLECT_API_ENDPOINT` with only `User-Agent`, `Content-Type`, `x-umami-cache` (passed through), `x-real-ip: fd…` (the first 120 bits of HMAC-SHA256(day key, IP), as an fd00::/8 address) and the three `cf-*` headers when resolved. Return Umami's status and body; timeout 3 s.
6. The IP exists only in that request's memory. No access log. Error lines carry typed outcomes and counts, never an IP, UA, visitor id or consent id.

### 3.3 `CompanyResolver`

```go
// insights-collector/internal/company
type Result struct {
    Kind, Name, Domain   string // Kind: "network" | "company"; Domain "" for a network
    Confidence           string // "network" | "low" | "medium" | "high"
    Source, Version      string // e.g. "dbip-asn-lite", "2026-10"
}
type Resolver interface {
    Name() string
    Resolve(ip netip.Addr, asn ASN) (Result, bool) // false: nothing known; never a guess
}
```
Registered by name; `COMPANY_RESOLVER` unset or empty selects `network-only` (the default is a real choice, never "off by accident"). `network-only`
returns `{Kind:"network", Name: asn.Org, Confidence:"network", Source:"dbip-asn-lite"}`, or nothing when the ASN is unknown. It runs **only on the
consented channel**. After O-12, a new resolver is one more local-file implementation and a register row; the interface does not change.

### 3.4 Failure modes

| Failure | Behaviour |
|---|---|
| City or ASN file missing at start | Start anyway; forward without `cf-*` headers; bot check by UA only; `/healthz` says `geo:degraded`; one log line names the file |
| Umami slow or down | 502 to the tracker after 3 s (it sends in the background; no page waits); nothing buffered |
| `vdb` down | Aggregate channel unaffected (bot counts dropped and counted in a process metric); consented and replay channels answer 503 |
| Collector down | The edge answers 502; trackers fail silently. Rollback: point the edge's collect location back at `app:3000` and restore `SKIP_LOCATION_HEADERS=1` |
| Numeric env empty | The documented default, never 0; out of range refuses to start and names the variable (the `consent.config.ts` discipline). Switches are on only for exactly `1` |
| Day key replaced at 00:00 UTC, or a restart | Umami sessions split at that moment; a restart day counts slightly more visitors (accepted: the key never touches disk) |

## 4. V3: consented visitor profiles

### 4.1 Identity rules

| # | Rule |
|---|---|
| I1 | The browser mints a visitor id (`crypto.randomUUID()`) only when analytics is granted **and** the consent log has returned a `consentId`; both are stored together in localStorage |
| I2 | No `consentId`, no profile: the consented channel refuses a body without both ids |
| I3 | A new `consentId` (site data cleared, or a version re-ask that mints one) means a new visitor id; the old profile ages out |
| I4 | Analytics off (`withdraw`, or `update` with `analytics:false`): the site calls `/lib/kestrel/f`, then deletes its visitor id |
| I5 | A `410 visitor-forgotten` answer: the site deletes its visitor id and mints none again for that `consentId` |
| I6 | The privacy page shows the visitor their own id (addendum §10, item 9), for rights requests |
| I7 | The visitor id never goes to Umami, GA4, Google Ads, Meta, Clarity or any other third party |

### 4.2 Flow

1. **Browser** (consented only): batches ≤ 50 events every 10 s and on `pagehide`: `POST /lib/kestrel/v` `{website, visitorId, consentId, events:[{t, kind, path, name?, data?}]}`, body ≤ 16 KB, sent as `text/plain` JSON with `keepalive` (no preflight).
2. **Collector:** validates (uuids; website allow-list; `kind` pageview or event; `path` only, no query or hash, ≤ 512; event names from the site's list; data keys `section_id`, `link_location`, `form_id`, `step_index`, `language_to` only; `t` clamped to ±10 min of receipt), drops bots, answers 410 for a tombstoned visitor, resolves geo + network + company, stores rows in `consented_events` with a device class (desktop/mobile/tablet/unknown, WebDesk's `classifyUserAgent` buckets) and never the IP or the UA. 204.
3. **ERP ingest** (`search`, every 10 min, OFF unless `SEARCH_VISITORS_ENABLED=1`): per property with `umami_site_id`, under advisory lock `0x53430005` keyed on the property: `GET /ops/v1/events?website&after=<cursor>&limit=1000`; distinct consent ids → `consent.status` (≤ 100 per call); per event: tombstoned visitor or consent → skip; latest record absent or `analytics !== true` → skip and queue a `forget`; else upsert the profile, insert the event (`UNIQUE (property_id, collector_event_id)`), recompute interests and score; the cursor advances in the same transaction.
4. **Sweep** (hourly, same lock): every live profile's consent id → `consent.status`; not `analytics:true` → delete the profile (events cascade), tombstone the visitor id (`withdraw`), `POST /ops/v1/forget`.
5. **Purge** (daily): profiles whose `last_seen_at` is older than 14 months; tombstones older than 14 months.

### 4.3 `consent.status` (WebDesk control read)

- `POST /control/v1/tenants/:tenantSlug/consent/status` `{siteSlug, consentIds: uuid[1..100]}` → `200 {statuses:[{consentId, analytics, marketing, action, noticeVersion, recordedAt}]}`: the latest record per id for that site (`ORDER BY recorded_at DESC, id DESC`). An id with no record is **omitted** (no proof). `user_agent_class` is not returned.
- Registry: `consent.status`, impact `read`, scope `webdesk:read`, not job-tracked, no audit row (as `forms.submission.get`). Tenant context plus an explicit `tenant_id` filter; unknown site 404; more than 100 ids or a non-uuid 400. No migration: `ix_consent_records_subject (tenant_id, consent_id, recorded_at)` serves it.
- ERP caller: the L4 control client and its cross-company wall (an active WebDesk tenant whose `company_ref` is this company, else 404).

### 4.4 Collector APIs

| Route | Caller | Contract |
|---|---|---|
| `POST /lib/kestrel/v` | browser | §4.2 step 2. 204, 400, 403 (unknown website), 410, 429, 503 |
| `POST /lib/kestrel/f` | browser | `{website, visitorId, consentId}` → always 204 (no oracle); deletes buffer rows and recordings only where the pair matches; tombstones the visitor id |
| `GET /ops/v1/events` | ERP, read key | `?website&after&limit≤1000` → `{events:[{id, visitorId, consentId, receivedAt, occurredAt, kind, path, name, data, device, geo:{country, city}, network:{asn, name}, company}], next}`. Only rows with `received_at < now() − 15 s` (a bigserial can commit after a larger one) |
| `GET /ops/v1/bots` | ERP, read key | `?website&from&to` → daily counts by reason |
| `POST /ops/v1/forget` | ERP, forget key | `{website, visitorIds ≤ 100, consentIds ≤ 100, mode: "withdraw" or "erase"}` → deleted counts; tombstones the hashes; idempotent. The read key gets 403 |
| `GET /healthz` (8081) | docker | db, geo files and their versions, build version |

Keys are two random 32-byte values. The collector holds only their SHA-256 (`OPS_READ_KEY_SHA256`, `OPS_FORGET_KEY_SHA256`, compose `environment:`).
platform-nest holds `INSIGHTS_BASE_URL` (`http://10.88.0.2:18743`), `INSIGHTS_READ_KEY` and `INSIGHTS_FORGET_KEY`, listed in
`infra/compose/docker-compose.vps.yml` `environment:` and `.env.example` (an `.env` line alone does nothing). Any of them unset: the tab says "not configured".

### 4.5 ERP schema (one platform-nest migration, timestamp name; V3-d)

```sql
-- Every table: ENABLE + FORCE RLS with the search wall copied from 202610122200 (tenant_id = ANY(app_current_tenants())
-- AND app_module_allowed('search')). No DML anywhere in the file (the RLS zero-row trap cannot bite).
CREATE TABLE search_visitor_profiles (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id), visitor_id uuid NOT NULL, consent_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL, visits int NOT NULL DEFAULT 0, pageviews int NOT NULL DEFAULT 0,
  device text NOT NULL DEFAULT 'unknown' CHECK (device IN ('desktop','mobile','tablet','unknown')),
  country text CHECK (country ~ '^[A-Z]{2}$'), city text CHECK (length(city) <= 120),
  first_source jsonb,                     -- {referrerHost, utmSource, utmMedium, utmCampaign} of the first event; no query strings
  network jsonb, company jsonb,           -- latest resolver results, with kind/confidence/source/version
  interests jsonb NOT NULL DEFAULT '{}', score smallint NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100), score_parts jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, property_id, visitor_id));
CREATE INDEX ix_visitor_consent ON search_visitor_profiles (tenant_id, property_id, consent_id);
CREATE INDEX ix_visitor_recent  ON search_visitor_profiles (tenant_id, property_id, last_seen_at DESC);
CREATE TABLE search_visitor_events (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, property_id uuid NOT NULL,
  profile_id uuid NOT NULL REFERENCES search_visitor_profiles(id) ON DELETE CASCADE, collector_event_id bigint NOT NULL,
  occurred_at timestamptz NOT NULL, kind text NOT NULL CHECK (kind IN ('pageview','event')), path text CHECK (length(path) <= 512),
  name text CHECK (length(name) <= 50), data jsonb CHECK (pg_column_size(data) <= 1024), UNIQUE (property_id, collector_event_id));
CREATE TABLE search_visitor_tombstones (tenant_id uuid NOT NULL, property_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('visitor','consent')),
  id_hash bytea NOT NULL, reason text NOT NULL CHECK (reason IN ('withdraw','erase')), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, kind, id_hash));                   -- sha256 of the id: an erased person's pseudonym is not kept
CREATE TABLE search_interest_rules (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, property_id uuid NOT NULL REFERENCES search_properties(id),
  match text NOT NULL CHECK (match IN ('path_prefix','section_prefix')), pattern text NOT NULL CHECK (length(pattern) BETWEEN 1 AND 200),
  facet text NOT NULL CHECK (facet IN ('industry','service')), tag text NOT NULL CHECK (tag ~ '^[a-z0-9-]{1,40}$'),
  weight smallint NOT NULL CHECK (weight BETWEEN 1 AND 10), UNIQUE (property_id, match, pattern, facet, tag));
CREATE TABLE search_visitor_ingest_state (tenant_id uuid NOT NULL, property_id uuid PRIMARY KEY REFERENCES search_properties(id),
  cursor bigint NOT NULL DEFAULT 0, last_run_at timestamptz, last_ok_at timestamptz, last_outcome text);
-- agency_leads is a plain tenant wall; this only ADDS an index for the lead link (no constraint touched, no DML):
CREATE INDEX ix_lead_consent_id ON agency_leads (tenant_id, (visitor_consent->>'consentId')) WHERE visitor_consent ? 'consentId';
```

### 4.6 Interests and score (a pure module, no I/O)

- **Interests:** rules map a path prefix or a `section_id` prefix to `{facet: industry or service, tag, weight}`. Per facet, a tag scores the sum of rule weights over distinct matched pages and sections in the last 90 days; the top three per facet are shown. Rules are data (tab and tool). No rules means no interests, never a guess. The source is the consented event stream only, never a lead's attribution.
- **Score** (0–100, every part stored in `score_parts` and shown):

| Part | Max | Rule |
|---|---|---|
| Recency | 25 | last visit ≤ 7 days 25, ≤ 30 days 15, ≤ 90 days 5 |
| Frequency | 15 | visits 2 → 5, 3–4 → 10, ≥ 5 → 15 |
| Depth | 30 | the sum of interest-rule weights over distinct matches, capped |
| Intent | 30 | `lead_form_start` 15; any `cta_click`, `click_whatsapp`, `click_phone` or `click_email` 10; `generate_lead` 5; capped |

A score orders a list. No job, tool or rule acts on it (R-V1: no decision about a person, manual review before any outreach).

### 4.7 Withdrawal, erasure, retention

| Event | On `sumopod` (collector) | In the ERP |
|---|---|---|
| Banner: analytics off | `/f` deletes the visitor's buffer rows and recordings at once; tombstone | Next sweep (≤ 1 h): profile deleted, visitor tombstoned, `forget` sent |
| Rights request (G5; by email/phone, visitor id or consent id) | `forget mode:"erase"` | Profiles matched directly, or through a matched lead's `visitor_consent.consentId`, are deleted; visitor **and** consent tombstoned, so nothing is re-created |
| Forged or unknown `consentId` | `forget` from ingest | Never ingested |
| Time | buffer 72 h; recordings 30 days; tombstones (hashes) 14 months | profile and events 14 months after the last visit; tombstones 14 months |

### 4.8 Authorization, BFF, MCP

- **Cerbos (V3-f):** two new actions on the existing kind `resource_search_property`: `read_visitors` and `view_replay` (V6). Role arm: `module_manager` and `company_admin`, in tenant (plain `module_staff` keeps aggregate `read` only). Perm arm: `perm_resource_search_property_read_visitors` and `…_view_replay` with the kind's existing condition. No new kind. Artifacts: the policy, the catalog JSON, an IAM migration (permission rows), the `platform-ui/src/lib/rbac.ts` mirror, the pinned-count tests; a Cerbos restart and a probe at release.
- **Routes** (a new controller class on `api/:tenantId/modules/search`, like `SearchAnalyticsController`; the property resolves through `withTenants([t], {modules:['search']})`):

| Capability | Route under `…/properties/:propertyId/` | Cerbos | MCP tool | Impact |
|---|---|---|---|---|
| List | `GET visitors?minScore&facet&tag&hasLead&seenFrom&order&cursor` (server order) | `read_visitors` | `search.visitors.list` | read |
| Detail | `GET visitors/:visitorId` (summary, latest 200 events, interests, score parts, lead) | `read_visitors` | `search.visitors.get` | read |
| Interest rules | `GET` / `PUT visitors/interest-rules` | `read_visitors` / `update` | `search.visitors.rules.list` / `.set` | read / low |
| State | `GET visitors/status` (configured, enabled, last ok ingest, bot counts) | `read_visitors` | `search.visitors.status` | read |
| Recordings (V6) | `GET visitors/:visitorId/recordings`, `GET recordings/:id/chunks?from` | `view_replay` | `search.replays.list` (metadata only, O7) | read |

- **The lead link:** `agency_leads.visitor_consent->>'consentId' = profile.consent_id` in the same tenant (the module-walled read and the agency read share one `withTenants`, as P2 does). The lead id is returned only when the principal may `read` that `agency_lead` (probe); otherwise "a lead you cannot open".
- Authorize before validating; denial tests send valid bodies. A non-ok state is words, never an empty list.

### 4.9 The Visitors tab (Website workspace)

A sixth tab, `visitors` (`lib/deptToolkits.ts`, `requireWebsiteCtx(…, "visitors")`, `website/visitors/[tenant]/[site]/…`), resolved like Analytics
(site → domains → search property). Header line: *"Only visitors who accepted analytics. A score is a guide for follow-up, never a decision about a
person."* List: visitor (8-character id), last seen, visits, country and city, **Network** or Company (by `kind`, with confidence), top interests,
score, lead. Detail: timeline, interests, score parts, linked lead, recordings (V6, with `view_replay`). Interest rules are edited on a sub-page.
The Analytics tab gains one figure, "bot hits filtered", from `/ops/v1/bots`, and a note of the date V2 went live (its counts drop then).

## 5. V5: A/B tests on blocks

### 5.1 The variant model: the `experiment` block

```jsonc
// A typed section item (gaiada.com: one collection per section type, WSK-D41). blocks[0] is arm "a", the control.
[ { "type": "fields", "props": { "heading": "Websites that win work", "ctaLabel": "Get a quote" } },
  { "type": "experiment", "props": {
      "key": "home-hero-2026-11",                       // ^[a-z0-9][a-z0-9-]{2,47}$; unique per property (the ERP enforces it)
      "target": "fields",                               // or { "block": 2 }: a generic block by index
      "enrolment": "consented",                         // "consented" (default) or "all"
      "goal": { "event": "lead_form_start", "match": { "form_id": "contact" } },
      "arms": [ { "key": "a", "weight": 50 },
                { "key": "b", "weight": 50, "override": { "heading": "Your next client is searching now" } } ] } } ]
```

Write-time rules (in `validateItemContent` and beside it):
- Like `fields`, non-composable and non-visual: allowed in any collection without being listed; at most one per item; never at index 0.
- Arms 2–4 with keys `a`–`d`; `a` comes first and never overrides; integer weights ≥ 10 summing to 100.
- `target:"fields"`: the collection declares fields; `override` keys ⊆ the declared fields; `{...fields, ...override}` passes `validateFieldValues`. `target:{block:i}`: `blocks[i]` is a generic block and `replace` is a block of the same type that passes `validateBlock`.
- `goal.event` ∈ `generate_lead`, `lead_form_start`, `cta_click`, `click_whatsapp`, `click_phone`, `click_email`, `section_view`; `match` holds at most one of `form_id`, `link_location`, `section_id`, each `[A-Za-z0-9_.:-]{1,64}`.
- **Never client-editable**: an explicit rule in `client-editable.ts`. Today a block after `blocks[0]` follows the collection's flag, which would let a client editor add an experiment.
- **Publish lock**: publishing an item whose live version carries experiment E is refused `409 experiment-locked` if the new version changes E or the control values E overrides. Removing E (the stop) is always allowed.
- `search-text.ts` skips `experiment` blocks, so `/v1` search indexes only the control.

### 5.2 What `/v1` allows

- The envelope changes by **no byte**; no new route; `meta.x` untouched; list routes unchanged (`blocks` only with `?expand=blocks`); WSK-48a's byte gate holds (the read SQL does not change).
- Vocabulary 1.4.0 → **1.5.0 MINOR** ("new block type", §05 rules), computed by `breaking-change.ts` against a new `test/fixtures/vocabulary-1.4.0.snapshot.json`. Re-vendor the three copies with their own scripts (`webdesk/blocks` `npm run vendor:vocabulary`; `webdesk/api` `node src/delivery/vocabulary/vendor.mjs`; platform-nest `npm run vendor:webdesk-vocabulary`), never by hand.
- Contract codegen (`openapi-builder.mts`): every collection's item schema allows one optional `experiment` block; tenant contracts regenerate as MINOR.
- An older consumer renders nothing for the block (the renderer invariant) and shows arm `a`. `webdesk/blocks` registers `experiment` as known and non-visual, so it is not reported as unknown.
- **No WebDesk migration:** `blocks` is `jsonb NOT NULL` with no type CHECK in `content_versions` and `content_items` (0002).

### 5.3 Assignment and events (the site)

| | With a visitor id (analytics consent) | Without one (only when `enrolment:"all"`) |
|---|---|---|
| Unit | the visitor id | the browser-tab session |
| Arm | `fnv1a32(visitorId + ":" + key) mod 100` over cumulative weights | a random draw kept in `sessionStorage` for the session |
| Stored | nothing new | `sessionStorage` only; only the arm label ever leaves the browser |
| Exposure | the first time the section comes into view (the trigger `section_view` already uses), once per unit | same |
| Conversion | the first goal event after exposure, once per unit | same |
| Basis | consent (F9) | aggregate counts; device storage needs counsel (F9, ePrivacy 5(3) for EU visitors) |

- **Render:** the static build emits arm `a` as normal markup and the other arms in `<template>`s; a fixed inline script after the section swaps synchronously before paint (one CSP hash). Bots are treated like people (no cloaking); the collector removes bot events from the counts. Not enrolled: arm `a`, no events.
- **Events:** `exp_exposure` and `exp_convert` with one property, `ev = "<key>:<arm>:<c or s>"` (`c` visitor unit, `s` session unit), to **Umami only** (never GA4, Google Ads, Meta or Clarity). Added to the site's `EventName` and `UMAMI_KEYS` (`['ev']`).
- **Preview** (WSK-46): `#arm=b` in the preview fragment renders that arm.

### 5.4 The stopping rule

- **Method:** a two-sided test of two proportions, each arm against `a`, at a **fixed horizon**.
- **Pre-registered at creation, immutable after start** (a trigger refuses the UPDATE): goal; baseline p₀ (suggested from the last 28 days of Umami counts, editable before start); relative MDE; α 0.05; power 0.8; weights; n per arm = ⌈(z₁₋α/₂·√(2p̄q̄) + z₀.₈·√(p₀q₀ + p₁q₁))² / (p₁ − p₀)²⌉.
- **Horizon:** every arm has ≥ n exposures **and** ≥ 14 whole days have passed. The projected date uses exposure counts only.
- **Refused at creation** (`422 underpowered`) when the projection at the last 28 days' rate (section views × the observed consented share for `consented`) exceeds 56 days.
- **At the horizon:** per arm units, conversions and rate; difference against `a` with a 95 % Newcombe interval; p from the pooled z-test, or Fisher's exact when an expected cell is < 5; Holm's correction over the k − 1 comparisons. **Ship arm X** iff its adjusted p < 0.05 and the interval's lower bound > 0 (the best estimate wins among several); otherwise keep `a`. 56 days without reaching the horizon: "inconclusive", keep `a`.
- **Before the horizon** the API returns exposures per arm, progress and the SRM check only (χ² of exposures against weights; p < 0.001 raises "sample ratio mismatch", a data-quality alarm, not an outcome look). Abort is allowed at any time and shows no outcome.
- **Why not Bayesian:** (1) the ERP can withhold the estimate until a pre-registered horizon, which turns "never peek and stop" into a property of the API instead of a habit; (2) at this traffic the duration must be known before a test starts, and a fixed n gives it; (3) a posterior shown every day invites stopping when it looks good, and its prior would be a choice nobody here can defend. Example: 3.0 % → 4.5 % needs 2,518 units per arm, about 17 days at 300 units a day or 42 at 120. Named upgrade if traffic grows: group-sequential with O'Brien–Fleming spending.

### 5.5 The ERP side

- **Tables** (search module wall, no DML): `search_experiments` (property; key unique per property; WebDesk tenant, site, collection, item, locale; target; arms; goal; enrolment; the pre-registration; status `draft`, `running`, `stopped`, `aborted` or `decided`; `started_at`, `stopped_at`; at most 10 running per property) and `search_experiment_results` (append-only decision snapshot: counts, p, interval, decision, decided by). One experiment is one item in one locale.
- **Flow:** create (ERP record plus a WebDesk draft through `content.update` carrying the block; the user's editorial grant is required) → the existing review and `content.publish` (HIGH, WS4; R4 allows a publisher's own single item) → `started_at` = the publish execution → results → stop (a draft without the block, or with the winner's override merged into `fields`) → publish → decided.
- **Counts:** `event-data/values?eventName=exp_exposure` (and `exp_convert`) `&propertyName=ev&startAt=<start>` through the existing `umami-client.ts`. Umami returns at most 100 values, hence the cap of 10 running experiments.
- **Authorization:** the existing `search_property` actions, `read` for results and `update` for create, stop, abort and decide, plus WebDesk's content grants and WS4 for every public change. No new action.
- **MCP:** `search.experiments.create`, `list`, `get`, `results`, `stop`, `abort`, `decide`; the writes are `low`, because each public effect goes through a WS4 publish.

## 6. V6: our own sampled session replay

### 6.1 Recording rules (the site)

- rrweb (MIT, exact version pinned at build) is loaded by dynamic import only when: analytics consent **and** a visitor id **and** the tab was sampled at start (`PUBLIC_REPLAY_SAMPLE`, a build value in (0, 1], recommended 0.10; unset, empty or invalid means off) **and** the page is not deny-listed (thank-you, preview, privacy).
- `blockSelector: "form, [data-noreplay]"`: forms are blank boxes, and nothing inside them is recorded, whether sent or abandoned (the funnel stays in Umami). Plus `maskAllInputs: true` and `maskInputFn: () => ""` for any input outside a form (e.g. search), `maskTextSelector: "[data-private]"`, no canvas, fonts, cross-origin iframes or inlined images; the meta `href` reduced to origin + path.
- Stops at once on analytics withdrawal, at 30 minutes, or when the collector answers 403 or `{record:false}`.
- Chunks every 10 s or 64 KB of events, gzipped in the browser (`CompressionStream`): `POST /lib/kestrel/r` `{website, visitorId, consentId, recordingId, seq, chunk}`.

### 6.2 Storage, caps, retention (the collector)

| Item | Value |
|---|---|
| Tables in `vdb` | `replay_sessions(id, website_id, visitor_id, consent_id, started_at, last_chunk_at, chunks, bytes, pages)`, `replay_chunks(session_id, seq, received_at, bytes, data bytea)` |
| Server check per chunk | ≤ 256 KB compressed and ≤ 4 MB inflated (bomb guard); any input event with non-empty text → 422 and the recorder stops; meta `href` rewritten to origin + path |
| Caps | 30 min and 5 MB per recording; 500 new recordings a day per site; `REPLAY_BUDGET_MB` (default 2048) per site, beyond which new recordings get `{record:false}` |
| Switch | `REPLAY_ENABLED` exactly `1` (default off) |
| Retention | 30 days from `started_at`, daily purge; withdrawal and erasure through `forget` |
| Backup | `vdb`'s nightly dump (same age recipient and push as Umami's) excludes the data of `consented_events`, `replay_sessions` and `replay_chunks`, so it holds hashes and aggregates only (O2) |
| Edge | its own erp-edge router for `/lib/kestrel/r`: buffering 320 KB, rate 2/s, burst 5; nginx `client_max_body_size 320k` on that location only |

### 6.3 Viewing in the ERP

The visitor detail lists recordings (date, length, pages) for a holder of `view_replay`. Opening one streams chunks through the BFF, never a link to
`sumopod`. The player is `rrweb-player` (MIT, pinned) on a page whose CSP allows images only from the property's own domains; the replayer runs no
scripts. Every opening writes one activity row (who, which recording, when; no content). No download; export only through the rights-request
export. Only recordings of live profiles are listed; ingest sends `forget` for recordings whose consent id is not verified.

### 6.4 O-5: replace Clarity, or run beside it

| | V6 replaces Clarity | V6 runs beside Clarity |
|---|---|---|
| Site | Clarity leaves `vendors.ts` and the CSP | Both load after analytics consent; Clarity masking set to Strict |
| Banner, Analytics line (draft for counsel) | "…and record a sample of visits on our own server to see how pages are used. What you type is never recorded." | "…Microsoft Clarity (in the USA) and our own recorder may record how you use pages. Typed text is masked." |
| Notice, RoPA | W4 loses Clarity; F4 withdrawn; one recorder in §10 | F4 and its US transfer (R-V4) stay; both recorders named |
| Rights | One recorder, by visitor id | Plus Clarity deletion by Clarity user id |
| V6 build | Identical | Identical |

Recommendation: **replace, once V6 is live and DEV-VERIFIED**: one recorder, recordings stay in our estate, and masking we can test. Until then
Clarity stays only with the recorder wording and Strict masking (addendum §11, item 10).

## 7. Legal and register deltas (L5, for counsel at G2)

1. F7–F9 placement fixed: a 72-hour buffer and 30-day recordings on `sumopod`; profiles in the ERP on `gda-aicenter`. R-V18 narrows accordingly.
2. F6 and LIA A/C: Umami receives a daily-keyed pseudonym, not the IP (once V2-d holds); R-V6 improves.
3. F7: the network name is shown as a network; company identification only after O-12 and counsel's answer to open item 5 (for large organisations the network name already names the employer).
4. F8: forms blocked, nothing typed recorded, 30 days, not backed up; the O-5 wording.
5. F9: with a visitor id, consent; the session-only arm for visitors without consent needs counsel on device storage.
6. §5 rows: buffer 72 h; tombstones (hashed ids) 14 months; bot counts and experiment results are aggregate. §9.1 rows: profile and recordings by visitor id, consent id, or through a lead's consent id (G5).
7. Vendor register: rrweb and rrweb-player (MIT) rows. The DB-IP row (¹¹) already covers the ASN edition.

## 8. Tickets

Seats default to their own model; Opus only where flagged. Nothing runs Docker on the laptop: DB and container tests run on the `sumopod` gate.

| # | Scope (owned paths) | Tier | Model·effort | Depends | Done when (QA-executable) |
|---|---|---|---|---|---|
| V2-a | New component `insights-collector/` (Go, same toolchain as `ai-gateway-go`): `cmd/`, `internal/{ingest,geo,bot,company,store,ops,config}`, `migrations/` (`bot_counts`, `tombstones`), `data/datacenter-asns.txt`, the vendored isbot list and notice, distroless non-root `Dockerfile`, `CLAUDE.md`. §3.2, §3.3, `/healthz`, `/ops/v1/bots` | senior-integrator | sonnet; Opus review | V1 | `go test ./...` green. A hit from `203.0.113.7`: the string is absent from every log line, from the request a fake Umami receives (it gets an `fd…` address and `cf-ipcountry`) and, on the gate, from a `pg_dump` of `vdb`. `identify` and unknown types are dropped; `payload.id` is removed; a UA bot and a listed ASN are not forwarded and are counted; port 8081 ignores `X-Real-IP`; an empty numeric env takes its default and `0` refuses to start |
| V2-b | CI: an `insights-collector` job in `.github/workflows/ci.yml` (vet, test, lint) and a tag-triggered job that builds, cosign-signs and pushes the GHCR image and prints its digest | devops | sonnet | V2-a | green on the branch; a test tag yields an image that `cosign verify` accepts; nothing is built on the laptop or on `gda-aicenter` |
| V2-c | `infra/sumopod/umami/`: compose (`collector`, `vdb`, volume, every env listed under `environment:`), `nginx/edge.conf.template`, `geo-refresh.sh` (ASN Lite, collector restart), `backup.sh` (`vdb`, personal tables' data excluded), `.env.example`; runbook section (preflight, deploy, verify, rollback) | devops | sonnet; Opus review | V2-a, V2-b | on the `sumopod` gate: `docker compose config -q` passes for every profile; the templates render and pass `nginx -t` in the pinned image; `bash -n` passes; only `edge` and the gates touch a non-internal network |
| V2-d | Proof in a throwaway project on `sumopod` (never the live `umami` project): Umami 3.4.0 + its Postgres + collector + `vdb` + edge + the real DB-IP files | qa | sonnet | V2-c | through the edge with a known public test IP: Umami's `session` row has the right country, and `pg_dump` of both databases plus every container log holds the IP 0 times; Umami takes the collector's `cf-*` headers with `SKIP_LOCATION_HEADERS` removed, or the D2 fallback is recorded; a public `cf-ipcountry` does not land; bots dropped and counted; every other path still 404s |
| V2-e | Live deploy on `sumopod` (preflight, services, edge switch, timers, backup) and the Analytics tab checked | **orchestrator** (server) | — | V2-d; live after G2 and O-11 | the runbook's Verify passes; the rollback (edge back to `app:3000`) is rehearsed |
| V3-a | WebDesk `consent.status` (§4.3): `webdesk/api/src/control/consent/*`, `command-types.ts`, the registry spec, tests | senior-be | sonnet; Opus review | — | the spec pins `read`/`webdesk:read`; a grant then an `update` with `analytics:false` returns `analytics:false`; another tenant's or site's ids are omitted; 101 ids → 400; a scopeless caller with a valid body → 403; DB tests on the gate; `webdesk/qa/linux-gate.sh` green |
| V3-b | Collector consented channel, forget, ops reads and forget (§4.4); `consented_events` migration; 72 h purge | senior-integrator | sonnet; Opus review | V2-a | no `consentId` → 400; tombstoned visitor → 410; data keys outside the list are dropped; `/ops/v1/events` never returns a row younger than 15 s and pages by id; `forget` with the read key → 403, with the forget key deletes and returns counts; a 73-hour-old row is purged; a schema test proves no IP or UA column exists |
| V3-c | Routes and keys: `erp-edge/dynamic/erp-insights.yml` (exact paths `/lib/kestrel/v`, `/f`), `nginx/{edge,read}.conf.template`, key hashes in the umami `.env.example`, `infra/compose/docker-compose.vps.yml` + `.env.example` (`INSIGHTS_*`), runbook | devops | sonnet | V3-b | static checks as V2-c; after deploy (orchestrator), from `gda-aicenter`: the read key lists events, the read key on forget → 403, no key → 401, a `DELETE` is refused (403 or 404, never 2xx); publicly, `/ops/v1/events` → 404 |
| V3-d | The §4.5 migration and its DB tests | senior-db | sonnet; Opus review | — | migration lints green; applied as NOBYPASSRLS on the gate; a cross-tenant or module-disabled read returns 0 rows; the unique keys hold; deleting a profile cascades its events; no IP or UA column; the `agency_leads` index exists; the file holds no DML |
| V3-e | Ingest, sweep and purge jobs; `insights-client.ts` (and its line in `egress-inventory.test.ts`); the `consent.status` client; the §4.6 module | senior-be | **opus·high**: consent-gated ingest races the withdrawal sweep across two remote systems; a mistake shows a person who never consented or brings back one who withdrew, and a cheap first pass would be re-run whole | V3-a, V3-b, V3-d | with fakes for both remotes on the gate: a consent id whose latest record is `update analytics:false`, or that is absent, is never ingested and is forgotten; a sweep run while that visitor's pre-withdrawal events are being ingested leaves no profile (lock + tombstone); a repeated batch changes nothing; `SEARCH_VISITORS_ENABLED` empty → no timer; an empty or `0` interval → the default; score parts sum to the score; no rules → no interests; the purge deletes only expired profiles |
| V3-f | Cerbos actions `read_visitors`, `view_replay` (§4.8) | senior-be | sonnet; Opus review | — | policy tests: staff denied both; manager and company_admin allowed in tenant; another tenant denied; the perm arm grants exactly its action; catalog, parity and count tests green; a probe after the restart (orchestrator) |
| V3-g | BFF and MCP (§4.8): the visitors controller, tools, `docs/FRONTEND-BFF-CONTRACT.md` §, the capability inventory (`UPDATE_INVENTORY=1`) | medior | sonnet | V3-e, V3-f | `app.inject`: staff 403 with valid bodies, manager 200; the lead id only for a principal who can read the lead; 403 and 404 distinct; not-configured, disabled and unreachable answer in words; hub tests pass the tools |
| V3-h | Rights requests (G5 extended): `core/agency-privacy*.ts` accept a visitor id or consent id; find, export and erase cover profiles; an email or phone erase follows matched leads' consent ids; erase tombstones and sends `forget mode:"erase"` | senior-be | **opus·medium**: it extends a two-person WS4 privacy flow into a second system, and a missed row is a rights failure | V3-e | erasing by the email of a lead with a linked profile deletes the profile, tombstones both ids and records the forget counts in the ledger; a later ingest of that visitor's buffered events creates nothing; export returns the profile and its events; a grep finds no identifier in approvals, events or logs |
| V3-i | The Visitors tab and the Analytics figure (§4.9) | medior | sonnet (senior-uiux review) | V3-g | vitest and `next build` green; rows keep server order; non-ok states are words; the tab 404s where the toolkit lacks it; driven against a platform-nest test container on the gate, with screenshots of the list, a detail and a lead link |
| V3-j | The site (gaiada-web-revamp): rules I1–I7, the consented client, forget on withdrawal, the visitor id on the privacy page | site session | — | V3-b | site tests: no visitor id without consent and a `consentId`; withdrawal calls `/f` and then clears; a 410 stops minting; `check_tracking` finds no `/lib/kestrel/v` request without analytics consent |
| V3-k | QA, end to end | qa | sonnet | V3-a…j | on `sumopod` test containers: consent → browse → a profile; withdraw → gone within one sweep and the buffer empty; erase by email removes a linked profile; a forged consent id yields nothing. DEV-VERIFIED only for what was observed |
| V5-a | Vocabulary 1.5.0 (§5.1, §5.2): `webdesk/delivery/vocabulary/{blocks,item-fields,client-editable,version}.ts`, the 1.4.0 snapshot, classifier tests, the three vendored copies, `webdesk/blocks`, `openapi-builder.mts`, the publish lock in `content-commands.service.ts`, `search-text.ts` | senior-be | sonnet; Opus review (frozen contract) | — | the classifier computes MINOR; every drift check green; each §5.1 rule has a passing and a failing case; a client editor adding the block → 422; the lock refuses a control change and allows a stop; the envelope and WSK-48a byte gates unchanged; `linux-gate.sh` green |
| V5-b | The stats engine, pure (`search/experiment-stats.ts`) | senior-be | sonnet; Opus review | — | known-answer tests: n = 2,518 for 3.0 % → 4.5 %; Holm ordering; Fisher when an expected cell < 5; SRM fires at p < 0.001; every decision case |
| V5-c | The experiments service (§5.5): migration, routes, tools, the WebDesk draft writer, Umami counts, the horizon gate | senior-be | sonnet; Opus review | V5-a, V5-b | before the horizon `results` carries no rate, difference, interval or p for any principal; a pre-registration UPDATE after start fails; a projected 57-day test → 422; an 11th running experiment is refused; start and stop drafts validate in WebDesk; denials with valid bodies |
| V5-d | The Experiments tab (`website/experiments/**`) | medior | sonnet (senior-uiux review) | V5-c | as V3-i; until the horizon the view shows progress and SRM only |
| V5-e | The site: arms, assignment, events, the preview arm (§5.3) | site session | — | V5-a | the same visitor id gives the same arm across reloads; the session arm is stable in a tab and absent from every request; one exposure per unit; conversion only after exposure; no `exp_*` reaches GA4 or Meta; with `consented`, a visitor without consent sees `a` and sends nothing |
| V5-f | QA | qa | sonnet | V5-a…e | a two-arm test on the proof site through publish; both arms seen and counted in Umami; results withheld until the horizon (seeded counts on the gate) |
| V6-a | Collector replay channel and its routes (§6.2) | senior-integrator | sonnet; Opus review | V3-b | a chunk holding typed input → 422; an inflate bomb refused; caps and the budget answer `{record:false}`; `REPLAY_ENABLED` empty → off; a 31-day-old recording is purged; `forget` removes recordings; the backup holds no replay data |
| V6-b | ERP replay backend: list and stream routes (`view_replay`), the activity row, forgetting unverified recordings | senior-be | sonnet | V6-a, V3-e, V3-f | denial with valid parameters; one activity row per opening, without content; a withdrawn visitor's recording is not listed and is forgotten |
| V6-c | The player page and the recordings list (platform-ui) | senior-fe | sonnet | V6-b | `next build` green; the CSP admits images only from the property's domains; a recorded session replays against the gate stack |
| V6-d | The site recorder (§6.1) | site session | — | V6-a, **O-5** | no recorder without consent and sampling; forms show as blocked; typing into a form and leaving stores no input text |
| V6-e | QA: the masking proof | qa | sonnet | V6-a…d | the stored chunks of a session where a test string was typed into a form, then abandoned, are decoded and searched: 0 hits |
| L5 | `legal/website-visitor-addendum.md` v0.2 (§7 items) and the two register rows | medior | sonnet; Opus review | this design | every §7 item appears; every changed retention value is marked «ASSUMPTION» for counsel; no other section changes |

### 8.1 What can start, what waits, and whose

| Group | Tickets |
|---|---|
| Can start now | V2-a, V2-b, V3-a, V3-d, V3-f, V5-a, V5-b, L5 |
| After their code dependencies | V2-c, V2-d, V3-b, V3-c, V3-e, V3-g, V3-h, V3-i, V5-c, V5-d, V6-a, V6-b, V6-c; QA tickets last |
| Site session | V3-j and V5-e build now; V6-d waits for **O-5** |
| Live gates | V2: G2, O-11, V2-d. V3: G2 (including open item 5), V2 live, G3 (the privacy page shows the visitor id and the profile and network wording). V5: G2 with `enrolment:"consented"`; `all` waits for counsel on F9. V6: G2, O-5, V6-e |
| Waits for O-12 | a resolver for the chosen company source, after the owner's choice and counsel's answer to open item 5 (plus a register row and, for a vendor, its contract) |
| Server and owner work | Orchestrator: every `sumopod` deploy (V2-e, the V3-c and V6-a routes and keys), the `INSIGHTS_*` variables on `gda-aicenter` (through compose `environment:`), the platform-nest and platform-ui releases with their migrations, the WebDesk release (1.5.0 and `consent.status`), the Cerbos restart and probe. Owner: O1–O9 below, G2, O-5, O-11, O-12 |

## 9. Risks and traps

1. **Corporate gateways are not bots.** Zscaler, Netskope and similar egress from datacenter ASNs and carry real B2B visitors; Cloudflare WARP and Apple Private Relay egress from CDN ASNs. The list starts with compute clouds only and is reviewed against the bot counts after go-live.
2. **Commit order:** a bigserial id can commit after a larger one; the 15 s lag on `/ops/v1/events` covers single-row inserts.
3. **Empty env reads as 0:** every numeric variable in the collector and the jobs falls back to its default; switches are on only for exactly `1`.
4. **Compose passthrough:** a variable in `.env` does nothing unless the service's `environment:` lists it (collector and platform-nest).
5. **RLS zero-row:** the migrations hold no DML; search tables are written through `withTenants(…, {modules:['search']})`; agency tables ignore the scope.
6. **`analytics:false` is a withdrawal even under `action:"update"`.**
7. **Validation pre-empting authz:** every denial test sends a valid body.
8. **Cerbos:** the new actions need a restart and a probe; the perm arm copies the kind's condition, because the mirror cannot express attribute gates.
9. **Umami's 100-value limit** on `event-data/values`: at most 10 running experiments per property.
10. **The Analytics numbers drop** when V2 starts dropping datacenter traffic; the tab notes the date.
11. **Backups outlive deletions:** the `vdb` backup holds no personal data by design; an ERP restore must re-apply the tombstones before ingest resumes (a runbook line in V3-e).
12. **Four vocabulary copies:** re-vendor with the scripts; the drift tests are the check.
13. **A new HTTP suite** moves the capability inventory: regenerate it with `UPDATE_INVENTORY=1`.
14. **Sumopod disk** (81 % when measured): the replay budget is a hard cap, and preflight measures first.

## 10. Open questions for the owner (each default holds if unanswered)

| # | Question | Default |
|---|---|---|
| O1 | D66 says the ERP "pushes nothing". May it send the collector one delete-only `forget` command over WireGuard (D6)? | Yes, narrowly: delete-only, its own key, idempotent; recorded as an amendment of D66 |
| O2 | WSK-D32: "nothing on sumopod is the only copy". The 72-hour buffer and the 30-day recordings are deliberately not backed up | Yes: a backup would outlive the retention promise, and their loss stops no company function |
| O3 | O-5: does V6 replace Clarity, or run beside it? | Replace, once V6 is live; until then Clarity only with the recorder wording and Strict masking |
| O4 | O-12: the company-identification source | Network name only, labelled "Network" |
| O5 | Who sees profiles and recordings? | Search managers and company admins, plus anyone granted the permission; not plain search staff |
| O6 | A/B tests for visitors without consent (session-only)? | `consented` only until counsel confirms F9; then chosen per experiment |
| O7 | Agentic-native bar: in v1, no MCP tool returns recording content (metadata only) | Yes, until counsel rules on AI processing of recordings |
| O8 | The score's parts and weights (§4.6) | As listed; the score orders a list and never acts |
| O9 | Experiment limits: 14–56 days, α 0.05, power 0.8, at most 10 running | As listed |

**Flags for the orchestrator (not the owner).** (a) The plan's V5 row says "WebDesk next" for a migration; none is needed (vocabulary 1.5.0
only). V6's "its own" is the collector's `vdb`. (b) G6's "withdrawal deletes the profile" had no mechanism (no profile existed); V3-e and V3-j
build it. `consent.status` also lets P2 re-check a lead's consent id just before an upload, which closes P1 design flag (c); one line for P2's owner.
(c) At V3-k, confirm that gaiada.com's search property (G0) and its web leads (L4) sit in the same company tenant; otherwise no lead link appears.
(d) O1 and O2 belong in §14 once ruled; this document does not edit §14.
