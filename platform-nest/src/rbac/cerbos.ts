// Cerbos policy-decision client (5b.4). Replaces the in-code check() with the SAME
// signature — call sites are unchanged. The principal's raw grants + authorized-tenant
// set + assurance become Cerbos principal attributes; the scope cascade lives in the
// versioned policy repo (cerbos/policies). PlanResources (D16) turns a list authorization
// into a predicate the RLS query can push down instead of N per-row checks.
import { config } from "../config";
import type { Principal } from "./principal";

export interface Resource {
  kind: string;
  id?: string;
  tenantId?: string;
  ownerId?: string;
  projectId?: string;
  teamId?: string;
  module?: string;
  /** WSD-4: the HR-case/record/leave "subject" (the employee the row is about), so the
   *  member-self-service derived-role rules (resource_hr_case.yaml et al.) can match
   *  `resource.attr.subjectUserId == principal.id`. Omitted -> "" -> those rules fail
   *  closed (never a leak from a handler that forgot to pass it). */
  subjectUserId?: string;
  /** ASST-21: a free-text origin marker (currently only `"assistant_handoff"`) so the additive
   *  `agent_run` rule (resource_agent_run.yaml) can be scoped to EXACTLY runs created through the
   *  assistant's handoff endpoint, never every owner-attributed run in the platform. Omitted -> "" ->
   *  that rule's `==` comparison fails closed, same convention as every other optional attr here. */
  origin?: string;
  /** IAM-GAP-01 — the maker/checker seam (invoice `approve`). The DB user id that CREATED this
   *  resource (`invoices.created_by`), distinct from `ownerId`'s self-service-ownership semantics
   *  (`gaiada_common.yaml`'s `owns` asserts EQUALITY; this attribute backs an INEQUALITY check —
   *  approver must NOT be the creator). Omitted/empty -> the policy's `has() && != ""` guard denies
   *  rather than treating an unknown creator as "no conflict" (fail CLOSED — a legacy invoice with
   *  no recorded creator, or a handler that forgot to pass this, must never be approvable by
   *  anyone but the platform_admin/group_executive wildcard). */
  creatorId?: string;
  /** IAM-GAP-01 — disambiguates WHICH kind of `automation_approval` row this is, for kinds whose
   *  origin alone is not specific enough (hr-origin rows cover BOTH leave and loan requests).
   *  Currently only `"leave"` (hr.controller.ts's fileLeave()); loans never set this. Omitted -> ""
   *  -> the dedicated `decide_leave` rule's `== "leave"` check fails closed, same convention as
   *  every other optional attr here. */
  subKind?: string;
  /** HIER-2 (DR-9): every ancestor of this resource's own org-unit node id, self-inclusive at
   *  depth 0 (IAM-09's `org_unit_closure` table — `org-unit-closure.ts::loadUnitAncestors`).
   *  `org_unit_lead`'s derived role (derived_roles.yaml) matches when its grant's `scopeId` is
   *  anywhere in this list — that containment IS the subtree cascade, computed by the caller, not
   *  walked per request. Omitted -> `[]` -> the derived role's `in` test can never match anything,
   *  fail-closed by construction (an unfed resource confers nothing, same convention as every
   *  other optional attr on this type). Only two call sites populate it today
   *  (reports.controller.ts's report_document department grain; appraisals.controller.ts's
   *  subject-unit resolution) — see each rule's own comment for why it stops there.
   *  DW-4e-1: `dept_kpi_target` (resource_dept_kpi_target.yaml) reads it too, for the head's `propose` rule; the
   *  handler (dept-kpis.controller.ts) feeds the TARGET unit's chain. No allow-list change was needed: the line
   *  below already carries it. */
  unitAncestors?: string[];
  /** P2-02/P2-06 — the person BEING acted upon, as distinct from the resource's owner or subject:
   *  the target of a `position` assign or a `role_grant` create/revoke. Backs the self-target DENY
   *  rules in `resource_position.yaml` and `resource_role_grant.yaml` (`targetUserId ==
   *  principal.id`), which is why an INEQUALITY-style attribute cannot reuse `subjectUserId`'s
   *  self-service-EQUALITY semantics. P2-02 registered both kinds expecting callers to set this;
   *  `employees.controller.ts` (P2-06) is the first caller, and adding it to this type is what makes
   *  the DENY reachable at all — until now the rule read an attribute no handler could send.
   *  Omitted -> "" -> the rules' `has() && != ""` guard makes the DENY vacuously false, the same
   *  fail-open-for-DENY/fail-closed-for-ALLOW convention every other optional attr here follows. */
  targetUserId?: string;
  /** HR-FULL — `hr_payroll`'s member arm requires BOTH `subjectUserId == principal.id` AND this.
   *  A draft payslip mid-run is not the subject's to see, and a run being recalculated would
   *  otherwise leak half-computed figures. Omitted -> `false` -> the rule's `== true` check fails
   *  closed, so a handler that forgets it denies rather than exposing an unpublished slip. */
  published?: boolean;
  /** HR-FULL — `hr_recruitment`'s panel arm. The users attached to the application being acted on,
   *  resolved BY THE HANDLER from hr_interview_panelists / hr_requisitions (never client-supplied:
   *  the handler is what knows who is on the panel). Omitted -> `[]` / `""` -> the panel rules
   *  cannot match, so an unfed resource confers nothing — the same fail-closed convention as
   *  `unitAncestors` and `subjectUserId` above. */
  panelistUserIds?: string[];
  hiringManagerUserId?: string | null;
  recruiterUserId?: string | null;
  /** GH-03 (github_repo's `create_repo`/`delete_repo` rules) — mirrors `resource_mcp_tool.yaml`'s
   *  WSK-31 "ALWAYS-WS4" shape, reapplied to a platform-nest-native resource kind instead of
   *  `mcp_tool`: repo creation and deletion are D14-gated even for an ATTENDED company_admin, so the
   *  policy admits the action only when this attribute carries a verified grant id — never merely
   *  because the caller holds an elevated role. Whoever wires the create/delete endpoint (GH-10/12)
   *  is responsible for setting this ONLY from a verified D14 execution grant (the platform-nest
   *  equivalent of mcp-hub's branded `VerifiedExecutionGrant` — never from a client-supplied field,
   *  a header, or any other unverified source). Omitted -> "" -> the policy's `has() && type==string
   *  && != ""` guard denies, same fail-closed convention as every other optional attr here — so an
   *  unwired caller (today, there is none) gets a denial rather than a silent bypass. */
  approvalId?: string;
  /** WSK-47 — the WebDesk collection an item belongs to (`webdesk_content_item`/
   *  `webdesk_collection`). Taken from ZONE B's read of the item (WSK-51), never from the request
   *  body: a caller that could name its own collection could name its way into a later writer rule
   *  (`collectionKey in ["post","guide"]`). No rule reads it yet. Omitted -> "" -> fail closed. */
  collectionKey?: string;
  /** WSK-47 — the item's locale, same provenance rule as `collectionKey` (Zone B's read). Reserved
   *  for the later translator rule (`locale == "id"`). Omitted -> "" -> fail closed. */
  locale?: string;
  /** WSK-47 / WSK-D46 (R4) — how many items a `webdesk_content_item` publish approval covers,
   *  counted by the decide() executor (WSK-66) from the STORED approval row's tool_args.items, never
   *  from the client. `publish` lets a maker approve their own request only when this is exactly 1;
   *  batches keep maker ≠ checker. Omitted -> 0 -> the strict two-person rule applies (fail closed). */
  itemCount?: number;
  /** WSK-49f / WSK-D60 -- the CLIENT RECORD (`clients.id`) this resource is about. Two readers, both in
   *  derived_roles.yaml: `client_website_editor` (a grant with scopeType client whose scopeId equals it, in
   *  the grant's tenant) and `client_contact_admin` (the principal's `clientAdminOf` contains this client in
   *  this tenant). It must come from a row the handler loaded in the request's tenant (or from a route
   *  param the handler then verifies against that row) -- NEVER from a request body. Omitted -> "" -> neither
   *  derived role can match, so an unfed resource confers nothing (fail closed). */
  clientId?: string;
  /** M5-W1a (docs/plans/2026-10-11-m5-writers-room-design.md §2.3) -- the WebDesk SITE a
   *  `webdesk_content_item` / `webdesk_collection` / `webdesk_media_asset` resource belongs to. The writers'
   *  room derived roles (derived_roles.yaml) compare it with the grant's scope rows. It must come from the
   *  route `:siteId` AFTER resolveEditableSite() has proven the site is this company's -- never from a body
   *  or a query. Omitted -> "" -> every editorial derived role fails closed (the staff tiers never read it). */
  siteId?: string;
  /** M5-W1a -- WebDesk's editorial review state of the item (`editorial_items.state`: draft | in_review |
   *  changes_requested | approved), from WebDesk's read, never a body. For a translator's twin `create` it is
   *  the SOURCE item's state. Omitted -> "" -> every rule that reads it (writer/translator update, SEO
   *  reviewer update, approve) denies. */
  reviewState?: string;
  /** DW-5c (docs/FRONTEND-BFF-CONTRACT.md §32.2) -- the user who ASKED, for `work_request`'s `cancel` requester rule
   *  (`requestedBy == principal.id`). Read by the handler from `work_requests.requested_by`, never from a body.
   *  Omitted -> "" -> the rule's `has() && != ""` guard and the equality both fail closed. */
  requestedBy?: string;
  /** DW-5c -- the people doing the work behind a `work_request`: the PM task's responsible person and any person
   *  assignee, resolved BY THE HANDLER from the task (never a body). Backs `deliver`'s assignee rule
   *  (`principal.id in assigneeIds`). Omitted -> [] -> the rule contains nobody, so an unfed resource confers
   *  nothing (the same fail-closed convention as `unitAncestors` and `panelistUserIds`). */
  assigneeIds?: string[];
  /** DW-6h (docs/FRONTEND-BFF-CONTRACT.md §35.4) -- the REQUESTERS of an Asset Library asset: the `requested_by` of every
   *  live work request (`work_requests`) any version of the asset's group was delivered against (`work_request_assets`).
   *  Backs `creative_asset`'s `decide_review` requester rule (`principal.id in requesterIds`). Resolved BY THE HANDLER
   *  (creative-reviews.ts), never from a body. Omitted -> [] -> the rule contains nobody (fail closed). */
  requesterIds?: string[];
  /** DW-6h -- who OPENED the review round being acted on (`creative_asset_reviews.requested_by`). Backs the opener's
   *  `withdraw_review` rule AND the maker/checker `decide_review` DENY (nobody decides a round they opened). Read from
   *  the round row (NOT NULL), never from a body. Omitted -> "" -> the opener's withdraw rule denies (fail closed), and
   *  the self-approval DENY's `has() && != ""` guard stays false (the invoice `approve` convention: fail-open for a
   *  DENY, fail-closed for an ALLOW); the handler always feeds it on a decision. */
  reviewRequestedBy?: string;
  /** DW-8g (docs/FRONTEND-BFF-CONTRACT.md §47.2) -- every person invited to a `calendar_event` (`calendar_event_attendees`, the
   *  organizer included). Backs the attendee `read` rule and the `respond` rule, and the deny-overrides `respond` rule that stops
   *  every role (platform_admin too) answering for someone else (`principal.id in attendeeIds`). Resolved BY THE HANDLER from the
   *  attendee rows, never from a body. Omitted -> [] -> contains nobody, so an unfed resource confers nothing and `respond` denies. */
  attendeeIds?: string[];
  /** DW-8g -- a `calendar_event`'s visibility, `attendees` or `company` (`calendar_events.visibility`). Backs the company-visibility
   *  `read` rule for member and viewer. Read from the row by the handler, never from a body. Omitted -> "attendees" (never
   *  "company"), so an unfed resource never opens to the whole company. */
  visibility?: string;
  /** PV7-04a (docs/FRONTEND-BFF-CONTRACT.md §55, PERMISSION-CONTRACT §46) -- the CLIENT'S OWNER (`clients.owner_user_id`)
   *  of the client a `client_report` belongs to. Backs the owner's self-scoped `draft` / `publish` / `withdraw` rule
   *  (`ownerUserId == principal.id`). Read by the handler from the client row, never from a body. Omitted -> "" -> the
   *  rule's `has() && != ""` guard and the equality both fail closed (a client with no owner confers nothing). */
  ownerUserId?: string;
  /** DW-10a (docs/FRONTEND-BFF-CONTRACT.md §57.3, PERMISSION-CONTRACT §47) -- a `dept_notice`'s scope, `unit` or `company`. Backs the
   *  head's `post` / `edit` / `withdraw` rules, which carry `scope == "unit"` so a head never reaches a company-wide notice. Derived by
   *  the handler from the validated request scope (post) or the STORED row (edit, withdraw), never trusted from a body. Omitted ->
   *  "unit": an unfed resource reads as a unit notice, which on its own confers nothing (the lead rule still needs a
   *  `unitAncestors` match, and an unfed list is empty). An attribute dropped from the allow-list below makes the rule's `has()`
   *  false, which DENIES. */
  scope?: string;
  /** DW-10c (docs/FRONTEND-BFF-CONTRACT.md §59.3, PERMISSION-CONTRACT §48) -- the org-tree node a `department`-visible
   *  `calendar_event` belongs to (`calendar_events.unit_node_id`). Read from the STORED row by the handler, never from a body. No
   *  Cerbos rule compares it (the per-unit narrowing needs the caller's placement as of today, which Cerbos cannot read, so the
   *  handler and the SQL mirrors apply it); it is in the payload so the decision carries the unit the event names. Omitted -> "". */
  unitNodeId?: string;
  /** SCP-1b (docs/PERMISSION-CONTRACT.md §53.4, §53.5) -- the company's live lead-seat holders of its Social Media unit and
   *  its GM unit (the HoD and the GM), for `social_post` / `social_engagement` / `social_report`. Backs the
   *  `social_approver_seat` derived role (`approverIds.exists(id, id == principal.id)`). Computed BY THE HANDLER per company
   *  (`modules/social/pipeline-authz.ts` loadSocialApproverIds), never from a body. Omitted -> [] -> contains nobody, so no
   *  seat approver matches (fail closed). */
  approverIds?: string[];
  /** SCP-1b (§53.4, §53.5) -- a pipeline post's design route, `creatives` or `in_team` (`social_posts.creative_source`).
   *  Backs the two `design` rules, each of which tests it. Read from the post row, never from a body. Omitted -> "" -> neither
   *  designer rule matches (fail closed). */
  creativeSource?: string;
  /** SCP-1q (SCP-Q23, docs/PERMISSION-CONTRACT.md §53.4) -- the OPEN holders of a `position` (`position_assignments` with no
   *  `valid_to`, the §50 seat rule), for `resource_position.yaml`'s self-EDIT DENY on `update` (nobody edits a position they
   *  hold, superadmin included). Fed BY THE HANDLER from the rows (positions.controller.ts `loadPositionHolderIds`), never
   *  from a body. Omitted -> [] -> contains nobody, so the DENY matches nobody (the self-assign DENY's convention: fail-open
   *  for a DENY, so an unfed caller loses nothing it had). A dropped allow-list line below makes the DENY never fire. */
  holderIds?: string[];
  /** SCP-1r (SCP-D7, owner ruling SCP-Q23; docs/PERMISSION-CONTRACT.md §53.4) -- the live lead-seat holders (the §50 seat rule) of every
   *  org unit whose name, kind or parent an `org_structure` `update` changes, or which it removes, for `resource_org_structure.yaml`'s
   *  unit self-edit DENY (nobody renames, re-types, moves or deletes a unit they lead, superadmin included). Fed BY THE HANDLER from
   *  the stored tree and the seat rows (admin/org-structure-lead-guard.ts), never from a body. Omitted -> [] -> contains nobody, so the
   *  DENY matches nobody (fail-open for a DENY: an unfed caller loses nothing it had). A dropped allow-list line below makes the
   *  DENY never fire. */
  touchedLeadHolderIds?: string[];
}

export type Decision = { allow: true } | { allow: false; reason: string };

// Exported (HIER-1) so `assemblePrincipal() -> attr.grants` can be tested against the REAL
// mapping rather than a hand-duplicated copy that could silently drift from this function.
// Visibility-only change — no behavioural difference, still called the same way internally.
export function principalPayload(p: Principal) {
  return {
    id: p.userId ?? "anonymous",
    roles: ["user"], // base role; the real logic is in derived roles over attr.grants / attr.perms
    attr: {
      assurance: p.assurance,
      // PV5-14 / PV-D40: present ONLY when the "high" above came from the simulated second factor (dev stage).
      // Conditional, so every other principal's payload is byte-identical to before. No policy reads it.
      ...(p.assuranceSource ? { assuranceSource: p.assuranceSource } : {}),
      // T7 (WebDesk M3). `users.kind` (employee | client | automation | bot). This function is an
      // explicit allow-list: an attribute not named here silently never reaches Cerbos, so without
      // this line the `kind in ["automation","bot"]` DENY in resource_webdesk_content_item.yaml
      // would read an absent attribute and never fire. `?? ""` is the safe default because every
      // rule that reads it is an EFFECT_DENY: an absent kind matches no DENY and falls back to the
      // pre-existing rules, so a fixture (or a caller) that omits it can lose nothing and gain
      // nothing. A default that matched `automation` would be the unsafe direction for a deny-list
      // read by an ALLOW; here it is a deny-list, so "" is correct.
      kind: p.kind ?? "",
      companies: p.companies,
      // MON-00c (Wall 2). `variables.inRoot` reads this. `?? []` is the fail-closed default: a
      // principal assembled before this field existed (or by a test fixture that omits it) denies
      // cross-root access rather than permitting it, which is the direction an omission must fail.
      rootCompanies: p.rootCompanies ?? [],
      // WSK-49f: `scopeTenantId` is sent only on a client-scoped grant (see RoleGrant). The derived role
      // guards it with has(), so a client-scoped grant that somehow arrives without its tenant matches nothing.
      grants: p.roles.map((g) => ({
        role: g.role,
        scopeType: g.scopeType,
        scopeId: g.scopeId ?? "",
        // Conditional spread: every non-client grant keeps its exact historical shape (the HIER-1 round-trip
        // tests pin it); only a client-scoped grant carries a tenant.
        ...(g.scopeTenantId ? { scopeTenantId: g.scopeTenantId } : {}),
        // DW-10g-2 Part B: an `org_unit_lead` grant carries the companies whose own lead seat backs it (RoleGrant.tenantIds).
        // Same conditional-spread rule: every other grant keeps its exact shape. The derived role guards it with has(), so an
        // `org_unit_lead` grant that arrives without it (a hand-built principal, an older producer) matches nothing.
        ...(g.tenantIds ? { tenantIds: [...g.tenantIds] } : {}),
        // M5-W1a: a writers' room grant's scope rows (RoleGrant.editorialScopes). Same conditional-spread rule:
        // every other grant keeps its exact shape. Each row is re-listed field by field (an allow-list, like
        // this whole function), so nothing beyond the five fields the derived roles read reaches Cerbos.
        ...(g.editorialScopes
          ? {
              editorialScopes: g.editorialScopes.map((s) => ({
                siteId: s.siteId,
                allCollections: s.allCollections === true,
                collections: s.collections ?? [],
                allLocales: s.allLocales === true,
                locales: s.locales ?? [],
              })),
            }
          : {}),
      })),
      // WSK-49f. An explicit allow-list entry, like every attribute here: an attribute not named in this
      // function never reaches Cerbos. `?? []` is the fail-closed default (the derived role's `exists` is
      // false on an empty list).
      clientAdminOf: (p.clientAdminOf ?? []).map((a) => ({ tenantId: a.tenantId, clientId: a.clientId })),
      // IAM-04a: additive alongside `grants` — the resolved (permission key, scope) pairs IAM-03a's
      // `assemblePrincipal()` expands through `role_permissions` (0094). `p.perms` is optional on
      // `Principal` (see principal.ts's own comment on why: ~20 pre-existing test files construct
      // `Principal` literals without it), so this defaults to `[]` rather than throwing — an empty
      // array makes every `attr.perms.exists(...)` in derived_roles.yaml evaluate false, never a CEL
      // error, which is exactly the same fail-closed shape `grants` already has for a roleless
      // principal. Nothing in this repo's policies read `attr.perms` before IAM-04b's two-resource
      // pilot (resource_pm_task.yaml, resource_hr_case.yaml) — every other decision is unaffected.
      perms: (p.perms ?? []).map((g) => ({ key: g.key, scopeType: g.scopeType, scopeId: g.scopeId ?? "" })),
    },
  };
}

function resourcePayload(r: Resource) {
  return {
    kind: r.kind,
    id: r.id ?? "new",
    attr: {
      id: r.id ?? "",
      tenantId: r.tenantId ?? "",
      ownerId: r.ownerId ?? "",
      projectId: r.projectId ?? "",
      teamId: r.teamId ?? "",
      module: r.module ?? "",
      subjectUserId: r.subjectUserId ?? "",
      origin: r.origin ?? "",
      unitAncestors: r.unitAncestors ?? [],
      creatorId: r.creatorId ?? "",
      subKind: r.subKind ?? "",
      targetUserId: r.targetUserId ?? "",
      // HR-FULL. These four MUST be listed here to reach the policy at all: this function is an
      // explicit allow-list, and a caller passing an attribute it does not name has that attribute
      // silently dropped. Two of them arrive through an object spread in recruitment.controller.ts,
      // where TypeScript's excess-property check does not fire — so the type alone would not have
      // caught the omission, and the panel rules would have denied every panelist for no visible
      // reason. Adding a Resource field without adding it here is a no-op with no error.
      published: r.published ?? false,
      panelistUserIds: r.panelistUserIds ?? [],
      hiringManagerUserId: r.hiringManagerUserId ?? "",
      recruiterUserId: r.recruiterUserId ?? "",
      // GH-03. MUST be listed here to reach resource_github.yaml at all — this function is an
      // explicit allow-list (see the comment above `published`/`panelistUserIds`): a Resource field
      // added without a matching line here is a no-op with no error, and for this specific field
      // that failure mode would be the WORST direction — a `create_repo`/`delete_repo` rule silently
      // never seeing an approvalId reads as "always deny", which is safe; the trap this comment
      // exists to prevent is the reverse fear (that omitting it here could widen access). It cannot:
      // an absent attribute makes the `has()` guard false, which DENIES, never allows. Recorded
      // anyway because the estate's own trap note names this allow-list as the failure class to
      // check first when a resource-policy rule "isn't seeing" an attribute a caller believes it set.
      approvalId: r.approvalId ?? "",
      // WSK-47. Listed here or they never reach resource_webdesk_*.yaml (this is an allow-list).
      // `itemCount` is the one whose absence changes a decision: missing, R4's single-item
      // self-publish exception cannot apply, so a self-approval is denied (fail closed).
      collectionKey: r.collectionKey ?? "",
      locale: r.locale ?? "",
      itemCount: r.itemCount ?? 0,
      // WSK-49f. Listed here or it never reaches derived_roles.yaml (this is an allow-list).
      clientId: r.clientId ?? "",
      // M5-W1a. Listed here or they never reach derived_roles.yaml / resource_webdesk_*.yaml (allow-list).
      siteId: r.siteId ?? "",
      reviewState: r.reviewState ?? "",
      // DW-5c. Listed here or they never reach resource_work_request.yaml (this is an allow-list). Both fail closed:
      // "" never equals a principal id, and [] contains nobody.
      requestedBy: r.requestedBy ?? "",
      assigneeIds: r.assigneeIds ?? [],
      // DW-6h. Listed here or they never reach resource_creative_asset.yaml (this is an allow-list; the handler builds the
      // Resource through an object spread, where TypeScript's excess-property check does not fire). Both fail closed for
      // their ALLOW rules: [] contains nobody, and "" equals no principal id.
      requesterIds: r.requesterIds ?? [],
      reviewRequestedBy: r.reviewRequestedBy ?? "",
      // DW-8g. Listed here or they never reach resource_calendar_event.yaml (this is an allow-list; the handler builds the
      // Resource through an object spread, where TypeScript's excess-property check does not fire). Both fail closed: [] contains
      // nobody, and "attendees" is the narrow visibility (the company-visibility rule reads exactly "company").
      attendeeIds: r.attendeeIds ?? [],
      visibility: r.visibility ?? "attendees",
      // PV7-04a. Listed here or it never reaches resource_client_report.yaml (this is an allow-list). Fails closed: ""
      // equals no principal id.
      ownerUserId: r.ownerUserId ?? "",
      // DW-10a. Listed here or it never reaches resource_dept_notice.yaml (this is an allow-list; the handler builds the Resource
      // through an object spread, where TypeScript's excess-property check does not fire). Defaults to "unit": see the type's note.
      scope: r.scope ?? "unit",
      // DW-10c. Listed here or it never reaches resource_calendar_event.yaml (this is an allow-list). No rule reads it today; "" is
      // "no unit".
      unitNodeId: r.unitNodeId ?? "",
      // SCP-1b. Listed here or they never reach resource_social_*.yaml / derived_roles.yaml (this is an allow-list; the
      // social handlers build the Resource through an object spread of pipeline-authz.ts's facts, where TypeScript's
      // excess-property check does not fire). Both fail closed: [] contains nobody, and "" matches no designer rule.
      approverIds: r.approverIds ?? [],
      creativeSource: r.creativeSource ?? "",
      // SCP-1q. Listed here or it never reaches resource_position.yaml (this is an allow-list; a handler that builds the
      // Resource through an object spread gets no excess-property check). A dropped attribute means the self-EDIT DENY
      // never fires, which is the unsafe direction, so a test pins that it is carried (cerbos-position-self-edit.test.ts).
      holderIds: r.holderIds ?? [],
      // SCP-1r. Listed here or it never reaches resource_org_structure.yaml (this is an allow-list). A dropped attribute means the
      // unit self-edit DENY never fires, which is the unsafe direction, so a test pins that it is carried
      // (cerbos-org-structure-self-edit.test.ts).
      touchedLeadHolderIds: r.touchedLeadHolderIds ?? [],
    },
  };
}

/** Single authorization decision (Cerbos CheckResources). */
export async function check(p: Principal, r: Resource, action: string): Promise<Decision> {
  const res = await fetch(`${config.cerbosUrl}/api/check/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "platform",
      principal: principalPayload(p),
      resources: [{ actions: [action], resource: resourcePayload(r) }],
    }),
  });
  if (!res.ok) throw new Error(`cerbos ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ actions?: Record<string, string> }> };
  const effect = data.results?.[0]?.actions?.[action];
  return effect === "EFFECT_ALLOW" ? { allow: true } : { allow: false, reason: `cerbos denied ${action} on ${r.kind}` };
}

/**
 * Several actions on ONE resource in a single CheckResources call: the same request `check` makes, with the same
 * principal and resource payloads (so the attribute allow-list in `resourcePayload` cannot drift), for a UI capabilities
 * answer such as WebDesk media. ADVISORY for the caller: each real action still runs its own `check`.
 */
export async function checkActions(p: Principal, r: Resource, actions: readonly string[]): Promise<Record<string, boolean>> {
  const res = await fetch(`${config.cerbosUrl}/api/check/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "platform",
      principal: principalPayload(p),
      resources: [{ actions: [...actions], resource: resourcePayload(r) }],
    }),
  });
  if (!res.ok) throw new Error(`cerbos ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ actions?: Record<string, string> }> };
  const got = data.results?.[0]?.actions ?? {};
  return Object.fromEntries(actions.map((a) => [a, got[a] === "EFFECT_ALLOW"]));
}

/** Cerbos refuses a CheckResources request over 50 resources (the limit the repo already hit once). */
export const CERBOS_BATCH_LIMIT = 50;

/**
 * ONE action on MANY resources: the same principal and resource payloads `check` sends (so the attribute allow-list in
 * `resourcePayload` cannot drift), in chunks of at most `CERBOS_BATCH_LIMIT`. Answers a boolean per input resource, in input
 * order. ADVISORY like `checkActions`: it audits nothing and does not run `authorize()`'s session or act-for checks, so a caller
 * that returns data on the strength of it (DW-8i knowledge search) does those itself.
 *
 * FAILS CLOSED, per resource. A result is matched to its input by POSITION and then confirmed by its echoed `kind` and `id`;
 * a response of the wrong length, or a result that echoes a different resource or none, answers `false` for what it cannot vouch for.
 * An HTTP error throws (a caller must not read "Cerbos is down" as "nothing is allowed").
 */
export async function checkMany(p: Principal, resources: readonly Resource[], action: string): Promise<boolean[]> {
  const out: boolean[] = [];
  for (let i = 0; i < resources.length; i += CERBOS_BATCH_LIMIT) {
    const chunk = resources.slice(i, i + CERBOS_BATCH_LIMIT);
    const payloads = chunk.map(resourcePayload);
    const res = await fetch(`${config.cerbosUrl}/api/check/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "platform",
        principal: principalPayload(p),
        resources: payloads.map((resource) => ({ actions: [action], resource })),
      }),
    });
    if (!res.ok) throw new Error(`cerbos ${res.status}`);
    const data = (await res.json()) as {
      results?: Array<{ resource?: { kind?: string; id?: string }; actions?: Record<string, string> }>;
    };
    const results = Array.isArray(data.results) && data.results.length === chunk.length ? data.results : [];
    chunk.forEach((_, j) => {
      const got = results[j];
      const echoed = got?.resource;
      const matches = echoed !== undefined && (echoed.kind === payloads[j].kind && echoed.id === payloads[j].id);
      out.push(Boolean(got) && matches && got.actions?.[action] === "EFFECT_ALLOW");
    });
  }
  return out;
}

export interface QueryPlan {
  kind: "always-allowed" | "always-denied" | "conditional";
  /** For conditional plans: the raw Cerbos AST (the RLS layer maps the parts it supports). */
  condition?: unknown;
}

/**
 * PlanResources (D16): the authorization for a set-returning action as a PREDICATE rather
 * than N per-row checks. Callers apply the allowed-tenant filter (which the platform
 * already enforces via RLS) and treat "always-denied" as an early empty result.
 */
export async function planResources(p: Principal, kind: string, action: string): Promise<QueryPlan> {
  const res = await fetch(`${config.cerbosUrl}/api/plan/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "platform",
      principal: principalPayload(p),
      resource: { kind, attr: {} },
      action,
    }),
  });
  if (!res.ok) throw new Error(`cerbos plan ${res.status}`);
  const data = (await res.json()) as { filter?: { kind?: string; condition?: unknown } };
  const k = data.filter?.kind ?? "";
  if (k === "KIND_ALWAYS_ALLOWED") return { kind: "always-allowed" };
  if (k === "KIND_ALWAYS_DENIED") return { kind: "always-denied" };
  return { kind: "conditional", condition: data.filter?.condition };
}
