# SEO / site-audit capability — first-class design

**Date:** 2026-08-23 · **Author:** system architect · **Status:** PLANNED (design only — nothing here is built)
**Supersedes:** the SM-71..SM-74 framing of [`2026-08-13-gaia-nexus-harvest.md`](2026-08-13-gaia-nexus-harvest.md) §5 Track B (owner ruling below) and, in part, the "where this belongs" recommendation of [`2026-08-20-wave1-security-triage.md`](2026-08-20-wave1-security-triage.md) §5 (see §8.2 — reversed with reasons, not silently).
**Inputs:** every claim about existing schema/code below was read from this working tree on 2026-08-23 (`platform-nest/migrations/0034,0045,0116,202608201518`, `modules/search/search-audit.ts`, `search.controller.ts`, `scope-presets.ts`, `reports.ts`, `seed/nexus-import.ts`, `modules/monitoring/{index,runner,drivers/*}.ts`, `search-crawl-go/`, `docs/blueprints/{seo-sem-design,monitoring-program}.md`, `docs/FRONTEND-BFF-CONTRACT.md` §14/§20, `docs/blueprints/seo-sem-execution-tracker.md`, `docs/MAP.md`). No client site, helios, delphi, gda-ce01, or Hostinger host was contacted.

---

## 0. The owner ruling, recorded

> "forget about those nexus import. we are independent of that anyway. so we need to build ours
> properly. that one matter." — owner, 2026-08-23

**Interpretation applied throughout this document:** Gaia Nexus is **not a dependency and not a
template**. The harvest plan's Track B (SM-70..74) was framed as *importing and mirroring Nexus's
shape*; that framing is superseded. Nexus's 126 documents remain what they always honestly were —
**evidence of a real workload** (63 properties × technical + SEO analysis, a real security backlog)
— and stop being a specification. SM-70 (the import script, landed as
`platform-nest/src/seed/nexus-import.ts`) stays as an **inert, opt-in tool**; nothing below builds
on it, extends it, or designs around its data shape. Its imported rows keep their
`source='nexus-import'` provenance and are treated as historical prose, not as measurements (§8.4).

### 0.1 A numbering fact that forces a clean break anyway

The harvest plan allocated **SM-71..74** to its Track B tickets. The SEO execution tracker
(`docs/blueprints/seo-sem-execution-tracker.md` §6bq–§6bx) independently allocated **SM-71..75 to
entirely different work that has since landed DEV-VERIFIED** (SM-71/72 = Google-connection resolver
hardening, SM-73 = campaign-applied event handler, SM-74 = report-lifecycle MCP tools, SM-75 = boot-
wiring smoke test). The harvest identifiers are therefore **burnt**: resurrecting "SM-71 report
compiler" would collide with a shipped ticket of the same name. Everything ticketed by this document
starts at **SM-76**, and §8 rules on the *substance* of the four old tickets individually.

---

## 1. What exists today — verified, with the gaps named

### 1.1 Already built and reusable (do not reinvent)

| Asset | Where | State |
|---|---|---|
| `search_properties` (tenant → client → property, `verified_at` crawl-consent gate, `UNIQUE(tenant, client, domain)`) | `0034_module_search.sql` | applied |
| `search_engagements` + `tool_scope` (already carries `audit_technical`/`audit_cwv` toggles with cadences via presets) + budget stop-loss | `0034` + `scope-presets.ts` | applied / DEV-VERIFIED |
| `search_audits` (per property × kind, `source` provenance, `report_hash` idempotent ingest per `0045`) | `0034`, `0045` | applied |
| `search_audit_findings` (code, 5-level severity, category, url_count, sample_urls, per-run rows, regression diff) | `0034` + `search-audit.ts` (SM-08) | DEV-VERIFIED |
| Ingest pipeline: `POST audits` validate → hash → derive → diff → events (`search.audit.completed`, `search.audit.regression`) | `search.controller.ts` ~2255 | DEV-VERIFIED |
| `search-crawl-go`: job-mode crawler with the estate's best SSRF egress guard (allowlist from **verified** properties, DNS→IP re-validation, private-IP denial, JSONL audit, robots RFC 9309, per-host rate cap) | `search-crawl-go/` | DEV-VERIFIED |
| `search_reports` — **`kind` CHECK already includes `'audit'`** — plus SM-22's client-facing renderer with ratified honesty rules (simulated watermarks, empty-is-not-zero, freshness survives into the document) | `0034` + `modules/search/reports.ts` | DEV-VERIFIED |
| `report-renderer` sidecar (Playwright PDF, token + same-origin guard) + the reports module's print-payload path | `report-renderer/`, `modules/reports/` | DEV-VERIFIED |
| Monitoring module (Plane B): driver registry (absent-not-inert, capability contracts), `http`/`keyword`/`heartbeat` drivers behind a TS egress guard with redirect-hop re-validation and the IP-literal fix, runner with pure decisions, 9 FORCE-RLS tables, Cerbos probed live | `modules/monitoring/` | DEV-VERIFIED (runner dark by default) |
| MON-00 cross-root boundary ruling + enforcement design | `2026-08-20-monitoring-gated-rulings.md` | ruled, partially landed |
| `search.audit.run` permission; `resource_search_audit` Cerbos kind | `modules/search/index.ts`, policies | applied |

### 1.2 Where the existing schema is *wrong* for a first-class capability (not bendable)

Stated plainly, because "reuse before inventing" also means saying where reuse would mislead:

1. **A finding has no identity across runs.** `search_audit_findings` rows are per-audit
   observations; the diff inserts a *new* row per code per run and flips the previous run's rows to
   `fixed` when absent. Consequences: (a) "which of my 63 sites still have missing-HSTS?" requires a
   latest-audit-per-property dedup query, and naive `WHERE code AND status='open'` over-counts across
   generations; (b) triage is not sticky — `diffAudits` turns a re-detected **`ignored`** finding
   into `regressed`, so "we know, stop nagging" does not survive the next run; (c) there is nothing
   stable to hang an assignee, a PM task, or an accepted-risk expiry on. This is the single biggest
   structural gap. Fix: a **finding-state** entity (§2.3), not a semantic rewrite of the populated
   observations table.
2. **Absence of findings is indistinguishable from absence of checking.** An audit row with zero
   findings for a class could mean "checked, clean" or "that collector never ran". Nothing records
   which checks executed. This violates the estate's empty-list-is-a-claim rule and is exactly the
   bug class that has shipped wrong 8+ times here. Fix: per-run **check coverage** rows (§2.3) —
   the honesty spine of the whole design.
3. **`fixed` is claimable without measurement.** `AUDIT_TRIAGE_STATUSES` lets a human set `fixed`
   directly; the same word also means "measured absent by the next run". A claim and a measurement
   must not share a value. Fix: `fixed_claimed` vs `fixed_verified` in the state machine (§5.2),
   and `fixed_verified` only when the *check demonstrably ran* in the verifying audit.
4. **`computeScore` lies under partial coverage.** 100-minus-deductions over whatever findings
   exist scores an audit that executed one check as a perfect 100. Fix: score is only meaningful
   paired with coverage, and is withheld below a floor (§7).
5. **`kind` and `source` CHECKs are closed enums** — acceptable, but `security` and `performance-
   field` sources/kinds must be added deliberately by constraint surgery (the CONKEY-matching idiom
   `202608201518` already established), never by bending `technical` to mean everything.
6. **No per-property fact base.** CMS, hosting, "is this WordPress", "were salts rotated" have
   nowhere to live with provenance. The harvest's SM-74 gestured at columns on `search_properties`;
   flat columns cannot carry *who asserted this and when*, which for attested security facts is the
   entire point. Fix: `search_property_facts` (§2.3).

### 1.3 What `search-crawl-go` actually detects today — honest inventory

Read from `internal/crawler/crawler.go`, not assumed. Per page it records: **URL, HTTP status,
`<title>` text, skip reason (robots / off-host / max-pages), fetch error**. That is all. It does
**not** capture: response headers (so no HSTS/security-header signal), TLS/cert facts, redirect
chains (a redirect is followed by the client silently), meta description / canonical / robots meta /
h1 / hreflang, mixed-content, structured data, page weight or timing, DNS, or any WordPress
fingerprint. Its default cap is 25 pages, 5 MiB/page. The README is explicit that the *egress guard*
was the deliverable and the crawler is a minimal proof vehicle. So today the crawler can support
exactly the finding set SM-08 derives: fetch errors, robots blocks, truncation, 5xx/4xx/404, missing
title. **An audit capability needs a deliberate capture upgrade (§3.2), not a claim that the crawler
already "does audits".**

---

## 2. Domain model

### 2.1 Vocabulary (binding for code, docs, and UI copy)

| Term | Meaning | Table |
|---|---|---|
| **Property** | A client web property under management; the consent anchor (`verified_at`) and the egress-allowlist source | `search_properties` (exists) |
| **Engagement** | The commercial container: tool scope, cadence, budget, KPI targets | `search_engagements` (exists) |
| **Audit run** | One point-in-time evaluation of one property for one `kind`, by one `source`. Immutable once `completed` | `search_audits` (exists, widened) |
| **Audit group** | The set of runs produced by one "run audit" action across kinds — the unit a report renders | `search_audits.group_id` (new column) |
| **Check** | A catalogued, keyed question with a defined detection method (e.g. `security.hsts`) | catalog-as-data (§4.1) |
| **Check result** | Per run × check: `passed / failed / error / not_run / unsupported`, with evidence | `search_audit_checks` (new) |
| **Finding observation** | A failed check's per-run detail rows (existing shape: code, urls, message) | `search_audit_findings` (exists, kept as the immutable per-run log) |
| **Finding state** | THE trackable entity: one row per (property, check, scope), carrying status, assignee, stickiness, verification | `search_finding_states` (new) |
| **Property fact** | A provenance-stamped statement about the property (CMS, host, "salts rotated 2026-09-01 by X") | `search_property_facts` (new) |

### 2.2 Reuse decisions

- **Audit runs stay `search_audits`.** Idempotent ingest (`report_hash`), source provenance,
  RLS, events, and the SM-70 rows all live there already. Widen, don't replace.
- **Observations stay `search_audit_findings`** and become insert-only per run (the diff pass stops
  mutating prior-run rows once states exist — SM-77). History stops being retroactively edited.
- **Reports stay `search_reports`** (`kind='audit'` already in its CHECK) rendered by the SM-22
  pipeline + `report-renderer` PDF. **No parallel report system** (this kills the Nexus-shaped
  compiler — §8.1).
- **Scheduling stays `tool_scope`** (`audit_technical` / `audit_cwv` cadences exist; new keys
  `audit_security`, `audit_performance` follow the same shape) consulted by the existing search
  pull-scheduler pattern. Audits are $0 collectors, but the scope toggle is still the per-client
  authorization surface and cadence source.
- **Probing authority model mirrors monitoring:** a verified property + an enabled scope toggle,
  written by a human holding `search.audit.run` / `search.engagement.set_scope`, **is** the standing
  authorization to *probe on schedule*. It is never authorization to *change* the client's site —
  remediation execution stays behind the triage doc's owner Decisions A–E (§10).

### 2.3 New tables (DDL sketch — refined at SM-76; conventions byte-for-byte from `0034`/`0116`: `tenant_id` + `client_id NOT NULL`, `origin_site`, FORCE-RLS loop with the `'search'` third-wall predicate, no in-migration GRANTs)

```sql
-- (A) Per-run check coverage — the honesty spine. A check with no row here DID NOT RUN
-- and must render as "not checked", never as passed.
CREATE TABLE search_audit_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  audit_id uuid NOT NULL REFERENCES search_audits(id),
  check_key text NOT NULL,          -- catalog key, e.g. 'security.hsts'
  outcome text NOT NULL CHECK (outcome IN ('passed','failed','error','not_run','unsupported')),
      -- unsupported = not applicable to this property (e.g. wp.* on a non-WordPress site):
      -- an HONEST skip. not_run = applicable but not executed (collector down/refused): a GAP.
      -- error = the check itself failed to evaluate. The three must never collapse into one.
  evidence jsonb NOT NULL DEFAULT '{}',  -- measured facts (header value, cert notAfter…). NOT public-safe.
  source text NOT NULL,             -- 'crawler' | 'monitor-probe' | 'psi' | 'attestation'
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (audit_id, check_key)
);

-- (B) Finding state — one row per live problem per property. The dedup key IS the
-- portfolio query: "which properties still have X" = one indexed SELECT.
CREATE TABLE search_finding_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  check_key text NOT NULL,
  scope_key text NOT NULL DEFAULT '',   -- '' = property-level; else a stable URL-group discriminator
  status text NOT NULL DEFAULT 'open' CHECK (status IN
    ('open','in_remediation','fixed_claimed','fixed_verified','accepted_risk','false_positive','regressed')),
  severity text NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
      -- seeded from the catalog default; a human override is recorded via triage fields below
  first_seen_audit_id uuid NOT NULL REFERENCES search_audits(id),
  last_seen_audit_id  uuid NOT NULL REFERENCES search_audits(id),
  first_seen_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  verified_absent_audit_id uuid REFERENCES search_audits(id),  -- the run that MEASURED it gone
  assignee_id uuid REFERENCES users(id),
  remediation_task_id uuid,             -- PM linkage; exact FK target verified at SM-87, not assumed here
  triage_note text,
  triaged_by uuid REFERENCES users(id),
  triaged_at timestamptz,
  accepted_until timestamptz,           -- accepted_risk expiry; NULL = indefinite (UI must flag it)
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, property_id, check_key, scope_key)
);
CREATE INDEX ix_search_finding_states_portfolio
  ON search_finding_states (tenant_id, check_key, status);
CREATE INDEX ix_search_finding_states_property
  ON search_finding_states (tenant_id, property_id, status);

-- (C) Property facts — provenance-stamped statements. Append-only chain: the current value
-- is the row with superseded_at IS NULL (partial unique index — NULLs defeat plain UNIQUE).
CREATE TABLE search_property_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  key text NOT NULL,                    -- 'cms', 'hosting.provider', 'wp.table_prefix_customized',
                                        -- 'wp.salts_rotated_at', 'wp.salts_unique_confirmed', …
  value jsonb NOT NULL,
  source text NOT NULL CHECK (source IN ('detected','attested','imported')),
  audit_id uuid REFERENCES search_audits(id),   -- set when detected
  recorded_by uuid REFERENCES users(id),        -- REQUIRED (app-enforced) when attested
  observed_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_search_property_facts_current
  ON search_property_facts (tenant_id, property_id, key) WHERE superseded_at IS NULL;
```

Widenings on `search_audits` (same migration): `group_id uuid` (nullable — one "run audit" action
stamps all its kind-runs); `kind` CHECK gains `'security'` (constraint surgery by CONKEY match, the
`202608201518` idiom); `source` CHECK gains `'psi'`. `search_audit_findings` gains nullable
`state_id uuid REFERENCES search_finding_states(id)` linking each observation to its state row.

**Hard rule carried from `0116`:** neither `evidence`, `search_audit_findings.sample_urls`, nor any
finding/check field may ever hold secret material **or derivatives of secret material** — no salt
values, no salt fingerprints/hashes (§4.3), no tokens. `search.audit.read`-class grants are broad.

---

## 3. Where findings come from — source matrix and the monitoring boundary

### 3.1 The source matrix (what we generate vs. borrow vs. defer)

| Signal | v1 source | Vendor? | Notes |
|---|---|---|---|
| Crawlability, HTTP status, broken **internal** links, titles | `search-crawl-go` (today) | no | already ingesting |
| Security headers (HSTS, CSP, X-Frame-Options, Referrer-Policy…), redirect chain, mixed content, meta/canonical/robots-meta/h1, JSON-LD presence, WP passive fingerprints | `search-crawl-go` **capture v2** (§3.2) | no | SM-78 |
| TLS cert state (expiry, chain), DNS posture | **monitoring drivers** (MON-15 `tls`/`dns`), invoked one-shot (§3.3) | no | shared code, never duplicated |
| Page performance / CWV | **PageSpeed Insights API** (field CrUX + lab Lighthouse) | free API key | §3.4; self-hosted Lighthouse container is the fallback if PSI quota/ToS bites |
| WordPress server-side config (salts, table prefix, WP_DEBUG *setting*) | **attestation** via `search_property_facts` | no | not crawlable; never pretend otherwise (§3.5) |
| Structured-data *validation depth*, backlink-informed audits, log-file analysis, keyword/content gap | deferred | would be paid/heavy | out of v1; listed so absence is a decision, not an oversight |
| Broken **external** links | deferred, owner-gated | no | §3.6 — collides with the per-job allowlist egress doctrine |

### 3.2 Crawler capture v2 (SM-78) — the one real upgrade our own tool needs

Additive Report-shape v2 (the ingest validator accepts v1 and v2; v1 hashing unchanged so existing
`report_hash` dedupe keys stay stable): per page add `finalUrl` + `redirectChain[]`, a **selected**
response-header subset (allowlisted header names only — never cookies), `metaDescription?`,
`canonical?`, `robotsMeta?`, `h1Count`, `mixedContent[]` (http:// subresource refs found in HTML),
`jsonLdTypes[]`, and a top-level `siteFacts` block (generator meta / `wp-content` path presence ⇒
CMS detection; reachability of `/wp-content/debug.log` and debug-output body signatures — all
same-host fetches inside the existing guard + robots + rate cap). Redirects are already re-validated
per hop by the guard doctrine; v2 must surface the chain rather than swallow it. MaxPages and the
5 MiB cap stand. **No new egress capability is granted by this ticket** — same allowlist, same
verified-property gate, same audit sink.

### 3.3 The monitoring boundary — ruled

**Monitoring is continuous and alerting; an audit is point-in-time and advisory.** Concretely:

| Question | Home |
|---|---|
| "Is it up / did content change / did the cert expire *now*?" → wake someone | monitoring (`monitors` → `monitor_results` → `monitor_incidents`) |
| "What is the posture of this property *today*, what should we fix, is it fixed yet?" | audit (`search_audits` → checks → finding states) |
| "Keep it fixed" after remediation | monitoring — a finding closed by the audit can *recommend* a guard assertion (§5.3) |

**Where they share a probe, they share the code — the monitoring driver registry is the shared
probe library.** MON-15 owns the `tls` and `dns` drivers (PLANNED, tracked in
`docs/plans/monitoring-tracker.md`); the audit collector calls the *same* drivers one-shot with the
property's allowlist, through the same TS egress guard. To make that useful, `ProbeResult` gains an
optional `facts?: Record<string, unknown>` field (additive; carries e.g. cert `notAfter`, resolved
records, captured header subset) — monitoring's detail views benefit too. **The audit module builds
no prober of its own for tls/dns/headers, and monitoring grows no findings/triage tables.** If
MON-15 has not landed when the audit needs it, the audit ticket lands those drivers *in monitoring's
tree with monitoring's owner*, never a fork (SM-80 coordination note). The Go crawler keeps HTML/
page-level capture (it is already on-site crawling); the TS drivers own connection-level probes —
one probe implementation per protocol across the estate.

Also honored: MON-06/K2's defacement-signature idea stays a *monitoring* concern (continuous body
assertions). The audit's debug-signature scan is a point-in-time check that shares the signature
*list* (config), not the runtime.

### 3.4 Performance: PSI first, honestly labeled

PageSpeed Insights API gives CrUX **field** data (the thing that actually reflects users) plus a
Lighthouse **lab** run, free with an API key, no Chromium container of ours. For ~63 properties on
monthly/weekly cadences this is far inside quota. Rows are stamped `source='psi'`; field vs lab is
recorded per check; **a property absent from CrUX renders "no field data" (an honest state), never
a fabricated score** — this is precisely the check Nexus faked with a hash function, so it carries
the strictest honesty bar. Self-hosting Lighthouse (own job container, mirroring `search-crawl-go`'s
job shape — deliberately *not* extending `report-renderer`, whose README pins its scope) is the
documented fallback, not built in v1. This discharges the substance of the harvest's MON-02.

### 3.5 What we cannot measure — attestation, never simulation

WP salts, table prefix, and the `WP_DEBUG` *setting* live server-side. The audit system represents
them as checks whose `source='attestation'`: outcome comes from a current `search_property_facts`
row recorded by a named human (`search.property.attest`); with no fact on file the check outcome is
**`not_run` and renders "not verified"** — it must never default to passed *or* failed. No secret
material or fingerprints of secrets are ever stored (§2.3); the ERP records conclusions ("salts
rotated on D by U", "prefix customized: true"), not evidence containing secrets.

### 3.6 Deliberately out of v1 (so absence is a ruling, not a gap)

External-link checking dials arbitrary third-party hosts, which breaks the per-job-allowlist egress
doctrine that is this module's proudest control. If wanted later, it returns as a designed, bounded
mode (HEAD-only, public-IP-only, global rate cap, its own owner sign-off) — owner question Q4.
Backlink-driven audit checks, SERP-based checks, and log-file analysis are deferred with the same
logic: each is a real capability with a real cost/consent shape, to be designed when pulled.

---

## 4. Findings taxonomy and severity

### 4.1 The check catalog is data, not code

Mirroring the monitoring driver-registry lesson: adding a check must be catalog data + (at most) a
parser, never a schema change. The catalog (seeded by migration, maintained as data) defines per
`check_key`: **category** (`security · crawlability · content · links · performance · dns-tls ·
wordpress · structured-data`), **default severity**, **scope** (`property` | `url-group`),
**detection source(s)**, **applicability predicate** (e.g. `wp.*` requires fact `cms=wordpress` —
otherwise the run records `unsupported`), **freshness TTL** (staleness threshold per §7), and a
**remediation guidance template**. Registration pin: a test asserts the seeded catalog by key, and
an adapter emitting an uncatalogued `check_key` is a loud error — an unknown check silently stored
would be an unauditable claim.

### 4.2 Severity

Keep the existing 5 levels (schema already enforces them). Severity ranks **attacker capability /
user harm**, not SEO-tool convention — the triage doc's §2 ranking is adopted as the calibration
precedent. Catalog defaults are overridable per finding-state by triage (recorded, attributed).
Security-category findings at `critical`/`high` emit a distinct event (§5.4) so they can route to
security triage rather than sitting in an SEO queue — the exact failure mode of June–August.

### 4.3 The Wave-1 four, as acceptance cases (the model must represent these well)

| Nexus Wave-1 finding | check_key | Detection | Scope | Default severity (per triage §2) |
|---|---|---|---|---|
| Missing HSTS | `security.hsts` | crawler v2 header capture (measured) | property | medium |
| Debug flags exposed | `security.wp_debug_exposed` | crawler v2: reachable debug output / `debug.log` (measured); the *setting* alone is a separate attested check | property | high |
| Default `wp_` prefix | `security.wp_table_prefix` | attested fact | property | low |
| Shared WP auth salts | `security.wp_salts` | attested: `wp.salts_rotated_at` / `wp.salts_unique_confirmed` facts | property | **critical while the cross-site question is open** (triage §2.3 asymmetry ruling), demoted on Decision-B disconfirmation |

The cross-site salt correlation is concluded **off-ERP** (triage Decision B — a human with
`gaia-nexus` history access) and recorded as an attested fact; the ERP never holds salt values or
their hashes. And the portfolio question this document was asked to make answerable —

> "which of my 63 sites still have this?"

— is, by construction, `GET …/finding-states?checkKey=security.hsts&status=open,regressed`: one
indexed select over the dedup key, per tenant, with per-client rollup. No latest-audit dance.

### 4.4 Comparability between properties

Because states are keyed by catalog check, cross-property comparison is exact (same check, same
semantics). The per-audit `score` remains a per-run at-a-glance signal but is **only** comparable
alongside coverage (§7); the portfolio compliance view compares *states and coverage*, never bare
scores.

---

## 5. Lifecycle

### 5.1 Run

`POST …/properties/:id/audit-runs {kinds?: [...]}` (SM-82) — gated on `search.audit.run`, property
`verified_at` set, and the engagement scope toggle for each kind. Mints a `group_id`, dispatches the
collectors (crawl job, one-shot probes, PSI), ingests each collector's report through the existing
idempotent path (per-kind rows share the group). Scheduled runs ride the `tool_scope` cadence the
same way rank pulls do. Audit rows are immutable once `completed`; a re-run is a new group —
**versioned runs by construction**, and two runs of one property are comparable because checks are
keyed and coverage is recorded.

### 5.2 Finding-state machine (SM-77 — the semantic core)

System transitions (the state-maintenance pass, same transaction as ingest):
- check `failed`, no state row → create `open` (first_seen = this audit).
- check `failed`, state exists → bump `last_seen`; `fixed_claimed`/`fixed_verified` →
  **`regressed`** (+ event); `accepted_risk`/`false_positive` → **sticky** (bump last_seen only;
  auto-reopen when `accepted_until` passes).
- check **`passed` in a run where it demonstrably executed** → `open`/`in_remediation`/
  `regressed`/`fixed_claimed` → **`fixed_verified`** (stamp `verified_absent_audit_id`).
  **A check that was `not_run`/`unsupported`/`error` closes nothing** — this is the honesty fix
  over SM-08's absence-means-fixed diff, and the reason `search_audit_checks` exists.

Human transitions (Cerbos-gated): `open → in_remediation` (assign, optional PM task link);
`in_remediation → fixed_claimed` (a **claim**, rendered as one until the next run verifies);
`open → accepted_risk` / `false_positive` (sensitive — the concealing direction, §6). Manual
`fixed` ceases to exist as a triage target.

### 5.3 Remediate → verify → keep fixed

Remediation of client sites is executed by humans under the triage doc's runbook (§3 there) and
owner Decisions A–E — **nothing in this module touches a client system**. After a state reaches
`fixed_verified`, the UI offers "guard this fix": a *proposal* to create the matching monitoring
assertion (e.g. an HSTS header assertion on the property's `keyword`/`http` monitor) which a human
holding monitoring's write grants accepts — audit recommends, monitoring guards, a later regression
becomes a real *incident* (now genuinely incident-shaped: a required response to a change, not a
backlog).

### 5.4 Report

An audit report = a `search_reports` row (`kind='audit'`) assembled from a group's runs + current
finding states + coverage, rendered through SM-22's renderer (whose honesty rules — empty-is-not-
zero, freshness inline, simulated watermarks — apply verbatim) and PDF'd via the existing
`report-renderer` path. The portfolio compliance report (per client or per tenant: states × checks
matrix with coverage) is a second render input into the same pipeline. **No cooldown gate** — the
Nexus 24 h cooldown was a cost/abuse control for a $-per-run system; our runs are $0-collector +
budget-gated where paid, and renderer load is bounded by the existing queue. Report lifecycle
(draft → in_review → approved → delivered) is already on `search_reports`.

### 5.5 Events

Existing: `search.audit.completed`, `search.audit.regression`. New: `search.finding.regressed`,
`search.finding.security_opened` (critical/high security category only — the security-triage router).
Both registered in the consumer-loop stream list **in the same change** (the
`N8N_BRIDGE_ENTITY_TYPES` lesson), with a registration pin test.

---

## 6. Multi-tenancy and authorization

- **Tables:** all three new tables carry `tenant_id` + `client_id NOT NULL` (monitoring's
  convention — the portal and billing hang off client) and join the `0034` FORCE-RLS loop with the
  byte-identical `'search'` third-wall predicate. No new RLS exemptions; `search_data_cache` remains
  the single ratified one and this module never touches it.
- **Module:** this stays inside `search` (module key unchanged) — audits are the SEO department's
  product surface; monitoring/webdev consume states read-side via their own contracts. Cross-module
  reads happen over HTTP/events per estate doctrine, not shared tables.
- **Cerbos:** reuse `resource_search_audit` for runs/reads. New actions with catalog rows, bundles,
  groups, and the parity suites in the **same change-set** (the 0117/0117-completion lesson: the
  failure mode is boot, and half-seeded catalogs sat green in CI for four releases):
  `search.finding.triage` (assign / in_remediation / fixed_claimed), `search.finding.accept_risk`
  (**sensitive** — it conceals a live problem, mirroring monitoring's `maintenance.create`
  reasoning; `false_positive` rides the same grant), `search.property.attest` (**sensitive** — an
  attested fact can flip a security check to passed; it is an accountability record and requires
  `recorded_by`). Cerbos does not hot-reload — restart + live probe is part of the AC.
- **Cross-root:** the portfolio views are the same shape MON-00 exists for. All list/rollup
  endpoints are single-tenant `withTenants([tenantId])`; the MON-00 walls (root anchor, GUC assert,
  `inRoot`) apply unchanged; the cross-root canary test extends to the two new list endpoints.
- **Client portal:** deliberately **not** in this wave. Clients receive audits as delivered
  reports (§5.4) first; a live portal read surface is Phase D behind the client-side separate-
  interface program and its own field allowlist (evidence/detail fields are staff-only — they can
  quote compromise signatures, the `monitor_results.detail` precedent).
- **Agentic-native bar:** read-only MCP tools with real `pathTemplate`s (`search.listFindingStates`,
  `search.auditCoverage`) land with the endpoints; write actions (triage, attest) go through ASST-23
  proposals + D14 — no agent may accept risk or attest a fact directly.

---

## 7. Honesty requirements (binding contract notes — these have shipped wrong 8+ times)

1. **An unmeasured check never renders as passed.** UI/report render exactly five outcomes; absence
   of a `search_audit_checks` row renders "not checked". A kind with no run renders "never audited".
2. **An empty findings list is a claim.** Every "0 findings" surface must state its denominator:
   "0 findings · 41 checks passed · 3 not run · 2 not applicable". The summary JSON carries the
   coverage counts; the BFF contract rows will mark this REQUIRED, not decorative.
3. **Score is paired or absent.** `score` is computed over *executed* checks only and is served/
   rendered only alongside `checksExecuted/checksApplicable`; below a coverage floor (catalog
   constant, e.g. <50 %) the API serves `score: null` and the UI shows "—", exactly like the
   monitoring board's deliberate `uptime —` (MON-12d precedent: null ≠ 0).
4. **Stale is visible.** Every read carries `completedAt` + catalog `staleAfterDays`; the UI badges
   stale runs; a *report* renders "as of <date>" inline in the document body (SM-22 rule 1: a
   caveat can never be appended after delivery). The June-era imported findings are the cautionary
   tale: 2.5 months stale and rendered nowhere.
5. **Claims are labeled claims.** `fixed_claimed` renders "reported fixed — awaiting verification";
   attestation-sourced outcomes render "attested by <name>, <date>", never bare green.
6. **Provenance survives aggregation.** Portfolio rollups carry per-source counts (measured vs
   attested vs not-run) — never blended, the SM-30/SM-16 `provenance` precedent.
7. **`GET` surfaces 404 when the module is off** — never a zeroed summary (contract §20 note 1
   applies verbatim to the audit endpoints).

---

## 8. Rulings

### 8.1 The four legacy harvest tickets

| Old id (burnt, §0.1) | Substance | Ruling |
|---|---|---|
| SM-71 report compiler | portfolio/versioned audit reports, MD+PDF, cooldown | **Reframed, mostly survives** — as §5.4: `search_reports kind='audit'` + SM-22 renderer + `report-renderer`. The Nexus-shaped parts are **dropped**: no separate run-versioning system (groups already version), no 24 h cooldown, no "only-latest-downloadable" rule (delivered reports are immutable deliverables here). Re-ticketed **SM-85**. |
| SM-72 content gate loop | draft→vet→revise loop for `ai-drafts.ts` | **Dropped from this program.** Orthogonal to audits (content production, not site evaluation). If wanted, it re-enters through the content/AI program on its own merits with a fresh number — not preserved here out of momentum. |
| SM-73 wave/engagement model | encode Nexus's Wave 0–3 as engagement phases | **Dropped.** Nexus-shaped delivery narrative. Our engagements already carry scope presets, cadences, budgets, KPI targets, and an optional `project_id` — delivery phasing belongs to PM if ever needed. The one useful residue (earners-vs-portfolio effort split) is already expressible as per-engagement cadence/budget tiers and needs no schema. |
| SM-74 hosting topology on `search_properties` | host/panel/stack columns seeded from the Nexus directory | **Reframed, survives on its own merits** — as `search_property_facts` (§2.3): typed facts *with provenance* rather than flat columns, populated by detection (crawler v2) and attestation, optionally back-seeded from import **stamped `source='imported'`** so a Nexus-era claim can never masquerade as a current measurement. Re-ticketed inside **SM-76/SM-86**. Monitoring's target inventory keeps reading `search_properties` (verified rows) exactly as today; facts add context, not a second registry. |

### 8.2 The Wave-1 security backlog — where it lives (re-examined as instructed)

The 2026-08-20 triage recommended modeling the Wave-1 classes as `monitors.kind` entries whose
failures open `monitor_incidents`. **That recommendation is superseded in part, with reasons:** it
was made when no real audit system existed and monitoring was the only honest home. With finding
states designed, the shapes separate cleanly:

- **Detection + tracking-to-closure → this audit system.** Wave-1 items are point-in-time posture
  facts needing triage, assignment, accepted-risk, and measured verification — exactly the
  finding-state lifecycle. Forcing them into incidents would mean ~63×4 perpetually-open incident
  rows, defeating the one-open-incident-per-monitor anti-fatigue constraint and burying real
  outages; an incident is *"respond now"*, not *"backlog since June"*.
- **Post-remediation regression guarding → monitoring**, via the "guard this fix" recommendation
  (§5.3). There a regression genuinely is incident-shaped.
- **Unchanged from the triage doc:** the severity calibration (§2 there, adopted in §4.3 here), the
  remediation runbook (§3), the owner Decisions A–E (§4 — all still open, restated in §10), and the
  boundary findings (not `modules/it`, not a bespoke module, WebDev owns future *prevention* at
  webdesk-P6 — `provisioning.service.ts` still refuses WordPress stacks today, so prevention has no
  hook yet and detection is what ships).
- The four classes become the **acceptance test** of Phase 1: the system must represent them,
  answer the portfolio question about them, and refuse to claim them fixed without measurement or
  attestation.

### 8.3 SM-70 (the import)

Stays landed and inert, per the owner ruling. Not extended, not a data-model precedent. Its rows
remain queryable history (`source='nexus-import'`).

### 8.4 No retro-synthesis of states from imported prose

The 126 imported documents get **no** finding-state or check-coverage backfill — that would mint
per-check claims the source (analyst Markdown) never made at that granularity, and would render
June's world as today's. The first v2 runs establish the baseline by *measuring*; import history
remains advisory context (and RAG corpus), visibly dated.

---

## 9. Phasing and tickets

Numbering continues from SM-75 (§0.1). Tiers per the agent-army standard; **model = seat default
unless flagged** (flag only where cheap-then-escalate would waste a full re-run). ⚡ = touches a
contract (schema/API/policy) → QA gate + architect design-review on the diff. Status of every row:
PLANNED.

**Phase 1 — the honest core (useful alone: Wave-1 measured detection across the portfolio):**

| # | Ticket | Tier | Model | Deps | Done when (AC) |
|---|---|---|---|---|---|
| SM-76 ⚡ | **Schema + IAM wave**: tables A/B/C (§2.3) with client_id + third-wall FORCE-RLS; `search_audits.group_id`; `kind`+`'security'`, `source`+`'psi'` constraint surgery (CONKEY idiom); `search_audit_findings.state_id`; catalog seed table + Wave-1 & crawler-v1 check rows; Cerbos actions/catalog/bundles/groups for `finding.triage`, `finding.accept_risk` (sensitive), `property.attest` (sensitive) + parity suites | senior-db | **opus·medium** — RLS on a populated table-set + constraint surgery + a sensitive-permission seed; a silent RLS or catalog-drift mistake is the 0117 failure mode again | — | Migrations apply on fresh + existing DB; RLS suite: right tenant+scope → rows, no scope → zero, cross-tenant → zero; partial-unique on facts proven (two current rows for one key impossible); Cerbos restarted + new decisions probed live; catalog/policy parity suites green with **zero skips** |
| SM-77 ⚡ | **Coverage-honest ingest v2 + finding-state machine**: adapters emit check results (5 outcomes incl. `unsupported` via applicability predicates); state-maintenance pass per §5.2 (sticky triage, `fixed_verified` only on executed-check absence, regression events); observations become insert-only; triage endpoints move to states (old `PATCH findings/:id` deprecated, kept answering with a pointer); score paired with coverage, null below floor; new events + consumer-loop registration pin | senior-be | **opus·medium** — a cross-run state machine where a wrong transition *silently* fabricates "fixed" or erases triage; this is the capability's semantic core | SM-76 | Fixture sequence proves: not-run check closes nothing; sticky `accepted_risk` survives re-detection and auto-reopens on expiry; `fixed_claimed` verifies only via an executed passing check; portfolio query returns exact property sets; both events land in the bell; mutation probe: removing the executed-check guard turns the suite red |
| SM-78 | **Crawler capture v2** (Go): header-subset allowlist, redirect chain, meta/canonical/robots-meta/h1, mixed content, JSON-LD types, WP passive fingerprints + debug-output/`debug.log` reachability, `siteFacts`; Report v2 additive; v1 hashing untouched | medior | default | — (parallel) | v2 report parses under the extended validator, v1 fixtures still ingest byte-identically (hash regression test); adversarial suite proves no new egress: off-allowlist and private-IP still refused with audit lines; header capture never includes cookies/auth headers |
| SM-79 | **Security + WP check pack**: adapter mapping v2 capture → catalog checks (incl. all §4.3 Wave-1 representations); detected facts written to `search_property_facts` (`source='detected'`); attestation-sourced checks resolve from current facts, else `not_run` | medior | default | SM-76,77,78 | Wave-1 fixtures produce the §4.3 table exactly; a non-WP fixture yields `unsupported` for `wp.*`; no secret material anywhere (string-scan assertion); "0 findings" responses carry full coverage counts |
| SM-82 | **Run orchestration**: `POST audit-runs` (group mint, scope+verified gates), scheduled runs via `tool_scope` cadences (new `audit_security` key in presets), staleness metadata (`staleAfterDays`) on all reads | medior | default | SM-76,77 | One click yields a group of kind-runs; disabled scope toggle refuses naming the toggle; unverified property refuses; re-run of unchanged site is idempotent per kind; every read carries completedAt + staleness |

**Phase 2 — shared probes, performance, and the surfaces:**

| # | Ticket | Tier | Model | Deps | Done when |
|---|---|---|---|---|---|
| SM-80 ⚡ | **Shared-probe seam**: `ProbeResult.facts` (additive) on the monitoring driver contract; one-shot evaluation entry; audit collectors for tls/dns/header checks calling monitoring's drivers with the property allowlist. **Coordination:** if MON-15 (`tls`/`dns` drivers) is unlanded, this ticket lands them in `modules/monitoring/drivers/` under monitoring's rules (registry pin, egress guard, capability contracts) — one implementation, never a fork | senior-be | default | SM-76,77; coordinates MON-15 | Registry pin updated; same driver code serves a scheduled monitor and a one-shot audit call (test proves single implementation); `facts` absent ⇒ checks record `not_run`, never pass; design-review on the monitoring contract diff |
| SM-81 | **PSI performance collector**: PSI client (key via env, boot-refusal if live-mode+keyless per the estate's boot-guard doctrine), field+lab per property → `kind='cwv'` runs with per-check field/lab provenance; CrUX-absent = explicit no-field-data outcome | medior | default | SM-76,77 + owner Q1 (key) | Mocked-PSI suite: scores land with provenance; missing CrUX renders honest absence; quota/429 backs off and records `error` outcomes (never fabricates); ledger untouched ($0 path) |
| SM-83 ⚡ | **Portfolio + state read surface** (BE): finding-state list/filter, per-check portfolio rollup, per-client compliance rollup, coverage summaries; contract §14 rows; read-only MCP tools with real pathTemplates | medior | default | SM-76,77 | The §4.3 portfolio question answers in one call; rollups carry per-source provenance counts; cross-root canary extends to both new lists; module-off ⇒ 404 not zeros; MCP tools callable through the hub |
| SM-84 | **UI — Site Audit v2**: run detail with coverage strip (5 outcomes, "not checked" ≠ green), finding-state board with sticky-triage affordances (accept-risk requires expiry-or-explicit-indefinite + note), portfolio compliance view, staleness badges, claim-vs-verified rendering | senior-fe | default | SM-83 | Driven in a browser against a live backend: every §7 rule visibly holds; an empty state renders its denominator; DEMO_MODE fixtures cover all five outcomes + stale + claimed |
| SM-89 | **Events → notifications wiring** for the two new event types (hrefs into the audit surfaces) + n8n bridge exposure | junior | default | SM-77 | Each event produces a bell item deep-linking to the finding state; registration pin test green |

**Phase 3 — reporting, attestation, closure loop:**

| # | Ticket | Tier | Model | Deps | Done when |
|---|---|---|---|---|---|
| SM-85 | **Audit report assembly**: group + states + coverage → `search_reports kind='audit'` via SM-22 renderer; portfolio compliance report; PDF via `report-renderer` path; "as of" inline | medior | default | SM-82,83 | Rendered MD+PDF for a fixture group passes the SM-22 honesty checklist (empty-is-not-zero, provenance inline, as-of date in body); delivery creates deliverable + file rows as existing reports do |
| SM-86 | **Attestation surface**: facts write API + UI (attest/supersede with required note), history view; `imported` back-seed path (optional, owner-triggered) stamped as such | medior | default | SM-76 | Attesting flips the dependent check on the *next* run only (no retro-edit of completed runs); superseding preserves the chain; `recorded_by` enforced; sensitive-permission denial probed live |
| SM-87 | **Remediation loop**: assign + PM-task link (verify the exact task FK/contract before wiring — do not assume), `fixed_claimed` flow, "guard this fix" → monitoring-assertion **proposal** (human-accepted, monitoring's write perms; depends on monitoring's write API MON-19/MON-14) | senior-be | default | SM-77,83; monitoring MON-14/19 | Claim → next-run verification → `fixed_verified` end-to-end on fixtures; guard proposal creates nothing without a monitoring-write-holder's acceptance; task link round-trips |
| SM-88 | **QA adversarial gate** (merge gate for phases 1–3): coverage-honesty attack set (can any path render unmeasured-as-passed?), sticky-triage regressions, cross-tenant + cross-root leak probes on every new endpoint, hostile v2 payloads (oversized, header-smuggling, secret-material injection into evidence), hash-idempotency v1/v2 | qa | default | each phase | Every attack has a pinned failing-before/passing-after test; zero skips with DATABASE_URL_TEST set; run against live Cerbos |

**Owner-gated (mobilize only on the §10 answers):**

| # | Ticket | Tier | Gate |
|---|---|---|---|
| SM-90 | **Wave-1 baseline campaign**: reconcile the ~63 properties against `search_properties` (verified rows), first portfolio run (measured checks), attestation drive for the server-side checks, first portfolio compliance report to the owner | medior + operator | Owner Q2/Q5 (probing + notice posture), triage Decisions A/B |
| SM-91 | **Client-portal audit surface** (field-allowlisted read of states/reports) | senior-fe + architect review | Owner Q3 |

Sequence: SM-76 → SM-77 → {SM-79, SM-82} with SM-78 parallel from day one; SM-80/81/83 next;
SM-84/89 then SM-85/86/87; SM-88 gates each phase. Opus flags: **2** (SM-76, SM-77) — everything
else is bounded by landed patterns and stays on seat defaults.

---

## 10. What only the owner can decide

1. **PSI API key** (free, Google Cloud project) — approve creating/holding one for the platform.
   Without it, `kind='cwv'` runs record `not_run` honestly. No paid vendor is required by this
   design; confirm the $0 posture stands (DataForSEO/Semrush site-audit endpoints stay unused).
2. **Probing posture for client sites**: is verified-property + human-enabled scope toggle
   sufficient standing consent to *crawl/probe* on schedule (the monitoring precedent says yes for
   monitors), or does the audit crawl need per-client notice first? Gates SM-90's first live run.
3. **Client-portal exposure** of audit results (SM-91): when, and whether it must precede staging.
4. **External-link checking**: authorize designing the bounded public-only mode, or keep deferred.
5. **Remediation authority**: triage-doc Decisions A–E remain open and are re-surfaced unchanged —
   engagement scope/contract authority (A), the salts confirmation task (B — still requires a human
   with `gaia-nexus` history access; the ERP can only record the conclusion), incident-vs-
   maintenance framing if salts confirm (C), client comms for logout/downtime fixes (D), and
   sequencing against cutover (E).
6. **Catalog severity defaults** (§4.3) — sign off or adjust; they encode risk appetite, not just
   engineering fact.

---

## 11. Provenance

Design only; no code, migration, or configuration was changed by this document beyond the harvest
plan's header note it mandates. No live system, container, or client property was contacted. Every
"exists/DEV-VERIFIED" claim is read from the files named in the header; every "wrong/missing" claim
names the mechanism, not an impression. Concurrent-session note: migration naming follows the
timestamped scheme (`YYYYMMDDHHMM_*`, sequential closed above 0118 per `docs/MAP.md`) — SM-76
reserves its filename by creating it, never by claiming a number in prose.
