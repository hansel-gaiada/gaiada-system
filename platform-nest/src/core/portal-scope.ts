// CP-1 — the client portal's isolation kernel, extracted from PortalController.
//
// WHY THIS IS A MODULE AND NOT PRIVATE METHODS ANY MORE: the portal grew from 3 routes on one
// controller to ~20 across four, and every single one of them has to answer the same two questions
// before it touches a row — "which clients is this caller a contact of" and "which of that client's
// projects may they see". Leaving those as private methods on one controller would have meant the
// other three controllers each re-deriving the rule, and a rule re-derived four times is a rule that
// will disagree with itself. The `client_contacts`-vs-`portal_user_id` union below is exactly the sort
// of subtlety that gets dropped in a re-derivation — it was already missed once (see callerClientIds).
//
// The portal's isolation is FOUR layers, and this file is the third:
//   1. RLS          — tenant, in Postgres (FORCE RLS on the authorized-tenant-set)
//   2. Cerbos       — the `client` derived role on the `portal` resource
//   3. THIS FILE    — client + project ownership ("owned by caller"), applied as a SQL predicate
//   4. per-route    — the entity actually belongs to a run/invoice/contract in that scoped set
// Layer 3 is the one that stops client A reading client B's contract INSIDE the same tenant, which is
// the portal's whole reason for existing. RLS cannot express it (both clients are the same tenant) and
// Cerbos does not know the row. So: never write a portal query without a scope predicate from here.
import { ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";

/** The caller's resolved reach inside one tenant. `projectIds === null` means "every project of these
 *  clients" — NOT "no projects". Getting that inversion wrong fails OPEN, which is why every consumer
 *  passes it to SQL as `($n::uuid[] IS NULL OR project_id = ANY($n::uuid[]))` rather than branching in
 *  TypeScript, where an accidental `?? []` would silently widen or narrow. */
export interface PortalScope {
  clientIds: string[];
  projectIds: string[] | null;
  /** Whether this caller may SIGN (contracts, scope agreements) or only watch. A contact is a
   *  `signer` on some rows and a `viewer` on others (D-1 makes contacts per-project), so this is the
   *  union: true if ANY active row grants signing. Per-object narrowing is the route's job. */
  canSign: boolean;
}

export interface PortalPrincipal {
  userId: string | null;
}

/** Every client this caller is an active portal contact of.
 *
 *  ⚠ THE UNION IS LOAD-BEARING — do not simplify it. `client_contacts` (0072) is what the invite/accept
 *  flow writes; `clients.portal_user_id` is the older single-contact column. The portal originally read
 *  ONLY the latter, so an invited contact could accept, get a Keycloak account, receive the `client`
 *  role, gain the tenant through principal.ts's client_contacts union, pass `resource_portal` authz —
 *  and then be refused here with "not a portal client". Everything upstream succeeded and the portal
 *  still showed nothing. The legacy column still has live rows and its own tests; it is retired by a
 *  later migration, not by deleting this branch.
 *
 *  Returns a SET because contacts are many-per-client (D-1): one person can legitimately be a
 *  stakeholder for two clients of the same agency. */
export async function callerClientIds(c: PoolClient, principal: PortalPrincipal): Promise<string[]> {
  if (!principal.userId) throw new ForbiddenException("not a portal client");
  const r = await c.query<{ id: string }>(
    `SELECT cc.client_id AS id
       FROM client_contacts cc
      WHERE cc.user_id = $1 AND cc.status = 'active' AND cc.deleted_at IS NULL
      UNION
     SELECT cl.id FROM clients cl WHERE cl.portal_user_id = $1 AND cl.deleted_at IS NULL`,
    [principal.userId],
  );
  const ids = r.rows.map((row) => row.id);
  // A `revoked` or still-`invited` contact resolves to nothing and is refused here — status governs
  // ACCESS, which is precisely the question this function asks.
  if (!ids.length) throw new ForbiddenException("not a portal client");
  return ids;
}

/** The caller's full scope for one tenant: clients, project restriction, and signing capability.
 *
 *  One query for the contact rows, so adding `canSign` costs nothing over the previous two-query
 *  shape. The `clients.portal_user_id` legacy branch is UNIONed in as a client-wide signer, which is
 *  what it has always meant (it predates the capability column entirely). */
export async function resolvePortalScope(c: PoolClient, principal: PortalPrincipal): Promise<PortalScope> {
  const clientIds = await callerClientIds(c, principal);
  const r = await c.query<{ project_id: string | null; capability: string }>(
    `SELECT cc.project_id, cc.capability
       FROM client_contacts cc
      WHERE cc.user_id = $1 AND cc.status = 'active' AND cc.deleted_at IS NULL
        AND cc.client_id = ANY($2::uuid[])
      UNION ALL
     SELECT NULL::uuid AS project_id, 'signer' AS capability
       FROM clients cl WHERE cl.portal_user_id = $1 AND cl.deleted_at IS NULL`,
    [principal.userId, clientIds],
  );
  // Any client-wide grant (project_id IS NULL, or the legacy whole-client scheme) => unrestricted.
  // A client-wide row WIDENS access and must win over any narrower row — otherwise adding a
  // project-scoped row to someone who already had client-wide access would silently take access away.
  const projectIds = r.rows.some((row) => row.project_id === null)
    ? null
    : r.rows.map((row) => row.project_id as string);
  return {
    clientIds,
    projectIds,
    canSign: r.rows.some((row) => row.capability === "signer"),
  };
}

/** Refuse a write the caller's capability does not cover. Separate from the scope resolution so a
 *  READ route can never accidentally acquire a signing gate, and a SIGN route can never forget one. */
export function requireSigner(scope: PortalScope): void {
  if (!scope.canSign) {
    throw new ForbiddenException("your access is view-only — ask your account manager to grant signing");
  }
}
