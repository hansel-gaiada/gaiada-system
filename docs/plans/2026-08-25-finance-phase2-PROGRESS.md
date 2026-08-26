# Finance Phase 2 — assets, consolidation, cutover, treasury · PROGRESS

**Session opened 2026-08-25.** Continues `2026-08-24-finance-PROGRESS.md` (F0–F7 + FA, 80 items,
0 outstanding, deployed at `alpha-01.071.0156a`). Design:
`docs/blueprints/finance-accounting-foundation.md`.

Owner asked for four things plus the live seed:

1. **Seed live finance** — blocked on answers (§A below).
2. **A depreciation engine — "real and proper".**
3. **Consolidation.**
4. **Opening + closing balances and cutover.**
5. **Everything money-shaped: loans, bonds, etc.**

Status vocabulary: `PLANNED · IN PROGRESS · PROTOTYPED · DEV-VERIFIED`. Nothing here is production.

## Roll-up

| Track | Items | PLANNED | IN PROGRESS | PROTOTYPED | DEV-VERIFIED |
|---|---|---|---|---|---|
| S · Seed live finance | 6 | 0 | 0 | 0 | **6** |
| F8 · Fixed assets + depreciation | 14 | 1 | 0 | **13** | 0 |
| F9 · Consolidation | 12 | 7 | 0 | **5** | 0 |
| F10 · Opening balances + cutover + year-end close | 10 | 10 | 0 | 0 | 0 |
| F11 · Treasury: loans, bonds, leases | 13 | 13 | 0 | 0 | 0 |
| UI · Configuration surfaces (ownership, settings) | 8 | 8 | 0 | 0 | 0 |
| **Total** | **63** | **39** | **0** | **18** | **6** |

---

## §A — ANSWERED 2026-08-26 (owner)

The seed is **UNBLOCKED for one entity**. Ruling, and what each answer forecloses:

| # | Question | Ruling |
|---|---|---|
| A1 | Scope | **Gaia Digital Agency ONLY.** D & A Syrowatka (holding) and Viceroy Bali get NO books yet |
| A2 | Fiscal calendar | **January start — calendar year.** Monthly periods. **First open period: 1 January 2027** |
| A3 | PKP status | **PKP.** CoA carries PPN Keluaran / PPN Masukan; invoices carry PPN; F7 stays as designed |
| A3 | Withholdings | **PPh 21 (payroll) ONLY.** No PPh 23, no PPh 4(2) |
| A4 | Existing books | **Start clean — NO opening balances.** ERP books begin at zero on 1 Jan 2027 |

**What this changes in the build**

- **F10 shrinks a lot but does not vanish.** No opening-balance import is needed, so the trial-balance
  ingest path is out of scope for this entity. Year-end close is still required — and because 1 Jan
  2027 is a fiscal-year boundary, FY2027 is a complete year with no stub-period special cases. That
  was the point of the date.
- **F9 consolidation cannot be exercised for real yet.** Consolidation needs a parent and at least one
  subsidiary with books; only one entity has them. Build it against fixtures, but do NOT mark it
  DEV-VERIFIED on live data until a second entity is seeded — a green consolidation over a single
  set of books proves nothing.
- **PPh 23 and PPh 4(2) accounts are NOT created.** ⚠ This is a claim about today, not a permanent
  fact: the moment the agency withholds on a vendor service fee or on office rent, the obligation
  exists whether or not the account does. Missing withholding on a live transaction is a filing
  problem, not a bookkeeping one. Re-ask before the first vendor payment run.
- **PKP is asserted, not verified.** The CoA is being cut on the owner's word; nobody has read a
  PKP certificate. Worth one confirmation before 1 Jan 2027, since un-picking PPN accounts after
  books open is a reversal exercise under D-F1.

**STILL NEEDED before the seed can be written** (facts, not decisions):

1. **Full legal name of the PT** — exactly as registered. The books of record carry it.
2. **NPWP — does one exist?** Do not paste it here. Say yes/no and I wire the field for the
   accountant to enter.

**Timing note:** with a 1 Jan 2027 first period there is real runway. F10, F11 and the config UI
(31 items) can all land before anything is live. Nothing about this seed is urgent — but items 1–2
above should be captured while they are easy to get.

---

## §A — original blocking questions (superseded by the above, kept for the reasoning)

The live estate is **3 companies**: `D & A Syrowatka` (holding, root) · `Gaia Digital Agency`
(finance module already ON) · `Viceroy Bali`.

Seeding writes a chart of accounts and cuts a fiscal calendar **into the books of record**. Under
D-F1 a wrong figure is corrected by reversal, never by editing — so a wrong fiscal-year start is
not a quick fix later. Hence: ask, do not guess.

### A1. Scope — which entities get live books now?
- Are all three ERP companies **separate legal entities (PT)**, or are some brands/divisions inside
  one PT? *(This decides whether they get separate books at all — a brand does not get its own
  ledger, a PT must.)*
- Full legal name per PT.
- Which get books **now**, which later?

### A2. Fiscal calendar (per entity)
- Fiscal year **start month** — Jan–Dec, or something else?
- **Period granularity** — monthly assumed. Confirm.
- **First open period** — the cutover date; books start here.

### A3. Tax identity (per entity)
- **NPWP** — does one exist per entity? Do **not** paste it in chat; say whether it exists and I
  will wire the field for the accountant to enter.
- **PKP status** — PKP or non-PKP? *(non-PKP ⇒ no PPN output at all; this changes the CoA and the
  F7 surface.)*
- Which withholdings actually occur: **PPh 21** (payroll) · **PPh 23** (services) · **PPh 4(2)**
  (final — rent, construction)?

### A4. Existing books — the cutover question
- Is there **any** existing bookkeeping? (Accurate · Mekari/Jurnal · Xero · Zahir · spreadsheets ·
  none)
- If yes: as-at date of the last closed period, and can we get a **trial balance** + open AR/AP
  lists + bank balances + fixed asset register at that date?
- If none: books start clean at the cutover date and there are no opening balances beyond capital.

### A5. Chart of accounts
- Adopt **our template CoA** (4-digit, e.g. `1120 Bank`), or **mirror the existing books' CoA** so
  history reconciles? *(Mirroring is more work but makes the cutover verifiable against the old
  system — usually the right call when books already exist.)*
- Base currency **IDR** for all? Any entity whose functional currency is not IDR?

### A6. People — who gets which seat
Roles are seated from IAM positions; ownership rows are separate (they gate owner/shareholder
scope, not staff access).
- Who is the **accountant** (email) per entity — the ERP account that will actually keep the books?
- Who is the **finance manager** (email) — approves, signs off periods?
- Owner said *"approval from Anthony"* for cross-company visibility. Anthony's ERP email, and is he
  the `finance.cross_company_approver` for all entities?

### A7. Ownership map (Q9 — `company_ownership` is live and EMPTY)
Until rows exist, owner/shareholder scope resolves to **nothing**, and consolidation (F9) has no
control determination.
- For each PT: who holds what **%**, and is the holder a person or another PT?
- Who is also a **director/commissioner** (separate from shareholding)?
- Holding owner = sees all. Which people are company-owner/shareholder-scoped, and to which
  companies?

### A8. Bank accounts (needed for F6 bank rec to be real, not for the seed itself)
- Which bank accounts per entity, and which bank? Statement format available (CSV/OFX/MT940)?

---

## §B — DESIGN QUESTIONS for the four new streams

These change what gets built, so they are worth answering before the code exists.

### B1. Depreciation — book only, or book **and** tax?
Indonesian tax depreciation (PMK golongan: Gol 1/2/3/4 + bangunan permanen/non-permanen, garis
lurus or saldo menurun) frequently **differs** from the useful life used for PSAK book purposes.
Two sets of numbers ⇒ a **temporary difference** ⇒ **deferred tax** (PSAK 46).
- **Book only** — one schedule. Simpler, but the tax return needs a manual adjustment every year.
- **Book + tax, with deferred tax** — the "real and proper" answer, and required if an auditor or a
  bank is going to look at the statements. Materially more engine.

### B2. Consolidation — how far?
- **Full consolidation** of >50%-held subs with **NCI** (PSAK 65), **equity method** for 20–50%
  (PSAK 15)? Or is everything wholly-owned, making NCI dead code?
- Are there **intercompany transactions** to eliminate (management fees, loans between PTs,
  cross-charges)? If yes, elimination journals are mandatory — a naive sum would double-count.
- Any **goodwill** from an acquisition? Any **foreign-currency** subsidiary needing translation
  (PSAK 10)?

### B3. Treasury — which instruments actually exist?
- **Loans payable** (bank/shareholder)? **Loans receivable**? **Bonds issued**? **Leases**?
- Are any at a rate that differs from market, or with fees, such that **amortised cost / effective
  interest** (PSAK 71) matters — or is straight-line interest adequate?
- **PSAK 73 leases** create a right-of-use asset that depreciates — that ties F11 back into F8, so
  it matters whether leases are in scope.

### B4. Year-end close
- Confirm the retained-earnings roll: close P&L to **`3200 Retained earnings`** at fiscal year end?
- Is there a **dividend** process to model, or is that manual for now?

---

## §C — TASKS

### S · Seed live finance

| ID | Task | Status | Notes |
|---|---|---|---|
| S-01 | Confirm entity scope (A1) | **DEV-VERIFIED** | Owner: all three entities get books. Legal PT names still to confirm for invoices/e-Faktur — does not block the ledger |
| S-02 | Cut fiscal calendar per entity (A2) | **DEV-VERIFIED** | FY2026 Jan–Dec, **12 monthly periods, all OPEN**, on all three. Verified by direct query, not by the seed's own output |
| S-03 | Instantiate CoA per entity (A5) | **DEV-VERIFIED** | Our `id_psak_general_v1` template (no prior books to mirror). **69 accounts, 5 control accounts**, IDR, fyStart=1, on all three |
| S-04 | Seat accountant + finance manager (A6) | **DEV-VERIFIED** | Owner ruling 2026-08-25: *“i can be the subtitute to prroof our work in this dev stage”*. `hansel@gaiada.com` holds `finance_manager` on all three, live. Registered as P-01/P-02 in `docs/PLACEHOLDER-PRINCIPALS.md`. ⚠ **SoD is still NOT in force** — one account posts and approves. Accepted for dev; must be retired before real transactions |
| S-05 | Load `company_ownership` rows (A7) | **DEV-VERIFIED (default only)** | Anthony 100% `holding` on D & A Syrowatka, live. Verified: `finance_owner_company_ids(anthony)` resolves to **all 3 companies**. ONE row, not three — a holding edge confers the company + all descendants; three shareholder rows would resolve the same while asserting a false cap table. **Any further shareholders await owner data + UI-01** |
| S-06 | Prove the finance surface end to end | **DEV-VERIFIED (by simulation)** | Owner ruling: *“s-06 can use simulation to proof it”*. `finance-cycle-simulation.test.ts` — 12 assertions driving the REAL HTTP surface through the REAL guards and a LIVE Cerbos: a whole month of agency books from an empty ledger to a close verdict. ⚠ Proves the SYSTEM, not the live estate's data |

### F8 · Fixed assets + depreciation

| ID | Task | Status | Notes |
|---|---|---|---|
| F8-01 | Asset register schema | **PROTOTYPED** | `finance_asset_classes` + `finance_assets`, migration 202608251030. Componentisation via `parent_asset_id` — a component is a full asset row, so it gets its own schedule with no special-casing |
| F8-02 | Depreciation methods | **PROTOTYPED** | straight_line · declining_balance · units_of_production · none, as DATA on the class with per-asset override |
| F8-03 | Tax golongan on the same asset | **PROTOTYPED** | `finance_tax_golongan_params()` holds UU PPh Ps. 11. Life/rate DERIVED from the golongan, never stored — they are law, and a stored copy invites an accountant to “correct” a statutory rate. Buildings on saldo menurun refused by CHECK |
| F8-04 | Schedule generator (book + tax) | **PROTOTYPED** | `finance_asset_depreciation_schedule()`. DERIVED, never stored — PSAK 16 requires annual review of life and residual, so revision is the normal case and a stored schedule goes stale silently |
| F8-05 | Monthly depreciation RUN | **PROTOTYPED** | `finance_run_depreciation()` (202608251130). ONE aggregated journal per period, not one per asset. ★ **Tax is recorded on the line but NEVER posted** — it belongs on a tax computation, not in the statements |
| F8-06 | Idempotent run | **PROTOTYPED** | `ux_finance_dep_runs_period` — one run per period as a UNIQUE INDEX. The only form of idempotency that survives a retried job or two concurrent operators |
| F8-07 | Deferred tax (PSAK 46) | **PROTOTYPED** | `finance_deferred_tax_position()` + `finance_post_deferred_tax()` (202608251230). ★ The posting **adjusts to a target**, it does not post the computed figure — posting it each period accumulates, and by year three the sheet carries 3x the real balance while every entry looks correct. Rate is a PARAMETER, not a constant |
| F8-08 | Additions (capitalisation) | **PROTOTYPED** | `finance_capitalise_asset()` posts DR asset / CR funding via `p_subledger := 'fixed_assets'`, the only thing permitted to touch the `1210` control account. Double-capitalisation REFUSED, not silently ignored. Transfers + revaluation still PLANNED |
| F8-09 | Disposals | **PROTOTYPED** | `finance_dispose_asset()`. Derecognises **both** cost and accumulated depreciation — crediting cost alone strands accum in `1220` and the sheet eventually shows negative net fixed assets. Gain/loss to `7400`, sign carrying the meaning |
| F8-10 | Impairment (PSAK 48) | **PROTOTYPED** | `finance_impair_asset()`, booked against accumulated depreciation so original cost stays visible. Refused above carrying amount — that input is wrong, not an asset worth negative money |
| F8-11 | CIP / assets under construction → capitalisation on in-service | PLANNED | depreciation must NOT start before the in-service date |
| F8-12 | Reconcile register ⇄ GL | **PROTOTYPED** | `finance_fa_reconcile()`. An uncapitalised asset is NAMED, not netted into a total. Pinned by a test that drives the check RED — a tie-out that cannot fail is not a tie-out |
| F8-13 | Close interlock | **PROTOTYPED** | `finance_fa_close_blockers()`. Unrun depreciation overstates profit and a close is terminal, so it BLOCKS. Not a blocker when there is nothing to depreciate |
| F8-14 | Movement schedule | **PROTOTYPED** | `finance_fa_movement()` (202608251330). Derived from the REGISTER, not the GL — a schedule read out of the GL agrees with the balance sheet by construction and could never reveal a drifted register, which is the failure it is printed to rule out |

### F9 · Consolidation

| ID | Task | Status | Notes |
|---|---|---|---|
| F9-01 | Control determination | **PROTOTYPED** | `finance_group_members()` (202608251530). Derived from ownership, never a stored flag. Reports the BASIS used — PSAK 65 control is about power, not arithmetic ⚠ requires the candidate tenants already in scope: an ownership edge lives in the OWNED company's tenant, so the read is circular and is resolved by sequence, not privilege |
| F9-02 | Consolidation group + reporting entity | **PROTOTYPED** | `finance_consolidation_runs` keyed by (parent, as_of). A run is a SNAPSHOT of a judgement and is never edited — a changed elimination means a new run, so “what did we report in March” stays answerable |
| F9-03 | **Separate consolidation ledger** | **PROTOTYPED** | `finance_consolidation_entries` — deliberately NOT the journal tables. Pinned by a test asserting the subsidiary's own receivable is UNCHANGED after eliminating |
| F9-04 | Intercompany tagging | **PROTOTYPED** | `finance_accounts.counterparty_company_id` (202608251430) — on the ACCOUNT, not the journal. The ledger is immutable, so a journal tag could only be set at posting time via a 13th parameter on a 313-line function with 7 callers. An account must be CHOSEN, so a mis-posted related-party balance is visible rather than invisible |
| F9-05 | Intercompany balance elimination | **PROTOTYPED** | `finance_eliminate_intercompany()`. REFUSES on a disagreeing pair — netting hides a real reconciling item, forcing invents a number. A balance with an entity OUTSIDE the group survives |
| F9-06 | Intercompany revenue/expense elimination | PLANNED | |
| F9-07 | Unrealised profit elimination (inventory, fixed assets sold intragroup) | PLANNED | |
| F9-08 | Non-controlling interest (PSAK 65) | PLANNED | gated on B2 |
| F9-09 | Equity method for associates (PSAK 15) | PLANNED | gated on B2 |
| F9-10 | Goodwill on acquisition | PLANNED | gated on B2 |
| F9-11 | FX translation of a non-IDR sub (PSAK 10) | PLANNED | gated on B2 |
| F9-12 | Consolidated TB / P&L / BS + the group console showing a REAL consolidated figure | PLANNED | ★ until F9-05..07 exist the console must NOT label a naive sum "consolidated" |

### F10 · Opening balances, cutover, year-end close

| ID | Task | Status | Notes |
|---|---|---|---|
| F10-01 | Opening-balance journal: `source=OPENING`, balanced, one per entity per cutover date | PLANNED | |
| F10-02 | A silent suspense/equity plug is FORBIDDEN — an unbalanced opening must fail loudly | PLANNED | |
| F10-03 | Open AR invoice load ⇒ must tie to the AR control account | PLANNED | reuses `finance_ar_reconcile` |
| F10-04 | Open AP bill load ⇒ must tie to the AP control account | PLANNED | |
| F10-05 | Bank opening balances ⇒ must tie to the bank control account | PLANNED | |
| F10-06 | Fixed-asset register opening incl. accumulated depreciation to date | PLANNED | F8 dependency |
| F10-07 | Cutover gate: opening TB balances AND every subledger ties, else cutover is refused | PLANNED | ★ the whole point of a cutover phase |
| F10-08 | HARD_LOCK every pre-cutover period | PLANNED | history is not editable |
| F10-09 | Year-end close: roll P&L to retained earnings (B4) | PLANNED | the balance sheet already carries current-year profit pre-close |
| F10-10 | Re-open protection: a closed year is terminal; corrections go to an open period | PLANNED | consistent with D-F1 |

### F11 · Treasury — loans, bonds, leases

| ID | Task | Status | Notes |
|---|---|---|---|
| F11-01 | Instrument model: principal, rate, dates, counterparty, currency | PLANNED | one model, many instrument kinds |
| F11-02 | Repayment schedule generator (annuity, straight principal, bullet) | PLANNED | |
| F11-03 | Interest accrual posting per period | PLANNED | accrual ≠ payment; both must post |
| F11-04 | Amortised cost / effective interest (PSAK 71) | PLANNED | gated on B3 |
| F11-05 | Loans receivable (the mirror side) | PLANNED | |
| F11-06 | Bonds issued: par, coupon, premium/discount amortisation | PLANNED | gated on B3 |
| F11-07 | Lease liability + right-of-use asset (PSAK 73) | PLANNED | ★ the ROU asset depreciates ⇒ hands off to F8 |
| F11-08 | Current/non-current split by maturity | PLANNED | a bank reads this off the balance sheet |
| F11-09 | FX revaluation of foreign-currency debt | PLANNED | |
| F11-10 | Intercompany loans flagged for F9 elimination | PLANNED | F9-05 dependency |
| F11-11 | Maturity + covenant schedule for the bank-ready pack | PLANNED | |
| F11-12 | Reconcile instrument balances ⇄ GL control accounts | PLANNED | same verdict contract |
| F11-13 | Close interlock: unposted accruals block the close | PLANNED | |

---

## Constraints carried forward from F0–F7 (binding, do not relitigate)

- **Reversal-only correction.** No UPDATE, no DELETE, on anything posted.
- **Contra sign comes from `normal_balance`**, never a hardcoded account list. Accumulated
  depreciation (F8) and bond discount (F11) are both contra — this is why that rule exists.
- **A verdict must never degrade to a pass.** New reconciliations follow `financeVerdict`, not
  `financeData`.
- **No computed money in the UI.** Figures come from a SQL function next to the constraint that
  guarantees them.
- **Adding a Cerbos kind touches five coupled artifacts** (catalog, bundles, migration, policy,
  parity suites) — one change or the parity suites break for every other session.
- **Agentic-native bar**: every capability must work identically under a human, n8n, and an agent.

## Session log

- **2026-08-25** — Plan opened. 55 tasks across S/F8/F9/F10/F11, all PLANNED. Seeding blocked on
  §A; F8/F9/F11 shape gated on §B. Live estate confirmed as 3 companies (holding + agency + resort;
  the agency already has the finance module enabled).

- **2026-08-25** — **Live finance SEEDED** at `alpha-01.071.0157a`, all three entities. 69 accounts /
  5 control / 12 OPEN monthly periods / IDR / fyStart=1 each. `finance_trial_balance` runs and
  balances (0=0 on empty books, which is the correct answer, not a missing one) and
  `finance_balance_sheet` returns. Verified by direct query against the live DB rather than from the
  seed's own output.
  - Owner answers folded in: **no existing books** (so our CoA template, and F10's opening shrinks
    to capital only) · **book + tax depreciation with deferred tax** (F8 is the full engine) · **all
    three entities** · **Jan–Dec**.
  - Judgment call made rather than asked: calendar cut from **2026-01-01** so FY2026 exists in full;
    Jan–Aug are OPEN for the accountant to close. 7 ended periods correctly report
    `NO_ACCOUNTANT_SIGNOFF`.
  - **Seeded with `--no-seats`.** S-04 is the real remaining blocker: without a named accountant and
    finance manager, nobody can keep these books.

---

## Owner answers, 2026-08-25 (second round)

| # | Answer | What it changes |
|---|---|---|
| **A3** | **PKP** — "should be PKP because its a company". Must be **settable in UI** | `finance_company_settings.is_pkp` already exists. Seeded true as a DEFAULT; needs a UI editor (UI-02) |
| **A6** | Point every blocked person-assignment at **`hansel@gaiada.com`**, and **document the usage** so it can be moved to the real person later | `docs/PLACEHOLDER-PRINCIPALS.md` created. Register entry is now part of making the grant, not an afterthought |
| **A7** | Ownership must be **CRUD-able in UI** — person, percentage, which company. Default **Anthony 100%** | UI-01. Anthony is a real account; the default is one `holding` edge, not three shareholder rows |
| **B2** | **Yes — there ARE intercompany dealings** | ⭐ **Eliminations are now mandatory, not optional.** F9-04..07 are in scope. A naive sum across the three companies would double-count real transactions, so the group console must NOT label one "consolidated" until eliminations exist |
| **B3** | Build **all** of it; the user adds or removes instruments from the book as needed | F11 keeps its full scope (loans, bonds, leases). Instruments are user-managed data, not a fixed list. **PSAK 73 leases are IN**, so the right-of-use asset wires F11 into F8 |

### What B2 costs, stated plainly

Intercompany dealings mean the holding, the agency and the resort transact with each other. Three
consequences that are not optional any more:

1. **Journals need counterparty tagging** (F9-04) at posting time. Retrofitting it means going back
   through history that is append-only — much cheaper to have it from the first entry, which is
   *now*, while the books are empty.
2. **Eliminations must live in a separate consolidation ledger** (F9-03). An entity's own books
   must stay standalone-auditable; an elimination entry must never appear in them.
3. **The group console must not say "consolidated"** until F9-05..07 exist. A naive sum is a
   legitimate figure to show — mislabelling it is not.

---

## UI · Configuration surfaces

Owner: ownership and PKP must both be editable by a person, not only by a seed.

| ID | Task | Status | Notes |
|---|---|---|---|
| UI-01a | `company_ownership` read + write endpoints (list/create/update/end-date) | PLANNED | An ownership edge is **effective-dated**: "remove" = set `effective_to`, never DELETE. Last year's statements were true under last year's cap table |
| UI-01b | Cerbos kind for ownership writes | PLANNED | Touches the five coupled artifacts. Who may edit a cap table is not the same as who may read finance |
| UI-01c | Ownership CRUD UI: holder (person or company), %, which company, dates | PLANNED | Must support BOTH holder kinds — the schema's `num_nonnulls(holder_user_id, holder_company_id) = 1` |
| UI-01d | Stake validation surface: warn when live stakes for a company exceed 100% | PLANNED | The DB caps a single row at 100 but does not sum them. A cap table totalling 140% must be visible, not silently accepted |
| UI-02a | `finance_company_settings` read + write endpoints | PLANNED | is_pkp, npwp, currencies, fiscal_year_start_month |
| UI-02b | Settings UI editor | PLANNED | ⚠ `fiscal_year_start_month` must NOT be freely editable once periods exist — it would invalidate every cut period and every balance sheet's fyStart |
| UI-02c | NPWP handling: PII-scrubbed, encrypted at rest | PLANNED | Program rule: scrub national-ID-shaped values before persist. An NPWP is exactly that shape |
| UI-02d | Guard: turning PKP **off** with posted PPN is refused | PLANNED | Same reasoning as a locked period — it would orphan tax already charged |

- **2026-08-25** — **F8 core landed** (migration `202608251030`, 14 tests green). Schedule generator
  produces book and tax side by side; every figure in the suite is checked against a value computed
  by hand from the statute, not against whatever the function returned.
  - Three bugs the suite caught, all mine: an untyped `NULL` in a `VALUES` list; `SELECT *` returning
    four columns against three declared (Postgres reports both as the same opaque *"return type
    mismatch in function declared to return record"*, naming the function and not the column); and a
    test-harness collision because `newId()` is **uuid v7**, whose leading hex digits are a
    millisecond timestamp — two assets built in the same millisecond derived the same code.
  - ⚠ **A concurrent session has a broken UNTRACKED migration in this shared checkout**
    (`202608250950_lms_l5_lab_runs.sql` — *no unique constraint matching given keys for referenced
    table "lms_attempts"*). It is **not in HEAD**, so the live deploy is unaffected, but it blocks
    every migration-dependent test run from this working tree. F8 was verified in a clean
    `git worktree` for that reason. Not mine to fix — flagged for its owner.

- **2026-08-25** — **F8b landed** (migration `202608251130`, 9 tests green first run). The module is
  now a SUBLEDGER rather than a register: cost reaches the GL through `finance_capitalise_asset()`,
  depreciation posts through `finance_run_depreciation()`, and `finance_fa_reconcile()` checks the
  two against each other.
  - ★ **Tax depreciation is recorded and never posted.** Book depreciation is an entry in the books;
    tax depreciation is a figure on a computation. Posting both would give statements that look
    plausible and are wrong in a way no reconciliation here would catch, because both sides would be
    consistently wrong together. Pinned by a test asserting the line carries 250,000 tax while the
    GL carries only the book charge.
  - The run row is inserted **before** any posting, so the one-run-per-period UNIQUE index rejects a
    concurrent second caller before a journal exists — otherwise the loser leaves an orphan journal.
  - `docs-map` was red for the whole finance wave and is now green. It was mine: a migration, a seed
    and a doc added without regenerating MAP, which fails the gate on EVERY commit and blocks every
    other session. Regenerated from a clean worktree (this checkout carries 26 untracked files from
    concurrent sessions).
  - The LMS L5b migration referenced earlier was fixed by its own session before I touched it; the
    full chain now applies from this checkout.

- **2026-08-25** — **F8c landed** (migration `202608251230`, 10 tests green). Disposal, impairment,
  deferred tax and the close interlock. F8 is now 12 of 14; only transfers/revaluation (part of
  F8-08) and the movement schedule (F8-14) remain.
  - ★ **The deferred-tax posting adjusts to a TARGET.** Posting the computed figure each period is
    the obvious implementation and it accumulates — by year three the balance sheet carries three
    times the real balance while every individual entry looks correct. Pinned by a test that runs
    two periods and asserts the BALANCE equals the second target, not the sum.
  - **Book value from what was POSTED, tax value from the SCHEDULE.** The asymmetry is deliberate:
    an asset depreciates in the books only when a run charged it, while tax depreciation is never
    posted and the schedule is its only record. Using the schedule for both would report book
    values for depreciation the GL never received.
  - Answered the other session: their report of a broken `202608251030` was correct at the time and
    is now stale. Fixed (`SELECT *` returned four columns against three declared), committed, and
    **applied on the live database** — which is stronger evidence than a local run.

- **2026-08-25** — **F8d + F9-04** (migrations `202608251330`, `202608251430`; 6 + 6 tests green).
  F8 is 13 of 14 — only transfers/revaluation remain.
  - **The movement schedule is derived from the REGISTER, deliberately.** Read out of the GL it
    would agree with the balance sheet by construction and could never reveal a register that had
    drifted — which is the one thing the note is printed to rule out.
  - ★ **The intercompany counterparty lives on the ACCOUNT, not the journal.** The obvious design is
    a column on the journal entry; `trg_finance_journal_entries_immutable` forbids UPDATE and DELETE
    on entries, so it could only be set at posting time — a 13th parameter on a 313-line function
    with seven callers, threading NULL almost everywhere. On the account it changes nothing about
    the ledger, it NAMES the counterparty in the chart of accounts, and it cannot be forgotten: a
    journal parameter defaults to NULL and an untagged posting looks normal, while an account has to
    be chosen.
  - ⚠ **Consolidation only works WITHIN a root.** `withTenants` refuses a tenant set spanning two
    root companies, and reading both sides of an intercompany balance is inherently a two-tenant
    read. That is correct — two unrelated holdings must never consolidate — but it means the group
    is bounded by `root_company_id`. The live estate satisfies this: all three companies sit under
    D & A Syrowatka. My first fixture made two independent roots and every cross-company read was
    refused; pinned now.
  - A test pins the RLS zero-row trap in the one place it would be misread as a real accounting
    difference: reading the pair with ONE tenant in scope makes every balance look mismatched by its
    full amount.

---

## Owner rulings, 2026-08-25 (third round) — EVERYTHING IS NOW UNBLOCKED

| # | Ruling | Effect |
|---|---|---|
| **S-04** | *“i can be the subtitute to prroof our work in this dev stage”* | The stand-in is ACCEPTED, not merely tolerated. ⚠ SoD remains off until a second real person exists |
| **S-06** | *“s-06 can use simulation to proof it”* | Proved by `finance-cycle-simulation.test.ts`, 12 assertions through the real API |
| **Q3** | *“all companies has to be bank ready. but start with Gaia digital agency first”* | F9–F11 are in scope for all three entities; **Gaia Digital Agency is the reference implementation** |
| Scope | *“proceed with finishing F9, F10, F11, UI, F8-11”* | 39 items, no remaining owner blockers |

### Why the live estate could not be driven, recorded so it is not re-investigated

`AUTH_MODE=oidc` on the box. The `x-user-id` service path is accepted **only** under `dev`/`hybrid`
(`src/auth/guards.ts`) — deliberately, so a service token can never impersonate a user in
production. A valid IdP token from `scripts/sso-login.sh` returns `unauthorized` (the
service-credential message, NOT `unknown or inactive user`), meaning it fell through the JWT branch:
`principalFromToken()` threw something other than an auth error, most likely the issuer being
unreachable from inside the container. **A live authenticated drive needs the IdP-subject → user
mapping resolved, and that is its own ticket.**

---

## Gap closure + THREE CORRECTIONS (2026-08-25, end of session)

### ✅ S-06 is DEV-VERIFIED against the LIVE estate — it was never blocked

I reported that a live authenticated drive was impossible because `AUTH_MODE=oidc` and the IdP
subject mapping was broken, and called it "its own ticket". **That was wrong.**

`GET /api/me` returns **200** with a valid token. The earlier 401 was an **EXPIRED TOKEN** —
Keycloak access tokens are short-lived and I had reused one generated much earlier in the session.
The `unauthorized` message (rather than `unknown or inactive user`) misled me into diagnosing a
mapping failure; it was simply the token failing verification and falling through to the
service-credential branch.

Driven live against Gaia Digital Agency, authenticated as a real user through the real flow:

| Endpoint | Result |
|---|---|
| `finance/periods` | 12 periods, Jan 2026 first |
| `finance/accounts` | the live chart |
| `finance/trial-balance?asOf=2026-08-31` | `balanced: true` |
| `finance/ledger/verify` | `clean: true` |
| `finance/ar/reconcile` | `problems: []` |
| `finance/ap/reconcile` | `problems: []` |
| `finance/settings` | IDR, fyStart 1, isPkp true |

**Lesson worth keeping: a stale bearer token fails as `unauthorized`, which reads exactly like an
authorization design problem.** Re-mint before diagnosing.

### ❌ CORRECTION: `deploy.yml` DOES ship the compose files

I said twice that it does not, and called it a standing deploy gap. It does —
`scp infra/compose/*.yml vps:...` at line 145. I had grepped only for `rsync`. The follow-on claim
that the LMS session must have hand-copied their change was also wrong: the deploy did it.

### ✅ report-renderer's healthcheck budget raised BEFORE it bit

`start_period: 10s` → `300s`, the same latent shape that took the site down on 2026-08-24. No
`start_period: 10s` remains anywhere in the compose file.

### ✅ F9-07 / F9-10 / F9-11 now have a real recording path

`finance_record_consolidation_adjustment()` + `finance_consolidation_completeness()`, 8 tests.
Still deliberately NOT computed — goodwill needs fair value at acquisition and unrealised profit
needs an inventory count, and a figure derived from data that cannot support it is a wrong number
with a function signature. What IS enforced:

- an adjustment must **balance on its own**, so two wrong entries cannot cancel into a right total;
- a **computed** kind cannot be hand-entered beside the generated one (that removes the same balance
  twice);
- the run **reports what it has not addressed** — "considered and not applicable" and "never
  considered" look identical in a working paper, and only one is a finished job.
