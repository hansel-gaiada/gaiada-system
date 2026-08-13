# IAM-GAP-02 — the owner's correction to the invoice approval design, self-approval hole closure, and revision tracking

**Status:** PROTOTYPED / DEV-VERIFIED (targeted suites below, `cerbos compile`, `npm run
typecheck`, `lint:withtenants`, `lint:migration-rls`, live probes against a restarted
`gaiada-test-cerbos`, and `app.inject` end-to-end tests against real Postgres + Cerbos). **Not
committed, not pushed, not deployed** — tree left dirty per this ticket's own constraint; the
owner reviews and commits. No full `npm test` was run (shared test-Cerbos container) — every
suite below was run explicitly by name.

---

## 1. Files touched

**New:**
- `platform-nest/migrations/0108_iam_gap_02_invoice_self_approval_deny_and_revisions.sql`
- `platform-nest/src/modules/billing/invoice-revisions.ts` (shared snapshot/record helpers)
- `platform-nest/src/core/contracts-invoice-payment-revision.test.ts` (the THIRD write path had no
  test file at all before this ticket)
- `docs/superpowers/plans/2026-08-13-iam-gap-02-report.md` (this file)

**Modified — Cerbos policy:**
- `platform-nest/cerbos/policies/resource_invoice.yaml` — new `EFFECT_DENY` rule on `approve`
  (the self-approval hole, Part 2); a long comment on the existing `approve` ALLOW rule stating
  the "related manager" interpretation plainly (Part 1, no rule change). `src/rbac/cerbos.ts` and
  `permission-catalog.json` are **untouched** — no new attribute, no new catalog key, no bundle
  regeneration needed for either Part 1 or Part 2.

**Modified — handlers:**
- `platform-nest/src/modules/billing/billing.controller.ts` — `updated_by` written on every
  mutation; revision recorded in `create()`/`setStatus()`/`approve()`; GET/list response gains
  `updatedBy`.
- `platform-nest/src/core/contracts.controller.ts` — the ONE other place `invoices.status` moves
  (`decidePayment()`'s confirmed-payment → `paid` transition): `updated_by` + revision recording
  wired in, guarded by the UPDATE's actual `rowCount` so a no-op (void invoice, already-paid) never
  fabricates a revision.

**Modified — tests:**
- `platform-nest/src/core/billing.test.ts` — new `platformAdmin`/`groupExec` fixtures (global
  scope); new `describe("invoice approve — the self-approval hole, elevated roles (IAM-GAP-02)")`
  (2 cases, each also proving non-regression on a DIFFERENT invoice); new
  `describe("invoice revision tracking (IAM-GAP-02)")` (3 cases: create→edit→approve chain,
  approve-specific actor attribution, and a denied self-approval leaving NO revision row).
- `platform-nest/src/core/contracts-invoice-payment-revision.test.ts` — new file, 3 cases covering
  the payment-confirmation write path: full payment → `paid` + 1 revision; partial payment → no
  status change + 0 revisions; void invoice + full payment → status unchanged + 0 revisions (with
  a flagged pre-existing quirk, see §7).

**Modified — docs:**
- `docs/PERMISSION-CONTRACT.md` §9 — closes IAM-GAP-01's filed hole #1 (self-approval), records
  the "related manager" interpretation, records the revision-tracking addition, and gives an
  honest account of the stuck-draft investigation (no live-DB access this session; a general
  recovery rule shipped instead of a one-row fix).
- `docs/FRONTEND-BFF-CONTRACT.md` — amended the existing `.../invoices/:invoiceId/approve` row
  (self-approval hole now closed for elevated roles too — no contract/shape change) and added one
  new data-layer-only row for the `updatedBy` field / revision capture (explicitly: no new read
  endpoint, deferred by the ticket).
- `docs/MAP.md` — regenerated (`node scripts/gen-map.mjs`); picked up the new migration head
  (`0108`, next free `0109`) and, incidentally, unrelated concurrent-session drift already present
  on disk (two new `/monitoring/*` UI routes, an `alertmanager` port publish) — not touched or
  reviewed by this ticket, same "regeneration reflects the filesystem as it is" behaviour
  IAM-GAP-01's own report flagged.

**Deliberately NOT touched (per the ticket's constraints):** `principal.ts`,
`scope-constrained-roles.*`, `admin-identity.controller.ts`, `resource_portal.yaml`, HR policies,
`platform-ui/`. Also not touched: `permission-catalog.json` / bundle regeneration (nothing to
regenerate — no new grantable key), `derived_roles.yaml` (considered and rejected for Part 1's
tighter-relation option — see §2).

## 2. Part 1 — what "related" resolved to, and why

**No code or policy-rule change.** The owner's words confirm, not narrow, IAM-GAP-01's shipped
approver set: `company_admin`/`manager` (department-manager tier) plus `platform_admin`/
`group_executive` ("due to the nature of account specification" — the existing wildcard). What
changed is documentation: `resource_invoice.yaml`'s `approve` ALLOW rule now carries a long
comment stating PLAINLY what "related" resolves to in this implementation, per the ticket's own
instruction not to silently equate "related" with "any manager in the tenant."

**Resolution: same-company `manager`** — `derived_roles.yaml`'s existing `manager` derived role at
`g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId`. This is exactly what
the rule already granted before this pass; nothing narrowed or widened.

**Why a tighter client/project relation was NOT implemented, checked concretely:**
- `invoices` carries only `client_id` (`0021_invoices.sql`). Its line items are computed at
  creation from `time_entries` across the client's projects — **potentially multiple projects, one
  line per project** (`billing.controller.ts::create()`'s aggregation query) — and frozen as JSONB
  `{description, hours, rate, amount}`. `description` is the project's **name**; no `project_id` is
  persisted per line. There is therefore no per-invoice project identifier this policy could check
  against `manager`'s existing project-scope branch
  (`g.scopeType == "project" && g.scopeId == request.resource.attr.projectId`) — that attribute is
  simply never populated for invoices today (`billing.controller.ts`'s `authorize()` calls never
  pass `projectId`).
- `clients` (`0001_core.sql`) has no manager/account-owner column at all — checked directly,
  confirmed absent.
- `projects` has `owner_id`, but that is an arbitrary PM-tool assignee field, not a Cerbos grant
  scope — it cannot be compared against `request.principal.attr.grants` without inventing a second
  lookup Cerbos's resource-attribute model doesn't carry.
- Making this tighter would require either (a) a schema change (persist `project_id` per invoice
  line, or a `projectIds` array) plus widening `manager`'s own derived-role condition from equality
  to array-containment — a role shared by ~30 other resource kinds, so touching its shape belongs
  with an architect/schema decision, not a policy-only pass — or (b) inventing a client-level grant
  scope that doesn't exist in this program's scope-cascade model at all. Both are bigger than this
  ticket's authorized surface.

**Conclusion, stated plainly per the ticket's instruction:** the implemented "related" is "any
manager holding a company-scope grant for this invoice's tenant" — i.e., structurally identical to
"any manager in the tenant." Flagged for the owner to tighten (e.g. by capturing `project_id` per
invoice line in a future ticket) if narrower scoping was intended.

## 3. Part 2 — the self-approval hole, and proof it beats the wildcard for BOTH roles

**The hole (IAM-GAP-01 report §4.5/§12.2):** `resource_invoice.yaml`'s top rule —
`actions: ["*"]`, `derivedRoles: ["platform_admin", "group_executive"]`, **no condition** — sat
above the maker/checker `approve` rule and granted `approve` unconditionally. Either role could
approve an invoice it created itself, defeating the owner's two-person rule ("1 superadmin + 1
owner" — being IN the approver set must never mean being able to approve your OWN invoice).

**The fix — a new, second rule on the SAME action:**

```yaml
- actions: ["approve"]
  effect: EFFECT_DENY
  roles: ["user"]
  condition:
    match:
      expr: >-
        has(request.resource.attr.creatorId) && request.resource.attr.creatorId != "" &&
        request.resource.attr.creatorId == request.principal.id
```

`roles: ["user"]` (not `derivedRoles`) matches **every** principal — `cerbos.ts`'s
`principalPayload()` sets the base role `"user"` unconditionally for every caller, elevated tiers
included. Cerbos combines a kind's matching rules with **deny-overrides** semantics: if ANY rule
matching the requested action evaluates `EFFECT_DENY`, the final decision is DENY regardless of how
many `EFFECT_ALLOW` rules also matched — wildcard included. That is the mechanism that makes this
"cannot be walked around" rather than "one more condition to remember to copy onto a future rule."

**Proof it beats the wildcard, live Cerbos probes** (`gaiada-test-cerbos`, cleanly restarted,
health=`healthy`, no policy-load errors in logs — restart confirmed via
`docker inspect --format '{{.State.StartedAt}}'` immediately preceding every probe run below):

```
── the hole being closed ──
DENY   platform_admin approving OWN invoice (creatorId===principal.id)
DENY   group_executive approving OWN invoice (creatorId===principal.id)
DENY   company_admin approving OWN invoice (already denied since IAM-GAP-01 — non-regression)
DENY   manager approving OWN invoice (already denied since IAM-GAP-01 — non-regression)

── the DENY must not over-fire ──
ALLOW  platform_admin approving a DIFFERENT user's invoice
ALLOW  group_executive approving a DIFFERENT user's invoice
ALLOW  company_admin (not creator) approving
ALLOW  manager (related, same-company, not creator) approving

── unknown-creator rows (fail-closed check, must be unaffected by the new DENY) ──
DENY   company_admin (not creator) on UNKNOWN-creator row — still DENIED (fail-closed, unchanged)
DENY   manager (not creator) on UNKNOWN-creator row — still DENIED (fail-closed, unchanged)
ALLOW  platform_admin on UNKNOWN-creator row — pre-existing wildcard bypass, UNCHANGED by this ticket
ALLOW  group_executive on UNKNOWN-creator row — pre-existing wildcard bypass, UNCHANGED by this ticket

── cross-tenant / low assurance ──
DENY   cross-tenant company_admin — DENIED
DENY   low-assurance company_admin (not creator) — DENIED
```

**⚠ Flagged explicitly, not silently decided:** the ticket's own VERIFY section says "unknown-
creator row DENIED for everyone" — read literally, that would mean narrowing the wildcard's
existing (separately flagged, pre-existing, IAM-GAP-01 §4.5) ability to approve a legacy row with
no recorded creator. Part 2's own body text scopes the DENY to "the principal IS the creator," not
to "unknown creator" — those are different rows entirely (a legacy row's `creatorId` is empty, so
it can never equal any `principal.id`, known or not). I implemented Part 2 exactly as its body
text specifies (creator === approver, for everyone) and left the wildcard's unknown-creator reach
untouched, because narrowing it was never asked for as a DENY condition and doing so unprompted
would be a second, unrequested policy change riding on this ticket. **If the owner did intend the
wildcard to lose its unknown-creator reach too, that is a one-line follow-up** (drop the two
`actions: ["*"]` roles from bypassing `approve` specifically, or extend the DENY to also fire on an
empty `creatorId`) — flagged here rather than guessed at.

**Adversarially proven end-to-end**, not just via Cerbos probe (`src/core/billing.test.ts`,
`"invoice approve — the self-approval hole, elevated roles (IAM-GAP-02)"`): platform_admin and
group_executive each create a real invoice through the HTTP API, are 403'd approving that SAME
invoice, and are then proven to still 200 approving a DIFFERENT invoice — the DENY does not
over-fire into a blanket lockout for either tier.

**Structural, not a mirror hazard:** the DENY has no `derivedRoles`, so it is invisible to
`iam-215-boundary-pin.test.ts`'s and `role-permission-parity.db.test.ts`'s reach computations
(both explicitly skip non-`EFFECT_ALLOW` rules AND only count rules naming a role via
`derivedRoles` — this is the FIRST `EFFECT_DENY` rule in the repository, and it satisfies both
detectors' pre-existing "zero-EFFECT_DENY invariant" comments by construction, not by luck).
Confirmed unaffected by running both suites (§8).

## 4. Part 3 — revision schema, snapshot-vs-diff justification

**Schema (migration `0108`):**
- `invoices.updated_by uuid REFERENCES users(id)` — the last actor to mutate the row.
- `invoice_revisions` — one row per mutation: `id, tenant_id, invoice_id, actor_id (nullable — see
  below), action (CHECK'd enum), before_snapshot jsonb (nullable — null only for 'created'),
  after_snapshot jsonb (never null), changed_fields text[], occurred_at`.

**SNAPSHOT, not diff.** Forensics needs to answer "what did this look like before that edit" for
ANY single edit in isolation. A diff-only design (store only what changed) requires replaying every
prior revision, in order, to reconstruct state at any point — one missing or corrupt revision
breaks reconstruction for every edit after it, permanently. A full before/after snapshot per
mutation is self-contained: any ONE revision row answers both "before" and "after" with zero
dependency on any other row in the table. `changed_fields` is a derived, human-skimmable
convenience computed FROM the two snapshots at write time — it is never authoritative and is never
used to reconstruct state, only to skim "what moved" without a manual JSON diff. The storage cost
(a few KB of JSON per mutation, on a table with a handful of writes per invoice's lifetime) is
trivial next to what a broken forensic chain would cost.

`actor_id` is nullable ONLY for the one-time `baseline_pre_revision_tracking` marker this migration
inserts for every pre-existing invoice (§6) — every revision produced by the RUNNING application
always carries a real, authenticated actor; a live write path with no principal would be a bug, not
a case this schema is designed to accommodate.

FORCE RLS + `tenant_isolation`, mirroring `0075`/`0105`'s NULLIF-hardened form (not `0021`'s
original — the NULLIF guard matters: an unset GUC reads as `''`, and `string_to_array('', ',')`
casts to a `uuid[]` ERROR without it, not a harmless empty match). `npm run lint:migration-rls`
scanned 107 migrations (54 enforced, up from 53) and reported clean.

## 5. Part 3 — the FULL list of invoice write paths, and coverage per path

Enumerated via `grep -rn "INTO invoices\|UPDATE invoices\|DELETE FROM invoices" src --include=*.ts`
(excluding tests), then independently confirmed there is no `DELETE`/soft-delete path for invoices
at all (`grep -n "@Delete\|deleted_at = now()"` on both files below returns nothing):

| # | Write path | File | Covered? |
|---|---|---|---|
| 1 | `create()` — `POST /api/:t/invoices` | `billing.controller.ts` | ✅ revision `action='created'`, `before=null`; `updated_by` set to the creator at INSERT time |
| 2 | `setStatus()` — `PATCH /api/:t/invoices/:id` | `billing.controller.ts` | ✅ revision `action='status_changed'`; snapshot taken BEFORE the UPDATE, inside the same `withTenants` transaction |
| 3 | `approve()` — `POST /api/:t/invoices/:id/approve` | `billing.controller.ts` | ✅ revision `action='approved'`; snapshot re-taken inside the mutating transaction (not reused from the earlier, separate pre-`authorize()` SELECT, so a race between the two cannot corrupt the "before" state) |
| 4 | `decidePayment()`'s conditional `status='paid'` transition | `contracts.controller.ts` | ✅ revision `action='paid_via_payment_confirmation'`, gated on the UPDATE's own `rowCount` so a no-op (void invoice, already `'sent'`→already-paid) never fabricates a revision for a mutation that didn't happen — previously had **zero test coverage of any kind**, now has a dedicated file |
| 5 | `src/seed/agency.ts` — dev/test bootstrap INSERT | seed script | ❌ **deliberately not wired** — no authenticated principal exists at seed time; fabricating an actor would be worse than an honest gap |
| 6 | `src/seed/portal-workspace.ts` — dev/test bootstrap INSERT | seed script | ❌ **deliberately not wired**, same reasoning |

Read-only references (`portal-commerce.controller.ts`, `portal-workspace.controller.ts`,
`portal-live.service.ts`, `webdev-change-requests-portal.controller.ts`, `cerbos.ts`) were checked
and confirmed to contain no `INSERT`/`UPDATE`/`DELETE` against `invoices` — listed for completeness,
not because any of them needed wiring.

**Partial-capture risk, addressed directly:** paths 1–4 are the entire set of ways a RUNNING
instance of this application can mutate `invoices`; all four are now covered, independently
`app.inject`-tested, not merely reasoned about. Paths 5–6 are a KNOWN, STATED exclusion (dev/test
bootstrap data with no actor), not a silent gap — and the baseline-marker mechanism (§6) makes that
exclusion visible in the data itself rather than reading as an empty, indistinguishable-from-
untouched history.

## 6. Part 4 — the stuck draft: what I could and couldn't determine

**No live-database connectivity from this session** (per program norms — "Local stack OFF, server
is truth" — the live 12-invoice estate lives on `gda-aicenter`, not reachable from this sandbox).
I could not directly inspect which of the 12 rows is the stuck draft, nor confirm whether the
recovery below actually resolves it.

**What I determined structurally:** `billing.controller.ts::create()` has called
`writeActivity(tenantId, req.principal.userId, "created", "invoice", id, ...)` since before this
ticket (unrelated to the `created_by` column's own history) — `activities.actor_id` records the
SAME fact `created_by` was always meant to capture, just in a different, older table.
`created_by IS NULL` invoices that went through the real API therefore likely have a genuine,
recoverable signal; ones created before the `activities` writeActivity call existed, or via a seed
script, do not.

**What migration `0108` does about it — general, not row-specific:** for every invoice with
`created_by IS NULL`, it looks for `activities` rows with `verb='created'`,
`target_entity_type='invoice'`, matching `target_entity_id`, and a non-null `actor_id`. It backfills
`created_by` **only when EXACTLY ONE distinct actor** claims that invoice's creation — an ambiguous
(multiple distinct actors — should never happen for a single creation event, but guessing would be
worse than NULL) or absent signal leaves the row untouched. This is recovery of a real recorded
fact, not invention — the same standard `created_by`'s own no-backfill decision in IAM-GAP-01
already set.

**The fail-closed rule is untouched either way.** A row that still has `created_by IS NULL` after
this migration runs remains permanently unapprovable by `company_admin`/`manager`, exactly as
IAM-GAP-01 designed — only the `platform_admin`/`group_executive` wildcard can still approve it
(and, per §3, still cannot approve it if IT happens to be the (unknown) creator — moot here since
an empty `creatorId` can never equal a real `principal.id`).

**Operator step, if the migration reports zero recovered for the specific stuck row:**
```sql
-- Run as the platform_owner/migrator role, NOT the app role (invoices carries FORCE RLS):
SELECT set_config('app.current_tenant_ids', '<the row''s tenant_id>', false);
UPDATE invoices SET created_by = '<a real user id — the actual creator, if known by other means>'
 WHERE id = '<the stuck row''s id>' AND created_by IS NULL;
```
No restart needed — this is a data change, not a policy change. The row becomes approvable by
`company_admin`/`manager` on the caller's very next request.

**What the owner/devops seat should do when this migration actually runs against production:** read
the `RAISE NOTICE` output (`[0108] created_by recovered from activities log: N row(s)`) to learn how
many of the 12 rows were recovered automatically, and check specifically whether the known stuck
row is among them.

## 7. A pre-existing quirk noticed while adding test coverage (not fixed, flagged)

`contracts.controller.ts::decidePayment()`'s response field `invoicePaid` is computed purely from
`confirmed-ledger-sum >= total - tolerance`, **not** from whether the guarded `UPDATE ... WHERE
status='sent'` actually matched a row. So confirming a payment that fully covers a `void` invoice's
total returns `{invoicePaid: true}` in the HTTP response even though the invoice correctly stays
`'void'` in the database (the guard operates at the SQL `WHERE` clause, invisible to that response
field). This is **pre-existing behaviour, unrelated to this ticket** — I did not change the
`fullyPaid`/`invoicePaid` computation, only added revision recording gated on the UPDATE's own
`rowCount` (which correctly records zero revisions for this case — the forensic trail is accurate
even though the API response field is misleading). Flagged for a separate ticket; my test
(`contracts-invoice-payment-revision.test.ts`, "a VOID invoice is never resurrected...") asserts the
ACTUAL behaviour and documents the discrepancy inline rather than silently asserting around it.

## 8. Gates run (targeted only — no full `npm test`, per instruction)

Baseline comparison throughout: IAM-GAP-01's own report (HEAD at `a9cb210` for that session). This
session started at `f597770` (already at-or-after the ticket's required `9963d16`); the shared
checkout's HEAD advanced to `e7327cc` DURING this session from unrelated concurrent commits
(social/observability work, none of it touching billing/invoices/rbac) — expected behaviour in a
shared checkout (HEAD moves under you; it does not affect uncommitted working-tree diffs). No
suite below was red before my edits — every count matches IAM-GAP-01's own previously-recorded
baseline exactly (605/605 `src/rbac/`, 196/196 `src/admin/`, 8/8 `org14-preflight-adversarial`), so
nothing here is dismissed as "pre-existing" — every result is a fresh run against my own changes.

| Gate | Result |
|---|---|
| `npm run typecheck` | clean, 0 errors |
| `cerbos compile` (`docker run ghcr.io/cerbos/cerbos:0.54.0 compile /policies`) | exit 0, "0 tests executed", no compile errors |
| `gaiada-test-cerbos` restart + health | clean restart (`StartedAt` confirmed fresh immediately before probing), no policy-load errors in logs, health=`healthy` |
| Live Cerbos probes (§3) | all 15 match expectation |
| `npm run lint:withtenants` | OK — 303 files scanned |
| `npm run lint:migration-rls` | OK — 107 migrations scanned (53 baselined, 54 enforced) |
| `node scripts/generate-role-bundles.mjs --check` | byte-identical (no catalog change this pass) |
| `src/core/billing.test.ts` | 15/15 (was 10/10 pre-IAM-GAP-02; +5 new: 2 self-approval-hole, 3 revision-tracking) |
| `src/core/contracts-invoice-payment-revision.test.ts` (new) | 3/3 |
| `src/rbac/iam-04-reg1-mirror-reach-invariant.test.ts` (unscoped) | 25/25 |
| `src/rbac/permission-arm-hazard-scan.test.ts` | (included in full `src/rbac/` run below) |
| `src/rbac/role-permission-parity.db.test.ts` | 27/27 |
| `src/rbac/permission-catalog.db.test.ts` | 12/12 |
| `src/rbac/` (full, 27 files) | **605/605** — byte-identical count to IAM-GAP-01's own baseline |
| `src/admin/` (full, 18 files, incl. `org14-preflight-adversarial.test.ts`) | **196/196** — byte-identical count to IAM-GAP-01's own baseline |
| `src/admin/org14-preflight-adversarial.test.ts` (individually) | 8/8 |
| `src/modules/billing/` | no dedicated test dir — tests live in `src/core/billing.test.ts` (above), same as IAM-GAP-01 noted |

## 9. Blockers / follow-ups for the owner

1. **The wildcard's unknown-creator reach is unchanged** (§3) — if "unknown-creator row DENIED for
   everyone" in the VERIFY instructions was meant to also narrow `platform_admin`/
   `group_executive`'s reach over a legacy row with no recorded creator (not just close the
   self-approval hole), that is a small, explicit follow-up, not something this pass inferred and
   applied silently.
2. **The stuck draft's actual recovery outcome is unverified** (§6) — this session had no live-DB
   access; the owner/devops seat applying `0108` to production should read its `RAISE NOTICE` output
   to learn whether the specific known row was recovered, and apply the documented hand-fix if not.
3. **A tighter client/project "related manager" relation is not implemented** (§2) — same-company
   `manager` is what shipped; a genuinely narrower relation needs either a schema change (persist
   `project_id` per invoice line) or an architect decision to widen the shared `manager` derived
   role's shape.
4. **No revision-history READ surface** — by design, per the ticket ("build the durable data
   capture now, not an analysis surface"). The data is captured; nobody can query it through the
   API yet. Deferred to the named future session.
5. **Loan decisions, MODULES.md/CHANGELOG.md, and the `/approve` UI** — unchanged carryovers from
   IAM-GAP-01's own blockers list; out of this ticket's scope, not re-investigated here.
