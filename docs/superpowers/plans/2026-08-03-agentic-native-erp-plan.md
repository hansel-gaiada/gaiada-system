# Agentic-native ERP — readiness plan

Status: **OPEN**. Owner-approved 2026-08-03. **Close this document before staging.**

## Close-out measurement, 2026-10-26 (main e7af4f2d)

Measured read-only against `main` at `e7af4f2d`: source, tests, `docs/modules/CAPABILITY-INVENTORY.md`
and the permission contract. Nothing was run (no tests, no server), so every verdict below reads
code and test text, not a green run. Claims that could not be established from source are marked
«UNVERIFIED». The Status line stays **OPEN**: closing needs the owner's waivers (see "To close").

**Headline:** no exit-bar item is a plain PASS and none is untouched. All seven are PARTIAL.
The structural work the plan asked for has landed (D14 resume path, `users.kind`, the generated
inventory, `via` stamping, the reader-degrade guard). What is left is coverage: places where the
mechanism exists but its guard, its inventory or its stamp does not yet reach every capability.

### Exit-bar items

| # | Exit-bar item | Verdict | Evidence |
|---|---|---|---|
| 1 | Every department at the bar or waived | **PARTIAL** | See the department table. Reads and impact classes are broad; write tools are still missing for IT, Knowledge, Agency, Creatives, GM oversight and most of PM/HR. No waiver is recorded anywhere yet. |
| 2 | D14 resume path fixed; every write impact-classified | **PARTIAL** | Resume path present in code and tests: `core/approval-execute.ts` (685 lines), 31 `registerExecutableApproval` entries in `core/approval-executables.ts`, tests `approval-execute.test.ts`, `approval-executables.test.ts`, `d14-09-redelivery-storm.test.ts`, `d14-*-registry.test.ts`. The QA gate report `2026-08-05-d14-09-qa-gate-report.md` was bounded: the live Redis and transport legs were not driven. Impact: `modules/impact-registry.test.ts` fails the build on a write with no impact, but it registers 14 modules while `main.ts` registers 16 (finance and lms missing), and its count tripwire is a hard-coded `14`, not read from `main.ts`. The "medium/high write has an executor or a bar" invariant exists only for core tools (`core/core-tools.test.ts`). By string search, **28 medium/high module writes have neither** (list under ticket T1), so an approval of one re-drives nothing. `PERMISSION-CONTRACT.md` §27.3 records one of them (`webdesk.forms.define`) as an open follow-up. |
| 3 | `users.kind` shipped; no service account counted as a person | **PARTIAL** | Shipped: `migrations/202608201442_users_kind_discriminator.sql` (`employee\|client\|automation\|bot`, evidence-based backfill), `rbac/users-kind-discriminator.db.test.ts`, and `rbac/users-kind-readers.db.test.ts` (asserts BOTH directions, with the old membership predicate as a negative control). Readers repointed: `/members` in `core/core.controller.ts` and the admin directory (`admin/admin-identity.controller.ts`) filter `u.kind = 'employee'`. Not proven "anywhere": `admin/it-accounts.controller.ts:141` and `seed/portal-engagement.ts:367` still key on `company_memberships.kind`; HR headcount reads HR employee tables, not accounts «UNVERIFIED»; no static guard stops a new people reader using the wrong column. Both DB tests skip silently without `DATABASE_URL_TEST`, so they were not re-run here. |
| 4 | Refusal explicit; no reader folds a denial into `[]` | **PARTIAL** | Guard exists: `platform-ui/src/lib/readerDegrade.test.ts` (static sweep with allow-lists), shared `lib/readResult.ts` (`ok \| forbidden \| unavailable`), `components/systems/ReadRefusal.tsx` used in 86 non-test files. Remaining offenders: (a) `lib/portal-data.ts` `safe()` still folds 403 to `[]`/`null` on 17 portal readers, documented as deliberate ("teach, not refuse"); (b) `app/(app)/me/page.tsx` has its own bare-catch `safe()` over 4 reads (notifications, leave, balances, loans), outside the guard because the sweep only scans `src/lib`; (c) about 98 `.catch(() => [] / null)` lines in 87 files under `src/app` and components, also outside the sweep «UNVERIFIED how many are 403-reachable»; (d) `lib/people.ts` fallback chain (documented residual); (e) `lib/queue.ts` `settle()` is broad by design but now names failed sources. |
| 5 | Each department has at least one golden case | **PARTIAL** | The inventory derives endpoint-level golden cases: 16 owners, each with suites that call `app.inject` against its route family (agency 22, clients 26, hr 14, it 5, knowledge 3, pm 16, reports 24, search 30, social 13, webdev 37, invoice 16, core 79, finance 4). That derivation does not say whether a suite is DB-backed or mocked «UNVERIFIED». Agent-level evals are thin: `ai-agents/src/evals/` holds the generic `cases.ts` and `dept-pm.cases.ts` only. Playwright specs in `platform-ui/e2e/` cover client hub, billing, GM console, PM, social, reports. No golden case at all for Creatives, GM oversight or Operations (no owning capability). |
| 6 | Capability inventory exists (endpoint + tool + impact) | **PARTIAL** | Generated and drift-checked: `docs/modules/CAPABILITY-INVENTORY.md` from `platform-nest/src/modules/capability-inventory.test.ts` (`UPDATE_INVENTORY=1`). 279 capabilities, 16 owners, 147 writes (high 26, medium 41, low 80), plus a derived golden-case table. It covers `core-tools.ts` and 15 module `mcpTools`; it omits `lms` and the **hub-native tool groups** (about 71 tools counted by `name:` literals in `mcp-hub/src/`: `platform-tools`, `platform-write-tools`, `pm-tools`, `delivery-tools`, `pipeline-tools`, `agents-tools`, `work-activity-tools`, `webdesk-deploy-tools`, `tools.ts`). Those carry their impact in code and per-tool test pins, but are not in the table. |
| 7 | Agent attribution at least to the interim `via:` stamp | **PARTIAL** | Shipped: `Principal.via` and `actFor` (`rbac/principal.ts`), ambient stamping in `writeActivity` (`core/http.ts`, `core/request-context.ts`, `metadata.via`, caller's own `via` wins), `x-obo-agent` carried by `mcp-hub/src/obo-headers.ts`, delegation intersection tested in `core/act-for-delegation.db.test.ts`, approval-attribution columns in `migrations/202608261100_activity_approval_attribution.sql`, `agent_registry` (`202608221745`). Not stamped: `work_activity` rows (the bridge in `core/activity-bridge.ts` deliberately carries no metadata) and the PM assignment ledger (`pm_task_assignment_events`, migration 0087, no via column). Second structural finding: the impact gate **no longer** binds only `provider === "n8n"`. `mcp-hub/src/policy.ts` now keys on `isUnattended` (n8n OR `principal.agent`), proven in `mcp-hub/src/agent-impact-gate.test.ts`. Residual: `principal.agent` is a self-asserted header, so a direct MCP caller that sends no `x-obo-agent` and arrives under a human provider is still "attended" (`PERMISSION-CONTRACT.md` §15.3 states this). Step 2 (a real persona per department) is not built. |

### Namespaces the August baseline called missing

| Baseline said none | Now | Evidence |
|---|---|---|
| Billing / invoices | EXISTS | Core tools `invoices.draftFromSchedule/issue/voidIssued/issueReadiness/billableInstalments`, `invoicePayments.list/decide`, `billingProfile.read`, `contracts.*` (create/update/send/countersign), `freelancerBills`, 6 `finance.*` reads; `invoices.issue`, `voidIssued`, `invoicePayments.decide`, `contracts.countersign` are **high**. No mark-paid, send-invoice or chase tool. |
| Org structure / people / companies | EXISTS (partial) | 9 `iam.*` tools in `core/core-tools.ts` (`grantRole` high; `assignPosition`, `revokeRoleGrant`, `unassignPosition` medium, all with executors per `core-tools.test.ts`). `hr.hireEmployee` (medium) exists; the invite-to-login-to-placement chain as one capability is «UNVERIFIED». |
| Social media | EXISTS | `modules/social`: 39 capabilities, 24 writes (high 4, medium 4, low 16); `docs/modules/social-capability-inventory.md` covers refusal and `work_activity`, the one module with that deeper treatment. |
| Appraisals namespace | ABSENT BY RULING | `modules/reports/index.ts` header: every appraisal tool is deliberately not exposed (human-only performance surface), asserted by `index.test.ts`. Propose a recorded waiver. |

### Per-department table

"At the bar" is claimed only on criteria the repo can derive (1 tool parity, 4 impact, 7 golden).
Criteria 2 (typed contract), 3 (idempotent writes) and 6 (activity row) are not derived by any
generated artifact; they are «UNVERIFIED» estate-wide except for Social (its own inventory) and PM
(the 2026-08-08 audit). Counts are reads/writes from the inventory plus hub-native tools.

| Department | Position | Failing criterion and why | Proposal |
|---|---|---|---|
| SEO / search | At the bar on 1, 7; gap on 4 | 4: `search.publishContent` (high) and the paid `pull*`/`keywordResearch` (medium) have no executor or bar by string search «UNVERIFIED if barred by another path»; the three money tools are documented permanently barred. 30 golden suites. | T1 |
| Delivery pipeline (WS11) | At the bar on 1, 4, 7 | `pipeline.*` 11 tools; `deploy.staging/production` executors registered. | None |
| PM | Gap | 1: no milestone, dependency, board-move or poly-assignee tool (hub `pm.*` 10 tools, 6 low writes). Criteria 3 and 6 covered by the 2026-08-08 audit. | T11 |
| Clients | At the bar on 4, 7; gap on 1 | 1: no portal-invite tool (only `agency_intake.invite` for leads). | T16 |
| Deliverables | At the bar | `deliverables.get/list/create/update` (hub-native, not in inventory: see T3). | T3 |
| Time / timesheets | Gap | 1: `time.list/log/update`; no approval/lock tool. | T14 |
| HR | Gap | 1: 13 reads, 5 writes (`hireEmployee`, `transferEmployee`, `fileLeave`, `terminateEmployee`, `requestLoan`); no attendance, case or onboarding-checklist writes. 4: `hr.fileLeave` and `hr.requestLoan` have no registry executor (HR applies its own decision, by design per migration 0078 «UNVERIFIED that this is recorded as a bar»). | T10, T1 |
| Reports / appraisals | At the bar on reads; waiver proposed | 1: 4 reads plus check-in; no seal/recompute/cycle/appraisal tools, by standing human-only ruling. | Waive (recorded) |
| Knowledge | Gap | 1: `knowledge.listSources` plus hub `knowledge.search/graph`; no ingest or quarantine-decision tool. | T13 or waive |
| IT | Gap | 1: still one read tool (`it.listDevices`), zero writes. | T9 or waive |
| Agency | Gap | 1: `agency.*` 2 reads; intake (`agency_intake.*` 10, `agency_pipeline.*` 4, `agency_privacy.*` 3 high and barred) are at the bar; campaign and approval writes absent. | T12 or waive |
| Billing / invoicing (GM-owned) | Partial | 1: create/issue/void/payment-decide exist and are high; no send, mark-paid or chase tool. | T15 |
| Org structure / people | At the bar on 1, 4, 7 | See namespace table. | None |
| Compliance gates | Gap «UNVERIFIED» | Hub `compliance.gates` is a read; the plan's "gate decisions UI-only" was not re-measured. | Re-measure in T3 |
| Creatives | Waiver proposed | No module and no asset-lifecycle tool; only `image`/`vision`/`design` seams in `mcp-hub/src/tools.ts` and `delivery-tools.ts`. | Waive until a module exists |
| Social media | At the bar on 1, 7; gap on 4 | 4: `approvePostVariant`, `requestClientReview`, `deliverReport`, `provisionPublisherOrg`, `setEngagementScope` (medium/high) have no executor or bar by string search. | T1 |
| Web Dev | At the bar on 1, 7; gap on 4 | 4: `webdesk.content.preview`, `editorial.approve/seoSignoff/setPolicy`, `forms.define`, `media.uploadToken`, `webdev.refreshContract` have no executor or bar. | T1 |
| GM (commercial spine) | Gap | 1: no cross-department oversight view; the plan's option (a) (reports grains at GM scope) is not built. `e2e/gm-console.spec.ts` exists for the UI. | T17 |
| Operations (Sanur) | Waiver proposed | Scope still undefined; owns no capability. | Owner defines scope, or waive |

### Gap list (tickets)

Seat guidance follows the standing rule: Haiku for mechanical work, Sonnet for implementation,
Opus only for money or gate design. Estimates are hours of focused work, excluding review.

**Exit-bar tickets (needed to close items 2 to 7):**

| ID | Title | What and files | Hours | Seat |
|---|---|---|---|---|
| T1 | Executor-or-bar invariant for module tools | Extend the `core-tools.test.ts` invariant to every module `mcpTools` and `core-tools`, then classify the 28 uncovered medium/high writes as executor, bar or inline-by-design (`hr.fileLeave`, `hr.requestLoan`, `search.aiCrawlers.ingest`, `search.connectBing`, `search.deliverReport`, `search.keywordResearch`, `search.publishContent`, `search.pullAiVisibility`, `search.pullBacklinks`, `search.pullRanks`, `social.approvePostVariant`, `social.deliverReport`, `social.provisionPublisherOrg`, `social.requestClientReview`, `social.setEngagementScope`, `webdesk.content.preview`, `webdesk.editorial.approve`, `webdesk.editorial.seoSignoff`, `webdesk.editorial.setPolicy`, `webdesk.forms.define`, `webdesk.media.uploadToken`, `webdev.refreshContract`, plus the money and social publish tools, which the string search listed but which may be registered by constant). Files: `platform-nest/src/core/approval-executables.ts`, new `platform-nest/src/modules/executor-coverage.test.ts`, `platform-nest/cerbos/policies/resource_mcp_tool.yaml`. Money and publish tools stay barred. | 6 (classify + invariant); +2 per executor added | Sonnet |
| T2 | One module list for the impact and inventory tests | `impact-registry.test.ts` and `capability-inventory.test.ts` each hard-code a module list; read it from one shared export that `main.ts` also uses, so a new module cannot be skipped (finance and lms are missing today). | 1.5 | Haiku |
| T3 | Inventory covers the hub-native tools | Generate rows for about 71 hub-native tools (`mcp-hub/src/*-tools.ts`, `tools.ts`) and add a hub-side "every write has an impact" test. Re-measure `compliance.gates`. Files: `capability-inventory.test.ts`, `mcp-hub/src/*.ts`, `docs/modules/CAPABILITY-INVENTORY.md` (regenerated). | 6 | Sonnet |
| T4 | Reader-degrade guard reaches `src/app` | Extend `lib/readerDegrade.test.ts` to scan `src/app` and components; fix `app/(app)/me/page.tsx` `safe()` (4 reads) with `readResult` and `ReadRefusal`. | 3 | Sonnet |
| T5 | Sweep the `.catch(() => [] / null)` sites | Triage about 98 sites in 87 files; move every 403-reachable read to `readResult`/`ReadRefusal`; allow-list the rest with a reason. | 10 | Sonnet |
| T6 | Stamp `via` on `work_activity` and the assignment ledger | Add a nullable `via_agent` column to `pm_task_assignment_events` (append-only table, mind its trigger) and to the `work_activity` writer; read `currentVia()`; tests that an agent-driven write is distinguishable. Files: new migration, `modules/pm/pm.controller.ts`, `core/activity-bridge.ts`, `core/work-activity-*.ts`. | 8 | Sonnet, Opus review of the migration |
| T7 | Direct-MCP-agent gate | Make the hub fail closed for a caller that is neither an attended interactive session nor a registered seat (today only a self-asserted `x-obo-agent` marks a call unattended). Needs a design decision first (see "To close" item 4). Files: `mcp-hub/src/policy.ts`, `mcp-hub/src/principal.ts`, `agent-impact-gate.test.ts`, `resource_mcp_tool.yaml`. | 6 | Opus |
| T8 | Agent eval cases per department | One `dept-<x>.cases.ts` plus test in `ai-agents/src/evals/`, modelled on `dept-pm.cases.ts`, for HR, IT, SEO, Reports, Clients/Billing, Knowledge, Agency, Social, Web Dev (9 x about 1.5 h). | 14 | Sonnet |
| T18 | Static guard for people readers | A test that fails on a new people-shaped reader keyed on `company_memberships.kind` without `users.kind`; repoint `admin/it-accounts.controller.ts:141`. | 3 | Sonnet |

**Capability tickets (build, or waive; each ships its tool, its executor and a golden suite):**

| ID | Title | Files (start here) | Hours | Seat |
|---|---|---|---|---|
| T9 | IT write tools: device register/edit/delete, discovery trigger, alert acknowledge/resolve | `modules/it/index.ts` and the IT controllers | 10 | Sonnet |
| T10 | HR writes: attendance log, case open/transition, onboarding checklist | `modules/hr/index.ts`, `hr-employee-tools.test.ts` | 14 | Sonnet |
| T11 | PM milestone, dependency, board-move and poly-assignee tools | `mcp-hub/src/pm-tools.ts`, `modules/pm/index.ts` | 10 | Sonnet |
| T12 | Agency campaign and approval write tools | `modules/agency/index.ts` | 8 | Sonnet |
| T13 | Knowledge ingest trigger and quarantine decision tools | `modules/knowledge/index.ts` | 6 | Sonnet |
| T14 | Time approval and lock tool | `mcp-hub/src/platform-write-tools.ts` | 4 | Sonnet |
| T15 | Invoice send, mark-paid and chase tools (high, money) | `modules/invoice`, `core/core-tools.ts`, executors | 6 | Opus |
| T16 | Client portal invite tool (pairs with the Keycloak provisioner) | `core/core-tools.ts` | 4 | Sonnet |
| T17 | GM oversight view via reports grains at GM scope (plan option a) | `modules/reports`, `mcp-hub` | 8 | Sonnet |

**Totals:** exit-bar tickets T1 to T8 and T18: 57.5 hours (Sonnet about 41, Opus 6, Haiku 1.5, plus
Opus review of T6). Capability tickets T9 to T17: 70 hours, all waivable. Everything: 127.5 hours.

### To close

The plan can be closed when the owner has decided each of these and the exit-bar tickets are
DEV-VERIFIED (or each is waived with a reason recorded here):

1. **Department waivers (item 1).** Decide build or waive for each of: Creatives (no module),
   Operations (scope undefined; the owner must define it or waive), Reports/appraisals (human-only
   by standing ruling; record it as a waiver), and T9 to T17 (IT, HR writes, PM, Agency, Knowledge,
   Time, invoice send/chase, portal invite, GM oversight). Recorded waivers can sit in this document.
2. **Item 2 classification.** Confirm which of the 28 uncovered writes are barred (money, publish),
   which are inline-by-design (HR leave and loan decisions), and which need executors.
3. **Item 5 reading.** Accept endpoint-level golden cases (16 owners, derived) as the exit bar, or
   require agent-level eval cases per department (T8).
4. **Item 7 and the second structural finding.** Accept the interim `via` stamp as written (it is on
   `activities.metadata.via` today), or order T6 so `work_activity` and the assignment ledger carry
   it too. Separately, accept the residual that an undeclared direct MCP caller is "attended"
   (documented in `PERMISSION-CONTRACT.md` §15.3), or order T7. This is a staging gate by the
   owner's 2026-08-08 decision, so it needs an explicit yes or no.
5. **Item 4 exception.** Record the `lib/portal-data.ts` 403-to-teach-state behaviour as an owner
   waiver, or order its migration to `readResult`.
6. **Persona integration stays deferred** (late staging, optional), as decided on 2026-08-03; confirm
   that step 2 of attribution is not a close-out condition.

**Owner, 2026-10-27: deferred.** The owner deferred the waivers and the decisions above. None is recorded yet, so the plan stays
**OPEN** and the exit-bar tickets are not scheduled by this document. Ask again when the owner picks the plan back up.

## How to use this

This is a **late-dev checklist**, not a build ticket set for today. The ERP build continues on its
own track; this document says what "agentic-native" means, measures where each department stands
today, and states the goal per department so the work can be picked up incrementally and closed out
in one pass before staging.

**Read it when:** adding a department capability, wiring a new module surface, or preparing the
staging cut. **Close it when:** every department reaches its "Exit bar" below, or the gap is
explicitly waived by the owner with a reason recorded here.

Agent/persona INTEGRATION is deliberately **deferred and optional** (see "Deferred" at the end).
Nothing in the main plan depends on a persona existing — the point is that the ERP be *ready* for
one, which is a property of the ERP alone.

## The target: one capability, three operating modes

Every department capability must work identically whether driven by a human, by automation, or by an
agent — and at any mix in between:

| Mode | Driver | Must hold |
|---|---|---|
| **Full human** | ERP UI | works today with no agent, no n8n |
| **Assisted** | human + n8n for the scheduled/deterministic parts | same authz, same audit |
| **Agentic** | persona acting for a human | same authz, same audit, bounded by BOTH identities |

The failure mode to avoid: a capability that only exists as a UI interaction. A button whose logic
lives in a React handler is invisible to automation and to agents, and will have to be rebuilt.
**The UI must be one client of the capability, never its definition.**

## The readiness bar

Applies per capability, not per page. A department is ready when every capability it owns passes all
seven.

| # | Criterion | Why | Signal it fails |
|---|---|---|---|
| **1** | **Tool parity.** Everything the UI can do is reachable as an MCP tool with the same authorization. | Agents and n8n only reach the platform through the hub. | Namespace exists with reads but no writes, or no namespace at all. |
| **2** | **Deterministic contract.** Structured request + structured response. Refusals are typed, not prose. | An agent cannot consume free text reliably, and a human UI cannot render it consistently. | Endpoint returns a rendered string; errors only as message text. |
| **3** | **Idempotent writes.** Natural dedupe key or `ON CONFLICT`. | Agents and n8n retry, at-least-once. A retry must not double-create. | No unique constraint; "create" that always inserts. |
| **4** | **Impact-classified writes.** Low → direct; medium/high → D14 approval, and the approval must actually execute on decision. | The gate is what makes agentic writes safe to enable at all. | Write not registered with the impact gate. |
| **5** | **Explicit refusal.** Denials carry a structured reason (Cerbos already returns one). Never an empty list that reads as "no data". | The single worst agentic failure: a denied read presented as "nothing found". | 403/404 collapsed into `[]` by the reader. |
| **6** | **Observable.** Every state change writes `work_activity`/audit with actor + tenant, and the actor may be non-human. | Attribution is the only way to review what an agent did. | Write with no activity row, or actor assumed human. |
| **7** | **One golden case.** A fixture exercising the capability end-to-end, usable as an eval case later. | Without it, agent behaviour on this capability is untestable. | No test drives the real endpoint. |

Criteria **2, 5, 6** are also plain product-quality wins for the human-only ERP — they are worth
doing regardless of whether an agent ever arrives. **1, 3, 4, 7** are the specifically agentic ones.

## Measured baseline — 2026-08-03

MCP hub: **90 tools across 34 namespaces** (live count). BFF contract: **52 BUILT / 19 PENDING**.
Tool counts below are read/write per namespace, taken from the running hub.

| Department / module | Tools (r/w) | Reads as | Biggest gap |
|---|---|---|---|
| **SEO / search-marketing** | 3 / **14** | **Most agentic-native in the estate** | Vendor-cost tools exist; 5 UI tabs still PLANNED (SM-10/16/18/20/22) |
| **Delivery pipeline (WS11)** | 2 / 5 | Good write coverage | D14 resume path broken ⇒ gated writes dead-end |
| **PM (projects/tasks)** | `pm` 1/3, `projects` 2/1, `tasks` 2/2 | Usable | No milestone/dependency/board tools; poly-assignee not tool-exposed |
| **Clients** | 3 / 2 | Usable | No portal-invite tool |
| **Deliverables** | 2 / 2 | Usable | — |
| **Time / timesheets** | 1 / 2 | Usable | No approval/lock tool |
| **HR** | 2 / **1** | **Thin for a department meant to be agentic** | Leave/attendance/cases/onboarding not tool-reachable |
| **Reports / appraisals** | `reports` 4 / **0** | Read-only | No seal/recompute/cycle tools; **no `appraisals` namespace at all** |
| **Knowledge** | 3 / **0** | Read-only | No ingest/quarantine-decision tools |
| **IT** | **1 / 0** | **Barely reachable** | Device register/edit/discovery all UI-only |
| **Agency** | 2 / **0** | Read-only | Campaign/approval writes UI-only |
| **Billing / invoices** | **none** | **Not reachable at all** | No namespace |
| **Org structure / people / companies** | **none** | **Not reachable at all** | Onboarding, placement, role grants all UI-only |
| **Compliance gates** | 1 / 0 | Read-only | Gate decisions UI-only |
| **Creatives** | — (uses `image`/`vision`/`design` 1/0 each) | Generation seams only | Asset lifecycle not tool-reachable |
| **Social media** | none | Module `0.0.0` PLANNED | Whole module |
| **Web Dev** | `github` 1/1, `deploy` 0/2, `code` 1/0 | Real dev-loop coverage | Webdesk `0.0.0` PLANNED |
| **GM** | borrows `clients` 3/2, `projects` 2/1, `reports` 4/0; **`billing` none** | Owns the commercial spine | **Invoicing is not tool-reachable at all**; no cross-department aggregate tool |
| **Operations** (Sanur) | — | Console renders, owns no capabilities | Scope still undefined — see open question |

> **Dated note, 2026-10-26 (main e7af4f2d): this baseline is history, not the present.** Superseded
> since 2026-08-03: the D14 resume path exists (item 1 of cross-cutting); `users.kind` shipped
> (migration `202608201442`); `billing`-shaped tools (`invoices.*`, `invoicePayments.*`,
> `billingProfile`, `contracts.*`), the `iam.*` people/org tools and the whole `social` module now
> exist; HR has 5 write tools, IT/Knowledge/Agency are still read-only; `appraisals` is absent by
> ruling; the hub plus platform now expose about 350 capabilities (279 in the generated inventory
> plus about 71 hub-native), not 90. The "BFF 52 BUILT / 19 PENDING" figure and the per-row tool
> counts above were not re-measured. See "Close-out measurement, 2026-10-26" at the top.

## Goals per department

Each goal is "what must be true before staging". Ordered within each department by leverage.

### Cross-cutting — do these first, they unblock everything

> Dated note, 2026-10-26: items 1 and 2 below have landed in code (resume path; `users.kind`), items 3 to 6 are partly landed. Status per item is in "Close-out measurement, 2026-10-26" at the top; the text below is kept as written.

1. **Fix the D14 resume path.** Approving a suspended write currently executes **nothing**. Criterion 4
   is unsatisfiable estate-wide until this lands. This is the single highest-leverage item in the
   document.
2. **`users.kind` migration** (`employee | client | automation | bot`) — see
   `2026-08-03-principal-kinds-design.md`. Every people-shaped surface depends on it, and the interim
   `company_memberships.kind='service'` reuse should not survive to staging.
3. **Audit the reader-degrade pattern for criterion 5.** Several readers fold 403/404 into `[]`
   (found live: the client portal told staff "your kickoff is being processed"). Sweep every
   `safe()`/`skipMissing()` call site and make the refusal explicit.
4. **Structured refusal surface in the UI** — one component rendering a typed deny reason, reused
   wherever authorization can fail.
5. **Impact-classify every existing write** and register it with the gate, so criterion 4 is a
   property of the registry rather than per-endpoint memory.
6. **Agent attribution — the "co-author" model.** ⚠ **PRE-STAGING GATE. App-wide, not per-department.
   Owner decision 2026-08-08: deliberately NOT scoped into any department's ticket set — it is
   systemic, it ripples across every module at once, and it warrants its own version cut.**

   **The problem, found by the PM agentic audit (`2026-08-08-pm-agentic-native-audit.md`):** an agent
   acting for a human runs under *that human's* envelope, and the channel never survives into the
   platform. `Principal` (`platform-nest/src/rbac/principal.ts:23`) carries only
   `userId · assurance · companies · roles · sessionVersion` — there is **no field for a provider,
   channel or agent at all**, so this is not a dropped log line, it is information with nowhere to
   live. Every activity row, `work_activity` fact and append-only ledger entry therefore records
   **"Alice did X"** where the truth is **"Alice's agent did X"**, and the two are unrecoverable
   after the fact. It is the one guarantee the PM assignment ledger cannot make — about precisely the
   actor most worth auditing.

   **The model (owner's framing, and it settles the design):** git's `Co-Authored-By`.
   - **Author = the human.** Authority, permission, accountability. Cerbos still decides on the
     human; an agent can never do anything its principal could not.
   - **Co-author = the agent.** Mechanism, recorded *alongside* and never *instead*.

   That framing is what makes it safe to add: it is **additive and authorization-neutral**. No new
   rights are minted, so no policy needs re-reasoning — which is exactly why it can be deferred
   without accumulating risk, and exactly why it must not be half-done per-module.

   **Two steps, in order:**
   - *Interim* — carry `via: {provider, externalId}` on the principal and stamp it onto
     `writeActivity` metadata, `work_activity`, and the assignment ledger. Buys the audit trail with
     no identity model change.
   - *Full* — a real persona per department with its own `users` row, roles and lifecycle, so an
     agent is an actor that can be granted and revoked independently. Depends on item 2
     (`users.kind`). Today there are **zero** personas: six agent *specialists* exist
     (`ai-agents/src/specialists.ts`) but they are skills, not identities — none has a user row or
     anything Cerbos can authorize as itself. (Hermes has a `users` row purely to authenticate; it is
     the brain, not a persona.)

   **Why it earns a version cut:** it touches the principal type, the guard chain, every write that
   records an actor, the activity/rollup readers, and any surface that displays "who did this" —
   estate-wide, in one coordinated change, with a migration behind it.

   **Related:** pairs with the audit's second structural finding — the D14 impact gate binds only
   `provider === "n8n"` (`mcp-hub/src/policy.ts:47`, the impact branch sits INSIDE
   `isAutomation(principal.provider)`), so tier-based protection is unenforceable against a direct
   MCP agent. Both are the same root cause: **the platform cannot tell who is really calling.**

### HR
- Tool coverage for leave (file/decide), attendance (log), cases (open/transition), onboarding
  (instantiate/complete checklist item). Currently 1 write tool for the whole department.
- Employee onboarding as ONE capability: invite → Keycloak user (provisioner exists, verified) →
  membership → role → org placement → checklist. Today these are separate UI steps and the invite
  does not provision a login.
- Exclude service accounts from every people count (done as interim; revisit with `users.kind`).

### IT
- Device register / edit / delete / discovery-trigger as tools. Currently one read tool.
- Discovery run as an idempotent, re-drivable capability (it already exists in-app — expose it).
- Alert acknowledge / resolve as gated writes.

### SEO / search-marketing
- Closest to the bar already — hold the line: every new SM ticket ships its tool with its endpoint.
- Land the 5 PLANNED tabs (SM-10/16/18/20/22); they are labelled and contract-documented.
- Keep the paid-vendor rule intact: automation must never trigger a paid pull (SM-54/55 ruling).

### PM
- Milestones, dependencies, board moves, poly-assignee changes as tools.
- Recurring-task generation must be idempotent (it is scheduled — criterion 3 applies hardest here).

### Reports / appraisals
- Seal, recompute, and export as tools; `appraisals` namespace does not exist yet.
- Cycle open/generate/transition as tools.
- Fact history starts 2026-08-03 — reports cannot be meaningfully evaluated before ~2 weeks of facts
  accumulate. Plan the eval cases for late dev, not now.

### Clients / billing — **owned by GM**, see the GM section for why this is top priority
- `billing` namespace from scratch: invoice create/send/mark-paid, all impact-classified. Money moves
  here, so this is the clearest place the D14 gate has to work before any automation touches it.
- Client portal invite as a tool (pairs with W0-3's Keycloak provisioning, already built).

### Knowledge
- Ingest trigger and quarantine decision as tools (currently read-only).
- Sweep completeness must be verifiable — "0 errors" already proved insufficient once.

### Agency
- Campaign and approval writes as tools.

### Creatives
- Asset lifecycle (upload → variant → approve → publish) as tools. The generation seams
  (`image`/`vision`/`design`) exist; the lifecycle around them does not.

### Web Dev
- Best dev-loop coverage in the estate (`github`, `deploy`, `code`). Extend to the webdesk module
  when it leaves `0.0.0`.

### Social Media
- Module is `0.0.0` PLANNED, **being built in a separate session.** It is the last department that can
  be built TO this bar instead of retrofitted onto it — that option disappears the moment it ships,
  so hand this document to whoever builds it before they start.

### GM — the commercial spine (scope settled 2026-08-03)
Owns **clients, projects, invoices** and the general-manager duties around them; **oversees** the other
departments through aggregate views rather than owning their work. Two distinct halves, and they fail
differently:

- **Owned capabilities.** `clients` (3/2) and `projects` (2/1) have tools; **invoicing has no
  namespace at all.** GM is therefore the department most damaged by the missing `billing` tools —
  quote → invoice → send → chase → mark-paid is the one GM loop with zero automation surface, and
  it is the loop with money in it. Build `billing` to the bar first, not last.
- **Oversight views.** "Overview the departments" needs cross-department aggregation, and the only
  general cross-tenant/cross-unit reader in the estate is the HR envelope fan-out (`fanOutHr`) plus
  `reports` (4 read tools, 0 write). There is no generic aggregate tool. Decide deliberately whether
  GM oversight is: (a) `reports` grains pointed at the GM scope — cheapest, reuses the sealed-period
  machinery and gets honest partial-period warnings for free; or (b) a bespoke GM aggregate endpoint.
  **Prefer (a)** — a second aggregation path will drift from the first, and reports already solves
  time-awareness, which is the hard part.
- Approvals already fan in correctly across agency/pipeline/HR/automation/agent, so the GM
  decision queue needs no new mechanism — only scoping.
- Criterion 5 (explicit refusal) matters more here than anywhere: a GM overview that silently omits a
  department it cannot read looks identical to a department with no work. It must say which
  departments are excluded and why — the envelope pattern already does this; reuse it.

### Operations (Sanur Resort)
- **Open question, still unanswered:** the console renders but owns no capabilities. Until its scope is
  defined the bar cannot be applied. Sanur is a resort, not an agency, so it likely needs a different
  capability set than the Gaia departments rather than a copy of one.

## Exit bar — what "closed before staging" means

1. Every department row above is either at the bar or has a **recorded waiver** with a reason.
2. D14 resume path fixed; every write impact-classified.
3. `users.kind` shipped; no service account counted as a person anywhere.
4. Refusal is explicit everywhere; no reader folds a denial into an empty list.
5. Each department has ≥1 golden case usable as an eval.
6. A capability inventory exists showing, per capability, its endpoint + its tool + its impact class.
   **If that table cannot be generated, the estate is not agentic-native regardless of how it feels.**
7. **Agent attribution shipped at least to the interim `via:` stamp** (cross-cutting item 6). Until
   it is, no audit trail in the estate can distinguish a human from their agent — so "who did this"
   is unanswerable for exactly the actor that runs unattended. Owner decision 2026-08-08: this is a
   gate, and it gets its own version cut rather than being smuggled into a department's tickets.

## Deferred — agent/persona integration (late staging, OPTIONAL)

Recorded so the decisions are not re-litigated. Full design:
`2026-08-03-principal-kinds-design.md` (principal kinds) and the analysis below.

**Owner decisions taken 2026-08-03:**
- **One persona per department.** `persona:hr`, `persona:webdev`, `persona:seo`, …
- Personas are **optional** — the ERP must be fully usable with none present.
- Integration happens in **late staging**, after this plan is closed.
- Owner's Discord army stays the owner's. The ERP is a **second front door to the same brain**, not a
  second brain. ERP users are consumers: they may invoke, never see or edit persona configuration.

**The blocking architectural decision, unresolved:** `Principal` holds a single `userId`. OBO resolves
to *either* the human *or* the bot — there is **no delegation**. So "persona helps an employee within
scope, escalates beyond it" cannot be bounded by the employee's own permissions today.

Recommendation on the table (not yet accepted): **effective permission = persona scope ∩ acting
user's permissions** — add `x-act-for`, check Cerbos twice, deny if either denies, audit both.
Alternative is persona-authority plus a redaction layer, which trades an architectural guarantee for
a filter that has to be right every time.

**Also deferred with it:** `agent_personas` registry (personas are hardcoded in `specialists.ts`
today), the ERP ask/answer surface, `orchestrator.ask` as a hub tool rather than a side channel,
per-principal AI budgets, and Hermes-first model routing for cost control (the AI Gateway is already
the only key-holder, with daily + per-tenant caps and ~317 calls/day against a 2000 cap).

**n8n's lane, settled:** deterministic, scheduled, idempotent, approval-gated execution. n8n must not
call models directly. Personas propose; humans decide; n8n executes — which is exactly why the D14
resume path is a prerequisite and not a nicety.
