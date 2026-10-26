// M5-W1d — the freelance-contributor invite token: mint, verify, single-use consume (owner ruling WSK-D84; design
// docs/plans/2026-10-11-m5-writers-room-design.md §3.1 item 3).
//
// A SIBLING OF `client-invites.ts`, NEVER A WIDENING OF IT. The client invite provisions a portal contact; this one
// provisions a contributor, a different principal class on the other side of the staff/client boundary. If one token
// family could be redeemed by the other's accept route, a client link could mint a staff-side principal (or the reverse).
// So nothing is shared that could make one token valid for the other:
//   * its own PREFIX (`ctr1`, the client's is `inv2`/`inv1`): each parser refuses the other's shape before any crypto;
//   * its own HMAC KEY, domain-separated from the client invite's by a different fixed label
//     (`gaiada:contributor-invite:v1` vs `gaiada:client-invite:v1`), so even a token re-spelled with the other prefix fails
//     the signature;
//   * its own TABLE (`editorial_contributor_invites`, migration 202610270900), so the client accept route's consume
//     (which reads `client_invites`) can never find a contributor invite, and the reverse.
// `contributor-invites.test.ts` proves all three directions.
//
// STRENGTH: at least the client invite's after PGL-10, by construction (the same attack list A1 to A6 applies):
//   A1 forgery / tenant pivot    HMAC over (invite id, tenant id, nonce), compared with timingSafeEqual BEFORE any DB read;
//                                the signed tenant is the only one put into withTenants.
//   A2 replay / double accept    ONE atomic `UPDATE … WHERE consumed_at IS NULL … RETURNING`.
//   A3 another address           the email is bound into the row at issue time; the accept provisions THAT address.
//   A4 leaked database           only sha256(token) is stored, and the token carries 16 random bytes (never stored), so a
//                                leaked database AND a leaked key together still cannot rebuild a usable link.
//   A5 indefinite validity       a TTL inside the consume predicate.
//   A6 cross-tenant read         FORCE RLS on the table plus the signed tenant.
//   PGL-10's lesson: the consume claims by id AND token hash, so a stale or forged token spends nothing.
// Link delivery only in W1d (the raw token is returned once to the inviting publisher, like the client invite's "link"
// delivery); a mailed contributor invite is a follow-up.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";

import { config } from "../config";
import { newId, withTenants } from "../db";

const TOKEN_PREFIX = "ctr1";
const NONCE_BYTES = 16;
/** How long an issued contributor link stays usable. Shorter than an engagement by far; a lost link means a new invite. */
export const CONTRIBUTOR_INVITE_TTL_SECONDS = 72 * 60 * 60;

export type ContributorInviteFailureReason = "malformed_token" | "bad_signature" | "unknown_or_expired" | "not_configured";

/** Coarse to the caller (the accept route is unauthenticated: no oracle between unknown, expired and used). */
export class ContributorInviteError extends Error {
  readonly status: number;
  readonly code = "contributor_invite_invalid";
  constructor(readonly reason: ContributorInviteFailureReason) {
    super(
      reason === "not_configured"
        ? "contributor invites are not configured: INTEGRATION_TOKEN_KEY must be set (it signs the invite token)"
        : "this invitation link is not usable — ask for a new one",
    );
    this.name = "ContributorInviteError";
    this.status = reason === "not_configured" ? 503 : 400;
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Derived from the credential-vault key under a label of its OWN: never the client invite's key (see the header). */
function signingKey(): Buffer {
  const b64 = config.integrationTokenKey;
  if (!b64) throw new ContributorInviteError("not_configured");
  return createHmac("sha256", Buffer.from(b64, "base64")).update("gaiada:contributor-invite:v1").digest();
}

function signingInput(inviteId: string, tenantId: string, nonce: Buffer): string {
  return `${TOKEN_PREFIX}.${b64url(Buffer.from(inviteId, "utf8"))}.${b64url(Buffer.from(tenantId, "utf8"))}.${b64url(nonce)}`;
}

/** Mint a token. A fresh nonce per call. `nonce` is a test seam only. */
export function signContributorInviteToken(inviteId: string, tenantId: string, nonce: Buffer = randomBytes(NONCE_BYTES)): string {
  const input = signingInput(inviteId, tenantId, nonce);
  return `${input}.${b64url(createHmac("sha256", signingKey()).update(input).digest())}`;
}

export function hashContributorToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export interface ParsedContributorInviteToken {
  inviteId: string;
  tenantId: string;
}

/** Verify + unpack. Throws on anything unusable, BEFORE any database access. */
export function parseContributorInviteToken(token: string): ParsedContributorInviteToken {
  const parts = (token ?? "").split(".");
  if (parts.length !== 5 || parts[0] !== TOKEN_PREFIX) throw new ContributorInviteError("malformed_token");
  let inviteId: string;
  let tenantId: string;
  let nonce: Buffer;
  try {
    inviteId = Buffer.from(parts[1], "base64url").toString("utf8");
    tenantId = Buffer.from(parts[2], "base64url").toString("utf8");
    nonce = Buffer.from(parts[3], "base64url");
  } catch {
    throw new ContributorInviteError("malformed_token");
  }
  if (!inviteId || !tenantId || nonce.length !== NONCE_BYTES) throw new ContributorInviteError("malformed_token");
  // Recompute over the CANONICAL re-encoding of the decoded values, never the caller's own segments (no second spelling).
  const expected = createHmac("sha256", signingKey()).update(signingInput(inviteId, tenantId, nonce)).digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(parts[4], "base64url");
  } catch {
    throw new ContributorInviteError("bad_signature");
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw new ContributorInviteError("bad_signature");
  }
  return { inviteId, tenantId };
}

export interface CreatedContributorInvite {
  inviteId: string;
  /** The RAW token. Returned exactly once, never stored, never logged. */
  token: string;
  expiresAt: string;
}

/** Mint a link invite for an anchor, on the caller's `withTenants([tenantId])` connection (inside its transaction). */
export async function createContributorInvite(
  c: PoolClient,
  input: { tenantId: string; contributorId: string; email: string; invitedBy: string | null },
): Promise<CreatedContributorInvite> {
  const inviteId = newId();
  const token = signContributorInviteToken(inviteId, input.tenantId);
  const expiresAt = new Date(Date.now() + CONTRIBUTOR_INVITE_TTL_SECONDS * 1000).toISOString();
  await c.query(
    `INSERT INTO editorial_contributor_invites
       (id, tenant_id, contributor_id, email, token_hash, expires_at, invited_by, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [inviteId, input.tenantId, input.contributorId, input.email.trim().toLowerCase(), hashContributorToken(token), expiresAt,
     input.invitedBy, config.originSite],
  );
  return { inviteId, token, expiresAt };
}

/** A resend spends every open invite of the anchor first (same transaction), so at most ONE link is live. */
export async function spendOpenContributorInvites(c: PoolClient, contributorId: string): Promise<number> {
  const r = await c.query(
    `UPDATE editorial_contributor_invites SET consumed_at = now() WHERE contributor_id = $1 AND consumed_at IS NULL`,
    [contributorId],
  );
  return r.rowCount ?? 0;
}

export interface ConsumedContributorInvite {
  inviteId: string;
  tenantId: string;
  contributorId: string;
  /** The address the invite was ISSUED for. Provision this, never anything from the request body. */
  email: string;
}

/** Single-use consume: one atomic UPDATE claimed by id AND token hash (PGL-10), unexpired, unspent. */
export async function consumeContributorInvite(rawToken: string): Promise<ConsumedContributorInvite> {
  const { inviteId, tenantId } = parseContributorInviteToken(rawToken);
  const presentedHash = hashContributorToken(rawToken);
  const row = await withTenants([tenantId], async (c) => {
    const res = await c.query<{ id: string; tenant_id: string; contributor_id: string; email: string; token_hash: string }>(
      `UPDATE editorial_contributor_invites
          SET consumed_at = now()
        WHERE id = $1 AND token_hash = $2 AND consumed_at IS NULL AND expires_at > now()
        RETURNING id, tenant_id, contributor_id, email, token_hash`,
      [inviteId, presentedHash],
    );
    return res.rows[0] ?? null;
  });
  if (!row) throw new ContributorInviteError("unknown_or_expired");
  const stored = Buffer.from(row.token_hash, "utf8");
  const presented = Buffer.from(presentedHash, "utf8");
  if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) throw new ContributorInviteError("bad_signature");
  return { inviteId: row.id, tenantId: row.tenant_id, contributorId: row.contributor_id, email: row.email };
}
