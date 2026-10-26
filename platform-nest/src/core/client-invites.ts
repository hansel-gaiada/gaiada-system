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
// ── PGL-10 (PV-D47): TOKEN v2, AND WHY A4's "BELT AND BRACES" WAS NOT TRUE BEFORE IT ─────────────────
// The v1 token `inv1.<id>.<tenant>.<HMAC(id,tenant)>` has NO random part: it is a pure function of the
// row's id, its tenant and the signing key. So a database read PLUS the key could rebuild every open
// link, and the stored hash refused nothing the key could not already forge. The A4 claim above ("the
// hash still refuses a forged token if the signing key were compromised") was false for v1.
// v2 adds 16 random bytes: `inv2.<id>.<tenant>.<nonce>.<HMAC(id,tenant,nonce)>`. The nonce is never
// stored, only `sha256(token)` is, so now a leaked database AND a leaked key together still cannot
// produce a usable link. It is also what makes "mint a FRESH token at send time" mean something: the
// mail sender (src/mail/invite-mail.ts) mints a new nonce per send attempt and overwrites the stored
// hash, so only the latest minted link is live.
// v1 tokens are still ACCEPTED for one release (invites issued before PGL-10 live up to the TTL); nothing
// mints v1 any more. Removal: the release after PGL-10 drops `LEGACY_TOKEN_PREFIX` from the parser.
//
// ── PGL-10: THE HASH IS PART OF THE CLAIM ───────────────────────────────────────────────────────────────
// The consume now claims `WHERE id = $1 AND token_hash = $2 AND …`. Before, it claimed by id and compared
// the hash afterwards, spending the row on a mismatch. With send-time re-minting a mismatch is a NORMAL
// event (a link from an earlier, failed send attempt; a link superseded by a resend), and spending the row
// on it would let a stale link burn the live one. A stale or forged token now simply matches no row.
//
// ── PGL-10: THE "SEALED" STATE ──────────────────────────────────────────────────────────────────────────
// A mail invite is created with `delivery = 'mail'` and a SEALED hash: sha256 of 32 random bytes that are
// thrown away at once. No token can match it, so the invite is unusable until the sender mints the real
// token at the moment it composes the mail. Between send attempts the sender re-seals it.
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

const TOKEN_PREFIX = "inv2";
/** Accepted, never minted (see the header). Remove one release after PGL-10. */
const LEGACY_TOKEN_PREFIX = "inv1";
const NONCE_BYTES = 16;

export type InviteDelivery = "link" | "mail";

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

function legacySigningInput(inviteId: string, tenantId: string): string {
  return `${LEGACY_TOKEN_PREFIX}.${b64url(Buffer.from(inviteId, "utf8"))}.${b64url(Buffer.from(tenantId, "utf8"))}`;
}

function signingInput(inviteId: string, tenantId: string, nonce: Buffer): string {
  return `${TOKEN_PREFIX}.${b64url(Buffer.from(inviteId, "utf8"))}.${b64url(Buffer.from(tenantId, "utf8"))}.${b64url(nonce)}`;
}

/** Mint a v2 token. Every call draws a fresh nonce, so two calls for one invite give two different tokens;
 *  only the one whose hash is stored on the row is usable. `nonce` is a test seam only. */
export function signInviteToken(inviteId: string, tenantId: string, nonce: Buffer = randomBytes(NONCE_BYTES)): string {
  const input = signingInput(inviteId, tenantId, nonce);
  return `${input}.${b64url(createHmac("sha256", signingKey()).update(input).digest())}`;
}

/** The pre-PGL-10 v1 shape, for tests of the one-release compatibility path only. Nothing mints this. */
export function signLegacyInviteToken(inviteId: string, tenantId: string): string {
  const input = legacySigningInput(inviteId, tenantId);
  return `${input}.${b64url(createHmac("sha256", signingKey()).update(input).digest())}`;
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** A hash no token can match: sha256 of 32 random bytes that are discarded here. It has the same shape as a
 *  real hash (64 hex characters, unique), so `token_hash NOT NULL UNIQUE` holds and nothing can tell a sealed
 *  invite from an open one by reading the column. */
function sealedHash(): string {
  return hashToken(`sealed:${b64url(randomBytes(32))}`);
}

export interface ParsedInviteToken {
  inviteId: string;
  tenantId: string;
}

/** Verify + unpack. Throws on anything unusable, BEFORE any database access. */
export function parseInviteToken(token: string): ParsedInviteToken {
  const parts = (token ?? "").split(".");
  const v2 = parts.length === 5 && parts[0] === TOKEN_PREFIX;
  const v1 = parts.length === 4 && parts[0] === LEGACY_TOKEN_PREFIX;
  if (!v2 && !v1) throw new ClientInviteError("malformed_token");
  let inviteId: string;
  let tenantId: string;
  let nonce: Buffer | null = null;
  try {
    inviteId = Buffer.from(parts[1], "base64url").toString("utf8");
    tenantId = Buffer.from(parts[2], "base64url").toString("utf8");
    if (v2) nonce = Buffer.from(parts[3], "base64url");
  } catch {
    throw new ClientInviteError("malformed_token");
  }
  if (!inviteId || !tenantId) throw new ClientInviteError("malformed_token");
  if (v2 && nonce?.length !== NONCE_BYTES) throw new ClientInviteError("malformed_token");
  // Recompute over the CANONICAL re-encoding of the DECODED values, never over the caller's own segments:
  // otherwise a token whose segments decode to the same values but are spelled differently (padding,
  // alternate alphabet) would present a second valid form of the same invite.
  const input = v2 ? signingInput(inviteId, tenantId, nonce as Buffer) : legacySigningInput(inviteId, tenantId);
  const expected = createHmac("sha256", signingKey()).update(input).digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(parts[v2 ? 4 : 3], "base64url");
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

async function insertInvite(
  inviteId: string,
  input: CreateInviteInput,
  delivery: InviteDelivery,
  tokenHash: string,
  client?: PoolClient,
): Promise<string> {
  const expiresAt = new Date(Date.now() + config.clientInvites.ttlSeconds * 1000).toISOString();
  const email = input.email.trim().toLowerCase();
  const run = async (c: PoolClient): Promise<void> => {
    await c.query(
      `INSERT INTO client_invites
         (id, tenant_id, client_contact_id, email, token_hash, expires_at, invited_by, origin_site, delivery)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [inviteId, input.tenantId, input.clientContactId, email, tokenHash, expiresAt, input.invitedBy, config.originSite, delivery],
    );
  };
  if (client) await run(client);
  else await withTenants([input.tenantId], run);
  return expiresAt;
}

/** Mint a HAND-FORWARDED invite (`delivery = 'link'`). The caller delivers `token`: the invite route returns
 *  it to the PM to forward, exactly once. */
export async function createInvite(input: CreateInviteInput, client?: PoolClient): Promise<CreatedInvite> {
  const inviteId = newId();
  const token = signInviteToken(inviteId, input.tenantId);
  const expiresAt = await insertInvite(inviteId, input, "link", hashToken(token), client);
  return { inviteId, token, expiresAt };
}

/** PGL-10: create a MAIL invite (`delivery = 'mail'`), SEALED. No token exists yet and none is returned: the
 *  mail sender mints it when it composes the mail (`mintMailInviteToken`). */
export async function createMailInvite(
  input: CreateInviteInput,
  client?: PoolClient,
): Promise<{ inviteId: string; expiresAt: string }> {
  const inviteId = newId();
  const expiresAt = await insertInvite(inviteId, input, "mail", sealedHash(), client);
  return { inviteId, expiresAt };
}

/** PGL-10: "a resend issues a new token and invalidates the old one." Spends every open invite of a contact.
 *  Called by the invite route before it creates the new invite, in the same transaction, so a contact has at
 *  most ONE open invite at any moment (and a queued mail for a spent invite is dropped by the sender). */
export async function spendOpenInvites(c: PoolClient, clientContactId: string): Promise<number> {
  const r = await c.query(
    `UPDATE client_invites SET consumed_at = now() WHERE client_contact_id = $1 AND consumed_at IS NULL`,
    [clientContactId],
  );
  return r.rowCount ?? 0;
}

export interface MintedMailToken {
  /** The RAW token: for the outgoing message only. Never assigned to anything that is stored or logged. */
  token: string;
  tokenHash: string;
  email: string;
  expiresAt: string;
}

/** PGL-10, the send-time mint. ONE atomic UPDATE: a fresh token's hash replaces whatever the row held (sealed,
 *  or the hash of an earlier attempt's token, which therefore dies), and only for an invite that is still
 *  usable: delivery 'mail', unspent, unexpired, its contact still 'invited', and bound to the address the mail
 *  is going to. Anything else returns null and the sender drops the mail. Never touches a 'link' invite, so a
 *  stray mail row can never rotate a hand-forwarded link out from under a PM. */
export async function mintMailInviteToken(
  tenantId: string,
  inviteId: string,
  toEmail: string,
): Promise<MintedMailToken | null> {
  const token = signInviteToken(inviteId, tenantId);
  const tokenHash = hashToken(token);
  const row = await withTenants([tenantId], async (c) => {
    const r = await c.query<{ email: string; expires_at: Date | string }>(
      `UPDATE client_invites ci
          SET token_hash = $2
        WHERE ci.id = $1 AND ci.delivery = 'mail' AND ci.consumed_at IS NULL AND ci.expires_at > now()
          AND ci.email = $3
          AND EXISTS (SELECT 1 FROM client_contacts cc
                       WHERE cc.id = ci.client_contact_id AND cc.status = 'invited' AND cc.deleted_at IS NULL)
        RETURNING ci.email, ci.expires_at`,
      [inviteId, tokenHash, toEmail.trim().toLowerCase()],
    );
    return r.rows[0] ?? null;
  });
  if (!row) return null;
  return { token, tokenHash, email: row.email, expiresAt: new Date(row.expires_at).toISOString() };
}

/** PGL-10: after a failed send attempt, seal the invite again, so the token that attempt carried (and that may or
 *  may not have reached anyone) is dead. Only if the row still holds THAT token's hash. */
export async function resealMailInvite(tenantId: string, inviteId: string, mintedHash: string): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `UPDATE client_invites SET token_hash = $3 WHERE id = $1 AND delivery = 'mail' AND token_hash = $2`,
      [inviteId, mintedHash, sealedHash()],
    ),
  );
}

/** PGL-10: the route could not hand the invite to the mail queue (the address is suppressed, or the enqueue
 *  failed), so it falls back to today's hand-forwarded link: the SAME sealed invite becomes a 'link' invite with
 *  a real token, returned to the PM once. Converting it (rather than leaving it 'mail') means no mail row can
 *  ever re-mint it later. Null if the invite is no longer open. */
export async function convertMailInviteToLink(tenantId: string, inviteId: string): Promise<string | null> {
  const token = signInviteToken(inviteId, tenantId);
  const r = await withTenants([tenantId], (c) =>
    c.query(
      `UPDATE client_invites SET delivery = 'link', token_hash = $2
        WHERE id = $1 AND delivery = 'mail' AND consumed_at IS NULL AND expires_at > now()`,
      [inviteId, hashToken(token)],
    ),
  );
  return r.rowCount ? token : null;
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
        WHERE id = $1 AND token_hash = $2 AND consumed_at IS NULL AND expires_at > now()
        RETURNING id, tenant_id, client_contact_id, email, token_hash`,
      [inviteId, presentedHash],
    );
    return res.rows[0] ?? null;
  });

  // PGL-10: the hash is in the claim predicate (see the header), so a superseded, stale, sealed or forged token
  // matches no row and spends nothing: one coarse reason, the same as unknown, expired and already used.
  if (!row) throw new ClientInviteError("unknown_or_expired");

  // Belt and braces only: the predicate above already required equality.
  const stored = Buffer.from(row.token_hash, "utf8");
  const presented = Buffer.from(presentedHash, "utf8");
  if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) {
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
