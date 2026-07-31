// TR-04 — server-side, as-of-date department resolution (Blueprint §3.2 "Blocker 2").
//
// House pattern (same shape as work-activity-linker.ts / modules/search/ai-drafts.ts): every
// function here is PURE — no DB, no withTenants, no Date.now() defaults hidden inside the
// decision logic. All I/O (reading org_unit_memberships / company_org_structure / users /
// service_assignments) is the CALLER's job:
//   - the org-structure PUT hook lives in admin/company-admin.controller.ts (putOrg), which
//     calls deriveBlobPlacements() + diffMembershipSweep() from here and executes the resulting
//     ops as plain SQL inside its own withTenants([tenantId], ...) transaction.
//   - the nightly fact job (TR-07, NOT built by this ticket) will call resolveDepartment() once
//     per fact, after gathering the ①/②/③ inputs itself.
// Keeping the decision/diff logic here pure is what makes precedence ①-④ — including the as-of
// transfer case — unit-testable without a database (dept-resolution.test.ts), and what lets
// TR-07 reuse the exact same resolver without re-deriving its rules.

// ─────────────────────────── §3.2 precedence ①-④ ───────────────────────────

export type ResolutionPrecedence = 1 | 2 | 3 | 4;

/** One membership interval, as read from org_unit_memberships (is_primary=true rows only — the
 *  caller is responsible for filtering to primary and to ONE person/tenant before calling
 *  resolveMembershipAsOf; this module does not know about is_primary at all). Dates are
 *  'YYYY-MM-DD' strings (Postgres `date` columns come back this way with the driver's date
 *  parsing off, matching every other file in this program, e.g. org-unit-memberships.test.ts). */
export interface MembershipInterval {
  unitNodeId: string;
  validFrom: string; // 'YYYY-MM-DD'
  validTo: string | null; // null = open/current
}

/** The resolved person's primary-membership substrate for ONE tenant (their home placement in
 *  that tenant's org tree). `tenantId` may differ from the fact's own tenant — that is exactly
 *  the shared-service case §3.2 describes (a provider dept's person doing work for another
 *  company); the caller decides which tenant's memberships to hand in here. */
export interface PersonMembershipLookup {
  tenantId: string;
  intervals: MembershipInterval[];
}

export interface DeptResolutionInput {
  /** ① owner-unit assignee — a task's OWNER role assigned directly to a department/division
   *  (assignee_kind IN ('department','division') on pm_task_assignees, or the equivalent
   *  poly-assignee blob shape). Always a node id within `factTenantId`'s own org tree — there is
   *  no mechanism for a task to name a unit in a foreign tenant. */
  ownerUnitNodeId?: string | null;
  /** ② substrate — the owner-or-responsible PERSON's primary-membership lookup, or omitted/null
   *  if the fact has no resolvable owner/responsible person at all. */
  personMembership?: PersonMembershipLookup | null;
  /** The date the fact occurred on (the as-of axis), 'YYYY-MM-DD'. */
  asOfDate: string;
  /** ③ fallback — projects.department_id, a node id within `factTenantId`'s own org tree. */
  projectDepartmentId?: string | null;
  /** The tenant the fact is being written into (a project's own tenant — facts never re-home,
   *  per the HR/0026 precedent restated in §3.2). */
  factTenantId: string;
  /** Precomputed by the caller (I/O): is there an ACTIVE (not proposed/suspended/revoked)
   *  service_assignments row from personMembership's (tenant, unit) serving `factTenantId`?
   *  Ignored unless precedence ② actually fires AND personMembership.tenantId !== factTenantId
   *  — passing `true` for a same-tenant resolution or when ② doesn't fire has no effect. */
  activeServiceAssignment?: boolean;
}

export interface DeptResolution {
  /** The resolved department/division node id, or null when unattributed (④). */
  unitNodeId: string | null;
  /** The tenant that owns `unitNodeId`'s org tree — `factTenantId` for ①/③,
   *  `personMembership.tenantId` for ②, null for ④. */
  unitTenantId: string | null;
  precedence: ResolutionPrecedence;
  /** Shared-service stamp (§3.2): set ONLY when ② fired, the membership's home tenant differs
   *  from `factTenantId`, AND the caller confirmed an ACTIVE service_assignment. Never set for
   *  'proposed' | 'suspended' | 'revoked' — those aren't even represented here; the caller only
   *  passes `true` for a row it already filtered to status='active' (0026 header). */
  providerTenantId: string | null;
  providerUnitNodeId: string | null;
}

const UNATTRIBUTED: DeptResolution = {
  unitNodeId: null,
  unitTenantId: null,
  precedence: 4,
  providerTenantId: null,
  providerUnitNodeId: null,
};

/** Find the interval containing `asOfDate` (inclusive both ends — 'YYYY-MM-DD' string comparison
 *  is safe for this fixed-width format, same trick the EXCLUDE constraint's daterange relies on).
 *  Returns null if no interval covers that date (e.g. asOfDate predates the person's earliest
 *  membership row — pre-adoption history, per §3.2's backfill note). Assumes non-overlapping
 *  primary intervals, which the DB's EXCLUDE constraint guarantees for real data; if two
 *  (malformed/test) intervals both cover the date, the first match wins — callers should not
 *  rely on that tie-break for real data. */
export function resolveMembershipAsOf(intervals: MembershipInterval[], asOfDate: string): MembershipInterval | null {
  return intervals.find((iv) => iv.validFrom <= asOfDate && (iv.validTo === null || asOfDate <= iv.validTo)) ?? null;
}

/** The §3.2 precedence engine. Deterministic, side-effect-free, unit-testable without a
 *  database — see dept-resolution.test.ts for the full ①-④ matrix incl. the as-of transfer
 *  case (the ticket's whole point: a person moving units must never rewrite history). */
export function resolveDepartment(input: DeptResolutionInput): DeptResolution {
  // ① owner-unit assignee — always wins, always in the fact's own tenant.
  if (input.ownerUnitNodeId) {
    return {
      unitNodeId: input.ownerUnitNodeId,
      unitTenantId: input.factTenantId,
      precedence: 1,
      providerTenantId: null,
      providerUnitNodeId: null,
    };
  }

  // ② the owner/responsible person's primary membership AS OF the fact's date.
  if (input.personMembership) {
    const asOf = resolveMembershipAsOf(input.personMembership.intervals, input.asOfDate);
    if (asOf) {
      const crossCompany = input.personMembership.tenantId !== input.factTenantId;
      const stampProvider = crossCompany && input.activeServiceAssignment === true;
      return {
        unitNodeId: asOf.unitNodeId,
        unitTenantId: input.personMembership.tenantId,
        precedence: 2,
        providerTenantId: stampProvider ? input.personMembership.tenantId : null,
        providerUnitNodeId: stampProvider ? asOf.unitNodeId : null,
      };
    }
  }

  // ③ the project's own department_id.
  if (input.projectDepartmentId) {
    return {
      unitNodeId: input.projectDepartmentId,
      unitTenantId: input.factTenantId,
      precedence: 3,
      providerTenantId: null,
      providerUnitNodeId: null,
    };
  }

  // ④ unattributed.
  return UNATTRIBUTED;
}

// ─────────────────────────── date helpers (pure, 'YYYY-MM-DD' only) ───────────────────────────

/** Today as 'YYYY-MM-DD' (UTC — org-structure PUTs are dated by calendar day, not wall-clock
 *  timezone; matches how every other date column in this program is written/compared). */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** `dateIso` shifted by `days` (may be negative), 'YYYY-MM-DD' in, 'YYYY-MM-DD' out. */
export function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Same defensive shape-check the 0055 backfill uses for `assigneeId` (org-blob refs are
 *  app-validated only as non-empty strings, never as real uuids/users rows — legacy seed data
 *  like "u-dev"/"u-pm" is not uuid-shaped at all). */
export function isUuidShaped(value: string): boolean {
  return UUID_RE.test(value);
}

// ─────────────────────────── org-blob -> placements (pure tree walk) ───────────────────────────

export type OrgWalkKind = "holding" | "company" | "department" | "division" | "role" | "person" | string;

export interface OrgNodeForWalk {
  id: string;
  kind: OrgWalkKind;
  assigneeId?: string | null;
  children: OrgNodeForWalk[];
}

export interface BlobPlacement {
  userId: string;
  unitNodeId: string;
}

const UNIT_KINDS = new Set(["department", "division"]);

/** Walk a sanitized org-structure root, tracking the NEAREST department/division ancestor for
 *  every 'person' node with a non-empty assigneeId — byte-identical semantics to 0055's backfill
 *  DO block (see migrations/0055_org_unit_memberships.sql's tree-walk CTE): a person's inherited
 *  unit is the id of the nearest dept/division ANCESTOR, not necessarily their direct parent (a
 *  person nested department -> division -> role resolves to the DIVISION). A person with no
 *  department/division ancestor at all is unrepresentable and silently omitted (never a NULL-unit
 *  row — org_unit_memberships.unit_node_id is NOT NULL). Duplicate assigneeId occurrences (a
 *  malformed blob) resolve deterministically to the lexicographically smallest unit_node_id, the
 *  same tie-break the backfill's `DISTINCT ON ... ORDER BY assignee_id, unit_node_id` uses.
 *
 *  PURE and does not validate assigneeId as a real uuid/users row — that FK-shaped check is I/O
 *  (a `SELECT id FROM users WHERE id = ANY(...)`) and is the caller's job, mirroring the
 *  backfill's own uuid-shaped-AND-present-in-users guard (§15 "DEFENSIVE PERSON-REF RESOLUTION"). */
export function deriveBlobPlacements(root: OrgNodeForWalk): BlobPlacement[] {
  const bestByUser = new Map<string, string>();
  const walk = (node: OrgNodeForWalk, inheritedUnit: string | null) => {
    const unitForChildren = UNIT_KINDS.has(node.kind) ? node.id : inheritedUnit;
    for (const child of node.children ?? []) {
      if (child.kind === "person" && child.assigneeId) {
        if (unitForChildren) {
          const existing = bestByUser.get(child.assigneeId);
          if (existing === undefined || unitForChildren < existing) bestByUser.set(child.assigneeId, unitForChildren);
        }
        // else: no department/division ancestor at all -> unrepresentable, skipped.
      }
      walk(child, unitForChildren);
    }
  };
  walk(root, null);
  return [...bestByUser.entries()].map(([userId, unitNodeId]) => ({ userId, unitNodeId }));
}

// ─────────────────────────── membership sweep diff (pure) ───────────────────────────

/** An org_unit_memberships row's open-primary shape, as read by the caller
 *  (`SELECT user_id, unit_node_id, valid_from::text FROM org_unit_memberships
 *    WHERE tenant_id = $1 AND is_primary AND valid_to IS NULL`). */
export interface OpenPrimaryMembership {
  userId: string;
  unitNodeId: string;
  validFrom: string; // 'YYYY-MM-DD'
}

export type MembershipSweepOp =
  /** No existing open row for this user at all -> just open one. */
  | { kind: "add"; userId: string; unitNodeId: string; validFrom: string }
  /** The existing open row was ALSO opened today (an earlier sweep today, or a manual same-day
   *  row) -> amend its unit in place instead of close+open, which would otherwise try to set
   *  valid_to one day BEFORE valid_from on the same row and violate the valid_range CHECK. */
  | { kind: "amend"; userId: string; unitNodeId: string }
  /** A genuine transfer: close the old row the day before today (the only way to satisfy the
   *  EXCLUDE constraint's inclusive-both-ends daterange without a same-day overlap — see the
   *  "ADJACENT non-overlapping primary ranges are ALLOWED" test in org-unit-memberships.test.ts),
   *  then open a new one starting today. */
  | { kind: "transfer"; userId: string; closeValidTo: string; openUnitNodeId: string; openValidFrom: string }
  /** The person no longer appears anywhere resolvable in the new blob (removed, or moved to a
   *  node with no department/division ancestor) -> close the open row, open nothing. */
  | { kind: "remove"; userId: string; closeValidTo: string };

/** Diff the org blob's current placements against the currently-open primary membership rows and
 *  produce the write plan for the org-structure PUT hook. Pure — no DB access; the controller
 *  executes each op as plain SQL inside its own transaction (see company-admin.controller.ts).
 *  `today` is passed in (not defaulted) so the transfer/as-of test case is exactly reproducible:
 *  a person moved on 'today' means their OLD row's valid_to becomes 'today - 1' and their NEW
 *  row's valid_from becomes 'today' — so a fact dated the day before resolves to the OLD unit and
 *  a fact dated 'today' (or later) resolves to the NEW one. */
export function diffMembershipSweep(
  blobPlacements: BlobPlacement[],
  openMemberships: OpenPrimaryMembership[],
  today: string,
): MembershipSweepOp[] {
  const ops: MembershipSweepOp[] = [];
  const openByUser = new Map(openMemberships.map((m) => [m.userId, m]));
  const blobByUser = new Map(blobPlacements.map((p) => [p.userId, p]));

  for (const placement of blobPlacements) {
    const open = openByUser.get(placement.userId);
    if (!open) {
      ops.push({ kind: "add", userId: placement.userId, unitNodeId: placement.unitNodeId, validFrom: today });
      continue;
    }
    if (open.unitNodeId === placement.unitNodeId) continue; // no-op: same unit, nothing to write

    if (open.validFrom === today) {
      ops.push({ kind: "amend", userId: placement.userId, unitNodeId: placement.unitNodeId });
    } else {
      ops.push({
        kind: "transfer",
        userId: placement.userId,
        closeValidTo: addDaysIso(today, -1),
        openUnitNodeId: placement.unitNodeId,
        openValidFrom: today,
      });
    }
  }

  for (const open of openMemberships) {
    if (!blobByUser.has(open.userId)) {
      ops.push({ kind: "remove", userId: open.userId, closeValidTo: today });
    }
  }

  return ops;
}
