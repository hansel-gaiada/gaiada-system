# HR department — expansion blueprint

**Status:** `PLANNED` — design only, no code written. · **Scoped:** 2026-08-04
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

## 3 · Candidate scope for the expansion (not yet decided)

Listed so the next planning pass starts from options rather than a blank page. **None of these is
committed**, and each should be checked against "does HR actually need this, or is it the employee's?":

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
   (technical) reviews are both green — `legal/` holds the DPIA/LIA drafts.
5. **Appraisals are already owned elsewhere** (the TR-* reports program, with its own roles and sealing
   rules). An HR review cycle must integrate with it, not duplicate it.

## 5 · Cross-references

- Employee's personal hub: [`employee-portal-foundation.md`](./employee-portal-foundation.md)
- Appraisals / reports: [`tracker-reporting-foundation.md`](./tracker-reporting-foundation.md)
- HR module tickets: `../superpowers/plans/` (WSD-2 / WSD-4 / WSD-5)
- Org/service scoping: `ORG-CORE` + migrations 0026/0027/0055
