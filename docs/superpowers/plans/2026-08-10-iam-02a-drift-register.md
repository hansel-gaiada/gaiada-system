# IAM-02a — Cerbos ↔ `rbac.ts` drift register

**Status:** ANALYSIS ONLY — 2026-08-10. No code, policy, or migration touched. Nothing in this
document has been fixed; every row is a finding for the owner/bundling ticket to act on.
**Parent:** `2026-08-10-iam-phase1-tickets.md` (IAM-02a), `2026-08-10-iam-01a-02a-analysis.md`.
**Method:** parsed every `cerbos/policies/resource_*.yaml` + `derived_roles.yaml`
(platform-nest, 61 kinds, 230 concrete `(kind, action)` pairs), expanded `*` wildcards against
each kind's own action universe, skipped `EFFECT_DENY` rules, resolved `module_staff` /
`module_manager` / `module_approver` string-composition against the module attribute each
resource kind is actually authorized with in source (grepped, not assumed — see §0), and
diffed the result against `platform-ui/src/lib/rbac.ts`'s `ROLE_CAPS`. Where a capability's
UI call sites needed checking (e.g. an `OR` with a second capability that could rescue an
apparent gap), the actual `platform-ui/src/**` consumer was read, not just `rbac.ts`'s own
comment — this caught and discarded two false positives (§3).

Live role-holder counts are from `2026-08-10-iam-phase1-tickets.md` §6 (IAM-02a-0, run against
`gda-aicenter` 2026-08-10) and are **not re-verified in this pass** (no DB access was used for
this ticket; the local stack is off and this analysis needed none).

---

## 0. Baseline — confirming the already-known numbers

Independently re-derived from source, these match `2026-08-10-iam-01a-02a-analysis.md` exactly:

| Role | Pairs (of 230) | Kinds (of 61) | Matches prior doc? |
|---|---|---|---|
| `platform_admin` | 215 | 57 | ✅ exact match |
| `company_admin` | 199 | 55 | ✅ exact match |
| `group_executive` | 118 | 35 | ✅ exact match |
| `manager` | 109 | 41 | ✅ exact match |
| `member` | 74 | 34 | ✅ exact match |
| `team_lead` | 60 | 23 | ✅ exact match |
| `viewer` | 30 | 25 | ✅ exact match |
| `client` | 6 | 1 | ✅ exact match |

**`company_admin` (199) is confirmed materially stronger than `group_executive` (118)** —
re-verified directly from `resource_project.yaml` (line 11: `derivedRoles: ["platform_admin"]`
only on the wildcard rule) and 33 other kinds. **`viewer` holding 30 pairs including
`pm_task:update`** is confirmed (`resource_pm_task.yaml` line 15 lists `viewer` alongside
`member`/`team_lead`/`manager`/`company_admin` on `["read","update"]`).

One correction to the method, not the conclusion: `resource_automation_approval.yaml`'s
`module_manager` rule hardcodes `request.resource.attr.module == "hr"` **in the rule condition
itself** (not just via the derived role's own module match), so it resolves to `hr_manager`
only — never `search_manager`/`reports_manager`. A first parser pass over-attributed `decide`/
`read` on `automation_approval` to `search_manager` and `reports_manager`; corrected before any
number below was drawn from it.

**Six roles are ungrantable today** (no row in the `roles` table, confirmed live 2026-08-10 per
IAM-02a-0): `team_lead`, `viewer`, `it_manager`, `it`, `search_staff`, `search_manager`. Every
finding below that touches one of these is marked **THEORETICAL (ungrantable)**. `hr_staff` /
`hr_manager` / `reports_staff` / `reports_manager` **do** have seeded role rows but zero live
holders — marked **THEORETICAL (0 holders, seeded)**, a materially different (less permanent)
caveat than "ungrantable."

---

## 1. Register — UNDER-CLAIMS first (Cerbos allows it, the UI hides it — the dangerous direction)

### 1.1 `agency_approver` — a LIVE-HELD role entirely absent from `rbac.ts`'s `Role` union

**Severity: HIGH. Live-reachable: YES (1 real holder, IAM-02a-0's live query).**

`resource_agency_approval.yaml` grants `approve` to `derivedRoles: ["company_admin",
"module_approver"]`, and `derived_roles.yaml`'s `module_approver` string-composes
`"<module>_approver"` — so a `agency_approver` grant is a real, working Cerbos role, and the
live IAM-02a-0 query found exactly one account holding it. **`rbac.ts`'s `Role` type has no
`agency_approver` member and `ROLE_CAPS` has no entry for it.** `can(me, cap, companyId)`
resolves `ROLE_CAPS[g.role as Role]` to `undefined` for this account, and `!!caps && …` makes
every single `can()` call return `false` — this user has **zero** capabilities anywhere in the
UI, including the one thing Cerbos actually lets them do (approve an agency creative/campaign
change). Not a partial mismatch: a live human account is capability-invisible, full stop, in
every gated surface. Same defect shape as the already-fixed Gap-1/Gap-2/Gap-3 bugs `rbac.ts`'s
own header documents, just not yet found by that sweep.

**Recommendation:** add `agency_approver` to `Role` and `ROLE_CAPS` (minimally: whatever
capability gates the agency-approval "Approve" UI action) as its own ticket. This is exactly
the class of fix D-1/IAM-05b's codegen is meant to make structurally impossible going forward.

### 1.2 `hr_staff` genuinely holds case/record WRITE authority the UI models as read-only

**Severity: HIGH (design-intent mismatch). Live-reachable: THEORETICAL (0 holders, seeded).**

`rbac.ts`'s own header (lines 229-236) states the intended split: *"`hr_staff` is the BASELINE
read tier and `hr_manager` the ACTING tier... this mirror matches [Cerbos]."* It does not.
`resource_hr_case.yaml` (lines 24-28) and `resource_hr_record.yaml` (lines 21-25) both grant
`["read", "create", "update"]` to `module_staff` (→ `hr_staff`) — only `delete`/`export` are
`module_manager`-only. So Cerbos's real `hr_staff` tier can **create and update** HR cases and
records on someone else's behalf (subject to the served-company scope), not just read them.

The UI enforces the *intended* read-only split at the server-action layer, ahead of Cerbos:
`platform-ui/src/lib/hrActions.ts`'s `instantiateOnboarding`, `createCase` (for someone else),
and `createChecklistTemplate` all gate on `hr.manage`, which `hr_staff` does not hold — so the
UI refuses an action Cerbos would actually authorize. This is an under-claim in effect (Cerbos
says yes, the UI's own action layer says no before the request ever reaches Cerbos), but the
mechanism is different from the others in this register: it is a **UI action gate**, not a
missing capability grant, so fixing `ROLE_CAPS` alone would not change the refusal — the
`hrActions.ts` gates would need `hr.manage` split or replaced with something `hr_staff` holds.
Flagged here because the root disagreement is real: `hr.view`/`hr.manage` as modeled does not
match Cerbos's actual `module_staff`/`module_manager` split for this resource pair, and TR-25's
own split rationale (baseline reader vs. acting tier) was calibrated against *appraisal* and
*check-in*, not re-verified against `hr_case`/`hr_record`.

**Recommendation:** either (a) accept the UI is intentionally *narrower* than Cerbos here (a
product decision — "baseline HR staff shouldn't be filing cases for other people even though
Cerbos would allow it") and document it the way `resource_hr_record.yaml` documents the
`group_executive` exclusion in §1.4, or (b) split `hr.manage` so `hr_staff` gets the
create/update slice and `hr_manager` keeps delete/export/appraisal — an owner call, not mine.

### 1.3 `member` / `viewer` and the tenant directory (`people.directory`)

**Severity: MEDIUM (approximate signal — see caveat). Live-reachable: `member` YES (18 live
holders); `viewer` THEORETICAL (ungrantable).**

`resource_member.yaml`'s baseline rule (line 15) grants tenant-directory `read` to
`company_admin`, `manager`, `member`, `viewer`, and `team_lead` alike — "any in-tenant role may
read it," the file's own comment says. `rbac.ts` gates the `/hr/people` directory page on
`can(me, "people.directory", tenant) || isElevated(me)` (`app/(app)/hr/people/page.tsx:29`), and
`ROLE_CAPS` grants `people.directory` only to `company_admin`/`manager`/`team_lead` — **not**
`member` or `viewer`. 18 live `member`-only accounts cannot open `/hr/people`; Cerbos's only
signal for this capability says they could.

**Caveat, stated by `rbac.ts` itself** (lines 183-187): there is no Cerbos resource that
literally models "browse the staff directory" — `resource_member.yaml`'s picker-list read is
the *closest* signal, not a confirmed 1:1 mapping, and the same comment calls the team_lead
grant a "JUDGEMENT CALL." It is plausible `/hr/people` is deliberately a heavier page than the
bare owner/assignee-picker `resource_member.yaml` authorizes. Recorded as a real disagreement
against the best available signal, not a confirmed bug — an owner call on whether `/hr/people`
should open to any member.

### 1.4 `group_executive`'s `ALL` claim overrides THREE separately-documented, deliberate Cerbos narrowings

**Severity: MEDIUM (over-claim direction, but the Cerbos side is explicitly deliberate — worth
recording precisely rather than folding into the generic "ALL vs 118/230" finding).**
**Live-reachable: THEORETICAL — the sole `group_executive` holder is `exec@gaiada.test`, a
seed/test account (IAM-02a-0), not a real user.**

Three Cerbos policies **explicitly, in writing**, deny `group_executive` something `rbac.ts`'s
blanket `ALL` claims anyway:

- **`hr_record`** — `resource_hr_record.yaml` header: *"`group_executive` is intentionally
  DENIED here... `hr_record` holds raw per-subject rows... those stay sensitive even to the
  holding-level executive. `group_executive`'s cross-company visibility is served exclusively
  through rollups."* `group_executive` reaches `hr_case` fully but **zero** `hr_record` actions.
- **`checkin`** (`pending_reminders`/`missed_by_unit`) — `resource_checkin.yaml` header: *"`
  group_executive` is also excluded, deliberately... these two are ops POLLING surfaces and
  keeping them admin-only means a high-frequency automated poll never runs under a human
  oversight grant."*
- **`appraisal`** (`write`/`submit`/`cycle_admin`/`finalize`) — `resource_appraisal.yaml`
  header: *"Exec group: read-only... §8: 'exec read-only'."* `group_executive` reaches
  `appraisal:read` only.
- Also confirmed: `agency_approval:approve` (only `company_admin`/`module_approver` in
  `resource_agency_approval.yaml`), and (already known) `member` kind entirely (no
  `group_executive` rule in `resource_member.yaml` at all — reinforces §1.3).

This is the SAME root cause as the already-known `group_executive`-claims-`ALL` finding, but
these four are cases where the Cerbos author explicitly reasoned about the owner tier and chose
to exclude it — the UI's blanket claim silently overrides an intentional design decision, not
an accidental gap. Worth the owner seeing the specific list before D-7's replacement `owner`
role envelope is drafted (per the parent analysis doc's Part 2, consequence 2).

---

## 2. Register — OVER-CLAIMS (UI shows it, Cerbos refuses — safe-ish, still worth fixing)

### 2.1 `manager` and `approvals.decide` — a broad, previously undocumented full denial

**Severity: HIGH (breadth). Live-reachable: YES (11 live holders).**

`ROLE_CAPS.manager` includes `approvals.decide`, and `rbac.test.ts` (line 96) explicitly
pins `can(mgrA, "approvals.decide", "co-a") === true` as intended behavior. This capability
gates real, pure (no rescuing `OR`) checks across at least 8 call sites: the general approvals
inbox (`app/(app)/approvals/[id]/page.tsx`'s `mayDecide`), the pipeline gate console
(`pipeline/page.tsx`, `pipeline/[runId]/page.tsx`), and six actions in `lib/pipelineActions.ts`
(decide/open-gate/repair/artifact-edit/status-change/add-stage/start-run/scope-signoff-create).

Cross-checked directly against the backing policies:

- `resource_automation_approval.yaml` (lines 35-38): `decide`/`retry` → `company_admin`,
  `group_executive` only. `manager` is explicitly named as excluded in the file's own comment:
  *"A plain `manager` is deliberately excluded from both (they hold `read` above, so the inbox
  is visible but not actionable)."*
- `resource_agency_approval.yaml` (lines 20-23): `approve` → `company_admin`, `module_approver`
  only. `manager` gets `create`/`read`, never `approve`.
- `resource_pipeline_gate.yaml` (lines 27-30): `decide` → `company_admin`, `group_executive`
  only.

So a `manager` sees a "Decide"/"Approve"/"Reject" control on the general approvals inbox and
every pipeline-gate action, and it 403s every time — not a partial gap, a complete one, across
the three resource kinds these surfaces actually authorize against. (`scope_signoff` and the
webdev change-request/provisioned-site surfaces are **not** affected — `manager` genuinely
holds `create`/`read` on `scope_signoff` and full `triage`/`provision`/`reconcile` on the two
webdev kinds, so those specific `approvals.decide` call sites are correctly authorized.) Unlike
§2.2's `company.manage` widening, no comment in `rbac.ts` reasons about this specific gap —
it reads as an actual oversight, not a documented, accepted trade-off.

**Recommendation:** either narrow `manager`'s `approvals.decide` grant (breaks the pinned
`rbac.test.ts` assertion — needs an explicit owner call on whether that test encodes the
*intended* UX or just codifies the drift) or confirm Cerbos should be widened to let `manager`
decide automation/agency/pipeline-gate approvals (D-10's routing-table work already anticipates
"dept-head overrides route to company_admin/owner" for exactly this kind of decision, which
argues Cerbos, not the UI, is the one that's right).

### 2.2 `manager` and `company.manage` — CONFIRMED, already documented, accepted

**Severity: LOW (deliberate, owner-ratified per the existing comment). Live-reachable: YES.**

`rbac.ts` lines 154-166 already document this precisely and correctly: `manager` was given
`company.manage` specifically to surface the `integration_connection` "map another person's
seat" action (Cerbos genuinely grants `manager` full `integration_connection` CRUD — confirmed),
and the comment explicitly accepts that this also surfaces Billing/Company-edit/
automation-retry buttons that Cerbos still reserves for `company_admin` (`resource_company.yaml`
line 17-20 confirms `manager` gets `company:read` only, never `update`/`delete`). No new finding
— re-verified and confirmed accurate as written.

### 2.3 `it_admin` and `company.manage` — undocumented, full, live

**Severity: MEDIUM. Live-reachable: YES (1 live holder).**

`ROLE_CAPS.it_admin = ["it.manage", "company.manage"]`. Unlike `manager` (§2.2), `it_admin`'s
Cerbos reach is `device:["create","update","delete"]` **only** — zero presence anywhere in
`company`, `integration_connection`, `invoice`, or `automation_approval`. `company.manage`
gates Billing (`billing/*`), company edit (`companies/[companyId]/edit`), department
connections (`departments/[deptId]/connections/*`), and the automation-retry card — `it_admin`
sees all of these UI affordances and gets a 403 on every one. No comment anywhere in `rbac.ts`
discusses or intends this; it reads as a plain copy-paste from a template role bundle rather
than a considered grant.

**Recommendation:** drop `company.manage` from `it_admin`'s bundle unless there's an
undocumented reason IT admins need the Billing/Connections surface.

### 2.4 `company_admin` and `appraisal.read` — undocumented, full, live

**Severity: HIGH (surprising given `company_admin`'s otherwise near-universal reach). Live-
reachable: YES (9 live holders).**

`ROLE_CAPS.company_admin` includes `appraisal.read` (line 146, reasoned by analogy to the
report-grain exec-tier bundle). But **`resource_appraisal.yaml` has no `company_admin` rule at
all** — the file names exactly four tiers in its header (Self / Dept lead / Exec group /
HR-appraisal role) and none of them is "the tenant's own admin." Contrast with its two closest
siblings, `resource_report_period.yaml` and `resource_report_document.yaml`, which both
explicitly add a `company_admin` rule alongside `group_executive`'s ("the tenant's own admin...
bounded to its own company"). `resource_appraisal.yaml` does not follow that pattern, and
nothing in its header explains the omission the way it explains excluding `hr_people_reader`
(§1.2 of the parent analysis doc) or the served-dept tier. This reads as a genuine inconsistency
between three sibling reporting-program policies, not a considered exclusion — but it could
also be a deliberate "performance review contents are need-to-know even from the tenant admin"
stance that simply never got written down. Either way, every one of 9 live `company_admin`
accounts gets an `appraisal.read`-gated control that always 403s.

**Recommendation:** this is a genuine Cerbos-vs-Cerbos inconsistency question (appraisal vs. its
sibling report kinds) as much as a `rbac.ts` drift question — worth a senior-be/architect
decision on whether `resource_appraisal.yaml` should gain a `company_admin` rule (matching its
siblings) or whether the sibling policies are the odd ones out and `rbac.ts` should drop the
claim. Do not resolve by guessing which pattern is "correct."

---

## 3. False positives ruled out (recorded so they aren't re-discovered)

- **`hr_manager` + `approvals.decide`** — Cerbos grants `hr_manager` `decide` on
  `automation_approval` (module `hr` only). `rbac.ts`'s `ROLE_CAPS.hr_manager` does not list
  `approvals.decide` — but the one real call site that matters, `hrActions.ts`'s
  `decideHrLeave` (line 90), gates on `can(…,"approvals.decide",…) || can(…,"hr.manage",…)`, and
  `hr_manager` holds `hr.manage`. No live gap. (The *general* approvals inbox does not show
  `hr_manager` HR-origin items either, but `hr_manager` also lacks general `automation_approval:
  read` there — module-scoped `read` only fires for `module=="hr"`, and the dedicated `/hr/leave`
  page is the intended surface for exactly that reason.)
- **`member`/`hr_case:create`+`cancel`, `member`/`report_document:read_person`+`read_project`,
  `member`/`checkin:read`, `member`/`appraisal:read`** — all reached via an `owns`/
  `subjectUserId==principal.id` condition (self-service), not a role-wide grant. `rbac.ts`'s own
  header (lines 217-220) explicitly states self-service is deliberately NOT modeled as a
  capability ("nothing about you that you cannot read" — §11 principle 2). Correctly excluded;
  not drift.
- **`company_admin`/`hr_manager` "missing" `hr_case:cancel`** — an initial capability-backing
  guess treated `cancel` as part of `hr.manage`. It is not: `resource_hr_case.yaml` grants
  `cancel` only to `member` (self, "cancel own pending") and `group_executive`. Admins never get
  it because there is nothing for an admin to "cancel" — the self-service semantics don't apply
  to them. Not a capability at all; removed from consideration.
- **`search_manager` / `reports_manager` / `webdev_manager` / `agency_manager` on
  `automation_approval`** — an early parser pass attributed `decide`/`read` to all module-manager
  roles generically. The rule's condition hardcodes `module == "hr"`; only `hr_manager` can ever
  satisfy it. Corrected before this register was drawn (see §0).

---

## 4. Roles with a clean bill (checked, no drift found)

`pm.manage`/`pm.contribute` across `company_admin`/`manager`/`team_lead`/`member`/`viewer`;
`search.view`/`search.manage`/`search.scope.write`/`search.campaign.launch`/
`search.report.approve`/`search.ledger.admin` across `search_staff`/`search_manager`;
`reports.department.view`/`reports.project.view` across `reports_staff`/`reports_manager`;
`it.manage` across `it_admin`/`it_manager`/`it`; `org.edit`, `rollups.view`, `knowledge.review`,
`approvals.retry`, `reports.facts.admin`, `reports.period.seal`, `reports.ops.poll` wherever
claimed. All independently re-verified against the actual policy files, not assumed from prior
audits — `rbac.ts`'s existing TR-25/Gap-1/Gap-2/Gap-3 commentary holds up under direct
cross-check.

`team_lead`'s full capability sweep (documented in `rbac.ts` lines 170-212) also holds up
exactly as written — but is **THEORETICAL (ungrantable)**: 0 rows in `roles`, so it cannot be
exercised by any live account regardless of how correct the mirror is. Same caveat applies to
`it_manager`, `it`, `search_staff`, `search_manager` (all ungrantable, all clean).

---

## 5. Summary — ranked

| # | Finding | Direction | Severity | Reachability |
|---|---|---|---|---|
| 1 | `agency_approver` missing from `Role`/`ROLE_CAPS` entirely | under-claim | HIGH | **LIVE** (1 holder) |
| 2 | `hr_staff` real create/update case+record authority modeled as read-only | under-claim | HIGH | theoretical (0 holders, seeded) |
| 3 | `member`/`viewer` excluded from `people.directory` despite the closest Cerbos signal including them | under-claim | MEDIUM (approximate signal) | `member` **LIVE** (18 holders); `viewer` theoretical (ungrantable) |
| 4 | `group_executive`'s `ALL` overrides 3 written, deliberate Cerbos exclusions (`hr_record`, `checkin` ops-polls, `appraisal` write/cycle) + `agency_approval:approve` + `member` | over-claim | MEDIUM | theoretical (sole holder is a seed/test account) |
| 5 | `manager` + `approvals.decide` fully denied on automation/agency/pipeline-gate decisions, undocumented | over-claim | HIGH (breadth) | **LIVE** (11 holders) |
| 6 | `company_admin` + `appraisal.read` fully denied, no Cerbos rule exists for this role on this kind at all | over-claim | HIGH | **LIVE** (9 holders) |
| 7 | `it_admin` + `company.manage` fully denied, undocumented | over-claim | MEDIUM | **LIVE** (1 holder) |
| 8 | `manager` + `company.manage` partial denial | over-claim | LOW (already documented, owner-ratified) | **LIVE** (11 holders) |

Total distinct disagreements catalogued: **8** (plus the 4 already-known baseline confirmations
in §0, which are re-verified, not re-counted as new).

**Do not fix any of this inside IAM-02a.** Per the parent ticket's own risk table: "The
Cerbos↔`rbac.ts` disagreements found in IAM-02a turn out to be live access bugs, not drift...
Document each; do **not** fix silently inside this phase — a fix is a deliberate access change
and needs its own ticket and owner sight." Rows 1, 5, 6, and 7 in particular are live-reachable
today, independent of the IAM permission-catalog program, and worth pulling forward the same
way IAM-02d already pulled forward the ungrantable-roles fix.
