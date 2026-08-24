# Finance & Accounting department — foundation blueprint

**Status:** `PLANNED` — design/research only, no code.
**Written:** 2026-08-24. **Audited against:** `gaiada-system` @ working tree, and
`C:\Users\Hansel\Documents\Hansel\Others\project-hug-main` (the "Zenvix" build) @ working tree.

This is the research pass the owner asked for: what a real Finance & Accounting division *is* in
industry terms, what "banking ready" concretely demands, what we already have, and what can be
salvaged from project-hug. It stops short of a ticket breakdown — §9 lists the decisions that must
be made before tickets are worth writing.

---

## 1 · The boundary

Finance & Accounting (F&A) is **the only department that owns the books**. Every other department
*generates* financial events; F&A *records, controls, reports and pays* them. The line matters
because in this program several things currently look financial and are not:

| Existing surface | What it actually is | Not F&A because |
|---|---|---|
| `platform-nest/src/modules/billing` | Client invoice records + revisions for the agency side | No ledger behind it. An invoice that never posts a journal is a document, not accounting. |
| `departments/[deptId]/ledger` | **AI/provider cost ledger** for a Search Marketing engagement | It is cost-to-serve at standard rates for one department, denominated in provider spend. It is not the general ledger. |
| `departments/[deptId]/money` | GM oversight tab | Explicitly `BackendPending`; the file itself warns against summing engagement ledgers into a company figure. |

**There is no accounting system in `gaiada-system` today.** No chart of accounts, no journal, no
period, no AR/AP subledger. Everything below is greenfield with respect to this repo.

Two boundaries to fix now, before anyone writes a table:

- **F&A owns the GL; departments own their subledger source documents.** Sales owns the sales
  order; F&A owns the AR invoice and the revenue journal it posts. Procurement owns the PO; F&A
  owns the vendor bill and the AP journal. HR owns the employee; F&A owns the payroll journal.
- **F&A does not own Internal Audit.** In every governance model worth copying, internal audit
  reports to the owner/board, not to the CFO — otherwise the function that controls the books also
  grades them. In our RBAC this means an audit role that is *not* under the finance position tree.

---

## 2 · Industry standard — how a real F&A division is organised

The owner's instinct is right: in a company of any size this is a **division**, not a department,
and AR and AP are two of its teams. The standard shape (this is essentially the APQC PCF
"9.0 Manage Financial Resources" decomposition, the closest thing to a neutral industry taxonomy):

```
                                CFO / Finance Director
                 ┌──────────────────────────┴──────────────────────────┐
        CONTROLLERSHIP (Accounting)                          FINANCE (forward-looking)
        "record it correctly"                                "decide and fund it"
        Finance Controller / Chief Accountant                Finance Manager
        ├── General Ledger / R2R                             ├── Treasury & Cash Management
        ├── Accounts Receivable (AR / O2C)                    ├── FP&A (budget, forecast, variance)
        ├── Accounts Payable (AP / P2P)                       ├── Costing / Margin analysis
        ├── Payroll accounting (from HR's H2R)                └── Investment / CAPEX appraisal
        ├── Fixed Assets & Depreciation
        ├── Tax & Statutory compliance
        └── Period close & Financial reporting

   Internal Audit / Internal Control ── reports to Owner/Board, dotted line to CFO
```

### 2.1 The five end-to-end chains

Industry does not describe F&A as boxes; it describes it as **cycles that cross departments**. Any
"true program" has to be built along these, because they are what auditors trace and what banks ask
about:

| Cycle | Full name | Starts in | Ends in F&A as | Owning F&A team |
|---|---|---|---|---|
| **O2C** | Order to Cash | Sales | Cash received, AR cleared, revenue recognised | AR |
| **P2P** | Procure to Pay | Procurement | Cash paid, AP cleared, expense/asset recognised | AP |
| **R2R** | Record to Report | Everywhere | Trial balance → financial statements | GL / Reporting |
| **H2R** | Hire to Retire | HR | Payroll journal, PPh 21, BPJS accruals | Payroll accounting |
| **A2R** | Acquire to Retire | Procurement / IT | CAPEX → asset register → depreciation → disposal | Fixed Assets |

A system that implements only R2R is a bookkeeping toy. A system that implements O2C and P2P
*without* posting them to R2R is an invoice tracker — which is exactly what our `billing` module is
today. The program has to close all three of the first three, minimum.

### 2.2 Roles and the segregation-of-duties matrix

Segregation of duties (SoD) is the single control both auditors and bank credit teams look for
first. The standard rule: **no one person may perform two of {authorise, record, custody,
reconcile}** for the same transaction class.

The incompatible pairs that must be enforced in Cerbos, not in a policy PDF:

| Must not be the same person | Why |
|---|---|
| Vendor master maintenance **+** AP payment release | Invent a vendor, pay yourself |
| AP bill entry **+** payment approval | Approve your own invoice |
| Cash/bank custody **+** bank reconciliation | Hide the theft inside the recon |
| AR receipt posting **+** credit note / write-off approval | Pocket the cash, write off the debt |
| Journal entry posting **+** period close approval | Post an adjustment nobody reviews |
| Payroll master data **+** payroll run release | Ghost employees |

Minimum viable role set (maps onto our position-driven IAM): `finance.cfo`, `finance.controller`,
`finance.gl_accountant`, `finance.ar_officer`, `finance.ap_officer`, `finance.treasury`,
`finance.tax_officer`, `finance.fpna_analyst`, and `audit.internal` **outside** the finance tree.

In a small team one human holds several of these — then the control becomes **compensating**: the
owner reviews an exception report. That review must itself be a recorded artefact, not a habit.

---

## 3 · What "banking ready" actually means

"Banking ready" is not a feature. It is a set of properties a bank's credit team, an external
auditor (KAP), and the tax office will each test. Concretely, for an Indonesian group:

### 3.1 Ledger integrity (non-negotiable)

1. **Double entry, always balanced.** Debits = credits, zero tolerance, enforced at write time —
   not a nightly check.
2. **Immutable journals.** A posted journal is never edited or deleted. Corrections happen by
   **reversal + repost**, both visible. This is the single biggest difference between an accounting
   system and a CRUD app.
3. **Hash-chained / tamper-evident.** Each journal carries a hash over its content plus the previous
   journal's hash, per company, with periodic anchors so tampering is detectable.
4. **Monotonic sequence, no gaps.** Auditors test for missing document numbers.
5. **Full audit trail:** who, when, from which source event, and the before/after state.
6. **Idempotency.** The same business event must never post twice — this is what makes retries and
   integrations safe.

### 3.2 Period discipline

- Fiscal calendar with explicit period states: `OPEN → SOFT_LOCK → HARD_LOCK`. No posting into a
  hard-locked period, ever, by anyone, including an admin.
- A defined **close checklist**: bank recs done, AR/AP subledgers agree to their GL control
  accounts, accruals booked, depreciation run, FX revalued, intercompany eliminated, then lock.
- **Subledger-to-GL reconciliation is the test.** The AR aging total must equal the AR control
  account. If it can drift, the system is not banking ready.

### 3.3 Statutory outputs

Under PSAK — fully converged with IFRS since 1 Jan 2015 — a complete set is: statement of financial
position, statement of profit or loss and OCI, statement of changes in equity, statement of cash
flows, and notes. Indonesian companies meeting thresholds (assets ≥ IDR 50bn, public companies,
debt issuers, SOEs, financial institutions) must publish **audited** statements. A group borrowing
from a bank will be asked for these plus aging schedules, a fixed-asset register, and bank recs.

Practical implication: the system must produce, per company **and consolidated**, from the ledger
and not from a spreadsheet —
Trial Balance · P&L · Balance Sheet · Cash Flow (indirect, ideally direct too) · Changes in Equity ·
AR aging · AP aging · Fixed asset register + depreciation schedule · Bank reconciliation statement ·
GL detail by account with running balance.

### 3.4 Multi-company & consolidation (our holding-OS case)

Because the ERP vision is shared-service departments serving N companies, the ledger is
**multi-company from day one, not later**:

- Every journal line carries `company_id`; a journal never spans companies.
- Intercompany transactions post **two mirrored journals** with a shared link id.
- Consolidation = sum of companies + **elimination entries** (IC receivable/payable, IC revenue and
  cost, unrealised margin) booked at group level in a separate elimination "company", so the
  underlying statutory books stay clean.
- Group vs statutory currency: transaction currency → functional currency → presentation currency.

### 3.5 Multi-currency

Store on every line: transaction amount + currency, **and** base amount at the rate used, plus the
rate and its source/date. Period-end FX revaluation of monetary balances posts unrealised gain/loss;
settlement posts realised. Getting this wrong later is a data migration, so decide it at schema
time.

### 3.6 Indonesian tax — the compliance surface

This is the part most custom ERPs skip and then cannot ship:

| Obligation | Detail | Deadline pattern |
|---|---|---|
| **PPN (VAT)** | Statutory 12% since 1 Jan 2025; most domestic supplies effectively 11% via the 11/12 taxable-base multiplier where no luxury-goods tax applies. PKP registration mandatory above IDR 4.8bn revenue. | Pay + SPT Masa PPN by end of the following month |
| **e-Faktur / Coretax** | Every taxable supply needs a real-time e-invoice through DJP's system. **No valid e-Faktur ⇒ input VAT is not creditable.** Coretax went live 1 Jan 2025 and now pre-fills PPN and PPh returns from e-invoices. | Per transaction |
| **PPh 21** | Payroll withholding, plus Form A1 to employees | Pay by the 15th, file by the 20th |
| **PPh 23** | 2% on most domestic services | Monthly |
| **PPh 4(2)** | Final tax, e.g. 10% on office/warehouse rent | Monthly |
| **Corporate income tax** | Annual SPT Tahunan Badan | Annual |

The operationally hard part is **monthly reconciliation between our ledger and Coretax's
pre-populated data** — a mismatch unresolved by the due date means filing on a known inconsistency.
So the design requirement is: every AR invoice and AP bill carries its tax treatment as *data* (tax
code, base, rate, e-Faktur number, counterparty NPWP), and there is a reconciliation report against
what Coretax says.

**We should not build an e-Faktur transmission client ourselves** — integrate a licensed ASP/PJAP.
Getting the tax *data* right is ours; putting it on the wire is not.

### 3.7 Records retention

Indonesian law requires books and supporting documents be retained (10 years under the Company /
Documents Law; 5 years under KUP for tax assessment). That is a **storage and immutability**
requirement on attachments, not just on rows: the scanned vendor invoice must still be retrievable
and unaltered years later.

---

## 4 · The canonical object model

Any real system converges on roughly this. Listed so we can measure both project-hug and our own
future build against it.

**Master data** — `chart_of_accounts` (code, name, type ∈ Asset/Liability/Equity/Revenue/Expense,
normal balance, parent, is_control_account, allow_manual_posting) · `fiscal_years`,
`fiscal_periods` (state machine) · `currencies`, `exchange_rates` · `dimensions` (cost centre,
department, project, company, store) · `customers`, `vendors` (NPWP, terms, credit limit) ·
`tax_codes` / `tax_rates` / `tax_rules` · `bank_accounts`.

**The ledger** — `journal_entries` (immutable header: company, period, date, source event, hash,
sequence, status) · `journal_lines` (account, side, amount, currency, base amount, dimensions) ·
`posting_rules` (business event → debit/credit template; this is what lets non-accountants' actions
post correct accounting) · `journal_reversals` · `account_balances` plus
`trial_balance_projection` / `general_ledger_projection` read models — **reports must never scan the
ledger**.

**Subledgers** — AR: `ar_invoices`, `ar_invoice_lines`, `ar_payments`, `ar_allocations`,
`ar_credit_memos`, aging, credit limits, dunning. AP: `ap_bills`, `ap_bill_lines` (3-way match
against PO and GRN), `ap_payments`, `ap_allocations`, payment runs. Fixed assets: `fixed_assets`,
`depreciation_entries`, impairment, revaluation, disposal. Cash/bank: `bank_statements`,
`bank_transactions`, `reconciliation_matches`. Expenses: claims plus a policy engine.

**Control layer** — approval workflows with limits, append-only `audit_log`, period-close checklist,
exception/alert rules, hash anchors.

---

## 5 · Sourcing — what project-hug ("Zenvix") actually gives us

Audited directly against the tree, not taken from its README. This is the most valuable finding of
this research pass.

**Scale:** `backend/src/core/finance` is **27,100 LOC of TypeScript**, ~50 `finance_*` Prisma
models, **68 REST endpoints** on the finance controller, and **24 finance UI pages**
(`src/pages/core/finance`: CFODashboard, LedgerCore, JVDesk, PayableDesk, ReceivableDesk,
ReconciliationDesk, TreasuryMap, ClosePeriodStudio, TaxCompliance, Assets, AuditVault,
BudgetPlanning, PayFlow, PayslipStudio, InvoiceCapture, …).

### 5.1 What is genuinely good and worth taking

- **A real double-entry engine, not a CRUD app.** `services/ledger-posting.service.ts` computes
  debit/credit totals *from the lines* and hands them to `services/journal-validation.service.ts`,
  which enforces `BALANCE_TOLERANCE = 0`, rejects non-positive line amounts, and **requires a
  `sourceEventId`** — every journal must be traceable to a business event.
- **Event-driven posting via posting rules** (`finance_ledger_posting_rules` +
  `..._posting_rule_lines`), so business modules emit events and finance decides the accounting.
  This is the correct seam and the hardest thing to get right.
- **Tamper evidence built in:** hash-chained journals, `finance_ledger_hash_anchors`,
  `finance_ledger_merkle_checkpoints` for O(log n) inclusion proofs, monotonic `ledgerSequence`
  with gap checks.
- **Idempotency table** (`finance_ledger_idempotency`) with insert-first semantics.
- **Fiscal period state machine** `OPEN / SOFT_LOCK / HARD_LOCK` with a pre-write guard.
- **CQRS projections** (`trial_balance`, `general_ledger`, `account_statement`) with checkpointed
  idempotent workers and a streaming rebuild-from-ledger path. Its stated rule — *"financial reports
  must NEVER scan the ledger directly"* — is the right architecture.
- **Async posting pipeline** with `SKIP LOCKED`, exponential backoff, and a DLQ plus replay tool.
- **Breadth already modelled:** AR (invoices, payments, allocations, credit memos, credit balances),
  AP (bills, allocations, payments, aging), fixed assets with capitalise / depreciate / impair /
  revalue / dispose plus an audit pack, bank ingestion and reconciliation matching, budgets vs
  actuals, expense policies, exchange rates, **consolidation with intercompany elimination rules**,
  and tax configs / rates / rules with per-transaction taxes.
- **A written failure-mode analysis** (`FAILURE_MODES.md`) covering DB outage, worker crash loop,
  split-brain partial posting with auto-repair, contention, and hash-chain corruption. That document
  is worth porting almost verbatim.

### 5.2 What is *not* banking ready — evidence, not opinion

| Gap | Evidence |
|---|---|
| **Effectively untested.** For a ledger this is the disqualifying one. | **1 test file** across 27,100 LOC of finance code. Its own `FINANCE_CHECKPOINTS.md` ticks "Integration Test Suite: all phases pass with zero failures" — that claim is not supported by the tree. |
| **The posting lock is in-process only.** Safe on one node; wrong the moment there are two. | `guards/posting-lock.ts` is a `Map` in memory, with the comment *"In production, this would use Redis (Redlock)"*. |
| **Financial statements are unbuilt.** No P&L, no balance sheet, no cash flow — the bank-facing output is precisely what is missing. | `FINANCE_PHASE_ROADMAP.md` §8 "Financial Reporting Engine (Phase 12)": every box unchecked, including the A = L + E invariant. |
| **Broken UI→API wiring inside finance.** | Its own `DETAILED_GAP_ANALYSIS.md` lists finance asset audit-pack, payslip templates, and reconciliation statement details among **6 CRITICAL disconnected endpoints**. |
| **Tax is configuration, not compliance.** | Tax rates/rules/transaction-taxes exist; there is no e-Faktur or Coretax integration anywhere in the tree. |
| **Stack mismatch.** NestJS matches us; **Prisma does not** — this program is SQL migrations + RLS + per-service DB roles. | `prisma/schema.prisma` vs our migration ledger and DB topology. |
| **Authz mismatch.** Its RBAC is JWT/role-based; ours is Cerbos + position-driven IAM + RLS. The SoD matrix must be re-expressed as policy. | `docs/rbac-configurable-design.md` vs our `PERMISSION-CONTRACT.md`. |
| **Provenance/licence unresolved.** It is a client deployment (Bambu Silver, tenant `tnt-3rlhko`) with a `secrets/` directory in-tree. | Ownership must be confirmed before any of it is copied into this repo. |

### 5.3 Verdict on reuse

**Take the design; port the code selectively; copy nothing wholesale.**

- **Port as design (highest value):** the posting-rule/event seam, the immutability + hash-chain +
  idempotency contract, the fiscal-period state machine, the projection/CQRS split and its
  "never scan the ledger" rule, the failure-mode document, and the phase/checkpoint structure.
- **Port as reference implementation, rewritten to our stack:** journal validation, the ledger
  posting service, AR/AP allocation and aging, depreciation scheduling, bank reconciliation
  matching.
- **Do not port:** the Prisma schema (re-express as SQL migrations with RLS), the in-memory lock,
  its RBAC, and its 24 UI pages — our shell, design system and dept-interface template differ. Take
  the *information architecture* of those pages, which is good, and rebuild the pages.
- **Blocked until resolved:** anything at all, until §9 Q1 (licence/ownership) is answered.

---

## 6 · Build vs buy

| Option | Verdict |
|---|---|
| **Odoo Accounting / ERPNext as the book of record**, with the ERP integrating to it | Fastest route to statutory-compliant output, and both have Indonesian localisations. But it owns the customer/vendor master and its own auth — it fights the holding-OS model, Cerbos, and our multi-tenant RLS. A reasonable fallback if the owner wants real books *this quarter*. |
| **A dedicated ledger engine** (TigerBeetle, Formance) under our own accounting layer | Excellent for high-volume money movement; overkill for an agency/holding group's transaction volume, and it still leaves AR/AP/tax/reporting to build. Revisit only if a payments product appears. |
| **Custom double-entry GL inside `platform-nest`, informed by project-hug** | **CHOSEN — owner ruling D-F2, §9.1.** We already have multi-company, RLS, Cerbos, event plumbing, D14 approvals and an audit trail — the expensive scaffolding an accounting module normally has to invent. The domain risk is real but bounded, and project-hug is a 27k-LOC reference for the hard parts. |
| **Tax filing (e-Faktur/Coretax transmission)** | **Buy/integrate, never build.** Licensed ASP/PJAP. We own the tax data; they own the wire. |

---

## 7 · Constraints this department inherits

Non-negotiable, from this program's existing rules:

- **RLS + per-service DB role.** Finance tables get RLS from the first migration; the backfill trap
  applies (an unset GUC yields zero rows, with no error).
- **Cerbos for authz**, including the SoD matrix in §2.2 — and remember Cerbos needs a **restart**
  for new policies, and its batch limit is 50.
- **Migrations are timestamp-named**, and any globally-scoped row with a nullable key needs a
  partial unique index.
- **Money is `NUMERIC`, never float.** Decimal arithmetic end to end; store the currency with every
  amount; never let an empty env var collapse into a zero.
- **D14 approvals**: approving *executes*. Any AI-initiated finance action is a proposal until a
  human with the right position approves it — and finance is the department where that matters most.
- **Agent attribution**: anything an agent posts must carry the agent identity in the audit trail.
- **No fake zeros.** An empty list is a claim; a finance surface with no backend renders
  `BackendPending`, never `0`.
- **Status language**: `PLANNED → IN PROGRESS → PROTOTYPED → DEV-VERIFIED`. Nothing here gets called
  "done".

---

## 8 · Proposed phasing (for later ticketing; not yet approved)

| Phase | Delivers | Bank-readiness contribution |
|---|---|---|
| **F0 · Foundations** | CoA, dimensions, fiscal calendar, currencies/rates, company scoping + RLS, Cerbos roles + SoD | Nothing postable yet — but every later phase depends on it |
| **F1 · Ledger core** | Journal entry/line, balance validation, immutability, reversal-only correction, hash chain, sequence, idempotency, period guard | The integrity bar in §3.1–3.2 |
| **F2 · Posting rules & events** | Business event → journal template; the seam other departments emit into | Makes the ledger self-populating instead of manual |
| **F3 · Read models & statements** | Trial balance, GL and account-statement projections → **P&L, Balance Sheet, Cash Flow, Changes in Equity** | The actual bank/auditor deliverable. *This is where project-hug stopped.* |
| **F4 · AR (O2C)** | Customer invoices, receipts, allocation, credit memos, aging, credit limits, dunning, control-account reconciliation | The aging schedules banks ask for |
| **F5 · AP (P2P)** | Vendor bills, 3-way match, approval limits, payment runs, aging | SoD-critical; the main fraud surface |
| **F6 · Cash, bank & close** | Bank statement ingest, reconciliation matching, close checklist, period lock | "Are the books actually reconciled?" |
| **F7 · Tax & statutory** | Tax codes on every document, PPN/PPh computation, e-Faktur/Coretax reconciliation via an ASP, monthly filing pack | Legal ability to operate |
| **F8 · Fixed assets & CAPEX** | Register, depreciation runs, impairment/revaluation/disposal, CAPEX approval | Balance-sheet completeness |
| **F9 · Group & FP&A** | Intercompany mirroring + eliminations, consolidation, budget vs actual, forecast | The holding-OS payoff |

F0–F3 is the minimum that deserves the word "accounting". F0–F7 is the minimum that deserves
"banking ready".

---

## 9 · Decisions

### 9.1 Settled (owner ruling, 2026-08-24)

**D-F1 · project-hug reuse: ALLOWED, conditionally.** *"We could if it's good and proper."* Reuse is
permitted where the code meets our bar — it is not a licence to paste. The §5.3 split stands, and
the condition means every ported file arrives through the normal gate: rewritten to our stack
(SQL migrations + RLS, Cerbos, no Prisma), reviewed, and **tested** — project-hug's 1-test-file
posture is the specific thing we are not inheriting. Anything that cannot be brought to that bar is
read as design reference only.

**D-F2 · Book of record: OUR OWN LEDGER.** *"Own. As we are trying to build from the ground up."*
No Odoo, no ERPNext, no external accounting engine as the book of record. The GL lives in
`platform-nest` on our Postgres, under our RLS and Cerbos. Consequences, accepted deliberately:

- F0–F3 is now the critical path and it is real engineering, not integration. **F3 (P&L, Balance
  Sheet, Cash Flow) is exactly where project-hug stopped** — nobody has walked that ground for us.
- We own statutory correctness. PSAK conformance is our problem, which makes D-F5's accountant
  sign-off a hard gate on F3, not a nicety.
- The one carve-out from §6 stands: **e-Faktur/Coretax transmission is still integrated, not
  built.** "Ground up" applies to the ledger, not to being a licensed tax filing channel.

**D-F5 · The accountant: coming, with an ERP account.** *"We don't have yet, but the company will
give the accountant an account to this ERP so everything can be done with ERP as source of truth."*
Two things follow:

1. **The ERP is the book of record for the accountant too** — not a reporting mirror of books kept
   in Accurate or a spreadsheet. That raises the bar on F4–F6: the accountant must be able to do
   *daily* work here (post a JV, enter a bill, reconcile a bank line, close a period), not just read
   dashboards. A read-only finance UI would fail this ruling.
2. **Do not block on the hire.** Ship a **PSAK-aligned default chart of accounts as a template**
   that the accountant adjusts on arrival, rather than waiting. The CoA must therefore be *data*,
   versioned and editable, with account-level "in use / has postings" protection — not a seeded
   constant. Sign-off on the CoA and the close checklist becomes an F3 exit gate with a named human.
   Until then, no period may be hard-locked.

**D-F8 · Two kinds of owner.** *"Holding owner should be able to see all. But company owner or
shareholder could be only a company, or some."* Scope is **derived from an ownership graph**, not a
role flag; the holding owner's "all" falls out of owning the root entity. A company shareholder is
an **external** principal on a scoped read-only interface, defaulted to the **statements** tier —
transaction-level detail requires a separate director/owner-manager grant. Full treatment in §10.3b.

### 9.2 Still open (block later phases, not F0)

3. **Scope of "banking ready": which companies?** Group-consolidated for the holding, or per-PT
   statutory books for the specific entity that will borrow? Decides whether F9 is early or late.
4. **Which entities exist and their PKP status** — decides whether PPN lands in F1 or F7.
6. **Existing books.** Is there current bookkeeping (Accurate, Mekari Jurnal, Xero, spreadsheets)?
   Given D-F5, opening balances and a cutover are now certain to be needed and are a phase of their
   own, not yet in §8.
7. **e-Faktur ASP/PJAP choice** — determines the F7 integration contract.
*(Q8 answered — see D-F8 in §9.1 and §10.3b.)*

9. **The actual ownership map.** D-F8 settles the *model*; F0 needs the *data* — which PTs exist,
   who holds what stake in each, and which of those people are also directors. Without it the scope
   resolver has nothing to resolve.

---

## 10 · Access topology — internal / external, joined / individual

Owner ruling 2026-08-24: the holding and each company may run a **joined** (shared-service) or an
**individual** finance department; a **third party audits and checks**; and **a higher role may see
a company below it only after approval from Anthony**. That is an access-control design, and it has
to be settled before the schema, because it decides what `company_id` means on every row.

### 10.1 The invariant that survives every arrangement

**The books are always per-company. Department topology is a staffing arrangement, not a ledger
arrangement.**

A journal never spans companies (§3.4) whether one shared team or five separate teams key it. What
"joined vs individual" changes is *who is staffed to touch which company's books*, and therefore
what a position grants — never how the ledger is partitioned. If we let a shared-service department
own a shared ledger, consolidation, statutory audit and RLS all break at once. So:

- `finance_department` is a per-company setting: `SHARED` (served by the holding's finance
  department) or `OWN` (its own department + staff).
- A shared-service officer holds **one position with scope over N companies**, not N accounts.
- Switching a company from `SHARED` to `OWN` later is a staffing migration, not a data migration.
  That is the test of whether we modelled it right.

### 10.2 Two sides

| | **Internal** | **External** |
|---|---|---|
| Who | Holding + company finance staff, GM, owner | Audit firm (KAP), tax office, bank credit team |
| Interface | The ERP app shell, `(app)` route group | **A separate interface**, like the existing `(portal)` client side — never the staff shell |
| Access | Standing, position-derived, read+write | **Engagement-scoped, read-only, expiring** |
| Identity | Staff `users` rows | Distinct principal kind; must not inherit any staff baseline |
| Default | Own company; more by elevation (§10.3) | Nothing, until an engagement grants it |

The precedent is already in the repo: the client side is a separate route group and shell, not a
permission flag on the staff UI. External audit follows the same rule for the same reason — an
external party inside the staff shell will eventually see something no one intended.

### 10.3 The upward-visibility rule

*"The higher the role can see below company after approval from Anthony."*

**The approval gate is for staff reaching outside their staffed scope. It is not for the owner.**
Requiring the owner to request permission to see his own companies inverts the relationship —
Anthony approves *on the owner's behalf*, so the owner cannot be the one asking. Scope is therefore
tiered by position, and elevation only exists for the tiers where scope and need genuinely diverge:

| Tier | Baseline scope | Approval needed? |
|---|---|---|
| **Owner / board** | **All owned companies, full transaction detail, plus group totals — standing.** Default view is "all companies"; filtering down to one is a UI action, not a permission event. | **No.** Never gated. Reads are *logged*, not blocked. |
| **Holding CFO / group controller** | All companies in the group, full detail, standing. | **No** — they cannot close or consolidate the group books without reconciling subsidiary detail. Gating this would make group close impossible. |
| **Company finance staff** (controller, AR, AP, GL, tax) | Their staffed company or companies — for a shared-service officer, all companies they are staffed to serve. | **No** within staffed scope. **Yes** to reach a company they are not staffed to. |
| **Other department heads / GM** | Group aggregates and their own department's cost lines. | **Yes** for another company's transaction-level financial detail. |
| **Anyone, for write** | Posting rights come from a finance position in that specific company. | **Approval alone never confers posting rights.** Elevation *and* a position. |

So the approval gate protects **lateral and out-of-scope access by staff**, plus every write outside
a staffed company. That is what the ruling was actually reaching for, and scoping it this way keeps
the approval meaningful instead of turning it into a rubber stamp everyone clicks past.

**Superadmin is not an owner.** Worth separating explicitly, because the two get conflated: a
platform superadmin can *administer the system*; that is not a reason to read payroll, margins, or
the owner's own accounts. Technical administration and financial visibility are different grants.
If a superadmin needs financial data, they hold a finance position or they elevate like anyone else —
otherwise "sysadmin" quietly becomes the widest financial role in the company, off the org chart.

Mechanics for the tiers that *do* elevate, reusing what exists rather than inventing a parallel
path:

- The elevation request is a **D14-style approval: approving *executes*** — it mints the scoped
  grant, it does not merely record a blessing.
- The grant is **time-boxed** (hours, not indefinite), **company-scoped**, **purpose-tagged** with a
  stated reason, and it **expires on its own**. Nothing should depend on someone remembering to
  revoke it.
- Pair it with the existing **`/step-up`** re-authentication on the elevated session.
- **Every read under elevation is logged** with the grant id — an access trail, separate from the
  ledger's audit trail. Auditors ask who looked, not only who posted.
- Anchoring caveat from this program's own history: a cross-company grant has no root. Anchor it
  through the company being reached, never through a membership the requester already holds.

**Two things to flag on "approval from Anthony":**

1. **Model the approver as a position, not a person.** Store an `finance.cross_company_approver`
   position that Anthony holds. A hardcoded user id becomes an outage the first week he is on a
   plane, and it cannot survive him changing roles.
2. **Name a deputy.** A single human approver on the path to *reading a subsidiary's books* is a
   bottleneck during close and audit season, which is precisely when the requests cluster. Either a
   deputy, or a standing pre-approval for named roles during a declared close/audit window — which
   is still a grant, still logged, still expiring.

### 10.3a "All at a glance, then filter" — what that actually requires

The owner's ask is a **group console**, and it is a design requirement with teeth, not a dashboard
wish:

- **Default scope is "All companies."** The company switcher starts at group, not at one entity. A
  scope selector, not an access prompt.
- **Drill-through must be continuous:** group total → company → department/cost centre → account →
  journal → source document. If any hop dead-ends, the owner will go back to asking someone for a
  spreadsheet, and the ERP stops being the source of truth.
- **Every figure must state its scope and basis on the face of it** — which companies, which period,
  which currency, and consolidated-or-not.

Two traps that will otherwise produce a confidently wrong number in front of the owner:

1. **"Total" is ambiguous, and the naive answer overstates.** A straight sum of company P&Ls
   **double-counts intercompany** revenue and cost — if one company bills another for shared
   services, group revenue inflates by the internal invoice. The owner asking for "total" almost
   always means **consolidated** (post-elimination). So the console must offer both and label them
   distinctly: *Sum of companies* vs *Consolidated (eliminations applied)*. A single unlabelled
   "Total" tile is exactly the kind of number that gets quoted in a bank meeting.
2. **Mixed functional currencies.** If companies don't share a currency, a group total needs a
   presentation currency **and** a stated rate basis (closing rate for balance sheet, average for
   P&L, per PSAK/IFRS). The tile must show which — "IDR @ closing 31-Aug" — or the number is not
   reproducible.

Consequence for phasing: a genuine group-total view depends on **F9's elimination engine**, not just
F3's statements. Until F9 exists, the group console shows *sum of companies*, labelled as such, and
does **not** render a "consolidated" figure it cannot compute. (An empty list is a claim; so is an
unqualified total.)

### 10.3b Whose "all" is it? — two kinds of owner

**Owner ruling 2026-08-24 (D-F8):** the **holding owner sees everything**; a **company owner or
shareholder sees only their company, or some of them**. So "owner" is not one role — it is a scope
derived from ownership, and there are two distinct principals.

**Model it as an ownership graph, not a flag.** A `company_ownership` edge (principal → company,
with stake and kind) walked transitively:

- The holding owner owns the **root** entity, which owns the subsidiaries — so "sees all" is
  *derived*, not asserted. The practical payoff: incorporate a sixth PT under the holding and the
  holding owner sees it the moment the edge exists, with no permission edit and no risk of someone
  forgetting one.
- A company shareholder's scope is exactly their own edges — two of five companies means those two
  and *their* subtotal. No group total, because a group total they don't own would leak the other
  three by arithmetic.
- Enforcement is **RLS on a resolved company-id set**, not per-query filtering. The scope resolver
  runs once per request and sets the GUC; every finance table filters on it. Query-level filtering
  is how the third report someone writes leaks a company.

**Shareholder ≠ owner-manager.** These are two grants that may sit on the same human, and conflating
them is how a 5% investor ends up reading every employee's payroll line:

| Grant | What it conveys | Sees |
|---|---|---|
| **Shareholder** (economic interest) | A claim on results, not a management right | Financial statements for their company, their equity/capital account, dividend history, GMS/RUPS materials. **Not** the transaction-level GL. |
| **Owner-manager / director** (operational) | Runs the company | Full detail for **that company** — the "Company finance staff" tier of §10.3, at company-controller scope |

Default a company shareholder to the **statements** tier. Grant transaction detail only where the
person is genuinely also a director of that company, and record it as the separate grant it is.

**A company shareholder is an external party, not staff.** They are not an employee of the group, so
they belong in a **scoped read-only interface**, not the staff shell — the same pattern as the
client `(portal)` side and the auditor side in §10.4. Which is an economy worth taking: **the
shareholder portal and the auditor portal are one mechanism with different scopes** — an external
principal, a scoped grant, read-only, statements and sealed packages, everything logged. Build it
once.

**Confidentiality between shareholders is a hard boundary.** A shareholder in company A must not
reach company B *by any route* — and the routes are more numerous than they look:

- group totals and consolidated views (arithmetic leaks the difference),
- cross-company reports, search results, exports, notifications, activity feeds,
- **the AI assistant.** If an agent answers "how are we doing?" with a service-role query, it
  bypasses the resolver entirely. Every agent and assistant surface must run under the *caller's*
  resolved scope, and the attribution trail must record which scope it answered in. This is the
  leak channel RLS alone does not close.

Legal note, to confirm with counsel rather than assume: under Indonesian company law, annual
accounts are approved at the **RUPS/GMS** and dividends are declared per PT, while a minority
shareholder's right to *inspect* the books is limited. That supports the statements-tier default
above — it is the normal arrangement, not a restriction we invented.

### 10.4 The external audit side, concretely

An audit is not "give the auditor a login". The standard shape:

- **An engagement object**: audit firm, scope = {companies} × {fiscal year/periods}, start and end
  date, named auditor users. Access derives from it and dies with it.
- **Strictly read-only, and as-of.** Auditors examine a *closed* period. They need point-in-time
  reporting — the trial balance as it stood at close, not as it looks after later adjustments. This
  is the payoff of §3.1's immutability and hash chain: we can prove the period they signed is the
  period we still hold, and reversal-only correction means later fixes are visible rather than
  silent.
- **The PBC list** ("prepared by client") is the industry artifact: the auditor requests documents,
  we fulfil, both sides see status. Build it as a request/fulfilment queue with attachments, not an
  email thread. It is also the single best argument for §3.7 retention being real.
- **Exports are watermarked and logged**, and every auditor action is recorded.
- **The bank and the tax office get a package, not a login.** A sealed, dated statement pack —
  the `reports` module already has document-building and sealing precedent to follow — rather than
  standing access to a live system.

### 10.5 Segregation of duties gets *harder* in a shared department

A shared-service team is efficient and concentrates risk: one AP officer serving five companies is
a single point of failure across five sets of books. The §2.2 matrix therefore binds **per company,
per person**, not per department — one officer may not hold two incompatible duties for the *same*
company, even if the department collectively separates them. Cross-company approval routing must
also refuse self-approval when the same human appears on both sides in two different companies.

### 10.6 Effect on phasing

- **F0** grows: `finance_department` mode per company, the elevation grant object, the approver
  position, and the SoD matrix expressed per company-person.
- **F0 also owns the ownership graph and the scope resolver** (§10.3b) — the `company_ownership`
  edges, transitive resolution, and the RLS GUC every finance query passes through. This is
  foundational: retrofitting a scope resolver after tables exist means revisiting every query.
- **A new phase is needed** for the external side — one scoped read-only interface serving **both**
  external auditors and company shareholders (§10.3b): external principal kind, scoped grant/
  engagement, PBC list, as-of reporting, sealed packages. It depends on F3 (statements) and F6
  (close/lock), so it sits after F6; call it **F6.5 · External assurance & shareholder reporting**
  pending renumbering.
- Open question 3 in §9.2 now matters more: *which* companies must be bank-ready determines how many
  engagements and elevation paths are real on day one.

---

## 11 · Cross-references

- Program rules: `gaiada-system/CLAUDE.md`; module registry `docs/modules/MODULES.md`
- Authz: `docs/PERMISSION-CONTRACT.md` — the SoD matrix in §2.2 must land here
- Contract style precedent: `docs/FRONTEND-BFF-CONTRACT.md`
- Sibling department blueprints: `docs/blueprints/hr-department-foundation.md`,
  `docs/blueprints/gm-console-foundation.md`
- Reference implementation (external, licence unresolved):
  `Others/project-hug-main/backend/src/core/finance` — see especially `FAILURE_MODES.md`,
  `FINANCE_PHASE_ROADMAP.md`, `FINANCE_CHECKPOINTS.md`

### External sources consulted

- [e-Faktur Indonesia Coretax 2026: Full Guide — XPND](https://xpnd.co.id/blogs/e-faktur-indonesia-coretax-2026/)
- [Indonesia CoreTax System 2026 — JCSS](https://jcss.co.id/indonesia-coretax-system-2026-foreign-companies/)
- [Monthly Tax Reporting for PMA Companies in Indonesia — Okusi Associates](https://okusiassociates.com/guides/monthly-tax-reporting-indonesia)
- [Indonesian Tax Compliance in a Custom ERP: PPN, PPh, and e-Faktur Integration](https://www.matthewswong.com/en/blog/erp-tax-compliance-indonesia-ppn/)
- [APQC — 9.0 Manage Financial Resources: definitions and key measures (PCF 7.4)](https://www.apqc.org/resource-library/resource-listing/90-manage-financial-resources-definitions-and-key-measures-pcf-1)
- [Accounting Standards and General Audit Requirements in Indonesia — Cedar Strategi](https://cedarstrategi.com/accounting-standards-and-general-audit-requirements-in-indonesia/)
- [Audit and Accounting — Business-Indonesia](https://business-indonesia.org/audit_and_accounting)
- [What Is Segregation of Duties in Auditing? — ZenGRC](https://www.zengrc.com/blog/what-is-segregation-of-duties-in-auditing/)
- [World Bank — Indonesia ROSC: Accounting and Auditing](https://documents1.worldbank.org/curated/en/478551576872263951/pdf/Indonesia-Report-on-the-observance-of-standards-and-codes-accounting-and-auditing.pdf)
