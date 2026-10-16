// DW-10e (docs/FRONTEND-BFF-CONTRACT.md §60.2; PERMISSION-CONTRACT §49) — ROUTES: the routing keys of requests across group
// companies, and the one lookup every route check shares.
//
// A route is a `service_assignments` row whose `module_key` is a ROUTING KEY, not a registered module: "this department of the
// provider company takes requests of this kind from the target company". It grants nobody anything. This file is the single
// source of the keys; four places read it and nothing else may name them:
//   - `admin/service-reconciler.ts`      a routing key's desired set is always EMPTY (no membership, no grant, no claim);
//   - `modules/registry.ts`              `enabledModuleKeys` leaves a routing key out (a route turns no module on);
//   - `modules/reports/fact-job.ts` and `report-rollups.ts`  a route never stamps a provider on a fact or feeds a provider view;
//   - `admin/service-assignments.controller.ts`  `assertValidModuleKey` accepts one although it is not a registered module.
// The database trigger `work_requests_route_guard` (migration 202610160200) spells the same two keys in a SQL CASE; a static test
// pins that CASE to `REQUEST_ROUTE_KEYS`, so the two cannot drift apart silently.
//
// Pure on purpose (no DB import at runtime): the reconciler, the registry and the report jobs load this file, and none of them may
// pick up a connection pool through it.
import type { PoolClient } from "pg";
import type { RequestKind } from "./work-requests.service";

/** The routing keys, in the order of `REQUEST_KINDS`: one per request kind. */
export const REQUEST_ROUTE_KEYS = ["asset_requests", "engineering_requests"] as const;
export type RequestRouteKey = (typeof REQUEST_ROUTE_KEYS)[number];

const KEY_BY_KIND: Readonly<Record<RequestKind, RequestRouteKey>> = {
  assets: "asset_requests",
  engineering: "engineering_requests",
};
const KIND_BY_KEY: Readonly<Record<RequestRouteKey, RequestKind>> = {
  asset_requests: "assets",
  engineering_requests: "engineering",
};

/** True for a routing key. Anything else, including a non-string, is false: callers branch on it, so it never throws. */
export function isRequestRouteKey(key: unknown): key is RequestRouteKey {
  return typeof key === "string" && (REQUEST_ROUTE_KEYS as readonly string[]).includes(key);
}

/** The routing key a request of this kind goes through. */
export function routeKeyForKind(kind: RequestKind): RequestRouteKey {
  return KEY_BY_KIND[kind];
}

/** The request kind a routing key carries. */
export function kindForRouteKey(key: RequestRouteKey): RequestKind {
  return KIND_BY_KEY[key];
}

export type GroupClientResolution =
  | { status: "one"; clientId: string }
  | { status: "none" }
  | { status: "ambiguous" };

/** §60.2 "The target must be the provider's client (DW-D41)". The provider's live client record linked to `targetTenantId`:
 *  `clients.group_company_id = target`, not deleted, not the internal sentinel. `none` and `ambiguous` are the two refusals
 *  (422 `route_needs_group_client`, 422 `group_client_ambiguous` on a route's creation; 409 `group_client_missing`,
 *  409 `group_client_ambiguous` on every send, which is 10e-2's).
 *
 *  Runs on the caller's `PoolClient`, which MUST be inside `withTenants([providerTenantId])`: `clients` is FORCE RLS, an unset
 *  tenant reads ZERO rows, and zero rows here would read as "no client record" for every company. The explicit
 *  `tenant_id = $1` is belt and braces, not the wall. `LIMIT 2` is enough to tell one from several. */
export async function resolveGroupClient(
  c: PoolClient, providerTenantId: string, targetTenantId: string,
): Promise<GroupClientResolution> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM clients
      WHERE tenant_id = $1 AND group_company_id = $2 AND deleted_at IS NULL AND NOT is_internal
      ORDER BY id LIMIT 2`,
    [providerTenantId, targetTenantId],
  );
  if (rows.length === 0) return { status: "none" };
  if (rows.length > 1) return { status: "ambiguous" };
  return { status: "one", clientId: rows[0].id };
}
