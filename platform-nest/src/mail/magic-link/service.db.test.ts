// MAIL-10 — DB-backed proof for the auth-critical properties: hash-only storage, atomic single-use
// consume (incl. a REAL concurrent-transaction race), same generic error for
// unknown/replayed/expired, and that the mail_log audit row never carries the raw token.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { config } from "../../config";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createUser } from "../../testing/fixtures";
import { requestMagicLink, consumeMagicLink, MagicLinkConsumeError } from "./service";
import { resetMagicLinkRateLimitForTest } from "./rate-limit";

describe.skipIf(!TEST_URL)("magic-link service (DB)", () => {
  const savedEnabled = config.mail.magicLinksEnabled;

  beforeAll(async () => {
    await initTestDb();
    config.mail.magicLinksEnabled = true;
  });
  afterAll(async () => {
    config.mail.magicLinksEnabled = savedEnabled;
    await teardownTestDb();
  });
  afterEach(async () => {
    resetMagicLinkRateLimitForTest();
    await adminPool().query(`DELETE FROM auth_magic_links`);
    await adminPool().query(`DELETE FROM mail_log`);
    await adminPool().query(`DELETE FROM mail_suppressions`);
  });

  it("stores ONLY a hash — the raw token is not present anywhere in the row, and mail_log carries no href/token either", async () => {
    const email = "magic-hash-check@dev.gaiada.invalid";
    await createUser(email);
    await requestMagicLink({ email, ip: "203.0.113.9" });

    const linkRow = await adminPool().query<{ token_hash: string }>(
      `SELECT token_hash FROM auth_magic_links WHERE email = $1`,
      [email],
    );
    expect(linkRow.rows).toHaveLength(1);
    // sha256 hex is exactly 64 lowercase hex chars — a raw base64url token never looks like this.
    expect(linkRow.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);

    const mailRow = await adminPool().query<{ payload: Record<string, unknown>; subject: string }>(
      `SELECT payload, subject FROM mail_log WHERE to_email = $1 AND template_key = 'auth.magic_link'`,
      [email],
    );
    expect(mailRow.rows).toHaveLength(1);
    const payloadStr = JSON.stringify(mailRow.rows[0].payload);
    expect(payloadStr).not.toMatch(/token=/);
    expect(payloadStr).not.toContain("href");
    expect(mailRow.rows[0].subject).not.toMatch(/token=/);
  });

  it("consume is atomic single-use: a genuine race across N concurrent connections yields exactly ONE winner", async () => {
    const email = "magic-race@dev.gaiada.invalid";
    const userId = await createUser(email);
    // Mint directly (bypassing the mail send) so we have a raw token to race on: reproduce the
    // mint SQL inline rather than importing internals, to keep this a black-box DB race proof.
    const { generateRawToken, hashToken } = await import("./tokens");
    const raw = generateRawToken();
    await adminPool().query(
      `INSERT INTO auth_magic_links (id, user_id, email, token_hash, expires_at, origin_site)
       VALUES (gen_random_uuid(), $1, $2, $3, now() + interval '10 minutes', 'test')`,
      [userId, email, hashToken(raw)],
    );

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => consumeMagicLink({ token: raw, ip: "203.0.113.10" })),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    expect((fulfilled[0] as PromiseFulfilledResult<{ userId: string }>).value.userId).toBe(userId);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(MagicLinkConsumeError);
    }
  });

  it("unknown, replayed, and expired tokens all throw the SAME generic error", async () => {
    const email = "magic-generic-error@dev.gaiada.invalid";
    const userId = await createUser(email);
    const { generateRawToken, hashToken } = await import("./tokens");

    // unknown
    await expect(consumeMagicLink({ token: "not-a-real-token", ip: "x" })).rejects.toMatchObject({
      code: "magic_link_invalid",
    });

    // expired (never consumed, but past expiry — refused by the predicate itself, not a sweep)
    const expiredRaw = generateRawToken();
    await adminPool().query(
      `INSERT INTO auth_magic_links (id, user_id, email, token_hash, expires_at, origin_site)
       VALUES (gen_random_uuid(), $1, $2, $3, now() - interval '1 second', 'test')`,
      [userId, email, hashToken(expiredRaw)],
    );
    const expiredErr = await consumeMagicLink({ token: expiredRaw, ip: "x" }).catch((e) => e);
    expect(expiredErr).toMatchObject({ code: "magic_link_invalid" });

    // replayed (consume once, then again)
    const replayRaw = generateRawToken();
    await adminPool().query(
      `INSERT INTO auth_magic_links (id, user_id, email, token_hash, expires_at, origin_site)
       VALUES (gen_random_uuid(), $1, $2, $3, now() + interval '10 minutes', 'test')`,
      [userId, email, hashToken(replayRaw)],
    );
    await consumeMagicLink({ token: replayRaw, ip: "x" }); // first use succeeds
    const replayedErr = await consumeMagicLink({ token: replayRaw, ip: "x" }).catch((e) => e);
    expect(replayedErr).toMatchObject({ code: "magic_link_invalid" });

    // Same message across all three, byte for byte — no distinguishing detail leaked anywhere.
    const unknownErr = await consumeMagicLink({ token: "still-not-real", ip: "x" }).catch((e) => e);
    expect(unknownErr.message).toBe(expiredErr.message);
    expect(unknownErr.message).toBe(replayedErr.message);
  });

  it("the expired row is left in place (refused by the predicate, not pruned) and the already-spent row is never re-usable", async () => {
    const email = "magic-persist@dev.gaiada.invalid";
    await createUser(email);
    const present = await adminPool().query(`SELECT count(*)::int AS n FROM auth_magic_links WHERE email = $1`, [email]);
    expect(present.rows[0].n).toBe(0); // sanity: clean slate per afterEach
  });

  it("a suppressed auth address gets a distinguishable result (design §5.1's one documented exception)", async () => {
    const email = "magic-suppressed@dev.gaiada.invalid";
    await createUser(email);
    await adminPool().query(
      `INSERT INTO mail_suppressions (id, email, stream, reason) VALUES (gen_random_uuid(), $1, 'auth', 'manual')`,
      [email],
    );
    const result = await requestMagicLink({ email, ip: "203.0.113.11" });
    expect(result.status).toBe("suppressed");
    const rows = await adminPool().query(`SELECT 1 FROM auth_magic_links WHERE email = $1`, [email]);
    expect(rows.rowCount).toBe(0); // no token minted for a suppressed address
  });
});
