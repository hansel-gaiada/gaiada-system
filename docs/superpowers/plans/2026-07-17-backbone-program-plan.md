# Backbone Program — Full Ticketed Plan (Phase 1)

**Date:** 2026-07-17
**Status:** APPROVED PLAN — Phase 0 verdict (UPGRADE IN PLACE) accepted by the owner; this document
is the executable decomposition. Tickets are dispatched by the coordinator to the named seats.
**Owner:** hansel@gaiada.com
**Program order (owner-locked):** WS-0 → { ORG-CORE ∥ WS-A ∥ UX program } → WS-B → { WS-D ∥ WS-E }
→ WS-F → WS-C → WS-G. Internal operations first; client pillar + billing after.
**Design inputs:**
- Phase-0 design take (architect, 2026-07-17; delivered in-conversation to the coordinator).
- `docs/superpowers/specs/2026-07-17-org-core-shared-services-design.md` — the decided ORG-CORE
  design (minimal-delta / Proposal B + grafts). **Architect verdict: APPROVED WITH BINDING
  AMENDMENTS** (§2 below). The amendments are folded into the ORG tickets; no re-design loop.
- `docs/FRONTEND-BFF-CONTRACT.md` — the UI↔BFF contract; every backend ticket keeps it current.

**Locked owner decisions (do not relitigate):** upgrade-in-place; payroll OUT of v1 (export hook
later); resort company canon name = **Viceroy** (not "Sanur Resort"); core-vs-module split = core:
org, people, approvals, notifications, comments/files, search — modules: work/PM, clients+portal,
billing, agency, pipeline, IT, knowledge, automation-console, HR, resort-ops(future); Temporal later;
WS11 report sink = Knowledge docs + exec notification; payments gateway after invoice v1.5;
meeting-bot last; Daily-Work UX program added (senior-uiux lead), outputs binding for WS-B/D/E.

**Standing rules for every ticket:**
- Backbone rule (WS4): n8n = orchestration · MCP hub = access · services = logic.
- Cerbos + FORCE RLS are the authority; UI gating is defence-in-depth only.
- Every write emits domain events onto the outbox; every endpoint lands in
  `docs/FRONTEND-BFF-CONTRACT.md` in the same PR.
- No new "lite" shortcut without an explicit owner decision (full-fidelity mandate).
- Absolute paths; components stay separate projects; migrations follow the numbering protocol
  established by WS0-1.

---

## 1. Architect gates (4 checkpoints)

| Gate | When | What the architect reviews | Blocks |
|---|---|---|---|
| **GATE-1** | End of ORG-1..3 | Amended 0025/0026 DDL (renumbered from 0023/0024 by WS0-1 on 2026-07-22 — see `platform-nest/migrations/README.md`) + db choke-point implementation vs §2 amendments | ORG-6 (reconciler build) |
| **GATE-2** | UX-2 done + WSB-1 | Daily-Work UX contracts become binding; unified work-model ADR/DDL | WSB-2, and the UX build tickets UX-4/5 |
| **GATE-3** | WSD-1 | HR product design (shared-services flagship; payroll-out check; approver model) | WSD-2 |
| **GATE-4** | WSC-1 | Client pillar: external realm topology, portal IA, invoice v1.5 scope | WSC-2..7 |

Gate output is APPROVE or REVISE-with-specifics returned to the coordinator within the gate ticket.

---

## 2. ORG-CORE review verdict — APPROVED WITH BINDING AMENDMENTS

The decided design delivers the six required interface items: (1) stable unit identity via
`org_units` anchors + orphan semantics (accepted with hardening A13); (2) unit-scoped grants +
serves-companies resolution via `service_assignments` + reconciler + `serviceScopes`; (3) D5-based
RLS strategy preserved (no widened business SQL; one narrow dual-side metadata policy); (4) the
JSONB question resolved by **substitution** — blob stays presentation-authoritative with a
graduation path to a normalized graph (accepted; the Phase-0 requirement "migrate off the blob" is
formally superseded by this decision and `memory/org-structure-contract` must be updated, WS0-4);
(5) each/all selector semantics via scope pill + fan-out; (6) org-graph read API via
assignments/service-units/org-structure endpoints.

**Binding amendments (A1–A16), all sourced from the spec's own red-team findings and grafts —
these are normative and encoded in ticket acceptance criteria:**

- **A1 (CRITICAL, RT-1):** db-layer choke point: default assertion that any declared tenant set ⊆
  the principal's authorized set (global roles = all); exactly ONE privileged writer
  `reconcilerWrite(assignmentId, target)` allowed outside it, which re-reads the assignment row and
  re-verifies `status='active'` AND recorded target-side consent (or global actor) inside the same
  transaction. Grep-lint in CI that no other unvalidated multi-tenant `withTenants` exists.
  Invariant test: only the reconciler INSERTs `user_roles` with `managed_by NOT NULL`.
- **A2 (CRITICAL, RT-2 + RT-4):** no provenance coalescing. **Architect decision: claims junction**
  (`service_grant_claims`-style refcounting) rather than widening the user_roles UNIQUE — preserves
  principal assembly and admin endpoints untouched. A managed membership/grant is deleted only when
  its LAST claim is removed AND `kind='service'`; manual rows (managed_by NULL) are never claimed,
  resurrected, or deleted by the reconciler. Membership upsert: `ON CONFLICT (tenant_id,user_id) DO
  UPDATE` resurrects only dead service rows; if an employee row exists, record a claim and change
  nothing. Explicit hire-conversion admin action. The three RT-4 sequences + the RT-2 manual-grant
  sequences are mandatory tests.
- **A3 (CRITICAL, RT-7):** 0026 (renumbered from 0024, WS0-1 2026-07-22) ships per-command policies on `service_assignments`
  (`sa_select` USING provider-or-target; `sa_insert` WITH CHECK provider; `sa_update` USING+WITH
  CHECK provider-or-target) + column immutability (provider/target/unit/module frozen) via trigger
  or app-enforced UPDATE whitelist. Dedicated test exercises target-side accept under
  `withTenants([target])` — the spec's FOR ALL policy as written would fail it.
- **A4 (MAJOR, RT-3):** `platform-ui/src/lib/rbac.ts` `scopeCovers` fix (team scope must not
  blanket-cover; null-scope company grant must not cover all companies) + `holding_head` removal
  ships in the SAME release train as the backend feature; `SERVICE_ASSIGNMENTS_ENABLED` stays off
  until it lands. Server invariant test: every served-company route calls authorize() with the
  resolved tenantId before withTenants().
- **A5 (MAJOR):** same-holding validation on assignment targets (walk `parent_company_id` to a
  common root); cross-holding target → 422; proposed-row visibility only within the holding.
- **A6 (MAJOR):** no raw provider userIds to the target: `service-units` returns display
  names/opaque handles + role label; audit endpoints accepting a userId/subject_user_id to
  re-derive membership in the URL tenant under RLS.
- **A7 (MAJOR, RT-5 + RT-8):** reconcile is outbox-driven: the blob/assignment write emits
  `reconcile.requested` in the SAME transaction; an idempotent consumer executes per-target legs
  with dead-letter retry; PUT returns per-target queued/done/failed; nightly sweep is drift
  INSURANCE with alert-on-drift (expected zero); advisory lock lives in the consumer, not the
  interactive save path.
- **A8 (MAJOR, RT — org_units unreadable target-side):** denormalize `unit_name/unit_kind/
  unit_status` onto `service_assignments`, reconciler-refreshed; `org_units` stays strictly
  provider-side.
- **A9 (MAJOR, RT — UI scope):** v1 UI = "Connect service" BUTTON on the department card in the
  existing per-company OrgBuilder (confirm sheet + dryRun); the holding-canvas drag is designed in
  UX-6 and BUILT in WSF-5 (v1.1).
- **A10 (MAJOR, RT — exec visibility):** step-0 fix: global `group_executive` gets the
  platform_admin-style widened `GET /api/companies` read (architect decision: widen the read path;
  do NOT seed memberships — memberships now carry `kind` semantics).
- **A11 (MAJOR, RT-9):** delete the org-structure cookie fallback; failed org saves are loud
  ("access changes NOT applied"). Done early in WS0-6.
- **A12 (MINOR):** lead mapping via `service_assignments.lead_user_id` (confirm-sheet picker), not
  a blob flag; reconciler grants `_manager` to the lead, `_staff` to the rest.
- **A13 (MINOR):** org PUT hardening when org_units exist: duplicate node ids → 422; an anchored
  node whose kind changed → orphaned, not resolvable.
- **A14 (MINOR):** admin grant colliding with a managed row converts it to manual
  (`managed_by=NULL` + audit "converted service grant to manual"), not 409.
- **A15 (MINOR):** `app_current_tenants()` = `LANGUAGE sql STABLE PARALLEL SAFE` returning uuid[],
  `GRANT EXECUTE` to all runtime roles incl. sync_app, EXPLAIN-verified inlining; re-point ONLY the
  six broken tables (0011, 0014, 0017, 0018_pm, 0019, 0021); new policies compose from it.
- **A16 (grafts kept as normative):** inclusion-tagged aggregate envelope
  `{items, companies:[{id,included,reason}]}` on every ALL fan-out; `suspended` assignment status;
  orphan-freeze + TTL auto-suspend escalation; batch session bumps per user; per-tenant dual outbox
  emission with shared correlationId; Automation-unit pattern for wf service accounts;
  `pm_tasks.unit_id`→unified-task `unit_id` (WS-B); zero-assignment Cerbos 13-case parity replay;
  module-sliced RLS (`app.scopes` second GUC) on NEW hr tables only; hub-injected `x-tenant-id`
  from validated tool-call tenantId (WS-E); `/api/scoped/*` future aggregate design written into
  the contract doc now (ORG-15).

---

## 3. WS-0 — Truth & deploy hygiene (start immediately)

| ID | Seat | Size | Deps | Ticket + acceptance criteria ("done when") |
|---|---|---|---|---|
| WS0-1 | devops | S | — | **Migration numbering resolution + protocol.** Resolve the 0018 collision (`0018_pipeline_portal.sql` vs `0018_pm.sql`) with a ledger-safe strategy: either renumber with a ledger fix-up for DBs that already applied it, or formally accept dual-prefix lexical ordering (0003 precedent) — then LOCK the protocol: next free number is 0023 (reserved by ORG-CORE), collisions forbidden, documented in `platform-nest/migrations/README` (create it). **Done when:** fresh empty-DB migrate is green AND an existing dev DB re-migrate is a no-op; protocol doc merged. |
| WS0-2 | devops | S | WS0-1 | **Redeploy the stale backend.** Rebuild platform image, deploy, run migrations 0018–0022, apply RUNTIME_GRANTS_SQL for pm/it/invoices/pipeline-portal tables, confirm admin-console env (`GATEWAY_URL`/`BOT_URL`/`HUB_URL`/`KNOWLEDGE_URL`/`AUTOMATION_URL` + tokens) present in compose. **Done when:** every route listed as "MISSING on the running :3004" in `docs/FRONTEND-BFF-CONTRACT.md` returns non-404 with a real principal. |
| WS0-3 | junior | S | — | **Viceroy canonicalization.** Sweep seeds (`platform-nest/src/seed/agency.ts`), `platform-ui/src/lib/demoFixtures.ts`, READMEs and operative docs: resort company = **Viceroy** everywhere; "Sanur Resort" may remain only in dated historical plan/spec prose (incl. the ORG-CORE spec example — leave, it is a dated record). **Done when:** grep for "Sanur" hits only dated historical docs; seeds/fixtures/docs agree on Viceroy. |
| WS0-4 | junior | S | WS0-2 | **Contract-doc + memory refresh.** Re-verify BUILT/PENDING flags in `docs/FRONTEND-BFF-CONTRACT.md` both directions post-redeploy; fix the two stale rows the ORG-CORE spec names (org.ts header comment, org-structure ⛔ markers); note that `memory/org-structure-contract` is superseded on storage authority by the ORG-CORE decision. **Done when:** doc matches code; QA (WS0-5) finds no doc drift. |
| WS0-5 | qa | M | WS0-2 | **Full-contract live walk.** Exercise every ✅ row with real seeded principals per role (member/manager/company_admin/platform_admin/group_executive/client); verify 403-vs-404 semantics per the contract conventions. **Done when:** discrepancy list is empty or each item is ticketed by the coordinator. |
| WS0-6 | junior | S | WS0-2 | **Kill the org cookie fallback (A11).** Remove the cookie write/read fallback from `platform-ui/src/lib/org.ts` `persistOrgStructure`/`getOrgStructure` (DEMO_MODE fixtures unaffected); failed PUT surfaces a loud destructive-failure message in OrgBuilder. **Done when:** backend down → save fails loudly, nothing "saved locally"; backend up → persists; unit tests updated. |

---

## 4. ORG-CORE build (the spine; spec §migration_path + §2 amendments)

Release-train rule: ORG-7, ORG-11, ORG-12 ship behind `SERVICE_ASSIGNMENTS_ENABLED` and the flag
flips only when all three (plus ORG-5's parity replay) are green.

| ID | Seat | Size | Deps | Ticket + acceptance criteria |
|---|---|---|---|---|
| ORG-1 | senior-db | M | WS0-1 | **Migration 0025 (renumbered from 0023 by WS0-1, 2026-07-22 — 0023/0024 were consumed out-of-band by meeting_recordings and the WSA-2 module-registration backfill) — RLS empty-set hardening (A15).** `app_current_tenants()` helper (sql STABLE PARALLEL SAFE, uuid[], GRANT EXECUTE to platform_app + sync_app + PUBLIC-safe), re-point ONLY the six NULLIF-missing tables (0011, 0014, 0017, 0018_pm, 0019, 0021); regression test: `withTenants([])` returns zero rows (not an error) on EVERY tenant table; EXPLAIN inlining check on one hot table committed as a test. **Done when:** full platform suite green; sync-engine CI job green (same GUC contract). |
| ORG-2 | senior-db | M | ORG-1 | **Migration 0026 (renumbered from 0024) — service layer, as amended.** `org_units`; `service_assignments` with per-command policies (A3) + immutability enforcement + denormalized `unit_name/unit_kind/unit_status` (A8) + `lead_user_id` (A12) + `suspended` in the status CHECK (A16); `kind`/`managed_by` on memberships/roles; the claims junction (A2); `hr_staff`/`hr_manager` roles seed. Dedicated FORCE-RLS test (the tenant_id sweep misses this table) incl. a target-side accept UPDATE under `withTenants([target])`. Dormant — no code reads it. **Done when:** dedicated tests green; full suite green; GATE-1 review requested. |
| ORG-3 | senior-be | M | ORG-2 | **db choke point + privileged writer (A1) + `app.scopes` GUC support.** Default subset assertion in the tenant-set path (global-role bypass documented); `reconcilerWrite()` as the sole exception, re-verifying assignment status+consent in-tx; wrapper support for the second `app.scopes` GUC (module-sliced RLS, used by 0027); CI grep-lint for unvalidated multi-tenant sets; invariant test per A1. **Done when:** lint + tests in CI; existing suite green (no behavior change for current single-tenant call sites). |
| ORG-4 | architect | S | ORG-1..3 | **GATE-1.** Review the actual DDL + choke-point diffs against §2. **Done when:** APPROVE recorded; any REVISE items ticketed before ORG-6 starts. |
| ORG-5 | senior-be | M | ORG-2 | **Cerbos policy release (inert).** `module_staff`/`module_manager` generic derived pair; `resource_service_assignment.yaml` (propose/accept/revoke/read per spec); `resource_hr_case/record.yaml` (incl. assurance=high on bulk export); member-read extension for module_staff. Zero-assignment 13-case parity replay asserting bit-identical decisions (A16). **Done when:** Cerbos loads clean; parity replay green; no live endpoint passes the new kinds yet. |
| ORG-6 | senior-be | L | ORG-3, ORG-4, ORG-5 | **The reconciler.** Pure diff of (blob, assignments) → claims-model materialization (A2); outbox-driven execution with `reconcile.requested` emitted in the source transaction, idempotent consumer, dead-letter retry, per-target status (A7); batch session bumps per user; dual outbox emission with correlationId; orphan detect → freeze → TTL auto-suspend (A16); unvalidated/stale assigneeIds skipped + reported. Mandatory tests: the three RT-4 sequences, the RT-2 manual-grant sequences, crash-between-legs recovery, drift-sweep-finds-zero. **Done when:** all named sequences green on live PG+Cerbos; drift alert wired to the observability alert path. |
| ORG-7 | senior-be | M | ORG-6 | **ServiceAssignmentsController + identity surface.** POST units/:nodeId/assignments (`?dryRun=1`; global→active, provider-admin→proposed), accept, revoke, suspend/resume PATCH, manual `/reconcile`, GET assignments?direction; same-holding validation (A5, 422); module key validated via in-process registry; opaque staff handles target-side (A6); `GET /api/me` `serviceScopes`; `GET /api/:t/members` default `kind='employee'` + `includeService=1` marked rows; `GET /api/:t/service-units` from denormalized fields; all behind `SERVICE_ASSIGNMENTS_ENABLED`. **Done when:** endpoint tests incl. cross-holding 422, consent flow, target-side accept (proves A3), dry-run staff list; contract doc updated (ORG-15 merges it). |
| ORG-8 | junior | S | WS0-2 | **Exec visibility (A10).** Widen `GET /api/companies` (and the /api/me companies derivation used by the switcher) for global `group_executive`, mirroring the platform_admin branch in `platform-nest/src/core/core.controller.ts`; test. **Done when:** a membership-less exec lists all holding companies; contract-doc note updated. |
| ORG-9 | medior | S | ORG-2 | **Org PUT hardening (A13).** In the server sanitizer: when the tenant has org_units rows, reject duplicate node ids (422) and orphan anchored nodes whose kind changed. **Done when:** tests cover dup-id, kind-change, and the happy path; UI save of a legal tree unaffected. |
| ORG-10 | senior-db | S | ORG-2, ORG-3 | **Migration 0027 (renumbered from 0025) — HR tables.** `hr_cases`/`hr_records` per spec with standard tenant_isolation composed from `app_current_tenants()` PLUS the module-sliced `app.scopes` predicate (C-graft; NEW tables only). **Done when:** RLS tests prove: right tenant + module scope → rows; right tenant, missing module scope → zero rows; sync untouched. |
| ORG-11 | senior-be | M | ORG-10, ORG-7 | **HR module v1 (acceptance vehicle).** `hr` ModuleContract (mcpTools, rollupProvider `hr.open_cases`, customFieldTargets) + registerModule; HrController (cases/records per spec API, comments reuse, assurance-high export gate); `ModuleEnabledGuard` OR-extension (enabled iff enabled_modules OR active service assignment, checked under withTenants([target])). Coordinate the guard file with WSA-2. **Done when:** guard dark/alive flips with an assignment; hr tools appear in `GET /mcp/tool-defs`; suite green. |
| ORG-12 | senior-fe | M | ORG-7 | **RBAC + scope UI (A4 + A16) — same release train.** `rbac.ts` `scopeCovers` fix + `holding_head` removal + hr capabilities for hr_staff/hr_manager; serviceScopes-driven switcher badges ("Viceroy · via HR"); module-workspace scope pill A/B/C/ALL; ALL fan-out loader emitting the inclusion-tagged envelope (visible "partial view" state, no silent 403 drops). **Done when:** UI tests: team-scope/null-company grants no longer over-cover; envelope renders excluded companies with reason; flag can flip. |
| ORG-13 | medior | M | ORG-7, ORG-12 | **Connect-service UI v1 (A9).** "Connect service" button on department cards in OrgBuilder → confirm sheet (module + target companies + dry-run staff list + lead picker per A12); "Serviced functions" panel on the target org page; orphaned/suspended banners with Re-link/Revoke/Resume actions; proposed→accept notification + accept UI (`/admin/services`). **Done when:** full propose→accept→active→suspend→revoke lifecycle drivable from the UI against a live backend. |
| ORG-14 | qa | L | ORG-11, ORG-12, ORG-13 | **ORG mechanism adversarial pass.** Attempt: conscription without consent (provider-admin direct-active), cross-holding target, RT-2/RT-4 revoke-leak + overlap sequences via API, target-side accept under RLS, choke-point bypass (handler passing a foreign tenant), orphan TTL expiry, cookie-fallback resurrection (must be dead), curl-vs-UI parity (server denies what UI hides). **Done when:** every probe denied/behaves per spec; findings ticketed; sign-off recorded. |
| ORG-15 | junior | S | ORG-7 | **Contract-doc additions.** Assignments API, serviceScopes, service-units, members behavioral change, module catalog note, and the committed `/api/scoped/*` future aggregate design (A16/C-graft) written into `docs/FRONTEND-BFF-CONTRACT.md`. **Done when:** doc merged; UX program and WS-D consume it without questions. |

---

## 5. WS-A — Module-ization (parallel with ORG-CORE)

| ID | Seat | Size | Deps | Ticket + acceptance criteria |
|---|---|---|---|---|
| WSA-1 | architect | S | — | **Module map ADR.** Formalize the owner-confirmed core-vs-module split + `uiManifest` schema extension (nav group, icon, capability, order). Largely encoded in this plan; record as ADR in `docs/superpowers/specs/`. **Done when:** ADR merged; WSA-2/4 build against it. |
| WSA-2 | senior-be | M | WSA-1 | **Register the modules.** pm, it, billing, clients, knowledge, automation-console become ModuleContracts with `ModuleEnabledGuard`; move billing/clients controllers under `src/modules/`; **backfill migration/seed enabling these modules for all existing companies so nothing goes dark on deploy.** Coordinate guard file with ORG-11. **Done when:** disabling a module 404s its routes for that tenant only; agency tests green; `GET /mcp/tool-defs` lists the new modules' tools; existing tenants unaffected. |
| WSA-3 | medior | S | WSA-1 | **Module catalog endpoint.** `GET /api/modules` (registry-derived keys/labels/uiManifest + per-tenant enabled) + registry validation on `PATCH /api/:t/company/modules` (422 unknown keys). **Done when:** admin modules page consumes it; unknown key 422 test green. |
| WSA-4 | senior-fe | M | WSA-3 | **Manifest-driven nav.** `navFor` composes core groups + enabled-module manifests; delete `KNOWN_MODULES` from `admin/modules/page.tsx`; visually separate Organization (org units) from module nav; nav tests updated. **Done when:** toggling a module reshapes nav without code change; client-only portal nav unaffected. |
| WSA-5 | medior | S | WSA-2 | **company.type templates.** On company create, `type` seeds a module template (agency template = agency+pm+clients+billing; resort placeholder); seed updated. **Done when:** POST type=agency yields the template; type change does not silently strip modules (additive only). |
| WSA-6 | qa | M | WSA-4, WSA-5 | **Module isolation matrix.** Two companies with different module sets: routes, MCP tools, rollup providers, event handlers, nav — verified per tenant, plus the ModuleEnabledGuard OR-service-assignment path once ORG-11 lands. **Done when:** matrix documented + green. |

---

## 6. Daily-Work UX program (parallel; outputs binding for WS-B/D/E)

| ID | Seat | Size | Deps | Ticket + acceptance criteria |
|---|---|---|---|---|
| UX-1 | senior-uiux | M | — | **Daily-work audit + brief.** Structured pass over My Work, department/division workspaces, approvals inbox, task detail; capture the owner's stated gaps ("doesn't quite touch what I need") via the coordinator; personas incl. shared-service staff and exec; prioritized problem list. **Done when:** brief approved by the owner (via coordinator). |
| UX-2 | senior-uiux | L | UX-1 | **Binding redesign specs.** (a) My Work = unified personal queue (tasks + approvals + pipeline gates + mentions; cross-company fan-out WITH the inclusion envelope); (b) department/division workspace per the ORG-CORE focus model (department = module/unit workspace, division = subtree filter, person = assignee=me); (c) unified approvals inbox across origins (automation/agent/pipeline/hr); (d) "automate this" affordance pattern. Every data need lands as a contract delta in `docs/FRONTEND-BFF-CONTRACT.md`. **Done when:** GATE-2 sign-off + owner approval; WS-B/D/E cite it. |
| UX-3 | senior-uiux | M | UX-2 | **Design-system deltas + hi-fi.** Tokens/components for: scope pill, partial-view (envelope) states, orphan/suspended banners, board/kanban evolutions, DataTable server-mode states; a11y pass. **Done when:** implementable specs handed to senior-fe/medior; no open questions from UX-4/5. |
| UX-4 | senior-fe | M | UX-3 | **Build: My Work + approvals inbox v2** against existing endpoints (frontend-first, graceful degrade). **Done when:** e2e green; owner walkthrough accepted; envelope renders on cross-company fan-outs. |
| UX-5 | medior | M | UX-3 | **Build: department/division workspace v2** on current data model (string refIds), structured to re-key onto `unit_id` when WS-B lands (single data-mapping module). **Done when:** boards populate for seeded Gaia org; division filter works; re-key TODO isolated to one file. |
| UX-6 | senior-uiux | S | UX-2 | **Holding-canvas connect gesture design** (the deferred drag): cross-tree DnD, dry-run confirm sheet, proposed/dashed edges, chips. Design only — build is WSF-5. **Done when:** spec complete incl. empty/error/proposed states. |

---

## 7. WS-B — Work-model unification (after ORG-CORE core + UX-2)

| ID | Seat | Size | Deps | Ticket + acceptance criteria |
|---|---|---|---|---|
| WSB-1 | architect | M | ORG-2, UX-2 | **GATE-2 ADR: unified task model.** Base `tasks` absorbs progress, poly-assignee jsonb, subtasks, depends_on, milestone_id, dates, estimate, `unit_id` (FK org_units); decide eager org_units anchoring for ALL dept/div nodes on org PUT (default: eager — retires string matching); consumer inventory (bot skills, agency, notifications, agents `tasks.*` tools, rollups, WS11 links, calendar); alias/deprecation strategy for `/api/:t/pm/*`. **Done when:** ADR + DDL sketch approved; WSB-2 unblocked. |
| WSB-2 | senior-db | L | WSB-1 | **Unification migration.** Extend tasks; backfill pm_tasks→tasks (zero-loss, proven on a prod-copy dump); re-key `time_entries.pm_task_id`→`task_id`; eager-anchor org_units + backfill `unit_id` from `assignee->>'refId'`; compat view if the ADR requires; drop/shim pm_* per ADR. **Done when:** backfill report shows zero loss; full suite green; rls sweep green on changed tables. |
| WSB-3 | senior-be | L | WSB-2 | **Controller collapse.** PmController onto unified model; `/api/:t/pm/*` kept as aliases during deprecation; tracker/suggestions/milestones/docs re-pointed; event names preserved (`pm.task.*`). **Done when:** contract doc §4/§5 merged into one Work section; UI runs unchanged through aliases; 184+ tests green. |
| WSB-4 | senior-fe | M | WSB-3 | **UI convergence.** `lib/pm.ts` + `lib/data.ts` + `lib/departments.ts` onto one task type; department routing via `unit_id` (delete string matching); calendar/boards/timesheets re-verified; UX-5's re-key executed. **Done when:** all surfaces read one model; unit tests green; no demo/base duality remains. |
| WSB-5 | junior | S | WSB-3 | **Seeds + demo fixtures** updated to the unified model (incl. `seedPm` re-tagging onto unit ids). **Done when:** fresh seed → boards/calendar/timesheets populate; DEMO_MODE walkthrough clean. |
| WSB-6 | qa | L | WSB-4, WSB-5 | **Cross-surface regression.** Bot `/actions` + `/projects`, agency module, PM board drag, task detail (subtasks/deps/progress), timesheets totals, tracker run, calendar, department workspaces, WS11 deep-links, notifications hrefs. **Done when:** no surface lost a field, event, or deep-link; sign-off recorded. |

---

## 8. WS-D — HR pillar (payroll OUT; the shared-services flagship)

| ID | Seat | Size | Deps | Ticket + acceptance criteria |
|---|---|---|---|---|
| WSD-1 | architect (+senior-uiux) | M | ORG-11, UX-2 | **GATE-3: HR product design.** Leave (requests+balances) and attendance as dedicated tables; onboarding/review-lite as hr_cases kinds with checklist templates — confirm or amend at gate; approver model (target company_admin and/or module_manager); shared-service UX (scope pill each/all); payroll explicitly OUT (export hook only, WSG-6). **Done when:** ADR approved; WSD-2 unblocked. |
| WSD-2 | senior-db | M | WSD-1 | **HR product DDL.** leave_requests/balances, attendance, checklist templates/instances — all with the 0027 sliced-RLS pattern; rollup-friendly. **Done when:** RLS + module-scope tests green; migration follows protocol. |
| WSD-3 | senior-be | L | WSD-2 | **HR endpoints + flows.** Leave request→approve/deny via the UNIFIED approvals surface (`origin:"hr"`); attendance capture; onboarding checklist instantiation on `user.invited`; review-lite cycle; notifications with hrefs; events; metrics (`hr.open_cases`, `hr.leave_pending`) via rollupProvider. **Done when:** endpoint tests green; an approval decided in the approvals inbox moves the leave request; events on the bridge allowlist. |
| WSD-4 | senior-fe | M | WSD-3, UX-3 | **HR workspace UI.** My-leave, team attendance, onboarding boards, review-lite per UX-2; scope pill A/B/C/ALL with envelope; served-company badging. **Done when:** e2e: HR staff switches each/all and sees per-company slices; owner walkthrough accepted. |
| WSD-5 | medior | M | WSD-3 | **Employee-360 + directory integration.** HR cards (leave balance, onboarding, review status) on `/people/[id]`; service-row badging in directory per ORG-7 members semantics. **Done when:** cards render from real endpoints; non-authorized viewers see nothing (Cerbos-checked). |
| WSD-6 | junior | S | WSD-3 | **Seeds/fixtures/docs** for HR (demo leave/attendance data; contract-doc section). **Done when:** DEMO_MODE HR walkthrough works; docs current. |
| WSD-7 | qa | L | WSD-4, ORG-14 | **THE OWNER'S LITERAL ACCEPTANCE SCENARIO.** One HR department (Gaia Digital Agency) connected to serve 3 companies via the UI gesture; each company's admins see ONLY their slice (proven by curl, not just UI); HR staff get the company selector (each + all, envelope-tagged); drag-undo revokes within one request (session bump verified); person-moved-out-of-dept mid-flight behaves per spec STEP 7 (access revoked, data + responsibleId intact, reassignment event emitted); orphan-freeze + TTL verified. **Done when:** the scripted scenario passes end-to-end on a live stack and the script is committed as a repeatable e2e. |

---

## 9. WS-E — Automation weave (parallel with WS-D, after WS-B for tracker)

| ID | Seat | Size | Deps | Ticket + acceptance criteria |
|---|---|---|---|---|
| WSE-1 | senior-integrator | M | ORG-7 | **Hub scope tools + bridge.** `me.scopes` + `service.assignments.list` hub tools; `service_assignment.*`/`service_staff.*`/`org_unit.orphaned` on N8N_BRIDGE_EVENTS; Automation-unit pattern (wf service accounts placed in a dedicated org unit so re-scoping bots = the same drag/reconcile path). **Done when:** hub tests green; a cron flow discovers its tenant set via me.scopes instead of `$env.AGENCY_TENANT_ID`. |
| WSE-2 | senior-integrator | M | WSB-3 | **Real AI Tracker.** WS8 PM-specialist behind `POST /api/:t/.../tracker/run` (Gateway model + D9 docs; D13 `evaledProviders` gate honored — un-evaled provider → deterministic fallback, never silent write). **Done when:** tracker suggestion produced by the agent on a live task; eval-gate test proves fallback; UI unchanged. |
| WSE-3 | senior-be | M | WS0-2 | **SSE channel.** One authenticated stream endpoint fed by an event-backbone consumer: notifications, approvals, IT heartbeats, reconcile status. Fail-soft (UI keeps no-store fallback). **Done when:** two browser sessions see a notification within 2s of the emitting write; load test at modest concurrency documented. |
| WSE-4 | medior | S | WSE-3 | **SSE UI wiring.** Bell + approvals badge + IT status live-update; reconnect/backoff. **Done when:** e2e proves live update without refresh; degraded mode identical to today. |
| WSE-5 | medior | S | WS0-2 | **n8n execution status/history** in `/it/workflows` (reshape n8n Public API executions; fail-soft). **Done when:** runs list + last status render for the 3 live workflows. |
| WSE-6 | senior-integrator | M | WSE-1 | **Bot scope + gateway attribution.** wa-bot resolves per-user scope via `me.scopes` ("For which company — Gaia / Viceroy / all?"); hub gateway-client injects `x-tenant-id` = validated tool-call tenantId post-scope-check (served tenant pays; wakes per-tenant budget caps). **Done when:** bot flow test green; gateway budget attribution visible per tenant in egress/budget audit. |
| WSE-7 | medior | M | UX-2, WSE-1 | **"Automate this" pilots + reorg-reaction flows.** The UX-2 affordance pattern on 2 pilot surfaces; n8n flows: orphaned-work reassignment chaser (on `service_staff.revoked` payload) and access-review digest (on assignment events). **Done when:** both flows fire on live events; pilot affordances create runnable n8n templates via hub tools only. |
| WSE-8 | junior | S | WS0-2 | **WS11 report sink (owner-locked).** Report track output lands as a Knowledge (D9) document + exec notification; replace the notify STUB in `automation/workflows/pipeline-fanout.json` path per the backbone rule (hub tool writes, not workflow logic). **Done when:** a driven pipeline run produces a searchable knowledge doc + a notification with href. |
| WSE-9 | qa | M | WSE-2, WSE-4, WSE-6, WSE-7 | **Automation-weave regression** on a live-ish stack: tracker e2e, SSE latency, bot scope dialogue, both n8n reaction flows, budget attribution. **Done when:** all pass; D14 probe confirms automation still cannot rewire access. |

---

## 10. WS-F — Holding governance

| ID | Seat | Size | Deps | Ticket + acceptance criteria |
|---|---|---|---|---|
| WSF-1 | senior-fe | M | ORG-8, UX-4 | **Exec landing.** Cross-company home for global execs: rollup tiles, unified approvals, org overview, service-assignment health (orphaned/suspended counts) — kills the "select a company" dead-end. **Done when:** a membership-less group_executive lands on a functional page; every tile deep-links. |
| WSF-2 | senior-be | M | WSB-3 | **Consolidated finance rollups.** D12 metric set over invoices + billable time across children + a drill-down endpoint (records behind a metric) + period history. **Done when:** holding P&L-lite computes from seeded data; drill-down returns row-level provenance; rollups remain the only cross-company read path. |
| WSF-3 | medior | S | WSF-2 | **Drill-down + period UI** on `/rollups`. **Done when:** metric click → underlying records; period switcher works. |
| WSF-4 | junior | S | WS0-2 | **Audit pagination/filter/export** server-side on `/api/:t/audit`. **Done when:** 10k-row audit pages in <1s locally; CSV export endpoint. |
| WSF-5 | senior-fe | M | UX-6, ORG-13 | **Holding-canvas connect gesture (build).** Cross-tree DnD per UX-6, same POST/dryRun API as the button (no new backend). **Done when:** drag from dept card → confirm sheet → assignment created; e2e green; button path still works. |
| WSF-6 | qa | M | WSF-1, WSF-2, WSF-5 | **Containment pass.** Adversarial probes that rollups stay the only cross-company read; exec landing leaks nothing to non-global roles; canvas gesture cannot exceed button-path guarantees (same-holding, consent). **Done when:** probes documented + denied. |

---

## 11. WS-C — Client pillar (after internal ops, owner-sequenced)

| ID | Seat | Size | Deps | Ticket + acceptance criteria |
|---|---|---|---|---|
| WSC-1 | architect | S | GATE-3 passed | **GATE-4: client-pillar design review.** External realm topology (separate Keycloak realm, issuer/JWKS split precedent from OIDC-SSO work), portal IA scope, invoice v1.5 scope, CRM-lite shape. **Done when:** APPROVE recorded; WSC-2..7 unblocked. |
| WSC-2 | senior-integrator | M | WSC-1 | **External client Keycloak realm** + portal login swap; client user provisioning flow; staff realm untouched; dev-login preserved for staff. **Done when:** a client authenticates via the external realm and reaches only the portal; staff SSO unaffected (regression run). |
| WSC-3 | senior-uiux | M | WSC-1 | **Portal IA/design.** Full client workspace: projects, deliverables status, invoices, shared files, feedback threads; blockage banner evolution; what the Cerbos `client` role may see per surface. **Done when:** binding spec + contract deltas in the contract doc. |
| WSC-4 | senior-be | M | WSC-2, WSC-3 | **Portal BFF expansion.** Client-scoped projections (3-layer isolation pattern from PortalController: RLS + Cerbos + controller linkage). **Done when:** a client principal sees only linked-client rows across all portal endpoints; isolation tests green. |
| WSC-5 | medior | M | WSC-1 | **CRM-lite.** Client contacts, rate cards, agreement references on client detail; invoice generation reads the rate card. **Done when:** CRUD + UI cards; invoice POST uses stored rate. |
| WSC-6 | senior-be | M | WSC-1 | **Invoice v1.5.** Numbering sequence (per company), currency on invoice, PDF artifact render, payment-status audit trail; payments gateway explicitly deferred. **Done when:** lifecycle draft→sent→paid produces a numbered PDF; status changes audited + evented. |
| WSC-7 | medior | M | WSC-4 | **Portal frontend build** per WSC-3 (client nav stays portal-only). **Done when:** e2e as a client: view project status, sign gates, see invoice, download shared file, post feedback. |
| WSC-8 | junior | S | WSC-4 | **Seeds/fixtures/docs** for the client pillar (demo client in external-realm dev mode; contract-doc rows). **Done when:** DEMO_MODE portal walkthrough; docs current. |
| WSC-9 | qa | L | WSC-6, WSC-7 | **Client adversarial pass.** IDOR across clients and tenants, portal nav escape to staff surfaces, realm token misuse (staff token on portal / client token on staff API), invoice visibility. **Done when:** zero leakage; findings ticketed; sign-off. |

---

## 12. WS-G — Scale & polish (last)

| ID | Seat | Size | Deps | Ticket + acceptance criteria |
|---|---|---|---|---|
| WSG-1 | medior | M | WSB-3 | **Server-side list params** (`?page&pageSize&sort&dir&q&filter`) on hot lists (tasks, people, audit, clients, invoices) + DataTable server mode. **Done when:** 10k-row lists page server-side; response shape documented (`{rows,total}`). |
| WSG-2 | senior-be | M | WSC-4 | **True multipart upload + storage design note.** Design note first (storage strategy incl. sync/site implications) — architect-reviewed within the ticket; then multipart on `/api/:t/files` alongside reference mode; day-one scrub preserved. **Done when:** binary upload/download e2e; note merged; reference mode regression green. |
| WSG-3 | medior | S | — | **i18n/timezone/currency prefs** threaded through `lib/format.ts` + user prefs. **Done when:** locale/tz user pref changes rendering app-wide. |
| WSG-4 | junior | S | WSE-3 | **Notification per-item read + prefs.** **Done when:** per-item read persists; mute prefs respected by SSE + bell. |
| WSG-5 | junior | S | WSG-1 | **Server CSV export** endpoints for the hot lists. **Done when:** export matches server-filtered result set. |
| WSG-6 | junior | S | WSD-3 | **Payroll export stub** (owner-locked "later" hook): CSV of comp-relevant HR records per company per period. **Done when:** export downloads; explicitly documented as not-payroll. |
| WSG-7 | qa | M | WSG-1 | **Volume pass.** Seed 10k tasks / 1k users-scale fixtures; verify paging, SSE stability, rollup recompute time; record baselines. **Done when:** baselines documented; no endpoint >2s locally at seeded volume. |

---

## 13. Dependency spine, critical path, sizing summary

```
WS0-1 → WS0-2 ─┬→ ORG-1 → ORG-2 → ORG-3 → [GATE-1] → ORG-6 → ORG-7 ─┬→ ORG-11 → ORG-12 → ORG-13 → ORG-14
               │                    (ORG-5 ∥ ORG-3)                  ├→ ORG-15, WSE-1
               ├→ WSA-1..6 (parallel)          UX-1 → UX-2 → [GATE-2]┤
               ├→ UX-1 (parallel)                                    ▼
               └→ WSE-3/5/8, WSF-4, ORG-8      WSB-1 → WSB-2 → WSB-3 → WSB-4/5 → WSB-6
                                                                   │
                                   WSD-1 [GATE-3] → WSD-2 → WSD-3 → WSD-4/5/6 → WSD-7 (owner scenario)
                                   WSE-2/4/6/7 → WSE-9   (∥ WS-D)
                                   WSF-1/2/3/5 → WSF-6
                                   WSC-1 [GATE-4] → WSC-2..8 → WSC-9
                                   WSG-1..7
```

**Critical path:** WS0-1 → WS0-2 → ORG-1 → ORG-2 → ORG-3 → GATE-1 → ORG-6 → ORG-7 → ORG-11 →
ORG-12 → ORG-13 → ORG-14 → WSD-1(GATE-3) → WSD-2 → WSD-3 → WSD-4 → **WSD-7 (the owner's acceptance
scenario)**. Near-critical parallel chain: UX-1 → UX-2 → GATE-2 → WSB-1 → WSB-2 → WSB-3 → WSB-6
(it gates WSE-2 and the department-workspace re-key). Keep senior-db and senior-be saturated on the
ORG chain; everything junior/medior above is deliberately off-path.

**Ticket counts:** WS-0: 6 · ORG: 15 · WS-A: 6 · UX: 6 · WS-B: 6 · WS-D: 7 · WS-E: 9 · WS-F: 6 ·
WS-C: 9 · WS-G: 7 — **77 total**.
**Per seat:** senior-be 13 · medior 14 · junior 13 · qa 9 · senior-fe 7 · senior-db 5 ·
senior-uiux 5 (+1 co-design) · architect 5 (incl. 4 gates) · senior-integrator 4 · devops 2.

**Release-train rules:** (1) `SERVICE_ASSIGNMENTS_ENABLED` flips only when ORG-5 parity replay,
ORG-7, ORG-11, ORG-12 are all green (A4). (2) The members `kind` default-filter (ORG-7) and its UI
consumption (ORG-12/13) merge in the same train. (3) WSB aliases stay until one full QA cycle after
WSB-6.
