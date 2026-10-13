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
//
// ⚠ NOT THE SAME THING AS `core/client-filter.ts` (CC-1), which parses the STAFF `?clientId=` list
// facet. That file narrows what a staff caller is SHOWN and fails OPEN (a bad value means "show
// everything"); this file decides what an external caller may REACH and fails CLOSED. Same noun,
// opposite failure mode. Keep them separate: collapsing them into one "client scope" abstraction is how
// a convenience filter silently becomes load-bearing for isolation.
import { ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";

/** The caller's resolved reach inside one tenant, PER CLIENT.
 *
 *  ⚠ PER CLIENT, NEVER FLATTENED (portal scope kernel per client, 2026-10-13). A contact can be a contact
 *  of several clients with a different reach and capability on each: client-wide `signer` on A and a
 *  `viewer` limited to one project on B. The scope used to be flattened across all of them (any client-wide
 *  row made `projectIds` null for EVERY client, and any signer row made `canSign` true for EVERY client), so
 *  that contact saw every project of B and could sign B's agreements. Every field below is therefore either
 *  a set of CLIENTS the caller holds a property on, or a set of explicit project ids; there is no global
 *  boolean and no "null means everything" any more.
 *
 *  How a query uses it: `inCallerClients` (row's client in `clientIds`) AND the project arm
 *  `(row's client in wideClientIds OR row's project in projectIds [OR row has no project])`, both built by
 *  portal-visibility.ts. Bind the three arrays with `scopeValues(scope)` at the indexes `scopeAt(n)` names. */
export interface PortalScope {
  /** Every client the caller is an active portal contact of. */
  clientIds: string[];
  /** The clients the caller reaches CLIENT-WIDE: an active `client_contacts` row with `project_id IS NULL`,
   *  or the legacy `clients.portal_user_id` column. Always a subset of `clientIds`. */
  wideClientIds: string[];
  /** The explicit project ids of the caller's project-scoped rows. Never null: an empty array means "no
   *  project-scoped grants", NOT "every project". Client-wide reach lives in `wideClientIds` only. */
  projectIds: string[];
  /** The clients on which the caller may SIGN (contracts, scope agreements, signature gates): an active row
   *  with capability `signer` or `admin` (WSK-49f: `admin` implies signer), or the legacy column. A signing
   *  route resolves its target's `client_id` and calls `requireSignerFor(scope, thatClient)`.
   *
   *  NOTE: a signer row that is PROJECT-scoped still makes the caller a signer for that client; the route's
   *  read predicate already confines them to their project's objects (and the client's project-less ones,
   *  for contracts), which is the existing per-object rule. There is deliberately no global `canSign`. */
  signerClientIds: string[];
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
    // M5-G0b: the internal sentinel client is never part of a portal scope (WSK-D36).
    `SELECT cc.client_id AS id
       FROM client_contacts cc
       JOIN clients ccl ON ccl.id = cc.client_id AND NOT ccl.is_internal
      WHERE cc.user_id = $1 AND cc.status = 'active' AND cc.deleted_at IS NULL
      UNION
     SELECT cl.id FROM clients cl WHERE cl.portal_user_id = $1 AND cl.deleted_at IS NULL AND NOT cl.is_internal`,
    [principal.userId],
  );
  const ids = r.rows.map((row) => row.id);
  // A `revoked` or still-`invited` contact resolves to nothing and is refused here — status governs
  // ACCESS, which is precisely the question this function asks.
  if (!ids.length) throw new ForbiddenException("not a portal client");
  return ids;
}

/** The caller's full scope for one tenant: clients, per-client reach, and per-client signing.
 *
 *  One query for the contact rows. The `clients.portal_user_id` legacy branch is UNIONed in as a
 *  client-wide signer, which is what it has always meant (it predates the capability column entirely). */
export async function resolvePortalScope(c: PoolClient, principal: PortalPrincipal): Promise<PortalScope> {
  const clientIds = await callerClientIds(c, principal);
  const r = await c.query<{ client_id: string; project_id: string | null; capability: string }>(
    `SELECT cc.client_id, cc.project_id, cc.capability
       FROM client_contacts cc
      WHERE cc.user_id = $1 AND cc.status = 'active' AND cc.deleted_at IS NULL
        AND cc.client_id = ANY($2::uuid[])
      UNION ALL
     SELECT cl.id AS client_id, NULL::uuid AS project_id, 'signer' AS capability
       FROM clients cl WHERE cl.portal_user_id = $1 AND cl.deleted_at IS NULL AND NOT cl.is_internal
        AND cl.id = ANY($2::uuid[])`,
    [principal.userId, clientIds],
  );
  // A client-wide row (project_id IS NULL, or the legacy whole-client scheme) widens access to THAT client
  // only, and wins over any narrower row of the same client (adding a project-scoped row to someone who is
  // already client-wide must not take access away). It says nothing about the caller's OTHER clients.
  const wide = new Set<string>();
  const projects = new Set<string>();
  const signers = new Set<string>();
  for (const row of r.rows) {
    if (row.project_id === null) wide.add(row.client_id);
    else projects.add(row.project_id);
    // WSK-49f (owner ruling 2026-10-11): `admin` IMPLIES signer. The capability column is single-valued, so
    // promoting a signer to admin must not silently take signing away from them.
    if (row.capability === "signer" || row.capability === "admin") signers.add(row.client_id);
  }
  return {
    clientIds,
    wideClientIds: clientIds.filter((id) => wide.has(id)),
    projectIds: [...projects],
    signerClientIds: clientIds.filter((id) => signers.has(id)),
  };
}

/** The three scope arrays, in the order `scopeAt(n)` binds them: `[clientIds, wideClientIds, projectIds]`.
 *  Spread it into a query's params at position n: `[id, ...scopeValues(scope)]` with `scopeAt(2)`. */
export function scopeValues(scope: PortalScope): [string[], string[], string[]] {
  return [scope.clientIds, scope.wideClientIds, scope.projectIds];
}

/** May the caller sign on behalf of this client? Per client: being a signer of another client grants
 *  nothing here. `clientId` must be the TARGET's own `client_id`, read from the row, never the body. */
export function canSignFor(scope: PortalScope, clientId: string | null | undefined): boolean {
  return !!clientId && scope.signerClientIds.includes(clientId);
}

/** Does the caller reach this client client-wide (every project of it, and its client-wide threads)? */
export function isWideFor(scope: PortalScope, clientId: string | null | undefined): boolean {
  return !!clientId && scope.wideClientIds.includes(clientId);
}

/** Refuse a signing write the caller's capability ON THIS CLIENT does not cover. Call it only AFTER the
 *  target has passed the read predicate (an object outside the caller's scope is 404, never 403), with the
 *  target's own `client_id`. Separate from the scope resolution so a READ route can never accidentally
 *  acquire a signing gate, and a SIGN route can never forget one. */
export function requireSignerFor(scope: PortalScope, clientId: string | null | undefined): void {
  if (!canSignFor(scope, clientId)) {
    throw new ForbiddenException("your access is view-only — ask your account manager to grant signing");
  }
}
