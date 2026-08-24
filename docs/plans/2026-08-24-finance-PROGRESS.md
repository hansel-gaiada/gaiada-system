# Finance & Accounting — F0 Foundations · PROGRESS

**Session:** 2026-08-24. **Design:** [`docs/blueprints/finance-accounting-foundation.md`](../blueprints/finance-accounting-foundation.md)

**Working rule (binding):** update the status column in the SAME change that moves the work. A stale
row here misleads real tickets. Every finished task also gets a line in the session log at the bottom.

**Status vocabulary (binding):** `PLANNED` · `IN PROGRESS` · `PROTOTYPED` · `DEV-VERIFIED`.
Never "built", "done", or "production-ready". **DEV-VERIFIED means it was driven and the result
observed** — a green unit suite is not that.

**Scope of this session:** F0 only — the foundations every later phase sits on. No ledger, no
journals, no AR/AP. F1 (ledger core) is deliberately out of scope; F0 must land first or every
later query gets retrofitted.

---

## Roll-up

| Track | Items | PLANNED | IN PROGRESS | PROTOTYPED | DEV-VERIFIED |
|---|---|---|---|---|---|
| Design & specs | 2 | 0 | 0 | 0 | **2** |
| F0 migrations (DB) | 6 | 0 | 0 | **6** | 0 |
| F0 authz (IAM + Cerbos) | 4 | 2 | 0 | **2** | 0 |
| F0 authz arm (F0-07/09/12) | 7 | 0 | 0 | **6** | **1** |
| F0 verification | 1 | 0 | 0 | 0 | **1** |
| F0 docs | 1 | 1 | 0 | 0 | 0 |
| F1 ledger core | 9 | 0 | 0 | **7** | **2** |
| F3 statements | 8 | 0 | 0 | **6** | **2** |
| F4 accounts receivable | 10 | 0 | 0 | **8** | **2** |
| F5 accounts payable | 8 | 0 | 0 | **6** | **2** |
| F6 cash, bank & close | 7 | 0 | 0 | **5** | **2** |
| F7 tax & statutory | 8 | 0 | 0 | **6** | **2** |
| F2 posting rules | 7 | 0 | 0 | **5** | **2** |
| FA application layer | 5 | 0 | 0 | **3** | **2** |
| **Total** | **83** | **3** | **0** | **60** | **20** |

---

## Owner rulings folded in (2026-08-24)

| # | Ruling | Where |
|---|---|---|
| D-F1 | project-hug reuse ALLOWED but conditional — rewritten to our stack **and tested**, never pasted | blueprint §9.1 |
| D-F2 | Book of record is **our own ledger**; no Odoo/ERPNext. e-Faktur transmission still integrated, not built | §9.1, §6 |
| D-F5 | Accountant coming, gets an ERP account; **ERP is their source of truth** ⇒ ship a PSAK-aligned CoA as *editable data*, don't block on the hire | §9.1 |
| D-F8 | **Holding owner sees all; company owner/shareholder sees one or some.** Scope derived from an ownership graph. Shareholder ≠ owner-manager | §9.1, §10.3b |
| — | Approval gate is for **staff out of scope + all writes**, never for the owner. Superadmin ≠ owner | §10.3 |

---

## Tasks

### Design & specs

| ID | Task | Status | Notes |
|---|---|---|---|
| D-1 | Research + foundation blueprint (industry standard, banking-ready bar, project-hug audit, build-vs-buy) | **DEV-VERIFIED** | `docs/blueprints/finance-accounting-foundation.md`; audited against both repos |
| D-2 | Access topology §10 (internal/external, joined/individual, ownership graph, elevation) | **DEV-VERIFIED** | Folded in 4 owner rulings across 3 rounds |

### F0 migrations — `platform-nest/migrations`

| ID | Task | Status | File | Notes |
|---|---|---|---|---|
| F0-01 | `finance` module registration + third wall (`app_module_allowed('finance')`) | **PROTOTYPED** | `202608241010_finance_ownership_and_scope.sql` | Policy shape established; 0028 DO-loop shape followed. Both linters green |
| F0-02 | Ownership graph (`company_ownership`) + scope resolver fn | **PROTOTYPED** | `202608241010_finance_ownership_and_scope.sql` | `finance_owner_company_ids()` + cycle-guarded `finance_company_descendants()`. **13 assertions driven against Postgres, all pass** |
| F0-03 | Chart of accounts as editable DATA + posting protection | **PROTOTYPED** | `202608241011_finance_coa_and_dimensions.sql` | Template→instantiate model; **69-line PSAK-aligned ID chart seeded**. Freeze trigger + 8 assertions pass |
| F0-04 | Accounting dimensions (cost centre, project, + validation) | **PROTOTYPED** | `202608241011_finance_coa_and_dimensions.sql` | dimensions + values + per-account `required/optional/forbidden` rules |
| F0-05 | Fiscal calendar: years + periods, `OPEN/SOFT_LOCK/HARD_LOCK` | **PROTOTYPED** | `202608241012_finance_fiscal_calendar_and_currency.sql` | State machine + **D-F5 sign-off gate** + `finance_period_accepts_posting()`. 13 assertions pass |
| F0-06 | Currencies + exchange rates with stated rate basis | **PROTOTYPED** | `202608241012_finance_fiscal_calendar_and_currency.sql` | 9 currencies; rates carry `basis` (spot/closing/average) + source; `finance_company_settings` functional vs presentation |

### F0 authz

| ID | Task | Status | Notes |
|---|---|---|---|
| F0-07 | IAM: 9 finance permissions/roles per blueprint §2.2 + `finance.cross_company_approver` | **PLANNED — deliberately not started** | ⚠ The IAM chain is GENERATED from `src/rbac/permission-catalog.json` + `role-permission-bundles.json`, with three parity suites (`test:iam-chain-alignment`, `role-permission-parity.db.test.ts`) asserting catalog ↔ Cerbos ↔ module agreement. A partial change breaks those for **every other session** in this shared checkout. Needs its own ticket with the generator |
| F0-08 | SoD matrix as data + enforcement primitive, bound **per company-person** | **PROTOTYPED** | `202608241013_finance_sod_and_elevation.sql` — 12 duties × 4 control functions, all 6 blueprint pairs seeded, `finance_sod_check()`. Shared-service case verified: same two duties in *different* companies is not a conflict |
| F0-09 | Cerbos policies for finance resources | **PLANNED — blocked by F0-07** | A policy naming permissions the catalog does not carry fails `cerbos-catalog-alignment`. Must land with F0-07, not before |
| F0-10 | Elevation grants: time-boxed, purpose-tagged, auto-expiring + access log | **PROTOTYPED** | `202608241013_finance_sod_and_elevation.sql` — `finance_access_grants` + `finance_has_elevated_access()` + append-only `finance_access_log`. Schema **refuses** an approved grant with no expiry |

### F0 authz arm — the deferred chunk, now authorised (owner: "proceed", 2026-08-24)

Broken out because it is one coupled change, not four independent ones: the catalog, the Cerbos
policy and the generated bundles must move together or the parity suites fail. Order is binding.

| ID | Task | Status | Notes |
|---|---|---|---|
| F0-07a | Decide the finance Cerbos KINDS and their permission keys | **PROTOTYPED** | **3 kinds / 13 keys**: `finance_config` (vocabulary) · `finance_period` (close lifecycle) · `finance_control` (governance). Split along SoD lines so `period_close` is grantable separately from CoA editing |
| F0-07b | Add the keys to `src/rbac/permission-catalog.json` (class, sensitive, uiGrantable) | **PROTOTYPED** | 320→333 pairs, 81→84 kinds, 305→318 grantable, 126→137 sensitive. Only the two `*.read` keys are non-sensitive (an account code is not money). `_meta` re-derived, not hand-edited |
| F0-09a | Write the `resource_finance_*.yaml` Cerbos policies | **PROTOTYPED** | 3 policies, role-arm only. `period.close` + every `finance_control` write at D4 `assurance == "high"`. Each carries a HANDLER CONTRACT block naming `module:"finance"` — load-bearing for the module-tier composition |
| F0-07c | Bundle the keys onto roles + regenerate (`npm run gen:role-bundles`) | **PROTOTYPED** | 26 roles / 1448 pairs. Derived exactly as intended: `finance_staff` gets only 2 read keys; `finance_manager` gets `control.read` but no control writes; `company_admin` gets `period.lock` but **not** `period.reopen` |
| F0-07d | Migration seeding the catalog rows + role bundles | **PROTOTYPED** | `202608241014_iam_finance_f0_permissions.sql` — 13 permissions, 2 roles, **48 bundle rows emitted from the artifact** so migration and artifact cannot disagree |
| F0-09b | Prove the chain: `npm run test:iam-chain-alignment` + the parity suites | **DEV-VERIFIED** | Cerbos restarted, then **proved by probe not by health**: `role-permission-parity.db.test.ts` (live Cerbos) green. 4 suites needed coupled updates — see log. 1 pre-existing failure isolated and cleared |
| F0-12 | `PERMISSION-CONTRACT.md` § + `MODULES.md` registry row + `CHANGELOG.md` | **PROTOTYPED** | §17 (kinds, holders, assurance tiers, and the two things the contract does NOT decide) · `finance 0.1.0 PROTOTYPED` row · changelog entry. Append-only edits to shared files |

## F1 · LEDGER CORE — the book of record itself

**This is the phase project-hug proves is buildable and F3 is where it stopped.** F1 makes the
ledger exist and makes it trustworthy; it does NOT produce statements (F3) or subledgers (F4/F5).

The integrity bar is blueprint §3.1, and every item is a property an auditor or a bank tests:
balanced always · immutable · tamper-evident · gap-free sequence · full audit trail · idempotent.

| ID | Task | Status | Notes |
|---|---|---|---|
| F1-01 | `finance_journal_entries` + `finance_journal_lines` schema | **PROTOTYPED** | `202608241015`. Immutable by trigger; reversal link points FORWARD ONLY so nothing on a posted entry is ever updated |
| F1-02 | `finance_post_journal()` — the ONE way in | **PROTOTYPED** | Totals FROM the lines; per-company advisory lock so sequence + chain cannot fork; accounts addressed by CODE |
| F1-03 | Idempotency on `source_event_id` | **PROTOTYPED** | Unique index arbitrates the race; early SELECT only makes the common case cheap. Reversal is idempotent for free via `reversal:<id>` |
| F1-04 | Guards: period state + account postability + `first_posted_at` stamp | **PROTOTYPED** | Locked period, no-period date, header account, archived account, control account all refused. Freeze loop closed |
| F1-05 | `finance_reverse_journal()` — correction is reversal, never edit | **PROTOTYPED** | Mirrors lines AND dimensions; performs ZERO updates on the ledger; refuses double-reversal, reversal-of-reversal, and a thin reason |
| F1-06 | `finance_verify_ledger_chain()` — hash + sequence + balance audit | **PROTOTYPED** | 5 problem classes. Tamper + gap detection driven on a superuser scratch DB; hash-sensitivity pinned in CI |
| F1-07 | IAM + Cerbos: `finance_ledger` kind | **DEV-VERIFIED** | 4 keys, 14 bundle rows, 2 groups, `202608241016`. Live-Cerbos parity probe green. **Corrected an over-claimed SoD justification** — see log |
| F1-08 | Test suite | **DEV-VERIFIED** | `src/db/finance-f1-ledger.test.ts` — **25 tests, all passing**. F0's 35 still pass after the CoA correction |
| F1-09 | Docs: PERMISSION-CONTRACT §, MODULES bump, CHANGELOG | **PROTOTYPED** | §18 · finance `0.1.0` → `0.2.0` · changelog entry |

---

### F0 verification

| ID | Task | Status | Notes |
|---|---|---|---|
| F0-11 | RLS + scope resolver test suite | **DEV-VERIFIED** | `src/db/finance-f0-foundations.test.ts` — **35 tests, all passing** against a real Postgres through the NOBYPASSRLS app role. Found 2 real defects (see log). Repo gates re-run green: 3 linters + `rls.test.ts` + `rls-empty-set.test.ts` |

### F0 docs

| ID | Task | Status | Notes |
|---|---|---|---|
| F0-12 | `docs/modules/MODULES.md` registry entry + `PERMISSION-CONTRACT.md` finance section | PLANNED | Deferred with F0-07: the PERMISSION-CONTRACT § should land in the same change as the permissions it documents, not ahead of them |

---

## Constraints binding this session

- **Shared checkout on `main` with ~20 files dirty from other sessions.** Do not commit, do not
  `git add`. New files only where possible; append-only edits to shared docs.
- Migration naming: `YYYYMMDDHHMM_snake_case.sql` UTC. No sequential numbers.
- RLS predicate is byte-identical across finance tables:
  `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('finance')`.
- `tenant_id` **references `companies(id)`** — tenancy *is* company. The finance ledger inherits
  per-company partitioning for free; do not invent a second company column.
- Money is `numeric`, never float. Every amount carries its currency.
- `app_module_allowed()` returns **NULL**, not false, on an unset GUC. Test `IS NOT TRUE`.

---

## Open — needs owner input (does not block F0)

| # | Question | Blocks |
|---|---|---|
| Q3 | Which companies must be bank-ready — group-consolidated or a specific borrowing PT? | F9 timing |
| Q4 | Which entities exist + their PKP status | whether PPN lands in F1 or F7 |
| Q6 | Existing books (Accurate / Mekari / Xero / spreadsheets)? ⇒ opening balances + cutover phase | a phase not yet in §8 |
| Q7 | e-Faktur ASP/PJAP choice | F7 integration contract |
| Q9 | **The actual ownership map** — which PTs, who holds what stake, who is also a director | F0-02 seed data (schema is unblocked; only the rows wait) |

---

## Session log

- **2026-08-24** — D-1 research pass: audited `gaiada-system` (no accounting system exists; `billing`
  is documents, dept `ledger` is AI cost, GM `money` is `BackendPending`) and project-hug
  (27,100 LOC finance core, ~50 tables, 68 endpoints, 24 pages — but **1 test file**, in-memory
  posting lock, statements unbuilt). Blueprint written. → `DEV-VERIFIED`
- **2026-08-24** — D-2 access topology: 4 owner rulings folded in across three rounds. Corrected an
  early error where the owner would have needed approval to see his own companies. → `DEV-VERIFIED`
- **2026-08-24** — F0-01/F0-02 `202608241010_finance_ownership_and_scope.sql`. Both migration linters
  green. Driven against Postgres on a scratch DB: **13 assertions** — holding owner reaches 5
  companies incl. a nested sub and excl. an unrelated PT; Sub-B shareholder reaches only Sub B; a
  user with no edges gets ZERO rows; a new subsidiary appears with no permission edit; a deliberate
  parent cycle terminates instead of hanging; RLS zero-row trap, cross-company write denial, and
  5 constraint violations all behave. → `PROTOTYPED`
- **2026-08-24** — F0-03/F0-04 `202608241011_finance_coa_and_dimensions.sql`. CoA template→instantiate
  (D-F5), 69-line PSAK-aligned Indonesian chart incl. PPN Masukan/Keluaran and PPh 21/23/4(2).
  **8 assertions**: 69 accounts created, 8 roots / 61 parented, 3 contra accounts keep credit
  normal-balance on an asset, 16 control accounts all refuse manual posting, re-run is idempotent,
  an accountant's rename survives a top-up, and the freeze trigger refuses re-typing / re-coding /
  clearing `first_posted_at` on a posted account while still allowing rename+archive. → `PROTOTYPED`
- **2026-08-24** — F0-05/F0-06 `202608241012_finance_fiscal_calendar_and_currency.sql`. **13
  assertions**: 12 monthly periods generated idempotently; posting guard TRUE only inside an OPEN
  period and **FALSE for an unmapped date**; `OPEN→HARD_LOCK` refused; **`HARD_LOCK` without
  accountant sign-off refused (D-F5 enforced by trigger, not process)**; `SOFT_LOCK→OPEN` reopen
  clears its stamp; **`HARD_LOCK` is terminal — reopen refused**; overlapping periods and
  overlapping fiscal years both rejected by btree_gist exclusion. → `PROTOTYPED`
- **2026-08-24** — F0-08/F0-10 `202608241013_finance_sod_and_elevation.sql`. SoD as data (12 duties,
  6 blocking pairs, waiver fields so a compensating control is an artefact rather than a habit);
  elevation grants that **cannot be approved without an expiry** and lapse with no revoke action;
  append-only access log with `basis` covering the ungated owner path (never blocked, always
  recorded). → `PROTOTYPED`
- **2026-08-24** — F0-11 `src/db/finance-f0-foundations.test.ts`, **35 tests all passing** through the
  NOBYPASSRLS app role. The suite paid for itself immediately by finding three things:
  1. **A pre-existing guard nobody told me about.** `202608201326` already maintains
     `companies.root_company_id` and REFUSES a cross-root re-parent. My fixture was re-parenting
     companies after creation; it now builds the tree top-down, respecting the guard. **`root_company_id`
     also means the descendant walk has a faster path available — worth revisiting in F1.**
  2. **A real design error of mine: the scope resolvers were RLS-bound.** `finance_owner_company_ids`
     reads `company_ownership`, which is tenant-walled — but the function exists to COMPUTE the tenant
     set, before it is set. Run as INVOKER it returned the empty set for **everyone, including the
     holding owner**, and silently: an empty scope is indistinguishable from "owns nothing". Left
     unfixed this would have shipped as the exact inverse of ruling D-F8. The scope resolvers
     (`finance_owner_company_ids`, `finance_company_descendants`, `finance_has_elevated_access`) are
     now `SECURITY DEFINER` with a pinned `search_path`, returning **only ids/booleans**; the domain
     helpers (`finance_sod_check`, `finance_period_accepts_posting`) stay RLS-bound on purpose.
  3. `finance_access_log` used `bigserial`, whose sequence the app role has no GRANT on — switched to
     a uuid PK, matching every other table in the schema. → `DEV-VERIFIED`
- **2026-08-24** — F0-07/F0-09/F0-12 **deliberately not started**, and this is the honest stopping
  point rather than a half-landed change: the IAM arm is generated from the permission catalog and
  guarded by three parity suites, so a partial edit breaks the test suite for every other session in
  this shared checkout. It needs its own ticket that runs the generator.

- **2026-08-24** — F0-07/F0-09/F0-12 **the authz arm, authorised by the owner and landed as one
  coupled change.** 3 Cerbos kinds, 13 keys, 2 roles, 48 bundle rows, 4 authoring groups.
  The coupling was real and is worth recording, because five artifacts had to move together and each
  one failed LOUD with a precise instruction rather than silently:
  1. `permission-groups-catalog-parity` — refused 13 grantable keys with **no authoring path**.
     Fixed by 4 new groups mirroring the SoD split (view vocabulary / manage vocabulary / run the
     close / govern duties), deliberately not one "finance" group.
  2. `role-catalog-drift` — could not resolve the module key for 7 rules. The resolver reads a
     literal `module:"x"`; my policies only said "finance" in prose. Fixed the RIGHT way — a
     HANDLER CONTRACT block in each policy header, the same stage `resource_monitor.yaml` uses —
     rather than by tuning the parser, which the test explicitly forbids.
  3. `role-permission-parity.db` — threw on `unhandled module_staff kind "finance_config"`; it keeps
     its own deliberate copy of the generator's resolver. Both updated.
  4. `iam-215-boundary-pin` + `ui-grantable-catalog` — pinned tallies, updated with reasons.
  5. `generate-role-bundles.mjs` — REAL_ROLES + both target resolvers.
  **Proved by probe, not by health:** Cerbos was restarted and `role-permission-parity.db.test.ts`
  compared the seeded bundle against what live Cerbos actually grants — 155 tests green across the
  four suites. → `DEV-VERIFIED` for F0-09b, `PROTOTYPED` for the rest.
- **2026-08-24** — `principal-perf.db.test.ts` fails on this machine (36–54 ms against a 25 ms
  budget, ~47% run-to-run variance). **Isolated: it fails IDENTICALLY with my IAM migration removed**
  (38.9 ms, same 2 tests), so it is pre-existing and environmental, not a regression from this work.
  Not fixed and not silenced — recorded here so the next person does not re-diagnose it.
- **2026-08-24** — FULL GATE, third attempt: `npx vitest run src/rbac` from `platform-nest` —
  **41 files, 40 passed**, zero worktree contamination. The only failure is the pre-existing
  `principal-perf.db.test.ts` isolated above.

  ⚠ **The first two attempts both exited 0 and both proved NOTHING.** Recorded because a green exit
  code was, twice in a row, not evidence that a gate ran:
  1. Run from the REPO ROOT instead of `platform-nest`, so vitest globbed
     `.claude/worktrees/agent-*/platform-nest/src/rbac/**` — dozens of other sessions' stale copies,
     which fail by construction (old catalog, no finance policies). Every failure line was a
     phantom. The tell: `role-catalog-drift.db.test.ts` appearing eight times, once per worktree.
  2. `--dir src/rbac --exclude "**/.claude/**"` overrode vitest's include glob → "No test files
     found", i.e. nothing ran at all.

  **Check the FILE COUNT and the PATHS, not the exit code.** 41 files from `platform-nest` is the
  shape of a real run here. This is the same class as the program's existing "CI fast gates mask the
  full suite" finding, and it cost three attempts to notice.

---

## F3 · STATEMENTS — the bank-facing output

**This is the phase project-hug never reached** (its `FINANCE_PHASE_ROADMAP.md` §8 "Phase 12" is
entirely unchecked, including the A = L + E invariant). There is no reference implementation to
lean on.

| ID | Task | Status | Notes |
|---|---|---|---|
| F3-01 | `finance_trial_balance()` | **PROTOTYPED** | `202608241017`. Built on `finance_account_movement()` — ONE definition of a balance, so no two statements can disagree |
| F3-02 | `finance_general_ledger()` with running balance | **PROTOTYPED** | Continuity verified by independent recomputation; opens from the PRIOR balance, not zero, when the window starts mid-year |
| F3-03 | `finance_profit_and_loss()` | **PROTOTYPED** | Sales return (revenue/debit-normal) nets −10m against revenue. Sign derives from `normal_balance`, never a hardcoded code list |
| F3-04 | `finance_balance_sheet()` | **PROTOTYPED** | **A = L + E holds.** Current-year profit carried into equity; `p_fy_start` required, not defaulted. Contra asset presents negative |
| F3-05 | Statement integrity checks | **PROTOTYPED** | `finance_verify_statements()` — one row per problem, empty = pass. **The checkpoint project-hug listed and never ticked** |
| F3-06 | IAM + Cerbos: `finance_statement` kind | **DEV-VERIFIED** | `202608241018`. 2 keys, 9 bundle rows, 2 groups. No write action exists by design. Live-Cerbos parity green (292 tests) |
| F3-07 | Test suite | **DEV-VERIFIED** | `src/db/finance-f3-statements.test.ts` — **13 tests, all passing first run**, incl. A = L + E surviving a reversal |
| F3-08 | Docs: PERMISSION-CONTRACT §, MODULES bump, CHANGELOG | **PROTOTYPED** | §19 · finance `0.2.0` → `0.3.0` · changelog entry |

**Cash Flow is deliberately NOT in F3.** The indirect method needs each account classified as
operating / investing / financing, which is CoA metadata that does not exist yet — inventing it
inside a reporting function would hide a modelling decision inside a query. It gets its own ticket
with the classification column. Stating the gap rather than shipping a cash-flow statement built on
a guess.

---

## F4 · ACCOUNTS RECEIVABLE — order to cash

The first SUBLEDGER. Its defining test is not "does an invoice save" — it is **does the AR aging
total equal the AR control account in the general ledger**. If those can drift, the system is not
banking ready (blueprint §3.2), and an aging schedule is the first thing a lender asks for.

| ID | Task | Status | Notes |
|---|---|---|---|
| F4-00 | Subledger posting path in `finance_post_journal()` | **PROTOTYPED** | `p_subledger` unlocks ONLY matching control accounts — an AR posting is still refused on the AP one |
| F4-01 | `finance_ar_customers` | **PROTOTYPED** | `client_id` nullable link, not an identity. `credit_limit` stored but deliberately UNREAD (policy layer deferred) |
| F4-02 | `finance_ar_invoices` + lines, with tax fields | **PROTOTYPED** | Rate stored PER LINE — the rate that applied is a fact about the transaction (PPN moved 11%→12%/11-12ths in 2025) |
| F4-03 | Issue an invoice → posts DR AR control / CR revenue / CR PPN Keluaran | **PROTOTYPED** | Control accounts resolved by ROLE (`is_control`+`control_subledger`), never by hardcoded code — the chart is editable data |
| F4-04 | Receipts + allocation to invoices | **PROTOTYPED** | Receipt posts to the GL immediately; allocation posts NOTHING (asserted by journal count). Overpayment and cross-customer refused |
| F4-05 | `finance_ar_aging()` | **PROTOTYPED** | Buckets by DAYS OVERDUE, not invoice age — a 45-day-old invoice on 60-day terms is CURRENT |
| F4-06 | **Control-account reconciliation** | **PROTOTYPED** | **Identity corrected by the tests** — open invoices − payments on account = control balance. Checks, never repairs |
| F4-07 | IAM + Cerbos: `finance_ar` kind | **DEV-VERIFIED** | 6 keys, 25 bundle rows, 3 groups. `finance_staff` gets `receipt` and NEVER `write_off`. Live-Cerbos parity green (293) |
| F4-08 | Test suite | **DEV-VERIFIED** | `src/db/finance-f4-ar.test.ts` — **16 tests**, reconciliation asserted empty after every state change |
| F4-09 | Docs | **PROTOTYPED** | PERMISSION-CONTRACT §20 · finance `0.3.0` → `0.4.0` · changelog |

**Credit limits, dunning and credit memos are NOT in this chunk** — they are policy layers on top of
a working subledger, and the reconciliation invariant has to be solid first. Stated as scope, not
discovered as a gap later.

---

## F5 · ACCOUNTS PAYABLE — procure to pay

The mirror of F4, with one thing AR does not have: **Indonesian withholding tax**. Paying a domestic
vendor for services means withholding PPh 23 and remitting it to the tax office — so the company
owes the vendor LESS than the bill, and owes DJP the difference. An AP subledger that ignores this
produces a payables figure that is wrong for every service vendor in the country.

| ID | Task | Status | Notes |
|---|---|---|---|
| F5-01 | `finance_ap_vendors` | **PROTOTYPED** | `202608241021`. Default withholding code/rate per vendor, overridable per bill (one vendor bills both services and rent) |
| F5-02 | `finance_ap_bills` + lines | **PROTOTYPED** | Three distinct money columns: `total` (billed) · `withholding_amount` (owed to DJP) · `amount_payable` (owed to the vendor) |
| F5-03 | Approve a bill → posts DR expense / DR PPN Masukan / CR AP / CR PPh payable | **PROTOTYPED** | Verified on a 100m+11m bill with 2m withheld: AP carries 109m, PPh payable 2m, expense stays GROSS at 100m |
| F5-04 | Payments + allocation | **PROTOTYPED** | Allocation capped at `amount_payable`, never `total` — the withheld portion was never the vendor's |
| F5-05 | `finance_ap_aging()` + `finance_ap_reconcile()` | **PROTOTYPED** | Identity reused verbatim from F4; a genuine vendor prepayment exercises the second term |
| F5-06 | IAM + Cerbos: `finance_ap` kind | **DEV-VERIFIED** | 6 keys / 23 bundle rows / 5 groups. `payment_release` is the narrowest grant in the module — not even `company_admin`. Live-Cerbos parity green (294) |
| F5-07 | Test suite | **DEV-VERIFIED** | `src/db/finance-f5-ap.test.ts` — **14 tests**. Includes the cross-subledger boundary: the `ar` subledger cannot post to the AP control account |
| F5-08 | Docs | **PROTOTYPED** | PERMISSION-CONTRACT §21 · finance `0.4.0` → `0.5.0` · changelog |

**3-way matching (PO ↔ goods receipt ↔ bill) is NOT in this chunk.** It needs a purchase order and a
goods-receipt document, and neither exists — there is no procurement module. Building a "match"
against documents that do not exist would be theatre. Stated as a dependency, not a gap.

---

## F6 · CASH, BANK RECONCILIATION AND THE CLOSE

The phase that turns "the books exist" into "the books are **closed**". Two halves:

**Bank reconciliation** answers the question a lender asks second, right after the aging: *does the
cash on your balance sheet actually exist?* The ledger says one number, the bank says another, and
the difference must be fully explained by items in flight — never by a plug.

**The close** is the capstone. Blueprint §3.2 lists a checklist; F6 turns it into a computed
readiness check so "can we close?" is answered by the system rather than by memory.

| ID | Task | Status | Notes |
|---|---|---|---|
| F6-01 | `finance_bank_statements` + `finance_bank_transactions` | **PROTOTYPED** | `202608241023`. `direction` in/out rather than a signed amount — CSV/OFX exports disagree about sign conventions constantly |
| F6-02 | Matching: statement line ↔ ledger line | **PROTOTYPED** | One-to-one, enforced on both sides. Auto-match REFUSES when two ledger lines are equally plausible — proven with two identical same-day payments |
| F6-03 | `finance_bank_reconcile()` | **PROTOTYPED** | Returns a POSITION, not pass/fail. **No adjustment field exists** — an unexplained residue is the finding |
| F6-04 | `finance_period_close_readiness()` | **PROTOTYPED** | Aggregates F1 chain · F3 A=L+E · F4 AR · F5 AP · F6 bank · D-F5 sign-off. Missing statement and unexplained difference are SEPARATE blockers (different owners) |
| F6-05 | IAM + Cerbos: `finance_bank` kind | **DEV-VERIFIED** | 4 keys / 16 bundle rows / 2 groups. **The SoD pair is satisfied STRUCTURALLY at the staff tier** — a first for this module. Live-Cerbos parity green (295) |
| F6-06 | Test suite | **DEV-VERIFIED** | `src/db/finance-f6-bank-close.test.ts` — **13 tests, all passing first run** |
| F6-07 | Docs | **PROTOTYPED** | PERMISSION-CONTRACT §22 · finance `0.5.0` → `0.6.0` · changelog |

**Bank feed / API import is NOT in this chunk.** Statement lines arrive as data; whether they come
from a CSV, an OFX file or a bank API is an integration concern with its own credentials, and none
of it changes the reconciliation logic. The tables accept lines from any source.

---

## F7 · TAX AND STATUTORY — the legal ability to operate

F4 and F5 already record the tax data. F7 turns it into **returns**, and adds the one rule with a
direct money consequence: **an input VAT amount with no valid e-Faktur is not creditable** — the
company pays it and cannot reclaim it.

| ID | Task | Status | Notes |
|---|---|---|---|
| F7-01 | `finance_tax_codes` — rates as data, with the 11/12 base multiplier | **PROTOTYPED** | `202608241025`. `rate` + `base_multiplier`, effective-dated so a 2024 supply keeps its full-base 11% |
| F7-02 | `finance_tax_ppn_summary()` — output − creditable input | **PROTOTYPED** | Uncreditable input VAT excluded from the claim and reported SEPARATELY — the loss is visible, not absorbed |
| F7-03 | `finance_tax_pph_summary()` — withheld by code and counterparty | **PROTOTYPED** | Per vendor incl. NPWP — a bukti potong is issued to each vendor individually, so a single total is useless |
| F7-04 | `finance_tax_efaktur_exceptions()` | **PROTOTYPED** | Two kinds, not merged: `AR_MISSING_EFAKTUR` is compliance, `AP_INPUT_VAT_LOST` is money. Different person to chase |
| F7-05 | Coretax extract + `finance_tax_coretax_reconcile()` | **PROTOTYPED** | Three problem classes: not-in-Coretax · not-in-ledger · amount mismatch. Extract imported then read, never edited |
| F7-06 | IAM + Cerbos: `finance_tax` kind | **DEV-VERIFIED** | 4 keys / 14 bundle rows / 4 groups. `file` is the module's highest bar alongside `ap.payment_release`. Live-Cerbos parity green (296) |
| F7-07 | Test suite | **DEV-VERIFIED** | `src/db/finance-f7-tax.test.ts` — **14 tests, all passing first run** |
| F7-08 | Docs | **PROTOTYPED** | PERMISSION-CONTRACT §23 · finance `0.6.0` → `0.7.0` · changelog |

**Transmission to Coretax is NOT built and must not be** (blueprint §6, owner ruling D-F2's carve-out):
that goes through a licensed ASP/PJAP. F7 owns the DATA and the RECONCILIATION; the wire is bought.

---

## F2 · POSTING RULES — the seam other departments post through

**The single best idea in project-hug**, and the one the F0 audit named as worth taking: business
modules EMIT events; finance decides the accounting. Without it every journal is hand-keyed, and the
day Sales wants delivery to post revenue somebody hardcodes a chart of accounts into the sales
module.

It is also what the program's own agentic-native bar requires — a capability must work identically
under a human, under n8n and under an agent. An event inbox is that seam.

| ID | Task | Status | Notes |
|---|---|---|---|
| F2-01 | `finance_posting_rules` + rule lines | **PROTOTYPED** | `202608241027`. Effective-dated; at most ONE active rule per event type (a second would post one event two ways by row order) |
| F2-02 | `finance_ledger_events` — the inbox | **PROTOTYPED** | Unique index arbitrates duplicate emissions. `failed` is a visible queryable state carrying the error |
| F2-03 | `finance_process_event()` | **PROTOTYPED** | Adds NO second way into the ledger — F1's balance/period/account/chain guards all still fire, pinned by test |
| F2-04 | Failure handling: retry, and a terminal state that stays visible | **PROTOTYPED** | Per-event subtransaction so one bad event cannot roll back the batch AND its reason survives. `finance_event_backlog()` surfaces it |
| F2-05 | IAM + Cerbos: `finance_posting_rule` kind | **DEV-VERIFIED** | 4 keys / 12 bundle rows / 4 groups. `process` is the agent path; an automation principal may hold it but NEVER `author`/`activate`. Live-Cerbos parity green (297) |
| F2-06 | Test suite | **DEV-VERIFIED** | `src/db/finance-f2-posting-rules.test.ts` — **16 tests** |
| F2-07 | Docs | **PROTOTYPED** | PERMISSION-CONTRACT §24 · finance `0.7.0` → `0.8.0` · changelog |

**No expression language.** A rule line takes an amount from a named path in the event payload, with
an optional fixed multiplier — and nothing else. The moment a rule can compute, the chart of accounts
becomes a programming language nobody can audit, and "why did this post there" stops having a short
answer. If a mapping needs logic, the emitting module computes the number and puts it in the payload.

---

## F1 session log

- **2026-08-24** — F1-01..F1-06 `202608241015_finance_ledger_core.sql`, driven against Postgres.
  **20 invariants driven on a scratch DB, then 25 pinned in CI.** Three things the driving found
  that reading would not have:
  1. **The CoA seed had 11 accounts mis-flagged as control.** Posting rent from `1120 Bank` was
     REFUSED. The guard was right; the flag was wrong. Control means "reconciled against a subledger
     that POSTS INTO IT" (AR/AP/inventory/fixed assets) — bank and cash reconcile against a
     *statement*, and tax accounts against a return. 16 control accounts → 5. Fixed at the seed in
     `202608241011`, with the reasoning recorded beside the flag's definition.
  2. **The immutability trigger's condition ERRORED instead of raising** on line updates:
     `record "old" has no field "entry_hash"`, because plpgsql resolves OLD against the triggering
     table and the check sat in a flat AND-chain. Fail-closed either way, but surfacing as an
     internal error — the "fail-closed but invisible" shape this codebase has been bitten by. Nested,
     and pinned by a regression test.
  3. **The reversal CHECK fought the two-phase write.** `(kind='reversal') = (reversal_of_id IS NOT
     NULL)` fired on the placeholder header, and a CHECK cannot be deferred in Postgres. Fixed by
     making the link a POSTING PARAMETER rather than weakening the constraint — which also means
     `finance_reverse_journal()` now performs zero updates on the ledger.
- **2026-08-24** — F1-07 authz. The five-artifact coupling behaved exactly as the F0 log predicted,
  and cost one round instead of five. **One genuine self-correction:** the policy header justified
  excluding `company_admin` from `ledger.post` on segregation-of-duties grounds — then the generated
  bundle showed `finance_manager` holding both `ledger.post` and `period.close`, the very pair
  called blocking. The argument did not survive its own logic. Corrected in the policy, the catalog
  note and PERMISSION-CONTRACT §18: **SoD binds per company per PERSON via `finance_duty_assignments`
  + `finance_sod_check()`, never through role bundles** — which is what lets a real conflict be
  waived deliberately with a recorded compensating control. `company_admin` is excluded on the
  separate, honest ground that it is an administrative role, not an accounting one.
- **2026-08-24** — ⚠ **A concurrent session (LMS-L1) landed 2 kinds / 12 keys mid-flight.** Catalog
  tallies moved under this work (345/86 → 349/87 after F1). `role-catalog-drift.db.test.ts` FAILS on
  8 unresolved rules — **all of them in `resource_lms_course.yaml` / `resource_lms_enrollment.yaml`,
  neither of which is mine.** Those files need a `module:"lms"` literal (a HANDLER CONTRACT block,
  as the finance policies carry). **Not fixed here:** touching another session's in-flight policy in
  a shared checkout is how two sessions clobber each other. Flagged for its owner.

---

## F3 session log

- **2026-08-24** — F3-01..F3-05 `202608241017_finance_statements.sql`. **The accounting equation
  holds on a real ledger**: assets 608,000,000 = liabilities 0 + equity 608,000,000, on a fixture
  spanning capital, revenue, a sales return, expenses and an amortisation adjustment. Three
  decisions worth keeping:
  1. **Functions over the ledger, NOT materialised projections — yet.** The blueprint records
     project-hug's "reports must never scan the ledger" rule, which is right AT SCALE and wrong now.
     A projection can DRIFT (project-hug needed an integrity service, invariant service, checkpointed
     workers and a rebuild path to manage exactly that); an aggregation cannot, because it IS the
     ledger. The SIGNATURES are what must stay stable — the projection lands behind them when
     measurement calls for it, and these tests become the oracle proving it agrees.
  2. **A = L + E only balances because current-period profit is carried into equity.** Revenue and
     expense close into retained earnings at year end; before that, their net is still equity, just
     unmoved. `p_fy_start` is REQUIRED rather than defaulted — "profit so far" is meaningless without
     knowing when the year began, and `finance_company_settings.fiscal_year_start_month` exists
     precisely because not every company starts in January.
  3. **Contra accounts derive their sign from `normal_balance`, never a hardcoded list**, and BOTH
     directions are pinned — a revenue account with a debit balance (sales return) and an asset
     account with a credit balance (accumulated amortisation). A fix that handles only one is the
     usual half-fix.
- **2026-08-24** — Driving the fixture surfaced that **depreciation cannot be posted yet**: `1220
  Akumulasi Penyusutan` is a genuine fixed-asset control account, and manual journals into control
  accounts are barred by design. That is CORRECT — depreciation belongs to the F8 fixed-asset
  subledger. The fixture uses amortisation (`1240`, not control) instead. Recorded so it is not
  mistaken for a defect later.
- **2026-08-24** — F3-06 authz: 2 keys, no write action. `export` split from `read` and held at D4
  high assurance — the export outlives the session, carries no access control once it exists, and is
  the artefact a bank decides on (blueprint §10.4).
- **2026-08-24** — **Cash Flow deliberately NOT shipped.** The indirect method needs each account
  classified operating/investing/financing — CoA metadata that does not exist. Inventing it inside a
  reporting query would bury a modelling decision in SQL. Stated as a gap with its own ticket rather
  than shipped on a guess.

---

## F4 session log

- **2026-08-24** — F4-00..F4-06 `202608241019_finance_ar_subledger.sql` + a narrow change to F1's
  posting function. 16 tests green.
- **2026-08-24** — ★ **THE TEST SUITE CAUGHT A REAL MODELLING ERROR, and it is the important
  outcome of this phase.** The reconciliation was written on the obvious identity —
  *open invoices == AR control account* — and it FAILED on first run with the control account
  427,000,000 in credit.
  The cause was not a bug in the code; it was a wrong model. **A receipt credits AR the moment the
  money lands**, before anyone decides which invoice it settles, so a customer who prepays or
  overpays leaves a genuine CREDIT sitting inside a receivable control account. The identity is:

      SUM(open invoices) − SUM(payments on account) = AR control balance

  The migration was fixed rather than the assertion, and `finance_ar_position()` now exposes all
  three numbers so no caller re-derives the identity and gets it subtly different. **The naive
  version would have reported a mismatch on every single prepayment** — which trains people to
  ignore the reconciliation, the precise failure it exists to prevent. The aging report still shows
  OPEN INVOICES only, because a prepayment is not a negative invoice and must not net into a bucket.
- **2026-08-24** — F4-07 authz: 6 keys mapped onto SoD DUTIES rather than CRUD, so the seeded
  `ar_receipt_posting` + `ar_writeoff_approve` conflict is enforceable at all. `finance_staff` holds
  `receipt` and never `write_off`; `company_admin` holds `write_off` but not `issue`/`receipt`
  (forgiving a debt is governance, running the desk is bookkeeping). The role-bundles-are-capability
  caveat from F1 is stated UP FRONT this time rather than corrected after the fact.
- **2026-08-24** — Scope stated, not discovered: **credit limits, dunning and credit memos are not
  in this chunk.** `credit_limit` is stored and deliberately unread — a silently unchecked limit is
  worse than an absent one.

---

## F5 session log

- **2026-08-24** — F5-01..F5-05 `202608241021_finance_ap_subledger.sql`, 14 tests green.
  **Withholding tax is the substance of this phase**, and it is what a generic AP module gets wrong
  in Indonesia. On a 100m services bill with PPh 23 at 2%: the expense is 100m, the VENDOR is owed
  98m, DJP is owed 2m. Two real liabilities, different creditors, different due dates. Booked at
  BILL APPROVAL rather than at payment — the liability to DJP arises when the expense is recognised,
  and it keeps `amount_payable` equal to what the vendor is actually owed, which is what the aging
  must show. An aging that lists gross bills overstates the cash that will leave.
- **2026-08-24** — **F4's lesson transferred cleanly.** The reconciliation identity (open bills −
  payments on account = control balance) was written correctly the FIRST time here, and the suite
  exercises a real vendor prepayment to prove the second term earns its place. That is the payoff of
  having recorded WHY F4's naive version was wrong instead of just fixing it.
- **2026-08-24** — One assertion of mine was wrong and the code was right: the prepayment test
  expected 25m on account and found 26m. The extra 1m is a genuine residue from the withholding
  test — PAY-002 was 50m against a bill with only 49m payable, so 1m sits with the vendor unmatched.
  Corrected the expectation and NAMED the residue in the test, rather than reshaping the fixture to
  hide it.
- **2026-08-24** — F5-06 authz: a FINER split than AR (5 action groups vs 3), because AP carries TWO
  seeded conflicts and is where money leaves. `vendor_master` is its own right specifically because
  editing a vendor's BANK DETAILS redirects payment on a genuine invoice — no fake bill needed. The
  AR/AP asymmetry is deliberate: a customer's bank details move no company money.
- **2026-08-24** — Cross-subledger boundary proven: a posting tagged `'ar'` is REFUSED on the AP
  control account. F4-00's narrow design — unlock only the MATCHING control account, never a blanket
  "allow control accounts" flag — holds under test.

---

## F6 session log

- **2026-08-24** — F6-01..F6-04 `202608241023_finance_bank_and_close.sql`, **13 tests green on the
  first run**. Three design decisions carry this phase:
  1. **The auto-matcher REFUSES ambiguity.** It matches only on an exact amount + direction +
     near-date triple, and where two ledger lines equally qualify it leaves the bank line for a
     human. Proven with two identical same-day payments to different vendors. An aggressive matcher
     clears the queue and produces a reconciliation that LOOKS complete while pairing the wrong
     payment with the wrong invoice — which surfaces months later as a customer chasing money we
     recorded against somebody else. An unmatched item costs a minute; a wrong match costs a
     relationship and an audit finding.
  2. **There is no plug.** `finance_bank_reconcile()` reports GL balance, statement balance, each
     class of item in flight, and the unexplained residue. No adjustment field exists — a difference
     nobody can explain IS the finding, and typing it away turns a real problem into a rounding line.
  3. **The statement is never edited to match the ledger.** No function updates a transaction row.
     The test proves the correct way to clear an unrecorded bank charge is to POST it.
- **2026-08-24** — **F6-04 is the capstone of the whole program so far.**
  `finance_period_close_readiness()` answers "can we close?" by aggregating every integrity check
  built across F1/F3/F4/F5/F6 plus the D-F5 sign-off, one row per blocker. A missing statement and
  an unexplained difference are kept as SEPARATE blockers on purpose: one means "nobody imported
  it", the other means "the money does not agree", and merging them sends the wrong person to
  investigate. The suite proves an unexplained bank difference BLOCKS the close, and that readiness
  itself closes nothing — F0's state machine still refuses `OPEN → HARD_LOCK` and still refuses an
  unsigned hard lock.
- **2026-08-24** — F6-05 authz: **the first finance kind where the SoD pair is satisfied by
  construction rather than caught by the duty matrix.** `bank_reconcile` + `cash_custody` is
  blocking; `finance_staff` reconciles but cannot release payments (F5 keeps `payment_release` at
  manager tier), so the default staffing — officer reconciles, controller releases — satisfies it
  with nobody configuring anything.
- **2026-08-24** — ⚠ **Tooling trap worth recording: these repo files are CRLF.** A scripted
  anchor replacement using `\n` silently matched nothing and reported "anchor missing" while the
  text was plainly present. Use the Edit tool for anchored edits in this repo, or normalise line
  endings first. Cost about ten minutes of chasing a phantom.

---

## F7 session log

- **2026-08-24** — F7-01..F7-05 `202608241025_finance_tax_and_returns.sql`, **14 tests green first
  run**. Three things carry this phase:
  1. **Input VAT with no e-Faktur is NOT creditable** — the one tax rule with a direct money
     consequence. It is EXCLUDED from the claim and reported separately rather than netted: the
     company pays it and cannot reclaim it, so the amount lost must be visible while somebody can
     still chase the vendor. The test asserts the payable is *not* the number you would get by
     wrongly including it.
  2. **A single `rate` column cannot express Indonesian PPN.** Since 2025-01-01 the statutory rate is
     12% applied to ELEVEN TWELFTHS of the base — an effective 11%. Storing "11%" loses what the tax
     office cares about; storing "12%" alone overstates by ~9%. Codes carry both, and are
     effective-dated so a 2024 supply keeps its full-base 11% and a prior-period return still
     reproduces.
  3. **A return snapshots its figures AS FILED.** A late invoice booked after filing moves the live
     figure; the filed figure must not, because an auditor asks about exactly that gap. Pinned by a
     test that books a late invoice and checks both numbers.
- **2026-08-24** — `finance_tax_efaktur_exceptions()` reports TWO kinds and they are deliberately not
  merged: `AR_MISSING_EFAKTUR` is a compliance failure (our customer cannot credit it either, and
  they will ask), `AP_INPUT_VAT_LOST` is a money loss. Same symptom, opposite consequence, different
  person to chase — merging them into "missing e-Faktur" sends the wrong one.
- **2026-08-24** — F7-06 authz: `file` is the module's highest bar alongside `ap.payment_release`,
  because it is the only action that makes a statement to the STATE. It does NOT transmit —
  that stays with a licensed ASP/PJAP per D-F2's carve-out; it records that a return was lodged.
  `configure` is the one action `company_admin` does NOT get: a tax code changes the tax on every
  future document, which is a different order of authority from preparing this month's return.

---

## F2 session log

- **2026-08-24** — F2-01..F2-04 `202608241027_finance_posting_rules.sql`, 16 tests green.
  **The most important decision in this phase is a refusal: there is no expression language.** A rule
  line takes an amount from a NAMED PATH in the event payload times an optional fixed multiplier, and
  nothing else. The moment a rule can compute, the chart of accounts becomes a programming language
  with no debugger, no tests and no review — and "why did this post there?" stops having a short
  answer. Accounting mappings are audited by people who READ them. If a mapping needs logic, the
  emitting module computes the number and puts it in the payload, where it is ordinary code with
  ordinary tests.
- **2026-08-24** — The seam is proven by a test that asserts the event payload contains **no
  accounting vocabulary at all** — Sales emits `{gross, net, tax}` and never learns that revenue is
  4100. That is the whole point: the chart of accounts is editable data (D-F5), so any module that
  hardcoded an account would be wrong the day the accountant renumbers it.
- **2026-08-24** — **It adds no second way into the ledger.** `finance_process_event()` builds lines
  and hands them to F1's `finance_post_journal()`, so an unbalanced rule fails with
  `FINANCE_UNBALANCED` and a locked period with `FINANCE_PERIOD_CLOSED` — F1's own errors, pinned by
  test. A posting-rule engine that wrote journals directly would be a second implementation of nine
  invariants.
- **2026-08-24** — The test suite caught a genuinely bad error message on first run: a rule created
  today cannot post an event dated in February (`effective_from` defaults to CURRENT_DATE), and the
  error said **"no active posting rule"** while the rule sat there plainly active. The dating
  behaviour is correct and deliberate — back-dating a mapping silently would re-map history — but
  the diagnostic was wrong. Split into `RULE_NOT_EFFECTIVE` (naming the rule and its dates, with a
  hint) versus `NO_ACTIVE_RULE`. Two different problems, two different fixes; one message was
  costing an hour.
- **2026-08-24** — F2-05 authz: `process` is DELIBERATELY WIDE because it is the agent/automation
  path required by the program's agentic-native bar — it applies an approved mapping and cannot
  invent accounting. `company_admin` holds `read` ONLY here, the narrowest it has been in the module:
  an administrative role has no business deciding where revenue lands, nor running the queue.

---

## ⚠ CORRECTION — what is actually a blocker, and what is not (owner challenge, 2026-08-24)

Several session summaries above called the ownership map and the accountant sign-off "the two things
no phase can supply" and implied they block the program. **The owner challenged that and is right.**
Correcting the record, because the wrong framing would make someone wait for the wrong thing:

| Thing | What it ACTUALLY gates | What it does NOT gate |
|---|---|---|
| **Ownership map** (`company_ownership` rows) | Owner/shareholder scope resolution under D-F8 — an owner with no edge resolves to an empty company set | Everything else. **Staff access comes from IAM positions**, not ownership. Posting, statements, AR, AP, bank, tax all work with the table empty |
| **Accountant sign-off** (`signed_off_by`) | Exactly ONE transition: `SOFT_LOCK → HARD_LOCK`. It refuses an ANONYMOUS declaration that figures are final | Posting · statements · subledgers · reconciliation · returns · soft-locking. All work without it |

Neither blocks development, and neither blocks deployment. They are **inputs for first real use**,
which is a different thing.

**And the accountant premise is now out of date.** D-F5 was written on "we don't have [an accountant]
yet". The owner reports an **internal finance and accounting manager is available**. So the sign-off
gate is not waiting on a hire — it is waiting on three ordinary setup steps:

1. an ERP account for that person (the owner's own D-F5 ruling: "the company will give the
   accountant an account to this ERP"),
2. a `finance_manager` grant scoped to the companies they are responsible for,
3. their review of the instantiated chart of accounts.

Then `finance_period_close_readiness()` stops reporting `NO_ACCOUNTANT_SIGNOFF` — because the
control is satisfied, not because it was removed. That gate exists so nobody can declare a period
final anonymously, and having a named person is precisely what makes it pass.

**The real gap to usable software is the APPLICATION LAYER, and no phase covered it.** F0–F7 and F2
are schema, SQL functions, Cerbos policy and tests. There is no `src/modules/finance`, `finance` is
not in the module registry, and there is no endpoint or UI. A deploy today would land the tables and
the policies and deliver nothing anyone can use. That — not the ownership map, not the accountant —
is what stands between this program and a working department.

---

## FA · APPLICATION LAYER — the surface a person can actually reach

Added after the owner's deploy request surfaced the real gap: F0–F7 and F2 were schema, SQL, Cerbos
policy and tests, with **no module, no endpoint and no UI**. A deploy would have landed the tables
and delivered nothing usable.

| ID | Task | Status | Notes |
|---|---|---|---|
| FA-01 | `financeModule` contract + registration | **PROTOTYPED** | `src/modules/finance/index.ts`; registered in `main.ts` and `app.module.ts`. 21 declared permissions, 6 READ-ONLY MCP tools |
| FA-02 | `FinanceController` — 19 endpoints | **PROTOTYPED** | Chart · periods · TB · P&L · BS · GL · journals (read/post/reverse) · ledger verify · AR/AP aging + reconcile · PPN · e-Faktur exceptions · close readiness · event backlog/process |
| FA-03 | `FinanceErrorFilter` | **PROTOTYPED** | Maps the `FINANCE_*` refusal family onto HTTP. **This is the FIFTH time this estate has shipped the body-less-500 bug** |
| FA-04 | API test suite | **DEV-VERIFIED** | `src/modules/finance/finance.test.ts` — **19 tests** against live Postgres + RLS + Cerbos |
| FA-05 | Capability inventory regenerated | **DEV-VERIFIED** | Generated artifact; the suite failed correctly on registration and now passes both ways |

### FA session log

- **2026-08-24** — The controller is THIN on purpose. Every figure comes from a SQL function; it
  authorizes, scopes and shapes JSON and computes no accounting. If a handler here ever starts doing
  arithmetic on money, that arithmetic belongs next to the constraint that guards it.
- **2026-08-24** — `withFinance()` is the ONLY database path in the module, and that is not style.
  Every `finance_*` table is module-walled, so a plain `withTenants()` returns **zero rows with a
  200** and looks like it worked. The API suite's first test exists specifically to fail if that
  helper ever loses `{ modules: ["finance"] }`.
- **2026-08-24** — ★ **THE FIFTH BODY-LESS 500.** An unbalanced journal — the most common mistake in
  bookkeeping — came back as `500 {"error":"internal error"}`. The database had already computed
  `debits (100) <> credits (90)` and the transport threw it away, because plpgsql errors arrive as
  pg's `DatabaseError` (a plain `Error`) and `HttpErrorFilter` only catches `HttpException`.
  `client-access-error.filter.ts`'s own header counts four prior instances of this exact bug.
  Fixed with a typed filter, not a try/catch. Two things worth keeping:
  - it is scoped to `@Catch(DatabaseError)`, **not** a bare `@Catch()`. The first draft caught
    everything and re-threw what it did not recognise — which broke the controller's own 400s,
    because **re-throwing from inside a filter does not hand the error to the next filter**;
  - unrecognised `FINANCE_*` codes default to **409 with their own message**, so a refusal added by
    a future migration is mapped by construction rather than by remembering to edit the filter.
- **2026-08-24** — The API suite pins the authorization tiers against a **live PDP**, which a SQL
  test structurally cannot: `finance_staff` reads the ledger and runs the integrity check but is
  **refused a journal post (403)**; a plain member cannot even read the chart of accounts.
- **2026-08-24** — MCP tools are **READ-ONLY this wave**, deliberately. An agent may look at the
  trial balance, the aging, and what is blocking the close — genuinely useful. No tool posts a
  journal: under D14 an agent-initiated entry must be a PROPOSAL a human approves, and the finance
  approval surface does not exist yet. Shipping the write tool first would put the estate one
  mis-parsed instruction away from a journal nobody asked for.
- **2026-08-24** — Rollup providers deliberately empty. A finance metric reaching the group
  dashboard would be a cross-company money figure, and §10.3a is explicit that a naive sum
  double-counts intercompany. That needs F9's elimination engine, not a rollup provider.

**Still not deployable, and the reason has changed.** There is now a working surface — but the
checkout carries ~42 files of other sessions' in-flight work (LMS, GM console), and a deploy is
`git push --tags` over the whole tree. That is a coordination problem, not a finance one.

---

## DEPLOY ATTEMPT — `alpha-01.071.0153a` (2026-08-24 16:07 UTC)

**Result: code and schema are LIVE; the running containers are NOT.** Precisely:

| Step | Outcome |
|---|---|
| `main` push (`9a15a64` + MAP fix `4f6a772`) | ✅ on origin |
| Tag `alpha-01.071.0153a` | ✅ pushed |
| `build-sign` × 10 components (cosign keyless + SBOM + SLSA) | ✅ all green |
| `docs-map` | ✅ green after regenerating MAP from a clean worktree |
| **`Run migrations`** | ✅ **the 13 finance migrations APPLIED to the live database** |
| `Start services` | ❌ `gaiada-platform-1` unhealthy |
| Rollback to `0150a` | ❌ also unhealthy — and that is the tell |

### ⚠ The deploy failure is PRE-EXISTING and not caused by this work

| Release | Failed at | Subject |
|---|---|---|
| `0150a` 09:57 | — | **last successful deploy** |
| `0151a` 13:38 | `Build and push` | fix(authz,hub): validate tool args and :tenantId |
| `0152a` 14:05 | **`Start services`** | release: add the missing client-filter module |
| `0153a` 16:10 | **`Start services`** | this finance release |

`0152a` failed at the identical step **two hours before this work was tagged**, and the rollback to
`0150a` was unhealthy too. The box has not accepted a deploy since 09:57.

**It is also not the finance code.** The built app was booted locally against a fresh database from
current HEAD — which contains `0152a`'s changes *and* finance — and it started cleanly, applied all
migrations, passed `validateModulePermissions()` for all 21 declared finance permissions, and
listened on 3004. So the image is good; something about the BOX rejects it. The most likely shapes,
given this program's own history: a new env var not passed through the compose `environment:` block,
or a healthcheck window too short for boot. Diagnosing it needs SSH, which this session does not have.

### Is the current state safe?

Yes, and deliberately so. The migrations are **additive throughout** — no `ALTER` of an existing
column, no `UPDATE`, no `DELETE` (`lint-migration-rls` green across all 13). The running `0150a`
code does not know the `finance_*` tables exist and ignores them. Newer schema under older app is
the normal forward-only posture, not a broken state. The deploy log says so itself:
*"Rolled back to alpha-01.071.0150a. Schema was NOT reverted."*

**What it means in practice:** the finance schema is on the live database and will be there when the
box next accepts a deploy. The finance API and module are not serving yet. Nothing is half-applied.

### Handover for whoever fixes the box

The question is why `gaiada-platform-1` fails its healthcheck on the server when the same image
boots locally. Start with `0152a` (client-filter module) — it is the first release that failed this
way. Check the box's `infra/compose/.env` against what the new code reads, and the platform service's
healthcheck `start_period`. Do NOT start by suspecting the finance migrations: they had already been
applied successfully when `Start services` failed, and the rollback to a pre-finance image failed
identically.
