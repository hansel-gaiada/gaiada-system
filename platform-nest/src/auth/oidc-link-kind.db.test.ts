// PV5-10 review — an IdP login may claim (link to) only a HUMAN account. The payment provider's automation principal
// (migration 202610140830) and any other automation or bot row carry addresses nobody should own; an IdP that verified
// such an address must not turn a login into that principal. Real Postgres (the Linux gate; skips without
// DATABASE_URL_TEST, and a skipped run proves nothing).
//
// TEETH: drop the kind check in provisionUser() -> "refuses to link ... automation principal" fails (the login becomes it).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createUser } from "../testing/fixtures";
import { provisionUser, type VerifiedToken } from "./oidc";
import { PROVIDER_PRINCIPALS } from "../payments/registry";

const token = (sub: string, email: string): VerifiedToken => ({
  sub, email, emailVerified: true, name: email, amr: [], amrClaimPresent: true, sessionId: null,
} as unknown as VerifiedToken);

describe.skipIf(!TEST_URL)("provisionUser links an IdP login only to a human account", () => {
  beforeAll(async () => { await initTestDb(); }, 120_000);
  afterAll(async () => { await teardownTestDb(); });

  it("refuses to link a verified email that belongs to the payment provider's automation principal", async () => {
    await expect(provisionUser(token("kc-sub-attacker-1", "midtrans@payments.automation.invalid"))).rejects.toThrow(/refusing to link/);
    const u = await adminPool().query<{ idp_subject: string | null }>(`SELECT idp_subject FROM users WHERE id = $1`, [PROVIDER_PRINCIPALS.midtrans]);
    expect(u.rows[0].idp_subject).toBeNull();
  });

  it("refuses a bot row too, and still links an employee and a client contact", async () => {
    const bot = await createUser("bot@link-kind.test");
    await adminPool().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [bot]);
    await expect(provisionUser(token("kc-sub-bot", "bot@link-kind.test"))).rejects.toThrow(/refusing to link/);

    const staff = await createUser("staff@link-kind.test");
    expect(await provisionUser(token("kc-sub-staff", "staff@link-kind.test"))).toBe(staff);
    const client = await createUser("client@link-kind.test");
    await adminPool().query(`UPDATE users SET kind = 'client' WHERE id = $1`, [client]);
    expect(await provisionUser(token("kc-sub-client", "client@link-kind.test"))).toBe(client);
  });
});
