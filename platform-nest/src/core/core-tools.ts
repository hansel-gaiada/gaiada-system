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
      "Decline a lead from ANY open status (new, invited, submitted, in_review or nurturing) -> declined, " +
      "and its pipeline stage becomes `lost` in the same transaction (unused invite links are revoked). " +
      "`reason` is REQUIRED (the DB's own CHECK enforces it; this surface returns a typed 400 first rather " +
      "than letting a reasonless decline hit that constraint as a raw 500). A converted or declined lead " +
      "409s naming its current status.",
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

  // ── M5-L4: a gaiada.com form submission becomes a lead ──────────────────────────────────────────
  {
    name: "agency_intake.createFromWebSubmission",
    description:
      "File a gaiada.com (WebDesk) form submission as an agency lead (source 'web', status 'new'). The " +
      "platform FETCHES the submission from WebDesk itself (forms.submission.get) — pass only the " +
      "submission's id and the WebDesk tenant slug, never field values. Idempotent per (tenant, submission): " +
      "a repeat returns the existing lead (200, created:false). 410 `submission-gone` = purged or erased, " +
      "nothing created; 422 `unmapped_form` = the form has no lead mapping; 422 `subject_suppressed` = the " +
      "submitter was erased on request (M5-G5), nothing stored; 409 `web_leads_disabled` = " +
      "AGENCY_WEB_LEADS_ENABLED is off. Authorized as the existing agency-lead create. impact:'medium' — it " +
      "files a prospect's personal data into the CRM, so an unattended caller SUSPENDS for human approval.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/agency/leads/from-web-submission",
    write: true,
    impact: "medium",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        siteSlug: { type: "string", description: "The WebDesk tenant slug (the form.received event's data.siteSlug). Must belong to this company." },
        submissionId: { type: "string", description: "The WebDesk submission id (uuid)." },
      },
      required: ["tenantId", "siteSlug", "submissionId"],
    },
  },

  // ── M5-L6: the Website → Leads read ─────────────────────────────────────────────────────────────
  {
    name: "agency_intake.listWebLeads",
    description:
      "The web leads (source 'web') filed from one WebDesk site (tenant) slug, newest first, at most 200 " +
      "(`truncated` says more exist). Per lead: org/contact name, form key, received-at, pipeline stage and status, " +
      "an attribution summary (landing, form page, referrer, utm source/medium/campaign, and which click ids are " +
      "PRESENT by name — never their values) and the visitor's marketing consent (true / false / null = unknown, " +
      "which counts as no consent). `leadIntakeEnabled` is false while AGENCY_WEB_LEADS_ENABLED is off: an empty " +
      "list then means intake is off, not that no one submitted. A 403 is a refusal, never an empty list.",
    minAssurance: "verified",
    method: "GET",
    pathTemplate: "/api/:tenantId/agency/web-leads/:siteSlug",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        siteSlug: { type: "string", description: "The WebDesk tenant slug of the site (e.g. the one in the Website workspace's URL)." },
      },
      required: ["tenantId", "siteSlug"],
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
        deal: {
          type: "object",
          description:
            "Optional deal value to record on the lead in the same transaction as the move to stage `won` " +
            "(M5-P1). Needs the `update` permission as well as `convert`. Omit to leave the value as it is.",
          properties: {
            value: { type: ["string", "number"], description: "Non-negative decimal, preferably a string. Exact at the currency's minor unit (IDR 0 decimals, USD 2)." },
            currency: { type: "string", description: "ISO 4217 code from `agency_pipeline.reference`." },
          },
          required: ["value", "currency"],
        },
      },
      required: ["tenantId", "leadId"],
    },
  },
];

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// M5-P1-c — `agency_pipeline.*`, the lead pipeline's agent surface (WSK-D69).
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Design: docs/plans/2026-10-11-m5-lead-pipeline-design.md §6. Routes: core/agency-leads.controller.ts.
// No new Cerbos kind or action: a stage move is `triage` (+ `update` when it carries a deal), a value is
// `update`, the reads are `read`. WON and LOST have no tool here on purpose: won is `agency_intake.convert`
// (medium, D14-gated) and lost is `agency_intake.decline`.
//
// ── WHY `moveStage` IS LOW, NOT MEDIUM ──────────────────────────────────────────────────────────
// A move sends nothing itself. Its only external effect, a P2 ad-platform upload, needs its own WS4 approval
// (filing that request is the low-impact act, IAM's precedent above). A low tool needs no executor entry.
const AGENCY_PIPELINE_CORE_TOOLS: McpToolDef[] = [
  {
    name: "agency_pipeline.reference",
    description:
      "The pipeline vocabulary: every stage in order (`key`, `position`, `kind` open|won|lost, `label`) and the " +
      "active currencies (`code`, `symbol`, `minorUnit`). Read it before a move or a value: stage keys are data, " +
      "not a fixed list, and a currency's minorUnit decides how many decimals a value may carry.",
    minAssurance: "verified",
    method: "GET",
    pathTemplate: "/api/:tenantId/agency/pipeline/reference",
    inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
  },
  {
    name: "agency_pipeline.stageHistory",
    description:
      "One lead's stage history, newest first: from/to stage, the deal value at that moment (a decimal STRING), " +
      "who moved it and `viaAgent` when an agent drove it. No personal data. 404 when the lead does not exist or " +
      "is not visible; a 403 is a distinct refusal.",
    minAssurance: "verified",
    method: "GET",
    pathTemplate: "/api/:tenantId/agency/leads/:leadId/stage-history",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, leadId: { type: "string" } },
      required: ["tenantId", "leadId"],
    },
  },
  {
    name: "agency_pipeline.moveStage",
    description:
      "Move a lead to an OPEN stage (enquiry, contacted, qualified, proposal; see `agency_pipeline.reference`), " +
      "forwards or backwards. A staff decision, never a reaction to something a prospect did. Moving to the stage " +
      "it is already at returns changed:false and writes nothing (safe to retry). `won` and `lost` are refused " +
      "(400 `stage_terminal`): won is `agency_intake.convert`, lost is `agency_intake.decline`. A converted or " +
      "declined lead 409s `lead_closed`. An optional `deal` sets the value in the same call and needs the `update` " +
      "permission too. impact:'low': a move sends nothing itself; an ad-platform upload it may trigger needs its " +
      "own approval.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/agency/leads/:leadId/stage",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        leadId: { type: "string" },
        stage: { type: "string", description: "An open stage key from `agency_pipeline.reference`." },
        deal: {
          type: "object",
          description: "Optional value to set with the move. Both members are required when `deal` is sent.",
          properties: {
            value: { type: ["string", "number"], description: "Non-negative decimal, preferably a string; exact at the currency's minor unit." },
            currency: { type: "string", description: "ISO 4217 code from `agency_pipeline.reference`." },
          },
          required: ["value", "currency"],
        },
      },
      required: ["tenantId", "leadId", "stage"],
    },
  },
  {
    name: "agency_pipeline.setDealValue",
    description:
      "Set or clear a lead's deal value, in any status. Send {value, currency} to set (value is a decimal string " +
      "exact at the currency's minor unit: IDR takes no decimals, USD two) or {value:null, currency:null} to clear; " +
      "value and currency are set together or not at all. Typed 400 reasons: `deal_incomplete`, " +
      "`deal_value_invalid`, `deal_currency_unknown`, `deal_value_precision`. Emits no stage event. impact:'low'.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/agency/leads/:leadId/deal",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        leadId: { type: "string" },
        value: { type: ["string", "number", "null"], description: "Non-negative decimal (preferably a string), or null to clear." },
        currency: { type: ["string", "null"], description: "ISO 4217 code, or null to clear." },
      },
      required: ["tenantId", "leadId", "value", "currency"],
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

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// PV3-06 — `contracts.*` and `invoicePayments.*`: the billing tools, readiness-bar criterion 1 for the
// staff "Contracts & billing" page (PV3-08).
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Plan: docs/plans/2026-10-11-pv3-hub-symmetry-tickets.md (PV3-06). Routes: core/contracts.controller.ts.
// The agentic-native plan called invoicing "the one GM loop with zero automation surface"; staff UI for
// legal and money writes without these tools would have widened that gap.
//
// Every tool is a thin front over ONE existing endpoint, so it carries exactly that endpoint's Cerbos
// authorization (`contract` read/create/update/send/countersign, `invoice` read/update) and nothing
// more. The hub fills `:param` tokens from the args and sends the rest as the JSON body; on a GET the
// remaining args are DROPPED, which is why the two list tools carry `clientId` as a `?clientId=:clientId`
// token in the path (the reports tools' pattern) and therefore REQUIRE it. A listing is per client by
// design: the staff page is per client, and an unscoped 300-row dump is not something an agent should
// ask for.
//
// ── READ ASSURANCE (PV-D28, 2026-10-13) ────────────────────────────────────────────────────────
// `contracts.list` and `invoicePayments.list` are `minAssurance: "low"`, unlike every other tool here. An n8n
// principal is ALWAYS "low" (mcp-hub never elevates one: assurance.test.ts), so at "verified" the daily
// `wf:billing-chaser` the owner ruled in (PV-D28) would be refused on assurance before its allow-list scope was
// ever consulted. The two are plain per-client reads; the data is still gated per caller by Cerbos at the
// endpoint (`contract`/`invoice` `read`, which a service account holds only as manager or above). Every WRITE
// here, and `contracts.get`, stay "verified"; the workflow's allow-list names exactly the two reads.
//
// ── IMPACT ──────────────────────────────────────────────────────────────────────────────────────
//   createDraft / updateDraft  LOW     a draft reaches nobody: it is created `draft`, and `send` is a
//                                       separate, separately authorized act. Editing is refused by the
//                                       route once the contract is no longer a draft.
//   send                       MEDIUM  it issues terms to a client and notifies their portal contacts.
//   countersign                HIGH    it binds the company to the contract. Only a company owner or
//                                       platform_admin passes Cerbos (PV3-01); company_admin and custom
//                                       roles are refused by the route, so an agent acting for one is
//                                       refused with the same 403 (a delegated call must pass for the
//                                       human behind it as well).
//   invoicePayments.decide     HIGH    it makes money real: only a `confirmed` payment counts toward a
//                                       balance and this is the only place an invoice moves to `paid`.
//
// ── MAKER-CHECKER ───────────────────────────────────────────────────────────────────────────────
// The person who recorded a payment cannot confirm it. The D14 re-drive runs as the ORIGINAL FILING
// PRINCIPAL (approval-execute.ts, invariant 1), so `decidePayment`'s own recorder check applies to an
// approved agent call exactly as to a human click: a recorder whose agent files `decide` is refused
// (403) at execution. The tools add no bypass because they call the route.
//
// ── IDEMPOTENCY (criterion 3) ──────────────────────────────────────────────────────────────────
// `contracts.createDraft` REQUIRES `reference`, the contract's natural dedupe key: the route inserts with
// `ON CONFLICT (tenant_id, reference, version) DO NOTHING` against `ix_contracts_reference_uniq`, and a
// retry returns the existing contract with `deduped: true`. `send`, `countersign` and `decide` are state
// transitions that refuse a repeat (already sent; `alreadySigned`; already decided), so a retry cannot
// double-apply, and each is also guarded by its D14 precondition.
//
// ── OBSERVABILITY (criterion 6) ────────────────────────────────────────────────────────────────
// `created`, `sent`, `countersigned`, and `confirmed`/`rejected` each write an `activities` row with the
// actor, and `writeActivity` stamps `metadata.via` (the agent or workflow that drove the call) and the
// approval behind it, so the actor may be non-human and is never assumed human.
const CONTRACT_BILLING_CORE_TOOLS: McpToolDef[] = [
  // ── reads ──────────────────────────────────────────────────────────────────────────────────────
  {
    name: "contracts.list",
    description:
      "One client's contracts, newest first (max 300), each with status (draft|sent|signed|declined|expired|void), " +
      "who has signed (`clientSigned`, `providerSigned`) and `canCountersign` (true only when the caller may " +
      "countersign this company's contracts AND the row is `sent` and awaiting our signature). `clientId` is a " +
      "client uuid; a malformed id is a 400. A 403 is a refusal, never an empty list (criterion 5).",
    minAssurance: "low", // PV-D28: see "READ ASSURANCE" in the section header
    method: "GET",
    pathTemplate: "/api/:tenantId/contracts?clientId=:clientId",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, clientId: { type: "string", description: "the client's uuid" } },
      required: ["tenantId", "clientId"],
    },
  },
  {
    name: "contracts.get",
    description:
      "One contract with its terms (`bodyMd`, `fileId`), value, term dates, `canCountersign` and its signatures " +
      "(party, signer, signer name and title, signedAt). 404 if it does not exist; a 403 is a distinct refusal.",
    minAssurance: "verified",
    method: "GET",
    pathTemplate: "/api/:tenantId/contracts/:contractId",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, contractId: { type: "string" } },
      required: ["tenantId", "contractId"],
    },
  },
  {
    name: "invoicePayments.list",
    description:
      "One client's payment claims (max 300), pending first: amount, method, reference, status, `recordedBy`, " +
      "`proofFileId` and the invoice's total and status. Deciding one is `invoicePayments.decide`. A 403 is a " +
      "refusal, never an empty list.",
    minAssurance: "low", // PV-D28: see "READ ASSURANCE" in the section header
    method: "GET",
    pathTemplate: "/api/:tenantId/invoice-payments?clientId=:clientId",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, clientId: { type: "string", description: "the client's uuid" } },
      required: ["tenantId", "clientId"],
    },
  },

  // ── low: drafts reach nobody ───────────────────────────────────────────────────────────────────
  {
    name: "contracts.createDraft",
    description:
      "Draft a contract for a client. Always created `draft`: sending it is `contracts.send`. IDEMPOTENT on " +
      "`reference` (the dedupe key): a retry with the same reference returns the existing contract's id with " +
      "`deduped:true` instead of a second draft, and the same reference under a different client is a 409. " +
      "`projectId` must belong to that client. `supersedesId` re-issues an earlier contract as the next version. " +
      "PRICE CHANGES (PV4-04): `kind:'amendment'` drafts an amendment and REQUIRES `amendsId`, a SIGNED contract of the same " +
      "client (400 `amends_id_invalid` otherwise); an amendment never voids or supersedes what it amends. " +
      "`changeRequestId` ties the draft to the webdev change request whose price it records (the request must already be triaged " +
      "`changes_price` and not waiting on a live or signed amendment) and points the request at this draft. Until that " +
      "contract is signed, the request cannot start work (409 `amendment_not_signed`).",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/contracts",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        clientId: { type: "string" },
        title: { type: "string" },
        reference: { type: "string", description: "REQUIRED here: the contract's own number (e.g. GDA-2026-014). It is the idempotency key." },
        projectId: { type: "string", description: "optional; must be a project of this client" },
        bodyMd: { type: "string", description: "the terms, in markdown. A contract needs this or a file before it can be sent." },
        fileId: { type: "string", description: "an uploaded document (files target `contract`)" },
        value: { type: "number", description: "non-negative" },
        currency: { type: "string", description: "defaults to IDR" },
        startsOn: { type: "string", description: "YYYY-MM-DD" },
        endsOn: { type: "string", description: "YYYY-MM-DD, not before startsOn" },
        supersedesId: { type: "string" },
        kind: { type: "string", enum: ["agreement", "amendment"], description: "defaults to agreement; an amendment requires amendsId" },
        amendsId: { type: "string", description: "kind 'amendment' only: the SIGNED contract of this client it amends" },
        changeRequestId: { type: "string", description: "the webdev change request (triaged changes_price) this draft records the price of" },
      },
      required: ["tenantId", "clientId", "title", "reference"],
    },
  },
  {
    name: "contracts.updateDraft",
    description:
      "Edit a DRAFT contract's title, reference, terms, file, value, currency or term dates (only the fields sent " +
      "change). Refused (400) once the contract is no longer a draft: a signed contract is never edited in place, " +
      "re-issue it with `contracts.createDraft` and `supersedesId`. Voiding is a staff action in the UI, not this tool (a `status` sent through it is refused with `status_not_allowed_via_automation`).",
    minAssurance: "verified",
    method: "PATCH",
    pathTemplate: "/api/:tenantId/contracts/:contractId",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        contractId: { type: "string" },
        title: { type: "string" },
        reference: { type: "string" },
        bodyMd: { type: "string" },
        fileId: { type: "string" },
        value: { type: "number" },
        currency: { type: "string" },
        startsOn: { type: "string", description: "YYYY-MM-DD" },
        endsOn: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["tenantId", "contractId"],
    },
  },

  // ── medium / high: D14, each with an executor entry in approval-executables.ts ─────────────────
  {
    name: "contracts.send",
    description:
      "Issue a DRAFT contract to the client: draft -> sent, and notify their portal contacts. Refused (400) when it is " +
      "not a draft or has neither terms nor a file. impact:'medium': an unattended caller SUSPENDS for human approval, " +
      "and approving it runs the send.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/contracts/:contractId/send",
    write: true,
    impact: "medium",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, contractId: { type: "string" } },
      required: ["tenantId", "contractId"],
    },
  },
  {
    name: "contracts.countersign",
    description:
      "Sign for OUR company. Only a company owner or platform_admin may; a company_admin is refused (403). The contract " +
      "becomes `signed` only when BOTH parties have signed, in either order, so this alone may leave it `sent`. A repeat " +
      "returns `alreadySigned:true`. impact:'high': an unattended caller SUSPENDS for human approval, and approving it " +
      "runs the signature as the original filing principal.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/contracts/:contractId/countersign",
    write: true,
    impact: "high",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        contractId: { type: "string" },
        signerName: { type: "string", description: "the signer's full name (at least 2 characters)" },
        signerTitle: { type: "string", description: "the signer's title" },
      },
      required: ["tenantId", "contractId", "signerName"],
    },
  },
  {
    name: "invoicePayments.decide",
    description:
      "Confirm or reject a payment a client recorded. `reject` needs a `reason` (shown to the client). Refused (403) for " +
      "whoever recorded the payment (maker-checker) and (400) when it is no longer pending. Confirming is what makes the " +
      "money count toward the balance and can mark the invoice paid. impact:'high': an unattended caller SUSPENDS for human " +
      "approval, and approving it runs the decision as the original filing principal.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/invoice-payments/:paymentId/decide",
    write: true,
    impact: "high",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        paymentId: { type: "string" },
        decision: { type: "string", enum: ["confirm", "reject"] },
        reason: { type: "string", description: "required when decision is reject" },
      },
      required: ["tenantId", "paymentId", "decision"],
    },
  },
];

/** PV3-06: the eight billing tools; exported so a suite can restore exactly this area. */
export function registerContractBillingCoreTools(): void {
  registerCoreTools(CONTRACT_BILLING_CORE_TOOLS);
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
  registerAgencyPipelineCoreTools();
  registerAgencyPrivacyCoreTools();
  registerContractBillingCoreTools();
}

// =================================================================================================
// M5-G5 - `agency_privacy.*`, data-subject requests over the agency intake data (addendum section 9.3 item 3).
// =================================================================================================
//
// Route: core/agency-privacy.controller.ts; flow: core/agency-privacy.service.ts. HIGH for all three, the
// WSK-38 classification (finding or exporting one person's whole footprint concentrates personal data the way
// no ordinary read does; erase is irreversible). The ROUTE is the WS4 gate for every principal, humans
// included (the SM-21 shape): the first call files an approval and returns 202, and the same call repeated with
// the approved `approvalId` runs exactly once. The hub's own gate still suspends an UNATTENDED caller on top,
// and the three names are BARRED from D14 auto-execution (approval-executables.ts): a hub re-drive would only
// file a second route-level approval, so an approved hub row must never pretend to have run the command.
//
// UNATTENDED CALLERS (M5-G5b): an agent's or workflow's call is suspended BY THE HUB before it reaches the route,
// and the caller files the suspension through `approvals.request` -> `POST /automation-approvals`. That filing
// path reduces these tools' args to the G5 subject hashes (+ a display hint) BEFORE storing or emitting anything,
// via the args policy in core/approval-arg-minimisers.ts (the minimiser itself is core/agency-privacy.filing.ts,
// next to the tool's other privacy code), so the approval row, the decided event and the notification never carry
// the email or phone. The policy is keyed by these three tool NAMES: add a fourth `agency_privacy.*` tool and
// the unit test that walks this array fails until it has a policy. Still HIGH, still two-person, still never
// auto-run by D14: after a DIFFERENT admin approves, the requester runs it by calling the route with just the
// `approvalId` (an unattended re-call is suspended by the hub again, so a person, or an attended session, runs it).
const PRIVACY_IDENTIFIER_PROPS = {
  tenantId: { type: "string" },
  email: { type: "string", description: "The person's email. Give email, phone, or both; matched after trim + lower-case." },
  phone: {
    type: "string",
    description:
      "The person's phone: 7-15 digits, an optional leading + or 00, spaces/dashes/dots/brackets allowed. A national " +
      "leading 0 is NOT rewritten to a country code, so try the number both ways if unsure.",
  },
  // M5-V3-h: the consented website visitor's own ids. Same minimiser rules: only their SHA-256 is ever stored or emitted.
  visitorId: {
    type: "string",
    description:
      "The website visitor id the site's privacy page shows the person (a uuid). Optional; reaches the consented " +
      "visitor profile and its events, never a lead's contact data. Only its hash is stored in the approval.",
  },
  consentId: {
    type: "string",
    description:
      "The person's website consent id (a uuid), as their consent record shows it. Optional; reaches the consented " +
      "visitor profile(s) recorded under it. Only its hash is stored in the approval.",
  },
  approvalId: {
    type: "string",
    description:
      "Omit on the first call (it files a WS4 approval and returns 202 with the approvalId). After a DIFFERENT " +
      "company admin approves it, call again with this approvalId to run it exactly once. The identifiers are " +
      "optional on that call: the person is rebuilt from the hashes the approval was filed with.",
  },
} as const;

const AGENCY_PRIVACY_CORE_TOOLS: McpToolDef[] = [
  {
    name: "agency_privacy.find",
    description:
      "Find every agency lead (and its AD-1 submissions and intake tokens) belonging to a person, by email and/or " +
      "phone, and their consented website-visitor profiles (by visitorId / consentId, and through each lead's consent " +
      "snapshot). Returns ids, statuses and counts, no contact data. impact:'high', WS4-gated per call: the first call " +
      "files an approval (202 suspended); the approved re-call returns the matches once (a re-use is 409 " +
      "`approval_already_used`). Converted leads are listed under `outOfScope`: their client record follows " +
      "client-record retention. Safe for an unattended agent to call: the approval stores only a hash of the " +
      "identifiers, never the email or phone.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/agency/privacy/find",
    write: true,
    impact: "high",
    inputSchema: { type: "object", properties: { ...PRIVACY_IDENTIFIER_PROPS }, required: ["tenantId"] },
  },
  {
    name: "agency_privacy.export",
    description:
      "Export a person's agency-intake data (lead contact fields, attribution, consent snapshot, AD-1 answers, " +
      "intake-token history) by email and/or phone, and their consented website-visitor profiles with every event " +
      "(by visitorId / consentId, and through each lead's consent snapshot). impact:'high', WS4-gated per call like agency_privacy.find; the " +
      "response IS personal data and is never stored, so a re-use of the approval is refused. Safe for an " +
      "unattended agent to call: the approval stores only a hash of the identifiers, never the email or phone.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/agency/privacy/export",
    write: true,
    impact: "high",
    inputSchema: { type: "object", properties: { ...PRIVACY_IDENTIFIER_PROPS }, required: ["tenantId"] },
  },
  {
    name: "agency_privacy.erase",
    description:
      "ERASE a person's agency-intake data by email and/or phone: scrubs the lead's contact fields, attribution and " +
      "decline reason and the AD-1 person answers, revokes unused intake tokens, and adds the contact (hashed) to the " +
      "suppression list so the web intake never re-creates the lead and nothing is uploaded to an ad platform. Rows " +
      "are kept (status, stage, client link). Also deletes the person's consented website-visitor profiles (by " +
      "visitorId / consentId, and through each lead's consent snapshot), tombstones both ids so nothing is re-created, " +
      "and tells the visitor-event collector to forget them (`counts.collectorForget`: `queued` when it was unreachable). A converted lead's client record is NOT touched (`outOfScope`). " +
      "impact:'high', irreversible, WS4-gated per call; the requester cannot approve their own request. Calling again " +
      "with a used approval returns the stored counts (`replayed: true`). Safe for an unattended agent to call: the " +
      "approval stores only a hash of the identifiers, never the email or phone; the requester runs it after " +
      "approval with just the approvalId.",
    minAssurance: "verified",
    method: "POST",
    pathTemplate: "/api/:tenantId/agency/privacy/erase",
    write: true,
    impact: "high",
    inputSchema: { type: "object", properties: { ...PRIVACY_IDENTIFIER_PROPS }, required: ["tenantId"] },
  },
];

/** M5-G5: the three `agency_privacy.*` tools; exported so a suite can restore exactly this area. */
export function registerAgencyPrivacyCoreTools(): void {
  registerCoreTools(AGENCY_PRIVACY_CORE_TOOLS);
}

/** M5-P1-c: the four `agency_pipeline.*` tools; exported so a suite can restore exactly this area. */
export function registerAgencyPipelineCoreTools(): void {
  registerCoreTools(AGENCY_PIPELINE_CORE_TOOLS);
}

registerAllCoreTools();
