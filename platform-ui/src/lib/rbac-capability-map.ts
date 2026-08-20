// Capability → permission map (IAM-05b-2) — the table that will later let `can()` evaluate
// CUSTOM ROLES (owner decision D-1, Phase 4) from a principal's RESOLVED PERMISSIONS instead of a
// role name. `ROLE_CAPS` in `rbac.ts` is role-keyed and can structurally never serve a role
// composed in the UI (a custom role doesn't exist as a member of `Role`); this map is the missing
// evaluation table. Full ruling: `docs/superpowers/plans/2026-08-10-iam-05b-design.md` (§3, §3.4)
// and the ticket itself (§5, IAM-05b-2). PLANNED / data-only at this stage — nothing in `rbac.ts`
// changes, `can()`'s signature and all ~188 call sites are untouched, and no authorization
// decision changes anywhere. This file carries NO runtime import from `rbac.ts` — only a
// type-only import of `Capability`, erased at compile time by `tsc` — so there is zero coupling
// beyond the type check itself; wiring this map INTO `can()` is a separate, later, Phase-4-adjacent
// ticket (design doc §3.4), not this one.
//
// SHAPE: every one of the 34 capabilities in `rbac.ts`'s `CAPABILITIES` tuple maps to a named SET
// of catalog permission keys (`platform-nest/src/rbac/permission-catalog.json`, the 215
// role-grantable keys, format `<domain>.<resource>.<action>`) plus a declared check semantics.
//
// SEMANTICS — the FIX-2 uniform-tier invariant, made explicit and (eventually, IAM-05b-3)
// machine-checked:
//   "all" (DEFAULT) — holding the capability means holding EVERY permission in its set. This is
//     the correct shape whenever every backing Cerbos policy for a capability grants it to the
//     IDENTICAL role list under the IDENTICAL condition — the definition FIX-2 discovered while
//     splitting `pipeline.write`/`pipeline.manage`/`webdev.provision` out of the old, over-broad
//     `approvals.decide` ("all three carrying the IDENTICAL role list" was the stated evidence).
//   "any" — holding the capability means holding AT LEAST ONE permission in its set: "may act on
//     SOMETHING this surface offers," not "may act on everything it offers." This deliberately
//     trades per-surface precision for the codebase's own tie-break rule — a visible refusal (a
//     button that 403s) beats a silent hiding (a button that never renders). It is meant to be
//     RARE: the correct fix whenever a capability's backing policies genuinely disagree about who
//     gets it is to SPLIT the capability (the FIX-2 playbook), not reach for `any`. Exactly TWO
//     capabilities earn it today, each with a written rationale at its entry: `approvals.decide`
//     (DR-2b's deliberate partial coverage) and `company.manage` (the Gap-3 safe-direction
//     judgment). No third candidate was found while authoring this file — see the IAM-05b-2 report
//     for the sweep performed. A future `any` addition is a FINDING for the owner, never a quiet
//     third entry.
//
// EXHAUSTIVENESS — `as const satisfies Record<Capability, CapabilityDef>` below makes BOTH
// directions a compile error: add a capability to `rbac.ts`'s `CAPABILITIES` tuple without adding
// it here, or add an entry here keyed by a string that isn't a `Capability`, and `tsc` fails.
// Construction-level, no codegen, no new dependency — the Gap-1 lesson ("one list, by
// construction") applied to this axis, exactly as `rbac.ts`'s own header describes for
// `CAPABILITIES`/`ALL`.
//
// PROVENANCE — every set below is seeded from `rbac.ts`'s OWN per-capability comments, which cite
// the backing Cerbos policy file, action, and role list for nearly every entry (past tickets
// DR-1/DR-2/DR-2b/FIX-2/Gap-2/Gap-3/TR-25 were each required to justify their grant in writing),
// cross-checked against `platform-nest/src/rbac/permission-catalog.json`'s key list. Where
// `rbac.ts` carries NO such citation for a capability, the entry below says so explicitly and is
// marked a JUDGEMENT CALL — the same discipline `rbac.ts` itself uses for `team_lead`'s
// `people.directory` grant and `viewer`'s inclusion. See the IAM-05b-2 report
// (`docs/superpowers/plans/2026-08-10-iam-05b-2-report.md`) for the full list of judgement calls,
// every place this file's derived set does not cleanly match what `ROLE_CAPS` grants today, and
// which of the 12 grant-only capabilities (never asked at a call site — design doc §1.4) were
// hardest to pin.
//
// NOT VALIDATED HERE, by design (data + types only, per the ticket):
//   - that every permission key below actually exists among the catalog's 215 grantable keys;
//   - that it carries ZERO overlap with the 15 relationship-class keys;
//   - that `ROLE_CAPS[role]` agrees with `semanticsEval(bundles[role], thisEntry)` for every role.
// All three are IAM-05b-3's job (the generated capability-axis parity test, sibling to
// `rbac-cerbos-parity.test.ts`'s role-axis proof) — do not hand-verify them here and do not treat
// this file's mere existence as proof of anything beyond "the shape is exhaustive."

import type { Capability } from "./rbac";

/** How a capability's permission set is evaluated against a principal's resolved permissions. */
export type CapabilitySemantics = "all" | "any";

export interface CapabilityDef {
  /** Catalog permission keys (`<domain>.<resource>.<action>`) this capability stands for. */
  readonly permissions: readonly string[];
  /** "all" (default) = every permission required to hold the capability. "any" = at least one. See the header. */
  readonly semantics: CapabilitySemantics;
}

export const CAPABILITY_MAP = {
  // ────────────────────────── admin / company / org / people / rollups ──────────────────────────

  // rbac.ts's own comment for this capability is scope-only ("/admin/* (users, identity, modules,
  // compliance, audit)") with NO per-permission Cerbos citation — unlike almost every other entry
  // in this file. JUDGEMENT CALL: mapped to the catalog kinds matching the FOUR named domains that
  // actually HAVE a catalog permission (users, identity links, compliance gates, the activity/audit
  // log). "modules" has NO corresponding catalog permission at all — consistent with the
  // admin/systems API layer still being a deferred surface (root CLAUDE.md: "no AdminController
  // exists yet — this is what blocks the built-but-placeholder UI Systems/Intelligence/Admin
  // sections"), so there is nothing in the catalog to cite for it. Flagged in the IAM-05b-2 report
  // as unverified against real role bundles — IAM-05b-3 should confirm `company_admin` genuinely
  // holds every one of these ten, not assume it from the capability's name alone.
  "admin.access": {
    permissions: [
      "core.user.create", "core.user.read", "core.user.update", "core.user.delete",
      "core.identity_link.read", "core.identity_link.update", "core.identity_link.delete",
      "core.compliance_gate.read", "core.compliance_gate.update",
      "core.activity.read",
    ],
    semantics: "all",
  },

  // ⚠ ONE OF THE TWO DECLARED "any" EXCEPTIONS (see header) — the Gap-3 safe-direction judgment.
  // rbac.ts's `manager` entry documents, in detail, that `company.manage` is ONE UI capability
  // standing in for SEVERAL Cerbos-side tiers that do NOT share a role list:
  //   resource_integration_connection.yaml "company.manage tier" rule -> company_admin, manager
  //     (managing company-owned connections / mapping another person's seat — the ONE tier
  //     `manager` genuinely holds, per `adminMapSeatAction`'s own comment)
  //   resource_company.yaml action "update" (company edit incl. enabled modules) -> company_admin
  //   resource_invoice.yaml (billing create/read/update/delete)                  -> company_admin
  //   resource_automation_approval.yaml action "retry" (the AUTOMATION-CONSOLE retry affordance —
  //     a different UI surface from the approvals-inbox retry gated by `approvals.retry` below,
  //     per rbac.ts's census table §1.3 naming "automation console" as one of this capability's
  //     real consuming surfaces) -> company_admin
  // `manager` holds ONLY the first tier, but the UI gates all FOUR surfaces (Billing, company edit,
  // automation console, seat mapping) behind this one capability name. Deriving `ROLE_CAPS` from
  // the catalog under strict ALL would strip `company.manage` from `manager` entirely — reverting
  // the Gap-3 judgment the owner already made on purpose (design doc §3.1's own worked
  // counter-example is this exact case). Under ANY, holding the one tier `manager` genuinely has is
  // enough to render the surface and let the server 403 the other three — "a visible refusal, never
  // a silent one," in that comment's own words. Design doc §7 item 2 blesses this as one of exactly
  // two `any` capabilities.
  // ⚠ Known first-run red under this semantics (design doc §3.3, drift finding #7): `it_admin`
  // holds `company.manage` in `ROLE_CAPS` but no policy grants it ANY member of this set — the
  // `any` check will correctly come back false, exposing an over-claim the owner still needs to
  // adjudicate (remove vs. register), not a bug in this map.
  "company.manage": {
    permissions: [
      "core.integration_connection.create", "core.integration_connection.read",
      "core.integration_connection.update", "core.integration_connection.delete",
      "core.company.update",
      "billing.invoice.create", "billing.invoice.read", "billing.invoice.update", "billing.invoice.delete",
      "core.automation_approval.retry",
    ],
    semantics: "any",
  },

  // Design doc §2.1's own worked example of "the capability already IS one permission under a
  // stable name": "org.edit -> core.org_structure.update". No split tiers, no ambiguity.
  "org.edit": {
    permissions: ["core.org_structure.update"],
    semantics: "all",
  },

  // DR-2a's own citation (rbac.ts, the `member`/`viewer` ROLE_CAPS comments): no Cerbos resource
  // literally models "browse the staff directory"; the ONLY signal is `resource_member.yaml`'s
  // baseline tenant-directory `read` rule (catalog: `core.member.read`), which lists
  // member/viewer/team_lead/manager/company_admin all on the SAME line — "any in-tenant role may
  // read it." That is why all five hold this capability in `ROLE_CAPS`.
  "people.directory": {
    permissions: ["core.member.read"],
    semantics: "all",
  },

  // "cross-company rollups (global)". Catalog names the read path directly: `core.rollup.read`
  // ("the only cross-company read path, D12"). JUDGEMENT CALL: the Rollups console page also
  // exposes a recompute trigger (root CLAUDE.md: "Rollups (exec cross-company view + recompute)"),
  // and `CAPABILITIES` has no separate `rollups.manage`/`rollups.recompute` member, so
  // `core.rollup_recompute.create` is included here on the assumption that one page = one gate —
  // but rbac.ts carries no comment confirming the recompute button is actually gated on THIS
  // capability rather than on `isElevated` or nothing at all. Flagged for IAM-05b-3. Held only by
  // `platform_admin`/`group_executive` in `ROLE_CAPS` (not even `company_admin`), matching the
  // capability's own "(global)" scope note — so a wrong guess here is low-blast-radius (no
  // partial-holder case exists to get wrong).
  "rollups.view": {
    permissions: ["core.rollup.read", "core.rollup_recompute.create"],
    semantics: "all",
  },

  // ─────────────────────────────────────── PM console ───────────────────────────────────────────

  // Gap-2's own citation: "resource_pm_task.yaml grants team_lead ... create/delete/manage (the
  // leads/admins tier); resource_pm_project.yaml grants it ... manage identically." That is the
  // elevated tier `pm.manage` names — deliberately EXCLUDING `pm.task.read`/`pm.task.update` (the
  // "any member's tier," `pm.contribute`'s job below) and `pm.project.read` (ungated baseline, no
  // capability needed). `manager`/`company_admin`/`team_lead` hold BOTH `pm.manage` AND
  // `pm.contribute` as two SEPARATE entries in `ROLE_CAPS` (never one subsuming the other) —
  // confirming these are non-overlapping sets by construction, not a derivation artifact.
  "pm.manage": {
    permissions: ["pm.task.create", "pm.task.delete", "pm.task.manage", "pm.project.manage"],
    semantics: "all",
  },

  // Owner decision 2026-08-06 ("anyone can pass the ball") + the capability's own comment: mirrors
  // Cerbos's `pm_task:update` specifically — the server diffs `assignee.refId` vs
  // `assignee.responsibleId` and only escalates to the `pm.manage` tier when OWNERSHIP actually
  // changes. `pm.task.read` is deliberately NOT included: PM console reads are ungated by any
  // `can()` check today (same open-baseline model the `viewer` comment describes for other reads),
  // so this capability's evidenced Cerbos surface is the one write action, not a read+write pair.
  "pm.contribute": {
    permissions: ["pm.task.update"],
    semantics: "all",
  },

  // ──────────────────────────────────────────── IT ──────────────────────────────────────────────

  // `team_lead`'s own exclusion comment is the citation: "it.manage — resource_device.yaml's
  // create/update/delete rule is [company_admin, it_staff] only; team_lead gets device READ
  // (baseline, ungated) but not management." Read is therefore deliberately excluded from this
  // capability's set — it's the ungated baseline, not part of the "manage" tier.
  "it.manage": {
    permissions: ["it.device.create", "it.device.update", "it.device.delete"],
    semantics: "all",
  },

  // ────────────────────────────────────── approvals / pipeline / webdev ─────────────────────────

  // ⚠ THE OTHER DECLARED "any" EXCEPTION (see header) — DR-2b's deliberate partial coverage.
  // Design doc §3.2 gives this exact set as its worked example. rbac.ts's `agency_approver` comment
  // is the fullest citation in the file: its ENTIRE verified Cerbos reach is
  // `agency_approval:approve` (via `module_approver`) — nothing else, not even
  // `agency_approval:read`. It is denied on the other two genuine decide surfaces
  // (`automation_approval:decide`/`retry`, `pipeline_gate:decide`) exactly as `manager` is (DR-1).
  // Yet `agency_approver`'s ONE capability IS `approvals.decide` — there is no finer-grained
  // capability meaning "approve only an agency_approval," and the per-approval decide surface
  // (`app/(app)/approvals/[id]/page.tsx`'s `mayDecide`) gates both automation and agency decisions
  // through this identical name. Under strict ALL, deriving `ROLE_CAPS` would strip
  // `agency_approver`'s only capability — reverting DR-2b. Under ANY, holding the one decide
  // surface it genuinely has is enough — "may decide SOMETHING here," not "may decide everything
  // this name covers." `core.automation_approval.retry` is deliberately NOT a member of this set —
  // that Cerbos action has its OWN capability (`approvals.retry` below), kept permanently separate
  // per the IAM-02a-FIX-2 comment's explicit warning not to re-merge them.
  "approvals.decide": {
    permissions: [
      "core.automation_approval.decide",
      "agency.approval.approve",
      "core.pipeline_gate.decide",
    ],
    semantics: "any",
  },

  // D14-08's own citation: "retry a FAILED (or stuck-executing) automation write's execution
  // (Cerbos action `retry` on `automation_approval`)... the backend restricts to
  // superadmin/company_admin/group_executive (D14-07's grant)." A singleton, deliberately kept
  // OUT of `approvals.decide`'s set (see that entry's comment) so the two capabilities can diverge
  // — a plain `company_admin` decides but a plain `manager` must not retry, and the split is what
  // makes that expressible.
  "approvals.retry": {
    permissions: ["core.automation_approval.retry"],
    semantics: "all",
  },

  // IAM-02a-FIX-2's own citation, and design doc §3.2's other worked example. "Verified against
  // every policy it gates, all three carrying the IDENTICAL role list under the IDENTICAL
  // condition (inTenant && notLow): resource_pipeline_run.yaml create/update, resource_pipeline_
  // stage.yaml create, resource_pipeline_gate.yaml create -> company_admin, manager, member." The
  // textbook FIX-2 case: one Cerbos-side tier, one capability, `all` semantics, no ambiguity.
  "pipeline.write": {
    permissions: [
      "core.pipeline_run.create", "core.pipeline_run.update",
      "core.pipeline_stage.create", "core.pipeline_gate.create",
    ],
    semantics: "all",
  },

  // IAM-02a-FIX-2's own citation: "resource_pipeline_stage.yaml action 'update' -> company_admin,
  // manager, group_executive (member EXCLUDED)... resource_scope_signoff.yaml action 'create' ->
  // company_admin, manager, group_executive (member AND team_lead both explicitly excluded)." Both
  // policies carry the identical elevated-only role list — another clean `all`-semantics tier, kept
  // as its own capability (not folded into `pipeline.write`) precisely because `member` is denied
  // here but granted there.
  "pipeline.manage": {
    permissions: ["core.pipeline_stage.update", "core.scope_signoff.create"],
    semantics: "all",
  },

  // IAM-02a-FIX-2's own citation: "resource_webdev_provisioned_site.yaml's provision/reconcile
  // rules: [read, provision, reconcile] -> company_admin, manager on the in-tenant tier... never a
  // plain-member action... Gates: provisionSiteAction, reconcileSiteAction." The Cerbos rule itself
  // bundles `read` into the same role list as `provision`/`reconcile`, but the UI capability's own
  // name and its two cited gates are both WRITE actions — `webdev.provisioned_site.read` is left out
  // of this set on the assumption that viewing a provisioned site's status is not, today, gated by
  // this capability. Flagged as a judgement call for IAM-05b-3 to confirm. Kept as its OWN
  // capability rather than merged into `pipeline.manage` even though the role sets match TODAY,
  // because this resource also carries an unmirrored `module_manager`/`module_staff` tier that will
  // diverge once a `webdev_manager`/`webdev_staff` `Role` member exists (see the capability's own
  // comment on `CAPABILITIES` in rbac.ts) — collapsing now would only have to be un-collapsed later.
  "webdev.provision": {
    permissions: ["webdev.provisioned_site.provision", "webdev.provisioned_site.reconcile"],
    semantics: "all",
  },

  // ───────────────────────────────────────── knowledge ───────────────────────────────────────────

  // "review/quarantine knowledge sources" — rbac.ts carries NO backing-policy citation for this
  // capability at all (unlike almost every neighbor). JUDGEMENT CALL, but a low-risk one: the
  // catalog's own description text for `knowledge.source.update` ("Approve, reject or edit a
  // knowledge source — controls what enters the org-wide RAG") is near-verbatim the capability's
  // own description, so the action mapping is a strong, if uncited, fit. `knowledge.source.read` is
  // included alongside it on the theory that "review" implies viewing the source before deciding on
  // it — that half is weaker evidence than the update half and worth a second look in IAM-05b-3.
  // Grant-only (12 grant-only list, design doc §1.4) — no call site exercises this today, so a wrong
  // guess here is currently invisible to users, not just to this file.
  "knowledge.review": {
    permissions: ["knowledge.source.read", "knowledge.source.update"],
    semantics: "all",
  },

  // ─────────────────────────────────────────── HR ───────────────────────────────────────────────

  // "read hr_cases/hr_records/leave/attendance for a company" — the description names the two
  // Cerbos-side resource kinds directly (hr_case, hr_record; "leave" is an `hr_case` subtype).
  // "attendance" is NOT included as a separate permission here — check-in/attendance data is its
  // own capability (`checkin.read` below, `reports.checkin.read`), and hr_manager/hr_staff hold
  // `checkin.read` as a SEPARATE entry in `ROLE_CAPS`, never folded into `hr.view` — so the
  // description's "attendance" reads as loose prose describing the HR reader's overall job, not a
  // third permission this capability itself grants.
  // ⚠ FLAGGED, not resolved: TR-25's own comment on `hr_staff` describes its OBSERVED grant only as
  // "reads person-grain reports and check-in history (that IS hr.view-shaped work)" — it never
  // states outright that `hr_staff` (Cerbos `hr_people_reader`) actually holds `hr_case:read`/
  // `hr_record:read` directly, only that its behavior matches the SHAPE of an HR-reader
  // capability. This map takes the capability's own description (which names hr_case/hr_record
  // explicitly) as the citation, but if IAM-05b-3's bundles show `hr_staff` lacks these two
  // permissions, that is this file being wrong about the SET, not `ROLE_CAPS` being wrong — see the
  // IAM-05b-2 report.
  "hr.view": {
    permissions: ["hr.case.read", "hr.record.read"],
    semantics: "all",
  },

  // "file/decide leave on others' behalf, edit cases/records/checklists, manage templates" — the
  // WRITE tier, held as a SEPARATE `ROLE_CAPS` entry alongside (never instead of) `hr.view`, per
  // TR-25's hr_staff/hr_manager split ("hr_staff is the BASELINE read tier and hr_manager the
  // ACTING tier, exactly as this file already modelled hr.view vs hr.manage"). Mapped to every
  // hr_case/hr_record WRITE action the catalog has: create/update/delete (case management) and
  // create/update/delete on records.
  // ⚠ ORPHAN FINDING: `hr.case.export`/`hr.record.export` ("Bulk-export... policy requires high
  // assurance") have NO capability anywhere in `CAPABILITIES` that names them, and the description
  // above doesn't mention "export" either. Deliberately NOT folded into this set without evidence —
  // this is a real gap in the UI mirror's coverage (a step-up-gated export action the mirror cannot
  // gate at all today), flagged for the owner/IAM-05b-3 rather than guessed into an existing
  // capability.
  // 🔴 IAM-DR67 CORRECTION — `hr.case.cancel` REMOVED (was a defect in this file, not an owner
  // decision). Verified directly against `resource_hr_case.yaml`: `cancel` is granted ONLY to
  // `group_executive` (wholesale, lines 19-23) and to `member`-self (the subject's own pending
  // case, `subjectUserId == principal.id`, lines 42-52, mirrored by the additive
  // `perm_hr_case_cancel_self` permission-arm rule at lines 111-119) — NEVER to
  // `module_manager`/`company_admin` at any condition. The unconditioned staff/manager/admin rule
  // (lines 25-28) lists only `["read", "create", "update"]`; the elevated manager/admin rule (lines
  // 30-33) lists only `["delete"]`. Including `hr.case.cancel` in this set made `hr.manage`
  // unsatisfiable under `all` semantics for `company_admin` and `hr_manager` — the two roles that
  // genuinely hold every OTHER permission in the set unconditionally — producing two false
  // over-claims (IAM-05b-3 report findings #6/#7). IAM-02a's own drift register §3 had already
  // reached the identical conclusion independently ("hr_case:cancel... not a capability at all...
  // removed from consideration"). This is the map catching up to a conclusion Cerbos and an earlier
  // audit both already stated; no `ROLE_CAPS` entry changes and no Cerbos policy changes.
  "hr.manage": {
    permissions: [
      "hr.case.create", "hr.case.update", "hr.case.delete",
      "hr.record.create", "hr.record.update", "hr.record.delete",
    ],
    semantics: "all",
  },

  // ───────────────────────────────────── search-marketing ───────────────────────────────────────

  // "read search-marketing properties/engagements/keywords/audits/campaigns/reports/ledger for a
  // company" — the description enumerates all seven resource kinds by name; mapped 1:1 to each
  // kind's `.read` action. Grant-only (design doc §1.4) but the cleanest of the twelve to pin —
  // the description IS the citation, with zero ambiguity about which actions are meant.
  "search.view": {
    permissions: [
      "search.property.read", "search.engagement.read", "search.keyword.read",
      "search.audit.read", "search.campaign.read", "search.report.read", "search.ledger.read",
    ],
    semantics: "all",
  },

  // The single largest capability by call-site count (42, per rbac.ts's census table §1.3) — "the
  // draft-only working set — mirrors search_staff/search_manager's baseline Cerbos grant." The
  // module design's own comment on `search_staff`/`search_manager` (SM-03) is the citation:
  // "module_staff (draft-only baseline: read/create/update, propose_change, research/run — never
  // launch/set_scope/approve/admin)." `search.view` above already covers the `read` half; this
  // capability covers the create/update/propose_change/research/run half across every resource the
  // capability's own description names (properties/engagements/keywords/audits/campaign
  // drafts+proposals/report drafts).
  // ⚠ FLAGGED: no `.delete` action on any of these six resources is included. Neither the
  // module-role comment's "never launch/set_scope/approve/admin" exclusion list NOR the baseline
  // "read/create/update" inclusion list mentions delete at all, so there is no citation either way
  // — if the SEO console exposes delete buttons on draft properties/keywords/audits under this
  // capability, that is unverified against Cerbos and needs checking in IAM-05b-3, not assumed here.
  "search.manage": {
    permissions: [
      "search.property.create", "search.property.update",
      "search.engagement.create", "search.engagement.update",
      "search.keyword.create", "search.keyword.update", "search.keyword.research",
      "search.audit.create", "search.audit.update", "search.audit.run",
      "search.campaign.create", "search.campaign.update", "search.campaign.propose_change",
      "search.report.create", "search.report.update",
    ],
    semantics: "all",
  },

  // "set an engagement's tool-scope config + provider budget cap (D-11; Cerbos action `set_scope`,
  // elevated-only)." A singleton — `search.campaign.set_budget` (live ad-spend budget) and
  // `search.ledger.admin` (stop-loss override) are each their OWN, differently-scoped, capability
  // below; the "+ provider budget cap" in this capability's description describes what the
  // `set_scope` config itself contains, not a second permission.
  "search.scope.write": {
    permissions: ["search.engagement.set_scope"],
    semantics: "all",
  },

  // "mark a manual-mode change proposal applied OR execute an api-mode one (Cerbos actions
  // launch/apply_manual/apply_negatives/set_budget, elevated-only)" — a direct 1:1 citation, all
  // four named actions exist verbatim in the catalog under `search.campaign.*`.
  "search.campaign.launch": {
    permissions: [
      "search.campaign.launch", "search.campaign.apply_manual",
      "search.campaign.apply_negatives", "search.campaign.set_budget",
    ],
    semantics: "all",
  },

  // "approve + deliver an engagement report (Cerbos actions approve/deliver, elevated-only)" — a
  // direct 1:1 citation.
  "search.report.approve": {
    permissions: ["search.report.approve", "search.report.deliver"],
    semantics: "all",
  },

  // "override a provider budget stop-loss cap (Cerbos action `admin` on resource_search_ledger,
  // elevated-only)" — the capability name IS the catalog key (`search.ledger.admin`), the cleanest
  // possible citation.
  "search.ledger.admin": {
    permissions: ["search.ledger.admin"],
    semantics: "all",
  },

  // ────────────────────────────── social-media (SMM-11) ──────────────────────────────────────────
  // Every set below was checked directly against role-permission-bundles.json's generated bundles
  // for company_admin/manager/social_staff/social_manager BEFORE being written (not inferred from a
  // policy comment the way search's three entries above were) — see rbac.ts's ROLE_CAPS comments
  // for the exact bundle sizes cited (social_staff 17 permissions, social_manager 32).

  // rbac.ts's own citation: "read engagements + the content calendar... held by staff and manager
  // alike." Both `social_staff` and `social_manager` (and company_admin/manager) hold BOTH keys
  // unconditionally.
  "social.view": {
    permissions: ["social.engagement.read", "social.post.read"],
    semantics: "all",
  },

  // rbac.ts's own citation: "author/edit a post and its per-network variants, record a native
  // import... staff's OWN tier, not manager-only." `social_staff`'s bundle holds all three; so does
  // every other role that holds any social permission at all (company_admin/manager/
  // social_manager). Deliberately excludes `social.post.delete` (its own capability below) —
  // Cerbos's module_staff rule grants create/update/submit/import_native but NOT delete.
  "social.manage": {
    permissions: ["social.post.create", "social.post.update", "social.post.import_native"],
    semantics: "all",
  },

  // rbac.ts's own citation: "set an engagement's tool scope + metered budget... manager-tier only,
  // mirrors search.scope.write exactly." A singleton, direct citation — `social_staff`'s bundle
  // does NOT hold `social.engagement.set_scope` (resource_social_engagement.yaml denies module_
  // staff every action but `read`); company_admin/manager/social_manager all hold it.
  "social.scope.write": {
    permissions: ["social.engagement.set_scope"],
    semantics: "all",
  },

  // rbac.ts's own citation: the manager/staff split IS the publish line — `social_staff`'s bundle
  // holds `social.post.create/update/submit/import_native/read` but NOT `social.post.delete`
  // (resource_social_post.yaml's module_staff rule omits it on purpose). company_admin/manager/
  // social_manager all hold it.
  "social.post.delete": {
    permissions: ["social.post.delete"],
    semantics: "all",
  },

  // ── client review (SMM-31/32, D-16) — verified directly against role-permission-bundles.json:
  // social_staff holds read+request only; social_manager/company_admin/manager/platform_admin hold
  // all three; group_executive holds read only (wholesale-excepted from this file's per-pair loop
  // below, same as every other social.* capability's `ALL`-derived reach for that role).
  "social.client_review.read": {
    permissions: ["social.client_review.read"],
    semantics: "all",
  },
  "social.client_review.request": {
    permissions: ["social.client_review.request"],
    semantics: "all",
  },
  "social.client_review.withdraw": {
    permissions: ["social.client_review.withdraw"],
    semantics: "all",
  },

  // ─────────────── TR-25: reports / check-in / appraisal (§8's matrix, mirrors never decides) ────
  // Every entry in this block cites an exact Cerbos action name in rbac.ts's own comment — this is
  // the most precisely-documented block in the whole file despite nine of its twelve members being
  // grant-only (design doc §1.4). Reminder carried over from rbac.ts's own warning: these
  // capabilities answer "should the UI OFFER this," never "may this user SEE this person" — the
  // person axis is server-enforced and deliberately unexpressed here.

  "reports.person.view": {
    permissions: ["reports.document.read_person"],
    semantics: "all",
  },
  "reports.project.view": {
    permissions: ["reports.document.read_project"],
    semantics: "all",
  },
  "reports.department.view": {
    permissions: ["reports.document.read_department"],
    semantics: "all",
  },
  "reports.company.view": {
    permissions: ["reports.document.read_company"],
    semantics: "all",
  },

  // "seal / amend / pin a period (Cerbos seal/amend/pin on report_period) — exec/company_admin
  // only; dept lead ⛔". A direct 1:1 citation. `reports.period.view` is deliberately excluded —
  // it is not named in the capability's comment, and this file has no evidence it's gated at all
  // (likely an ungated baseline read, matching the pattern elsewhere in this program).
  "reports.period.seal": {
    permissions: ["reports.period.seal", "reports.period.amend", "reports.period.pin"],
    semantics: "all",
  },

  // "rebuild the fact fabric (Cerbos `recompute` on report_admin) — exec/company_admin only." A
  // singleton, direct citation.
  "reports.facts.admin": {
    permissions: ["reports.admin.recompute"],
    semantics: "all",
  },

  // "the n8n reminder/escalation reads (Cerbos `pending_reminders`/`missed_by_unit`) — company_
  // admin ONLY, not a human console." A direct 1:1 citation.
  "reports.ops.poll": {
    permissions: ["reports.checkin.pending_reminders", "reports.checkin.missed_by_unit"],
    semantics: "all",
  },

  // "read others' check-in history + the compliance grid (Cerbos `read`) — SERVER narrows to the
  // caller's line." A singleton, direct citation.
  "checkin.read": {
    permissions: ["reports.checkin.read"],
    semantics: "all",
  },

  // "excuse a missed day (Cerbos `excuse`) — rewrites an appraisal-SAFE metric, so hr_manager not
  // hr_staff." A singleton, direct citation.
  "checkin.excuse": {
    permissions: ["reports.checkin.excuse"],
    semantics: "all",
  },

  // "read appraisal packs beyond one's own (Cerbos `read`)." A singleton, direct citation.
  "appraisal.read": {
    permissions: ["reports.appraisal.read"],
    semantics: "all",
  },

  // "write/submit scores (Cerbos `write`/`submit`) — the ASSIGNED manager only; server narrows to
  // manager_user_id." A direct 1:1 citation of exactly the two named actions.
  // ⚠ ORPHAN FINDING: `reports.appraisal.confirm_evidence` ("Confirm the evidence pack attached to
  // an appraisal") is NOT included — the capability's own comment names only write/submit, and
  // confirm_evidence isn't mentioned anywhere in `CAPABILITIES`. `reports.appraisal.ack`
  // ("Acknowledge your own finalized appraisal — subject action") is correctly excluded on
  // purpose: it's the SUBJECT's own self-service action (§11 principle 2: "nothing about you that
  // you cannot read"), the same reason appraisals/check-ins have no self-service capability at all
  // per the `member` ROLE_CAPS comment. `confirm_evidence` is genuinely ambiguous between the two
  // and is flagged here as an uncovered catalog permission, not silently assigned to either.
  "appraisal.score": {
    permissions: ["reports.appraisal.write", "reports.appraisal.submit"],
    semantics: "all",
  },

  // "cycle CRUD + generate + finalize (Cerbos `cycle_admin`/`finalize`) — hr_manager ONLY (TR-25
  // finding ②)." A direct 1:1 citation.
  "appraisal.cycle.admin": {
    permissions: ["reports.appraisal.cycle_admin", "reports.appraisal.finalize"],
    semantics: "all",
  },
} as const satisfies Record<Capability, CapabilityDef>;
