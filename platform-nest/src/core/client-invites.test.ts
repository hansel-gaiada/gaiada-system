// W0-4 — the invite token's security properties, against live PG + RLS.
//
// This file exists to hold the SIX refusals client-invites.ts publishes in its header. Each one is a
// named authorization-code-style attack, and each is cheap to break by accident later: a "tidy" that
// drops the canonical re-encoding, an "optimisation" that turns the atomic consume into
// check-then-act, a "helpful" error message that distinguishes expired from unknown.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../config";
import { newId, withTenants } from "../db";
import {
  createInvite,
  consumeInvite,
  parseInviteToken,
  signInviteToken,
  hashToken,
  pruneExpiredInvites,
  ClientInviteError,
  createMailInvite,
  mintMailInviteToken,
  resealMailInvite,
  convertMailInviteToLink,
  spendOpenInvites,
  signLegacyInviteToken,
} from "./client-invites";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createClient } from "../testing/fixtures";

async function contactFor(tenantId: string, clientId: string, userId: string): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site)
       VALUES ($1, $2, $3, $4, 'signer', 'invited', $5)`,
      [id, tenantId, clientId, userId, config.originSite],
    ),
  );
  return id;
}

describe.skipIf(!TEST_URL)("W0: client invite tokens", () => {
  let co: string;
  let other: string;
  let clientRow: string;
  let contactId: string;
  let userId: string;

  beforeAll(async () => {
    await initTestDb();
    // The token HMAC derives from the credential-vault key; without it every mint/verify is a 503.
    if (!config.integrationTokenKey) config.integrationTokenKey = Buffer.alloc(32, 7).toString("base64");
    co = await createCompany("Gaiada Creative");
    other = await createCompany("Rival Co");
    userId = await createUser("contact@client.test");
    clientRow = await createClient(co, "Bali Beach Resort");
    contactId = await contactFor(co, clientRow, userId);
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  // ONE contact for the whole suite. The first draft re-created it per test and 0072's
  // client_contacts_clientwide_uniq refused the duplicate — the constraint catching my own fixture is
  // the constraint working. Several invites for one contact are legitimate, which is all these need.

  // ---- happy path ----

  it("mints a token that verifies and consumes exactly once, returning the ISSUED email", async () => {
    const { token } = await createInvite({ tenantId: co, clientContactId: contactId, email: "Contact@Client.Test", invitedBy: null });
    const used = await consumeInvite(token);
    expect(used.tenantId).toBe(co);
    expect(used.clientContactId).toBe(contactId);
    // Lower-cased at issue, and it is the ROW's email that comes back — the accept path must provision
    // this address, never one supplied in a request body (A3).
    expect(used.email).toBe("contact@client.test");
  });

  it("never stores the raw token — only its sha256", async () => {
    const { token, inviteId } = await createInvite({ tenantId: co, clientContactId: contactId, email: "a@b.test", invitedBy: null });
    const row = await adminPool().query<{ token_hash: string }>(`SELECT token_hash FROM client_invites WHERE id = $1`, [inviteId]);
    expect(row.rows[0].token_hash).toBe(hashToken(token));
    expect(row.rows[0].token_hash).not.toBe(token);
    // A database read must not yield a usable link (A4).
    expect(row.rows[0].token_hash).not.toContain("inv1.");
    expect(row.rows[0].token_hash).not.toContain("inv2.");
  });

  // ---- A1: forgery / tenant pivot ----

  it("refuses a token signed with the wrong key", async () => {
    const { inviteId } = await createInvite({ tenantId: co, clientContactId: contactId, email: "a@b.test", invitedBy: null });
    const saved = config.integrationTokenKey;
    config.integrationTokenKey = Buffer.alloc(32, 9).toString("base64"); // attacker's key
    const forged = signInviteToken(inviteId, co);
    config.integrationTokenKey = saved;
    await expect(consumeInvite(forged)).rejects.toMatchObject({ reason: "bad_signature" });
  });

  it("refuses a token whose TENANT segment has been swapped (the pivot attempt)", async () => {
    const { token, inviteId } = await createInvite({ tenantId: co, clientContactId: contactId, email: "a@b.test", invitedBy: null });
    const parts = token.split(".");
    // PGL-10: a v2 token is five segments (prefix, id, tenant, nonce, HMAC); only the tenant is swapped.
    expect(parts).toHaveLength(5);
    const swapped = [parts[0], parts[1], Buffer.from(other, "utf8").toString("base64url"), parts[3], parts[4]].join(".");
    await expect(consumeInvite(swapped)).rejects.toMatchObject({ reason: "bad_signature" });
    // …and the original invite is untouched, so a failed pivot does not deny the real contact.
    const still = await adminPool().query(`SELECT consumed_at FROM client_invites WHERE id = $1`, [inviteId]);
    expect(still.rows[0].consumed_at).toBeNull();
  });

  it("rejects a re-spelled but equivalent encoding (canonical re-encoding, not the caller's bytes)", async () => {
    const { token: good, inviteId } = await createInvite({ tenantId: co, clientContactId: contactId, email: "a@b.test", invitedBy: null });
    const parts = good.split(".");
    // Padded base64 decodes to the same id but is a different spelling. Verifying over the caller's own
    // segments (rather than a canonical re-encode) would accept this as a SECOND valid form of one invite.
    const padded = [parts[0], `${parts[1]}==`, parts[2], parts[3], parts[4]].join(".");
    await expect(consumeInvite(padded)).rejects.toBeInstanceOf(ClientInviteError);
    // PGL-10: the hash is in the claim predicate, so the refused re-spelling spent nothing and the real link still works.
    const still = await adminPool().query(`SELECT consumed_at FROM client_invites WHERE id = $1`, [inviteId]);
    expect(still.rows[0].consumed_at).toBeNull();
    await expect(consumeInvite(good)).resolves.toMatchObject({ tenantId: co });
  });

  it.each([["nonsense"], ["inv1.a.b"], ["inv2.a.b.c"], ["inv2.a.b.c.d.e"], [""], ["....."]])("refuses malformed token %s", async (bad) => {
    await expect(consumeInvite(bad)).rejects.toBeInstanceOf(ClientInviteError);
  });

  it("verifies the signature BEFORE touching the database", async () => {
    // A forged token must cost nothing: parse throws with no query, which is what keeps the accept
    // endpoint from being a database-load amplifier for an unauthenticated caller.
    expect(() => parseInviteToken("inv1.zzz.zzz.zzz")).toThrow(ClientInviteError);
  });

  // ---- A2: replay ----

  it("is SINGLE USE — a second accept of the same link is refused", async () => {
    const { token } = await createInvite({ tenantId: co, clientContactId: contactId, email: "a@b.test", invitedBy: null });
    await expect(consumeInvite(token)).resolves.toMatchObject({ tenantId: co });
    await expect(consumeInvite(token)).rejects.toMatchObject({ reason: "unknown_or_expired" });
  });

  it("survives a genuine race: N concurrent accepts yield exactly ONE winner", async () => {
    // The whole anti-replay mechanism is one atomic UPDATE … WHERE consumed_at IS NULL RETURNING. A
    // check-then-act rewrite would pass the sequential test above and fail this one — which is the only
    // reason this test exists.
    const { token } = await createInvite({ tenantId: co, clientContactId: contactId, email: "a@b.test", invitedBy: null });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => consumeInvite(token)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(7);
  });

  // ---- A5: expiry ----

  it("refuses an expired invite, enforced in the CONSUME predicate not by a sweep", async () => {
    const { token, inviteId } = await createInvite({ tenantId: co, clientContactId: contactId, email: "a@b.test", invitedBy: null });
    await adminPool().query(`UPDATE client_invites SET expires_at = now() - interval '1 second' WHERE id = $1`, [inviteId]);
    // Nothing has pruned the row — it must already be unusable.
    await expect(consumeInvite(token)).rejects.toMatchObject({ reason: "unknown_or_expired" });
    const present = await adminPool().query(`SELECT 1 FROM client_invites WHERE id = $1`, [inviteId]);
    expect(present.rowCount).toBe(1);
  });

  it("honours the configured TTL", async () => {
    const saved = config.clientInvites.ttlSeconds;
    config.clientInvites.ttlSeconds = 3600;
    const { expiresAt } = await createInvite({ tenantId: co, clientContactId: contactId, email: "a@b.test", invitedBy: null });
    const delta = Date.parse(expiresAt) - Date.now();
    expect(delta).toBeGreaterThan(3_000_000);
    expect(delta).toBeLessThan(3_700_000);
    config.clientInvites.ttlSeconds = saved;
  });

  it("prune removes only expired-and-unconsumed rows", async () => {
    const live = await createInvite({ tenantId: co, clientContactId: contactId, email: "live@b.test", invitedBy: null });
    const dead = await createInvite({ tenantId: co, clientContactId: contactId, email: "dead@b.test", invitedBy: null });
    await adminPool().query(`UPDATE client_invites SET expires_at = now() - interval '1 day' WHERE id = $1`, [dead.inviteId]);
    const removed = await pruneExpiredInvites(co);
    expect(removed).toBeGreaterThanOrEqual(1);
    const l = await adminPool().query(`SELECT 1 FROM client_invites WHERE id = $1`, [live.inviteId]);
    const d = await adminPool().query(`SELECT 1 FROM client_invites WHERE id = $1`, [dead.inviteId]);
    expect(l.rowCount).toBe(1);
    expect(d.rowCount).toBe(0);
  });

  // ---- A6 + no-oracle ----

  it("gives ONE coarse reason for unknown / expired / already-used (no probing oracle)", async () => {
    const { token } = await createInvite({ tenantId: co, clientContactId: contactId, email: "a@b.test", invitedBy: null });
    await consumeInvite(token);
    const failure = async (t: string): Promise<ClientInviteError> => {
      try {
        await consumeInvite(t);
        throw new Error("expected the consume to be refused");
      } catch (e) {
        return e as ClientInviteError;
      }
    };
    const used = await failure(token);
    const ghost = await failure(signInviteToken(newId(), co));
    // Same status and same client-facing message: the accept route is effectively unauthenticated, so
    // telling a prober "that invite exists but is spent" would be a free existence oracle.
    expect(used.status).toBe(ghost.status);
    expect(used.message).toBe(ghost.message);
    expect(used.reason).toBe("unknown_or_expired");
    expect(ghost.reason).toBe("unknown_or_expired");
  });

  it("client_invites is tenant-isolated — a rival tenant reads nothing", async () => {
    await createInvite({ tenantId: co, clientContactId: contactId, email: "a@b.test", invitedBy: null });
    const rows = await withTenants([other], (c) => c.query(`SELECT id FROM client_invites`));
    expect(rows.rowCount).toBe(0);
  });

  it("is a 503, not a 400, when the signing key is absent (deployment state, not a caller error)", async () => {
    const saved = config.integrationTokenKey;
    config.integrationTokenKey = "";
    try {
      await expect(
        createInvite({ tenantId: co, clientContactId: contactId, email: "a@b.test", invitedBy: null }),
      ).rejects.toMatchObject({ status: 503, reason: "not_configured" });
    } finally {
      config.integrationTokenKey = saved;
    }
  });

  // ---- PGL-10: token v2, the sealed mail invite, the send-time mint ----

  it("PGL-10: a v2 token has a random part, so two mints for ONE invite differ (v1 was a pure function of id + tenant + key)", async () => {
    const id = newId();
    const a = signInviteToken(id, co);
    const b = signInviteToken(id, co);
    expect(a.startsWith("inv2.")).toBe(true);
    expect(a.split(".")).toHaveLength(5);
    expect(a).not.toBe(b);
    expect(signLegacyInviteToken(id, co)).toBe(signLegacyInviteToken(id, co));
  });

  it("PGL-10: a v1 (legacy) token whose hash is stored still consumes, for invites issued before this release", async () => {
    const inviteId = newId();
    const legacy = signLegacyInviteToken(inviteId, co);
    await adminPool().query(
      `INSERT INTO client_invites (id, tenant_id, client_contact_id, email, token_hash, expires_at, origin_site)
       VALUES ($1, $2, $3, 'legacy@b.test', $4, now() + interval '1 hour', $5)`,
      [inviteId, co, contactId, hashToken(legacy), config.originSite],
    );
    await expect(consumeInvite(legacy)).resolves.toMatchObject({ inviteId, email: "legacy@b.test" });
  });

  it("PGL-10: a stale token for an open invite (a superseded mint) spends NOTHING; the live one still works", async () => {
    const { token, inviteId } = await createInvite({ tenantId: co, clientContactId: contactId, email: "a@b.test", invitedBy: null });
    const stale = signInviteToken(inviteId, co); // validly signed, not the stored one
    await expect(consumeInvite(stale)).rejects.toMatchObject({ reason: "unknown_or_expired" });
    const still = await adminPool().query(`SELECT consumed_at FROM client_invites WHERE id = $1`, [inviteId]);
    expect(still.rows[0].consumed_at).toBeNull();
    await expect(consumeInvite(token)).resolves.toMatchObject({ inviteId });
  });

  it("PGL-10: a MAIL invite is born sealed: delivery 'mail', no token returned, and no token can open it", async () => {
    const created = await createMailInvite({ tenantId: co, clientContactId: contactId, email: "Mail@B.Test", invitedBy: null });
    expect(Object.keys(created).sort()).toEqual(["expiresAt", "inviteId"]);
    const row = await adminPool().query(`SELECT delivery, token_hash, email FROM client_invites WHERE id = $1`, [created.inviteId]);
    expect(row.rows[0]).toMatchObject({ delivery: "mail", email: "mail@b.test" });
    expect(row.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    await expect(consumeInvite(signInviteToken(created.inviteId, co))).rejects.toMatchObject({ reason: "unknown_or_expired" });
  });

  it("PGL-10: the send-time mint makes exactly the minted token usable, once; a second mint kills the first", async () => {
    const { inviteId } = await createMailInvite({ tenantId: co, clientContactId: contactId, email: "mint@b.test", invitedBy: null });
    const first = await mintMailInviteToken(co, inviteId, "MINT@b.test");
    const second = await mintMailInviteToken(co, inviteId, "mint@b.test");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.token).not.toBe(second!.token);
    const stored = await adminPool().query(`SELECT token_hash FROM client_invites WHERE id = $1`, [inviteId]);
    expect(stored.rows[0].token_hash).toBe(hashToken(second!.token));
    await expect(consumeInvite(first!.token)).rejects.toMatchObject({ reason: "unknown_or_expired" });
    await expect(consumeInvite(second!.token)).resolves.toMatchObject({ inviteId, email: "mint@b.test" });
    await expect(consumeInvite(second!.token)).rejects.toMatchObject({ reason: "unknown_or_expired" });
    expect(await mintMailInviteToken(co, inviteId, "mint@b.test")).toBeNull(); // spent: nothing more can be minted
  });

  it("PGL-10: the mint refuses a LINK invite, another address, an expired invite, a non-invited contact and another tenant", async () => {
    const link = await createInvite({ tenantId: co, clientContactId: contactId, email: "link@b.test", invitedBy: null });
    expect(await mintMailInviteToken(co, link.inviteId, "link@b.test")).toBeNull();
    await expect(consumeInvite(link.token)).resolves.toMatchObject({ inviteId: link.inviteId }); // untouched

    const bound = await createMailInvite({ tenantId: co, clientContactId: contactId, email: "bound@b.test", invitedBy: null });
    expect(await mintMailInviteToken(co, bound.inviteId, "someone-else@b.test")).toBeNull();
    // Another tenant cannot mint it at all: under RLS the row is not there.
    expect(await mintMailInviteToken(other, bound.inviteId, "bound@b.test")).toBeNull();

    const old = await createMailInvite({ tenantId: co, clientContactId: contactId, email: "old@b.test", invitedBy: null });
    await adminPool().query(`UPDATE client_invites SET expires_at = now() - interval '1 second' WHERE id = $1`, [old.inviteId]);
    expect(await mintMailInviteToken(co, old.inviteId, "old@b.test")).toBeNull();

    const revokedUser = await createUser("revoked-mint@client.test");
    const revokedContact = await contactFor(co, clientRow, revokedUser);
    const r = await createMailInvite({ tenantId: co, clientContactId: revokedContact, email: "revoked-mint@client.test", invitedBy: null });
    await adminPool().query(`UPDATE client_contacts SET status = 'revoked' WHERE id = $1`, [revokedContact]);
    expect(await mintMailInviteToken(co, r.inviteId, "revoked-mint@client.test")).toBeNull();
  });

  it("PGL-10: re-sealing after a failed send kills that attempt's token, and only if it is still the stored one", async () => {
    const { inviteId } = await createMailInvite({ tenantId: co, clientContactId: contactId, email: "reseal@b.test", invitedBy: null });
    const attempt = await mintMailInviteToken(co, inviteId, "reseal@b.test");
    await resealMailInvite(co, inviteId, attempt!.tokenHash);
    await expect(consumeInvite(attempt!.token)).rejects.toMatchObject({ reason: "unknown_or_expired" });
    const next = await mintMailInviteToken(co, inviteId, "reseal@b.test");
    await resealMailInvite(co, inviteId, attempt!.tokenHash); // a stale hash: a no-op
    await expect(consumeInvite(next!.token)).resolves.toMatchObject({ inviteId });
  });

  it("PGL-10: the route's fallback turns a sealed mail invite into a usable LINK invite that no mail can re-mint", async () => {
    const { inviteId } = await createMailInvite({ tenantId: co, clientContactId: contactId, email: "fallback@b.test", invitedBy: null });
    const token = await convertMailInviteToLink(co, inviteId);
    expect(token).toBeTruthy();
    expect(await mintMailInviteToken(co, inviteId, "fallback@b.test")).toBeNull();
    const row = await adminPool().query(`SELECT delivery FROM client_invites WHERE id = $1`, [inviteId]);
    expect(row.rows[0].delivery).toBe("link");
    await expect(consumeInvite(token!)).resolves.toMatchObject({ inviteId });
  });

  it("PGL-10: spendOpenInvites spends every open invite of the contact (a resend invalidates the old link)", async () => {
    const u = await createUser("resend-spend@client.test");
    const cid = await contactFor(co, clientRow, u);
    const a = await createInvite({ tenantId: co, clientContactId: cid, email: "resend-spend@client.test", invitedBy: null });
    const b = await createMailInvite({ tenantId: co, clientContactId: cid, email: "resend-spend@client.test", invitedBy: null });
    const n = await withTenants([co], (c) => spendOpenInvites(c, cid));
    expect(n).toBe(2);
    await expect(consumeInvite(a.token)).rejects.toMatchObject({ reason: "unknown_or_expired" });
    expect(await mintMailInviteToken(co, b.inviteId, "resend-spend@client.test")).toBeNull();
  });
});
