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

## 1b. MON-00i — the client-portal root anchor (RULING + implementation + the reverted-fix's fix)

### 1b.1 The gap

§1 built the boundary for every STAFF principal — `group_executive`'s 46 role-arm rules, 8 split
platform_admin/group_executive rules, and 183 `perm_*` mirrors, all keyed on
`Principal.rootCompanies`, anchored on `users.home_company_id` with a fallback to the roots of
ACTIVE `company_memberships`. It did not cover the estate's other externally-reachable principal
class: **client-portal contacts** (`client_contacts`, `roles: ["client"]`, `derivedRoles: ["client"]`
in `resource_portal.yaml`). Those principals have no `company_memberships` row by design
(`principal.ts`'s own header: putting clients in that table would leak them into every staff
listing) and no `home_company_id` (nothing ever set one — that column exists for employees). Their
`rootCompanies` therefore resolved to `[]`, which — correctly, per the empty-means-deny invariant —
denies them everywhere a root gate is added.

Eight rules in `resource_portal.yaml` were consequently found still conditioned on
`variables.inTenant` ALONE: the `client` role-arm rule itself (`actions: [read, decide, sign, pay,
update_profile, request_change, approve_post]`) and its 7 `perm_portal_*` mirrors
(IAM-04-B7). **Verified in source, not assumed from the ticket brief that named only the 7 mirrors:**
the role-arm rule is the rule a real client actually authorizes through today — `perms` only carries
`portal.*` keys for `client`'s own seed-only bundle, so the mirrors are a second, largely-dormant
path to the identical reach (`resource_portal.yaml`'s own header says so). Gating only the mirrors
and leaving the role-arm rule alone would have closed nothing observable: every real client would
still sail through the untouched rule. Both move together in this ticket.

Two prior attempts to close this (adding `&& variables.inRoot`, then separately `&& variables.notLow`)
were reverted after breaking 15 tests across `iam-04-b7-portal.db.test.ts`,
`iam-04-b7-portal.test.ts` and `can.test.ts` — verified by literally reproducing the regression
(§1b.4): with `inRoot` wired but no anchor, `assemblePrincipal()` gives a real, legitimate client
`rootCompanies: []`, so the added condition denies them in their OWN tenant. The prior attempts
correctly diagnosed the symptom and incorrectly concluded the fix belonged in policy; it belongs in
the principal.

### 1b.2 Ruling — what a client contact's root is, and why

**A client contact's root anchor is the root of the company recorded in its OWN `client_contacts.
tenant_id` — the SERVING company (the agency/customer running this ERP instance), never the
`clients` row (`client_id`, a business-entity record that is not itself a `companies` row and has
no root of its own). A client belongs to whoever serves them, not to a party they merely transact
with.**

This is the only anchor that is available and correct today:

- `client_contacts.tenant_id` is exactly the company whose portal the contact was invited into —
  the relationship the whole authorization chain (RLS, Cerbos, `portal-scope.ts`) already keys on.
  Anchoring the client_contacts fallback on this column, rather than inventing a new one, needs no
  schema change: `companies.root_company_id` (MON-00a) already resolves it in one join.
- **The SaaS non-leak case, worked through explicitly:** customer X (an agency, tenant `tenantX`,
  root `rootX`) serves client C via a `client_contacts` row at `tenant_id = tenantX`. C's anchor is
  `root(tenantX) = rootX`. A portal login for C can therefore only ever satisfy `inRoot` against a
  resource whose `tenantId` sits in `rootX`'s subtree. Customer Y's tenant (`tenantY`, `rootY`) is
  never in that set unless C also holds an independent `client_contacts` row there — i.e. unless C
  is *also, separately* a real client of Y, which is not a leak, it is two real relationships each
  gated on `inTenant` in its own right (see §1b.3's safety argument for why a second root in the
  anchor set still cannot widen anything).
- **This does not assume one tenant per client forever.** The anchor is computed per-request from
  whatever `client_contacts` rows exist for that user at that moment — it is a live derivation, not
  a stored, single-valued field. When MON-00h's consent-gated cross-root servicing ships, a
  deliberately-provisioned second `client_contacts` row (or whatever record that ticket designs) is
  exactly the kind of fact this anchor already knows how to fold in; no rework is implied here. What
  is explicitly NOT built here is the consent record, its audit trail, or a policy rule that crosses
  roots *without* an explicit relationship row — that is MON-00h's remit, untouched.

### 1b.3 Implementation — precedence, not a flat union (`src/rbac/principal.ts`)

`assemblePrincipal()`'s anchor resolution gains a THIRD tier, consulted only as a fallback:

1. `users.home_company_id` ("staff anchor"), unchanged.
2. Roots of ACTIVE `company_memberships` ("staff anchor"), unchanged in intent — see §1b.5 for a
   defect found and fixed in this same code.
3. **NEW.** Only if BOTH of the above are empty: roots of ACTIVE `client_contacts` rows ("portal
   anchor").

**Why precedence and not a plain three-way `UNION`, stated as its own safety argument, not asserted:**
`users.email` is globally unique (platform-nest/CLAUDE.md), so nothing stops the identical `users`
row from being both an internal employee of root A (`home_company_id` or a membership there) AND,
independently, an external portal contact of some unrelated company under root B — a different
agency's staff invited that same email as a client. Unioning root B into that user's
`rootCompanies` would silently widen every OTHER root-gated rule their STAFF roles hold —
`group_executive`'s `inRoot`, and any future one — into a root they merely happen to also be a
portal guest of. That is a real escalation, not a portal-only concern, and precedence closes it: the
portal anchor never fires once a staff anchor exists. Verified live (not asserted): a user with a
`company_memberships` row at root A and, separately, a `client_contacts` row at an unrelated root B
resolves `rootCompanies: [A]` only, never `[A, B]`.

**Why the portal-only case is safe even when its own anchor spans multiple roots** (a pure client,
no staff anchor at all, who happens to be a genuine client_contacts holder at two unrelated
tenants): the portal's only root-gated reach is the 8 `resource_portal.yaml` rules this ticket
touches, and every one of them is `variables.inTenant && variables.inRoot` — never `inRoot` alone.
`inTenant` is independently pinned to the caller's own explicit `client_contacts` rows (`principal.
companies`, unchanged by this ticket). `inRoot` can therefore only ever DENY a request `inTenant`
would have denied anyway (a foreign, unrelated tenant); it can never ALLOW one `inTenant` wouldn't
already have allowed, because `inRoot`'s "any company in this root's subtree" is always strictly
wider than or equal to `inTenant`'s "this exact company" — the AND of the two is at most as wide as
`inTenant` alone. A flat union across multiple portal roots is therefore safe by construction, and
only the staff/portal cross-contamination case (previous paragraph) needed the precedence rule.

`resource_portal.yaml`'s `client` role-arm rule and all 7 `perm_portal_*` mirrors now read
`variables.inTenant && variables.inRoot` (previously `variables.inTenant` alone). `derived_roles.
yaml`'s `perm_portal_*` definitions are untouched — the gate lives in the resource-policy rule
condition, matching how `client`'s own rule already carried its condition there.

### 1b.4 Verification — positive controls before the negative, per the estate's standing rule

`src/rbac/mon00i-portal-root-anchor.db.test.ts` (new). Fixtures: `tenantA` (the agency the client is
actually a contact of, its own root) and `tenantB` (an unrelated root, canary-named, zero
relationship to the client). The client holds a `client_contacts` row and a `client` grant at
`tenantA` ONLY — no `home_company_id`, no `company_memberships`, the real shape of every
client-portal principal.

1. **Positive, DB-level:** `assemblePrincipal()` resolves `rootCompanies` containing `tenantA` (not
   `[]`).
2. **Positive, Cerbos-level:** all 7 portal actions ALLOW against `tenantA` for the real assembled
   principal.
3. **Positive, HTTP-level:** `GET /api/{tenantA}/portal/runs` → 200, body contains the client's own
   run marker.
4. **Negative, Cerbos-level:** all 7 actions DENY against `tenantB`.
5. **Negative, HTTP-level:** `GET /api/{tenantB}/portal/runs` → 403/404, raw body scanned for the
   canary string (belt over the status code, same discipline as §1.4's suite).

**This suite was proven to fail against pre-fix code, not assumed to** — this session reverted
`principal.ts` to its pre-MON-00i shape (keeping the already-updated `inRoot`-gated policy) and
re-ran it: the 3 positive-arm tests went red with exactly the shape the two earlier revert notes
describe (`rootCompanies: []`, `cerbos denied read on portal`, HTTP `403` where `200` was expected),
while the 2 negative-arm tests stayed green — for the wrong reason, which is precisely why positive
controls must run first and be trusted before any negative assertion. Restoring the fix turned all 6
green. Exact numbers: see §1b.6.

`iam-04-b7-portal.test.ts`'s two static assertions that pinned the byte-exact string
`"variables.inTenant"` on the role-arm rule and on each of the 7 mirrors are updated to expect
`"variables.inTenant && variables.inRoot"` — they are structural pins on the policy text, and the
policy text changed on purpose; the file's prose is updated alongside so it no longer claims the
role-arm rule is "BYTE-UNCHANGED." `iam-04-b7-portal.db.test.ts`'s hand-built `principal()` helper
(Section 1, live-Cerbos-only, no DB) gains a `rootCompanies = companies` default, the same
single-root-fixture convention already used in `cerbos.test.ts`, `cerbos-permission-dual-match.
test.ts` and `iam-trap4-group-executive-split.test.ts` — omitting it would default to `[]` via
`cerbos.ts`'s `?? []` and deny every ALLOW case in that section for a reason unrelated to what each
test means to exercise. `can.test.ts`'s `principal()` helper needed the identical default for a
DIFFERENT, PRE-EXISTING reason unrelated to portal — see §1b.5.

### 1b.5 A second defect found and fixed in the same code path (not scope creep)

While wiring the client_contacts fallback, this session found and fixed a **live bug in the
already-shipped MON-00c membership-fallback**: `rootCompanies`'s join to `company_memberships` ran
under a bare `withGlobal` call that never set `app.principal_user_id`. `company_memberships` is
FORCE RLS with a `principal_lookup` SELECT policy keyed on exactly that GUC (0001:305,
hardened 0004) — precisely so `assemblePrincipal()` can read it before any tenant context exists.
Without the GUC, the join returned ZERO rows regardless of how many real memberships existed, so the
"anchor from any active membership" fallback the original MON-00c comment describes was dead code
for anyone lacking an explicit `home_company_id`. **Verified live, not inferred:** a user with one
active membership and no `home_company_id` resolved `rootCompanies: []` before the fix; the same
fixture resolves the membership's root after it. `can.test.ts`'s pre-existing 1-test failure
(`pm.task.read` ALLOW via the permission arm) traces to this exact defect — its `principal()` helper
predates the 183-mirror/46-role-arm rollout and never gained a `rootCompanies` default, so its
hand-built literals inherited `[]` the same way a real membership-only user would have. Both are
fixed by the same change: `companies` and `rootCompanies` are now resolved inside ONE transaction
that sets the GUC once, rather than two separate `withGlobal` calls where only one of them did.
Nothing caught this earlier because every fixture that already exercises a root-gated rule
(`cross-root-boundary.db.test.ts`'s execA, the `cerbos-*` matrix files) sets `home_company_id`
directly, which never touches the membership branch at all.

This is not scope creep: the client_contacts fallback this ticket adds reads the identical FORCE-RLS
`principal_lookup` shape and would have shipped with the identical defect — silently anchoring
nothing — had the two queries stayed apart.

### 1b.6 Verification run (2026-08-21)

Env: `DATABASE_URL_TEST` against `gaiada-test-pg-2` (55435), `CERBOS_URL=http://127.0.0.1:3592`
against `gaiada-cerbos-1` restarted immediately before probing (confirmed
`StartedAt` postdates every policy edit in this section — the estate's standing staleness trap).

- `src/rbac/iam-04-b7-portal.db.test.ts` — 23/23
- `src/rbac/iam-04-b7-portal.test.ts` — 19/19
- `src/rbac/can.test.ts` — 21/21 (was 20/21 before this ticket — the pre-existing §1b.5 defect; the
  21st case is a concurrently-added DENY pin for the `rootCompanies: []` shape, unaffected by and
  compatible with this ticket's fix)
- `src/rbac/cross-root-boundary.db.test.ts` — 6/6 (unaffected; portal is out of that suite's scope)
- `src/rbac/iam-215-boundary-pin.test.ts` — 82/82 (static policy-shape pin; unaffected by a
  condition-only edit that adds no rule and no action)
- `src/rbac/mon00i-portal-root-anchor.db.test.ts` (new) — 6/6, and 3/6 (the positive arm) confirmed
  RED against pre-fix `principal.ts` per §1b.4

**157/157 across the five required files plus the new suite. Zero skips** (`DATABASE_URL_TEST` and
`CERBOS_URL` both present for the whole run — a silent skip here would have reported this same "all
green" with nothing actually checked, the estate's standing trap).

**Out-of-scope observation, not fixed here:** a broader `npx vitest run src/rbac` sweep (747 tests,
35 files) run during this ticket showed 2 unrelated failures in
`iam-04-reg1-mirror-reach-invariant.test.ts` concerning `automation_approval.retry`/
`group_executive`. Git status at the time showed dozens of `cerbos/policies/*.yaml` files and
`iam-04-reg1-mirror-reach-invariant.test.ts` itself already modified by a concurrent session in this
shared checkout (ticket 3's Wall-2 rollout, in flight) — none of those files were touched by this
ticket. Flagged rather than silently worked around or fixed, per the shared-checkout discipline:
fixing another in-flight ticket's file from here would itself be the kind of drift that discipline
exists to prevent.

**A second full-sweep observation, checked rather than waved through:** the same sweep also timed
out `principal-perf.db.test.ts`'s end-to-end benchmark (`Test timed out in 20000ms`) — worth
checking directly, since this ticket edits the exact function that test measures (`assemblePrincipal
()`, now one merged transaction instead of two `withGlobal` calls, plus a heavier 3-CTE
`rootCompanies` query). Verified rather than assumed innocent: run in ISOLATION (no sweep
contention), the suite passed 3/3 both with this ticket's `principal.ts` (wall time 31833ms overall,
the timed `it()` block itself 19463ms) and with `principal.ts` reverted to pre-MON-00i HEAD (wall
time 29743ms, the timed block 19047ms) — a ~400ms difference on a ~19s budget, well inside
run-to-run noise (per-call `max` samples alone varied by 40–50ms between the two runs). **This
suite's `it()` block runs at ~19.0–19.5s against its own 20000ms budget in EITHER version** — it was
already this close to its limit before this ticket touched anything, which is a pre-existing thin
margin worth someone's attention (the fix is presumably raising the timeout or trimming
`ITERATIONS`/`WARMUP`, neither of which is this ticket's file to edit), not a regression this ticket
introduced. It only actually times out under the full-sweep's DB/Cerbos contention from concurrently
running 35 files' worth of load against the same shared `gaiada-test-pg-2` — consistent with every
other symptom in this section tracing back to the shared checkout being live-worked by more than one
session, not to this ticket's diff.

### 1b.7 Contract-doc and ticket updates

New ticket **MON-00i** recorded in §6 below as row 15 (appended, not inserted mid-table, so the
existing numeric dependency references in rows 1–14 don't need renumbering in a shared, concurrently
-edited file). It depends on ticket 1 (MON-00a)'s `root_company_id`/anchor infrastructure and is
DONE — implemented and verified in this same session, per §1b.6.

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
| 15 | **MON-00i** client-portal root anchor: `client_contacts`-derived `rootCompanies` fallback (staff-anchor precedence, §1b.3) + `inRoot` on the `client` role-arm rule and its 7 `perm_portal_*` mirrors + fixed the dead membership-fallback RLS/GUC bug found in the same code path (§1b.5) — **DONE**, this session | senior-be | seat default | 1 | §1b.4's suite 6/6, confirmed red pre-fix; iam-04-b7-portal suites + can.test.ts green (157/157 total); zero widening for any staff principal (§1b.3's precedence argument) |

Sequence: 1 → (2, 3 in parallel) → 4 → 5 gates the cross-client board before any second tenant;
6–8 ride the same wave; 9–14 are independent Plane A work. 15 (MON-00i) rode after 1, in parallel
with 2/3, and is done.

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
| IAM-04-B7 pin ("the client role-arm rule itself is BYTE-UNCHANGED") | **Superseded, narrowly** — §1b adds `&& variables.inRoot` to that rule and its 7 mirrors; the pin is revised to assert the new condition string instead, per §1b.4. IAM-04-B7's actual finding (company-scope-only, no global branch, IAM-SEC-06 closes the `client@global` hazard) is untouched — `inRoot` is additive on top of it, not a replacement |

---

## 9. MON-00 closure ruling (2026-08-21) — the mirror-reach invariant vs root gating, and the last live hole

**Author:** system architect · **Scope:** the two failures left after Walls 1–3 landed
(`iam-04-reg1-mirror-reach-invariant.test.ts` 2 failing; `can.test.ts` 1 failing).

### 9.1 Ruling

**The invariant machinery and root gating are reconcilable without weakening either — but only
because one of the five new register entries was a real leak, and it got a policy fix, not a pin.**
The syntactic clause-subset comparator in `findNarrowHolders()` is a *sound but incomplete* witness
of "the mirror implies the role arm". Until MON-00c every role arm in the estate was syntactically
⊆ its mirror, so the incompleteness had never once fired; `variables.inRoot` is the estate's first
condition-narrowed role arm, and the comparator flagged five new `group_executive` entries.
Disposition, per entry, against the file's own doctrine ("growth = a NEW instance of this hazard
shape"):

| Register growth | Mirror's real width vs the exec arm | Verdict |
|---|---|---|
| `checkin.read`, `hr_case.read`, `hr_case.create`, `hr_case.cancel` | Self-scoped mirrors (`inTenant && notLow && subjectUserId == principal.id`) — strictly NARROWER than `notLow && inRoot` | **Not hazard instances.** Comparator false positives; fixed in the comparator |
| `rollup.read` | Mirror had **no condition at all** — a global-scope grant of `core.rollup.read` allowed on ANY tenant in ANY root | **Real instance** — fixed at the responsible policy, exactly as the doctrine instructs |

**The `rollup.read` finding was demonstrated live, not theorised** (estate rule: probe, don't
trust): against the pre-fix policy, a principal shaped like a real assembled exec
(`perms: [core.rollup.read @ global]` — `assemblePrincipal` expands role bundles into `attr.perms`,
so every exec principal carries this — `rootCompanies: [T1]`) received `EFFECT_ALLOW` for
`rollup.read` at a tenant in a FOREIGN root. This is leak chain #2 of §1.2 surviving through the
**permission arm** after Wall 2 closed the role arm. Root cause of the miss: the 183-mirror inRoot
sweep *appended* `inRoot` to each mirror rule's existing condition, and this was the estate's only
mirror rule with no condition line — nothing to substitute into. A sweep by substitution is blind
to the empty case; the static invariant caught it the moment the exec's arm became narrowed, which
is the invariant doing precisely its job.

### 9.2 What shipped

1. **`cerbos/policies/resource_rollup.yaml`** — `perm_rollup_read`'s rule gains
   `condition: variables.inRoot`. `inRoot` alone, deliberately: it is the sweep's own
   transformation applied to an empty clause list; rollup's pinned design has no `notLow` floor
   (`iam-verify-02.low-assurance.test.ts`) and no membership gate (it is the
   cross-company-within-root surface); the derived role's scope check already pins company-scoped
   grants to their one company, so `inRoot`'s only effect is bounding global-scope grants to the
   holder's own root — MON-00's invariant verbatim. Post-restart probes: exec-shaped perm-arm
   read in own root **ALLOW**, foreign root **DENY** (was ALLOW), anchored company-grant holder
   **ALLOW**, unanchored (`rootCompanies: []`) **DENY**.
2. **`src/rbac/iam-04-reg1-mirror-reach-invariant.test.ts`** — the comparator gains exactly ONE
   implication axiom (`clauseSatisfiedByMirror`): a mirror clause `variables.inTenant` satisfies a
   role-arm clause `variables.inRoot`, never the reverse. Soundness (argued in full at the
   function): MON-00a aborts on root-spanning memberships and anchors `home_company_id` from
   memberships, so for every anchored principal memberships ⊆ rootCompanies (inTenant ⇒ inRoot
   pointwise); the one shape where the implication fails (membered but unanchored) cannot smuggle
   cross-root reach because every mirror the axiom can mask is itself inTenant-gated (single-root
   reach by the span-abort) while the inRoot-gated role arm fails closed. The **baseline register
   is byte-identical** — nothing was widened. Two new TEETH proofs pin the axiom: an unconditioned
   mirror (the exact live rollup shape) still flags a root-gated holder, and the implication is
   one-directional (an inRoot-gated mirror never satisfies an inTenant-gated arm). Deliberate
   restraint, recorded in-file: the comparator does NOT learn `assurance=="high" implies notLow`,
   because that would silently shrink baseline entries other tickets own (`hr_case.export`).
3. **`src/rbac/can.test.ts`** — verdict on the B question: the fixture-helper fix
   (`rootCompanies` parameter defaulting to `companies`) **is** the right answer; the failing
   assertion's intent ("perm arm alone allows, in-tenant") fully survives the boundary — an
   in-tenant, in-root allow was never meant to be denied, the fixture was merely pre-anchor-shaped.
   The default is not permissive: it encodes MON-00a's anchored-membership invariant, and
   `companies: []` fixtures still yield `rootCompanies: []` = deny. Adopted, plus one new pin so
   the default can never quietly become "the perm arm works without an anchor": an unanchored
   principal (`rootCompanies: []` explicit) is DENIED via the permission arm **even in its own
   member tenant**.

### 9.3 Verification (all against live infra, 2026-08-21)

- Cerbos `gaiada-cerbos-1` restarted AFTER the policy edit (start time postdates the edit),
  healthy, zero compile errors in logs; decisions probed before and after (the before-probe is the
  leak demonstration above).
- `src/rbac` **in full**: **35 files, 747 tests — 746 passed, 1 failed, 0 skipped** (the zero-skip
  count is load-bearing: every db/Cerbos suite genuinely ran; `DATABASE_URL_TEST` +
  `CERBOS_URL` + unique `TEST_DB_PREFIX` exported).
- The 1 failure is `principal-perf.db.test.ts` › "full end-to-end assemblePrincipal() cost" — a
  20s test-timeout under full-directory parallel load. **Not a decision failure and not from this
  change** (nothing here touches `assemblePrincipal`): in isolation the file passes 3/3 with that
  case at **19.74s of its 20s budget** — the budget is simply spent, post MON-00i's client-contact
  anchor fallback. Handed to a ticket below rather than silenced.
- Key suites: `iam-04-reg1` 27/27 · `can.test` 21/21 · `cross-root-boundary.db` 6/6 ·
  `iam-215-boundary-pin` 82/82 · `cerbos-permission-dual-match` 82/82 (includes the rollup
  perm-arm allow/deny pair against the new condition) · `mon00i-portal-root-anchor.db` 6/6.
- `tsc --noEmit` clean.

### 9.4 Coordination

The 7 `perm_portal_*` mirrors, `resource_portal.yaml`, and every `iam-04-b7-portal*` file were
**left untouched** (concurrent MON-00i session owns them; its in-tree state passed in the full run
above). The uncommitted 183-mirror sweep across 53 policy files is likewise that wave's to commit —
this ruling's changes stand alone and stay green whether or not the sweep is present (the axiom
covers inTenant-carrying mirrors either way; the rollup fix is on a clean file).

### 9.5 Follow-up tickets

| # | Ticket | Tier | Model·effort | Done when |
|---|---|---|---|---|
| 16 | **MON-00j** forward anchor guard: BEFORE INSERT/UPDATE trigger on `company_memberships` raising when the membership's company root differs from the member's `home_company_id` root (anchor-on-first-membership for NULL-home users). **`client_contacts` is explicitly exempt** — a user may legitimately be staff of one root and a portal contact of another (MON-00i's precedence design). Closes the one stated soft spot in §9.2's axiom soundness | senior-db | seat default | cross-root membership insert raises; anchorless-user first membership anchors; existing rbac suites green |
| 17 | **MON-00k** `principal-perf.db.test.ts` end-to-end budget: 19.7s/20s solo, fails under parallel load. Either consolidate the MON-00i anchor queries into the existing single round-trip or re-budget with a written justification — not a silent timeout bump | medior | seat default | full `src/rbac` parallel run green 3 consecutive times; the perf file's own header updated with the measured new baseline |

No owner decision is required for any of the above; §9's rulings sit inside the boundary already
ratified in §1 and Q2.
