# Monitoring programme — architect rulings on the five gated items

**Date:** 2026-08-20 · **Author:** system architect · **Status of everything here:** PLANNED until a ticket lands
**Inputs:** `docs/blueprints/monitoring-program.md`, `docs/plans/monitoring-tracker.md`,
`docs/plans/2026-08-18-observability-relocation.md`, the migrations/policies/source named inline, and
read-only probes of `gda-aicenter` on 2026-08-20 (`df`, `docker system df`, `docker images`,
`docker info`, cAdvisor logs, `docker inspect .GraphDriver`). Nothing on any box was mutated.

---

## 1. MON-00 — cross-root boundary rule (RULING + enforcement design + the failing test)

### 1.1 Ruling

**The unit of isolation for the SaaS estate is the root company tree** (root = the `companies` row
whose ancestry terminates at `parent_company_id IS NULL`). No request, rollup, status page,
notification route, fan-out, or service assignment may combine data from companies under two
different roots. Exactly one principal class crosses roots: the SaaS **operator** (`platform_admin`,
our staff) — and only that one. `group_executive` — today the deliberate not-inTenant cross-company
role — becomes **root-bounded**: cross-company *within the holder's own root*, never beyond. This is
enforceable with three concrete walls (below), each of which fails closed, and it is verified by a
live-decision test suite because the role-bundle/parity machinery is *structurally blind* to Cerbos
conditions and therefore can never attest this boundary.

### 1.2 Why this is the rule (the verified leak chains)

Verified in source, not assumed:

1. **`GET /rollups` spans roots today.** `src/core/core.controller.ts:328-345` authorizes
   `{kind:"rollup"}` with **no tenantId**, then does `SELECT id FROM companies` and
   `withTenants(all, …)` — the GUC is widened to every company in the database. Under one root this
   is the holding view; the moment a second root exists it is a cross-customer read. It is also
   already flagged as allowlist entry #1 in `scripts/lint-withtenants.mjs`.
2. **`group_executive` completes a cross-root read chain on monitoring.**
   `derived_roles.yaml` matches it on a global grant alone; `resource_monitor.yaml` (and the other
   four monitor kinds, rollup, appraisal, …) allow it with `variables.notLow` only — no tenant
   condition, by design (IAM-TRAP4). The HTTP chain is: URL `:tenantId` (client-chosen) →
   `authorize()` ALLOW (no tenant gate for this role) → `withTenants([tenantId])` (GUC now contains
   the foreign tenant) → RLS passes. A DnA exec can read tenant Acme's monitors end to end.
3. **RLS itself never crosses roots — but it only bounds to the GUC.** The single point of failure
   is *what goes into the GUC*, plus the no-RLS exemptions (`search_data_cache`, §5) and Cerbos
   rules without a tenant condition (#2).

The monitoring board itself (`monitoring.controller.ts`) is single-tenant `withTenants([tenantId])`
with a tenant-carrying authorize — correct. The runner sweeps `withGlobal` but scopes every write to
the row's own `tenant_id` — correct. The exposure is the two chains above plus every *future*
widened call site, which is what the walls below make structurally hard.

### 1.3 Enforcement design (three walls + one anchor)

**Anchor — materialize the root (MON-00a, migration).**
- `companies.root_company_id uuid NOT NULL REFERENCES companies(id)`, backfilled by recursive CTE.
- Triggers: BEFORE INSERT derives root from the parent (self if `parent_company_id IS NULL`);
  BEFORE UPDATE OF `parent_company_id` **raises** if the new parent's root differs from the old root
  (moving a company between roots is a deliberate data migration, never an UPDATE); cycle guard with
  a depth cap. Direct writes to `root_company_id` that disagree with the recomputation also raise.
- `users.home_company_id uuid NULL REFERENCES companies(id)` — the principal's anchor. NULL means
  operator staff. Backfill from memberships; the handful of zero-membership `group_executive`
  holders (see `0092`) get DnA's root by hand in the same migration. Migration **aborts with a
  report** if any user's memberships span two roots — that state is itself a violation.
- Bots/automation principals are `users` rows on purpose ([[principal-kinds]]) — they get a home
  company like everyone else.

**Wall 1 — the GUC can only ever hold one root (withTenants assert, MON-00b).**
`withTenants` gains, immediately after `set_config`, a single indexed check:
`SELECT count(DISTINCT root_company_id) FROM companies WHERE id = ANY($1::uuid[])` — result > 1
throws unless the caller passed an explicit `opts.crossRoot: "<justification-key>"`.
`lint-withtenants.mjs` extends to treat `crossRoot` exactly like multi-tenant arrays: allowlist
entries with written justification, architect-approved. Known legitimate cross-root sites, each
ratified here:
- `src/events/relay.ts` (background outbox poller, no principal, returns nothing to a caller);
- `src/modules/search/providers/ledger.ts` `sumGlobalMonthToDate` (the **operator's** platform-wide
  vendor stop-loss: one parameterized scalar aggregate, pinned by `ledger.test.ts` — this is the
  operator's wallet, and it is *correct* that it spans roots).
All per-tenant background fan-outs (`burndown-job`, `pull-scheduler`, ingest, retention jobs, …)
pass single-element arrays and are untouched. The typical array length is 1, so the assert is one
PK-array lookup per transaction — negligible.

**Wall 2 — Cerbos root-bounding for the one non-tenant-gated customer role (MON-00c).**
- `assemblePrincipal` computes `attr.rootCompanies: string[]` = every company id where
  `root_company_id = root(home_company_id)`; `[]` for operator staff and anchorless principals
  (fail-closed: `x in []` is false).
- `_variables.yaml` gains `inRoot: request.resource.attr.tenantId in request.principal.attr.rootCompanies`.
- Every `group_executive` rule across the policy tree changes `variables.notLow` →
  `variables.notLow && variables.inRoot`. No handler changes: `tenantId` is already on every
  resource (the monitor policies document that shape explicitly).
- `GET /rollups` starts authorizing `{kind:"rollup", tenantId: <caller's root id>}` and derives its
  id list from `principal.rootCompanies` instead of `SELECT id FROM companies` (platform_admin may
  keep the estate-wide list — operator view). After this, the endpoint passes Wall 1 with no
  `crossRoot` opt.
- `platform_admin` stays estate-global — that is the operator role. Governance invariant, pinned by
  test: **customer principals never hold `scopeType:"global"` grants**; global grants are
  operator-only under SaaS.
- **Prior-decision conflicts, flagged rather than silently overridden:** (a) IAM-TRAP4
  (`iam-trap4-group-executive-split.test.ts`) pinned "exec ALLOWs with zero memberships against any
  tenant" — its *intent* (no membership requirement; don't gate the exec on `inTenant`) is
  preserved, because `inRoot` reads `rootCompanies`, not memberships; its *reach* (any tenant ⇒ any
  root) is deliberately superseded. The pinned suite is revised in the same change, with this
  paragraph cited. (b) Blueprint §13.1's "group_executive … reads only, since its rule is not
  inTenant-gated" gains the root bound. (c) `group_executive` is D-7-obsolete (removal Phase 3,
  replaced by the narrower `owner`) — which is exactly why this is a cheap policy-side bound riding
  principal attrs, **not** a grant-model rework for a dying role; D-8's `owner` inherits `inRoot`
  from day one.

**Wall 3 — the surfaces monitoring adds (already correct or pinned at build time).**
- Board/detail/editor: single-tenant, tenant-carrying authorize — correct today; the failing suite
  pins it.
- Notification routing (MON-17): route/channel resolution must run inside
  `withTenants([incident.tenant_id])`; the outbox event carries `tenant_id`; acceptance for MON-17
  includes the cross-root canary (below).
- Public status page (MON-21): the slug resolver reads the single `status_pages` row `withGlobal`,
  then everything else inside `withTenants([row.tenant_id])`, output through the §3.5 field
  allowlist. Acceptance includes the canary.
- Service assignments: **cross-root assignments are denied** — validated at propose time and
  asserted in the reconciler (provider root == target root). If cross-root servicing ever becomes a
  product (owner question Q2), it returns as a designed, consent-gated exception with its own
  review; it does not exist by accident.

### 1.4 The failing test — `src/rbac/cross-root-boundary.db.test.ts` (MON-00d)

Needs `DATABASE_URL_TEST` + `CERBOS_URL` like its siblings. **Two of its blocks fail against
today's code** — that is the point: it proves it can detect the leak before it pins the fix.

Fixtures: `rootA` (parent NULL) → `childA1`; `rootB` (parent NULL) → `childB1`. Users: `execA`
(`group_executive`, home = rootA, **zero memberships** — the real exec shape), `adminB`
(`company_admin` @ rootB). Monitoring rows under both children; every rootB row carries a canary
string in its name: `LEAK-CANARY-B-<uuid>`. Monitoring module enabled for all four companies.

1. **Positive controls first** — the zero-row-trap inversion (`app_module_allowed` + an unset GUC
   return zero rows *silently*, so a leak test asserting "no foreign rows" passes vacuously when the
   query returns nothing at all). `app.inject GET /api/{childA1}/monitoring/monitors` as execA must
   return the rootA rows before any negative assertion is trusted.
2. **Cerbos live probes** (per kind: `monitor`, `monitor_incident`, `monitor_maintenance`,
   `status_page`, `rollup`): execA vs `{tenantId: childA1}` → ALLOW; execA vs `{tenantId: childB1}`
   → **DENY**. Remember the estate rule: restart Cerbos and confirm the container start time
   postdates the policy edit, or every DENY below is a stale-policy artifact.
3. **HTTP cross-root** — `GET /api/{childB1}/monitoring/monitors` as execA → **403**.
   *Fails today (returns 200 with rows).* Belt over the status code: serialize the **entire raw
   response body** and assert the canary substring is absent — a canary scan fails on any leak
   shape, not just the fields the author thought to check.
4. **Wall-1 backstop** — `withTenants([childA1, childB1], noop)` → throws (two roots);
   `withTenants([childA1, rootA], noop)` → passes (one root). This is the wall that catches every
   *future* widened call site, which is why it is tested directly.
5. **Rollups** — seed `rollup_metrics` under both roots; `GET /rollups` as execA returns tenant_ids
   ⊆ subtree(rootA) and the body contains no rootB company name. *Fails today (returns both
   roots).*
6. **RLS regression pin** — inside `withTenants(subtree(rootA), {modules:["monitoring"]})`, select
   from every monitoring table + `rollup_metrics`: zero rows with `tenant_id ∈ subtree(rootB)`
   (passes today; pins Wall 3), preceded by its positive control.
7. **Root integrity** — `UPDATE companies SET parent_company_id = childB1 WHERE id = childA1` →
   raises.

**Verification blindness, stated once:** `generate-role-bundles.mjs` records role names per action
and *documents* that it treats conditions as satisfied; `role-permission-parity.db.test.ts` derives
reach the same way. Neither can see `inRoot`. **The only evidence this boundary exists is this
suite's live decisions** — which is why MON-00e gives it a CI home: the tracker already records that
every `*.db.test.ts` silently skips in CI (no test DB), and a boundary test that can silently skip
is not a gate. A dedicated CI job with Postgres + Cerbos services runs this suite plus the
monitoring db-suites, and **fails on skip** (assert the skip count is zero for these files).

---

## 2. MON-09o — disk sizing on gda-aicenter (RULING)

**Ruling: keep two local release tags (rollback autonomy is load-bearing), fix the *cost of a tag*
with three engineering levers, and put one sizing question to the owner.** Measured 2026-08-20:
49G disk, 37G used, **11G free (79%)**; images **19.86 GB** of which **2.805 GB reclaimable**;
per-tag app set ≈ 6.5 GB (outlier: `report-renderer` **3.62 GB** — Playwright/Chromium; then
`wa-chat-bot` 989 MB, `mcp-hub` 525 MB, `ai-agents` 499 MB, `platform-nest` 491 MB); third-party
residents ≈ 12 GB (`waha` 3.17 GB, `n8n` 2.47 GB, `faster-whisper` 1.92 GB, …). Two corrections to
the blueprint's framing: the "~19 GB for two tags" is really ~13 GB of app tags + ~12 GB of
third-party sharing layers; and **cleanup is *not* fully exhausted** — the relocation left orphans
(`grafana` 647 MB, `clamav` dup 395 MB, `tempo` 179 MB, `loki` 142 MB, three unused cAdvisor
versions ~340 MB, plus dup `latest` tags), which is the 2.8 GB reclaimable. Do **not** go
keep-1-tag: `rollback-to.sh` classifies services by *local* image presence and its bad-tag gate
reasons by proportion — a registry-pull rollback changes the recovery tool's semantics and makes an
incident depend on GHCR reachability. Levers, all engineering: **(a)** remove the orphans by
explicit `docker rmi <name:tag>` — never a prune on this box — after grepping both tags' merged
compose output to prove nothing references them; **(b)** `release.yml` uses buildx with **no
`cache-from`/`cache-to`** (verified), so consecutive tags share almost no layers — add registry
layer-cache so an unchanged component's next tag costs ~0 instead of its full size; **(c)** image
diet with `report-renderer` first (3.62 GB → target ≤ 2 GB; it ships twice, so this one image is
~7.2 GB of the problem), then multi-stage/prod-deps-only for the four ~0.5–1 GB Node images.
Steady-state after levers: images ~13 GB and a deploy's transient third tag ~1 GB instead of
~6.5 GB. The residual owner call is **headroom**: a disk-full has already rolled back a healthy
release on this estate, and 49 GB stays permanently tight even after the diet → owner question Q1.

## 3. MON-09n — cAdvisor per-container discovery (RULING)

**Ruling: fix it — one bounded, evidence-grounded attempt; if that misses, replace the signal
source; do not accept the gap.** The root cause is now pinned, not hypothesized: the daemon runs the
**containerd image store** (`docker info`: `Storage Driver: overlayfs`,
`driver-type: io.containerd.snapshotter.v1`; `docker inspect .GraphDriver` returns `null`), and
cAdvisor's Docker factory fails every container handler at
`…/image/overlayfs/layerdb/mounts/<id>/mount-id: no such file or directory` (live log, 2026-08-20) —
a file that only exists under the classic graphdriver store. That lookup is the RW-layer resolution
cAdvisor performs **for disk-usage metrics**; the attempt is therefore to add `disk` to
`--disable_metrics` (keep v0.49.1's default disable list and append `disk`), which skips the failing
call so handlers construct and per-container CPU/memory/network appear. Acceptance:
`count(container_last_seen{name!=""})` ≈ running-container count on the box, per-container
CPU/memory series queryable from the remote Prometheus, error spam gone, dashboard gap-note
removed. What we lose with the fix: per-container *filesystem usage* series — which cAdvisor cannot
produce under the snapshotter anyway, so nothing real is lost. **Fallback (single attempt fails):**
replace discovery with the `docker_stats` receiver in the already-deployed
`otel-collector-contrib:0.116.1` (per-container CPU/mem/net/blkio straight from the daemon API,
riding the existing remote-write path), then retire cAdvisor after a parity check — cost: OTel
metric names replace `container_*`, so the Host & Infrastructure dashboard panels are rewritten
once. **Accepting the gap is rejected** because "which container is eating the box" is precisely the
question a prior 46%-CPU busy-loop incident required, and this programme's founding lesson is that a
monitor which is up-but-blind is the failure mode. Honestly stated uncertainty: the error text and
the disk-metrics gating match the known upstream failure exactly, but I could not execute the flag
change in a read-only session — hence one bounded attempt with a hard fallback, not a promise.

## 4. MON-09p — durable metrics queue (RULING)

**Ruling: durability is NOT warranted now — accept a bounded, *loud* gap and spend nothing further
on it; if gap-free staff metrics are ever wanted, build the boring topology (local Prometheus
agent-mode + receiver-side out-of-order window), never the otlphttp re-translation.** Reasoning:
(i) the exposure is Plane A staff telemetry history only, during the compound event
(tunnel outage ∩ queue overflow) or (restart while a backlog is queued) — the tenant-facing/SLA
record is Postgres by the two-stores ruling (§3.1) and never touches this path; (ii) the outage is
already *noticed*, which is the property that matters: `RemoteWriteStalled` was verified in both
directions (fires on a missing feed, silent on a healthy one) and its description says the other
alerts are meaningless while it fires; (iii) the durable path already paid its tuition — §12
measured `otlphttp` re-translation changing series identity (`up` 16→30) and exposed the junk-label
bug, and the remaining `wal` option on `prometheusremotewrite` is experimental with known loss modes;
(iv) durability without receiver-side out-of-order tolerance is **theater**: a replayed backlog
hours old is rejected by the receiving Prometheus TSDB as out-of-bounds unless
`out_of_order_time_window` is configured (exact default windows vary by version — flagged as the one
soft spot in this reasoning, verify before ever building the durable path). Cheap hardenings that DO
ship: size `remote_write_queue` to ~15 minutes of measured throughput (from
`otelcol_exporter_sent_metric_points` rate) so blips cost nothing; add an alert on increase of
`otelcol_exporter_enqueue_failed_metric_points_total` so queue overflow is visible instead of
silent; one runbook line stating post-outage backfill is out of scope. Revisit trigger:
`RemoteWriteStalled` firing repeatedly in a quarter, or an owner request for gap-free staff history.

## 5. `search_data_cache` re-ratification (RULING)

**Ruling: the D-4 global-share ratification does not survive unrelated tenants — re-scope the cache
per root, now, while it costs zero.** The table is the estate's single no-RLS exemption
(`0034:418-437`): key `kind|provider-class|norm(query)|engine|locale|location`, payload = purchased
vendor market data. Under one owner all sharing was self-dealing. Under SaaS three things change:
(1) `backlinks`/`competitors`/`ai_visibility` keys are **domains and brands** — a customer's
client list is written into a shared table's keys ("no client identifiers" stops being true the
moment a domain identifies someone else's client); (2) serving vendor data purchased by customer A
to customer B is a **vendor-license** question we currently cannot answer; (3) the sales-call answer
to "is any table shared between customers?" must be an unqualified no. Mechanics: add
`root_scope uuid NOT NULL REFERENCES companies(id)` (must be a root row), PK becomes
`(root_scope, cache_key)`, `cache.ts` — the single reader/writer — passes the requesting tenant's
root (O(1) via MON-00a's `root_company_id`), backfill existing rows to DnA's root, keep no-RLS (the
pre-tenant-context read constraint stands; scoping is an ordinary WHERE — honestly an
application-discipline boundary, acceptable because there is exactly one reader and it gets a pinned
cross-root cache test). Cost today: **zero** — one root exists, so no dedup is actually lost; the
isolation only "costs" money in exactly the future where it is mandatory. The ledger's
`sumGlobalMonthToDate` cross-tenant scalar (operator wallet ceiling) is explicitly ratified as
remaining cross-root — different table, operator concern, pinned by `ledger.test.ts`. Future owner
option, recorded not asked: re-sharing the pure-keyword kinds (`volume`, `suggestions`) across roots
for vendor-cost savings is possible *after* a vendor-license verification.

---

## 6. Tickets

Default model = seat default (Sonnet; Haiku for junior). Opus flagged only where a cheap first run
would likely be wasted.

| # | Ticket | Tier | Model·effort | Depends on | Done when |
|---|---|---|---|---|---|
| 1 | **MON-00a** root anchor: `companies.root_company_id` (+triggers: derive-on-insert, cross-root re-parent raises, cycle cap) + `users.home_company_id` + backfills; migration aborts with a report if any user's memberships span roots | senior-db | **opus·medium** — live-estate core-table migration with real data-integrity risk | — | applies clean on a prod-schema copy; recursive-CTE comparison shows 0 mismatched roots; re-parent across roots raises; all users anchored |
| 2 | **MON-00b** Wall 1: `withTenants` single-root assert + `opts.crossRoot` + lint extension; `relay.ts`/`ledger.ts` opt-ins with justifications; `principal.rootCompanies` assembly; `GET /rollups` root-bounded + tenant-carrying authorize | senior-be | seat default | 1 | assert throws on two roots, passes on one; `lint:withtenants` green with exactly the two new entries; `principal-perf.db.test.ts` still green |
| 3 | **MON-00c** Wall 2: `inRoot` in `_variables.yaml`; every `group_executive` rule gains `&& variables.inRoot`; revise IAM-TRAP4 pins (zero-membership ALLOW **within** root preserved, cross-root DENY added); Cerbos restart + live probes | senior-be | **opus·medium** — security-critical policy sweep with a pinned-test reversal; a silent-DENY mistake looks exactly like a logic bug | 1, 2 | 12+ live probes: exec ALLOW in-root / DENY cross-root on all five monitor kinds + rollup; trap4 suite green in revised form |
| 4 | **MON-00d** the failing suite `src/rbac/cross-root-boundary.db.test.ts` as specified in §1.4 (authored first; blocks 3 and 5 red against pre-fix code; merge gate for the board) | qa | seat default | 1 (fixtures) | all 7 blocks green with walls in place; canary scan + positive controls present; suite fails when Wall 2 is reverted (mutation check) |
| 5 | **MON-00e** CI job: Postgres + Cerbos services running the cross-root + monitoring db-suites, failing on skip | devops | seat default | 4 | CI red if the suite skips or fails; documented in tracker |
| 6 | **MON-00f** deny cross-root `service_assignments` (propose-time validation + reconciler assert) | senior-be | seat default | 1 | cross-root propose → 422; reconciler assert covered by test |
| 7 | **MON-00g** docs: PERMISSION-CONTRACT.md `group_executive` root-bound note; blueprint §1.2/§13 updates; MODULES changelog | junior | seat default (haiku) | 3 | docs match shipped behavior |
| 8 | **SDC-1** `search_data_cache` per-root: migration (`root_scope`, PK change, backfill) + `cache.ts` keying + cross-root cache test + D-4 comment update | senior-db + senior-be | seat default | 1 | cache read with root-A scope never returns a root-B row (pinned test); dispatch/incurred-cost suites green |
| 9 | **MON-09n-a** cAdvisor: append `disk` to `--disable_metrics` (keep v0.49.1 defaults), verify per-container series | devops | seat default | — | `count(container_last_seen{name!=""})` ≈ running containers on remote Prometheus; error spam gone |
| 10 | **MON-09n-b** *(only if 9 fails)* `docker_stats` receiver on the existing collector; dashboard rename; retire cAdvisor after parity | devops | seat default | 9 | per-container CPU/mem/net queryable; dashboard panels updated; cAdvisor removed |
| 11 | **MON-09o-a** explicit `docker rmi` of relocation orphans + dup tags (list generated on-box; verify both tags' merged compose reference nothing removed; NEVER prune) | devops | seat default | — | ~2.8 GB reclaimed; both tags still start via `--dry-run` rollback plan |
| 12 | **MON-09o-b** `release.yml` registry layer-cache (`cache-from`/`cache-to`) | devops | seat default | — | second consecutive tag of an unchanged component adds <5% of its size on the box |
| 13 | **MON-09o-c** image diet: `report-renderer` ≤ 2 GB first, then the four Node images multi-stage | medior | seat default | — | per-tag app set ≤ 4 GB; PDF render e2e still green |
| 14 | **MON-09p-a** queue sizing (~15 min measured throughput) + `enqueue_failed` increase alert + runbook line "no post-outage backfill" | devops | seat default | — | alert loaded remotely and probe-verified both directions (fires on synthetic increase, silent otherwise) |

Sequence: 1 → (2, 3 in parallel) → 4 → 5 gates the cross-client board before any second tenant;
6–8 ride the same wave; 9–14 are independent Plane A work.

## 7. Owner questions — BOTH ANSWERED 2026-08-20

> **Q1 → (b) NO RESIZE. Reclaim instead.** Proceed with tickets 11–13: explicit `docker rmi` of the
> relocation orphans (never a prune — 34 containers of live production on that box), registry
> layer-cache in `release.yml`, and the `report-renderer` image diet. Target ~75% with
> `DiskSpaceLow` as the standing guard. Do NOT re-open sizing without new evidence; if the box
> crosses the alert threshold again after the diet, that is new evidence and worth re-asking.
>
> **Q2 → (b) YES, PLANNED.** A company in the holding *will* provide shared services to a SaaS
> customer's company inside the ERP. **This overturns the recommendation in §1** and is the more
> expensive answer, so record what it costs:
>
> - Ticket 6 ("hard-deny cross-root service assignments") still ships **first and unchanged**. A
>   deny-by-default wall is the only safe starting point, and every exception must be carved out of
>   a wall that already exists rather than bolted onto an opening.
> - MON-00's invariant is now "no cross-root data flow **except through an explicit, consented,
>   audited service assignment**" — strictly harder than the blanket rule the rulings assume.
>   §1's enforcement design stands as written; what changes is that Wall 1's `crossRoot` escape
>   hatch becomes a *product feature* with a permission and a consent record, not just a
>   lint-allowlisted internal.
> - **This must be specced and reviewed before tenant #2 onboards**, not at the point of first sale.
>   Consent needs a record with a grantor, a scope, and a revocation path; the audit trail has to
>   name both roots; and Cerbos needs a rule that can cross roots deliberately without reopening the
>   `group_executive` hole §1 exists to close.
> - Deliberately NOT designed here: this answer arrived after the rulings were written, and
>   inventing a consent model in a footnote is how a security boundary acquires a quiet exception.
>   It gets its own ticket (**MON-00h**) and its own review.

## 7b. The original questions, for provenance

- **Q1 — disk spend:** grow `gda-aicenter`'s 49 GB disk given a disk-full has already rolled back a
  release — (a) resize to ~100 GB now (**recommended**: cheapest insurance, typical VPS delta
  ~$5–15/mo), (b) no resize — accept running ~75% after tickets 11–13 land with `DiskSpaceLow` as
  the guard, (c) resize larger (~150 GB) if you want headroom for future modules on this box.
- **Q2 — cross-root servicing as product:** will a company in your holding ever provide shared
  services to a SaaS customer's company *inside the ERP* — (a) no, hard-deny cross-root service
  assignments (**recommended**; ships as ticket 6 regardless, and this stays permanent), (b) yes,
  planned — then a designed, consent-gated cross-root exception must be specced before tenant #2
  onboards (it changes MON-00's invariant and needs its own review).

## 8. Prior decisions touched

| Prior decision | Disposition |
|---|---|
| D-4 (shared no-RLS `search_data_cache`, owner-ratified) | **Superseded in part** by §5 — the owner asked for re-examination; core D-4 claims (provider-layer-only, no secrets) stand, global sharing does not |
| IAM-TRAP4 pin (exec ALLOW, zero memberships, any tenant) | **Intent preserved, reach superseded** — `inRoot` uses `rootCompanies`, not memberships; suite revised in ticket 3 |
| Blueprint §13.1 "group_executive reads, not inTenant-gated" | Gains the root bound (ticket 3) |
| D-7 (`group_executive` obsolete, Phase 3 removal) | **Respected** — the bound is policy-side and cheap, not a grant-model rework; D-8 `owner` inherits `inRoot` |
| D-UX-2 fan-out rule | **Generalized** — fan-out sets are now root-bounded by construction (Wall 1) |
