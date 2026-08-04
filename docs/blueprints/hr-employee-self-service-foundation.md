# HR department expansion + employee self-service — foundation blueprint

**Status:** `PLANNED` — design only, **no code written**. · **Scoped:** 2026-08-04
**Owner decision:** kept as its OWN scope for a later HR department expansion, deliberately *not* built
in the client-portal session that produced it.

Vocabulary per [`../modules/MODULES.md`](../modules/MODULES.md): `PLANNED · IN PROGRESS · PROTOTYPED ·
DEV-VERIFIED`. Sibling department blueprints: [`creative-foundation.md`](./creative-foundation.md),
[`smm-foundation.md`](./smm-foundation.md), [`seo-sem-foundation.md`](./seo-sem-foundation.md).

---

## 0 · Why this document exists

The owner's plan for a "staff portal" was stated as five capabilities (leave/sick/loan requests; own
contract/benefits/allowance; KPI/trainings; personal docs/payslip/certifications; notifications/mail).
An audit against the code showed that **roughly half already exists** and the rest is four separate
subsystems — one of which (payroll) is department-sized and holds the most sensitive data in the
company. Recording the audit and the locked decisions here means the later ticket starts from facts
rather than re-deriving them, which is the failure mode the migration-ledger and reservation-drift
history in this repo keeps demonstrating.

**Read §1 before designing anything.** Two of its findings invalidate the obvious plan.

---

## 1 · Ground truth (audited 2026-08-04 against code, not docs)

### 1.1 There is no staff portal — there is an HR *ops console* plus scattered self-service

`/hr/*` ([`platform-ui/src/app/(app)/hr/`](../../platform-ui/src/app/(app)/hr/)) is built for HR
staff: its home shows headcount, department counts, **pending leave across other people**, and open
cases, and its own copy says "clear the approval queue". An ordinary employee landing there sees an
operations console about colleagues. The `HR` nav entry is **ungated** (`nav.ts` lists it
unconditionally in the Departments group), so every staff member can already reach it.

Genuine self-service exists but is spread across seven unrelated routes:

| Route | What the employee gets |
|---|---|
| `(app)/page.tsx` | My Work — assigned tasks, agenda, check-in card |
| `/account` | Preferences, sign out, link to "My employee page" |
| `/people/[userId]` | Employee 360 on themselves — profile, roles, KPIs, tasks, projects, time, WA/TG identity links, activity |
| `/reports/person` | Own KPI report (person grain) |
| `/appraisals/mine` | Own appraisal record |
| `/timesheets` | Own time entries |
| `/notifications` | In-app bell + list |
| `/hr/leave` | **Can already file and cancel their own leave** (`canFileForOthers` is the separate, gated path) |

### 1.2 The authorization model is already right — the surface is what is missing

This is the good news and it shapes the whole estimate. `lib/rbac.ts` states the principle explicitly:

> A plain member's own report, own check-in and own appraisal are **NOT capabilities** — they are
> self-service, gated server-side by `ownerId`/`subjectUserId == principal.id` (§11 principle 2:
> *"nothing about you that you cannot read"*).

and `resource_hr_case.yaml` already carries a `member` self-service rule for `read` / `create` /
`cancel` guarded by `subjectUserId == principal.id`, with a `has()` check so it **fails closed** if a
handler forgets to pass the subject. So leave, sick leave, cases and cancellations need no new
authorization work — only a place to live.

### 1.3 ⚠ FINDING ONE — subject self-read of HR records is deliberately OFF

[`resource_hr_record.yaml`](../../platform-nest/cerbos/policies/resource_hr_record.yaml):

> `hr_record` = contract|document|note references per subject. More sensitive than `hr_case`: per
> design §1 Scope, **subject self-read of records is OUT in v1 (no `member` rule here —
> deliberately).**

`hr.controller.ts` repeats it at the call site ("no dual-path fallback"). So **an employee cannot read
their own employment contract today**, and that is a recorded decision, not an oversight. Two of the
owner's five bullets (own contract; personal documents/certifications) are blocked on reversing it.

A second, related surprise in the same policy: **`group_executive` is explicitly denied** on
`hr_record` — the holding-level owner cannot read raw per-subject contracts either, by design
(cross-company visibility is served through D12 rollups only). Anyone assuming "the owner sees
everything" will be wrong here.

### 1.4 ⚠ FINDING TWO — four capabilities have no representation at all

Greps for `loan|payroll|payslip|salary|training|certification|benefit|allowance|reimburse` across
`platform-nest` return **only unrelated hits** (Ahrefs' "training" data, `creative_assets_training`,
search-provider cost fields). There is no table, no endpoint and no UI for:

- **loans** — nothing
- **payroll / payslips (slip gaji)** — nothing; payroll was explicitly scoped *out* of the backbone program
- **trainings** — nothing
- **benefits / allowances** — nothing

And **there is no mailer in the platform at all** — no `nodemailer`, no SMTP send path, nothing. In-app
`notifications` exist and work; outbound email does not. "Mail" in the owner's list therefore needs
defining before it can be scoped (in-app thread with HR? emailed digest? a real mailbox?).

### 1.5 What HR *does* have (0028, `module_hr`)

`hr_cases` (onboarding|offboarding|review|grievance|other, with a JSONB checklist) · `hr_records`
(contract|document|note + `file_id`) · `hr_leave_requests` (vacation|sick|unpaid|other, minutes as the
canonical unit, approval via `automation_approvals`) · `hr_leave_balances` (per subject/year/type) ·
`hr_attendance` (one row per subject/day) · `hr_checklist_templates`.

All six sit behind the **module third wall** — `tenant_id = ANY(app_current_tenants()) AND
app_module_allowed('hr')` — so any new `hr_*` table must declare `{ modules: ["hr"] }` on
`withTenants(...)` or it reads and writes **zero rows** with a correct tenant set. Fail-closed by
construction, and invisible if forgotten.

---

## 2 · Decisions locked 2026-08-04

| # | Decision | Consequence |
|---|---|---|
| 1 | **A `/me` section inside the staff ERP** — not a separate portal shell, not more `/hr` tabs | Employees are already ERP users with a workspace; one login, one shell. `/hr` stays the HR-ops console. The client portal's separate-interface treatment is deliberately **not** copied here. |
| 2 | **Full payroll computed in-platform** — not upload-only PDFs | The largest single piece of this program. See §4 for why it is gated on facts nobody has supplied yet. |
| 3 | **Loans with full amortization + payroll deduction** | Only coherent *because* of decision 2 — it depends on a payroll run existing to deduct from. Sequenced after payroll, never before. |
| 4 | **Reverse §1.3, scoped by `record_type`: contract + documents + certificates readable by the subject; `note` stays HR-only** | `note` is where performance concerns and grievance context live. Exposing it would change what HR is willing to write down, quietly destroying the field's value — the reversal is deliberately partial. |

**Recommended `/me` shape** (from decision 1):

```
(app)/me/
  page.tsx          my dashboard — what needs me, balances, next payslip
  leave/            request leave/sick, balances, history      ← mostly EXISTS, needs re-homing
  loans/            request, schedule, remaining balance       ← new
  documents/        contract, certificates, personal docs      ← needs §1.3 reversal
  pay/              payslips, allowances, benefits             ← new (payroll)
  performance/      KPI report, appraisals, trainings          ← KPI/appraisal EXIST, trainings new
  inbox/            notifications + HR messages                ← notifications EXIST, "mail" undefined
```

---

## 3 · Sequencing — cheapest and least risky first

The order is not arbitrary: each wave is independently shippable, and the two waves that touch money
come last so they cannot block the rest.

**Wave A — the `/me` shell and re-homing (no new subsystems, no new sensitive data).**
Build `(app)/me/*`, move the seven scattered self-service surfaces under it (leaving the old routes as
redirects), and give `/me/leave` a first-class "request leave or sick day" flow using the
already-correct `member` self-service authorization from §1.2. **This alone delivers bullets 1 (partly),
3 (partly) and 5 (partly) with essentially no new risk**, and it is what makes the portal *feel* like it
exists. Do this first regardless of what happens to payroll.

**Wave B — documents (§1.3 reversal).** Add the `record_type`-scoped `member` self-read rule, extend
`hr_records.record_type` with `certificate` (and later `payslip`), and build `/me/documents` on top of
the existing `files` download path. Delivers bullets 2 (contract) and 4 (docs/certs). Small, and gated
only on the owner having signed off decision 4 — which they have.

**Wave C — trainings.** Cheapest defensible v1 is `record_type='training'` on `hr_records` (a viewable
record of a completed training with an optional certificate file), **not** an LMS. If enrolment,
curricula or scheduling are ever wanted, that is a separate subsystem and should be named as such
rather than grown accidentally out of a record type.

**Wave D — payroll.** The department-sized piece. See §4.

**Wave E — loans.** After D, because payroll deduction needs a payroll run to deduct from.

**Wave F — "mail".** Blocked on the definition in §1.4. If it turns out to mean outbound email, note
that the client portal already has the same gap (a client is not emailed when a contract awaits their
signature) — so a mailer is shared infrastructure serving two programs, and should be scoped as such.

---

## 4 · Payroll — what must be true before a line is written

Decision 2 was taken with the concern stated and reaffirmed, so it is the plan. But payroll is the one
part of this program that **cannot be built from the information currently available**, and guessing
would be worse than waiting.

### 4.1 Architecture that is safe to commit to now

**Statutory rates must be versioned DATA, never code.** Indonesian PPh21 (including the 2024 TER
scheme), BPJS Kesehatan and BPJS Ketenagakerjaan (JHT / JP / JKK / JKM) all have rates, caps and
brackets that change by regulation and must be reproducible for a *past* period — a payslip issued last
March has to still compute to the same number next year. So:

- a `payroll_rate_tables` shape keyed by `(kind, effective_from, effective_to)`, holding brackets and
  caps as JSONB, with the engine resolving the table by the payslip's **period**, not by `now()`;
- the calculation engine as pluggable components (earnings → allowances → statutory deductions → tax),
  each a pure function over `(structure, period, rate_table)` so every component is unit-testable
  against known-answer fixtures;
- payslips **frozen on issue** (the same pattern `invoices.lines` already uses in this codebase) so a
  later rate correction never silently rewrites history;
- salary structures versioned per employee, because a mid-year raise must not retroactively change
  prior payslips.

This much is derivable from the codebase's existing habits and is worth writing down now.

### 4.2 Facts required from the owner / a payroll professional

Not opinions — inputs the engine cannot be correct without:

1. **Pay cycle** — monthly? cut-off and pay dates? pro-rating rule for mid-month joiners/leavers?
2. **The actual statutory rate set in force**, with effective dates, for PPh21 (TER category per
   employee), BPJS Kesehatan (employer/employee split, salary cap), and BPJS JHT/JP/JKK/JKM.
   **These must be supplied and reviewed by someone accountable for them — they are not something to
   infer, and a model's recollection of a tax table is not a source.**
3. **Where each employee's tax status lives** — PTKP status (TK/K plus dependants) and NPWP. There is
   no column for either today; both are new and both are personal data with a retention story.
4. **THR / bonuses / overtime** — in scope or out? Each changes the earnings model.
5. **Who may run payroll, and who may see a salary.** `company_admin` is almost certainly too wide, and
   `group_executive` is currently *denied* even on `hr_record` (§1.3) — so the existing role set does
   not yet express "payroll officer". A new role plus its own Cerbos resource is required.
6. **Where payroll data may live** — the same database as everything else, or an isolated store? This
   is the most sensitive data the platform would hold, and the answer changes the deployment topology.

### 4.3 The honest estimate

Payroll is not a feature on a portal; it is a subsystem with statutory correctness obligations, an
audit trail, and a blast radius measured in employee trust and legal exposure. It deserves its own
design document, its own review by someone who owns payroll compliance, and its own test corpus of
known-answer payslips **before** implementation — not a wave in a portal ticket. Waves A–C deliver most
of what the owner asked for and are unblocked today; recommend running those while §4.2 is answered.

---

## 5 · Explicit non-goals for the first pass

Recorded so scope creep has to be a decision rather than a drift:

- No LMS (enrolment, curricula, scheduling) — trainings are viewable records only.
- No expense reimbursement — not in the owner's list; adjacent enough to be assumed by accident.
- No recruitment/ATS.
- No employee-editable HR records. The client portal's precedent applies: the subject *reads* their
  contract and *requests* changes; HR applies them. A record the subject can rewrite is not a record.
- No mailer until §1.4's "mail" is defined (and then as shared infrastructure, not an HR feature).

---

## 6 · Cross-references

- HR module design: `docs/superpowers/plans/` (WSD-2/WSD-4/WSD-5 — the `module_hr` tickets)
- Reports/appraisals (the existing KPI half): [`tracker-reporting-foundation.md`](./tracker-reporting-foundation.md)
- Client portal, whose session produced this document and whose `/portal` isolation kernel is the
  reference for "subject reads, provider writes": `docs/plans/2026-08-04-client-portal-deployment.md`
  and §16 of [`../FRONTEND-BFF-CONTRACT.md`](../FRONTEND-BFF-CONTRACT.md)
- Org/company scoping that any `/me` surface inherits: `ORG-CORE` + `service_assignments` (0026/0027)
