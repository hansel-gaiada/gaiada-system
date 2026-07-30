# Search-Marketing Module — Operator Runbook

**Status:** `search-marketing` **`0.2.0` · IN PROGRESS** (registry of record:
[`../modules/MODULES.md`](../modules/MODULES.md); running ticket state:
[`../blueprints/seo-sem-execution-tracker.md`](../blueprints/seo-sem-execution-tracker.md)). This module is **not yet in production** and has **never made a real paid pull** to a provider (proven only against mock DataForSEO and HTTP fake; the $50 DataForSEO deposit, OQ-2, is unfunded). P1 data work is incomplete, so several console tabs are still backend-pending. Operators must not over-trust this module for financial decision-making until it has been live-tested with real credentials and budget spend.

**Authority:** `docs/blueprints/seo-sem-design.md` (§05 provider design, §08 console, §12 crawl jobs).

---

## What this module is

The search-marketing module (`platform-nest`, route `/api/:t/modules/search/…`) is a **data + judgment subsystem** for SEO, SEM, and GEO operations. It sits inside the platform (not a fleet of external apps) and:

- **Owns provider abstraction** — routes paid data calls (keyword research, rank tracking, backlink snapshots, AI-visibility checks, etc.) through a **single dispatch choke-point** (`dispatchProviderOp`) that enforces a cost ledger and stop-loss budgets *before* money is spent.
- **Runs self-hosted crawlers as job-mode workers** — SEONaut, open-seo-crawler, Unlighthouse containerized and orchestrated by n8n, with egress-guarded network access and results ingested into tenant-scoped database rows.
- **Records spend in `search_provider_calls`** — a per-engagement, per-tenant metering ledger that powers billing rollups and operator visibility.
- **Owns three first-class pillars**: SEO (technical audits, keyword research, rank tracking), SEM (campaign planning, ad drafts, dual-mode execution — manual export OR automated API), and GEO (AI-visibility snapshots, citation-oriented brief guidance).

The console is built on the **dept-interface-template** (like Web Dev) with **universal Home · Work · Connections spine** plus three department-specific craft groups: **Accounts** (Engagements, Reports), **Optimize** (Site Audit, Keywords, Rankings, Briefs, AI Visibility), **Campaigns** (Planner, Ads Studio, Search Terms, Pacing).

---

## Environment variables (provider credentials & kill switches)

### Provider credentials (server-side, platform-nest only)

```
DATAFORSEO_LOGIN=<username>
DATAFORSEO_PASSWORD=<password>
DATAFORSEO_BASE_URL=https://api.dataforseo.com        # default
DATAFORSEO_QUEUE=standard|live                        # default: standard (~5 min queue)
DATAFORSEO_TIMEOUT_MS=20000                           # default
```

**KEYLESS MODE IS SUPPORTED AND INTENDED FOR DEV:** With no `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD`, the DataForSEO driver is simply not registered at bootstrap. All paid capabilities fail closed (`NoCapableProviderError`), while **$0 pillars keep working** (crawl audits, keyword clustering, AI drafts). This is the whole point of the P1-before-P2 build order — you can operate and demo the module without a DataForSEO account.

Semrush is a premium fallback (credentials not yet wired; future).

### Budget caps (stop-loss tiers, checked in order)

```
SEARCH_GLOBAL_MONTHLY_CAP_USD=150                     # platform-wide ceiling (default)
SEARCH_TENANT_MONTHLY_CAP_USD=<number>                # optional per-deploy tenant override (empty = skip)
```

Individual **engagement caps** are set per-client in the console (Engagements → Configure Scope & Budget) as `provider_budget_usd` (defaults to $10/mo per engagement per `seo-sem-design.md` §04).

### Per-pillar kill switches (operator emergency brake)

```
SEARCH_PILLAR_SEO=1|0        # default: 1 (ON) — technical audits, keywords, rankings
SEARCH_PILLAR_SEM=1|0        # default: 1 (ON) — campaign planning, ad drafts, spend tracking
SEARCH_PILLAR_GEO=1|0        # default: 1 (ON) — AI-visibility snapshots (ChatGPT, Gemini, etc.)
```

When a pillar is disabled (set to `0`), **all operations in that pillar fail closed** at the dispatch choke-point with `PillarDisabledError`, *before* budget or scope checks. This is the operator's most immediate emergency brake — use it to pause a misbehaving provider or hedge a cost surprise without editing per-engagement toggles.

All three pillars default ON. An unset env var is treated as ON.

### Provider selection order

For any paid operation:
1. **Engagement override** — `search_engagements.tool_scope.provider.<tool>` (e.g., `tool_scope.provider.rank = "semrush"` forces that tool to use Semrush).
2. **Tenant default** — `SEARCH_TENANT_DEFAULT_PROVIDER` (empty = skip).
3. **Platform default** — `SEARCH_DEFAULT_PROVIDER` (default: `"dataforseo"`).

If no provider is registered (keyless mode, or the selected provider's credentials are unset), the operation refuses with `NoCapableProviderError` after budget checks.

---

## Ordered refusal gates (the dispatch choke-point)

Every paid operation is routed through **`dispatchProviderOp()`** in `platform-nest/src/modules/search/providers/dispatch.ts`. The stop-loss gates are enforced in this order, and the first breach or refusal wins:

### (-1) Pillar kill switch

If `SEARCH_PILLAR_<PILLAR>=0`, the operation is refused **immediately** — no ledger row, no budget check. Error: `PillarDisabledError(<pillar>, <op_kind>)`.

This is checked **before** the engagement is even loaded, making it the fastest operator brake.

### (0) Scope toggle

The operation's tool must be **enabled in the engagement's `tool_scope`** (set via the console's Configure Scope & Budget panel). The `tool_scope` is a JSON object in `search_engagements`:

```json
{
  "rank": {"enabled": true, "cadence": "weekly", "maxKeywords": 50},
  "volume": {"enabled": true},
  "backlinks": {"enabled": false},
  "ai_visibility": {"enabled": true, "cadence": "weekly"},
  "audit_technical": {"enabled": true, "cadence": "weekly"},
  "sem_sync": {"enabled": false}
}
```

If a tool is disabled or missing, the operation is refused with **`ScopeDisabledError(<toggle_name>, <op_kind>)`** — the toggle name is **explicitly named** to the operator so they know which switch to flip. A ledger row is recorded (status `"failed"`, endpoint `<provider>.<op_kind>.scope_disabled`), but **no budget is spent**.

This gate fires *before* budget checks, ensuring that a disabled tool cannot accidentally trip the budget alarm.

### (1) Budget stop-loss (three tiers, engagement → tenant → global)

After scope is cleared, the estimated cost of the operation is checked against three cascading budget caps:

1. **Engagement cap** — `search_engagements.provider_budget_usd` (e.g., $10/mo for this client).
2. **Tenant cap** — `SEARCH_TENANT_MONTHLY_CAP_USD` (optional per-deploy, e.g., $500/mo for the whole company).
3. **Global cap** — `SEARCH_GLOBAL_MONTHLY_CAP_USD` (platform ceiling, default $150/mo until the deposit model is proven).

Month-to-date spend is summed from `search_provider_calls(status = 'posted' OR 'completed')` for the current month (per-engagement if tier 1, per-tenant if tier 2, global if tier 3). The estimate + MTD is compared to the cap:

- **If breach:** Operation is refused with `BudgetExceededError(<tier>, <cap>, <mtd>, <estimate>)`. A ledger row is recorded (status `"failed"`, endpoint `<provider>.<op_kind>.budget_blocked`), and event `search.provider.budget_threshold` is emitted (level `"blocked"`). **No dispatch happens.**
- **If 80% of cap:** Warning event `search.provider.budget_threshold` (level `"warn"`) is emitted. The operation **proceeds**.
- **If <80%:** Silent pass.

An operator with `search:provider:admin` permission can **override** a budget breach (audit event `level: "override"` is emitted), but the breach still triggers a warning event.

### (1a) Global MTD computation — fail-closed

Computing the global month-to-date sum must **FAIL CLOSED** — if the query fails (DB error, permission issue), the operation is refused with `GlobalCeilingUnavailableError`, rather than degrading to $0 (which would silently disable the only platform-wide ceiling on the default config). A ledger row records the failure (endpoint `<provider>.<op_kind>.global_ceiling_unavailable`).

---

## Cost ledger structure

The `search_provider_calls` table is the authoritative spend record. Each row represents one provider invocation:

```sql
CREATE TABLE search_provider_calls (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  engagement_id uuid,
  provider text,                  -- 'dataforseo', 'semrush', 'scraper', etc.
  endpoint text,                  -- 'dataforseo.serp', 'semrush.backlinks', 'dataforseo.serp.cache_hit', etc.
  items integer,                  -- number of items dispatched (e.g., keywords in a rank pull)
  cost_usd numeric(12,6),         -- DataForSEO prices are precise: $0.00012 per SERP
  cache_hit boolean,              -- true if the result was found in search_data_cache (cost_usd = 0)
  status text,                    -- 'posted' (estimated), 'completed' (true-up actual), 'failed'
  requested_by uuid,              -- user id (human) OR automation OBO user
  created_at timestamptz NOT NULL DEFAULT now()
);
```

**Reading the ledger:**

- **`status = 'posted'`** — Estimated cost at dispatch time; will later be true'd up to `'completed'` with actual cost once the provider responds.
- **`status = 'completed'`** — Final cost after true-up.
- **`status = 'failed'`** — Operation refused (scope disabled, budget breach, pillar disabled). `cost_usd = 0`.
- **`cache_hit = true`** — Result was found in the shared market-data cache (`search_data_cache`); `cost_usd = 0`, a pure reuse win.

Operators can inspect spend per-engagement (`WHERE engagement_id = …`), per-tenant (`WHERE tenant_id = …`), or platform-wide (`SELECT SUM(cost_usd) FROM search_provider_calls WHERE created_at > now() - interval '1 month'`).

The ledger also powers the rollup metric `search.provider_cost.month` (money_minor USD) that feeds billing.

---

## Running a crawl job

Crawls are **job-mode containers** orchestrated by n8n or run manually. The worker is `search-crawl-go/cmd/crawl`.

### Command-line invocation

```bash
DATABASE_URL=postgres://platform_app:<password>@postgres:5432/gaiada_platform \
TENANT_ID=<company uuid> \
PROPERTY_ID=<search_properties uuid> \
AUDIT_LOG_PATH=/app/data/egress-audit.jsonl \
REPORT_PATH=/app/data/report.json \
MAX_PAGES=25 \
MIN_HOST_GAP_MS=1000 \
./crawl
```

### Required inputs

- **`DATABASE_URL`** — Postgres connection string for `gaiada_platform` (must connect as `platform_app`, NOBYPASSRLS role; see `docs/db-topology-roles.md`). The crawl worker runs RLS queries (`SELECT set_config('app.current_tenant_ids', '...')` + module scope) — no elevated privilege.
- **`TENANT_ID`** — UUID of the company/tenant owning the property.
- **`PROPERTY_ID`** — UUID of the `search_properties` row to crawl. The property must exist, be owned by the tenant, and have `verified_at IS NOT NULL` (the activation checklist gate).
- **`AUDIT_LOG_PATH`** — File path for the egress-guard audit log (append-only JSONL, one record per network dial attempt). Directory must exist and be writable.
- **`REPORT_PATH`** — File path for the raw crawl report (JSON). Directory must exist and be writable.
- **`MAX_PAGES`** — Integer; stop crawling after this many pages. Recommended 25–50 for typical sites.
- **`MIN_HOST_GAP_MS`** — Integer; minimum milliseconds between requests to the same host (robots.txt compliance + rate-limiting). Recommended 1000 (1 second).

### Refusals (non-zero exit, audit line written)

The crawl exits with `non-zero` and writes an audit line if:

- **`unknown_property`** — The `PROPERTY_ID` has no matching `search_properties` row.
- **`not_verified`** — The property exists but `verified_at IS NULL` (not yet activated by the user's activation checklist).
- **`not_allowlisted`** — (Optional, if `TARGET_URL` env var is set) The target URL's hostname does not match the property's registered domain.

Everything past verification is enforced live by the egress guard (`internal/egress`) during the crawl:

- DNS resolution of each hostname is checked; any private/reserved IP (RFC1918, loopback, link-local, `169.254.169.254`, IPv6 equivalents, CGNAT) is refused mid-crawl.
- Each dial attempt is logged to the audit sink with reason (`allowed`, `private_ip_denied`, `ratelimit`, etc.).

### Egress guard (SSRF prevention)

The crawl worker includes an **SSRF-hardened egress guard** (`internal/egress`):

1. **Per-job allowlist** — Only hostnames registered in `search_properties.domain` + any linked properties are allowed; subdomains of the registered domain are permitted.
2. **DNS-rebind protection** — DNS is resolved *once* at connection time; the *actual IP* dialed (not the hostname) is checked against the allowlist and RFC1918 denials. No second-resolution race.
3. **Private IP denial** — Any RFC1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16 — which covers the cloud metadata address 169.254.169.254 — and fe80::/10), multicast, unspecified, and CGNAT (100.64.0.0/10) addresses are refused. Both IPv6 spellings of an IPv4 address are decoded before the check: the **mapped** form (`::ffff:10.0.0.1`) and the deprecated **compatible** form (`::a.b.c.d`, e.g. `::7f00:1` = 127.0.0.1). The compatible form was a real gap found at the SM-07 QA gate — `net.IP.To4()` only unwraps the mapped one, so every private/CGNAT branch silently skipped it and the classifier called it public.

   The check runs at `DialContext` on the **resolved IP actually being dialled**, not on the URL string, so a public hostname that resolves to a private address (DNS rebinding) and a redirect chain landing on one are both refused by the same code path.
4. **Audit trail** — Every dial attempt (allowed or refused) is appended to the audit log (`AUDIT_LOG_PATH`) as JSONL, naming the reason.

### Output files

**`REPORT_PATH`** (JSON) — Raw crawl report. SM-08 will define ingest adapters that parse this into `search_audits` + `search_audit_findings` rows.

**`AUDIT_LOG_PATH`** (JSONL) — One JSON record per dial:

```json
{
  "timestamp": "2026-07-29T12:34:56Z",
  "hostname": "example.com",
  "resolved_ip": "192.0.2.1",
  "reason": "allowed"
}
```

Reasons include: `allowed`, `private_ip_denied`, `dns_resolution_failed`, `ratelimit_per_host`, `off_allowlist`, etc.

---

## Console operator workflows (happy paths)

### Keyless dev/demo

With no DataForSEO credentials, the module is fully functional for **$0 operations**:

1. Create an engagement.
2. Import keywords (CSV paste).
3. Run crawls (Site Audit).
4. Cluster keywords with AI (Keywords).
5. Draft content briefs (Briefs, with Hermes).
6. Build SEM campaign plans (Planner, with Hermes).
7. Mock-test the SEM dual-mode flow (manual export path).

Any attempt to enable a **paid toggle** (rank tracking, volume/difficulty, backlinks, AI visibility) in the scope config will show the button disabled and name the missing DataForSEO login. The engagement's engagement-level `provider_budget_usd` is configurable but immaterial.

### With DataForSEO credentials

Once `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` are set:

1. Enable paid toggles in the engagement's scope config (Accounts → Engagements → Configure Scope & Budget).
2. Set cadence + per-tool caps. The console projects monthly cost per toggle so the operator sees the price.
3. Enable the tool. A dispatch with matching cadence will start pulling real data (next scheduled run, or manual trigger).
4. Monitor spend in the engagement detail (Accounts → Engagements → <engagement> → Usage Ledger tab).

Budget warnings emit to the notifications bell at 80% of any cap; breaches refuse further operations.

---

## Known limitations (status honesty)

- **No real paid pull ever completed** — this module has been proven only against a mock DataForSEO and HTTP fake. The $50 DataForSEO deposit (OQ-2) is unfunded. Operators should not assume it is production-hardened until it has been live-tested with real credentials and real spend.
- **P1 data work incomplete** — Several console tabs (Rankings, Backlinks, AI Visibility) are still backend-pending (SM-24+). The console renders them but operations fail gracefully pending implementation.
- **Dual-mode SEM execution** — Manual export twin (approved proposal → Ads-Editor CSV) is P3 (shipped soon). Automated twin (API push via OAuth) is P4 (committed, deferred).
- **Semrush premium** — Semrush is designed as a premium fallback (planned §06) but credentials are not yet wired.
- **Per-tool provider override** — Engagement `tool_scope.provider.<tool>` allows per-client provider selection (e.g., force Semrush for rank tracking), but only DataForSEO is registered at bootstrap unless Semrush is added.

---

## Troubleshooting

### "Pillar disabled" error in the ledger

Check `SEARCH_PILLAR_<PILLAR>=0` in the env. Flip the pillar back to `1` (or unset to default ON).

### "Scope disabled: <toggle>" refusal

The engagement's `tool_scope` has the toggle disabled or missing. Go to Accounts → Engagements → <engagement> → Configure Scope & Budget. Enable the toggle. If you see "no provider available", DataForSEO credentials are unset (keyless mode); the $0 operations remain available.

### "Budget exceeded" (engagement / tenant / global)

Month-to-date spend has hit or exceeded the cap. Options:

1. **Increase the engagement's `provider_budget_usd`** (Accounts → Engagements → Configure Scope).
2. **Wait for the calendar to flip to the next month** (caps are monthly, resets on the 1st).
3. **Override with `search:provider:admin` permission** — proceed past the breach (audit event emitted). Use sparingly; this is for unexpected surges only.
4. **Reduce enabled toggles** — disable less-critical tools (Accounts → Engagements → Configure Scope) to lower projected monthly cost.

### Crawl job exits with "not_verified"

The property's `verified_at` is NULL. The user must complete the property's activation checklist in the console (Accounts → Engagements → <engagement> → Property → Verify). This is a user-facing flow; typically a domain verification or Google Search Console link. Until verified, crawls refuse.

### Crawl job dials are all "private_ip_denied"

The property's registered domain resolves to a private IP (10.x.x.x, 192.168.x.x, 127.x.x.x, 169.254.x.x, etc.). Check the property's DNS and the `search_properties.domain` + `site_url` — they should point to a public internet address. If this is a dev/staging environment with a private domain, the crawl guard is working as designed (SSRF protection).

---

## Related documentation

- **Full design:** `docs/blueprints/seo-sem-design.md` (§00–§12, authority for all decisions).
- **Console IA:** `docs/superpowers/plans/2026-07-23-dept-console-ia-redesign.md` §2 (SEO dept structure).
- **DB topology & roles:** `docs/db-topology-roles.md` (platform_app role, NOBYPASSRLS).
- **Crawl job internals:** `search-crawl-go/README.md`.
- **Dispatch source:** `platform-nest/src/modules/search/providers/dispatch.ts` (file header explains the choke-point).
- **Config reference:** `platform-nest/src/config.ts` (lines 69–110, search section).
