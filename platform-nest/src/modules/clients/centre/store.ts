// Client Centre — the shared `client_centre_profiles` row access + `CentreProfile` response shape.
// Used by BOTH the staff controller (clients-centre.controller.ts) and the portal controller
// (../../../core/portal-centre.controller.ts) so the two surfaces can never disagree about what a
// profile looks like on the wire. See docs/plans/2026-09-29-client-centre.md for the contract this
// mirrors (§ "API contract" -> `CentreProfile`).
import type { PoolClient } from "pg";
import { newId } from "../../../db";
import { config } from "../../../config";
import type { ProfileState } from "./validation";
import { allSections, connectionIdsFor, settingsDef, GENERAL_FIELD_KEYS } from "./sections";

export const DEFAULT_BUSINESS_TYPE = "other";

export function emptyProfileState(businessType = DEFAULT_BUSINESS_TYPE): ProfileState {
  return { businessType, profile: {}, connections: {}, departments: {}, customConnections: {} };
}

export interface ProfileRow {
  state: ProfileState;
  revision: number;
  updatedAt: string | null;
  updatedById: string | null;
}

/** The client's row, or `null` if none exists yet — a missing row means an empty profile (CC-D3);
 *  callers synthesise `emptyProfileState()` rather than treating this as "not found". */
export async function loadProfileRow(c: PoolClient, tenantId: string, clientId: string): Promise<ProfileRow | null> {
  const r = await c.query<{
    business_type: string; profile: Record<string, string>; connections: Record<string, unknown>;
    departments: Record<string, boolean>; custom_connections: Record<string, unknown>;
    revision: number; updated_at: string | null; updated_by: string | null;
  }>(
    `SELECT business_type, profile, connections, departments, custom_connections, revision, updated_at, updated_by
       FROM client_centre_profiles WHERE tenant_id = $1 AND client_id = $2`,
    [tenantId, clientId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    state: {
      businessType: row.business_type,
      profile: row.profile ?? {},
      connections: (row.connections ?? {}) as ProfileState["connections"],
      departments: row.departments ?? {},
      customConnections: (row.custom_connections ?? {}) as ProfileState["customConnections"],
    },
    revision: row.revision,
    updatedAt: row.updated_at,
    updatedById: row.updated_by,
  };
}

/** Upsert the row with `state`, bumping `revision` by 1. Caller has already decided there IS a
 *  change (CC's "a no-op PATCH still returns 200 but writes nothing" rule lives one level up) — this
 *  function always writes. */
export async function saveProfileRow(
  c: PoolClient,
  tenantId: string,
  clientId: string,
  state: ProfileState,
  updatedBy: string | null,
): Promise<{ revision: number; updatedAt: string }> {
  const r = await c.query<{ revision: number; updated_at: string }>(
    `INSERT INTO client_centre_profiles
       (id, tenant_id, client_id, business_type, profile, connections, departments, custom_connections,
        revision, updated_by, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10)
     ON CONFLICT (tenant_id, client_id) DO UPDATE SET
       business_type = EXCLUDED.business_type,
       profile = EXCLUDED.profile,
       connections = EXCLUDED.connections,
       departments = EXCLUDED.departments,
       custom_connections = EXCLUDED.custom_connections,
       revision = client_centre_profiles.revision + 1,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING revision, updated_at`,
    [
      newId(), tenantId, clientId, state.businessType, JSON.stringify(state.profile),
      JSON.stringify(state.connections), JSON.stringify(state.departments),
      JSON.stringify(state.customConnections), updatedBy, config.originSite,
    ],
  );
  return { revision: r.rows[0].revision, updatedAt: r.rows[0].updated_at };
}

export interface CentreProfileDTO {
  clientId: string;
  clientName: string;
  clientStatus: string | null;
  businessType: string;
  profile: Record<string, string>;
  connections: ProfileState["connections"];
  departments: Record<string, boolean>;
  customConnections: ProfileState["customConnections"];
  revision: number;
  updatedAt: string | null;
  updatedBy: { id: string; name: string | null } | null;
  canEdit: boolean;
}

/** Assemble the wire `CentreProfile` from a resolved row (or `null` for "no row yet") plus the
 *  caller-resolved `updatedBy` name — the two controllers each resolve that name inside their own
 *  transaction (one extra `users` lookup, only when a row exists), so this function stays a pure
 *  shape-builder with no query of its own. */
export function toCentreProfileDTO(
  client: { id: string; name: string; status: string | null },
  row: ProfileRow | null,
  updatedByName: string | null,
  canEdit: boolean,
): CentreProfileDTO {
  const s = row?.state ?? emptyProfileState();
  return {
    clientId: client.id,
    clientName: client.name,
    clientStatus: client.status,
    businessType: s.businessType,
    profile: s.profile,
    connections: s.connections,
    departments: s.departments,
    customConnections: s.customConnections,
    revision: row?.revision ?? 0,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedById ? { id: row.updatedById, name: updatedByName } : null,
    canEdit,
  };
}

/** `fieldsFilled` for the staff list endpoint — `{filled, total}` against the Company settings
 *  page's own field keys, EXACTLY matching platform-ui's `demoClientCentre.ts:toListItem` /
 *  `fieldsFilledCount(profile, generalFieldKeys)`. Total is fixed (the registry's own field count),
 *  not per-client. */
export function fieldsFilledSummary(state: ProfileState): { filled: number; total: number } {
  const filled = GENERAL_FIELD_KEYS.filter((k) => (state.profile[k] ?? "").trim().length > 0).length;
  return { filled, total: GENERAL_FIELD_KEYS.length };
}

/** `connectionsConnected` for the staff list endpoint — `{connected, total}` against the UNION of
 *  every connection id reachable from any section for this client's business type (registry
 *  connections + this client's own custom ones), EXACTLY matching platform-ui's
 *  `demoClientCentre.ts:toListItem` (`allSections` + `connectionIdsFor`, deduped). `total` therefore
 *  varies by business type and by how many custom connections the client has added. */
export function connectionsConnectedSummary(state: ProfileState): { connected: number; total: number } {
  const ids = new Set<string>();
  for (const section of allSections(state.businessType)) {
    for (const id of connectionIdsFor(section.id, settingsDef(section), state.customConnections)) ids.add(id);
  }
  const connected = [...ids].filter((id) => state.connections[id]?.status === "Connected").length;
  return { connected, total: ids.size };
}
