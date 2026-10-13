// M6-P6i — a registry row that gets a REAL domain also gets its `search_properties` row, and the consent gate that goes with it.
//
// WHY: MON-01 probes only `search_properties` rows with `verified_at IS NOT NULL` (client-targets.ts PROBEABLE_SQL, the
// monitoring runner's own join, the monitoring controller). Before this, a provisioned site's claim (M6-P4c2) and its
// production row (M6-P6g) put a domain on `webdev_sites` and nothing anywhere else, so the domain was in the registry and
// invisible to the SEO module and to monitoring, and the probe-consent request (`console/probe-consent-requests`) had no
// property id to ask about. WSK-D35 makes the domain the key: one domain, ONE property row, one consent gate.
//
// THE CONSENT RULE (webdesk-design-v2.md §07, WSK-D36). Scheduled requests to someone else's server are a permissions
// question, so the gate is the same for every property and the claim never opens it for a client:
//   - a CLIENT site (the registry row's client is a real client): the property is created UNVERIFIED (`verified_at` NULL).
//     Nothing probes it until the probe-consent approval (the existing flow) sets `verified_at`;
//   - an INTERNAL site (no client on the registry row, or the row's client is the internal sentinel, `clients.is_internal`):
//     consent is trivially ours (D36(a)), so the property is created VERIFIED, under the SENTINEL client (D36(b): internal
//     properties are distinguishable). That needs the sentinel to EXIST (M5-G0 created it live): with none, or with more than
//     one, no property is created and the answer says `no_internal_sentinel` / `ambiguous_internal_sentinel`. A property
//     with no owner is not invented, and an unverified one is not a stand-in for an internal one;
//   - an EXISTING live property for the same domain (case-insensitive, the D35 index) is LINKED, never modified: its
//     `verified_at` is left exactly as it is (a link never grants consent and never takes it away). If it belongs to a
//     different client than this row's owner, that is a conflict and the claim is REFUSED: one domain cannot have two owners.
//
// `planPropertyLink` is pure (the unit suite drives it); `linkPropertyForSite` is its Postgres half, run INSIDE the caller's
// transaction (the claim's, the production row's) so the registry change and its property commit or roll back together.
// The transaction must declare BOTH module scopes (`webdev`, `search`): `search_properties` carries the search wall, and
// without it every read returns zero rows and the plan would say "insert" for a row that exists (the RLS zero-row trap).
import type { PoolClient } from "pg";
import { newId } from "../../db";
import { config } from "../../config";
import { emitEvent } from "../../events/outbox.service";

export interface PropertyLinkState {
  /** `webdev_sites.client_id` of the row that got the domain. NULL = an internal site (WSK-D35: a delivery fact). */
  siteClientId: string | null;
  /** The row's client is itself an internal client (`clients.is_internal`). */
  siteClientIsInternal: boolean;
  /** Every live internal-sentinel client of the tenant (normally exactly one). */
  sentinelIds: string[];
  /** The live `search_properties` row for lower(domain) under the tenant, if any. */
  existing: { id: string; clientId: string; verifiedAt: Date | null } | null;
}

export type PropertyLinkPlan =
  | { action: "insert"; clientId: string; internal: boolean }
  | { action: "link"; propertyId: string; internal: boolean }
  | { action: "skip"; reason: "no_internal_sentinel" | "ambiguous_internal_sentinel" }
  | { action: "conflict"; propertyId: string; ownerClientId: string };

/** Pure. What a registry row's new domain does to `search_properties`. Never reads, never writes. */
export function planPropertyLink(state: PropertyLinkState): PropertyLinkPlan {
  const internal = state.siteClientId === null || state.siteClientIsInternal;
  let owner: string | null;
  if (!internal) {
    owner = state.siteClientId;
  } else if (state.siteClientIsInternal) {
    owner = state.siteClientId;
  } else if (state.sentinelIds.length === 1) {
    owner = state.sentinelIds[0];
  } else {
    return { action: "skip", reason: state.sentinelIds.length === 0 ? "no_internal_sentinel" : "ambiguous_internal_sentinel" };
  }
  if (owner === null) return { action: "skip", reason: "no_internal_sentinel" };
  if (state.existing) {
    return state.existing.clientId === owner
      ? { action: "link", propertyId: state.existing.id, internal }
      : { action: "conflict", propertyId: state.existing.id, ownerClientId: state.existing.clientId };
  }
  return { action: "insert", clientId: owner, internal };
}

/** What the claim and the production command report back, and the console reads. */
export interface PropertyLinkResult {
  /** `created` a new row; `linked` an existing one (left as it was); `skipped` nothing was created, see `reason`. */
  state: "created" | "linked" | "skipped";
  propertyId: string | null;
  /** `verified_at` is set: MON-01 may probe the domain. False for every client site until the probe-consent approval. */
  verified: boolean;
  internal: boolean;
  reason: string | null;
}

/** Raised (inside the caller's transaction, so it rolls the registry change back) when the domain already has a property
 *  that belongs to another client. */
export class PropertyDomainConflict extends Error {
  constructor(readonly propertyId: string) {
    super(`property_domain_conflict: the domain already has a search property that belongs to another client (${propertyId})`);
    this.name = "PropertyDomainConflict";
  }
}

/**
 * Create or link the property for a registry row's domain, inside the caller's transaction (declare `modules: ["webdev",
 * "search"]`). Emits `webdev.site.property_linked` (ids and the consent flag, never a credential). Throws
 * `PropertyDomainConflict` when the domain belongs to another client.
 */
export async function linkPropertyForSite(
  c: PoolClient,
  tenantId: string,
  site: { id: string; domain: string; clientId: string | null },
): Promise<PropertyLinkResult> {
  const sentinels = await c.query<{ id: string }>(
    `SELECT id FROM clients WHERE tenant_id = $1 AND is_internal AND deleted_at IS NULL ORDER BY created_at, id`,
    [tenantId],
  );
  let siteClientIsInternal = false;
  if (site.clientId !== null) {
    const own = await c.query<{ is_internal: boolean }>(
      `SELECT is_internal FROM clients WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [site.clientId, tenantId],
    );
    siteClientIsInternal = own.rows[0]?.is_internal === true;
  }
  const existing = await c.query<{ id: string; client_id: string; verified_at: Date | null }>(
    `SELECT id, client_id, verified_at FROM search_properties
      WHERE tenant_id = $1 AND lower(domain) = lower($2) AND deleted_at IS NULL
      ORDER BY created_at, id LIMIT 1`,
    [tenantId, site.domain],
  );
  const row = existing.rows[0];
  const plan = planPropertyLink({
    siteClientId: site.clientId,
    siteClientIsInternal,
    sentinelIds: sentinels.rows.map((r) => r.id),
    existing: row ? { id: row.id, clientId: row.client_id, verifiedAt: row.verified_at } : null,
  });

  let result: PropertyLinkResult;
  switch (plan.action) {
    case "conflict":
      throw new PropertyDomainConflict(plan.propertyId);
    case "skip":
      result = { state: "skipped", propertyId: null, verified: false, internal: true, reason: plan.reason };
      break;
    case "link":
      result = { state: "linked", propertyId: plan.propertyId, verified: row?.verified_at != null, internal: plan.internal, reason: null };
      break;
    case "insert": {
      const id = newId();
      // `verified_at` is the consent gate: now() ONLY for an internal property (D36(a)), NULL for every client's.
      await c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, umami_site_id, verified_at, origin_site)
         VALUES ($1, $2, $3, $4, $5, NULL, CASE WHEN $6::boolean THEN now() ELSE NULL END, $7)`,
        [id, tenantId, plan.clientId, site.domain, `https://${site.domain}/`, plan.internal, config.originSite],
      );
      result = { state: "created", propertyId: id, verified: plan.internal, internal: plan.internal, reason: null };
      break;
    }
  }
  await emitEvent(c, tenantId, "webdev_site", site.id, "webdev.site.property_linked", {
    domain: site.domain, state: result.state, propertyId: result.propertyId, verified: result.verified, internal: result.internal, reason: result.reason,
  });
  return result;
}
