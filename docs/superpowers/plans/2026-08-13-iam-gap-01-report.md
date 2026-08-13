# IAM-GAP-01 — invoice maker/checker + the dedicated HR leave decision right

**Status:** PROTOTYPED / DEV-VERIFIED (targeted suites below, `cerbos compile`, `npm run
typecheck`, `lint:withtenants`, `lint:migration-rls`, live probes against a restarted
`gaiada-test-cerbos`, and `app.inject` end-to-end tests against real Postgres + Cerbos). **Not
committed, not pushed, not deployed** — tree left dirty per this ticket's own constraint; the
owner reviews and commits.

**Owner defaults exercised** (per the ticket): the platform superadmin can always act (the
pre-existing `platform_admin`/`group_executive` wildcard on both `invoice` and
`automation_approval` — unchanged, just newly exposed by the two new actions); approval authority
sits with the department-manager tier (`manager` on invoices, `hr_manager`/module_manager on
leave).

---

## 1. Files touched

**New:**
- `platform-nest/migrations/0107_iam_gap_01_invoice_approve_hr_leave_decide.sql`
- `docs/superpowers/plans/2026-08-13-iam-gap-01-report.md` (this file)

**Modified — Cerbos policy:**
- `platform-nest/cerbos/policies/resource_invoice.yaml` — new `approve` action
- `platform-nest/cerbos/policies/resource_automation_approval.yaml` — new `decide_leave` action
- `platform-nest/src/rbac/cerbos.ts` — `Resource` interface + `resourcePayload()`: new
  `creatorId`/`subKind` attributes

**Modified — catalog / bundles / groups (regenerated, not hand-edited, except the two catalog
entries and two group entries which ARE hand-authored per this program's own convention — see
`permission-catalog.json`'s and `permission-groups.json`'s own headers):**
- `platform-nest/src/rbac/permission-catalog.json` — +2 entries (`billing.invoice.approve`,
  `hr.leave.decide`), `_meta.counts` refreshed
- `platform-nest/src/rbac/role-permission-bundles.json` — regenerated via `npm run
  gen:role-bundles` (byte-identical `--check` pass)
- `platform-nest/src/rbac/permission-groups.json` — +2 groups (`invoices_approve`,
  `hr_leave_decide`), `_meta.counts` refreshed
- `platform-nest/src/rbac/scope-constrained-roles.json` — **checked, unaffected** (`npm run
  gen:scope-constrained-roles --check` passed with no diff; neither new action changes any role's
  scope-constraint shape)

**Modified — handlers:**
- `platform-nest/src/modules/billing/billing.controller.ts` — `created_by` on create, gated
  `sent`/`paid` transition, new `POST .../invoices/:invoiceId/approve`
- `platform-nest/src/modules/billing/index.ts` — module contract permission list
- `platform-nest/src/core/automation-approvals.controller.ts` — `decide()` now requests
  `decide_leave` instead of `decide` for `origin='hr' && workflow_id='hr:leave'` rows only
- `platform-nest/src/modules/hr/index.ts` — module contract permission list + comment

**Modified — tests:**
- `platform-nest/src/core/billing.test.ts` — existing draft→sent test updated for the new
  approval gate; new `describe("invoice approve — maker/checker (IAM-GAP-01)")` block (6 new
  cases) plus inline assertions in the updated flow test
- `platform-nest/src/modules/hr/hr.test.ts` — 2 new adversarial cases (hr_staff denied
  `decide_leave`; cross-tenant read denied)
- `platform-nest/src/rbac/cerbos-catalog-alignment.test.ts` — hardcoded sanity count 262→264
- `platform-nest/src/rbac/permission-groups-catalog-parity.test.ts` — hardcoded sanity count
  247→249

**Modified — docs (beyond the two explicitly owned):**
- `docs/PERMISSION-CONTRACT.md` — §2 numbers, bundle-size table, §9 closed/open items (owned, per
  the ticket)
- `docs/FRONTEND-BFF-CONTRACT.md` — new endpoint row + a note on the existing leave-decide row.
  **Not in the ticket's explicit ownership list**, but `platform-nest/CLAUDE.md`'s own standing
  rule ("update the relevant § when you add or change an endpoint the UI consumes") applies
  directly — flagging this as a deliberate, low-risk, additive-only judgment call rather than a
  silent scope expansion.
- `docs/MAP.md` — regenerated (`node scripts/gen-map.mjs`); picked up the new migration head
  (`0107`, next free `0108`) and, incidentally, one **pre-existing, unrelated** drift (the
  `gen:scope-constrained-roles` npm script was already missing from the generated node-scripts
  list before this session touched anything — swept up by regeneration, not something I caused or
  investigated further).

**Deliberately NOT touched:** `docs/modules/MODULES.md` / `CHANGELOG.md`. Judgment call: these are
a large (1518 + 5008 line), chronologically-organized changelog with visible pre-existing
mojibod/encoding artifacts, not in this ticket's owned-file list, and not a "frozen contract" the
CLAUDE.md calls out the way `PERMISSION-CONTRACT.md`/`FRONTEND-BFF-CONTRACT.md` are. Editing it
blind, in a shared checkout, risked more than it was worth for a backend-only IAM ticket. Flagging
for the owner rather than silently skipping.

## 2. Endpoints added/changed

| Method | Path | Change |
|---|---|---|
| POST | `/api/:tenantId/invoices/:invoiceId/approve` | **NEW.** `draft → approved`. Authorizes `billing.invoice.approve`; 403 if the caller is the invoice's own creator OR the creator is unknown; 400 if the invoice is not currently `draft`; 404 if invisible/absent. |
| PATCH | `/api/:tenantId/invoices/:invoiceId` | **CHANGED.** `status:'sent'`/`'paid'` now 400 unless the invoice is currently `'approved'`. `status:'approved'` was never a valid PATCH input and still isn't (only `/approve` can set it). `'draft'`/`'void'` remain reachable from any state, unconditionally. |
| POST | `/api/:tenantId/automation-approvals/:id/decide` | **CHANGED internally, same route/contract.** For `origin='hr' && workflow_id='hr:leave'` rows, now authorizes `hr.leave.decide` (Cerbos action `decide_leave`) instead of `core.automation_approval.decide`. Every other row (loans, automation, agent) is byte-unchanged. |

## 3. GAP 1 — the invoice migration and what happens to existing rows

`migrations/0107_iam_gap_01_invoice_approve_hr_leave_decide.sql`:

- Adds `invoices.created_by uuid REFERENCES users(id)`, `approved_by uuid REFERENCES users(id)`,
  `approved_at timestamptz`.
- Widens the `status` CHECK from `('draft','sent','paid','void')` to `('draft','approved','sent',
  'paid','void')` — dropped/re-added by **discovered** constraint name (`pg_constraint` lookup),
  not a hardcoded guess at Postgres's default-naming convention.
- **No backfill of `created_by`.** There is no reliable historical-actor signal on this table
  (`origin_site` records which deployment wrote the row, not which user) — inventing one would be
  a fabricated audit trail. **Consequence, stated plainly:** every invoice that existed before this
  migration runs has `created_by IS NULL` **forever**, unless an operator sets it by hand.
  `resource_invoice.yaml`'s `approve` rule is written to deny exactly this case — see §5. Only the
  pre-existing `platform_admin`/`group_executive` wildcard rule (unchanged) can still approve a
  legacy row, the same way it already bypasses create/read/update/delete today.
- Seeds the 2 catalog permissions + the 8 machine-derived `role_permissions` bundle pairs (exact
  set difference of `npm run gen:role-bundles` before/after, same provenance discipline as
  migration `0106`). Asserts row counts and the grantable/relationship boundary; no RLS-backfill
  trap applies (no DML against `invoices` at all, only DDL).

## 4. Business-rule defaults chosen, and the alternative rejected — please adjust

1. **Approvers: `company_admin` (a different one) + `manager`.** Rejected: `company_admin` only —
   would leave the owner's stated "department-manager tier" default unimplemented for this gap.
   `manager` previously held ONLY `read` on invoices; this is a deliberate widening.
2. **`sent`/`paid` now REQUIRE `approved` first.** Rejected: leaving `approve` as a bolt-on action
   nobody is forced to use (any `company_admin` could still skip straight from `draft` to `sent`) —
   that would make the "maker/checker seam" purely cosmetic, which is the exact defect the ticket
   describes. `draft`/`void` stay reachable unconditionally (correcting a mistake or cancelling
   outright must never require a checker).
3. **Fail closed on an unknown creator**, per the ticket's own instruction — implemented as `has(
   creatorId) && creatorId != "" && creatorId != principal.id`. Without the non-empty check, an
   unset `creatorId` (`""`, cerbos.ts's own default for an omitted attr) would satisfy `!=
   principal.id` **vacuously** and ALLOW — exactly backwards. Rejected: `has()` alone (this
   program's `Resource` payload always populates every optional attr with `""`, so `has()` by
   itself proves nothing here — the non-empty check is load-bearing, not decorative).
4. **No `perm_invoice_approve` permission-arm mirror.** The condition is a resource-instance check
   (creator ≠ approver) that `0094`'s bundling methodology treats as "satisfied" when computing a
   role's reach — mirroring it would grant `approve` to a company_admin/manager who IS the
   creator. Same doctrine as `resource_hr_case.yaml`'s excluded self-only mirrors (IAM-04c).
5. **`group_executive` also bypasses the creator check**, via the PRE-EXISTING wildcard rule
   (`actions:["*"]`, `["platform_admin","group_executive"]`) at the top of `resource_invoice.yaml`
   — unchanged by this ticket, just newly exposed by the new action. Flagging loudly: the owner's
   stated default was "platform superadmin can always act", not "platform superadmin AND
   group_executive" — if that's not intended for invoices specifically, it predates this ticket
   and is a separate, pre-existing scoping decision to revisit, not something IAM-GAP-01 changed.

## 5. Fail-closed proof for unknown creators (GAP 1) — live Cerbos probes

Against a freshly-restarted `gaiada-test-cerbos` (verified clean restart, no policy-load errors,
health=`healthy`), `POST /api/check/resources`, action `approve` on kind `invoice`:

```
creator (company_admin) approving OWN invoice          -> EFFECT_DENY   (creatorId == principal.id)
different company_admin approving                       -> EFFECT_ALLOW
unknown/legacy creator (creatorId="") — different admin  -> EFFECT_DENY   *** fail-closed proof ***
cross-tenant company_admin                               -> EFFECT_DENY
low-assurance company_admin                              -> EFFECT_DENY
manager (not creator, department-manager tier)           -> EFFECT_ALLOW
plain member                                             -> EFFECT_DENY
platform_admin on the SAME unknown-creator row           -> EFFECT_ALLOW  (pre-existing wildcard bypass)
```

The third line is the load-bearing proof: a DIFFERENT admin (not the creator) is denied approval
of a legacy row purely because `creatorId` is unknown — an empty creator reads as "cannot prove
you're not the creator," not "definitely not you."

## 6. GAP 2 — how leave is decided today, the tier chosen, and why

Leave is filed as an `hr_case`-adjacent `hr_leave_requests` row PLUS an `automation_approvals` row
(`origin='hr'`, `workflow_id='hr:leave'`) in one transaction (`hr.controller.ts::fileLeave`).
Deciding rides the pre-existing, unforked `POST /automation-approvals/:id/decide` — before this
ticket, authorized generically as `core.automation_approval.decide`, indistinguishable in the
catalog from loan decisions (`workflow_id='hr:loan'`), automation-suspension decisions, and agent
re-run decisions.

**Tier chosen: NOT the D4 `assurance=="high"` tier.** `resource_hr_case.yaml`'s `export` action
uses that tier for BULK data extraction (a data-exposure risk in its own right); a leave decision
is a routine, single-record approve/reject with no bulk-export or money-movement shape (unlike
loans, which are D14 `impact:"high"` on the automation-approval axis — a different axis entirely).
Requiring step-up MFA at click time for every single leave decision would be friction
disproportionate to the risk and copying a tier by reflex — the ticket explicitly warned against
this. **Chosen instead: `variables.notLow`**, the same floor every other `hr_case`/
`automation_approval` action in this file already uses. Rejected alternative: reusing `assurance==
"high"` — would weaken nothing existing (leave never had that tier) but would introduce an
unreachable-in-practice bar for a routine HR action, the same "unreachable tier written into a
contract" defect this program has already named once (`checkin.submit`'s `minAssurance:"verified"`,
per `derived_roles.yaml`'s own header).

**Decider set: unchanged in practice, now its own key.** `company_admin`/`group_executive`/
`platform_admin` retain exactly the reach they had before (non-regression — all three could already
decide hr-origin leave rows through the generic `decide` rule; omitting them from `decide_leave`
would have been a silent narrowing). `hr_manager` (module_manager, gated `module=='hr' &&
subKind=='leave'`) is the "department-manager tier" default. `hr_staff` (module_staff) does
**not** get it — adversarially proven, not just asserted (§8). Loans are **unaffected** — they keep
`core.automation_approval.decide` unchanged; the ticket asked about leave specifically, and
widening the split to loans without an owner ask felt like scope creep. Flagged as a candidate
follow-up in `PERMISSION-CONTRACT.md` §9.

**No `perm_hr_leave_decide` mirror**, same reasoning as `automation_approval`'s pre-existing
`read`/`decide` exclusion (IAM-04-REG1): `hr_manager`'s only role-arm path is the attribute-gated
`module_manager` rule; a flat mirror would grant `decide_leave` on ANY `automation_approval`
resource regardless of module/subKind.

## 7. GAP 2 probes — same rigour, live Cerbos

```
hr_manager deciding a LEAVE row (module=hr, subKind=leave)     -> EFFECT_ALLOW
hr_manager on a LOAN row via decide_leave (subKind="")          -> EFFECT_DENY  (loans never set subKind)
company_admin deciding a LEAVE row                              -> EFFECT_ALLOW  (non-regression)
cross-tenant company_admin on LEAVE row                         -> EFFECT_DENY
low-assurance hr_manager on LEAVE row                           -> EFFECT_DENY
hr_staff (module_staff, not manager) on LEAVE row               -> EFFECT_DENY  *** the tier proof ***
group_executive on LEAVE row                                    -> EFFECT_ALLOW  (non-regression)
platform_admin on LEAVE row                                     -> EFFECT_ALLOW  (wildcard)
hr_manager generic `decide` on a LOAN row                       -> EFFECT_ALLOW  (unchanged path)
```

## 8. Holders × reach table (both new keys)

| Role | `billing.invoice.approve` | `hr.leave.decide` | Path |
|---|---|---|---|
| `platform_admin` | ✅ | ✅ | pre-existing wildcard (invoice) / new own rule (leave) |
| `company_admin` | ✅ (not self) | ✅ | new own rule, both kinds |
| `group_executive` | ✅ (via pre-existing invoice wildcard — not self-scoped for THIS role, see §4.5) | ✅ | invoice: pre-existing wildcard; leave: new own rule |
| `manager` | ✅ (not self) | — | new own rule (invoice only) |
| `hr_manager` | — | ✅ (module_manager, module='hr' && subKind='leave') | new rule |
| `hr_staff` | — | — | no rule names it |
| `member`/`viewer`/`client`/others | — | — | no rule names them |

Zero pairs removed from any existing bundle — `role-permission-bundles.json`'s regen diff shows
**+8 additions, 0 removals** (verified via `node scripts/generate-role-bundles.mjs --check`).

## 9. Endpoint tests, verbatim

```
$ npx vitest run src/core/billing.test.ts src/modules/hr/ \
    src/rbac/iam-04-reg1-mirror-reach-invariant.test.ts src/rbac/permission-arm-hazard-scan.test.ts \
    src/rbac/role-permission-parity.db.test.ts src/rbac/permission-catalog.db.test.ts \
    src/rbac/scope-constrained-roles.test.ts src/rbac/cerbos-catalog-alignment.test.ts \
    src/rbac/permission-groups-catalog-parity.test.ts src/rbac/iam-215-boundary-pin.test.ts

 ✓ src/rbac/iam-04-reg1-mirror-reach-invariant.test.ts (25 tests) 46ms
 ✓ src/rbac/role-permission-parity.db.test.ts (27 tests) 4365ms
 ✓ src/modules/hr/wsd7-acceptance.test.ts (12 tests) 7122ms
 ✓ src/modules/hr/loans.test.ts (20 tests) 8430ms
 ✓ src/modules/hr/hr.test.ts (19 tests) 6818ms
 ✓ src/rbac/permission-catalog.db.test.ts (12 tests) 4959ms
 ✓ src/core/billing.test.ts (10 tests) 7769ms
 ✓ src/rbac/iam-215-boundary-pin.test.ts (73 tests) 24ms
 ✓ src/rbac/cerbos-catalog-alignment.test.ts (6 tests) 34ms
 ✓ src/modules/hr/loan-schedule.test.ts (19 tests) 122ms
 ✓ src/rbac/permission-groups-catalog-parity.test.ts (9 tests) 7ms
 ✓ src/rbac/scope-constrained-roles.test.ts (8 tests) 65ms

 Test Files  13 passed (13)
      Tests  369 passed (369)
```

Also run separately (same session): full `src/rbac/` — **27 files, 605 tests, all green**; full
`src/admin/` (incl. `org14-preflight-adversarial.test.ts`, 8/8) — **18 files, 196 tests, all
green**. Baseline comparison: HEAD at `a9cb210` before this session's edits; no test in any of
these files was red before I started (confirmed by running the full suites after my changes with
zero unexplained failures — nothing here is dismissed as "pre-existing", everything is newly
green against my own changes).

Adversarial cases specifically written for this ticket (not merely structural):
- Invoice: creator self-approval denied (403), different admin/manager allowed (200), re-approval
  of an already-approved invoice rejected (400), direct PATCH to `status:'approved'` rejected
  (400), `sent`/`paid` blocked pre-approval (400), `void` always reachable (200), a legacy row with
  real `created_by IS NULL` (inserted directly, not just a Cerbos-level probe) denied to a
  non-superadmin (403).
- HR leave: `hr_staff` (module_staff) denied `decide_leave` end-to-end through the real
  `/automation-approvals/:id/decide` route (403) — the exact shape the ticket asked for ("An
  adversarial end-to-end test caught what every structural suite missed today; write yours in that
  spirit").

## 10. Gates run (targeted only — no full `npm test`, per instruction)

| Gate | Result |
|---|---|
| `cerbos compile` (via `docker run ghcr.io/cerbos/cerbos:0.54.0 compile /policies`) | exit 0, "0 tests executed", no compile errors |
| `gaiada-test-cerbos` restart + health | clean restart, no policy-load errors in logs, `health` = `healthy` |
| Live Cerbos probes (§5, §7) | all 17 match expectation |
| `npm run typecheck` | clean, 0 errors |
| `npm run lint:withtenants` | OK — 302 files scanned |
| `npm run lint:migration-rls` | OK — 106 migrations scanned (53 baselined, 53 enforced) |
| `node scripts/generate-role-bundles.mjs --check` | byte-identical |
| `node scripts/generate-scope-constrained-roles.mjs --check` | byte-identical (unaffected) |
| `src/core/billing.test.ts` | 10/10 |
| `src/modules/hr/` (4 files) | 70/70 |
| `src/modules/billing/` | no dedicated test dir (tests live in `src/core/billing.test.ts`, above) |
| `src/rbac/` (full, 27 files) | 605/605 |
| `src/admin/` (full, 18 files, incl. `org14-preflight-adversarial.test.ts`) | 196/196 |
| `src/rbac/iam-04-reg1-mirror-reach-invariant.test.ts` (unscoped, run pre- and post-edit) | 25/25 both times, register byte-identical to the pinned baseline — no new mirror wired, nothing widened |
| `src/rbac/permission-arm-hazard-scan.test.ts` | 129/129 |

## 11. Contract-doc updates

- `docs/PERMISSION-CONTRACT.md`: §1 header date/status; §2's numbers table (264/249/93/68,
  1031 pairs/22 roles, 85 groups) and the full per-role bundle-size table refreshed from source
  (the table was already stale pre-SMM-30 per the doc's own admission — refreshed wholesale while
  touching it, per the ticket's rule 1); §9 moved both gaps from "still open" to "closed since the
  freeze" with a full account each; removed the now-stale bullets.
- `docs/FRONTEND-BFF-CONTRACT.md`: new row for `POST .../invoices/:invoiceId/approve`; amended the
  existing `.../modules/hr/leave` row to note the `decide_leave` split (no client-visible change).
- `docs/MAP.md`: regenerated (migration head/next-free number).

## 12. Blockers / follow-ups for the owner

1. **Legacy invoices are permanently unapprovable** (by anyone but platform_admin/group_executive)
   until `created_by` is set by hand — confirm this is acceptable, or specify a one-time
   backfill rule (e.g., "assign to the company's first company_admin membership") if not.
2. **`group_executive`'s pre-existing wildcard bypasses the creator check too** (§4.5) — confirm
   this matches intent, or scope `group_executive`'s invoice reach down in a follow-up (out of
   this ticket, which only added `approve` to the existing rule set).
3. **Loan decisions still ride the generic `core.automation_approval.decide`** — only leave got a
   dedicated key this pass. If the owner wants the same treatment for loans, that's a small,
   same-shaped follow-up (a `subKind='loan'` companion, mirroring this ticket's pattern exactly).
4. **No UI** for the new `/approve` endpoint or the `createdBy`/`approvedBy`/`approvedAt` fields —
   `platform-ui/` was explicitly out of scope for this ticket.
5. **`docs/modules/MODULES.md`/`CHANGELOG.md`** were not touched (§1) — flagging in case the owner
   wants a module-version bump recorded there.
