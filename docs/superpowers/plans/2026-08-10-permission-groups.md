# Permission groups — the authoring layer (IAM-01b-3)

**Status:** PROTOTYPED — 2026-08-10. Designed against the frozen 215-permission catalog
(`platform-nest/src/rbac/permission-catalog.json`) and the ~40 existing `platform-ui/src/lib/rbac.ts`
`CAPABILITIES`. Not wired into any UI or backend yet — this ticket is the design, not the build.
Pending the owner/HR review this doc calls for in §6 before role authoring is built against it.

**Machine-readable output:** `platform-nest/src/rbac/permission-groups.json` — same generation
script as this doc (`build-groups.mjs`, scratchpad-local), so the two cannot silently disagree as
of this date. A future drift test (parallel to IAM-07b) should assert they still agree.

**Parents:** `2026-08-10-identity-rbac-program.md` (D-1, D-9, D-10) ·
`2026-08-10-iam-01a-02a-analysis.md` (Ruling 1 — the two-layer model) ·
`2026-08-10-permission-catalog.md` (the 215 frozen permissions this ticket composes, never invents).

---

## 0. What this is and isn't

This ticket builds the **top half** of Ruling 1's two-layer model. The enforcement layer (215
Cerbos-mirrored permissions) is frozen input — I did not touch `permission-catalog.json`,
`rbac.ts`, any Cerbos policy, or any migration. What I designed is the **authoring layer**: named,
plain-language bundles an HR manager or department head composes a role from, with every one of
the 215 individually reachable underneath via an "advanced" expansion.

**Numbers, mechanically verified** (script output, not eyeballed):

| Fact | Count |
|---|---|
| Grantable permissions in the frozen catalog | 215 |
| Permission groups defined | **75** |
| Permissions reachable through ≥1 group | 213 |
| Permissions deliberately advanced-only (no group) | 2 |
| Permissions appearing in more than one group (intentional overlap) | 2 |
| Groups flagged `sensitive` (contain ≥1 catalog-sensitive permission) | 42 of 75 |
| Groups containing a `relationship`-class permission | **0** (checked against all 15; none appear) |
| Groups referencing a key not in the catalog | **0** (checked against all 215) |

The validation is mechanical, not asserted: `build-groups.mjs` loads the live catalog, checks every
group's permission list against the grantable-key set, checks none intersect the 15
relationship-class keys, and diffs the full 215 against everything referenced (groups +
advanced-only list) to prove nothing is silently missing.

---

## 1. Design principles applied

1. **Seed from `CAPABILITIES`, not from the catalog's shape.** Every one of the ~40 existing
   `platform-ui` capabilities has a direct descendant group below (mostly 1:1, some split — see
   §2's rationale notes). The owner explicitly chose to retain these as groups rather than
   discard them; nothing here reinvents that vocabulary.
2. **Name for the reader.** Every group name is what a department head would call the thing, not
   the Cerbos kind. "Client Records" not "core.client.*"; "Draft Client Contracts" not
   "core.contract.create+update".
3. **Split on "and also."** Wherever a single existing capability's one-line description needed an
   "and also" to stay honest (e.g. old `hr.manage` covered cases *and* records *and* templates), or
   wherever the catalog's own sensitivity flag draws a line inside one Cerbos kind (e.g.
   `client_contact.read` is not sensitive, `.create/.update/.revoke` are), I split into two groups.
   This is most of why there are 75 groups against ~40 capabilities: splitting for precision, not
   inventing new duties.
4. **Sensitivity is mechanical, not asserted.** A group's `sensitive` flag is computed as "does any
   member permission carry `sensitive: true` in the frozen catalog" — never hand-set. Where that
   produces a surprising result (§5), I say so rather than quietly overriding it.
5. **Splits that expose a dangerous combination are a feature, not friction.** Several splits
   below (contracts draft/send, pipeline sign/edit, service-assignment propose/approve, appraisal
   score/finalize, search draft/launch) exist *specifically* so the two halves can be granted to
   different people — see the register in §4. Bundling them back together for "convenience" would
   quietly re-introduce the separation-of-duties problem the split exists to expose.

---

## 2. The groups, by domain

Each entry: **name** — `key` — permission count (✱ = sensitive). Full permission lists and
descriptions live in `permission-groups.json`; only the ones needing a rationale note beyond their
one-line description get one here.

### Core — company & admin (9 groups)

- **Company Overview (read-only)** — `company_overview` — 5 perms. Baseline visibility: company
  profile, staff directory, user list, org chart, activity feed — all reads. Deliberately bundles
  `core.user.read` here too (not only in a user-admin group) so "browse the company" doesn't force
  granting anything sensitive.
- **Company Settings Administration** — `company_settings_admin` — 2 perms ✱ (update, delete)
- **User Account Administration** — `user_account_admin` — 3 perms ✱ (create/update/delete logins)
- **Edit Organization Chart** — `org_structure_edit` — 1 perm ✱. Standalone: editing the org chart
  drives automatic role/access reconciliation for everyone under the edited unit (D-3), so it is
  never bundled with anything else.
- **Custom Field Definitions** — `custom_fields` — 4 perms
- **View Compliance Gates** — `compliance_gates_view` — 1 perm
- **Flip Compliance Gates** — `compliance_gates_manage` — 1 perm ✱. Split from the view group: a
  legal/compliance toggle deserves its own grant, not a side effect of "can see gates."
- **Teams** — `teams` — 4 perms
- **Everyday Collaboration** — `everyday_collaboration` — 9 perms. Comment, file up/download,
  notifications, and self check-in submission. The baseline every staff member needs; none of its
  member permissions are catalog-sensitive. `reports.appraisal.ack` was deliberately **excluded**
  from this bundle even though it is also a self-service action — see the next group and §5's note
  on why.
- **Acknowledge Own Appraisal** — `appraisal_acknowledge` — 1 perm ✱. Split out of Everyday
  Collaboration specifically so that bundle stays non-sensitive. `reports.appraisal.ack` is
  catalog-flagged sensitive (blanket S1 HR-data rule over all `appraisal.*`), and folding it into
  the "give every employee" bundle would make that baseline bundle trip a sensitive-grant warning
  for a purely self-service action — worse UX than one extra tiny group.

### Core — clients & commercial (9 groups)

- **Client Records** — `client_records` — 3 perms (create/read/update)
- **Delete Client Records** — `client_records_delete` — 1 perm ✱. Split: deleting a client
  relationship is categorically bigger than editing one.
- **View Client Portal Contacts** — `client_portal_contacts_view` — 1 perm
- **Manage Client Portal Contacts** — `client_portal_contacts_manage` — 3 perms ✱
  (create/update/revoke portal-access identities)
- **Draft Client Contracts** — `client_contracts_draft` — 3 perms ✱ (create/read/update)
- **Send Contracts for Signature** — `client_contracts_send` — 1 perm ✱. Split deliberately from
  drafting — see dangerous combination DC-6.
- **Delete Client Contracts** — `client_contracts_delete` — 1 perm ✱
- **Client Deliverables** — `client_deliverables` — 4 perms
- **View Invoices** / **Manage Invoices** — `invoices_view` (1 ✱) / `invoices_manage` (3 ✱,
  create/update/delete)

### Core — projects, tasks, time (3 groups)

- **Projects** — `company_projects` — 4 perms. This is the **core** `project` kind — the original
  agency-era entity (clients/deliverables/time), not the PM console.
- **Tasks** — `company_tasks` — 4 perms. Same distinction: core `task`, not `pm_task`.
- **Time Tracking** — `time_tracking` — 4 perms

> ⚠ Naming trap for whoever builds the authoring UI: the catalog has **two** unrelated
> project/task pairs (`core.project`/`core.task` vs `pm.project`/`pm.task`). "Projects" and "Tasks"
> above are the core pair; the PM console pair is named "PM Console — …" below on purpose so the
> two never look interchangeable in a picker.

### PM console (2 groups)

- **PM Console — Contribute** — `pm_contribute` — 3 perms. Read + update + pass-the-ball. Mirrors
  the existing `pm.contribute` capability exactly ("anyone can pass the ball" — 2026-08-06 owner
  decision).
- **PM Console — Manage** — `pm_manage` — 4 perms. Create/delete/manage tasks, manage projects.
  Mirrors `pm.manage`.

### Delivery pipeline & meeting recordings (5 groups)

- **Advance Delivery Pipeline Runs** — `pipeline_advance` — 8 perms. Everyday working tier: start
  and progress a run, add stages, open gates, view scope sign-offs.
- **Edit Signed Pipeline Artifacts** — `pipeline_edit_signed_artifacts` — 1 perm
  (`core.pipeline_stage.update`)
- **Sign Client Scope** — `pipeline_sign_scope` — 1 perm (`core.scope_signoff.create`)

  These last two were **one group** in my first draft (mirroring the old `pipeline.manage`
  capability, which bundled them). I split them on a second pass specifically because bundling
  them silently creates a separation-of-duties problem *inside a single group* — see DC-7. Neither
  member permission is catalog-flagged sensitive, which is itself worth a second look (§5).

- **Meeting Recordings** — `meeting_recordings` — 5 perms (create/ingest/sync/update/read)
- **Re-link Meeting Recordings** — `meeting_recordings_relink` — 1 perm ✱. Split out: relinking can
  move a recording into a *different* client's context — a mistake or malicious act with a real
  confidentiality consequence, unlike everyday recording management.

### Approvals — cross-domain (4 groups)

- **File Automation Approval Requests** — `approvals_file_automation` — 2 perms
- **File Agency Approval Requests** — `approvals_file_agency` — 2 perms
- **Decide Approvals** — `approvals_decide` — 3 perms ✱ (automation decide, agency approve,
  pipeline gate decide). Mirrors `approvals.decide` exactly, including its DR-1 correction (Cerbos
  denies plain `manager` on all three; this group is not held automatically by anyone below
  `company_admin`/`owner`/`module_approver` in the real bundles that will consume it).
- **Retry Failed Automation Actions** — `approvals_retry` — 1 perm ✱. Kept separate per the
  existing `approvals.retry` rationale: deciding does not include retrying.

### Cross-company / rollups / service assignments (4 groups)

- **Cross-Company Rollups** — `rollups` — 2 perms ✱
- **Propose Shared Service Assignments** — `service_assignments_propose` — 2 perms ✱
- **Approve Shared Service Assignments** — `service_assignments_approve` — 2 perms ✱
- **Administer Service Assignments** — `service_assignments_admin` — 6 perms ✱ (suspend/resume/
  revoke/relink/reconcile)

  Propose and Approve are split on purpose — this is the clearest self-dealing risk in the whole
  catalog (DC-1). `core.service_assignment.read` appears in all three groups deliberately: each
  duty needs to see what it's acting on.

### Integrations, identity, chat (5 groups)

- **View Integrations** / **Manage Integrations** — read (1) / create+update+delete (3 ✱)
- **Cross-Channel Identity Links** — `identity_links` — 3 perms ✱ (read/update/delete all flagged;
  unlike most core resources there is no non-sensitive subset to split out — even reading a
  WhatsApp↔platform-user mapping is impersonation-adjacent)
- **WhatsApp Group Messaging** — `chat_group_messaging` — 2 perms (pin, set subject)
- **WhatsApp Group Membership** — `chat_group_membership` — 3 perms ✱ (add/remove/promote)

### Agency (3 groups)

- **Campaign Briefs**, **Marketing Campaigns**, **Creative Assets** — 4 perms each, no split
  needed (no sensitive/non-sensitive mix within any of the three resources).

### HR (4 groups)

- **View HR Cases & Records** — `hr_view` — 2 perms ✱
- **Manage HR Cases** — `hr_cases_manage` — 4 perms ✱ (create/update/cancel/delete)
- **Manage HR Records** — `hr_records_manage` — 3 perms ✱ (create/update/delete)
- **Export HR Data** — `hr_export` — 2 perms ✱. Kept separate per the catalog's own note: bulk
  export requires high assurance and is a distinct exfiltration-risk tier from ordinary CRUD.

  Cases and records are split into two groups rather than one "HR Operations" bundle (which is what
  the old `hr.manage` capability was) because they are different Cerbos kinds covering different
  material — case *workflows* (leave, loans, grievances) versus record *documents* (contracts,
  notes) — and a company may reasonably want a coordinator who handles case workflow without
  touching the document archive, or vice versa.

### IT (2 groups)

- **View IT Devices** / **Manage IT Devices** — read (1) / create+update+delete (3). Neither
  flagged sensitive — matches the catalog's own borderline call that all `it.device.*` resolved
  not-sensitive.

### Knowledge (2 groups)

- **View Knowledge Sources** — 1 perm. **Review Knowledge Sources** — 1 perm ✱. Review controls
  what enters the org-wide RAG — kept apart from plain viewing.

### Search / SEM (6 groups)

- **View Search & SEM Data** — `search_view` — 7 perms (all reads incl. the cost ledger)
- **Draft Search & SEM Work** — `search_manage_drafts` — 21 perms. The single largest group by
  permission count — deliberately: every create/update/delete/propose/research/run action across
  audits, campaigns, engagements, keywords, and properties is genuinely one duty ("do SEO/SEM
  working-level work") and none of it touches anything live. Splitting it further would violate
  principle 3 (only split when the description needs an "and also"; this one doesn't).
- **Set Engagement Scope & Budget Cap** — `search_scope_and_budget` — 1 perm
- **Launch Live Ad Campaigns** — `search_launch_live_campaigns` — 4 perms ✱. Real client ad spend.
  Split from drafting — DC-8.
- **Approve & Deliver SEM Reports** — `search_report_approve` — 2 perms ✱. Split from drafting —
  DC-9.
- **Override Ad Spend Stop-Loss** — `search_ledger_admin` — 1 perm ✱. Rare, audited, standalone.

### Reports / check-ins / appraisals (9 groups)

- **Executive Reporting** — `exec_reporting` — 6 perms ✱ (company-grain read, period view/pin/seal/
  amend, facts recompute). The tenant's own administrator tier — mirrors `company_admin`'s existing
  bundle of `EXEC_ONLY_REPORTS` + `reports.ops.poll`'s sibling reads.
- **Team & Project Reports** — `team_project_reports` — 3 perms ✱. What a department head needs for
  their own unit — mirrors `REPORT_READS` exactly.
- **View Check-ins** / **Manage Check-ins** — `checkins_view` (1 ✱) / `checkins_manage` (1 ✱,
  excuse). Split mirrors the existing `hr_staff`/`hr_manager` distinction precisely.
- **Check-in Reminders & Compliance Feed** — `checkin_ops_automation` — 2 perms ✱. Named and
  described as what it is: the n8n reminder/escalation read pair, "not a human console" per the
  existing capability's own comment.
- **View Appraisals** — `appraisals_view` — 1 perm ✱
- **Score Appraisals** — `appraisals_score` — 2 perms ✱ (write, submit)
- **Administer Appraisal Cycles** — `appraisals_cycle_admin` — 3 perms ✱ (cycle_admin, finalize,
  confirm_evidence). Split from Score Appraisals — DC-5. `confirm_evidence` was placed here rather
  than in a self-service bundle: its description ("confirm the evidence pack attached to an
  appraisal") reads as a review-chain gate parallel to finalize, not a subject action like `ack`.

### Web Dev (3 groups)

- **File Website Change Requests** — `webdev_file_change_requests` — 2 perms
- **Triage Website Change Requests** — `webdev_triage_change_requests` — 2 perms. Split from
  filing: the person who files a request (often a PM or the client) and the person who
  triages/routes it (Web Dev) are usually different people.
- **Website Provisioning** — `webdev_provisioning` — 3 perms ✱ (provision real infra + reconcile +
  read)

### Client portal (4 groups — for composing `client`-tier roles)

- **Client Portal — Basic Access** — `portal_basic_access` — 3 perms (read, request change,
  update own profile)
- **Client Portal — Sign Documents** — `portal_sign` — 1 perm ✱
- **Client Portal — Pay Invoices** — `portal_pay` — 1 perm ✱
- **Client Portal — Decide Gates** — `portal_decide` — 1 perm ✱

  Split into four instead of one "portal power user" bundle so a company can give a client contact
  read/file access without also handing them payment or contract-signing authority — these are
  three independently meaningful trust decisions about an external person.

---

## 3. Coverage — grouped vs advanced-only

**213 of 215** grantable permissions are reachable through at least one named group. **2** are
deliberately advanced-only:

| Permission | Why advanced-only, not grouped |
|---|---|
| `core.work_activity.create` | Machine/automation tracker-event ingestion (bot/agent writes feeding the tracker/reporting pipeline). Not a duty a human role is composed for — bundling it into a human-facing group would put a technical write action next to "comment" and "upload a file" with no shared mental model. |
| `core.work_activity.read` | Raw tracker event stream — a support/debugging read. The human-facing equivalent, `core.activity.read` (the tenant activity feed), is already in **Company Overview**; this is the underlying machine feed, not the feed a manager reads. |

Both remain individually grantable through the advanced expansion — nothing is unreachable, they
are simply not worth a named bundle. No other permission needed this treatment: everything else in
the catalog maps to a duty a non-engineer can name.

**Zero** groups contain a `relationship`-class permission (mechanically checked against all 15).
**Zero** groups reference a key absent from the catalog (mechanically checked against all 215).

Two permissions deliberately appear in more than one group — not a bug, the two halves of a
composable tier both need the same read to be self-sufficient:

- `core.service_assignment.read` — in Propose, Approve, and Administer Service Assignments (each
  needs to see what it's proposing/approving/administering).
- `webdev.change_request.read` — in both File and Triage (each needs to see the request it's
  filing/triaging).

---

## 4. Dangerous combinations register

The highest-value output of this ticket. Each entry names two groups that are each individually
reasonable but together create a separation-of-duties (SoD) gap — the pattern the ticket calls out
by name ("create a payment and approve it," "edit an appraisal and finalize the cycle"). These are
UI-layer **warnings** for whoever is composing a role, not blocks: some small companies will
legitimately need one person to hold both sides, and the authoring UI should say so rather than
forbid it (see §7 for how the warning surfaces).

| # | Groups | The gap | Real-world shape |
|---|---|---|---|
| **DC-1** | Propose Shared Service Assignments + Approve Shared Service Assignments | One person can propose a cross-company service assignment *and* accept it — unilaterally activating cross-company access with no second party involved. | The clearest maker/checker pair in the whole catalog: `propose` and `accept` are literally a two-step handshake that this combination collapses to one step. |
| **DC-2** | File Automation Approval Requests + Decide Approvals | Can file an automation/agent write request and then approve their own request. D14 makes this sharper than usual: approving **executes the action as the original filer**, so self-approval is also self-execution-by-proxy. | An agent-adjacent power user files a bulk write and rubber-stamps it themselves. |
| **DC-3** | File Agency Approval Requests + Decide Approvals | Same shape as DC-2 for agency campaign/creative approvals: files a brief for approval, then approves it. | A campaign lead who is also the sole approver on their own campaign. |
| **DC-4** | Manage HR Cases + Decide Approvals | HR cases include leave and loan requests (the historical `hr:leave:decide`/`hr:loan:decide` aliases route through `core.automation_approval.decide`). Holding both lets someone file a leave/loan case **and** decide it. | Someone files their own (or a favored colleague's) leave/loan request and approves it without a second signature. |
| **DC-5** | Score Appraisals + Administer Appraisal Cycles | The assigned manager who writes/submits an appraisal score can also finalize and seal the cycle that locks that score in — no independent check before the record becomes permanent. This is the exact "edit an appraisal and finalize the cycle" example the ticket names. | A manager scores their own report's appraisal, then immediately finalizes the cycle before HR reviews it. |
| **DC-6** | Draft Client Contracts + Send Contracts for Signature | One person drafts a client contract and sends it out for signature — the step that commits the agency commercially — with nobody else in the loop. | Any account lead alone drafting and dispatching a contract that legally binds the agency. |
| **DC-7** | Edit Signed Pipeline Artifacts + Sign Client Scope | Can sign a client's scope agreement **and** still edit the very pipeline-stage artifact that sign-off was supposed to freeze — defeats the point of the signature. | Scope is signed off Monday; the same person edits the deliverable artifact Wednesday with no re-sign-off. |
| **DC-8** | Draft Search & SEM Work + Launch Live Ad Campaigns | Drafts a SEM change proposal and executes it live on the ad platform, spending the client's real ad budget, with no independent reviewer between draft and launch. | A single SEM analyst proposes a bid change and launches it themselves the same afternoon. |
| **DC-9** | Draft Search & SEM Work + Approve & Deliver SEM Reports | Writes the engagement report and approves/delivers it to the client — no independent QA on client-facing numbers. | The analyst who wrote the report is also the only sign-off before the client sees it. |

**Register format for the JSON (not yet added — see §7's open item):** each row above is expressible
as `{ groupA, groupB, risk, example }`, ready to drop into `permission-groups.json` as a top-level
`dangerousCombinations` array once the authoring UI is being built. I left it out of this ticket's
JSON deliverable because the ticket asked for the register in the **doc**, and wiring it into the
machine-readable file is an implementation decision (exact warning copy, whether it's symmetric or
directional) that belongs with whoever builds IAM-19/20, not guessed here.

---

## 5. Sensitivity mechanics worth a second look

Not new catalog findings (the catalog's own §9 already schedules an owner/HR/finance sensitivity
pass) — but two places where the *mechanical* group-level sensitivity computation produces a result
worth flagging before that pass locks in:

1. **`reports.appraisal.ack` forced a split.** It is caught by the catalog's blanket "all
   `appraisal.*` are S1 HR data" rule, which is correct for `write`/`finalize`/`cycle_admin` but
   feels like overreach for "acknowledge your own already-finalized appraisal" — a pure self-service
   click with the server narrowing to the subject regardless of role. I split it into its own group
   (§2) rather than override the flag, so the baseline "give everyone" bundle stays clean. **Not a
   change to the catalog** — just a design choice built around its current shape. Worth a line in
   the owner's sensitivity pass: should self-ack really carry the same weight as writing a score?
2. **`pipeline_stage.update` and `scope_signoff.create` are NOT catalog-sensitive**, despite DC-7
   above describing a real commercial-commitment risk (signing scope, then editing the signed
   artifact). The old UI capability that bundled them (`pipeline.manage`) was already treated as
   "elevated-only" by role, just not by the sensitivity rubric. I did not add `sensitive: true` to
   either group — that would be relitigating the frozen catalog's own flags, not my call to make —
   but the DC-7 register entry exists precisely because the *group-composition* risk is real even
   though the *individual-permission* sensitivity flag says no. Flag for the catalog's owner/finance
   pass: should `core.scope_signoff.create` join the S2 (finance/commercial) rubric alongside
   `contract.send`, which it resembles closely?

---

## 6. Catalog gaps found (reported, not papered over)

Per the ticket's instruction: I did not invent permissions to plug these, and did not fake a split
that the catalog can't actually support. Two real gaps surfaced while designing the dangerous
combination register:

1. **No dedicated invoice-approval action.** `billing.invoice` has `create`/`read`/`update`/`delete`
   only — no `approve`. `update` covers "transition its status," which folds any approval-shaped
   workflow (e.g. marking an invoice approved-for-sending) into the same permission as ordinary
   editing. Unlike contracts (which at least separate `send` from `create`/`update`), invoices have
   no maker/checker seam at all in the current catalog — I could not build an "Invoices — Manage"
   vs "Invoices — Approve" split because there is only one write action to split from. If invoice
   approval becomes a real workflow need, it requires a new Cerbos action + catalog permission
   first (additive, post-freeze per the catalog's own amendment rule) — not something this ticket
   can express by rearranging existing keys.
2. **No standalone "approve HR case" action.** The leave/loan decide path is an *alias* through
   `core.automation_approval.decide` (per the catalog's §7 disposition table, `hr:leave:decide` and
   `hr:loan:decide` both map there), not a dedicated `hr.case.decide`. This is why DC-4 above has to
   be phrased as "Manage HR Cases + **Decide Approvals**" (a generic, catalog-wide decide group)
   rather than a narrower "Manage HR Cases + Approve HR Cases" pair — the finer permission the
   register would ideally warn against doesn't exist yet. Flagged, not invented.

---

## 7. Authoring UX sketch

Wireframe-level, no implementation. Three states: browse/compose, advanced expansion, and the
dangerous-combination warning.

### 7.1 Role composition — group view (the default)

```
┌─ New role: "Marketing Coordinator" ──────────────────────────── company: Northwind ─┐
│                                                                                       │
│  Search groups…                                          [ Show: All ▾ ]  [Advanced] │
│                                                                                       │
│  AGENCY                                                                              │
│   ☑ Campaign Briefs                    Create, view, edit, and delete campaign briefs│
│   ☑ Marketing Campaigns                Create, view, edit, and delete campaigns      │
│   ☐ Creative Assets                    Create, view, edit, and delete creative assets │
│   ☐ ⚠ File Agency Approval Requests    File and view agency approval requests        │
│                                                                                       │
│  SEARCH / SEM                                                                        │
│   ☑ View Search & SEM Data             See SEM properties/campaigns/reports (read)   │
│   ☐ ⚠ Draft Search & SEM Work          Create/edit SEM work — draft only, 21 perms   │
│   ☐ ⚠ Launch Live Ad Campaigns         Execute changes on the LIVE ad platform        │
│                                                                                       │
│  … (grouped by domain, collapsed sections for domains with nothing checked)          │
│                                                                                       │
│  ⚠ 1 dangerous combination detected — see below                                      │
│  [ Cancel ]                                                          [ Save role ]   │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

- Groups are listed by **domain**, checkbox per group, one-line description always visible (never
  a tooltip-only description — the ticket's whole point is that the description must be readable
  without extra clicks).
- A small **⚠** badge prefixes any group flagged `sensitive`, before the name — visible while
  scanning, not just on hover.
- Domain sections with zero permission-catalog-hits for the company's enabled modules collapse by
  default (e.g. a company with Web Dev disabled never sees the Web Dev section at all — this is a
  module-gating decision for the implementer, not new to this ticket).

### 7.2 Dangerous-combination warning — inline, not a blocking modal

Appears **the moment** a check would create a registered combination, directly under the
newly-checked group, and again in a summary strip at the bottom of the composer:

```
   ☑ ⚠ Draft Search & SEM Work            Create/edit SEM work — draft only
   ☑ ⚠ Launch Live Ad Campaigns            Execute changes on the LIVE ad platform

   ┌─────────────────────────────────────────────────────────────────────────┐
   │ ⚠ Separation-of-duties warning                                          │
   │ This role can draft a SEM change AND execute it live — with nobody      │
   │ else reviewing between draft and launch. Client ad spend is at risk.    │
   │                                                                         │
   │ Consider: keep these on two different roles, so a second person        │
   │ reviews before anything goes live.                                     │
   │                                                          [ Keep anyway ]│
   └─────────────────────────────────────────────────────────────────────────┘
```

- **Non-blocking.** "Keep anyway" dismisses it for this role; the combination is still recorded in
  the audit trail for the role (D-9's immutable-audit safeguard covers this for free — a role save
  that contains a registered dangerous combination is exactly the kind of elevated-adjacent event
  that safeguard already logs).
- **Per-pair, not per-permission.** If a role trips three registered combinations, three warnings
  stack, each naming its own two groups — never a single vague "this role looks risky" banner that
  makes the composer hunt for which checkbox caused it.
- Symmetric: checking either group first, then the other, produces the identical warning — order
  doesn't matter, only the resulting pair.

### 7.3 Advanced expansion — the escape hatch

Toggled per-group (a small "Advanced" link on the group row) or globally (the `[Advanced]` toggle
in the top bar), it replaces the group's single checkbox with its individual permissions, still
plain-language, still one line each:

```
  ▾ Draft Search & SEM Work  [Advanced — showing 21 individual permissions]
      ☑ Create SEO technical/content audits
      ☑ Edit SEO technical/content audits
      ☐ Trigger a technical/CWV/content audit run
      ☑ Create SEM campaigns (ads, ad groups, negatives)
      … 
      [ Collapse back to group view ]
```

- Individual permissions keep the catalog's own plain-language `description` field verbatim — no
  second copy to maintain.
- A role built partially from advanced picks still shows its parent group as **partially checked**
  (a dash, not a checkmark) in the collapsed view, so nobody loses track of what a role actually
  holds when they collapse the expansion back down.
- The 2 advanced-only permissions (`core.work_activity.{create,read}`, §3) appear **only** in this
  view, under a synthetic "Ungrouped / system" section at the bottom of the advanced picker — never
  in the group-view list at all, per their design rationale.

---

## 8. What I did not do (explicitly out of scope, per the ticket's constraints)

- Did not modify `permission-catalog.json`, `rbac.ts`, any Cerbos policy, any migration, or any
  module file.
- Did not invent any permission. Every group composes only existing catalog keys; the two gaps in
  §6 are reported, not worked around with a fabricated key.
- Did not wire the dangerous-combination register into the JSON (§4's closing note) — that's an
  implementation decision for whoever builds the authoring UI (IAM-19/20), not a data-shape
  decision this design ticket should pre-empt.
- Did not attempt to resolve the two open sensitivity questions in §5 — they are owner/HR/finance
  calls the catalog doc already schedules a pass for, and I flagged rather than guessed.
