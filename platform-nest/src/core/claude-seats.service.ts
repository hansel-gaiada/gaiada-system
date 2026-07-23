// WSUX-17 (ex-P1-10) — C1 Claude seat registry: a thin, provider-scoped projection over the WSUX-14
// connections vault (integration_connections, provider='claude'). NO new table, NO new secret path —
// every read/write here delegates straight to integrations.service.ts (the same vault, the same
// tenant_isolation RLS, the same enc:v1 sealing for any future token). This module only adds what the
// generic connections API doesn't already offer:
//   1. a seat-shaped response (codeSeatEmail / designLogin / mapped) instead of the generic
//      ConnectionResponse shape, so the console's LauncherRow ("opens as <seat>" / "Map your seat")
//      and team grid can consume it directly;
//   2. a company-wide "team roster" list (every user-owned claude row in a tenant) for the console's
//      team grid — the generic connections list only supports owner=me/company/user:<id>, not "every
//      user's row for one provider" in a single call.
//
// A "seat" IS an integration_connections row with provider='claude' and owner_kind='user' — there is
// no seat-specific table and no seat-specific columns. `externalAccount` holds the Claude Code seat
// email (the same column every provider uses); `meta.designLogin` holds the Claude Design login
// (already documented in the 0033 migration comment + FRONTEND-BFF-CONTRACT.md §12 as the provider='claude'
// meta convention). Company-owned ("shared team seat") claude rows are out of scope for this registry —
// C1's design is per-person seat mapping; a company-level claude connection, if one is ever created via
// the generic API, simply won't appear in a person's/team's seat roster (owner_kind filter excludes it).
import {
  type ConnectionResponse,
  createConnection,
  getConnectionRow,
  listConnections,
  patchConnection,
  revokeConnection,
} from "./integrations.service";

export interface SeatResponse {
  id: string;
  tenantId: string;
  personId: string; // = the row's owner_id (owner_kind is always 'user' for a seat)
  codeSeatEmail: string | null;
  designLogin: string | null;
  status: string;
  scopes: string[];
  /** true iff a codeSeatEmail is set and the row isn't (soft-)revoked. Drives the console's
   *  LauncherRow seatStatus ("mapped" vs "unmapped") — status alone can't tell that (create() always
   *  starts a row at 'unconfigured' regardless of whether externalAccount was supplied). */
  mapped: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function readDesignLogin(meta: Record<string, unknown>): string | null {
  const v = meta?.designLogin;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The ONLY projection this module returns. Built on top of ConnectionResponse, which structurally
 *  never carries token ciphertext — so this inherits the WSUX-14 non-exposure guarantee for free
 *  rather than re-deriving it. */
export function toSeatResponse(c: ConnectionResponse): SeatResponse {
  return {
    id: c.id,
    tenantId: c.tenantId,
    personId: c.ownerId,
    codeSeatEmail: c.externalAccount,
    designLogin: readDesignLogin(c.meta),
    status: c.status,
    scopes: c.scopes,
    mapped: c.status !== "revoked" && !!c.externalAccount,
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** owner=me / owner=user:<id> — a single person's seat. 0 or 1 rows: UNIQUE(tenant, owner_kind,
 *  owner_id, provider) on integration_connections means a person has at most one claude seat row
 *  per company. Returns null when unmapped/never linked (never a synthetic "unmapped" row). */
export async function getPersonSeat(tenantId: string, personId: string): Promise<SeatResponse | null> {
  const rows = await listConnections(tenantId, { ownerKind: "user", ownerId: personId, provider: "claude" });
  return rows[0] ? toSeatResponse(rows[0]) : null;
}

/** owner=team — every user-owned claude row in the tenant (mapped AND unmapped-but-created), for the
 *  console's team grid. Company-wide, so the controller gates this to company.manage (same tier as the
 *  generic connections API's owner=company case) — never exposed to a plain member for other people. */
export async function listTeamSeats(tenantId: string): Promise<SeatResponse[]> {
  const rows = await listConnections(tenantId, { ownerKind: "user", provider: "claude" });
  return rows.map(toSeatResponse);
}

export interface MapSeatInput {
  personId: string;
  codeSeatEmail: string;
  designLogin?: string | null;
  createdBy: string | null;
}

/** Map (or re-map) a person's Claude seat. Delegates to createConnection's UPSERT (decision #8) — a
 *  repeat call, including re-linking a previously revoked seat, updates externalAccount/meta rather
 *  than erroring or duplicating a row. Never touches tokens (Phase-1 mapping is identity-only). */
export async function mapSeat(tenantId: string, input: MapSeatInput): Promise<SeatResponse> {
  const conn = await createConnection(tenantId, {
    ownerKind: "user",
    ownerId: input.personId,
    provider: "claude",
    externalAccount: input.codeSeatEmail,
    meta: input.designLogin !== undefined ? { designLogin: input.designLogin } : {},
    createdBy: input.createdBy,
  });
  return toSeatResponse(conn);
}

export interface PatchSeatInput {
  codeSeatEmail?: string | null;
  designLogin?: string | null;
  status?: string;
}

/** PATCH a seat's codeSeatEmail / designLogin / status. designLogin is READ-MERGED into the existing
 *  meta (not a wholesale replace, unlike the generic patchConnection's meta param) so patching one
 *  seat field never clobbers other meta keys a future seat attribute might add. */
export async function patchSeat(tenantId: string, id: string, input: PatchSeatInput): Promise<SeatResponse> {
  let meta: Record<string, unknown> | undefined;
  if (input.designLogin !== undefined) {
    const row = await getConnectionRow(tenantId, id);
    meta = { ...(row?.meta ?? {}), designLogin: input.designLogin };
  }
  const conn = await patchConnection(tenantId, id, {
    externalAccount: input.codeSeatEmail,
    meta,
    status: input.status,
  });
  return toSeatResponse(conn);
}

/** Unmap = the vault's soft revoke: status='revoked', row KEPT, any token nulled (none exist for a
 *  seat in Phase 1, but this keeps ONE revoke path rather than growing a seat-specific delete). A
 *  revoked seat can be re-mapped later via mapSeat's upsert. */
export async function unmapSeat(tenantId: string, id: string): Promise<SeatResponse> {
  const conn = await revokeConnection(tenantId, id);
  return toSeatResponse(conn);
}
