# PV-5: Contracts & billing depth (tickets)

**Status: PLANNED.** Nothing here is built.

- **Parent plan:** `docs/plans/2026-10-10-three-perspectives.md` §1.3 (evidence), §2.3 (where a
  record lives), §2.4 (two client channels), §9 (traps 1, 6, 9, 10, 11).
- **Rulings in force:**
  - PV-D7: the finance ledger is the invoice of record. An invoice is drafted and approved as
    today, then **issued through the ledger**, and the PKP status gates taxed invoices.
  - PV-D8: contracts sign in two tiers. Content is fixed at send; a certified (PSrE) provider is used
    at or above a counsel-set threshold, or when staff mark a contract.
  - PV-D9: a provider-hosted checkout for issued invoices. A verified provider notice confirms the
    payment with no staff step, and bank transfer with proof stays.
  - PV-D25 (added 2026-10-12, after PV5-03): **Midtrans** for payments. Certified signing goes through
    **VIDA, but only when first needed**: PV5-11 is parked until counsel sets a threshold or a client
    asks. Until then, every contract signs in our own tier, which gains a **company seal** on each
    signed PDF (PV5-07).
  - PV-D26 (added 2026-10-12, after PV5-02): the platform administrator keeps access to bank details,
    ours and suppliers', but **everyone needs high assurance** (a fresh second factor) to change them,
    and every change to our bank details notifies all owners.
  - Also PV-D4 (the five areas, every URL kept), PV-D5 (money and legal effects land in Contracts &
    billing), PV-D10 (one client record per company), PV-D2 (Viceroy is a group client of Gaiada)
    and PV-D13 (no company names or ids in code).
  - Finance rulings that bind here: D-F2 (our own ledger is the book of record; e-Faktur goes through
    a licensed ASP/PJAP, never built here), and EST-D-VI1 (no per-seat pricing).
- **Base:** `origin/main` at `ddcda4fd` (`v1.0.0-alpha.365`), read 2026-10-12 from a clean detached
  worktree.
- **Paths:** `PN` = `platform-nest/`, `UI` = `platform-ui/src/`, `MH` = `mcp-hub/src/`.

## What people will notice

- **Clients** see a real invoice: a number, an issue date, a due date, tax lines when they apply,
  our legal name and tax id, and the bank account to pay into. An invoice can be paid online through
  the provider's own payment page, or by bank transfer with a proof, as today. An online payment
  shows as paid within a minute, with no staff step.
- **Clients** sign a contract knowing exactly what they sign. If the contract changed after they
  opened it, the signature is refused and the page reloads. A signed contract comes back as one PDF:
  the contract, its evidence page, and our company seal, which shows in any PDF reader that the file
  has not been altered since. Certified signing through a provider comes later, when counsel or a
  client needs it (PV-D25).
- **Clients** get a **Documents** list under Contracts & billing: signed contracts (the sealed
  copy), issued invoices as PDFs, and payment receipts.
- **Staff** issue an approved invoice with one button. The button lists what is missing (no billing
  profile, finance module off, no open period, PKP unknown on a taxed invoice) instead of failing.
  An issued invoice is in the books the moment it is issued, and a confirmed payment posts its
  receipt. An invoice to a group client (Viceroy) lands on the intercompany receivable.
- **Finance** sets the company's billing profile once: legal name, address, invoice number prefix,
  payment terms, the bank account clients pay into, and the ledger accounts behind it. Changing the
  bank account clients see notifies every owner.

## Findings from reading the code (they shaped the tickets)

1. **There are two invoices, and the client sees the one with nothing behind it.**
   - `invoices` (`PN/migrations/0021_invoices.sql:4-17`) has no number, due date, tax or issuer. Its
     only dates are `period_start` and `period_end`. Its currency defaults to `'USD'`
     (`PN/src/modules/invoice/invoice.controller.ts`, create handler).
   - Lines are built from billable time entries times a rate. Statuses are
     `draft | approved | sent | paid | void`; `approved` is the IAM-GAP-01 maker/checker step.
   - The ledger's `finance_ar_invoices` (`PN/migrations/202608241019_finance_ar_subledger.sql:87-130`)
     has `invoice_no`, `invoice_date`, `due_date`, per-line tax and `efaktur_no`. It is posted by
     `finance_ar_issue_invoice()` (DR AR control, CR revenue, CR 2140 PPN Keluaran).
   - **Nothing links the two.** The F2 posting-rules engine exists, but no code emits to it from
     invoices. → **PV5-04.**
2. **Staff can mark an invoice paid with no payment.** `PATCH /invoices/:id` accepts `paid` from
   `approved` (`REQUIRES_APPROVED_STATUS`, `invoice.controller.ts:28`). Separately, confirming
   payments that cover the total flips `sent` to `paid` (`PN/src/core/contracts.controller.ts:515-535`).
   Under PV-D7, "paid" is derived from allocations only. → **PV5-04** removes the manual path.
3. **No invoice number series exists anywhere.** `invoice_no` is a required free-text field
   (`PN/src/modules/finance/finance.controller.ts:1083-1084`), with a per-tenant unique index as the
   only control. → **PV5-01** adds a gapless series.
4. **The finance API hard-codes PPN, in four places.** It computes `subtotal * (11/12) * rate/100`
   (`finance.controller.ts:1108`, and the same line at `:2028`, `:2328` and `:2569`). It never calls
   `finance_tax_compute()` or reads the effective-dated `base_multiplier`
   (`PN/migrations/202608241025`). A 2024 supply, or a future rate change, would be taxed wrongly.
   → **PV5-04** issues through `finance_tax_compute()` and fixes all four.
5. **AR customers are a separate table** (`finance_ar_customers`, `202608241019:44`). It has a
   nullable `client_id` with **no FK** and no uniqueness, so one client can map to several customers.
   AR create-and-issue is one call with no draft or approval. → **PV5-01** adds the link constraint,
   and **PV5-04** creates the customer on the first issue.
6. **Intercompany tagging does not reach AR.** F9-04 tags receivables by counterparty on the
   ACCOUNT (`1290-<suffix>`, `202608251430`). But `finance_ar_issue_invoice` always debits the one
   AR control account (`ORDER BY code LIMIT 1`), and nothing reads `clients.group_company_id`
   (`202610111322`) on the finance side. An invoice to Viceroy would land on plain AR.
   → **PV5-05.**
7. **The issuer has no legal details, and clients are never told where to pay.** Only
   `companies.name`, the `settings` jsonb and `finance_company_settings.npwp/is_pkp` exist. Nothing in
   the portal shows a bank account; the pay page says only "Tell us you've paid"
   (`UI/app/(portal)/portal/invoices/[invoiceId]/page.tsx:155`). → **PV5-01, PV5-03.**
8. **A confirmed payment never reaches the ledger.** The decide route
   (`contracts.controller.ts:409-565`) has no finance call. `finance_ar_receipts` needs a bank
   account and a customer (`202608241019:176-199`). → **PV5-04.**
9. **Nothing records which content was signed.** The client sign route
   (`PN/src/core/portal-commerce.controller.ts:307-402`) stores the typed name, a salted IP hash and
   the user agent, but no document hash, version or file id. `files` has no checksum
   (`PN/migrations/0009*`). `file_id` is a plain FK, so the attached file can be soft-deleted.
   `signature_ref` exists on `contract_signatures` and is never written. The only content-hash
   precedent is the social review's `reviewed_args_sha256` (`0105_module_social.sql:386`).
   → **PV5-01, PV5-06.**
10. **`contracts.value` is optional** (`0075:109-111`), and the PATCH `COALESCE`s it, so it can never
    be cleared. A threshold rule must refuse to send an unvalued contract once a threshold exists.
    PV-4 adds amendments (`202610122330`: `kind`, `amends_id`), each with its own `value`.
    → **PV5-06**, plus PV5-Q1 for counsel.
11. **`declined` and `expired` are never written.** The portal derives `termEnded` on read. Not
    changed here; noted so no ticket relies on them.
12. **There is no document library and no listing over files.** The portal file route
    (`portal-commerce.controller.ts:419-457`) serves four parent kinds through `DOWNLOADABLE`
    (`:56-61`: `deliverable`, `contract`, `invoice_payment`, `project`). Every file is reachable only
    from its parent's page. The UI links straight to `/api/:t/portal/files/:id`. **No staff UI route
    proxies `/files/:id/content`** (PV-3 follow-up). Invoices have no PDF. → **PV5-07, PV5-08.**
13. **The PDF renderer exists and is the only Chromium image.** `report-renderer` takes
    `POST /render {url}` and returns PDF bytes. It accepts only same-origin URLs and is token-gated.
    Its README forbids extending it without a ticket. **PV5-07 is that ticket.**
14. **Auto-confirm collides with three human-only assumptions.**
    - `invoice_payments.recorded_by` and `confirmed_by` are user FKs.
    - Confirm refuses when the confirmer is the recorder (`contracts.controller.ts:485-490`).
    - Agent-proposed confirms go through D14 (`approval-executables.ts:2089`).
    - A provider-confirmed payment therefore needs its own write path, under a
      `users.kind = 'automation'` principal (`202608201442_users_kind_discriminator.sql:30`). It
      never goes through the staff decide route or D14. → **PV5-10.**
15. **The webhook door is already open.** nginx proxies `location /api/webhooks/` on the ERP host to
    platform-nest with no rate limit (`infra/nginx/erp.gaiada.online.conf:424-440`). The GitHub App
    receiver is the template:
    - HMAC over the raw body (`github-webhook-signature.ts`);
    - a `UNIQUE(delivery_id)` claim table (`202608311145_github_webhook_deliveries.sql`);
    - a handler error is recorded and still acknowledged.
    → **PV5-10, PV5-11.**
16. **Money is `numeric`, and providers take integer rupiah.** `finance_currencies.minor_unit` exists
    (IDR = 0, `202608241012:36-49`). Portal code compares with `Number()` and a 1-rupiah tolerance.
    → PV5-10 states the rounding rule.
17. **The finance module is serving but PROTOTYPED.** It is registered (`main.ts`, `app.module.ts`)
    and has UI under `UI/app/(app)/finance/`. Its progress docs say "PROTOTYPED + deployed, NOT
    DEV-VERIFIED", and live had 0 AR invoices at seed time. `withFinance()` is the only correct DB path
    to module-walled tables: a plain `withTenants()` returns zero rows with a 200. PV-5 is the first
    real caller of the AR path, so **PV5-13 drives it end to end**.
18. **Legal Gate 1 says nothing about signatures.** `legal/` covers employee monitoring and PDP only.
    The e-signature and stamp-duty questions go to counsel as PV5-Q1 and PV5-Q2.

## Design decisions made in these tickets (lead, within the rulings)

| # | Decision | Why |
|---|---|---|
| 1 | `invoices` stays the drafting stage, and `finance_ar_invoices` is the record. Issue links them 1:1 (`invoices.ar_invoice_id`, unique), with the same number and totals. A DB trigger makes every invoice-of-record column immutable once `issued_at` is set | PV-D7. Drift is prevented structurally, not by care |
| 2 | **Issue replaces "mark as sent".** `PATCH` can no longer set `sent` or `paid`. `paid` is derived from AR allocations in the same transaction that records a payment | Findings 1 and 2: one way in, and paid means money |
| 3 | The number comes from a **gapless series** per company, per calendar year, assigned inside the issue transaction under a row lock. Format `{prefix}/{yyyy}/{nnnn}`; the prefix is part of the billing profile. A rolled-back issue consumes no number | Auditors read gaps as deleted invoices. No company prefix in code (PV-D13) |
| 4 | A **billing profile** per company holds the issuer's legal name and address, the invoice prefix, default payment terms, the clients' bank account, and the ledger codes (receipt bank account, default revenue account). NPWP and PKP stay in `finance_company_settings`: one source each | Finding 7. Finance owns tax identity, so it is not copied |
| 5 | At issue, the issuer block (legal name, address, NPWP, bank details) is **frozen onto the invoice** as a snapshot. Later profile edits never change an issued invoice | An issued invoice is a legal document; what it said must stay what it said |
| 6 | **Changing the bank account clients pay into** requires a separate action (`finance_config` `set_bank_details`): an owner or finance manager of the company, plus the platform administrator, who keeps access (PV-D26). **Everyone needs high assurance** (a fresh second factor), enforced by an `EFFECT_DENY` that also beats the administrator's wildcard. The same DENY now guards supplier bank details (`vendor_master`). It is refused to `bot` and `automation` principals, writes an activity row, and notifies every owner of the company | The same reasoning as `vendor_master` in F5: editing these details redirects real money with no fake invoice needed |
| 7 | **Issue readiness** is a function returning one row per blocker: no billing profile or prefix, finance module off, no AR control account, no open period, no revenue account, a taxed invoice while `is_pkp` is not `true`, a currency not in `finance_currencies`. The Issue button shows the list | The `finance_period_close_readiness()` idiom: say every reason at once |
| 8 | Tax is computed by `finance_tax_compute()` from an effective-dated tax code, never by arithmetic in a handler. Finding 4's hard-coded line is replaced in the finance API too | One tax rule for every invoice the ledger holds |
| 9 | A void after issue posts the AR reversal (credit note for the full amount) in the same transaction, and both rows show `void`. A part-paid invoice cannot be voided; it needs a credit note in Finance | Voiding a paid invoice is a refund question, not a status change |
| 10 | Overdue means `due_date < current_date` and not fully paid. The two places using `period_end` move together (`portal-commerce.controller.ts:100`, `clients.controller.ts:473`) | PV-D7's supersession |
| 11 | **Content fixing:** at `send`, the server computes `content_sha256` (the attached file's bytes, else the UTF-8 `body_md`) and stores it on the contract. `files.sha256` is added and written on upload. A trigger refuses to soft-delete a file referenced by a non-draft contract | Finding 9 |
| 12 | **Sign carries the hash.** The portal GET returns `contentSha256`, and the sign POST must echo it. On a mismatch the route answers 409 "this agreement changed since you opened it". The signature row records the hash it signed | The client signs what they saw, not what the row says now |
| 13 | **Tier is set at send and never changes.** `signature_tier = certified` when staff tick "certified", or when `value >= threshold` (a company setting, NULL until counsel sets it). Once a threshold exists, an unvalued contract cannot be sent. An amendment to a certified agreement is certified (default for PV5-Q1) | PV-D8; finding 10 |
| 14 | Providers sit behind small adapters, `SignatureProvider` and `PaymentProvider`, with one implementation each. The rest of the code never imports a vendor SDK | The vendor-exit row is credible only if leaving means one new adapter |
| 15 | A provider notice is **never trusted on its own.** Verify its signature, then re-fetch the payment or envelope status from the provider's API before changing anything. Dedupe by `(provider, event_id)` | A forged or replayed callback must not mark an invoice paid |
| 16 | Online payment is offered only for an issued IDR invoice with an outstanding balance. The amount charged is the outstanding balance, which must be a whole number of rupiah (`minor_unit = 0`), otherwise the checkout is refused. Other currencies keep bank transfer | Finding 16. No silent rounding of money |
| 17 | The manual claim form stops offering "Card". The server enum keeps `card` for existing rows. Gateway payments get `method = 'online'` and `source = 'gateway'` | "Card" on a manual claim was a label, not a payment method |
| 18 | The Documents list holds **legal and money documents only**: signed contracts plus their evidence, issued invoice PDFs and payment receipts. Deliverables stay under Projects | §2.3: Contracts & billing holds legal and money instruments |
| 19 | PDFs of issued invoices and of signature evidence are **rendered once and stored** as files with a SHA-256, through an outbox job after commit. They are never re-rendered on download | A document must not change because a template did |
| 20 | Group clients: the AR customer carries `counterparty_company_id` (from `clients.group_company_id` on first issue). Issue debits that counterparty's `1290-*` receivable (created by `finance_ensure_intercompany_accounts`), and the AR reconciliation counts the tagged receivables with the control | Finding 6; F9-04's "an untagged intercompany posting is a visible mistake" |
| 21 | **Company seal (PV-D25).** A signed contract is issued as one PDF (the document, then its evidence page) sealed with a PAdES signature by the company's own key. The certificate is self-issued in the billing profile's legal name, so readers show "unmodified since sealed", but "identity not verified by a trusted authority". The evidence page says so in plain words. No third-party timestamp authority: the seal carries our server time | The client's own copy proves its integrity without our database. Legal standing is unchanged (uncertified), and no new vendor is added |

## Waves

| Wave | Tickets | Why this order |
|---|---|---|
| 1 | PV5-01 (all PV-5 DDL), PV5-02 (authorization), PV5-03 (provider comparisons, docs only) | Disjoint files. 01 and 02 unblock everything; 03 has no code dependency |
| 2 | PV5-04 (issue through the ledger), PV5-05 (intercompany posting), PV5-06 (fixed content and the signature tiers), **PV5-01b** (the two enforcement CHECKs) | 04 and 05 need 01a and 02. 05 changes `finance_ar_issue_invoice`, which 04 calls, so 05 merges first or 04 rebases. 06 needs 01a. **01b merges in the same change as 04 and 06**, because today's code, seeds and about 10 test fixtures violate its CHECKs (PATCH to `sent`/`paid`, a contract sent with no hash) |
| 3 | PV5-07 (PDFs and the sealed copy), PV5-08 (Documents), PV5-09 (screens), PV5-12 (agent tools) | 07 needs 04 and 06; 08 needs 07; 09 needs 04 and 06 |
| — | **Release A**: PV5-13 part A | invoice of record, attested signing, Documents, intercompany |
| 4 | PV5-10 (Midtrans checkout) | needs the owner's Midtrans sandbox keys and Release A live |
| — | **Release B**: PV5-13 part B | after the sandbox drive and the owner's switch to production keys |
| parked | PV5-11 (certified signing through VIDA) | PV-D25: unparks when counsel sets a threshold (PV5-Q1) or a client asks; then needs a VIDA sandbox |

**Rules for every ticket:**

- Work in your own worktree from `origin/main`, never in the shared checkout.
- **No Docker on the laptop at all** (owner order, 2026-10-12). DB-, Cerbos- and Redis-backed tests
  run only on a Linux gate: GitHub Actions `ci.yml` on the pushed branch (`gh workflow run ci.yml
  --ref <branch>`), or sumopod's gate. Read the job counts, not just the colour. A local green does
  not count.
- No company names or ids in code (PV-D13). Prefixes, bank details and thresholds are data.
- Every portal query takes its predicate from `portal-scope.ts` and `portal-visibility.ts` (trap 1).
  Rows outside the caller's scope answer 404, never 403.
- Every read or write of a `finance_*` table goes through `withFinance()`. A test proves the
  zero-row trap cannot hide a missing row.
- A "Client sees this" marker comes from the backend or it doesn't ship (trap 9).
- Authorization runs before validation, so denial tests test authorization.
- No secret, key or real bank account in the repo: **it is public.** Real values live in the server
  env and in the database; `.env.example` gets placeholders. A new env var is also listed in the
  compose `environment:` block.
- Update the matching `docs/FRONTEND-BFF-CONTRACT.md` rows in the same change: §16b (portal
  commerce), §16e (staff counterpart), the invoice module's rows, and a new §30 for billing profiles,
  issue and Documents. Update `docs/PERMISSION-CONTRACT.md` for every new action.
- Prove each new test bites: break the code, watch the test fail, and say how in the hand-back.
- Status words: PLANNED → IN PROGRESS → PROTOTYPED → DEV-VERIFIED. Only PV5-13 can claim
  DEV-VERIFIED.
- The lead writes `MODULES.md` and `CHANGELOG.md`, regenerates MAP and the capability inventory from
  a clean tree, and reviews every diff before merge.
- PV-4 is being built at the same time. Both phases touch `contracts`, `portal-visibility.ts` and the
  Cerbos pins: rebase on `origin/main` right before merge and recompute.

---

### PV5-01: the data model

**Owner:** senior-db. **Wave 1.** Model: Sonnet·high.

**Owned paths:** new migrations under `PN/migrations/` (timestamp names); their DB tests.

**As built (2026-10-12), in two parts:**
- **01a** (`202610130400_pv5_billing_data_model.sql`, branch `pv5/01-data-model`): everything
  additive. It merges in wave 1.
- **01b** (`202610130430_pv5_enforce_issue_and_fixed_content.sql`, branch `pv5/01b-enforcement`):
  `invoices_sent_paid_issued`, `contracts_content_fixed_when_sent`, and the legacy exemption. Code on
  main today violates both CHECKs, so 01b merges with PV5-04 and PV5-06 (see Waves).
- The legacy exemption is a `pre_pv5_legacy` flag that only the migration sets. A guard trigger
  refuses any INSERT or UPDATE that sets or changes it, because a dated `created_at` bound could be
  backdated.
- `provider_events.tenant_id` is NOT NULL, like `github_webhook_deliveries`; the receiver resolves
  the tenant before the claim.

**Change:**
- `company_billing_profiles` (one row per company, `tenant_id` primary key):
  - `legal_name`, `address` (text), `invoice_prefix` (CHECK: 1 to 16 characters, `[A-Z0-9-]`),
    `default_payment_terms_days` (default 30), `currency_code` (FK `finance_currencies`);
  - `bank_name`, `bank_account_name`, `bank_account_no`, `bank_ledger_account_code` (the
    `finance_accounts` code that receives bank-transfer receipts), `default_revenue_account_code`;
  - `signature_threshold` (numeric, NULL = no threshold, PV-D8), `updated_by`, the timestamps.
- `document_series(tenant_id, series, year, next_no)`, primary key `(tenant_id, series, year)`, plus
  `next_document_no(p_tenant, p_series, p_year)`: `INSERT … ON CONFLICT DO NOTHING`, then
  `SELECT … FOR UPDATE`, increment, return. The caller's transaction holds the lock, so a rollback
  returns the number. Series `invoice` only for now.
- `invoices` gains:
  - `invoice_no`, `issued_at`, `issued_by`, `issue_date`, `due_date` (CHECK `due_date >= issue_date`);
  - `subtotal`, `tax_total` (`total` stays and must equal their sum once issued), `tax_code`;
  - `issuer` jsonb (the frozen snapshot, design decision 5) and `ar_invoice_id` (unique, FK to
    `finance_ar_invoices`).
  - A CHECK ties them together: `issued_at IS NULL`, or all of `invoice_no`, `issue_date`,
    `due_date`, `issuer` and `ar_invoice_id` are set.
  - Unique `(tenant_id, invoice_no)`.
  - A trigger refuses any UPDATE to the invoice-of-record columns, `lines` or `client_id` once
    `issued_at` is set. Only `status` (to `paid` or `void`) and `updated_*` may change.
  - The status values stay. `sent` is now reachable only through issue, and the UI labels it
    "Issued"; a new value would ripple through every portal badge and predicate for nothing. A CHECK
    requires `issued_at` on `sent` and `paid` rows. Rows created before this migration are exempt by
    a dated exception, the same way as contracts below; they can never be issued and accept no new
    payment claims. Say how many there are (live data is seed).
- `finance_ar_customers`:
  - a partial unique index on `(tenant_id, client_id) WHERE client_id IS NOT NULL`, after a check
    that no duplicates exist (fail loudly if they do);
  - an FK to `clients (id, tenant_id)` if the composite key exists, otherwise a trigger;
  - `counterparty_company_id` (FK `companies`, NULL for ordinary customers).
- `contracts` gains `content_sha256`, `content_fixed_at`, `signature_tier`
  (`attested | certified`, NULL while draft) and `certified_requested` (boolean, default false).
  A CHECK requires `content_sha256` and `signature_tier` on every non-draft row. Existing sent and
  signed rows: compute nothing, but mark the tier `attested` and leave the hash NULL behind a dated
  exception in the CHECK (`content_fixed_at IS NULL` only for rows created before this migration).
  Say how many rows that is.
- `contract_signatures` gains `content_sha256`, `provider` (NULL = attested) and
  `provider_envelope_id`.
- `files` gains `sha256` (nullable for old rows), plus a trigger refusing to soft-delete a file
  referenced by a non-draft contract's `file_id`.
- `invoice_payments` gains `source` (`client_claim | staff | gateway`, default `client_claim`;
  backfill `staff` where `recorded_by` is not the client's contact, if that can be told, else leave
  the default and say so), `provider`, `provider_payment_id` (unique per provider), `ar_receipt_id`
  (FK). The `method` CHECK gains `online`.
- `payment_checkouts` (`id`, `tenant_id`, `invoice_id`, `client_id`, `amount`, `currency_code`,
  `provider`, `provider_checkout_id`, `checkout_url`, `status` (`open | paid | expired | failed`),
  `expires_at`, `created_by`, the timestamps).
- `provider_events` (`id`, `provider`, `event_id`, `kind` (`payment | signature`), `tenant_id`,
  `received_at`, `status` (`received | processed | failed | ignored`), `error`), unique
  `(provider, event_id)`. This is the GitHub table's shape, not a copy of it.
- Every new table: RLS `ENABLE` + `FORCE`, the `tenant_isolation` policy, grants for the runtime
  role, and a DO-block self-assertion. The exception is `provider_events`, written before the tenant
  is known: copy exactly how `github_webhook_deliveries` handles that, and say how.

**Tests (on the Linux gate):**
- The RLS zero-row trap is asserted on every new table.
- `next_document_no` across two concurrent transactions: no duplicate and no gap; a rolled-back
  transaction returns its number.
- Updating an issued invoice's `lines`, `total` or `invoice_no` fails. Setting `paid` succeeds.
- A non-draft contract without a hash fails, except the dated legacy exception.
- Soft-deleting a file under a sent contract fails.
- A second AR customer for the same client fails.
- Teeth: drop the immutability trigger and its test fails.

### PV5-02: authorization

**Owner:** senior-be. **Wave 1.** Model: Sonnet·high.

**Owned paths:** `PN/cerbos/policies/resource_invoice.yaml`, `resource_contract.yaml`,
`resource_finance_config.yaml`, `resource_portal.yaml`, `permission-catalog.json`,
`permission-groups.json`, the regenerated `role-permission-bundles.json`,
`PN/scripts/generate-role-bundles.mjs`, the parity and pinned tests, a migration seeding
`permissions` + `role_permissions`, and `docs/PERMISSION-CONTRACT.md`.

**Change:** new actions on existing kinds only. **No new kind.**
- `invoice` `issue`: the roles that hold `approve` today, plus a perm mirror. It is not
  maker/checker-bound; approval already was. Refuse `bot` and `automation` by `EFFECT_DENY`. An
  agent then reaches it only through a D14 proposal. Once approved, it re-runs as the human the
  agent was acting for (`approval-execute.ts` invariant 1), who must hold `issue` themselves. An n8n
  workflow, which is an `automation` principal, never can (PV5-12).
- `invoice` `void_issued`: `company_admin` and `owner`, with the same agent refusal.
- `finance_config` `set_bank_details`: `owner` and `finance_manager` only, the agent refusal, and no
  perm mirror (so custom roles cannot reach it, as with PV3-01's countersign). PV-D26: the platform
  administrator's wildcard keeps its reach, but an `EFFECT_DENY` refuses everyone below high
  assurance, the administrator included. The same DENY is added to `vendor_master` in
  `resource_finance_ap.yaml`, where the wildcard used to bypass its high-assurance rule.
- `contract` `mark_certified`: the roles that hold `send`.
- The portal needs **no new action**. Documents reads use `portal` `read`, and online payment uses
  the existing `portal` `pay`, the action the manual claim already uses.
- Recompute the four pinned counts (`iam-215-boundary-pin`, `permission-groups-catalog-parity`,
  `ui-grantable-catalog`, `cerbos-catalog-alignment`) on the rebased tree.

**Tests:** a Cerbos test per action and role: a member is denied, a bot is denied, and the right role
is allowed. Teeth: remove the bot `EFFECT_DENY` and its test fails. After deploy, Cerbos is restarted
and probed (PV5-13).

### PV5-03: provider comparisons (docs only)

**Owner:** senior-integrator. **Wave 1.** Model: Sonnet·high.

**Owned paths:** `docs/blueprints/pv5-provider-comparison.md` (new), and the two new rows in
`docs/blueprints/vendor-exit-register.md`.

**Change:** two short comparisons, each ending in a pick and a runner-up. They read the providers'
current public pricing and documentation, dated, with links. **No account is opened and nothing is
signed up for.**
- **E-signature (PSrE):** at least Privy, VIDA, Peruri and one more registered PSrE. Criteria:
  - a certified signature recognised under Indonesian law (PP 71/2019);
  - per-signature or per-document pricing, with **no per-seat fee** (EST-D-VI1);
  - how a signer's certificate is issued (KYC by e-KTP), and what it costs the signer;
  - an API for envelopes, a signing link, webhooks and the signed PDF with its certificate;
  - whether e-Meterai can be added (for PV5-Q2);
  - a sandbox;
  - exit: can we export the signed PDFs and audit trails, and what happens to their validity if we
    leave.
- **Payment gateway:** at least Xendit, Midtrans and DOKU. Criteria:
  - a hosted checkout, so no card data reaches us;
  - VA, QRIS, e-wallet and card coverage;
  - per-transaction fees only;
  - callback signing and a status API (design decision 15);
  - settlement timing and fee reporting;
  - refunds, a sandbox, and the exit.
- Two vendor-exit rows: band, seat flag, replacement and exit cost. The e-signature row names the
  custody exit: signed PDFs and certificates are exported and stored by us at signing time, so leaving
  never strands a signed contract.

**Owner step after this ticket:** approve the picks and open a sandbox account with each. Those are
the inputs PV5-10 and PV5-11 wait for.

### PV5-04: issue an invoice through the ledger

**Owner:** senior-be, with senior-db review of the SQL. **Wave 2.** Model: Opus·high (money path).

**Merges with PV5-01b and PV5-06 in one change.** Rebase 01b's branch in, then fix every seed and
test fixture that writes `sent` or `paid` without issuing; 01b's CI run lists the 12 files. Never
weaken a CHECK to make a fixture pass.

**Owned paths:** `PN/src/modules/invoice/*`, a new `PN/src/modules/invoice/issue.ts`, the
invoice-payment decide path in `PN/src/core/contracts.controller.ts`, `PN/src/core/portal-commerce.controller.ts`
(the overdue rule and the payment claim bound only), `PN/src/core/clients.controller.ts` (the
overdue rule only), `PN/src/modules/finance/finance.controller.ts` (the tax line only), a
billing-profile controller, and their tests.

**Change:**
- `GET/PUT :tenantId/billing-profile`, authorized on `finance_config` `read`/`update`. Bank fields
  need `set_bank_details`. A bank change writes activity and notifies every owner (design decision
  6).
- `GET :tenantId/invoices/:id/issue-readiness` returns the blocker list (design decision 7).
- `POST :tenantId/invoices/:id/issue`, authorized on `invoice` `issue`, from `approved` only. In one
  `withFinance()` transaction:
  1. Re-check readiness and refuse with the list.
  2. Find or create the AR customer for the client (design decision 20 for group clients).
  3. Take the next number.
  4. Compute tax with `finance_tax_compute()`.
  5. Write the AR invoice and its lines (revenue account from the profile) and call
     `finance_ar_issue_invoice()`.
  6. Write the invoice-of-record columns and the issuer snapshot, and set `sent` (shown as
     "Issued").
  7. Emit `invoice.issued` and write a revision.
  - Idempotent: a second call answers the issued invoice.
- `PATCH` no longer accepts `sent` or `paid`. `void` before issue stays as today; after issue it is
  `POST …/void`, authorized on `void_issued`, and design decision 9 applies.
- **Payments:**
  - The confirm path, and the client claim's bound, read the AR invoice's outstanding amount.
  - Confirm records `finance_ar_record_receipt()` into the profile's bank account, then allocates.
    The invoice becomes `paid` when the AR invoice does, in the same transaction.
  - A rejected claim posts nothing.
  - An existing tracker row that is not issued accepts no payment claim.
- Overdue is by due date (design decision 10).
- The finance API's hard-coded PPN line calls `finance_tax_compute()` (finding 4).
- Portal invoice reads add `invoiceNo`, `issueDate`, `dueDate`, tax lines, `issuer` (including the
  bank block) and `outstanding`. Hide nothing that was visible; an unissued invoice stays hidden
  (PV3-02d).

**Tests (Linux gate):**
- Issue on a company with no profile returns the blocker list, and nothing is written.
- Issue posts a balanced journal; the AR invoice and the invoice agree on number and totals.
- Two concurrent issues on one company get consecutive numbers.
- Issuing a taxed invoice while `is_pkp` is NULL is refused.
- Confirming a payment posts a receipt and an allocation; full payment flips both rows to `paid`.
- Void after issue reverses in the ledger, and `finance_ar_reconcile()` stays clean.
- `PATCH status=paid` answers 400.
- A bot calling issue gets 403 before any validation.
- Teeth: remove the readiness re-check inside the transaction and the "no profile" test fails.

### PV5-05: intercompany posting for group clients

**Owner:** senior-db. **Wave 2.** Model: Opus·high (ledger function).

**Owned paths:** a migration that re-creates `finance_ar_issue_invoice`, `finance_ar_reconcile` and
`finance_ar_position`, plus their DB tests.

**Change:**
- When the AR customer has `counterparty_company_id`, issue debits that counterparty's `1290-*`
  receivable (ensure it exists through `finance_ensure_intercompany_accounts`), not the AR control.
- The reconciliation identity counts the tagged receivables together with the control account. State
  the new identity in the migration header, with a worked example.
- Receipts against an intercompany invoice credit the same tagged account.
- Viceroy's mirror side (its payable) is NOT written: Viceroy has no books yet (PV-9). Say so in the
  header.

**Tests:**
- An invoice to a group client lands on `1290-*`, and the reconciliation is clean.
- An ordinary client's invoice still lands on the control account.
- A receipt clears the tagged account.
- Teeth: post a group client's invoice to the control account and the reconciliation test fails.

### PV5-06: fixed content and the signature tiers (attested tier live)

**Owner:** senior-be. **Wave 2.** Model: Sonnet·high.

**Merges with PV5-01b and PV5-04** (see PV5-04): the contract fixtures that send with no hash are
fixed here.

**Owned paths:** `PN/src/core/contracts.controller.ts` (send, countersign), the sign route in
`PN/src/core/portal-commerce.controller.ts`, `PN/src/core/files.controller.ts` (`sha256` on upload),
and their tests.

**Change:**
- `send` computes and stores `content_sha256` and `content_fixed_at`, and sets `signature_tier`
  (design decision 13). It refuses an unvalued contract while a threshold exists.
- The portal contract GET returns `contentSha256` and `signatureTier`.
- The client sign POST requires `contentSha256` and answers 409 on a mismatch. The signature row
  records the hash.
- A certified contract refuses the typed-name sign with a clear message ("this agreement is signed
  through <provider>"). Until PV5-11 lands, staff cannot mark one certified unless a provider is
  configured: the mark action answers 409 "no certified signing provider is set up".
- Countersign records the hash, plus the IP hash and user agent that the client side already records.
- Upload writes `files.sha256`.

**Tests:**
- A hash mismatch returns 409 and writes no row.
- The tier is set at send; once a threshold is set, an unvalued send is refused.
- Typed-name signing of a certified contract is refused.
- Teeth: skip the hash comparison and the mismatch test fails.

### PV5-07: issued-invoice PDFs, and the sealed signed copy of a contract

**Owner:** senior-integrator. **Wave 3.** Model: Opus·high (key handling and PDF signing).

**Owned paths:** two print routes under `UI/app/print/` (beside TR-20's), a render-and-seal job in
`PN` on the outbox, a migration for the seal certificates, an ops script that creates a company's
sealing key, and `report-renderer` only if its same-origin rule needs the new paths.

**Change:**
- After `invoice.issued`, an outbox job mints a one-shot job token (the TR-21 pattern), asks
  `report-renderer` for the PDF, and stores it as a file with `sha256` (`target_entity_type =
  'invoice'`).
- After a contract becomes `signed`, the same job builds the **sealed signed copy** (design decision
  21, PV-D25):
  1. Take the contract document: the attached PDF, verified against `content_sha256` first (refuse
     on a mismatch), or `body_md` rendered through a print route.
  2. Render the evidence page: parties, names, titles, times, IP hashes, user agents, the content
     hash, the tier, and a plain-words note on what the seal proves and what it does not.
  3. Join them into one PDF and apply a PAdES signature with the company's sealing key.
  4. Store it as a file with `sha256` (`target_entity_type = 'contract'`, marked as the signed copy;
     add a `files` column for the role if none exists).
- **Keys:**
  - One sealing key per company, created by the ops script. Neither the key nor its passphrase is
    ever in the repo, the database or an env var.
  - Mount it as a file. `env_file` mangles a multi-line PEM: it was empty on one compose and
    truncated to 27 characters on another.
  - The self-issued certificate names the billing profile's legal name. Public certificates are kept
    in a table (company, serial, valid from/to, PEM), so a seal stays checkable after the key
    rotates.
  - A missing key fails loudly: the document stays "being prepared" and an owner is notified. It
    never ships unsealed.
- Use maintained open-source libraries for joining and signing PDFs, check their licences, and add
  a vendor-exit row in the same change.
- The sealed copy and every issued-invoice PDF get the same soft-delete guard as a contract's
  `file_id` (PV5-01a's trigger, widened to the new file role).
- The job is idempotent and retried. A failure leaves the document marked "being prepared", never
  missing silently.
- `DOWNLOADABLE` gains `invoice`, and `ownsEntity` admits only an issued invoice in the caller's
  scope.

**Tests:**
- The job is idempotent: two runs store one file.
- An unissued invoice's PDF is not downloadable from the portal (404).
- The stored hash matches the stored bytes.
- The sealed copy's signature verifies with the stored certificate, and flipping one byte breaks it.
- A contract whose attached file no longer matches `content_sha256` is refused, not sealed.
- No key means no file, and the failure is reported.
- Teeth: skip the content check and the mismatch test fails.

### PV5-08: Documents (portal and staff)

**Owner:** medior. **Wave 3.** Model: Sonnet·medium.

**Owned paths:** a new `PN/src/core/portal-documents.controller.ts`, its staff counterpart, a Next
route under `UI/app/api/` that proxies staff file content, and the UI pieces named below.

**Change:**
- `GET :tenantId/portal/documents`: one list built **only** from the existing predicates
  (`contractInPortalScope`, `invoiceInPortalScope`, `invoicePaymentInPortalScope`), newest first.
  Each item has a kind, a title, a date and a download href. Add the endpoint to the portal guard
  test's list.
- The staff version on the client hub carries `clientVisible` from the same predicates. Add a parity
  test like PV3-07's.
- The staff download route already exists: `UI/app/api/files/[fileId]/route.ts` (PV-3 follow-up,
  `9ced6b6d`, released in 366). Reuse it for staff Documents links; do not build another.
- Portal: a **Documents** sub-tab under Contracts & billing at `/portal/documents`, a new path (every
  existing path is kept). Update `portalNav.ts` and its route test.
- Staff: a Documents section on `/clients/[id]/billing`.

**Tests:** scope (another client's documents never list, and a direct id answers 404); the
`clientVisible` parity; axe in light and dark on both pages.

### PV5-09: screens

**Owner:** senior-fe. **Wave 3.** Model: Sonnet·high.

**Owned paths:** `UI/app/(app)/invoices/*`, `UI/app/(app)/clients/[clientId]/billing/*`, a billing
profile page under `UI/app/(app)/finance/settings/`, `UI/app/(portal)/portal/invoices/*`,
`UI/app/(portal)/portal/contracts/*`, `UI/components/portal/PortalPaymentForm.tsx`.

**Change:**
- Staff invoice page: the readiness list and the Issue button; the issued view (number, dates, tax,
  issuer, PDF link, ledger link for finance roles); Void after issue.
- The billing profile page, with the bank block separated and labelled "clients pay into this
  account".
- Contracts on the billing page: tier, "Mark certified", and the content hash (short form, copyable).
- Portal invoice: the invoice of record, "How to pay" with the bank block from the snapshot, and the
  manual claim form without "Card" (design decision 17).
- Portal contract: the sign form sends the hash it was given; on a 409 it reloads with a notice. The
  evidence link appears once the document is ready.
- Axe in light and dark on every changed page. No opacity-dimmed labels (the go-live contrast item).

**Tests:** unit and render tests per component; the portal e2e signs with a stale hash and sees the
reload notice.

### PV5-10: online payment (hosted checkout)

**Owner:** senior-integrator. **Wave 4.** Model: Opus·high (money path and webhook).

**Needs:** the owner's Midtrans sandbox keys (PV-D25) and Release A live. Read
`docs/blueprints/pv5-provider-comparison.md` §2 and §4 first.

**Owned paths:** `PN/src/payments/` (new: the `PaymentProvider` interface and a Midtrans Snap
adapter), a webhook controller at `api/webhooks/payments/:provider`, the portal pay route, the env and
compose wiring, and an egress inventory test for the provider host.

**Midtrans specifics (from PV5-03):**
- `order_id` is single-use, at most 50 characters from `A-Za-z0-9-_~.`. Mint one per checkout
  attempt, never the invoice number, and keep it on `payment_checkouts`.
- The notice carries `signature_key` = SHA-512(`order_id` + `status_code` + `gross_amount` + server
  key). Compute and compare it in constant time.
- There is no event id. The dedupe key is `order_id` plus `transaction_status` plus `status_code`, or
  the transaction id; confirm which in the sandbox and record it in the controller header.
- `settlement` can arrive before `pending`: never drop an out-of-order status as unknown.
- Paid means `settlement`, or `capture` for cards, with `fraud_status = accept`. Anything else
  writes no payment.
- Midtrans retries for about 6 hours and wants a 200 within 5 seconds. So: verify, claim and answer
  200, then do the status re-fetch and the posting from the outbox.
- `gross_amount` is whole rupiah (design decision 16).

**Change:**
- `POST :tenantId/portal/invoices/:id/checkout` (portal scope, any active contact) creates or reuses
  an open `payment_checkouts` row for the outstanding amount (design decision 16) and returns the
  provider's hosted URL.
- The webhook:
  1. Verifies the signature (for Midtrans, `signature_key`).
  2. Claims the dedupe key in `provider_events`.
  3. Re-fetches the payment from the provider's status API.
  4. Then, as the provider's `automation` user (one `users` row per provider, created by this
     ticket's migration and named in its header; it holds no roles, because this path is
     server-internal and checks no Cerbos rule, like the GitHub receiver), writes an
     `invoice_payments` row
     (`source = 'gateway'`, `method = 'online'`, confirmed) and posts the AR receipt into the
     gateway clearing account (a `finance_accounts` code named in the provider config, never a
     hard-coded code). It allocates, emits `invoice.payment.confirmed`, and notifies the client and
     the staff recipients.
  - It acknowledges 200 after the claim even if processing fails, and records the error.
  - It never calls the staff decide route or D14 (finding 14). This bypass is written in the
    controller header.
- Amount mismatch, an unknown checkout, or a paid or void invoice: record `ignored` with the reason,
  write no payment, and notify finance.
- Settlement (the provider's payout to our bank) and fees stay manual in Finance for v1. Say which
  journal finance posts, in the BFF row.
- Secrets: the API key and callback secret are env vars, listed in compose `environment:` and as
  placeholders in `.env.example`. The repo is public.

**Tests:**
- A forged signature gets 401 and writes nothing.
- A replayed event is processed once.
- A payload claiming paid while the status API says pending writes nothing.
- An amount mismatch is ignored and reported.
- A good event confirms, posts and allocates exactly once.
- Teeth: skip the status re-fetch and the "payload lies" test fails.

**Live:** the owner's sandbox drive pays one test invoice end to end before production keys go in.

### PV5-11: certified signing (PARKED, PV-D25)

**Owner:** senior-integrator. **Parked.** Model: Opus·high.

**Parked until** counsel sets a threshold (PV5-Q1) or a client asks for a certified signature. Then
it needs a VIDA sandbox and Release A live. Until then, "Mark certified" answers 409 (PV5-06), and
every contract signs in our own tier with the company seal (PV5-07).

**Before building, from PV5-03:**
- VIDA's webhook has **no HMAC**, only Basic or OAuth2 credentials, so the re-fetch is the only
  integrity control.
- If VIDA has no status endpoint, call Download Signed Document on every notice and verify the
  hash and signature locally. If neither is possible, re-scope this ticket before building.
- VIDA charges per external signature, so create the envelope only when the client reaches the
  sign step, not at send.

**Owned paths:** `PN/src/signatures/` (new: the `SignatureProvider` interface and one adapter), a
webhook controller at `api/webhooks/signatures/:provider`, `contracts.controller.ts` (the send and
countersign branches for `certified`), and the env and compose wiring.

**Change:**
- When the client reaches the sign step on a certified contract, the server creates the provider
  envelope from the fixed content (its hash must match the file sent) with the client signer and our
  countersigner, and stores `provider_envelope_id`.
- The portal contract page shows "Sign with <provider>", linking to the provider's signing page.
- The webhook verifies, dedupes, and re-fetches the envelope status. Then it writes each
  `contract_signatures` row with `provider`, and on completion stores the provider's signed PDF and
  certificate as files with `sha256` (the custody exit in the vendor-exit row) and sets `signed`.
- Countersign for a certified contract happens at the provider, not through the ERP's button. The
  ERP button explains this.
- Agents never sign: the PV3-06 countersign executable refuses a certified contract.

**Tests:** forged and replayed callbacks; an envelope whose document hash differs from
`content_sha256` is refused at send; completion stores both files with matching hashes; teeth on the
re-fetch.

### PV5-12: agent tools (agentic-native bar)

**Owner:** medior. **Wave 3.** Model: Sonnet·medium.

**Owned paths:** `PN/src/core/core-tools.ts` (or the invoice module's tools), `approval-executables.ts`,
the MCP hub registration, golden cases and the capability inventory.

**Change:**
- `invoices.issueReadiness` (read).
- `invoices.issue` and `invoices.voidIssued` (high, through D14). Once approved, the call re-runs as
  the human the agent acted for (invariant 1), and the executable re-checks readiness.
- `billingProfile.read` (read; the bank block is masked to the last 4 digits).
- `documents.list` (read, per client).
- No tool sets bank details, marks a contract certified, or creates a checkout.
- One golden case per tool, and an activity row on every state change.

**Tests:** golden cases, and a bot calling `invoices.issue` directly is refused (403).

### PV5-13: QA gate, releases, live

**Owner:** qa, with the lead. **Model:** Sonnet·high.

**Part A (after waves 1 to 3):**
- Merged-tree gate on Linux with job counts; portal and hub e2e; axe in light and dark.
- MAP and the capability inventory regenerated from a clean tree.
- Release:
  - migrations applied;
  - Cerbos restarted, then probed: a member DENY `invoice/issue`, a bot DENY, and the owner ALLOW
    `finance_config/set_bank_details`.
- Live drive (DEV-VERIFIED), on a placeholder client (live ERP data is seed):
  1. The owner or finance sets the billing profile.
  2. Issue one invoice: its number, the ledger journal, and the portal view with bank details.
  3. Record a manual payment and confirm it: the receipt posts and the invoice is paid.
  4. Send, sign and countersign one attested contract: the hash is recorded, and the sealed signed
     copy is in Documents and shows as unmodified in an ordinary PDF reader.
  5. Issue one invoice to the group client: it lands on `1290-*`.
- This also closes PV-3's open countersign item.

**Part B (after wave 4):**
- A sandbox drive of PV5-10, then release with the production keys the owner sets.
- One real online payment of a small test invoice.
- The Midtrans vendor-exit row re-checked.
- PV5-11, when it unparks, gets its own sandbox drive, release and one real certified signature.

## Owner steps

1. ~~Approve the provider picks~~ Done (PV-D25). **Register the company as a Midtrans merchant**
   (deed, MoJHR decree, director's KTP and NPWP, company NPWP, NIB) and get sandbox keys; wave 4
   waits on this. VIDA only when PV5-11 unparks.
2. Ask counsel for PV5-Q1 and PV5-Q2.
3. Make sure Finance records the agency company's PKP status (`is_pkp`). Taxed invoices wait on it.
4. Set the billing profile on live, or name who does: the legal name, address, prefix and the bank
   account clients pay into.
5. Switch on the finance module for the agency company if it is off; issuing refuses until it is on.

## Open for the owner and counsel (non-blocking)

| # | Question | Lead's default, used until ruled |
|---|---|---|
| PV5-Q1 | **Counsel:** the contract value at or above which a certified signature is required. Is an amendment measured by its own value, or together with its agreement? | **No threshold.** Under PV-D25 nothing is certified until PV5-11 unparks, which this answer can trigger. When it does, an amendment to a certified agreement is certified |
| PV5-Q2 | **Counsel:** does stamp duty (bea meterai, UU 10/2020) apply to our agreements, and to invoices or receipts above Rp5,000,000, and should the ERP add an e-Meterai? | **Not applied by the system.** Staff handle it outside the ERP until counsel answers; PV5-03 records which providers can add one |
| PV5-Q3 | The invoice number format | `{prefix}/{yyyy}/{nnnn}`, restarting each calendar year, with the prefix set in the billing profile |

## Not in PV-5 (and where each goes)

| Item | Why not now | Goes to |
|---|---|---|
| e-Faktur transmission | D-F2: a licensed ASP/PJAP, never built here | Finance F7, when PKP is known |
| Invoices with fixed-fee or milestone lines | Lines come only from logged hours today | a billing follow-up; the owner names the need |
| The gateway's settlement and fee posting | Manual in Finance for v1 | Finance F6, after a month of real settlements |
| Refunds through the gateway | A credit note plus a manual refund at the provider for v1 | later |
| Viceroy's side of intercompany (its payable) | Viceroy has no books | PV-9 |
| Mail to clients when an invoice is issued | Needs the mail sender | "Before real clients use the portal" |
| `declined` and `expired` contract states being written | Not needed by PV-5 | a contracts follow-up |
| Partial-payment status on the invoice | `outstanding` shows it; a status adds nothing | not planned |
