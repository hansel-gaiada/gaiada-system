# HR department — expansion blueprint

**Status:** `IN PROGRESS` — §3's candidate list was BUILT on 2026-08-24 (HR-FULL, waves A–D), plus
five gaps this document did not name. Schema/RLS and the pure engines are DEV-VERIFIED; the handlers
and console are PROTOTYPED. Per-layer evidence: [`docs/modules/MODULES.md`](../modules/MODULES.md)
§hr. Surface: [`FRONTEND-BFF-CONTRACT.md`](../FRONTEND-BFF-CONTRACT.md) §10c. · **Scoped:** 2026-08-04
**Renamed + narrowed 2026-08-04:** this file was briefly
`hr-employee-self-service-foundation.md`, which framed the employee's personal hub as an HR feature.
**That framing was wrong** and the owner corrected it: employee self-service is a peer of the client
portal, not an HR sub-feature. It now lives in
[`employee-portal-foundation.md`](./employee-portal-foundation.md), and this document covers **HR the
department** only.

---

## 1 · The boundary

HR serves employees **up to the limit of HR's own need** — the same way a department console serves them
up to the limit of running projects. Neither is the employee's own view of themselves.

| This document owns | It does NOT own |
|---|---|
| The HR **operations console** (`/hr/*`) | The employee's personal hub (`/me/*`) → employee-portal blueprint |
| Employee records as HR's working data | The employee's *self-read* of those records → employee-portal §4.3 + decision 4 |
| The leave/case **approval queue** | Filing your own leave (already works, and is the employee's) |
| Onboarding/offboarding, cases, attendance, headcount | Payroll → employee-portal §6 (it is the employee's payslip, computed centrally) |

Payroll is a deliberate edge case: HR usually *operates* it, but the artefact is the employee's payslip
and the decision to compute it in-platform was taken as part of the personal hub. It is specified in the
employee-portal blueprint §6; when HR gets a payroll-operations surface, it belongs here and reads that
engine.

## 2 · What exists today (audited 2026-08-04 against code)

`/hr/*` is already a real HR console: home (headcount, department count, pending leave, open cases),
plus `leave`, `attendance`, `onboarding`, `cases`, `people`. Capability-gated on `hr.view` / `hr.manage`
via `lib/rbac.ts`, with `hr_staff` (read tier) and `hr_manager` (acting tier) mirrored from Cerbos's
`hr_people_reader` / `hr_people_ops` split.

⚠ **The `HR` nav entry is UNGATED** — `components/shell/nav.ts` lists it unconditionally in the
Departments group, so every staff member sees it and can open an operations console about their
colleagues. The sub-pages gate their *actions* on `hr.manage`, but the headcount, the department list,
the pending-leave count and the open-case count are visible to anyone. Worth an explicit decision:
either gate the nav entry on `hr.view`, or accept it and confirm the console's read surface is
genuinely fine for all staff. **Not fixed here** — it predates this scope and changing nav visibility is
a product call.

### Schema (0028, `module_hr`)

`hr_cases` (onboarding|offboarding|review|grievance|other + JSONB checklist) · `hr_records`
(contract|document|note + `file_id`) · `hr_leave_requests` (vacation|sick|unpaid|other, minutes as the
canonical unit, approval via `automation_approvals`) · `hr_leave_balances` (per subject/year/type) ·
`hr_attendance` (one row per subject/day) · `hr_checklist_templates`.

⚠ All six sit behind the **module third wall**: `tenant_id = ANY(app_current_tenants()) AND
app_module_allowed('hr')`. Every handler must pass `{ modules: ["hr"] }` to `withTenants(...)` or it
reads and writes **zero rows** with an otherwise-correct tenant set — fail-closed, and invisible when
forgotten.

## 3 · Candidate scope — DECIDED AND BUILT 2026-08-24 (HR-FULL)

The owner scoped all four waves on 2026-08-24, payroll included. What follows is the original
candidate list with what actually happened to each. **Read §3.1 first** — it records the five gaps
this list MISSED, which turned out to be the load-bearing ones.

| §3 candidate | Outcome |
|---|---|
| Recruitment / ATS | **BUILT** (wave B) — requisitions, a separate candidate pool, applications with an append-only funnel, interviews, scorecards, offers, and an explicit conversion into `employees` |
| Org & headcount planning | **PARTIAL** — requisitions link to a `positions` seat so headcount and the org chart cannot drift; a dedicated planning surface is still absent |
| Probation & review cycles | **BUILT** (wave A) as a CYCLE (cohort + window + completion), linking OUT to the reports program's appraisal rather than duplicating it — the overlap this document warned about was checked and honoured |
| Discipline & grievance | **BUILT** (wave A) — an append-only `hr_case_events` timeline with `hr_only` / `participants` visibility, because a grievance file whose history can be edited is not evidence of anything |
| Compliance & documents | **BUILT** (wave A) — `issued_on`/`expires_on`/`reference` on `hr_records` plus an idempotent reminder ledger |
| Payroll operations | **BUILT** (wave D) — see §3.2 on the sequencing override |
| HR analytics | **BUILT** (wave A) — derived from the lifecycle log, not from `employees`, because turnover is a question about a WINDOW and the employee row only knows the present |

### 3.1 · What this list MISSED, and why it mattered more

Audited 2026-08-24 against the standard HCM capability map. Five gaps existed that §3 did not name,
and four of them were silently producing wrong answers rather than merely being absent:

1. **Nothing computed a leave balance.** `hr_leave_balances.allocated_minutes` was a number somebody
   typed; nothing could restate how it was reached. → leave policies + an append-only accrual ledger.
2. **There was no holiday calendar.** A five-calendar-day request spanning a weekend was charged as
   five days. → calendars, weekend patterns, and *cuti bersama* as its own kind (not worked, but
   charged — two facts needing two counters).
3. **`employees` held CURRENT state only**, so every promotion, transfer and status change OVERWROTE
   the previous fact. Tenure, turnover and statutory severance were unanswerable from the database.
   → `hr_job_events`, an append-only effective-dated worker history with `employees` as its head.
4. **`hr_records` had no validity.** An expired work permit and a current one were byte-identical to
   every query. → expiry columns + a reminder ledger.
5. **Nothing modelled what anyone is paid.** → wave C.

### 3.2 · One sequencing override, recorded

§1 of this document and `employee-portal-foundation.md` §6 both place PAYROLL outside HR: the artefact
is the employee's payslip, and the engine was assigned to the employee-portal program, gated on
statutory facts. **The owner directed on 2026-08-24 that payroll be built as part of the HR
department.** That is honoured, and the gate it was protecting is honoured differently rather than
dropped: every regulated number lives in `hr_statutory_parameters`, effective-dated, carrying a
`ratified_by` signature that is NULL until sign-off; the engine hard-codes nothing; each run records
the parameter set it used; and finalizing against an unratified set requires an override with a
reason, written permanently to the run.

The seeded Indonesian figures are a TEST FIXTURE expressing the structure of PP 58/2023 (TER) and
PP 35/2021 (severance). **They are not legally verified.** Non-resident withholding (PPh 26) is not
implemented — the engine refuses rather than producing a plausible wrong figure.

### 3.3 · Still open after HR-FULL

- **LMS / learning — SCOPED (owner, 2026-08-24). Design now lives in its own blueprint:
  [`lms-foundation.md`](./lms-foundation.md).** It outgrew a bullet here: the owner scoped it for ALL
  eight departments and all levels (operational AND management), with a mandatory general track and
  an executable-lab tier for Web Dev. It is no longer an HR sub-feature.

  Original note, kept because the seams it names are still the right ones: The owner asked for a learning
  management surface inside HR: teach employees, and refresh existing staff with newer knowledge.
  **Deliberately sequenced LAST**, after the rest of the HR work is closed out — recorded here so it
  is a scheduled commitment rather than a remembered intention.

  Not designed yet, but three seams already exist and the design should start from them rather than
  from a blank page:

  1. **Certification expiry is already solved.** `hr_records` + `expires_on` + the reminder sweep
     (wave A) tracks a credential's validity today. An LMS should WRITE that record on completion,
     not invent a parallel expiry model — otherwise a certificate has two expiry dates.
  2. **Review cycles are the natural assignment trigger.** `hr_review_cycles` already models a
     cohort plus a window plus completion tracking. "Everyone in this cohort must complete this
     course by this date" is the same shape; check whether it can be reused before adding a second
     cohort engine.
  3. **The knowledge module already stores and retrieves content** (D9 RAG store). Course material
     is content; whether the LMS owns its own store or reads that one is the first real design
     decision, and it has an obvious wrong answer (two stores, two ingestion paths).

  Constraints it inherits unchanged: the module third wall (§4.1), the served-company split (§4.2),
  and — because completion records are performance-adjacent — a deliberate decision about whether
  they sit at the `hr_case` tier or the more sensitive `hr_record` tier. Note also §5's warning: the
  reports program owns appraisals, and "did they complete the training" must not quietly become a
  second performance-scoring surface.
- **Shifts, rosters and overtime rules** — payroll accepts an overtime INPUT, but nothing models a
  shift pattern or computes an overtime multiplier from one.
- **Headcount planning** as a surface of its own (see the table above).
- **Payroll bank-file export** — the register is exportable; a bank-format file is not.

---

## 3-original · The candidate list as written 2026-08-04

Preserved because §3.1 is only legible against it. **None of these was committed at the time**, and
each was to be checked against "does HR actually need this, or is it the employee's?":

- **Recruitment / ATS** — pipeline, candidates, interview scheduling. Entirely absent today.
- **Org & headcount planning** — positions vs filled seats, on top of the existing org structure and
  `org_unit_memberships`.
- **Probation & review cycles** — `hr_cases.kind='review'` exists as a container; there is no cycle
  engine. Note the reports program already owns appraisals — check the overlap before building.
- **Discipline & grievance** — `hr_cases.kind='grievance'` exists; no workflow.
- **Compliance & documents** — expiry tracking for contracts, permits, certifications (the same
  `hr_records` rows the employee portal will expose read-only).
- **Payroll operations** — the run, the approval, the bank file. Reads the engine specced in
  employee-portal §6; blocked on the same statutory facts.
- **HR analytics** — turnover, tenure, absence patterns. `report_work_facts` and `rollup_metrics` exist;
  this is a consumer, not new plumbing.

## 4 · Constraints any HR expansion inherits

1. **The module third wall** (§2) — the single most common way HR work silently does nothing.
2. **The served-company split.** HR grants are per-served-company via `service_assignments`; a
   materialized `(hr_staff|hr_manager, company, <served>)` grant lights up exactly one company's HR
   surface. Cross-company HR reads go through rollups, never raw rows.
3. **`hr_record` is the sensitive tier.** `group_executive` is explicitly denied; bulk `export` requires
   the D4 high-assurance tier. Do not widen either casually.
4. **Legal gate.** Do not ingest real employee personal data before the Gate-1 (legal) and day-one
   (technical) reviews are both green — `legal/` holds the DPIA/LIA drafts. **HR-FULL did not move
   this gate.** It defines WHERE that data will live (with per-column PD labels, matching 0109's
   owner decision of 2026-08-13 — label-only, no encryption or scrubbing this wave) and adds one new
   population the gate must now cover: `hr_candidates` holds OUTSIDER personal data under consent,
   with its own `retention_until` clock and an `erasure_requested_at` marker, which is a different
   legal basis from an employee under contract.
5. **Appraisals are already owned elsewhere** (the TR-* reports program, with its own roles and sealing
   rules). An HR review cycle must integrate with it, not duplicate it.

## 5 · Cross-references

- Employee's personal hub: [`employee-portal-foundation.md`](./employee-portal-foundation.md)
- Appraisals / reports: [`tracker-reporting-foundation.md`](./tracker-reporting-foundation.md)
- HR module tickets: `../superpowers/plans/` (WSD-2 / WSD-4 / WSD-5)
- Org/service scoping: `ORG-CORE` + migrations 0026/0027/0055
