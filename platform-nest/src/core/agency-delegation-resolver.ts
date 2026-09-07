// AD-6b — closes the delegation gap AD-6 correctly refused to paper over. AD-6's own comment in
// `agency-lead-convert.service.ts` said it plainly: design §4.3 names a default assignee for every
// one of the five delegation roles ("AM", "PM", "tech lead"), but nothing in `agency_leads` / `users`
// / `company_memberships` resolves "the PM" or "the tech lead" for a tenant — only
// `agency_leads.owner_id` (the AM) is a resolvable identity from THAT schema. Not inventing a
// hierarchy there was the right call. This file is the real resolver AD-6 said would need to exist.
//
// ── THE MACHINERY THIS USES, READ FIRST (do not re-derive a third resolver from scratch) ──────────
// IAM Phase 2 (migration 0109_iam_phase2_positions.sql) already models the org chart as SEATS:
//   - `positions` (tenant, unit_node_id, title, is_lead, status) — a seat. CORE, plain-tenant-wall
//     table (0109's own header: "the reconciler/dept-head surface/admin flows read platform-wide"),
//     so it carries NO module wall and is reachable on the SAME `withTenants([tenantId], ...)`
//     connection `agency-lead-convert.service.ts` already runs its whole spawn on.
//   - `position_assignments` (position_id, user_id, valid_from, valid_to) — who currently holds a
//     seat. `valid_to IS NULL` = current holder (mirrors org_unit_memberships' proven shape, 0055).
// `src/seed/roster.ts` proves this is not theoretical for the seeded tenant: Azlan's seat is titled
// "Tech Lead · Head of Web Dev" (`d-webdev`, is_lead=true, FILLED) and a "Project Manager" seat also
// exists at `d-webdev` (from `VACANCIES`) but is UNFILLED — the schema's own honest way of recording
// "the seat exists, nobody holds it yet" (0109 §3.3 / positions.controller.ts's `orphaned` comment).
//
// ── THE REAL LIMIT OF THIS SCHEMA, STATED PLAINLY (do not oversell the match) ───────────────────────
// `positions.title` is free text with no canonical role-KIND column (0109: "same posture as
// org_unit_memberships.unit_node_id ... free text, NO FK"). So "the PM" / "the tech lead" can only be
// resolved by matching `title` against a pattern, never by joining a foreign key to a first-class
// "role kind" concept — because no such concept exists in this schema. A tenant that titles the seat
// "Producer" or "Delivery Lead" instead of "PM"/"Tech Lead" will not match, and MUST NOT silently
// resolve to a wrong guess — it degrades to the owner fallback in `computeDelegationPlan`
// (agency-lead-convert.service.ts), which is exactly what that function's fallback chain is for. This
// is reported plainly in the AD-6b report rather than dressed up as a first-class lookup.
//
// House pattern, same shape as `dept-resolution.ts` / `approval-deciders.ts`: the DB read is a thin,
// separate function from the pure decision, so the decision logic (`pickPositionHolder`) is
// unit-testable with zero database — see `agency-lead-convert.test.ts`.
import type { PoolClient } from "pg";

/** The only three delegation roles design §4.3 calls "PM" or "tech lead" — the two AM-default roles
 *  (`discovery_review`/`content_owners`) resolve straight to the lead's owner and never consult a
 *  position at all (see `CANONICAL_DELEGATIONS` in agency-lead-convert.service.ts). */
export type PositionResolvableRole = "sitemap" | "integrations" | "dns";

const ROLE_TITLE_PATTERN: Record<PositionResolvableRole, RegExp> = {
  sitemap: /\bpm\b|project\s*manager/i,
  integrations: /tech(nical)?\s*lead/i,
  dns: /tech(nical)?\s*lead/i,
};

export function isPositionResolvableRole(role: string): role is PositionResolvableRole {
  return Object.prototype.hasOwnProperty.call(ROLE_TITLE_PATTERN, role);
}

export interface PositionCandidateRow {
  positionId: string;
  positionTitle: string;
  isLead: boolean;
  /** The current (valid_to IS NULL) holder's user id, or null when the seat is vacant. When more
   *  than one row is somehow open for the same seat (a data bug elsewhere; `position_assignments`'
   *  own EXCLUDE constraint prevents it for one person but not for a headcount>1 seat with several
   *  holders), the earliest-seated holder wins, tie-broken by user id — deterministic, never "the
   *  DB's arbitrary row order". */
  holderUserId: string | null;
}

/** I/O — every ACTIVE position in the tenant, each with its current holder if any. Read ONCE per
 *  convert (not once per role) on the caller's own tenant-scoped connection `c` — this MUST be
 *  called from inside `agency-lead-convert.service.ts`'s single `withTenants([tenantId], ...)`
 *  transaction (design §6.2's "stay inside the existing single transaction" rule): `positions` /
 *  `position_assignments` carry no module wall (0109's header), so this is an ordinary read on `c`,
 *  exactly like the `agency_leads` re-read that already happens on the same connection. */
export async function loadPositionCandidates(c: PoolClient, tenantId: string): Promise<PositionCandidateRow[]> {
  const { rows } = await c.query<{ id: string; title: string; is_lead: boolean; holder_user_id: string | null }>(
    `SELECT p.id, p.title, p.is_lead,
            (SELECT pa.user_id FROM position_assignments pa
              WHERE pa.tenant_id = p.tenant_id AND pa.position_id = p.id AND pa.valid_to IS NULL
              ORDER BY pa.valid_from ASC, pa.user_id ASC LIMIT 1) AS holder_user_id
       FROM positions p
      WHERE p.tenant_id = $1 AND p.status = 'active'`,
    [tenantId],
  );
  return rows.map((r) => ({
    positionId: r.id,
    positionTitle: r.title,
    isLead: r.is_lead,
    holderUserId: r.holder_user_id,
  }));
}

export interface PositionHolderResolution {
  /** null when nothing in the tenant's org chart carries a title this role's pattern matches at all. */
  matchedPositionId: string | null;
  matchedPositionTitle: string | null;
  /** null when a title DID match but the seat is currently vacant (0109 §3.3) — a materially
   *  different reason than "no such seat concept exists here", and reported as such by the convert
   *  response's per-role source/reason (agency-lead-convert.service.ts). */
  holderUserId: string | null;
}

const EMPTY_RESOLUTION: PositionHolderResolution = {
  matchedPositionId: null,
  matchedPositionTitle: null,
  holderUserId: null,
};

/** PURE — no DB. Decide the single best-matching seat for one role from an already-loaded candidate
 *  set. Preference order: a title match WITH a current holder beats a vacant one (a vacant seat
 *  resolves nobody, however good the title match); among holders, an `is_lead` seat beats a non-lead
 *  one (both roles this ticket resolves — PM, tech lead — are lead-shaped seats in the roster, and a
 *  non-lead seat sharing the same title text is more likely a junior variant, e.g. "Junior Web
 *  Developer" would never match, but "Assistant Project Manager" plausibly could); ties break on
 *  `positionId` for a deterministic, reproducible-in-tests pick — never on insertion/query order. */
export function pickPositionHolder(
  role: PositionResolvableRole,
  candidates: PositionCandidateRow[],
): PositionHolderResolution {
  const pattern = ROLE_TITLE_PATTERN[role];
  const matches = candidates.filter((c) => pattern.test(c.positionTitle));
  if (matches.length === 0) return EMPTY_RESOLUTION;

  const withHolder = matches.filter((c) => c.holderUserId);
  const pool = withHolder.length > 0 ? withHolder : matches;
  const best = [...pool].sort((a, b) => {
    if (!!a.holderUserId !== !!b.holderUserId) return a.holderUserId ? -1 : 1;
    if (a.isLead !== b.isLead) return a.isLead ? -1 : 1;
    return a.positionId < b.positionId ? -1 : a.positionId > b.positionId ? 1 : 0;
  })[0];

  return {
    matchedPositionId: best.positionId,
    matchedPositionTitle: best.positionTitle,
    holderUserId: best.holderUserId,
  };
}

/** Convenience: resolve all three position-resolvable roles at once from one already-loaded
 *  candidate set, exactly the shape `computeDelegationPlan` wants. */
export function pickAllPositionHolders(
  candidates: PositionCandidateRow[],
): Record<PositionResolvableRole, PositionHolderResolution> {
  return {
    sitemap: pickPositionHolder("sitemap", candidates),
    integrations: pickPositionHolder("integrations", candidates),
    dns: pickPositionHolder("dns", candidates),
  };
}
