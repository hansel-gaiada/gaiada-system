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
// ── WHAT IS DELIBERATELY NOT HERE, AND WHY IT IS AN OWNER DECISION ───────────────────────────────
// `POST :tenantId/role-grants` (grant a role), `DELETE :tenantId/role-grants/:grantId`, and
// positions' direct `assign`/`unassign` are NOT declared. This is not the "no executor yet" reason
// that held the JML writes back last release — that one is now solved and the pattern is worked
// (`registerJmlExecutableApprovals`). This is a different objection, and a bigger one:
//
//   A tool that grants a role is a PRIVILEGE-ESCALATION surface. Adding it makes "an agent asks, a
//   human clicks approve" a path to arbitrary role assignment, and the approver sees a tool name and
//   an args blob rather than the ceiling arithmetic `grant-write.service.ts` performs. The
//   ceiling itself still applies (the re-drive runs as the original filing principal, so an agent
//   cannot exceed what that principal holds) — but the estate has an unresolved gap the program
//   already recorded: audit attribution says "Alice", not "Alice's agent"
//   [agent-attribution-gate]. Granting rights through a surface whose attribution is known to be
//   wrong is exactly the combination worth refusing until someone decides it on purpose.
//
// The proposal endpoints give an agent the useful 90% (notice, propose, justify) with no escalation:
// a filed request that a human executes. If the owner later wants direct grant tools, the work is
// three D14 entries plus `resource_mcp_tool.yaml` allow-list names — small, and blocked on the
// decision rather than on the code.
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
];

/**
 * Exported for the same reason `registerJmlExecutableApprovals` is: a suite that calls
 * `resetCoreTools()` can restore exactly the production set without keeping a second copy of these
 * defs, which is how two copies drift.
 */
export function registerIamCoreTools(): void {
  registerCoreTools(IAM_CORE_TOOLS);
}

registerIamCoreTools();
