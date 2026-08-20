// P2-15 — backfill + adoption: the one-time data operation that makes the Phase 2 engine describe
// the estate that already exists, instead of an empty one.
//
// Design: docs/superpowers/plans/2026-08-13-iam-phase2-design.md §9 (Wave D). Four independent
// pieces, deliberately separable because they carry very different risk:
//
//   1. EMPLOYEES  — one `employees` row per staff membership. Additive; nothing else reads it yet.
//   2. POSITIONS  — candidates derived from org-blob `role` nodes. **REPORT ONLY, never applied.**
//   3. ASSIGNMENTS— `org_unit_memberships` → `position_assignments`, only where UNAMBIGUOUS.
//   4. ADOPTION   — re-tag hand-made grants that exactly match a seat's role-set so future moves
//                   manage them. The dangerous one, and the one with the hard count assertion.
//
// ── THE INVARIANT THAT OUTRANKS EVERYTHING ELSE HERE ─────────────────────────────────────────────
// Adoption NEVER creates a grant and NEVER widens one. It only re-labels rows that already exist.
// `user_roles`' row count is asserted identical before and after, INSIDE the writing transaction, so
// a violation rolls back rather than being discovered later by a drift sweep. Design §9 states the
// assertion; it is implemented as an abort, not a log line, because the failure mode it guards is
// "someone silently gained access during a maintenance script".
//
// ── WHY THIS REUSES `computePlan` INSTEAD OF ITS OWN MATCHER ─────────────────────────────────────
// "A grant that exactly matches what this seat would confer" is already implemented, once, in
// `position-reconciler.ts`: `collectDesired` resolves a seat's role-set to (role, scopeType, scopeId)
// and `classifyExisting` labels a row with neither marker `skip_manual`. Those `skip_manual` entries
// ARE the adoption candidates. Writing a second matcher here would mean the backfill could adopt a
// row the reconciler would never have managed — the exact drift ORG-7b's rule warns about ("a preview
// that re-implements the collector is a preview of a different program"). So there is no second
// matcher: adoption iterates the reconciler's own plan.
//
// ── DRY RUN IS THE DEFAULT, AND THE PLAN IS RE-DERIVED UNDER THE WRITE ───────────────────────────
// `planTenantBackfill` writes nothing. `applyTenantBackfill` re-derives the whole plan inside its own
// transaction rather than accepting one computed earlier — same A1 re-verification doctrine as the
// reconciler and the D14 executor. A plan reviewed by a human an hour ago is evidence about the past.
import type { PoolClient } from "pg";
import { withTenants, withGlobal, newId } from "../db";
import { computePlan } from "./position-reconciler";

/** `employees` sits behind the HR module's third RLS wall (0109). Without this the reads return ZERO
 *  ROWS and no error, and a backfill that "found nothing to do" is indistinguishable from a clean
 *  estate — see `approval-executables.ts`'s `preconditionModules` note for the same trap. */
const HR = { modules: ["hr"] };

/**
 * Identity-link providers that mark a principal as NOT A PERSON — the SECOND wall, not the first.
 *
 * The first wall is `company_memberships.kind = 'employee'` (migration 0026 added
 * `kind IN ('employee','service')`), and it is the right primary filter: automation accounts hold real
 * memberships on purpose — `seed/automation.ts` calls `addMembership(tenantId, userId, "service")` for
 * every workflow account, because the estate models bots as `users` rows so authorization, audit and
 * OBO work uniformly (the program's [principal-kinds] ruling). So bots are already structurally
 * separated, and 0072's header explains why that column's meaning is load-bearing.
 *
 * This list exists because NOTHING ENFORCES the kind. A bot inserted (by a future seeder, a fixture, a
 * hand-written row) with the default `kind='employee'` would otherwise get a person-shaped HR record.
 * Two cheap walls for an irreversible-looking mistake, and the excluded rows are NAMED in the report so
 * a reader can check the second wall never fired on a human.
 *
 * `whatsapp` is deliberately NOT here: those links belong to real humans reaching the estate over WA.
 */
const NON_HUMAN_PROVIDERS = ["n8n"];

/** Service-account email convention, used only as a SECOND signal: a `@gaiada.system` address with no
 *  n8n link is reported for review rather than silently treated either way. Being wrong in the
 *  including direction puts a bot in HR; being wrong the other way hides a real person. Neither is
 *  something a script should decide quietly. */
const SERVICE_EMAIL_SUFFIX = "@gaiada.system";

export interface EmployeeCandidate {
  userId: string;
  membershipId: string;
  email: string;
  name: string;
  title: string | null;
}

export interface PositionCandidate {
  /** The org-blob node this seat would come from. Not an id in any table — blob node ids are free
   *  text by the 0029 convention. */
  nodeId: string;
  title: string;
  /** The node's PARENT unit — a `role` node hangs under the unit whose seat it is. */
  unitNodeId: string;
  /** Whoever the blob already names in the seat, if anyone. */
  assigneeId: string | null;
  assigneeName: string | null;
  /** True when a position with this title already exists in that unit — importing would duplicate. */
  alreadyExists: boolean;
}

export interface AssignmentCandidate {
  userId: string;
  unitNodeId: string;
  positionId: string;
  positionTitle: string;
}

export interface AssignmentAmbiguity {
  userId: string;
  unitNodeId: string;
  /** 0 = the unit has no active position to seat them into; >1 = which seat is not derivable. */
  activePositions: number;
}

export interface AdoptionCandidate {
  userRoleId: string;
  userId: string;
  roleId: string;
  scopeType: string;
  scopeId: string;
  /** Every open assignment that justifies this grant — each becomes one claim (A2 refcounting). */
  assignmentIds: string[];
}

export interface BackfillReport {
  tenantId: string;
  employees: {
    create: EmployeeCandidate[];
    /** Already has an `employees` row — nothing to do. */
    alreadyRecorded: number;
    /** Rows whose `kind` said `employee` but which carry a non-human identity link — the second wall
     *  firing (see NON_HUMAN_PROVIDERS). Named, not just counted: a reader must be able to check the
     *  wall never fired on a human, and a non-empty list also means some seeder mis-kinded a bot. */
    excludedAutomation: Array<{ userId: string; email: string; provider: string }>;
    /** `@gaiada.system` address with no automation link — REVIEW, neither included nor excluded. */
    reviewServiceShaped: Array<{ userId: string; email: string }>;
    /** A membership whose user is also a client contact. Should be EMPTY by construction (clients are
     *  kept out of `company_memberships` on purpose — see seed/personas.ts). A non-empty list is a
     *  pre-existing data defect and is reported loudly rather than backfilled into HR. */
    reviewClientLinked: Array<{ userId: string; email: string }>;
  };
  positions: {
    /** REPORT ONLY. `applyTenantBackfill` never creates a position — see this file's header. */
    candidates: PositionCandidate[];
  };
  assignments: {
    create: AssignmentCandidate[];
    ambiguous: AssignmentAmbiguity[];
    /** Already seated in that position. */
    alreadySeated: number;
  };
  adoption: {
    adopt: AdoptionCandidate[];
    /** Users whose reconcile is FROZEN by an orphaned seat (A16). Adoption skips them entirely —
     *  the reconciler refuses to reason about such a user and this must not reason further than it. */
    frozenUsers: string[];
  };
  /** Snapshot for the count assertion. Read in the same transaction that reads everything else. */
  userRolesTotal: number;
}

export interface ApplyOpts {
  /** Each piece is opt-IN. A run with no flags set is a no-op that still returns the report, which is
   *  the intended way to review one piece at a time on a live estate. */
  employees?: boolean;
  assignments?: boolean;
  adoption?: boolean;
}

export interface ApplyResult {
  tenantId: string;
  employeesCreated: number;
  assignmentsCreated: number;
  grantsAdopted: number;
  claimsCreated: number;
  /** Proof, not decoration: the before/after `user_roles` count the transaction asserted on. */
  userRolesBefore: number;
  userRolesAfter: number;
  report: BackfillReport;
}

export class AdoptionWidenedAccessError extends Error {
  constructor(before: number, after: number) {
    super(
      `ADOPTION ABORTED: user_roles row count moved ${before} -> ${after}. Adoption may only RE-LABEL ` +
        `existing grants; creating or widening one is the failure this assertion exists to prevent. ` +
        `The transaction has been rolled back.`,
    );
    this.name = "AdoptionWidenedAccessError";
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE PLAN (pure read)
// ═════════════════════════════════════════════════════════════════════════════════════════════════

async function planEmployees(c: PoolClient, tenantId: string): Promise<BackfillReport["employees"]> {
  // Staff = an ACTIVE membership of `kind='employee'` (design §9's stated source; the column comes
  // from migration 0026). Two things make this table the right source and neither is a guess:
  //   * client contacts are STRUCTURALLY absent from it — 0072's header records the decision to keep
  //     `company_memberships` meaning "staff and service accounts of this company", specifically so a
  //     client can never surface in /people or the HR directory;
  //   * `kind` separates the service accounts, which do hold memberships (see NON_HUMAN_PROVIDERS).
  const { rows } = await c.query<{
    user_id: string;
    membership_id: string;
    email: string;
    name: string;
    title: string | null;
    has_employee: boolean;
  }>(
    `SELECT cm.user_id, cm.id AS membership_id, u.email, u.name, u.title,
            EXISTS (SELECT 1 FROM employees e
                     WHERE e.tenant_id = cm.tenant_id AND e.user_id = cm.user_id AND e.deleted_at IS NULL)
              AS has_employee
       FROM company_memberships cm
       JOIN users u ON u.id = cm.user_id
      WHERE cm.tenant_id = $1
        AND cm.kind = 'employee'
        AND cm.status = 'active'
        AND cm.deleted_at IS NULL
        AND u.deleted_at IS NULL
      ORDER BY u.email`,
    [tenantId],
  );

  // Bot detection and client-link detection both read GLOBAL tables (`identity_links` has no tenant
  // column; `client_contacts` is tenant-scoped and read below on the same client).
  const userIds = rows.map((r) => r.user_id);
  const automation = new Map<string, string>();
  if (userIds.length) {
    const links = await withGlobal((g) =>
      g.query<{ user_id: string; provider: string }>(
        `SELECT user_id, provider FROM identity_links WHERE user_id = ANY($1::uuid[]) AND provider = ANY($2::text[])`,
        [userIds, NON_HUMAN_PROVIDERS],
      ),
    );
    for (const l of links.rows) automation.set(l.user_id, l.provider);
  }

  const clientLinked = new Set<string>();
  if (userIds.length) {
    const contacts = await c.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM client_contacts
        WHERE tenant_id = $1 AND user_id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [tenantId, userIds],
    );
    for (const r of contacts.rows) clientLinked.add(r.user_id);
    // A portal user attached to a client row is the older shape of the same thing (0018).
    const portal = await c.query<{ portal_user_id: string }>(
      `SELECT portal_user_id FROM clients
        WHERE tenant_id = $1 AND portal_user_id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [tenantId, userIds],
    );
    for (const r of portal.rows) clientLinked.add(r.portal_user_id);
  }

  const out: BackfillReport["employees"] = {
    create: [],
    alreadyRecorded: 0,
    excludedAutomation: [],
    reviewServiceShaped: [],
    reviewClientLinked: [],
  };

  for (const r of rows) {
    const provider = automation.get(r.user_id);
    if (provider) {
      out.excludedAutomation.push({ userId: r.user_id, email: r.email, provider });
      continue;
    }
    if (clientLinked.has(r.user_id)) {
      // NOT created. See `reviewClientLinked`'s doc: this list should be empty, and if it is not, the
      // right move is a human looking at a data defect, never an HR record for a client.
      out.reviewClientLinked.push({ userId: r.user_id, email: r.email });
      continue;
    }
    if (r.email.toLowerCase().endsWith(SERVICE_EMAIL_SUFFIX)) {
      out.reviewServiceShaped.push({ userId: r.user_id, email: r.email });
      continue;
    }
    if (r.has_employee) {
      out.alreadyRecorded += 1;
      continue;
    }
    out.create.push({
      userId: r.user_id,
      membershipId: r.membership_id,
      email: r.email,
      name: r.name,
      title: r.title,
    });
  }
  return out;
}

interface BlobNode {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  assigneeId?: unknown;
  assigneeName?: unknown;
  children?: unknown;
}

/** Walk the org blob, yielding every `role` node with the unit it hangs under. A `role` node is the
 *  informal ancestor of a position (design §2 preamble / §63's note), which is why this is an IMPORT
 *  CANDIDATE and not an import: the blob's role nodes were never validated as seats, may duplicate
 *  each other, and carry no role-set at all. The owner reviews the list; nothing here applies it. */
function collectRoleNodes(root: BlobNode | null | undefined, parentUnit: string | null, acc: PositionCandidate[]): void {
  if (!root || typeof root !== "object") return;
  const id = typeof root.id === "string" ? root.id : null;
  const kind = typeof root.kind === "string" ? root.kind : null;
  const name = typeof root.name === "string" ? root.name : null;
  if (kind === "role" && id && name && parentUnit) {
    acc.push({
      nodeId: id,
      title: name,
      unitNodeId: parentUnit,
      assigneeId: typeof root.assigneeId === "string" ? root.assigneeId : null,
      assigneeName: typeof root.assigneeName === "string" ? root.assigneeName : null,
      alreadyExists: false, // filled in by the caller, which can query
    });
  }
  const children = Array.isArray(root.children) ? root.children : [];
  // A `role` node is a leaf-ish decoration on a unit: its children (if any) still belong to the
  // nearest UNIT ancestor, not to the role, so the unit only advances for non-role nodes.
  const nextUnit = kind === "role" ? parentUnit : id ?? parentUnit;
  for (const child of children) collectRoleNodes(child as BlobNode, nextUnit, acc);
}

async function planPositions(c: PoolClient, tenantId: string): Promise<BackfillReport["positions"]> {
  const { rows } = await c.query<{ structure: unknown }>(
    `SELECT settings -> 'orgStructure' AS structure FROM companies WHERE id = $1`,
    [tenantId],
  );
  const structure = rows[0]?.structure as { root?: BlobNode } | null;
  const candidates: PositionCandidate[] = [];
  collectRoleNodes(structure?.root, null, candidates);

  for (const cand of candidates) {
    const { rows: existing } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM positions
        WHERE tenant_id = $1 AND unit_node_id = $2 AND lower(title) = lower($3) AND status <> 'retired'`,
      [tenantId, cand.unitNodeId, cand.title],
    );
    cand.alreadyExists = Number(existing[0]?.n ?? "0") > 0;
  }
  return { candidates };
}

async function planAssignments(c: PoolClient, tenantId: string): Promise<BackfillReport["assignments"]> {
  // Open, current unit memberships — the estate's existing statement of "who is in which unit".
  const { rows } = await c.query<{ user_id: string; unit_node_id: string }>(
    `SELECT DISTINCT user_id, unit_node_id FROM org_unit_memberships
      WHERE tenant_id = $1 AND valid_to IS NULL
      ORDER BY user_id, unit_node_id`,
    [tenantId],
  );

  const out: BackfillReport["assignments"] = { create: [], ambiguous: [], alreadySeated: 0 };
  for (const m of rows) {
    const { rows: positions } = await c.query<{ id: string; title: string }>(
      `SELECT id, title FROM positions
        WHERE tenant_id = $1 AND unit_node_id = $2 AND status = 'active'
        ORDER BY id`,
      [tenantId, m.unit_node_id],
    );
    // UNAMBIGUOUS means exactly one candidate seat. Zero and many are both reported, never guessed:
    // picking "the first" would seat people into role-sets nobody chose for them, and a wrong seat
    // grants a wrong role — the top hazard in this program's risk table.
    if (positions.length !== 1) {
      out.ambiguous.push({ userId: m.user_id, unitNodeId: m.unit_node_id, activePositions: positions.length });
      continue;
    }
    const seat = positions[0];
    const { rows: held } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM position_assignments
        WHERE tenant_id = $1 AND user_id = $2 AND position_id = $3 AND valid_to IS NULL`,
      [tenantId, m.user_id, seat.id],
    );
    if (Number(held[0]?.n ?? "0") > 0) {
      out.alreadySeated += 1;
      continue;
    }
    out.create.push({ userId: m.user_id, unitNodeId: m.unit_node_id, positionId: seat.id, positionTitle: seat.title });
  }
  return out;
}

async function planAdoption(c: PoolClient, tenantId: string): Promise<BackfillReport["adoption"]> {
  // Everyone currently holding an open seat. Adoption is only ever about people the engine already
  // has an opinion about — a user with no assignment has no seat to attribute a grant to.
  const { rows: seated } = await c.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM position_assignments
      WHERE tenant_id = $1 AND valid_to IS NULL ORDER BY user_id`,
    [tenantId],
  );

  const out: BackfillReport["adoption"] = { adopt: [], frozenUsers: [] };
  for (const s of seated) {
    // THE reuse point — see this file's header. `skip_manual` is the reconciler's own verdict that a
    // row is an exact (role, scope) match made by hand.
    const plan = await computePlan(c, tenantId, s.user_id);
    if (plan.orphaned) {
      out.frozenUsers.push(s.user_id);
      continue;
    }
    for (const g of plan.grants) {
      if (g.action !== "skip_manual" || !g.existingGrantId) continue;
      out.adopt.push({
        userRoleId: g.existingGrantId,
        userId: s.user_id,
        roleId: g.roleId,
        scopeType: g.scopeType,
        scopeId: g.scopeId,
        assignmentIds: [...g.assignmentIds],
      });
    }
  }
  return out;
}

async function countUserRoles(c: PoolClient): Promise<number> {
  // GLOBAL count, not tenant-scoped: `user_roles` has no tenant column (scope_id carries the company
  // for company-scoped rows), and the assertion has to catch a row appearing ANYWHERE, including one
  // written with the wrong scope. A tenant-filtered count would miss exactly the mistake that matters.
  const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM user_roles`);
  return Number(rows[0].n);
}

/** The dry-run report. Writes nothing, and every piece is computed on ONE client inside ONE
 *  transaction so the four sections describe the same instant. */
export async function planTenantBackfill(tenantId: string): Promise<BackfillReport> {
  return withTenants(
    [tenantId],
    async (c) => ({
      tenantId,
      employees: await planEmployees(c, tenantId),
      positions: await planPositions(c, tenantId),
      assignments: await planAssignments(c, tenantId),
      adoption: await planAdoption(c, tenantId),
      userRolesTotal: await countUserRoles(c),
    }),
    HR,
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE APPLY
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Apply the opted-in pieces. Everything happens in ONE transaction, and the plan is RE-DERIVED
 * inside it — a report a human read an hour ago is evidence about the past, and this is the same
 * A1 re-verification rule `position-reconciler.ts` and `approval-execute.ts` both follow.
 *
 * Positions are never created here even when the report lists candidates. That is not an omission:
 * a blob `role` node carries no role-set, so importing one would create a seat that confers nothing
 * and then look, to every later reader, like a seat someone deliberately left empty.
 */
export async function applyTenantBackfill(tenantId: string, opts: ApplyOpts = {}): Promise<ApplyResult> {
  return withTenants(
    [tenantId],
    async (c) => {
      const report: BackfillReport = {
        tenantId,
        employees: await planEmployees(c, tenantId),
        positions: await planPositions(c, tenantId),
        assignments: await planAssignments(c, tenantId),
        adoption: await planAdoption(c, tenantId),
        userRolesTotal: await countUserRoles(c),
      };
      const userRolesBefore = report.userRolesTotal;

      let employeesCreated = 0;
      if (opts.employees) {
        for (const e of report.employees.create) {
          // `hire_date` is left NULL rather than invented: the estate does not record when these
          // people started, and `created_at` would read as a hire date to every later report.
          // `origin_site` defaults to 'central' (0109); `employment_status` defaults 'active', which
          // is right — every row here comes from an ACTIVE membership.
          await c.query(
            `INSERT INTO employees (id, tenant_id, user_id, display_name, work_email, notes)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (tenant_id, user_id) WHERE user_id IS NOT NULL DO NOTHING`,
            [newId(), tenantId, e.userId, e.name, e.email, "Created by the P2-15 membership backfill."],
          );
          employeesCreated += 1;
        }
      }

      let assignmentsCreated = 0;
      if (opts.assignments) {
        for (const a of report.assignments.create) {
          // `valid_from = current_date`, NOT the membership's own valid_from: back-dating a seat would
          // assert this person held that position (and its roles) during a period nobody verified.
          // The seat starts today; the membership row keeps the historical truth.
          // `reason`, not a `source` column — `position_assignments` has no such column (0109 gives it
          // valid_from/valid_to/assigned_by/reason/origin_site). `assigned_by` is left NULL because no
          // human assigned this seat; attributing it to whoever ran the script would put a name on a
          // decision they did not make. The reason string is how a later reader learns where it came from.
          await c.query(
            `INSERT INTO position_assignments (id, tenant_id, position_id, user_id, valid_from, reason)
             VALUES ($1, $2, $3, $4, current_date, $5)`,
            [newId(), tenantId, a.positionId, a.userId, "P2-15 backfill: sole active position in the user's org unit"],
          );
          assignmentsCreated += 1;
        }
      }

      let grantsAdopted = 0;
      let claimsCreated = 0;
      if (opts.adoption) {
        for (const ad of report.adoption.adopt) {
          // Re-label, guarded on the row STILL being unmanaged and STILL being the row the plan saw.
          // `managed_by IS NULL` is re-checked in the WHERE rather than trusted from the plan: the
          // 0109 exclusivity CHECK would reject a double-marked row anyway, but a silent zero-row
          // UPDATE is a better outcome than an aborted transaction for a race that means "the service
          // reconciler took this row while we were planning".
          const upd = await c.query(
            `UPDATE user_roles
                SET managed_by_position = $2
              WHERE id = $1 AND managed_by IS NULL AND managed_by_position IS NULL`,
            [ad.userRoleId, ad.assignmentIds[0]],
          );
          if (upd.rowCount !== 1) continue;
          grantsAdopted += 1;
          for (const assignmentId of ad.assignmentIds) {
            // One claim per justifying seat — A2 refcounting. Without the full set, a person holding
            // two seats that both confer this role would lose the grant when the FIRST seat closes.
            await c.query(
              `INSERT INTO position_grant_claims (id, tenant_id, position_assignment_id, user_role_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (position_assignment_id, user_role_id) WHERE user_role_id IS NOT NULL DO NOTHING`,
              [newId(), tenantId, assignmentId, ad.userRoleId],
            );
            claimsCreated += 1;
          }
        }
      }

      const userRolesAfter = await countUserRoles(c);
      // THE assertion, as an abort. Adoption re-labels; if the count moved, something in this
      // transaction created or removed access and the whole run is void.
      if (userRolesAfter !== userRolesBefore) throw new AdoptionWidenedAccessError(userRolesBefore, userRolesAfter);

      return {
        tenantId,
        employeesCreated,
        assignmentsCreated,
        grantsAdopted,
        claimsCreated,
        userRolesBefore,
        userRolesAfter,
        report,
      };
    },
    HR,
  );
}

/** Human-readable dry-run report. Deliberately plain text: this is read in a terminal by whoever is
 *  about to change a live estate, and a JSON blob is not a review. */
export function formatReport(r: BackfillReport): string {
  const L: string[] = [];
  L.push(`P2-15 backfill plan — tenant ${r.tenantId}`);
  L.push("");
  L.push(`EMPLOYEES  create ${r.employees.create.length} · already recorded ${r.employees.alreadyRecorded}`);
  for (const e of r.employees.create) L.push(`  + ${e.email}  (${e.name}${e.title ? `, ${e.title}` : ""})`);
  if (r.employees.excludedAutomation.length) {
    L.push(`  EXCLUDED as non-human (${r.employees.excludedAutomation.length}):`);
    for (const a of r.employees.excludedAutomation) L.push(`    - ${a.email}  [${a.provider}]`);
  }
  if (r.employees.reviewServiceShaped.length) {
    L.push(`  ⚠ REVIEW — service-shaped address with no automation link (neither created nor excluded):`);
    for (const a of r.employees.reviewServiceShaped) L.push(`    ? ${a.email}`);
  }
  if (r.employees.reviewClientLinked.length) {
    L.push(`  🔴 REVIEW — staff membership for a CLIENT principal. This should be impossible; it is a`);
    L.push(`     pre-existing data defect, and no HR record was created:`);
    for (const a of r.employees.reviewClientLinked) L.push(`    ! ${a.email}`);
  }
  L.push("");
  L.push(`POSITIONS  ${r.positions.candidates.length} candidate(s) from org-blob role nodes — REPORT ONLY, never applied`);
  for (const p of r.positions.candidates) {
    L.push(`  ~ "${p.title}" under ${p.unitNodeId}${p.assigneeName ? ` (blob names ${p.assigneeName})` : ""}` +
      `${p.alreadyExists ? "  [a position with this title already exists here]" : ""}`);
  }
  L.push("");
  L.push(`ASSIGNMENTS create ${r.assignments.create.length} · already seated ${r.assignments.alreadySeated} · ambiguous ${r.assignments.ambiguous.length}`);
  for (const a of r.assignments.create) L.push(`  + ${a.userId} -> "${a.positionTitle}" (${a.unitNodeId})`);
  for (const a of r.assignments.ambiguous) {
    L.push(`  ? ${a.userId} in ${a.unitNodeId}: ${a.activePositions} active position(s) — not derivable, skipped`);
  }
  L.push("");
  L.push(`ADOPTION   re-label ${r.adoption.adopt.length} hand-made grant(s); creates or widens NOTHING`);
  for (const a of r.adoption.adopt) {
    L.push(`  ~ user_role ${a.userRoleId}  role ${a.roleId} @ ${a.scopeType}:${a.scopeId}` +
      `  (${a.assignmentIds.length} justifying seat(s))`);
  }
  if (r.adoption.frozenUsers.length) {
    L.push(`  frozen by an orphaned seat (A16), skipped entirely: ${r.adoption.frozenUsers.length} user(s)`);
  }
  L.push("");
  L.push(`user_roles rows now: ${r.userRolesTotal} — apply asserts this is UNCHANGED afterwards.`);
  return L.join("\n");
}
