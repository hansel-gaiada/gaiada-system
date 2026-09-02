// Role-Based Access Control — the single source of truth for "who can do what,
// where". Pure (no server-only APIs) so it's importable from server components,
// server actions, and tests alike. The BACKEND (Cerbos/RLS) remains the real
// authority; this enforces the same model in the UI so nav, the company
// switcher, and write actions all gate consistently and fail closed.
//
// Model: a user has role GRANTS, each scoped global | company | org_unit | project. A grant
// confers a set of CAPABILITIES within its scope. `can()` answers a capability
// question, optionally against a specific company. Cross-company capabilities
// (rollups, admin-wide) are asked with no companyId and require a GLOBAL grant.
//
// HIER-3 (2026-08-11): `team`/`team_lead` are RETIRED — zero live grants, superseded by
// `org_unit`/`org_unit_lead` (HIER-1/HIER-2). See
// `docs/superpowers/plans/2026-08-10-hierarchy-consolidation.md` for why.
import type { Me } from "./platform";

export type Role =
  | "platform_admin"   // superadmin — everything, everywhere (unrestricted)
  // IAM-15 (D-7, 2026-08-23): `group_executive` removed. It meant "everything across the group's
  // companies, unrestricted", which is exactly the reach D-7 deleted. Holding-wide business
  // authority is `owner` now, granted PER OWNED COMPANY — so it needs no entry in this union: a
  // per-company grant is already expressible as a company-scoped role.
  | "company_admin"    // admin within a company
  | "manager"          // runs work within a company
  | "member"           // baseline access
  // Gap 3 (2026-08 sweep — found while writing the drift-proof test, not requested by name but the
  // same bug shape as `team_lead`): `viewer` is ALSO a real raw grant role in derived_roles.yaml
  // (`g.role == "viewer"`, company/global scoped like `member`) that had no `Role` member at all.
  // It is granted almost everywhere as the read-only baseline (no capability here needs modelling
  // for that — those reads are ungated by any `can()` check today, same as `member`'s). The ONE
  // place it is granted something this file actually gates: resource_pm_task.yaml's `["read",
  // "update"]` rule lists `viewer` alongside `member`/`team_lead`/`manager`/`company_admin` —
  // i.e. Cerbos lets a viewer grant pass the ball / make execution edits exactly like a member
  // (rbac.test.ts's own pre-existing comment on this file already said as much: "resource_pm_task.
  // yaml grants update to member/viewer/team_lead/manager/company_admin"). `viewer` is excluded
  // from pm_task's create/delete/manage rule and from every other write rule checked in this sweep
  // (comments explicitly exclude it: "Viewers are read-only; commenting is a write and excludes
  // them"), so `pm.contribute` alone — matching `member` — is the correct, non-invented capability
  // set, not a guess.
  | "viewer"
  | "it_admin" | "it_manager" | "it"  // IT operators
  | "hr_staff" | "hr_manager" // HR module derived roles (WSD-2 module_staff/module_manager, string-composed from grants — see hr module design §2.1). Company-scoped; may be reconciler-materialized onto a SERVED company (Me.serviceScopes) when the grant rides a service assignment.
  | "search_staff" | "search_manager" // search-marketing (SEO/SEM/GEO) module derived roles (SM-03; same WSD-2 module_staff/module_manager linchpin as HR — string-composed from grants, resource.attr.module === "search"). Company-scoped; may be reconciler-materialized onto a SERVED company.
  // social-media module derived roles (SMM-30/SMM-11; same WSD-2 module_staff/module_manager
  // linchpin, resource.attr.module === "social"). ⚠ NAMED `social_staff`/`social_manager`, NOT
  // `smm_*` — the addendum's own §A1 Δ1 correction: `derived_roles.yaml` string-composes
  // `resource.attr.module + "_staff"/"_manager"`, and the module key is `social` (the department's
  // display name "Social Media" and console slug "social-media" are cosmetic; the module key that
  // decides the Cerbos role string never changed). Company-scoped; may be reconciler-materialized
  // onto a SERVED company exactly like search_staff/search_manager.
  | "social_staff" | "social_manager"
  // IAM-02a-FIX / DR-2b — `agency_approver` is a REAL, LIVE-HELD role (1 real holder, IAM-02a-0's
  // live query 2026-08-10) that was entirely absent from this union — same defect shape as Gap 1/2/3
  // above: a raw grant role exists in Cerbos but has no `Role` member here, so `ROLE_CAPS[g.role]`
  // resolves `undefined` and the holder gets ZERO capabilities anywhere in the UI, including the one
  // thing Cerbos actually lets them do. Its Cerbos reach is `derived_roles.yaml`'s `module_approver`
  // (string-composes `"<module>_approver"` from `resource.attr.module`), which is referenced by
  // exactly ONE resource policy in the whole estate: `resource_agency_approval.yaml`'s `approve` rule
  // (`derivedRoles: ["company_admin", "module_approver"]`, module is always `"agency"` — every
  // `agency.controller.ts` call site hardcodes it). No other resource file names `module_approver` at
  // all, and `agency_approver` is not a raw-role string any OTHER derived role matches (it is not
  // `manager`/`member`/`viewer`/etc.), so this is its ENTIRE Cerbos surface — not even a baseline
  // `agency_approval:read` (that rule lists `company_admin`/`manager`/`member`/`viewer` explicitly,
  // never `module_approver`). See `ROLE_CAPS.agency_approver`'s comment for why the grant is
  // therefore exactly one capability, not a guess and not copied from another role.
  | "agency_approver"
  // TR-25 — §8's fifth column (served-dept provider tier). Same WSD-2 module_staff/module_manager
  // linchpin, `resource.attr.module === "reports"`. Reconciler-materialized onto a SERVED company for
  // the members of a providing unit, and ONLY while the assignment is status='active'.
  // ⚠ These roles are NOT SEEDED in the platform yet (0026 seeds only the hr_* pair, and
  // `service-reconciler.ts` no-ops on an unseeded module role) — so this tier is currently inert in
  // production. Mirrored here so the UI is ready and the intent is recorded, not because it is live.
  | "reports_staff" | "reports_manager"
  // HIER-2 (2026-08-11) — `team_lead`'s REPLACEMENT, and the first role scoped to an org-chart unit
  // (`scopeType: "org_unit"`, `scopeId` = a text node id like `'d-web'`). Added here because
  // `rbac-cerbos-parity.test.ts` caught its absence the moment HIER-2 landed the Cerbos side: that
  // guard exists precisely because two whole roles once went missing from this mirror.
  //
  // Capability set derived from its ACTUAL bundle (`role-permission-bundles.json`), which is two
  // permissions and only two — `reports.appraisal.read` and `reports.document.read_department` —
  // matching the two policies HIER-2 wired (`resource_appraisal.yaml` read,
  // `resource_report_document.yaml` read_department). Deliberately NOT given the rest of the
  // reports family: HIER-2 left `read_person`/`read_project` unwired because no handler resolves a
  // unit ancestor list there, so claiming them here would re-create the dead-grant pattern this
  // whole consolidation is removing.
  //
  // ⚠ SCOPE CAVEAT, same shape as `team_lead`'s: an `org_unit_lead` grant is ALWAYS
  // `scopeType: "org_unit"`, and `scopeCovers()` deliberately does not let a unit-scoped grant
  // satisfy a company-wide `can()` question. The real subtree containment is evaluated server-side
  // (Cerbos matches `g.scopeId in resource.attr.unitAncestors` off IAM-09's closure), which the
  // browser cannot and must not replicate. So these capabilities are correct for "should the UI
  // offer this at all", never for "may this lead see THAT unit".
  | "org_unit_lead"
  // F17 (2026-08-26) — THREE roles that Cerbos grants and this union did not name, so every holder
  // resolved to ZERO capabilities in the UI. Same defect class as Gap 1/2/3 above; found while
  // mirroring the finance read tier for the GM console's money card (GM-09), and fixed as its own
  // change because it is estate-wide, not GM-scoped.
  //
  // `finance_staff` / `finance_manager` — the WSD-2 module_staff/module_manager pair for
  // `resource.attr.module === "finance"`, exactly like hr_*/search_*/social_*/reports_*. Both derive
  // the SAME two capabilities today, because those are the only two finance capabilities this file
  // models; their remaining 19 and 38 backend permissions have no UI surface yet. That is honest, not
  // a gap in this change — a capability is added when a UI reads it, never speculatively.
  | "finance_staff" | "finance_manager"
  // MON-20 (2026-09-02) — the monitoring module's own module_staff/module_manager pair
  // (`resource.attr.module === "monitoring"`, monitoring-program.md §14's naming constraint:
  // `derived_roles.yaml` string-composes `monitoring_staff`/`monitoring_manager`, so those are the
  // ONLY names Cerbos will ever look for). Same defect class this file's own header warns about —
  // added alongside the channel/route/maintenance management UI rather than left absent, because an
  // absent `Role` member is not "no grant", it's "every capability check silently resolves false for
  // a real holder". `monitoring.controller.ts` does not exist for channels/routes yet (this module is
  // frontend-first, per the FRONTEND-BFF-CONTRACT), so — unlike finance_staff/manager above — there
  // is no live bundle to verify these two against; the split below is taken directly from
  // monitoring-program.md §13.2's PROBED Cerbos decisions (`monitoring_staff` DENY on
  // `maintenance:create`/`channel:manage`; `monitoring_manager` ALLOW), not guessed.
  | "monitoring_staff" | "monitoring_manager"
  // `owner` — the holding-wide BUSINESS authority, granted per owned company (see the IAM-15 note on
  // `group_executive` above, which `owner` replaced). It carries 330 permissions in the bundles,
  // deriving 61 capabilities here. **This was the most consequential omission of the three:** an
  // owner previously saw nothing — no Settings, no company management, no reports, no HR — while
  // Cerbos would have authorized all of it.
  | "owner";

// The single source of truth for every capability the platform knows about. `Capability` is
// DERIVED from this tuple (below) rather than hand-declared as a separate union, and `ALL` (the
// "unrestricted role gets everything" set — see ROLE_CAPS) is derived from the SAME tuple. Gap-1
// fix (2026-08): before this, `Capability` was its own `type` and `ALL` was a hand-maintained
// array that had to be kept in sync with it by memory alone — `can()` does not special-case
// platform_admin/group_executive, so "superadmin can do anything" was a promise kept only by
// someone remembering to append to two separate lists. A capability added to one and not the
// other would silently and permanently deny it to the owner's own account. Now there is only ONE
// list: add a capability here and it is simultaneously part of the `Capability` type AND part of
// `ALL`, by construction — `rbac.test.ts`'s "every Capability is in ALL" test pins this so a
// future refactor that reintroduces a second list fails loudly instead of silently.
export const CAPABILITIES = [
  "admin.access",       // /admin/* (users, identity, modules, compliance, audit)
  "company.manage",     // company settings / module enablement
  "org.edit",           // edit the org structure
  "people.directory",   // browse the people directory
  "rollups.view",       // cross-company rollups (global)
  "pm.manage",          // create/delete tasks, CHANGE OWNERSHIP (Responsible), confirm tracker writes
  // Owner decision 2026-08-06: "anyone can pass the ball." Mirrors Cerbos's `pm_task:update`, which
  // resource_pm_task.yaml grants to member/viewer/team_lead/manager/company_admin — i.e. any member.
  // Passing the ball changes `assignee.refId` and leaves `assignee.responsibleId` alone; the server
  // diffs the two and only escalates to `manage` when OWNERSHIP actually changes. This capability
  // exists so the UI stops being stricter than the server: it previously gated the ball on
  // `pm.manage`, which silently made a hand-off leads-only.
  "pm.contribute",      // pass the ball, execution edits (status/progress/dates) — any member
  "it.manage",          // register/edit devices
  "approvals.decide",   // approve/reject
  // D14-08 — retry a FAILED (or stuck-executing) automation write's execution (Cerbos action
  // `retry` on `automation_approval`). Deliberately NARROWER than `approvals.decide`: a plain
  // `manager` may decide but must not retry — retry re-attempts a write that already failed once,
  // which the backend restricts to superadmin/company_admin/group_executive (D14-07's grant).
  "approvals.retry",
  // IAM-02a-FIX-2 (2026-08-10) — REPAIRING DR-1's OWN COLLATERAL DAMAGE, NOT REOPENING IT. DR-1
  // correctly removed `approvals.decide` from `manager` because Cerbos denies `manager` on the three
  // genuine DECIDE surfaces it gates (automation_approval.decide/retry, agency_approval.approve,
  // pipeline_gate.decide — see the `manager` entry's DR-1 comment below). But `approvals.decide` was
  // ALSO, accidentally, the sole UI gate for 8 operational server actions in `pipelineActions.ts` /
  // `webdevProvisionedSitesActions.ts` that Cerbos DOES still grant `manager` — a completely different
  // Cerbos tier that happened to be expressed through the same UI capability. Removing the capability
  // from `manager` therefore ALSO silently removed those 8 real, Cerbos-granted affordances: a NEW
  // UI-side under-claim, the dangerous drift direction this whole program exists to eliminate. The fix
  // is the two purpose-built capabilities below, kept permanently separate from `approvals.decide` —
  // do NOT "simplify" them back into it; that recreates this exact bug.
  //
  // `pipeline.write` — the MEMBER-INCLUSIVE operational tier. Verified against every policy it gates,
  // all three carrying the IDENTICAL role list under the IDENTICAL condition (`inTenant && notLow`):
  //   resource_pipeline_run.yaml    actions ["create","update"] -> company_admin, manager, member
  //   resource_pipeline_stage.yaml  action  "create"            -> company_admin, manager, member
  //   resource_pipeline_gate.yaml   action  "create"            -> company_admin, manager, member
  // This is the low-privilege "open / advance / ask" tier — automation accounts authenticate at
  // `manager` tier (`seedAutomationAccounts`), never `member`, so this is genuinely a HUMAN member's
  // own grant, not just automation's. Gates: `createRunAction`, `updateRunStatusAction`,
  // `createStageAction`, `openGateAction` (all in `pipelineActions.ts`).
  "pipeline.write",
  // `pipeline.manage` — the ELEVATED-ONLY tier within pipeline, and the reason it is a SECOND
  // capability rather than widening `pipeline.write`: `member` is explicitly absent from both of the
  // policies it gates, so folding the two together would over-grant a plain member the power to edit
  // an already-signed artifact and to sign the agency's own commercial commitment.
  //   resource_pipeline_stage.yaml  action "update" -> company_admin, manager, group_executive
  //     (member EXCLUDED — WD-03/D-3's own comment: "A plain member role is denied per the D-3 AC")
  //   resource_scope_signoff.yaml   action "create" -> company_admin, manager, group_executive
  //     (member AND team_lead both explicitly excluded — the file's own comment: "signing a scope
  //     agreement commits the agency commercially, and the whole point of the dual-sign is that a
  //     named accountable person does it")
  // Gates: `editStageArtifactAction`, `recordScopeSignoffAction` (both in `pipelineActions.ts`).
  "pipeline.manage",
  // `webdev.provision` — provisioning REAL infrastructure (a private org repo, a server directory, an
  // nginx vhost, a TLS cert). Verified against resource_webdev_provisioned_site.yaml's `provision`/
  // `reconcile` rules: `["read","provision","reconcile"] -> company_admin, manager` on the in-tenant
  // tier (that file's own header: "never a plain-member action"). Kept as its OWN capability rather
  // than merged into `pipeline.manage`, even though the two role sets are identical TODAY
  // (company_admin/manager): this resource kind also carries an unmirrored `module_manager`/
  // `module_staff` (webdev-dept) tier — string-composed from `resource.attr.module === "webdev"` —
  // that the pipeline resources above do not have and that this file does not yet model as a `Role`
  // (no `webdev_manager`/`webdev_staff` member exists here; out of this ticket's scope). The two
  // capabilities are expected to diverge once that tier lands, so collapsing them now would only have
  // to be un-collapsed later. Gates: `provisionSiteAction`, `reconcileSiteAction` (both in
  // `webdevProvisionedSitesActions.ts`).
  "webdev.provision",
  // `github.link` — link/unlink a `github_repos` row to a `webdev_site_id`/`project_id` (GH-08/GH-10).
  // Verified directly against `resource_github_repo.yaml` (GH-03, shipped 2026-08-31): its `link`/
  // `unlink` rule is `derivedRoles: ["company_admin", "manager"]`, in-tenant, with NO `approvalId`
  // condition — unlike `deploy`/`secret_write`/`create_repo`/`delete_repo` on the same kind, which are
  // D14-gated and therefore unreachable by role tier alone (§25's own binding-rulings section: "no
  // module wall... tenant_id never moves... GitHub-owned columns are never written here"). `member`
  // holds `github_repo.read` only — genuinely narrower, not an oversight (§25: "a repo nobody owns" is
  // a finding for someone who may act on it, not everyone who may look at the registry). Bundled as
  // ONE capability covering both actions rather than split `github.link`/`github.unlink`: every call
  // site that offers a Link control on a row offers Unlink on the same row under the identical
  // condition (`GithubRepoRegistry.tsx`'s per-row controls), so a split would only ever be checked in
  // lockstep. Gates: `linkGithubRepoAction`, `unlinkGithubRepoAction` (`githubReposActions.ts`).
  "github.link",
  "knowledge.review",   // review/quarantine knowledge sources
  "hr.view",            // read hr_cases/hr_records/leave/attendance for a company
  "hr.manage",          // file/decide leave on others' behalf, edit cases/records/checklists, manage templates
  // ── HR-FULL (2026-08-24) — mirrors of the three new Cerbos kinds. This file is a MIRROR of the
  //    policy, never the source: resource_hr_policy.yaml / resource_hr_recruitment.yaml /
  //    resource_hr_payroll.yaml decide, and these exist so a page can hide a control the server
  //    would refuse anyway. Getting one of them WIDER than its policy is a cosmetic bug (a button
  //    that 403s); getting one NARROWER hides a capability somebody actually holds — so when in
  //    doubt the mirror is written narrow and the server is the one that says no.
  "hr.policy.view",     // read holiday calendars, leave policies, review cycles, pay grades, statutory params
  "hr.policy.manage",   // create/amend HR configuration (NOT ratify)
  "hr.policy.ratify",   // sign off a statutory parameter set — company_admin only, high assurance
  "hr.recruitment.view",    // read requisitions, candidates, applications, interviews, scorecards
  "hr.recruitment.manage",  // run the pipeline: create/advance/schedule/score/draft offers
  "hr.recruitment.approve", // approve a requisition or offer, and convert an offer into an employee
  "hr.payroll.view",    // read compensation, benefits, payroll runs, payslips, separations (company-wide)
  "hr.payroll.manage",  // set compensation, capture inputs, create + calculate runs, draft separations
  "hr.payroll.approve", // approve a run / compensation change / separation, mark a run paid
  // ── LMS-L1 (2026-08-24). Its OWN module, serving all eight departments. Mirrors of
  //    resource_lms_course.yaml / resource_lms_enrollment.yaml; the policy decides, this only
  //    hides controls the server would refuse anyway.
  "lms.catalogue.view",   // browse courses and paths — genuinely wide, every member holds it
  "lms.authoring",        // create/update/retire a course or path (HOD: own department only)
  "lms.publish",          // publish a version, making it assignable and certifiable
  "lms.progress.view",    // read OTHERS' enrolments, progress and scores
  "lms.assign",           // assign a path to somebody and record progress on their behalf
  "lms.grade",            // grade a reviewed submission (UI/UX, management scenarios)
  "lms.waive",            // excuse somebody from mandatory training — admin tier only
  "search.view",        // read search-marketing properties/engagements/keywords/audits/campaigns/reports/ledger for a company
  "search.manage",      // create/edit properties/engagements/keywords/audits/campaign drafts+proposals/report drafts (draft-only working set — mirrors search_staff/search_manager's baseline Cerbos grant)
  "search.scope.write", // set an engagement's tool-scope config + provider budget cap (D-11; Cerbos action `set_scope`, elevated-only)
  "search.campaign.launch", // mark a manual-mode change proposal applied OR execute an api-mode one (Cerbos actions `launch`/`apply_manual`/`apply_negatives`/`set_budget`, elevated-only)
  "search.report.approve",  // approve + deliver an engagement report (Cerbos actions `approve`/`deliver`, elevated-only)
  "search.ledger.admin",    // override a provider budget stop-loss cap (Cerbos action `admin` on resource_search_ledger, elevated-only)
  // ────────────────────────────── social-media (SMM-11) ──────────────────────────────────────────
  // Verified directly against cerbos/policies/resource_social_engagement.yaml +
  // resource_social_post.yaml (SMM-30) and role-permission-bundles.json's actual generated bundles
  // (not inferred from a module-role comment the way search's three were) — every set below is a
  // 1:1 match, per role, checked before writing it: company_admin/manager/social_manager hold every
  // permission each capability names; social_staff holds exactly the subset each capability's own
  // comment states; member/viewer hold NONE of any social.* permission (denied by both policies
  // entirely — social is a department-scoped module, not a baseline grant).
  "social.view",         // read engagements + the content calendar (Cerbos social_engagement/social_post `read`) — held by staff and manager alike
  "social.manage",       // author/edit a post and its per-network variants, record a native import (Cerbos social_post `create`/`update`/`import_native`) — staff's OWN tier, not manager-only
  "social.scope.write",  // set an engagement's tool scope + metered budget (Cerbos social_engagement `set_scope`) — manager-tier only, mirrors search.scope.write exactly
  // ⚠ Deliberately narrower than `social.manage` even though both ride the `social_post` kind:
  // Cerbos's module_staff rule grants read/create/update/submit/import_native but explicitly
  // EXCLUDES delete (resource_social_post.yaml's own header: "the manager/staff split IS the
  // publish line: staff author... the manager is the human who decides... and who can take it
  // back down"). Folding this into `social.manage` would hand every staff account a delete button
  // Cerbos will 403 — a dead button, the safe-but-wrong direction this file's own discipline (Gap-3)
  // still flags rather than accepts by default.
  "social.post.delete",  // delete an unpublished post/variant (Cerbos social_post `delete`) — manager-tier only
  // ── client review (SMM-31/32, D-16) — Cerbos kind `social_client_review`, migration `0106`.
  // Verified directly against 0106's `role_permission` seed rows (not inferred): `read`/`request` are
  // held by BOTH social_staff and social_manager (staff may ask the client and see the state);
  // `withdraw` is manager-tier ONLY (`0106` never seeds it for `social_staff`) — same staff/manager
  // split `social.post.delete` already draws for the identical reason ("staff author, the manager is
  // who can take it back down"). The CLIENT's own decision is `portal.approve_post` (a `portal.*`
  // permission, not `social.*` — DR-4/D-16) and is enforced purely server-side on the portal BFF;
  // this file has no capability for it because the portal surface does not gate writes through
  // `can()` at all (its own scope resolver is the authority, mirroring `lib/portal-data.ts`'s header).
  "social.client_review.read",     // view client sign-off state on a variant (Cerbos `read`)
  "social.client_review.request",  // ask the client to sign off, or re-ask after changes (Cerbos `request`)
  "social.client_review.withdraw", // retract a pending ask (Cerbos `withdraw`) — manager-tier only
  // ── the usage panel (SMM-22, X metering) — Cerbos kind `social_ledger`, migration `0106`.
  // Verified directly against 0106's role_permission seed rows: `social.ledger.read` is held by
  // social_staff/social_manager/company_admin/manager/platform_admin/group_executive — "a
  // department that cannot see its own spend cannot manage it" (resource_social_ledger.yaml's own
  // header). `social.ledger.admin` (override a stop-loss) is deliberately ABSENT here: no override
  // endpoint exists yet, same "don't declare a permission before its endpoint exists" rule this
  // file already follows for `social.client_review.*`/`social.report.*`.
  "social.ledger.read",
  // ── the engagement inbox (SMM-15/16/17/18) — Cerbos kind `social_inbox`, migration `0106`.
  // Verified directly against `resource_social_inbox.yaml` + `0106_iam_social_permissions.sql`'s
  // role_permission seed rows: `company_admin`/`manager`/`platform_admin`/`social_manager`/
  // `social_staff` ALL hold every one of the four actions identically — unlike client-review, this
  // is NOT a staff/manager split (the policy's own header: "a community-manager replying to
  // comments IS the job... requiring a manager for every 'thanks!' would make the inbox unusable").
  // `group_executive` holds `read` only (0106 seeds it nowhere else) — same wholesale-excepted
  // reach every other `social.*` capability gives that role via `ALL`.
  "social.inbox.read",     // the triage queue and thread view, including AI-stamped triage state
  "social.inbox.reply",    // decide a reply is SENT — outbound and public, same discipline as `social.post.publish`
  "social.inbox.assign",   // take/give ownership of a thread, set its status, start its SLA clock — NO write endpoint exists yet (see lib/socialShared.ts's InboxThread header); rendered read-only
  "social.inbox.escalate", // raise a thread to a lead — NO write endpoint exists yet either; same read-only rendering
  // ─────────── TR-25: the tracker/reporting program (§8's matrix). Mirrors, never decides. ───────────
  // ⚠ READ THIS BEFORE USING ANY `reports.*` CAPABILITY FOR ANYTHING BUT RENDERING.
  // These capabilities answer "should the UI OFFER this?", never "may this user SEE this person?". The
  // person axis — WHICH people/units a dept lead reaches — is deliberately ABSENT from this file and
  // cannot be expressed here: it depends on `org_unit_memberships` + the org tree as of a date, which
  // the browser does not have and must never be trusted to evaluate. That boundary lives in
  // `platform-nest/src/modules/reports/person-scope.ts` and is enforced server-side on every read (403
  // — the UI renders a limited-access state). So `reports.person.view` means "this role reads person
  // documents AT ALL", not "this user reads THAT person". Gate a nav item on it; never a data decision.
  "reports.person.view",      // person-grain report documents (Cerbos `read_person`) — SERVER narrows to the caller's line
  "reports.project.view",     // project-grain (Cerbos `read_project`)
  "reports.department.view",  // department-grain (Cerbos `read_department`) — SERVER narrows to the led unit subtree
  "reports.company.view",     // company-grain (Cerbos `read_company`) — exec/company_admin ONLY; §8 excludes dept lead AND HR ("person data yes, company strategy no")

  // ── finance (GM-09) ────────────────────────────────────────────────────────────────────────────
  // Mirrors `finance.statement.read` / `finance.ar.read` from platform-nest's permission catalog.
  // Holders per `role-permission-bundles.json` (regenerated 2026-08-26 and byte-identical to the
  // committed copy, so this is the live grant set, not a stale one): `company_admin`,
  // `finance_manager`, `finance_staff`, `owner`, `platform_admin`.
  //
  // ⚠ ONLY `company_admin` and `platform_admin` are mirrored below, because they are the only two of
  // those five that EXIST in this file's `Role` union. `finance_staff`, `finance_manager` and `owner`
  // are real Cerbos roles with no `Role` member at all — the same defect class as the Gap 1/2/3
  // comments on the union above, which means those principals currently resolve to ZERO capabilities
  // in the UI. That is an estate-wide gap affecting the whole `/finance` console, not just the GM
  // money tier, so it is REPORTED rather than quietly widened here: adding three roles to the union
  // changes what every capability check in the app returns for them, and that is its own ticket.
  "finance.statement.view",   // P&L / balance sheet / trial balance (Cerbos `finance_statement:read`)
  "finance.ar.view",          // receivables + aging (Cerbos `finance_ar:read`)
  "reports.period.seal",      // seal / amend / pin a period (Cerbos `seal`/`amend`/`pin` on report_period) — exec/company_admin only; dept lead ⛔
  "reports.facts.admin",      // rebuild the fact fabric (Cerbos `recompute` on report_admin) — exec/company_admin only; a lead who re-derives a window moves their own team's appraisal inputs
  "reports.ops.poll",         // the n8n reminder/escalation reads (Cerbos `pending_reminders`/`missed_by_unit`) — company_admin ONLY, not a human console
  "checkin.read",             // read others' check-in history + the compliance grid (Cerbos `read`) — SERVER narrows to the caller's line
  "checkin.excuse",           // excuse a missed day (Cerbos `excuse`) — rewrites an appraisal-SAFE metric, so hr_manager not hr_staff
  "appraisal.read",           // read appraisal packs beyond one's own (Cerbos `read`)
  "appraisal.score",          // write/submit scores (Cerbos `write`/`submit`) — the ASSIGNED manager only; server narrows to manager_user_id
  "appraisal.cycle.admin",    // cycle CRUD + generate + finalize (Cerbos `cycle_admin`/`finalize`) — hr_manager ONLY (TR-25 finding ②)

  // ── monitoring (MON-20, 2026-09-02) — closes the "nobody can create a channel or a route" gap.
  // Key spelling matches monitoring-program.md §14's permission table exactly (`monitoring.channel.
  // manage`, `monitoring.maintenance.create`/`.delete`) — dotted `<domain>.<resource>.<action>`, not
  // an invented shorthand. Deliberately NOT adding `monitoring.monitor.*` / `monitoring.incident.*` /
  // `monitoring.status_page.*` here even though the same table documents them: no page in this
  // change reads those, and this file's own discipline ("a capability is added when a UI reads it,
  // never speculatively" — see the finance_staff/manager comment above) applies just as much to a
  // module's first capabilities as to its later ones.
  "monitoring.channel.manage",      // create/edit/enable/disable/delete a channel, send a test notification, and create/edit/delete the routes that point at one — `sensitive: true` server-side (channels carry secret references and a test send is a real outward notification). No separate `monitoring.route.*` key exists in the backend's permission table; a route is the channel's own delivery config, so it rides the same grant.
  "monitoring.maintenance.create",  // schedule a maintenance window — suppresses alerting AND SLA math while it runs, `sensitive: true` server-side. This is the "hide an outage" direction (§14).
  "monitoring.maintenance.delete",  // cancel a window early — ends suppression, not conceal it, so the backend does NOT mark it sensitive. Kept as its own capability rather than folded into `.create` for the identical reason those two are separate Cerbos actions: granting cancel should not require granting the power to start a window that pages nobody.
] as const;

export type Capability = (typeof CAPABILITIES)[number];

// What each role grants (within its own scope). Order/duplication is harmless. `ALL` is every
// capability there is — see the header comment on `CAPABILITIES` above for why this is a `const`
// copy of that tuple rather than a second hand-written list.
const ALL: Capability[] = [...CAPABILITIES];

// TR-25 — the §8 tiers as capability bundles, so each role below reads as one line rather than a
// 12-item list, and a drift between two roles that should share a tier is visible.
//
// `group_executive` is in ALL above (owner tier, unrestricted). The three bundles here cover the
// columns §8 actually distinguishes:
//   REPORT_READS      — the per-grain document reads shared by dept-lead and BOTH HR tiers.
//   EXEC_ONLY_REPORTS — company grain + seal/amend + facts recompute. §8 excludes dept lead from all
//                       three; HR too. `company_admin` holds them as the tenant's own administrator.
//   HR_OPS            — the ACTING HR tier (hr_manager). See finding ② below.
const REPORT_READS: Capability[] = ["reports.person.view", "reports.project.view", "reports.department.view"];
const EXEC_ONLY_REPORTS: Capability[] = ["reports.company.view", "reports.period.seal", "reports.facts.admin"];
const HR_OPS: Capability[] = [
  "checkin.excuse", "appraisal.cycle.admin",
  // HR-FULL: the three new kinds' WRITE + APPROVE tiers are `hr_people_ops`, which derived_roles.yaml
  // defines as hr_manager ONLY (not hr_staff). Adding them to HR_OPS rather than to hr_manager's
  // literal list keeps that "acting tier" grouping intact — it is the same set TR-25 established.
  //
  // `hr.policy.ratify` is NOT here, deliberately: resource_hr_policy.yaml grants ratify to
  // company_admin alone. Ratification declares the statutory numbers verified and unblocks paying
  // people against them; it is an accountability act, not an HR-operations one.
  "hr.policy.manage",
  "hr.recruitment.manage", "hr.recruitment.approve",
  "hr.payroll.view", "hr.payroll.manage", "hr.payroll.approve",
];

/** The READ tier both HR roles hold: configuration and the recruitment pipeline, never payroll. */
const HR_BASELINE_READS: Capability[] = ["hr.policy.view", "hr.recruitment.view"];
export const ROLE_CAPS: Record<Role, Capability[]> = {
  platform_admin: ALL,
  company_admin: [
    "admin.access", "company.manage", "org.edit", "people.directory", "pm.manage", "pm.contribute", "it.manage", "approvals.decide", "approvals.retry", "knowledge.review",
    // IAM-02a-FIX-2 — company_admin appears in every one of the five backing policies for these three
    // (resource_pipeline_run/stage/gate.yaml, resource_scope_signoff.yaml,
    // resource_webdev_provisioned_site.yaml), same as it always did for `approvals.decide`'s own
    // three policies. Nothing changes for company_admin here — it already had these via the old
    // over-broad `approvals.decide` mapping; this just keeps them held under the correctly-split name.
    "pipeline.write", "pipeline.manage", "webdev.provision", "github.link",
    "hr.view", "hr.manage",
    // HR-FULL: company_admin is named in every rule of all three new policies, ratify included.
    // LMS: company_admin is named in every rule of both LMS policies.
    "lms.catalogue.view", "lms.authoring", "lms.publish",
    "lms.progress.view", "lms.assign", "lms.grade", "lms.waive",
    "hr.policy.view", "hr.policy.manage", "hr.policy.ratify",
    "hr.recruitment.view", "hr.recruitment.manage", "hr.recruitment.approve",
    "hr.payroll.view", "hr.payroll.manage", "hr.payroll.approve",
    "search.view", "search.manage", "search.scope.write", "search.campaign.launch", "search.report.approve", "search.ledger.admin",
    // company_admin holds the FULL social manager-tier bundle (role-permission-bundles.json: every
    // permission social_manager holds, company_admin holds identically — same Cerbos rule lists
    // company_admin alongside module_manager on every social_engagement/social_post action).
    "social.view", "social.manage", "social.scope.write", "social.post.delete",
    // client-review (SMM-31/32) — 0106 seeds company_admin all three, same manager-tier bundle.
    "social.client_review.read", "social.client_review.request", "social.client_review.withdraw",
    // the engagement inbox (SMM-15/16/17/18) — 0106 seeds company_admin all four inbox actions.
    "social.inbox.read", "social.inbox.reply", "social.inbox.assign", "social.inbox.escalate",
    // the usage panel (SMM-22) — 0106 seeds company_admin BOTH social.ledger.read AND .admin, but
    // only `.read` is declared on the module contract yet (no override endpoint exists).
    "social.ledger.read",
    // The tenant's own administrator holds the exec-only reporting tier within its company (§8's
    // company-grain / seal / recompute rows read "exec"; resource_report_period.yaml's header
    // establishes that §6.2's "lead" there means the COMPANY's lead, not a per-department manager).
    ...REPORT_READS, ...EXEC_ONLY_REPORTS, "reports.ops.poll", "checkin.read", "checkin.excuse", "appraisal.read",
    // GM-09: the tenant's own administrator holds the finance read tier in the bundles.
    "finance.statement.view", "finance.ar.view",
    // MON-20: every monitoring resource policy names `company_admin` alongside `monitoring_manager`
    // (monitoring-program.md §13.2's probe table) — the tenant admin holds the manager tier here too.
    "monitoring.channel.manage", "monitoring.maintenance.create", "monitoring.maintenance.delete",
  ],
  // §8's "Dept lead (own unit)" column. Reads person/project/department — NEVER company grain, NEVER
  // seal/amend, NEVER facts recompute, NEVER the n8n ops polls, NEVER cycle admin. May score the
  // appraisals they are ASSIGNED (the server narrows to `manager_user_id`; this only decides whether
  // the scoring UI renders at all).
  // IAM-02a-FIX / DR-1 (owner-decided 2026-08-10, drift register finding #5) — `approvals.decide`
  // REMOVED. VERIFIED: `resource_automation_approval.yaml`'s `decide`/`retry` rule is
  // `derivedRoles: ["company_admin", "group_executive"]` and its own comment says so explicitly
  // ("A plain `manager` is deliberately excluded from both"); `resource_agency_approval.yaml`'s
  // `approve` rule is `["company_admin", "module_approver"]`; `resource_pipeline_gate.yaml`'s
  // `decide` rule is `["company_admin", "group_executive"]`. `manager` appears in NONE of the three
  // policies this capability gates a decision on. Before this fix, 11 live managers (IAM-02a-0) saw
  // an Approve/Reject/Decide control on the general approvals inbox
  // (`app/(app)/approvals/[id]/page.tsx`'s `mayDecide`) and every pipeline-gate decide action
  // (`pipeline/page.tsx`, `pipeline/[runId]/page.tsx`) that 403'd every single time — a fully dead
  // button, not a partial gap. Cerbos is UNCHANGED; this is a mirror-only correction, so removing it
  // grants nothing and takes away nothing a manager could actually do.
  //
  // ✅ IAM-02a-FIX-2 (2026-08-10) — RESOLVED the collateral damage flagged above. `approvals.decide`
  // was ALSO the sole UI gate for 8 `pipelineActions.ts`/`webdevProvisionedSitesActions.ts` server
  // actions that mirror Cerbos actions `manager` genuinely DOES hold — `pipeline_stage:update`
  // (editStageArtifactAction), `scope_signoff:create` (recordScopeSignoffAction),
  // `pipeline_run:create`/`update` (createRunAction/updateRunStatusAction),
  // `pipeline_stage:create` (createStageAction), `pipeline_gate:create` (openGateAction), and
  // `webdev_provisioned_site:provision`/`reconcile` (provisionSiteAction/reconcileSiteAction) — all
  // re-verified directly against their resource policy files (see the `pipeline.write`/
  // `pipeline.manage`/`webdev.provision` comments on `CAPABILITIES` above for the exact role sets and
  // per-policy citations). `approvals.decide` had been doing double duty for two Cerbos tiers that are
  // NOT the same set — "the elevated DECIDE tier" (company_admin/group_executive/module_approver only)
  // and "the elevated pipeline/webdev WRITE tier" (company_admin/manager/group_executive, sometimes
  // member) — and DR-1's removal was correct for the first and an accurate over-correction for the
  // second. The fix is the three new capabilities below, NOT restoring `approvals.decide` to
  // `manager` — DR-1 stands: Cerbos still denies `manager` on all three genuine decide surfaces, so
  // `approvals.decide` is deliberately absent from this list. `relinkOrphanRecordingsAction` remains
  // correctly ungranted: its Cerbos action (`meeting_recording:relink`) is `company_admin`-only, so
  // manager never had it and loses nothing.
  manager: [
    "pm.manage", "pm.contribute", "people.directory",
    "pipeline.write", "pipeline.manage", "webdev.provision", "github.link",
    // Gap 3 (2026-08 sweep): resource_integration_connection.yaml's "company.manage tier" rule
    // (its own header's name for the rule) explicitly lists `company_admin` AND `manager` for
    // managing company-owned connection rows / other people's seats — `departments/[deptId]/
    // connections/actions.ts::adminMapSeatAction` already documents this as "Only managers/admins
    // can map another person's seat." `manager` was missing `company.manage` here, so that button
    // was silently hidden from every manager even though the backend would have allowed it (the
    // dangerous under-grant direction). Widening it also surfaces the Invoices/Company-edit/
    // automation-retry affordances to managers — those backing resources (resource_invoice.yaml,
    // resource_company.yaml, resource_automation_approval.yaml's `retry`) are company_admin-only,
    // so a manager will now see those buttons and get a clean 403 on the ones Cerbos still
    // reserves for company_admin. That is the SAFE direction per this ticket's framing (a visible
    // refusal, never a silent one) — flagged here as the judgement call it is, not asserted as
    // risk-free in every one of `company.manage`'s several consuming surfaces.
    "company.manage",
    // manager's bundle matches company_admin's on every social.* permission this file cites — same
    // Cerbos rule (`company_admin, manager` on both social_engagement and social_post), verified.
    "social.view", "social.manage", "social.scope.write", "social.post.delete",
    // client-review (SMM-31/32) — 0106 seeds manager all three, same manager-tier bundle.
    "social.client_review.read", "social.client_review.request", "social.client_review.withdraw",
    // the engagement inbox (SMM-15/16/17/18) — 0106 seeds manager all four inbox actions.
    "social.inbox.read", "social.inbox.reply", "social.inbox.assign", "social.inbox.escalate",
    // the usage panel (SMM-22) — 0106 seeds manager `read` only (NOT `.admin` — see resource_social_
    // ledger.yaml's own header: the override sits one tier up, with company_admin).
    "social.ledger.read",
    ...REPORT_READS, "checkin.read", "checkin.excuse", "appraisal.read", "appraisal.score",
    // MON-20 — the second-gap fix recorded in monitoring-program.md §13.1 found `manager` holding
    // ZERO monitoring bundle rows despite every monitoring policy naming it explicitly (19 rows were
    // added there: "manager: all 14"). This mirrors that live finding, not a guess.
    "monitoring.channel.manage", "monitoring.maintenance.create", "monitoring.maintenance.delete",
  ],
  // A plain member's own report, own check-in and own appraisal are NOT capabilities — they are
  // self-service, gated server-side by `ownerId`/`subjectUserId == principal.id` (§11 principle 2:
  // "nothing about you that you cannot read"). Adding a capability for them here would imply the UI
  // decides, and would have to be granted to everyone, which tells a gating check nothing.
  //
  // IAM-02a-FIX / DR-2a (owner-decided 2026-08-10, drift register finding #3) — `people.directory`
  // ADDED. Same precedent this file already used to justify `team_lead`'s grant above: no Cerbos
  // resource literally models "browse the staff directory", but `resource_member.yaml`'s baseline
  // tenant-directory `read` rule is the closest — and only — signal, and it lists `member`/`viewer`
  // on the SAME line as `company_admin`/`manager`/`team_lead` ("any in-tenant role may read it," the
  // file's own comment says). Before this, 18 live `member`-only accounts (IAM-02a-0) could not open
  // `/hr/people` (`app/(app)/hr/people/page.tsx:29` gates on `can(me, "people.directory", tenant) ||
  // isElevated(me)`) even though Cerbos's only opinion on the question says they could. `viewer` gets
  // the same grant on the identical reasoning, though it is currently THEORETICAL — no live holder,
  // no seeded `roles` row (see the `Role` union's `viewer` comment) — so this closes the mirror gap
  // without yet having a real account to observe it against.
  //
  // IAM-02a-FIX-2 — `pipeline.write` ADDED. Verified against all three backing policies (see the
  // `pipeline.write` comment on `CAPABILITIES` above): resource_pipeline_run.yaml (`create`/`update`),
  // resource_pipeline_stage.yaml (`create`), resource_pipeline_gate.yaml (`create`) all list `member`
  // alongside `company_admin`/`manager` under the identical `inTenant && notLow` condition. `member`
  // does NOT get `pipeline.manage` or `webdev.provision` — both of those policies explicitly exclude
  // `member` (see those two capabilities' comments above); a plain member may open a gate, advance a
  // run, or add a stage, but may not edit a signed artifact, sign the agency's scope commitment, or
  // provision infrastructure.
  // LMS-L1: `member` genuinely holds the catalogue read UNCONDITIONALLY —
  // resource_lms_course.yaml names `member` in its read rule, because training you cannot see
  // is a support ticket. Unlike the enrolment keys (which member holds only self-scoped), this
  // one is real unconditional reach and therefore belongs in the mirror.
  member: ["pm.contribute", "people.directory", "pipeline.write", "lms.catalogue.view"],
  // Gap 3 find — see the `Role` union's `viewer` comment for the full evidence trail. Matches
  // `member`'s ORIGINAL two capabilities exactly: `pm.contribute` + `people.directory` (DR-2a above).
  // Deliberately does NOT also pick up `member`'s IAM-02a-FIX-2 `pipeline.write` grant: `viewer` is
  // absent from resource_pipeline_run/stage/gate.yaml entirely (unlike `people.directory`'s baseline
  // read rule, no pipeline policy lists `viewer` on the same line as `member`), so there is no Cerbos
  // signal to justify it — granting it here would be exactly the "guess, not evidence" this file's
  // own discipline forbids. `viewer` and `member` are therefore no longer capability-identical, on
  // purpose; a future reader diffing the two should read this comment before "fixing" the gap back in.
  // excluded from every write rule this file gates other than pm_task's read+update).
  viewer: ["pm.contribute", "people.directory"],
  // IAM-DR67 / DR-6 (owner-decided 2026-08-10, drift register finding #7) — `company.manage`
  // REMOVED. Verified directly against the backing policies: `it_admin`'s entire Cerbos reach is
  // `resource_device.yaml`'s three `it.device.*` actions (create/update/delete) — ZERO overlap with
  // `company.manage`'s ANY-of-ten set (`core.integration_connection.*`, `core.company.update`,
  // `invoice.*`, `core.automation_approval.retry`; see that capability's own comment on
  // `CAPABILITY_MAP` above). IT administers devices and accounts, not company settings / module
  // enablement / invoicing / automation retry. Same class of over-claim as DR-1 (a dead button, 1
  // live holder per IAM-02a-0's live query) — independently recommended by the IAM-05b design
  // ruling (§7 item 2) as a "known first-run red," and confirmed here rather than assumed. Cerbos
  // is unchanged; this is a mirror-only correction. `it_admin` keeps `it.manage`.
  it_admin: ["it.manage"],
  it_manager: ["it.manage"],
  it: ["it.manage"],
  // ⚠ TR-25 finding ② — THE HR SPLIT, mirrored. `hr_staff` is the BASELINE read tier and `hr_manager`
  // the ACTING tier, exactly as this file already modelled `hr.view` vs `hr.manage`. TR-13's Cerbos
  // derived role had collapsed them (`hr_people_ops` == hr_staff OR hr_manager), which handed
  // appraisal cycle admin + finalize + every appraisal pack to HR rank-and-file — including, via the
  // service reconciler, on SERVED companies they do not work for. Cerbos is now split
  // (`hr_people_reader` vs `hr_people_ops`) and this mirror matches it: `hr_staff` reads person-grain
  // reports and check-in history (that IS `hr.view`-shaped work) but holds NO appraisal capability and
  // cannot excuse a missed day (which rewrites an appraisal-SAFE metric).
  // IAM-DR67 / DR-7 (owner-decided 2026-08-10) — `people.directory` ADDED to hr_staff (and, below,
  // search_staff/reports_staff — the three `module_staff`-tier roles, NOT their `_manager`
  // siblings). `resource_member.yaml`'s `module_staff` rule (lines 21-24) grants tenant-directory
  // `read` UNCONDITIONALLY to any module_staff-derived role — gated only on `inTenant && notLow`
  // and the module attribute being present, no self/`owns` clause at all. This is a genuinely
  // different signal from the self-service `owns`-conditioned entries the parity guard's
  // `KNOWN_NON_DRIFT` register carries for other roles: the rule itself carries no condition
  // narrower than "any served-company module_staff." Only `module_staff` is named in that rule
  // (`module_manager` is not), so `_manager` tiers are deliberately NOT widened here — Cerbos gives
  // them no independent signal for this capability, and IAM-02a-FIX-2's own discipline is to grant
  // exactly what a cited policy says, never by inference from a sibling role. All three roles have
  // 0 live holders today (IAM-02a-0's census), so this closes the mirror gap before HR/search/
  // reports staffing exists, rather than after — same precedent as DR-2a (`member`/`viewer`).
  // HR-FULL: hr_staff gains the two BASELINE reads and nothing else — notably NOT hr.payroll.view.
  // That is the whole point of the hr_payroll/hr_record split: an HR assistant who files leave and
  // uploads contracts has no business reading the company's salary book.
  // LMS-L1: the HR tiers hold LMS keys BY DESIGN — resource_lms_enrollment.yaml names
  // `hr_people_reader` on read and `hr_people_ops` on the write/grade/waive rules, because HR
  // owns company-wide training compliance ("has everyone passed the mandatory track"). Missing
  // these was a mirror omission caught by rbac-capability-parity.test.ts, not a design change.
  hr_staff: ["hr.view", "lms.progress.view", ...HR_BASELINE_READS, ...REPORT_READS, "checkin.read", "people.directory"],
  hr_manager: ["hr.view", "hr.manage",
               "lms.progress.view", "lms.assign", "lms.grade", "lms.waive",
               ...HR_BASELINE_READS, ...REPORT_READS, "checkin.read", "appraisal.read", ...HR_OPS],
  // search_staff = Cerbos module_staff (draft-only baseline: read/create/update, propose_change,
  // research/run — never launch/set_scope/approve/admin). search_manager = module_manager (adds
  // the elevated actions). Mirrors hr_staff/hr_manager's split exactly (SM-03).
  // DR-7 — `people.directory` ADDED (see hr_staff's comment above for the full citation; identical
  // reasoning, same `module_staff` rule, `search_manager` deliberately excluded for the same reason).
  search_staff: ["search.view", "search.manage", "people.directory"],
  search_manager: ["search.view", "search.manage", "search.scope.write", "search.campaign.launch", "search.report.approve", "search.ledger.admin"],
  // social_staff = Cerbos module_staff on social_engagement (read only — NOT create/update/
  // delete/set_scope, unlike search's engagement policy) and on social_post (read/create/update/
  // submit/import_native — NOT delete/publish/cancel/delete_published). Both verified directly
  // against role-permission-bundles.json's generated `social_staff` bundle (17 permissions) rather
  // than inferred from a comment: `social.manage` (post create/update/import_native) is held;
  // `social.post.delete` and `social.scope.write` are NOT — the manager/staff split IS the publish
  // line (resource_social_post.yaml's own header). DR-7 precedent — `people.directory` added on the
  // identical `module_staff` tenant-directory baseline rule search_staff/hr_staff already cite.
  // client-review (SMM-31/32): 0106 seeds social_staff `read`+`request` only, NOT `withdraw` —
  // verified directly against the migration's role_permission rows, same staff/manager split
  // `social.post.delete` already draws.
  // the engagement inbox (SMM-15/16/17/18): UNLIKE client-review, `0106` seeds social_staff ALL
  // FOUR inbox actions (read/reply/assign/escalate) — `resource_social_inbox.yaml`'s own header
  // states why this is not a staff/manager split ("a community-manager replying to comments IS the
  // job... requiring a manager for every 'thanks!' would make the inbox unusable").
  social_staff: [
    "social.view", "social.manage", "people.directory", "social.client_review.read", "social.client_review.request",
    "social.inbox.read", "social.inbox.reply", "social.inbox.assign", "social.inbox.escalate",
    // the usage panel (SMM-22) — 0106 seeds social_staff `read` ("a department that cannot see its
    // own spend cannot manage it" — resource_social_ledger.yaml's own header, staff-tier by design).
    "social.ledger.read",
  ],
  // social_manager = Cerbos module_manager: every social_staff permission PLUS
  // social.engagement.create/update/delete/set_scope and social.post.delete/publish/cancel/
  // delete_published (32-permission bundle). `social.scope.write` and `social.post.delete` are
  // this role's OWN tier — deliberately excluded from social_staff above. client-review `withdraw`
  // is the identical split (0106 seeds social_manager all three, social_staff only two). The inbox
  // actions are NOT split this way — social_manager holds the identical four social_staff already does.
  social_manager: [
    "social.view", "social.manage", "social.scope.write", "social.post.delete",
    "social.client_review.read", "social.client_review.request", "social.client_review.withdraw",
    "social.inbox.read", "social.inbox.reply", "social.inbox.assign", "social.inbox.escalate",
    // the usage panel (SMM-22) — 0106 seeds social_manager `read` (NOT `.admin`, same override-sits-
    // one-tier-up reasoning as `manager` above).
    "social.ledger.read",
  ],
  // §8's served-dept column: department + project grain ONLY. Deliberately NO `reports.person.view`
  // — §8's person-grain cell for this column ("only persons acting under the assignment, via the
  // provider view") is NOT enforceable, because no endpoint can bound a person read that way, so
  // granting it would expose ARBITRARY served-company persons. Cerbos denies it; this mirrors that.
  // Also no company grain, no appraisals, no check-ins, no seal, no recompute (§8: all ⛔).
  // DR-7 — `people.directory` ADDED (see hr_staff's comment above; identical `module_staff` rule,
  // `reports_manager` deliberately excluded for the same reason).
  reports_staff: ["reports.department.view", "reports.project.view", "people.directory"],
  reports_manager: ["reports.department.view", "reports.project.view"],
  // HIER-2 — exactly its two bundled permissions, no more. See the `Role` union comment above for
  // why the rest of the reports family is deliberately excluded.
  // LMS-L1: the department head authors, publishes and grades for their OWN unit — this is how
  // the owner's "each HOD makes more" requirement is expressed, and it needed no new role.
  // `lms.waive` is deliberately ABSENT: a lead must not be able to excuse their own team from
  // the company's mandatory training. `lms.catalogue.view` is absent too, for a subtler reason
  // — a lead browses the catalogue through their MEMBER grant at COMPANY scope, not through
  // org_unit_lead at unit scope (see principal-scope-constrained-perms.db.test.ts).
  org_unit_lead: ["reports.department.view", "appraisal.read",
                  "lms.authoring", "lms.publish", "lms.progress.view", "lms.assign", "lms.grade"],
  // IAM-02a-FIX / DR-2b — see the `Role` union's `agency_approver` comment for the full trail. Its
  // ENTIRE verified Cerbos reach is `agency_approval:approve` (via `module_approver`, module always
  // `"agency"`) — nothing else, not even `agency_approval:read` (that baseline rule names
  // `company_admin`/`manager`/`member`/`viewer` explicitly, never `module_approver`). The UI's own
  // per-approval decide surface (`app/(app)/approvals/[id]/page.tsx`'s `mayDecide`) gates BOTH
  // `automation_approval` and `agency_approval` decisions through the identical `approvals.decide`
  // capability + `/decide` façade — there is no finer-grained capability in this file that means
  // "approve only an agency_approval" — so `approvals.decide` is the correct, non-invented mapping
  // for what Cerbos actually grants this role, not a copy of `manager`'s old (removed, DR-1) grant or
  // of `company_admin`'s broader one.
  //
  // ⚠ Read this alongside DR-1 above: `approvals.decide` was just REMOVED from `manager` because
  // Cerbos denies `manager` on all three policies it gates. Cerbos ALSO denies `agency_approver` on
  // two of those three (`automation_approval:decide`/`retry` and `pipeline_gate:decide` — neither
  // names `module_approver`), so this role's `can(me, "approvals.decide", …) === true` only actually
  // resolves to an ALLOW at the backend for the one policy that does (`agency_approval:approve`); the
  // other two 403 exactly as they would for anyone else without `company_admin`/`group_executive`.
  // That is not a mirror bug and not an inconsistency to "fix" by mimicking `manager`'s exclusion or
  // widening this role to something narrower — one UI capability legitimately covers a role that
  // Cerbos allows on a strict subset of what the capability's Cerbos-side actions are. A future
  // reader diffing `manager` (0 of 3) against `agency_approver` (1 of 3, both non-zero-but-partial)
  // should not conclude either grant is wrong from that shape alone.
  agency_approver: ["approvals.decide"],
  // ── F17 ─────────────────────────────────────────────────────────────────────────────────────────
  // DERIVED, not authored. Each list is exactly the set of capabilities whose `CAPABILITY_MAP` entry
  // is satisfied by that role's bundle in `platform-nest/src/rbac/role-permission-bundles.json`, so
  // `rbac-capability-parity.test.ts`'s biconditional holds by construction. To regenerate after a
  // policy change: for each capability, evaluate its map entry ("all" = every permission held, "any"
  // = at least one) against the role's bundle. Do NOT hand-edit these to "look right" — a guess here
  // is precisely what the parity guard exists to catch.
  finance_staff: ["finance.statement.view", "finance.ar.view"],
  // Identical to finance_staff today. The manager tier's extra reach (post, reverse, close, approve,
  // write-off, waive) is real in Cerbos but has no capability in this file yet, because no UI reads
  // it — see the union comment.
  finance_manager: ["finance.statement.view", "finance.ar.view"],
  // MON-20 — `monitoring_staff` holds NONE of the three write capabilities, per the §13.2 probe:
  // ALLOW on `monitor:read`/`create`/`incident:acknowledge`, DENY on `channel:manage` and
  // `maintenance:create`. `maintenance:delete` was not itself probed, but it is the SAME
  // `monitor_maintenance` kind the probe denied `staff` on for `create` (module_staff is not named
  // in that policy's elevated-action rule at all), so granting delete here without evidence would be
  // exactly the "guess, not evidence" this file's own discipline forbids — left out until a real
  // bundle or a probe says otherwise. Staff can still run the desk (acknowledge incidents, read
  // everything); they cannot touch delivery config or suppress alerting.
  monitoring_staff: [],
  // `monitoring_manager` — Cerbos module_manager for `resource.attr.module === "monitoring"`. The
  // §13.2 probe ALLOWed `monitor:delete`/`maintenance:create`/`status_page:publish` for this role
  // directly; `channel:manage` is inferred from the SAME module_manager pattern every other module in
  // this file uses (hr/search/social: manager tier gets what staff tier is denied), not probed
  // independently — flagged here rather than asserted as verified, since MON-20 has no live bundle.
  monitoring_manager: ["monitoring.channel.manage", "monitoring.maintenance.create", "monitoring.maintenance.delete"],
  owner: [
    "admin.access", "appraisal.read", "approvals.decide", "approvals.retry", "checkin.excuse",
    "checkin.read", "company.manage", "finance.ar.view", "finance.statement.view", "hr.manage",
    "hr.payroll.approve", "hr.payroll.manage", "hr.payroll.view", "hr.policy.manage", "hr.policy.ratify",
    "hr.policy.view", "hr.recruitment.approve", "hr.recruitment.manage", "hr.recruitment.view", "hr.view",
    "it.manage", "knowledge.review", "lms.assign", "lms.authoring", "lms.catalogue.view", "lms.grade",
    "lms.progress.view", "lms.publish", "lms.waive", "org.edit", "people.directory", "pipeline.manage",
    "pipeline.write", "pm.contribute", "pm.manage",
    // MON-20: the holding-wide business authority holds the monitoring manager tier too.
    "monitoring.channel.manage", "monitoring.maintenance.create", "monitoring.maintenance.delete",
    "reports.company.view", "reports.department.view",
    "reports.facts.admin", "reports.ops.poll", "reports.period.seal", "reports.person.view",
    "reports.project.view", "search.campaign.launch", "search.ledger.admin", "search.manage",
    "search.report.approve", "search.scope.write", "search.view", "social.client_review.read",
    "social.client_review.request", "social.client_review.withdraw", "social.inbox.assign",
    "social.inbox.escalate", "social.inbox.read", "social.inbox.reply", "social.ledger.read",
    "social.manage", "social.post.delete", "social.scope.write", "social.view", "webdev.provision",
    "github.link",
  ],
};

type Grant = Me["roles"][number];

// Does a grant's scope cover the target company? A global grant covers
// everything. With no companyId (a cross-company question) only global counts.
// A company grant must match the granted company EXACTLY — a null/absent
// scopeId is NOT a wildcard for "any company" (that over-grants; A4). An
// org_unit (or project) grant is scoped to its own node, not the whole company:
// `can()` only reasons about companyId, so a unit-scoped grant can never
// resolve "yes, this company" from here — it must not blanket-cover
// company-wide capabilities (A4). Unit-level checks (e.g. `org_unit_lead`'s
// subtree cascade) belong to the server, which actually has the ancestor list.
function scopeCovers(g: Grant, companyId?: string | null): boolean {
  if (g.scopeType === "global") return true;
  if (companyId == null) return false;
  if (g.scopeType === "company") return g.scopeId != null && g.scopeId === companyId;
  return false;
}

export function can(me: Me, cap: Capability, companyId?: string | null): boolean {
  return me.roles.some((g) => {
    const caps = ROLE_CAPS[g.role as Role];
    return !!caps && caps.includes(cap) && scopeCovers(g, companyId);
  });
}

// "Elevated" = a global superadmin grant. Kept as a named concept because several surfaces
// (People directory, org editing default) key off it.
//
// ⚠ IAM-15 narrowed this to ONE role, and it must mirror the backend: `src/admin/elevated.ts` is
// `platform_admin` at global scope and nothing else. `owner` is deliberately NOT here — D-8 gives it
// no platform/system controls, and this program's rule is that the UI is a MIRROR of the server's
// authorization, never a second opinion.
const ELEVATED = new Set<Role>(["platform_admin"]);
export function isElevated(me: Me): boolean {
  return me.roles.some((r) => ELEVATED.has(r.role as Role) && r.scopeType === "global");
}

// Access tiers requested by the org:
// • UNRESTRICTED — owner (group_executive) + superadmin (platform_admin): may do anything, anywhere.
// • VIEW-ALL — same set as UNRESTRICTED today. There used to be a second,
//   narrower "view every company but not unrestricted" tier (`holding_head`,
//   people.directory + rollups.view only) — removed per the backbone-program
//   plan's A4 amendment: ORG-7/ORG-12's `serviceScopes` (a real, module-scoped,
//   consent-based grant materialized by the reconciler) supersedes the old
//   blanket "view everything" role. Cross-company oversight now happens
//   through an actual service assignment (Me.serviceScopes) or a normal
//   company/global grant — never a free-floating "can see all" role.
export function isUnrestricted(me: Me): boolean {
  return isElevated(me);
}
export function canViewAllCompanies(me: Me): boolean {
  return isUnrestricted(me);
}

// WS11: an external client (client-portal user). Gated by a `client` grant; drives portal-only nav.
// The real boundary is the portal BFF (client role + run ownership); this is nav/visibility.
export function isClient(me: Me): boolean {
  return me.roles.some((r) => r.role === "client");
}

/** Any staff grant at all — i.e. any role that is not `client`.
 *
 *  This is the correct companion to `isClient` for deciding "is this person EXTERNAL ONLY", and it
 *  replaces an `isElevated` check that was subtly wrong: `isElevated` is only global `platform_admin`
 *  / `group_executive`, so `isClient && !isElevated` classified a **manager or company_admin who is
 *  also a client contact** as an external client. `navFor` used that pair and handed such a person
 *  portal-only navigation, losing the entire staff surface. A PM added as a contact on their own
 *  client is an ordinary thing to do, so this was reachable, not theoretical.
 *
 *  Deliberately "has any non-client role" rather than a list of staff roles: a role added later is
 *  staff by default, which fails toward keeping someone's workspace rather than silently taking it. */
export function isStaff(me: Me): boolean {
  return me.roles.some((r) => r.role !== "client");
}

/** External client with no staff standing — the one case that gets the portal instead of the app. */
export function isClientOnly(me: Me): boolean {
  return isClient(me) && !isStaff(me);
}

// Can this user manage IT? Against a specific company when given; otherwise
// "anywhere" (used for nav visibility before a company is fixed).
export function canManageIT(me: Me, companyId?: string | null): boolean {
  if (companyId != null) return can(me, "it.manage", companyId);
  return me.roles.some((g) => ROLE_CAPS[g.role as Role]?.includes("it.manage"));
}

// The companies a user may switch between. The backend already returns only the
// companies the user can access in `me.companies`; a global (elevated) role can
// reach all of them, a company-scoped user reaches the ones they're granted in.
export function accessibleCompanies(me: Me): { id: string; name: string; type: string | null }[] {
  // Unrestricted (owner/superadmin) AND view-all (holding head-of-department)
  // reach every company under the holding — the switcher lists them all.
  if (canViewAllCompanies(me)) return me.companies;
  const scoped = new Set(
    me.roles.filter((g) => g.scopeType === "company" && g.scopeId).map((g) => g.scopeId as string),
  );
  // If the user has any company-scoped grants, prefer that set; else fall back
  // to full membership (e.g. plain members who belong to one company).
  const filtered = me.companies.filter((c) => scoped.has(c.id));
  return filtered.length > 0 ? filtered : me.companies;
}

// True when the switcher should offer a choice (vs. a static label).
export function canSwitchCompany(me: Me): boolean {
  return accessibleCompanies(me).length > 1;
}

// UX-2 §1.3 — Command Center (manager-tier) vs Queue+Agenda hybrid (everyone
// else). Keyed on role, not capability, so it's a simple lookup independent
// of scope/company. Deliberately does NOT include `holding_head` (D-UX-4 /
// the backbone A4 amendment already dropped that role from rbac.ts entirely —
// see `isUnrestricted`'s comment above; ORG-7/ORG-12 `serviceScopes` replaced
// it, and a served-company grant doesn't by itself imply manager-tier framing).
const MANAGER_TIER = new Set<Role>([
  // IAM-15: `group_executive` dropped with the role.
  "platform_admin", "company_admin", "manager", "it_admin", "it_manager",
]);

// "Any grant qualifies," not "every grant qualifies" — a user holding a
// manager-tier grant in one company and a plain `member`/`it`/`hr_*` grant in
// another still gets Command Center (UX-2 §1.3, explicit tie-break).
export function isManagerTier(me: Me): boolean {
  return me.roles.some((r) => MANAGER_TIER.has(r.role as Role));
}
