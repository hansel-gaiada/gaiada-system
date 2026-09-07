// P2-07 (structural gap) — the agent surface for tools owned by CORE controllers.
//
// ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────────────────────────
// `GET /mcp/tool-defs` returned `allModules().flatMap(m => m.mcpTools)`. Every tool therefore had to
// belong to a registered MODULE, and `positions` / `role-grants` belong to none: they are core
// controllers over core tables (`positions`, `position_assignments`, `role_grants` carry plain
// `tenant_isolation`, deliberately NOT module-gated — migration 0109's own header says the
// reconciler and admin flows read platform-wide). There was literally nowhere to declare them, so
// the entire IAM Phase 2 surface was unreachable to an agent while `hr.*` was reachable.
//
// The three options were: fold them into `hr` (semantically wrong — granting a role is not HR, and
// `hr`'s tools are the ones behind the HR module's RLS wall, which these are not); invent an `iam`
// ModuleContract (a module whose tables are core, whose migrations are core, and which no tenant can
// meaningfully disable — a module in name only, and `enabled_modules` would then imply a tenant could
// switch IAM off); or give core its own tool surface. This is the third.
//
// ── HOW A CORE TOOL DIFFERS FROM A MODULE TOOL, AND WHY IT MATTERS ───────────────────────────────
// A module tool is gated twice: the hub advertises it, and the module's controller 403s if the module
// is not enabled for the calling tenant (`ModuleEnabledGuard`). A CORE tool has no such second gate
// because there is no flag to consult — core is always on. Authorization is therefore entirely
// Cerbos + the controller's own guards, which is the same posture the human UI already has against
// these endpoints. Stated explicitly because "advertised to every tenant" is a stronger default than
// a module tool's, and anyone adding an entry here is choosing it.
import type { McpToolDef } from "../modules/contract";

const coreTools = new Map<string, McpToolDef>();

/**
 * Register core-owned tool defs. Throws on a duplicate NAME — including a name a module already
 * contributed, which is checked at aggregation time in `mcp-tools.controller.ts` rather than here
 * (this registry cannot see the module registry without an import cycle, and a duplicate must be
 * caught in the place that can see both).
 */
export function registerCoreTools(defs: McpToolDef[]): void {
  for (const def of defs) {
    if (coreTools.has(def.name)) throw new Error(`core tool already registered: ${def.name}`);
    coreTools.set(def.name, def);
  }
}

export function allCoreTools(): McpToolDef[] {
  return [...coreTools.values()];
}

/** Test-support twin of `resetModules()`; suites that assert the aggregate need a clean slate. */
export function resetCoreTools(): void {
  coreTools.clear();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE IAM PHASE 2 ENTRIES.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// ── WHAT IS HERE: reads, and the two PROPOSAL endpoints ──────────────────────────────────────────
// The proposals (`iam.requestAssignment`, `iam.requestOverride`) are declared as impact `low`, and
// that is a deliberate reading rather than an oversight. Their entire effect is to file a PENDING
// `automation_approvals` row that a human must then decide — the gate is downstream, in the decide
// surface, where `decide_assignment` / `decide_override` are separate permissions and self-approval
// is refused. Marking them medium would suspend the filing of a request behind an approval, i.e.
// require an approval to ask for an approval, and (because a medium write needs a D14 executor to
// complete at all) would make the natural agent path for "an agent notices a placement is needed"
// dead-end silently. Filing a request is the LOW-impact action; granting is the high one.
//
// ── THE FOUR DIRECT WRITES: DECIDED BY THE OWNER 2026-08-20, WITH AN EXPIRY ──────────────────────
// `iam.grantRole`, `iam.revokeRoleGrant`, `iam.assignPosition` and `iam.unassignPosition` are declared
// below. They were withheld until today, and the objection is kept on the record rather than deleted,
// because it was not answered — it was OUTRANKED by a fact about the data:
//
//   A tool that grants a role is a PRIVILEGE-ESCALATION surface. "An agent asks, a human clicks
//   approve" becomes a path to arbitrary role assignment, and the approver sees a tool name and an args
//   blob rather than the ceiling arithmetic `grant-write.service.ts` performs. The ceiling itself still
//   applies — the re-drive runs as the ORIGINAL FILING PRINCIPAL, so an agent can never exceed what the
//   human behind it holds — but audit attribution still says "Alice", not "Alice's agent"
//   ([agent-attribution-gate]).
//
// The owner ruled to proceed on the basis that every employee on the estate is seed/mock data except
// their own account. That was VERIFIED before shipping, not taken on trust: 23 `kind='employee'`
// memberships, every one a `.test` address except `hansel@gaiada.com` (the only account that can log in)
// and one `@gaiada.com` address with no login.
//
// ⚠ THE BASIS EXPIRES WHEN THE DATA DOES. The attribution gap is unchanged, and the moment real
// employee accounts exist these four become a genuine escalation surface with an audit trail that
// cannot say who used them. Closing [agent-attribution-gate] is a PRE-STAGING requirement, and this
// block is why it is not optional. See `core/approval-executables.ts`'s owner-decision block for what
// still bounds these regardless: one writer, the ceiling, the sensitive gate, the self-target DENY, and
// a human decision on every one of them because medium/high writes suspend.
//
// The PROPOSAL tools stay, and stay `low`: an agent that only needs to say "this person should be
// placed" should not have to reach for the write that can also do something else.
const IAM_CORE_TOOLS: McpToolDef[] = [
  {
    name: "iam.listPositions",
    description:
      "List org-chart seats for a company: unit node, title, lead flag, status, role-set size and current holders. The read behind 'who sits where'.",
    minAssurance: "verified",
    method: "GET",
    pathTemplate: "/api/:tenantId/positions",
    // No filter args: the handler takes none, and it narrows the result set itself — a dept-head
    // caller gets the union of their own lead subtrees, a scope-only tier gets the tenant. Advertising
    // an unitNodeId/status filter the endpoint ignores would be a schema that lies to the caller.
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" } },
      required: ["tenantId"],
    },
  },
  {
    name: "iam.listAttachableRoles",
    description:
      "The roles that may be attached to a position, as the caller's own authority allows — the grantable set, not the full catalog. Read this before proposing a placement.",
    minAssurance: "verified",
    method: "GET",
    pathTemplate: "/api/:tenantId/positions/attachable-roles",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" } },
      required: ["tenantId"],
    },
  },
  {
    name: "iam.listRoleGrants",
    description:
      "Manual role grants in this company: who holds what, at which scope, granted by whom, with any expiry. Position-derived grants are NOT here — those come from the seat (iam.listPositions).",
    minAssurance: "verified",
    method: "GET",
    pathTemplate: "/api/:tenantId/role-grants",
    // `userId` is REQUIRED, not a filter: the endpoint 400s without it, and deliberately so — the
    // read is authorized against THAT target's unit ancestry, so there is no "all grants" form to ask
    // for. A schema that made it optional would produce a 400 an agent could not diagnose.
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        userId: { type: "string", description: "the principal whose grants to read" },
      },
      required: ["tenantId", "userId"],
    },
  },
  {
    name: "iam.requestAssignment",
    description:
      "PROPOSE that a person be placed into a position. Files a pending request for a human (HR or a company admin) to decide; it does NOT open the seat. A justification is required.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/positions/:positionId/assignment-requests",
    write: true,
    // LOW because the whole effect is a pending row. See the block comment above.
    impact: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        positionId: { type: "string" },
        userId: { type: "string", description: "the person proposed for the seat" },
        justification: { type: "string", description: "why this placement — shown to the human deciding" },
      },
      required: ["tenantId", "positionId", "userId", "justification"],
    },
  },
  {
    name: "iam.requestOverride",
    description:
      "PROPOSE a role grant that exceeds what the requester may grant directly. Files a pending request routed to an approver who holds the right to decide it; it grants nothing by itself.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/role-grants/overrides",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        userId: { type: "string" },
        roleId: { type: "string" },
        // `scopeType`, matching the handler's body field exactly, and WITHOUT "global": this surface
        // refuses it (a global override is not an exception to one company's org chart). Naming it
        // `scopeKind` — as the DB column family does elsewhere — would have been silently ignored and
        // defaulted to "company", which is the worst kind of wrong: a successful call doing something
        // other than what was asked.
        scopeType: { type: "string", enum: ["company", "org_unit"], default: "company" },
        scopeId: { type: "string", description: "required when scopeType is org_unit" },
        expiresInDays: { type: "integer", description: "defaults to the surface's own default" },
        justification: { type: "string" },
      },
      required: ["tenantId", "userId", "roleId", "justification"],
    },
  },

  // ── the four direct writes (owner decision 2026-08-20) ─────────────────────────────────────────
  {
    name: "iam.grantRole",
    description:
      "Grant a role directly. Bounded by the granter's own ceiling, the ui_grantable allow-list and the sensitive gate — a grant above the ceiling is refused, and iam.requestOverride is the path for it.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/role-grants",
    write: true,
    // HIGH: the one tool here that can WIDEN somebody's authority. Impact drives urgency and the
    // notification tier, not whether a human is asked — medium and high both suspend.
    impact: "high",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        userId: { type: "string" },
        roleId: { type: "string" },
        scopeType: { type: "string", enum: ["company", "org_unit"], default: "company" },
        scopeId: { type: "string", description: "required when scopeType is org_unit" },
        temporary: { type: "boolean" },
        expiresInDays: { type: "integer" },
        reason: { type: "string" },
      },
      required: ["tenantId", "userId", "roleId"],
    },
  },
  {
    name: "iam.revokeRoleGrant",
    description:
      "Revoke a manual role grant. Position- and service-managed grants are refused: the reconciler would restore them, so the fix is to change the position instead.",
    minAssurance: "verified",
    method: "DELETE",
    pathTemplate: "/api/:tenantId/role-grants/:grantId",
    write: true,
    // MEDIUM, not high: taking access away cannot escalate anyone. It can still break somebody's day,
    // which is why it suspends rather than running unattended.
    impact: "medium",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, grantId: { type: "string" } },
      required: ["tenantId", "grantId"],
    },
  },
  {
    name: "iam.assignPosition",
    description:
      "Place a person in an existing seat; their access then follows that seat's role-set. This cannot confer anything the seat does not already carry.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/positions/:positionId/assign",
    write: true,
    // MEDIUM rather than high, for a structural reason: a placement can only confer what the position's
    // role-set already carries, and that role-set was authored by a human through a surface with its own
    // allow-list. The escalation ceiling is the position registry, not the caller's imagination.
    impact: "medium",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        positionId: { type: "string" },
        userId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["tenantId", "positionId", "userId"],
    },
  },
  {
    name: "iam.unassignPosition",
    description:
      "Remove a person from a seat. Grants that only that seat justified are revoked; one a second seat also justifies survives with its reference count decremented.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/positions/:positionId/unassign",
    write: true,
    impact: "medium",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        positionId: { type: "string" },
        userId: { type: "string" },
      },
      required: ["tenantId", "positionId", "userId"],
    },
  },
];

/**
 * Exported for the same reason `registerJmlExecutableApprovals` is: a suite that calls
 * `resetCoreTools()` can restore exactly the production set without keeping a second copy of these
 * defs, which is how two copies drift.
 */
export function registerIamCoreTools(): void {
  registerCoreTools(IAM_CORE_TOOLS);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AD-8 — `agency_intake.*`, the readiness-bar criterion-1 tool parity for Agency Discovery Intake.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Design: docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md §8 (compliance table),
// §9.2 (staff surfaces), §6.2 (convert idempotency). Contract:
// docs/FRONTEND-BFF-CONTRACT.md → "Agency Discovery Intake" — every pathTemplate/method pair below is
// copied from that table verbatim, not re-derived, so this file cannot drift from the documented
// staff surface.
//
// ── WHY HERE, NOT A MODULE (mirrors this file's own header) ─────────────────────────────────────────
// `agency_leads` / `agency_discovery_submissions` take the PLAIN tenant wall, deliberately NOT
// module-gated (design §3.1: the token-guarded prospect intake endpoint is a core surface with no
// module scope, and a `ModuleEnabledGuard` in front of the staff side only would let a disabled
// `agency` module strand a queue staff could no longer open while prospects kept submitting into it).
// So exactly like `positions`/`role-grants`, there is no module these belong to — core is where a
// core-table controller's tools go.
//
// ── ONLY `convert` GETS A `write:true, impact:"medium"` ─────────────────────────────────────────────
// It mints a client, a project and a delivery run (design §4.2) — the design's own §8 table calls this
// out as the one write in the feature that is not "a human waves it through without reading". The three
// triage dispositions (open/decline/nurture) and the invite mint are LOW: each moves one row through a
// state machine or issues a token, none creates a billable/commercial artifact.
//
// ── §8(b) — CONVERT IS REGISTERED, BUT THIS SHIPS NO CLAIM THAT IT COMPLETES UNATTENDED ─────────────
// `impact:"medium"` is what makes mcp-hub/src/policy.ts SUSPEND an unattended (agent or n8n) call to
// `agency_intake.convert` before it ever reaches the platform — proven by
// mcp-hub/src/agency-intake-tools.test.ts. Separately, `core/approval-executables.ts` now carries a
// real executor entry for this tool (lockKey + precondition against real Postgres), which is what
// keeps a human-approved row from sitting at `execution_status='not_applicable'` forever — see that
// file's own AD-8 section for the full reasoning and for why this ticket does NOT assert a full
// approve-then-executed round trip (that needs a reachable mcp-hub + Cerbos, out of every D14 registry
// suite's reach in this harness; see d14-09-agent-origin-authority.test.ts's identical scope note).
const AGENCY_INTAKE_CORE_TOOLS: McpToolDef[] = [
  // ── reads ──────────────────────────────────────────────────────────────────────────────────────
  {
    name: "agency_intake.listLeads",
    description:
      "The staff discovery-intake queue. Sorted by whose move it is, NOT by recency: submitted, then " +
      "new, then invited, then everything else, oldest-first within each tier (design §9.2 rule 1) — " +
      "do not re-sort by createdAt. A 403 is a refusal, never an empty queue (criterion 5): render the " +
      "denial rather than treating [] as 'nothing here'.",
    minAssurance: "verified",
    method: "GET",
    pathTemplate: "/api/:tenantId/agency/leads",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" } },
      required: ["tenantId"],
    },
  },
  {
    name: "agency_intake.getLead",
    description:
      "One lead plus its latest submission's answers, keyed by the questionnaire's stable field ids. " +
      "A key ABSENT from `answers` means the prospect was never asked or left it blank — never rendered " +
      "as an empty string; that distinction is the whole point of a reviewer reading this. 404 if the " +
      "lead does not exist or is not visible; a 403 (cannot read agency_lead at all) is a distinct, " +
      "typed refusal, never folded into the 404.",
    minAssurance: "verified",
    method: "GET",
    pathTemplate: "/api/:tenantId/agency/leads/:leadId",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, leadId: { type: "string" } },
      required: ["tenantId", "leadId"],
    },
  },
  {
    name: "agency_intake.listSubmissions",
    description:
      "Full submission history for a lead, including `supersedes_id` chains — a submission is INSERT-only " +
      "(a correction is a NEW row, never an edit). A separate Cerbos resource from `agency_lead` " +
      "(`agency_discovery_submission:read`).",
    minAssurance: "verified",
    method: "GET",
    pathTemplate: "/api/:tenantId/agency/leads/:leadId/submissions",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, leadId: { type: "string" } },
      required: ["tenantId", "leadId"],
    },
  },

  // ── writes: low-impact — one row through a state machine, or a token minted ──────────────────────
  {
    name: "agency_intake.invite",
    description:
      "Mint a discovery-questionnaire invite for a lead and advance it new/invited-eligible -> invited " +
      "in the same transaction. The PLAINTEXT token is returned exactly once, here, and is never " +
      "recoverable afterward — only its hash is stored; a lost link must be re-minted, not looked up. " +
      "Refuses (409, `reason: 'lead_already_dispositioned'`) for a lead already converted or declined.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/agency/leads/:leadId/invite",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        leadId: { type: "string" },
        ttlDays: { type: "integer", description: "Invite lifetime in days, capped at 365. Omit for the platform's own default." },
      },
      required: ["tenantId", "leadId"],
    },
  },
  {
    name: "agency_intake.open",
    description:
      "submitted -> in_review: mark that someone has picked this lead up. NOT a disposition (decline/nurture " +
      "are); an illegal transition (e.g. already converted) 409s naming the current status rather than " +
      "silently no-opping.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/agency/leads/:leadId/open",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, leadId: { type: "string" } },
      required: ["tenantId", "leadId"],
    },
  },
  {
    name: "agency_intake.decline",
    description:
      "in_review -> declined. `reason` is REQUIRED (the DB's own CHECK enforces it; this surface returns a " +
      "typed 400 first rather than letting a reasonless decline hit that constraint as a raw 500).",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/agency/leads/:leadId/decline",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        leadId: { type: "string" },
        reason: { type: "string", description: "Why this lead is being declined. Required." },
      },
      required: ["tenantId", "leadId", "reason"],
    },
  },
  {
    name: "agency_intake.nurture",
    description:
      "in_review -> nurturing: 'not this quarter', distinct from a decline ('we said no'). Does not " +
      "re-mint or re-send an invite.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/agency/leads/:leadId/nurture",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, leadId: { type: "string" } },
      required: ["tenantId", "leadId"],
    },
  },

  // ── the one medium-impact write ───────────────────────────────────────────────────────────────────
  {
    name: "agency_intake.convert",
    description:
      "Convert a lead: mints a client, a project, a delivery run seeded from the prospect's own answers, " +
      "and delegation tasks (design §4.2/§4.3) — one transaction. A lead already converted (or no longer " +
      "open — declined leads refuse too) returns 409 with `{existing:{clientId,projectId,runId}}`: a " +
      "retrying caller must branch on THAT shape to learn 'already done, here are the ids' rather than " +
      "treat it as a bare failure and retry into a false 'broken' conclusion. impact:'medium' — this is " +
      "the one write in the namespace that is D14-gated: called by an unattended agent or n8n workflow it " +
      "SUSPENDS for human approval rather than completing in the same call (design §8(b); the D14 " +
      "resume/execute path itself is a separate, estate-wide concern this tool's registration does not " +
      "attempt to resolve).",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/agency/leads/:leadId/convert",
    write: true,
    impact: "medium",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        leadId: { type: "string" },
        delegations: {
          type: "array",
          description:
            "Optional overrides/additions to the canonical delegation plan. An entry whose `role` matches " +
            "a canonical role (discovery_review/sitemap/integrations/content_owners/dns) REPLACES that " +
            "default entirely; any other (or absent) `role` is appended as its own task.",
          items: {
            type: "object",
            properties: {
              role: { type: "string" },
              assigneeId: { type: "string", description: "Must be an existing staff member; re-verified server-side." },
              dueAt: { type: "string", description: "YYYY-MM-DD" },
              title: { type: "string" },
            },
            required: ["assigneeId"],
          },
        },
      },
      required: ["tenantId", "leadId"],
    },
  },
];

/**
 * Exported for the same reason `registerIamCoreTools` is: a suite that calls `resetCoreTools()` can
 * restore exactly this production set without keeping a second copy of these defs.
 */
export function registerAgencyIntakeCoreTools(): void {
  registerCoreTools(AGENCY_INTAKE_CORE_TOOLS);
}

/**
 * The ONE aggregate, mirroring `approval-executables.ts`'s `registerAllExecutableApprovals()` doctrine
 * — that file's own header names the exact failure mode a hand-maintained list of "call these to
 * restore" invites: a suite restores the areas IT knows about, and every LATER suite in the same
 * vitest worker inherits a silently incomplete registry (this broke D14-17 on main, 2026-08-23, for
 * the executable-approvals registry specifically). `registerIamCoreTools`/`registerAgencyIntakeCoreTools`
 * stay exported for a suite that deliberately wants only its own area, but any suite that wants "the
 * production core set back" should call this, not enumerate the areas by hand.
 */
export function registerAllCoreTools(): void {
  registerIamCoreTools();
  registerAgencyIntakeCoreTools();
}

registerAllCoreTools();
