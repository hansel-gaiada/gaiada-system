# Employee portal — foundation blueprint

**Status:** `PLANNED` — design only, **no code written**. · **Scoped:** 2026-08-04
**Owner correction (2026-08-04):** the employee portal is **NOT an HR feature.** It is a personal hub —
a peer of the client portal — and it owns its own scope. HR was where this work was first written down;
that framing was wrong and this document exists to undo it.

Sibling: `2026-08-04-client-portal-deployment.md` (the pattern this follows).
The HR *department* scope is now [`hr-department-foundation.md`](./hr-department-foundation.md).

---

## 1 · The model: three surfaces over the same people, with different owners

The correction that produced this document. There are **three** distinct surfaces onto an employee, and
conflating any two of them is what made the first draft wrong:

| Surface | Whose need it serves | Owns | Example |
|---|---|---|---|
| **Employee portal** (`/me`) | **the person's own** | this document | "what is my leave balance, where is my payslip, what did I agree to" |
| **HR** (`/hr`) | the HR department's | `hr-department-foundation.md` | "who is on probation, clear the leave queue, run onboarding" |
| **Department consoles** (`/departments/*`) | the delivering department's | existing dept-console work | "what is my team shipping, who is assigned" |

Each serves the employee **up to the limit of its own need**. HR needs an employee's records to do HR
work; a department needs their assignments to run projects. Neither of those is *the employee's own view
of themselves*, and neither should own it — which is precisely why this is not an HR ticket.

**The client portal is the correct analogy.** A client's data lives in `clients`, `projects`, `invoices`
and `contracts` — tables the staff ERP owns and writes. The client portal does not own any of it; it is
a **personal, read-mostly hub over data other subsystems own**, with a narrow set of writes that belong
to the subject (sign, pay, request a change). The employee portal is the same shape:

- reads across HR, PM, reports/appraisals, payroll and notifications — **owning none of them**
- writes only what belongs to the person: request leave, request a loan, sign an acknowledgement,
  update their own contact details, ask for a correction
- everything else is a **request** that a responsible party applies (the client portal's
  "subject reads, provider writes" rule, applied to employees)

## 2 · Where it differs from the client portal — and why that changes the shell

One structural difference, and it is the reason decision 1 below is not simply "copy the client portal":

**A client has no other business in the ERP. An employee does.** A client signs in, answers what needs
them, and leaves; giving them their own shell costs them nothing. An employee spends the day in tasks,
projects, timesheets and their department console. Give them a *second* shell for personal matters and
they pay a context switch every time they check a leave balance — and we pay for two shells over one
identity.

So: **its own section with its own identity, inside the staff app.** Separate in ownership, navigation
and vocabulary — not a separate deployment. `(portal)` is a separate route group because its users are
external; `/me` is a section because its users are already here.

*(If this is ever reversed — e.g. a deskless workforce who only ever need the personal hub — the client
portal shows exactly what a split costs: a second shell is cheap, a divergent copy of the session and
egress layers is not. Move the folder, keep the plumbing.)*

---

## 3 · Decisions locked 2026-08-04

| # | Decision | Note |
|---|---|---|
| 1 | **A `/me` section in the staff ERP** — own nav group, own vocabulary, own empty states | Not a separate shell (§2), not more `/hr` tabs. `/hr` stays the HR-ops console. |
| 2 | **Full payroll computed in-platform** | The largest piece. Blocked on facts, not effort — §5. |
| 3 | **Loans with full amortization + payroll deduction** | Only coherent *because* of 2; sequenced after it, never before. |
| 4 | **Subject self-read of `hr_records`, scoped by `record_type`**: contract + documents + certificates readable by the subject; **`note` stays HR-only** | Reverses a deliberate v1 exclusion — §4. `note` holds performance and grievance context; exposing it would change what HR is willing to write down, destroying the field's value. |

### Proposed shape

```
(app)/me/
  page.tsx          my hub — what needs me, balances, next payslip, open requests
  leave/            request leave/sick, balances, history          ← mostly EXISTS, needs re-homing
  loans/            request, schedule, remaining balance           ← new (after payroll)
  documents/        contract, certificates, personal documents     ← needs the §4 reversal
  pay/              payslips, allowances, benefits                 ← new (payroll)
  performance/      KPI report, appraisals, check-ins, trainings   ← KPI/appraisals EXIST
  profile/          my details · request a correction              ← the client portal's pattern
  inbox/            notifications + messages                       ← notifications EXIST
```

---

## 4 · Ground truth (audited 2026-08-04 against code)

### 4.1 Half of it already exists, scattered across seven routes

`/` (My Work) · `/account` · `/people/[userId]` (self — profile, roles, KPIs, tasks, projects, time,
identity links, activity) · `/reports/person` · `/appraisals/mine` · `/timesheets` · `/notifications`,
plus `/hr/leave`, where **an employee can already file and cancel their own leave.**

### 4.2 The authorization model is already right

`lib/rbac.ts` states the principle: a member's own report, check-in and appraisal are **not
capabilities** but server-side `subjectUserId == principal.id` checks — *"nothing about you that you
cannot read"*. `resource_hr_case.yaml` already carries a `member` self-service rule for
`read`/`create`/`cancel`, guarded with `has()` so it **fails closed** if a handler omits the subject.
Leave, sick leave and cases therefore need **no new authorization work** — only a home.

### 4.3 ⚠ Subject self-read of HR records is deliberately OFF

`resource_hr_record.yaml`: *"subject self-read of records is OUT in v1 (no `member` rule here —
deliberately)"*, repeated at the call site in `hr.controller.ts`. **An employee cannot read their own
employment contract today.** Decision 4 reverses it, scoped by `record_type`.

Second surprise in the same policy: **`group_executive` is explicitly denied** on `hr_record` — the
holding-level owner cannot read raw per-subject contracts either (rollups only). Anyone assuming "the
owner sees everything" will be wrong.

### 4.4 ⚠ Four capabilities have no representation at all

Greps for `loan|payroll|payslip|salary|training|certification|benefit|allowance|reimburse` across
`platform-nest` return only unrelated hits. Nothing exists for **loans**, **payroll/payslips**,
**trainings**, or **benefits/allowances**. And there is **no mailer in the platform** — no nodemailer,
no SMTP send path. In-app `notifications` work; outbound email does not. (The client portal has the same
gap — a client is not emailed when a contract awaits signature — so a mailer is **shared
infrastructure for two programs**, and the `mail` module is already registered at `0.0.0`.)

### 4.5 What HR does have (0028)

`hr_cases` · `hr_records` (contract|document|note + `file_id`) · `hr_leave_requests` · `hr_leave_balances`
· `hr_attendance` · `hr_checklist_templates`.

⚠ All six sit behind the **module third wall** — `tenant_id = ANY(app_current_tenants()) AND
app_module_allowed('hr')`. Any handler touching them must declare `{ modules: ["hr"] }` on
`withTenants(...)` or it reads and writes **zero rows** with a correct tenant set. Fail-closed by
construction, and invisible when forgotten. **The `/me` surface reads HR tables, so every `/me` handler
that touches them inherits this.** (Only `hr`, `reports` and `search` gate tables this way — `pm_*`,
`deliverables`, `invoices` and `contracts` do not.)

---

## 5 · Sequencing

**Wave A — the `/me` shell + re-homing.** Build `(app)/me/*`, move the seven scattered surfaces under it
(old routes become redirects), and give `/me/leave` a first-class request flow on the already-correct
`member` authorization. **Delivers most of the personal hub with no new subsystem and no new sensitive
data.** Do this first regardless of what happens to payroll.

**Wave B — documents (the §4.3 reversal).** `record_type`-scoped `member` self-read, plus `certificate`
as a record type, on the existing `files` download path. Delivers "my contract" and "my certificates".

**Wave C — trainings.** `record_type='training'` — a viewable record of a completed training with an
optional certificate file. **Not an LMS.** If enrolment, curricula or scheduling are ever wanted, that is
a separate subsystem and must be named as one rather than grown out of a record type.

**Wave D — payroll.** See §6. **Wave E — loans** (after D). **Wave F — mail**, as shared infrastructure.

---

## 6 · Payroll — architecture now, values later

Decision 2 was taken with the concern stated and reaffirmed. Safe to commit to now:

- **statutory rates as versioned DATA**, keyed `(kind, effective_from, effective_to)`, resolved by the
  payslip's **period** and never by `now()` — a payslip issued last March must still compute to the same
  number next year;
- the engine as **pluggable pure components** (earnings → allowances → statutory deductions → tax), each
  unit-testable against known-answer fixtures;
- **payslips frozen on issue**, the pattern `invoices.lines` already uses, so a later rate correction
  cannot silently rewrite history;
- **salary structures versioned per employee**, so a mid-year raise cannot retroactively change prior
  payslips.

**Required before implementation — inputs, not opinions:** pay cycle + cut-off + pro-rating for
mid-month joiners/leavers · the statutory rate set in force with effective dates for PPh21 (TER
category), BPJS Kesehatan, and BPJS JHT/JP/JKK/JKM, **supplied and reviewed by someone accountable for
them — a model's recollection of a tax table is not a source** · where PTKP status and NPWP live (no
columns exist; both are personal data with a retention story) · THR/bonus/overtime in or out · who may
run payroll and who may see a salary (`company_admin` is too wide, and `group_executive` is denied even
on `hr_record` — so **no role expresses "payroll officer" yet**) · whether payroll data may share this
database.

Payroll deserves its own design document, review by whoever owns payroll compliance, and a corpus of
known-answer payslips **before** implementation. Waves A–C are unblocked today; run those while this is
answered.

---

## 7 · Non-goals for the first pass

No LMS · no expense reimbursement (adjacent enough to be assumed by accident) · no recruitment/ATS ·
**no employee-editable HR records** (the subject reads and *requests*; a record the subject can rewrite
is not a record) · no mailer until "mail" is defined, and then as shared infrastructure.

---

## 8 · Cross-references

- HR department scope: [`hr-department-foundation.md`](./hr-department-foundation.md)
- The pattern: `../plans/2026-08-04-client-portal-deployment.md` + §16 of `../FRONTEND-BFF-CONTRACT.md`
- Reports/appraisals (the existing KPI half): [`tracker-reporting-foundation.md`](./tracker-reporting-foundation.md)
- HR module tickets: `../superpowers/plans/` (WSD-2 / WSD-4 / WSD-5)
