// W0-4 — the client-portal invite token: mint, verify, single-use consume.
//
// ── THE ATTACK LIST THIS FILE EXISTS TO CLOSE (published, not implied) ────────────────────────────
// Deliberately modelled on modules/search/google/oauth-state.ts, which solved the same problem class
// for the Google callback. Same estate, same reasoning, same token shape — a second, subtly different
// scheme would be the more dangerous choice.
//
//  A1. Token forgery / tenant pivot — an attacker mints a token naming a tenant they want in.
//      REFUSED BY: the token is `inv1.<b64url(id)>.<b64url(tenantId)>.<b64url(HMAC)>` and the HMAC
//      covers BOTH ids, compared with timingSafeEqual BEFORE any DB read. The tenant is then used for
//      the `withTenants([...])` read, so a signature that verifies still only ever opens the tenant it
//      names.
//  A2. Replay / double-accept — the same link clicked twice (or raced) would otherwise provision two
//      accounts. REFUSED BY: consumption is one atomic
//      `UPDATE … WHERE consumed_at IS NULL RETURNING`; the second presentation matches ZERO rows.
//      Database-enforced, not check-then-act.
//  A3. Stolen-token redemption for a DIFFERENT address — REFUSED BY: the email is bound into the row
//      at issue time and returned by the consume, so the caller provisions THAT address and no other.
//      Nothing in the accept request body is trusted to name the account.
//  A4. Leaked-database redemption — a read of `client_invites` must not yield a usable link.
//      REFUSED BY: only `sha256(rawToken)` is stored; the raw token exists solely in the single
//      response that mints it. (Belt and braces behind the HMAC: the hash is what still refuses a
//      forged token if the signing key were ever compromised.)
//  A5. Indefinite validity — this token grants ACCOUNT CREATION, not merely a read.
//      REFUSED BY: a short TTL enforced INSIDE the consume predicate, not merely by a sweep, so an
//      unpruned row is already unusable.
//  A6. Cross-tenant row read — REFUSED BY: FORCE RLS on client_invites (0072) plus the signed tenant
//      being the only tenant put into `withTenants`.
//
// ── WHY THE TENANT IS IN THE TOKEN AND NOT ONLY IN THE ROW ────────────────────────────────────────
// The accept route is necessarily tenant-agnostic: the person clicking has no session and cannot
// supply `:tenantId`. But `client_invites` is FORCE-RLS tenant-scoped, so a lookup with no tenant GUC
// set matches zero rows — reading the row to discover its own tenant is circular. Hence the tenant
// travels inside the signature. (The W0 spec's first draft said "the tenant travels in the row"; that
// was wrong for exactly this reason.)
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";

import { config } from "../config";
import { newId, withTenants } from "../db";

const TOKEN_PREFIX = "inv1";

export type InviteFailureReason =
  | "malformed_token"
  | "bad_signature"
  | "unknown_or_expired"
  | "not_configured";

/** Coarse to the caller, specific in `reason` server-side. The accept endpoint is effectively
 *  unauthenticated, so distinguishing "no such invite" from "expired" from "already used" would hand a
 *  prober a free oracle — and no legitimate client can act differently on the distinction: all three
 *  mean "ask your PM for a new link". */
export class ClientInviteError extends Error {
  readonly status: number;
  readonly code = "client_invite_invalid";
  constructor(readonly reason: InviteFailureReason) {
    super(
      reason === "not_configured"
        ? "client invites are not configured: INTEGRATION_TOKEN_KEY must be set (it signs the invite token)"
        : "this invitation link is not usable — ask for a new one",
    );
    this.name = "ClientInviteError";
    this.status = reason === "not_configured" ? 503 : 400;
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Derived from the credential-vault key rather than adding a second secret to configure: if that key
 *  is absent nothing could be sealed anyway. Domain-separated by a fixed label so this HMAC key can
 *  never coincide with the AES key's own use — or with the Google OAuth state key, which derives from
 *  the same root under a different label. */
function signingKey(): Buffer {
  const b64 = config.integrationTokenKey;
  if (!b64) throw new ClientInviteError("not_configured");
  return createHmac("sha256", Buffer.from(b64, "base64")).update("gaiada:client-invite:v1").digest();
}

function signingInput(inviteId: string, tenantId: string): string {
  return `${TOKEN_PREFIX}.${b64url(Buffer.from(inviteId, "utf8"))}.${b64url(Buffer.from(tenantId, "utf8"))}`;
}

export function signInviteToken(inviteId: string, tenantId: string): string {
  const input = signingInput(inviteId, tenantId);
  return `${input}.${b64url(createHmac("sha256", signingKey()).update(input).digest())}`;
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export interface ParsedInviteToken {
  inviteId: string;
  tenantId: string;
}

/** Verify + unpack. Throws on anything unusable, BEFORE any database access. */
export function parseInviteToken(token: string): ParsedInviteToken {
  const parts = (token ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) throw new ClientInviteError("malformed_token");
  let inviteId: string;
  let tenantId: string;
  try {
    inviteId = Buffer.from(parts[1], "base64url").toString("utf8");
    tenantId = Buffer.from(parts[2], "base64url").toString("utf8");
  } catch {
    throw new ClientInviteError("malformed_token");
  }
  if (!inviteId || !tenantId) throw new ClientInviteError("malformed_token");
  // Recompute over the CANONICAL re-encoding of the DECODED ids, never over the caller's own first two
  // segments: otherwise a token whose segments decode to the same ids but are spelled differently
  // (padding, alternate alphabet) would present a second valid form of the same invite.
  const expected = createHmac("sha256", signingKey()).update(signingInput(inviteId, tenantId)).digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(parts[3], "base64url");
  } catch {
    throw new ClientInviteError("bad_signature");
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw new ClientInviteError("bad_signature");
  }
  return { inviteId, tenantId };
}

export interface CreateInviteInput {
  tenantId: string;
  clientContactId: string;
  email: string;
  invitedBy: string | null;
}

export interface CreatedInvite {
  inviteId: string;
  /** The RAW token. Returned exactly once, never stored, never logged. */
  token: string;
  expiresAt: string;
}

/** Mint an invite. The caller is responsible for delivering `token` — W0 returns it to the PM to
 *  forward (there is no mail transport in this estate); automated send is a later change that does not
 *  alter this contract. */
export async function createInvite(input: CreateInviteInput, client?: PoolClient): Promise<CreatedInvite> {
  const inviteId = newId();
  const token = signInviteToken(inviteId, input.tenantId);
  const expiresAt = new Date(Date.now() + config.clientInvites.ttlSeconds * 1000).toISOString();
  const email = input.email.trim().toLowerCase();

  const run = async (c: PoolClient): Promise<void> => {
    await c.query(
      `INSERT INTO client_invites
         (id, tenant_id, client_contact_id, email, token_hash, expires_at, invited_by, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [inviteId, input.tenantId, input.clientContactId, email, hashToken(token), expiresAt, input.invitedBy, config.originSite],
    );
  };
  if (client) await run(client);
  else await withTenants([input.tenantId], run);

  return { inviteId, token, expiresAt };
}

export interface ConsumedInvite {
  inviteId: string;
  tenantId: string;
  clientContactId: string;
  /** The address the invite was ISSUED for. Provision this, never anything from the request body. */
  email: string;
}

/** Single-use consume. The atomic `UPDATE … WHERE consumed_at IS NULL AND expires_at > now()
 *  RETURNING` is the whole anti-replay mechanism (A2/A5): one statement, so two concurrent clicks
 *  cannot both win, and an expired row is unusable even if nothing has pruned it.
 *
 *  The token hash is re-compared after the row is claimed. That is not redundant with the HMAC: it is
 *  what still refuses a forged token if the signing key were ever compromised, and it costs one
 *  timingSafeEqual. */
export async function consumeInvite(rawToken: string): Promise<ConsumedInvite> {
  const { inviteId, tenantId } = parseInviteToken(rawToken);
  const presentedHash = hashToken(rawToken);

  const row = await withTenants([tenantId], async (c: PoolClient) => {
    const res = await c.query<{
      id: string;
      tenant_id: string;
      client_contact_id: string;
      email: string;
      token_hash: string;
    }>(
      `UPDATE client_invites
          SET consumed_at = now()
        WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING id, tenant_id, client_contact_id, email, token_hash`,
      [inviteId],
    );
    return res.rows[0] ?? null;
  });

  if (!row) throw new ClientInviteError("unknown_or_expired");

  const stored = Buffer.from(row.token_hash, "utf8");
  const presented = Buffer.from(presentedHash, "utf8");
  if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) {
    // The row is already spent — deliberately. A token fed into a failing accept attempt is exactly
    // the token an attacker would want to retry, so spending it is the safe direction (the same
    // ordering choice oauth-state.ts documents).
    throw new ClientInviteError("bad_signature");
  }

  return {
    inviteId: row.id,
    tenantId: row.tenant_id,
    clientContactId: row.client_contact_id,
    email: row.email,
  };
}

/** Housekeeping only: the consume predicate already refuses expired rows (A5). This just stops spent
 *  and dead invites accumulating. Returns rows removed. */
export async function pruneExpiredInvites(tenantId: string): Promise<number> {
  const res = await withTenants([tenantId], (c) =>
    c.query(`DELETE FROM client_invites WHERE consumed_at IS NULL AND expires_at <= now()`),
  );
  return res.rowCount ?? 0;
}

/** A URL-safe random password used when a contact does not choose one on the accept screen. */
export function generatePassword(): string {
  return `Ga-${b64url(randomBytes(18))}`;
}
