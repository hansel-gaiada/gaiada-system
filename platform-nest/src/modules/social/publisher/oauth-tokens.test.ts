// SMM-38 phase 38b — OAuth token custody, against live Postgres (skips without DATABASE_URL_TEST).
//
// What each block proves, and why it earns a test rather than a comment:
//   (1) ⚠ THE MODULE-GUC REGRESSION — `storeOAuthGrant`/`resolveActiveAccessToken`/`revokeOAuthGrant`
//       each self-declare the module scope (mirroring `evaluatePublishPrecondition`'s own pattern),
//       so each is exercised on a transaction the TEST itself opened WITHOUT `{modules:['social']}`.
//       If any of those three ever lost its `declareSocialModuleScope` call, 0105's third RLS wall
//       would make the underlying query read/write ZERO ROWS, and these assertions fail exactly the
//       way that regression would look in production: "no grant found" for an account that plainly
//       has one.
//   (2) `purgeOAuthTokens` deliberately does NOT self-declare (same contract as `purgeInboxRetention`
//       — it runs inside an ALREADY-scoped transaction, opened by `purgeTenantInboxRetention`) — a
//       SEPARATE test proves that calling it directly on an unscoped transaction reads zero rows,
//       which is the CORRECT behaviour for that function and the reason the seam test below composes
//       it through `wireOAuthTokenCustody()` + `purgeTenantInboxRetention` instead.
//   (3) encrypt/decrypt round-trips through the REAL `secret-box.ts` vault (no mock), and the
//       resolved handle's `toJSON`/`inspect` both redact — the same discipline `types.ts`'s
//       `OrgHandle` is pinned on.
//   (4) revocation is the SHRED: both ciphertext columns are NULL in the ROW, not merely a status
//       flag, and `resolveActiveAccessToken` refuses `oauth_token_revoked` afterwards — never a
//       stale token, which is the ticket's own "revocation fails closed" requirement.
//   (5) the refresh-ahead / shred purge composes: a registered fake refresher (no network I/O) is
//       actually invoked and its result persisted; an unregistered network's due grant is left alone
//       and counted, never silently dropped; a grant already past `expires_at` is shredded to
//       `expired` and a subsequent resolve refuses `oauth_token_expired`.
//   (6) the SMM-36 seam actually composes: `wireOAuthTokenCustody()` + `purgeTenantInboxRetention`
//       reports an `oauth_tokens` key alongside the built-in `inbox` key, in the SAME transaction.
//   (7) `sot_shred_contract` (the migration's structural CHECK) actually refuses a hand-written
//       UPDATE that tries to mark a row revoked while leaving ciphertext behind — exercised against a
//       real row with real FK parents, same reasoning 0113 gives for deferring this from the
//       migration itself.
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { inspect } from "node:util";
import { randomBytes } from "node:crypto";
import { withTenants, newId } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany } from "../../../testing/fixtures";
import { config } from "../../../config";
import {
  storeOAuthGrant, resolveActiveAccessToken, revokeOAuthGrant, purgeOAuthTokens,
  registerTokenRefresher, resetTokenRefreshers, wireOAuthTokenCustody, OAuthTokenError,
  ResolvedAccessToken,
} from "./oauth-tokens";
import {
  purgeTenantInboxRetention, resetRetentionPurgers,
} from "../inbox-retention-job";

const MODULES = { modules: ["social"] };
const KEY_B64 = randomBytes(32).toString("base64");

async function makeAccount(tenant: string, network: string): Promise<string> {
  const accId = newId();
  const clientId = newId();
  await withTenants([tenant], async (c) => {
    await c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'oauth client','central')`, [clientId, tenant]);
    const orgId = newId();
    await c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, postiz_org_id, api_key_ref, origin_site)
       VALUES ($1,$2,$3,$4,'env:KEY','central')`,
      [orgId, tenant, clientId, `org-${accId}`],
    );
    await c.query(
      `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,'connected','central')`,
      [accId, tenant, clientId, orgId, network, `@h-${accId}`],
    );
  }, MODULES);
  return accId;
}

async function readRawRow(tenant: string, accountId: string) {
  const { rows } = await withTenants([tenant], (c) =>
    c.query(
      `SELECT status, access_token_enc, refresh_token_enc, revoked_at, revoked_reason, expires_at
         FROM social_oauth_tokens WHERE account_id = $1`,
      [accountId],
    ), MODULES);
  return rows[0];
}

describe.skipIf(!TEST_URL)("SMM-38/38b · OAuth token custody (module GUC, encryption, revoke-fails-closed, refresh-ahead)", () => {
  const originalKey = config.integrationTokenKey;
  let n = 0;
  // EACH test gets its OWN fresh company. The refresh-ahead sweep intentionally re-matches every
  // still-`active` grant within its window on every call (that IS the "keep trying every sweep"
  // property) — sharing one tenant across tests would let an earlier test's still-active,
  // still-in-window grant get re-counted by a LATER test's purge call, which is a test-isolation
  // bug in this file, not a bug in `purgeOAuthTokens` itself. A fresh tenant per test is the same
  // isolation `inbox-retention-job.test.ts`'s own "per-tenant isolation" test reaches for, applied
  // here to every test rather than just one.
  async function freshCompany(): Promise<string> {
    n += 1;
    return createCompany(`SMM-38b Custody ${n}`, ["social"]);
  }

  beforeAll(async () => {
    await initTestDb();
  });

  afterAll(async () => {
    config.integrationTokenKey = originalKey;
    await teardownTestDb();
  });

  beforeEach(() => {
    config.integrationTokenKey = KEY_B64;
  });

  afterEach(() => {
    resetTokenRefreshers();
    resetRetentionPurgers();
  });

  // ══ (1) THE MODULE-GUC REGRESSION ═══════════════════════════════════════════════════════════
  it("storeOAuthGrant writes through a transaction with NO module scope declared by the caller", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    // Deliberately WITHOUT `{modules:['social']}` — if storeOAuthGrant's own declareSocialModuleScope
    // call were ever removed, the INSERT below would hit 0105's third RLS wall and read/write zero
    // rows through the (id,tenant_id) composite FK check's own tenant-scoped side, silently.
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "linkedin", accessToken: "at-1", refreshToken: "rt-1",
        expiresAt: new Date(Date.now() + 3600_000),
      }));
    const row = await readRawRow(T, accountId);
    expect(row.status).toBe("active");
    expect(row.access_token_enc).toMatch(/^enc:v1:/);
  });

  it("resolveActiveAccessToken reads through a transaction with NO module scope declared by the caller", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "linkedin", accessToken: "at-2",
        expiresAt: new Date(Date.now() + 3600_000),
      }), MODULES);
    const resolved = await withTenants([T], (c) => resolveActiveAccessToken(c, accountId));
    expect(resolved.secret()).toBe("at-2");
  });

  it("revokeOAuthGrant shreds through a transaction with NO module scope declared by the caller", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "linkedin", accessToken: "at-3",
        expiresAt: new Date(Date.now() + 3600_000),
      }), MODULES);
    const { revoked } = await withTenants([T], (c) => revokeOAuthGrant(c, accountId, "user disconnected"));
    expect(revoked).toBe(true);
    const row = await readRawRow(T, accountId);
    expect(row.status).toBe("revoked");
    expect(row.access_token_enc).toBeNull();
  });

  // ══ (2) purgeOAuthTokens does NOT self-declare — it needs an already-scoped transaction ═══════
  it("purgeOAuthTokens run directly on an UNSCOPED transaction reads zero rows (relies on the caller, like purgeInboxRetention)", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "linkedin", accessToken: "at-4",
        expiresAt: new Date(Date.now() - 1000), // already expired
      }), MODULES);
    // No {modules:['social']} here, and purgeOAuthTokens itself declares no scope either.
    const counts = await withTenants([T], (c) => purgeOAuthTokens(c, T, new Date()));
    expect(counts.shredded).toBe(0);
    // Proof it is a visibility gap, not a real absence: reading WITH the module scope finds the row.
    const row = await readRawRow(T, accountId);
    expect(row.status).toBe("active"); // untouched by the unscoped call above
  });

  // ══ (3) round trip + redaction ══════════════════════════════════════════════════════════════
  it("round-trips a real token through secret-box.ts, and the resolved handle redacts on both serialization paths", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "youtube");
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "youtube", accessToken: "s3cr3t-access-token-do-not-log",
        refreshToken: "s3cr3t-refresh-token-do-not-log", expiresAt: new Date(Date.now() + 3600_000),
      }), MODULES);
    const resolved = await withTenants([T], (c) => resolveActiveAccessToken(c, accountId), MODULES);
    expect(resolved).toBeInstanceOf(ResolvedAccessToken);
    expect(resolved.secret()).toBe("s3cr3t-access-token-do-not-log");
    expect(JSON.stringify(resolved)).not.toContain("s3cr3t-access-token-do-not-log");
    expect(JSON.stringify(resolved)).toContain("[redacted]");
    expect(inspect(resolved)).not.toContain("s3cr3t-access-token-do-not-log");
    expect(inspect(resolved)).toContain("[redacted]");
  });

  it("resolveActiveAccessToken refuses oauth_token_not_found for an account with no grant on file", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    await expect(withTenants([T], (c) => resolveActiveAccessToken(c, accountId), MODULES))
      .rejects.toMatchObject({ code: "oauth_token_not_found" });
  });

  // ══ (4) revocation is the shred, and resolve fails closed afterwards ═══════════════════════════
  it("REVOCATION FAILS CLOSED: after revoke, resolveActiveAccessToken refuses oauth_token_revoked — never a stale token", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "linkedin", accessToken: "at-5",
        expiresAt: new Date(Date.now() + 3600_000),
      }), MODULES);
    await withTenants([T], (c) => revokeOAuthGrant(c, accountId, "client requested disconnect"), MODULES);

    const row = await readRawRow(T, accountId);
    expect(row.status).toBe("revoked");
    expect(row.access_token_enc).toBeNull();
    expect(row.refresh_token_enc).toBeNull();
    expect(row.revoked_reason).toBe("client requested disconnect");
    expect(row.revoked_at).not.toBeNull();

    await expect(withTenants([T], (c) => resolveActiveAccessToken(c, accountId), MODULES))
      .rejects.toMatchObject({ code: "oauth_token_revoked" });
  });

  it("revoking an already-revoked grant is a no-op the second time (idempotent), never a second audit stamp", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "linkedin", accessToken: "at-6",
        expiresAt: new Date(Date.now() + 3600_000),
      }), MODULES);
    const first = await withTenants([T], (c) => revokeOAuthGrant(c, accountId, "first reason"), MODULES);
    expect(first.revoked).toBe(true);
    const second = await withTenants([T], (c) => revokeOAuthGrant(c, accountId, "second reason"), MODULES);
    expect(second.revoked).toBe(false);
    const row = await readRawRow(T, accountId);
    expect(row.revoked_reason).toBe("first reason"); // the SECOND call's reason never overwrote the first
  });

  // ══ vault fail-closed ═══════════════════════════════════════════════════════════════════════
  it("FAILS CLOSED with no vault key configured: storeOAuthGrant refuses oauth_vault_not_configured, never plaintext", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    config.integrationTokenKey = "";
    await expect(withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "linkedin", accessToken: "at-should-never-land",
        expiresAt: new Date(Date.now() + 3600_000),
      }), MODULES)).rejects.toMatchObject({ code: "oauth_vault_not_configured" });
    const row = await readRawRow(T, accountId);
    expect(row).toBeUndefined(); // no row at all — the INSERT never ran past the failed seal
  });

  // ══ (5) refresh-ahead / shred purge ═════════════════════════════════════════════════════════
  it("refresh-ahead: a registered (fake, non-network) refresher is invoked for a grant due soon, and its result persists", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    const soon = new Date(Date.now() + 60_000); // due within a generous aheadMs window
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "linkedin", accessToken: "at-old", refreshToken: "rt-old",
        expiresAt: soon,
      }), MODULES);

    let calledWithRefreshToken: string | undefined;
    registerTokenRefresher("linkedin", async ({ refreshToken }) => {
      calledWithRefreshToken = refreshToken; // proves the DECRYPTED refresh token reached the refresher
      return { accessToken: "at-new", refreshToken: "rt-new", expiresAt: new Date(Date.now() + 3600_000) };
    });

    const counts = await withTenants([T], (c) => purgeOAuthTokens(c, T, new Date(), 3600_000), MODULES);
    expect(counts.refreshed).toBe(1);
    expect(calledWithRefreshToken).toBe("rt-old");

    const resolved = await withTenants([T], (c) => resolveActiveAccessToken(c, accountId), MODULES);
    expect(resolved.secret()).toBe("at-new");
  });

  it("a due grant on a network with NO registered refresher is counted and left alone, never dropped or errored", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "youtube");
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "youtube", accessToken: "at-yt", refreshToken: "rt-yt",
        expiresAt: new Date(Date.now() + 60_000),
      }), MODULES);
    const counts = await withTenants([T], (c) => purgeOAuthTokens(c, T, new Date(), 3600_000), MODULES);
    expect(counts.refreshSkippedNoRefresher).toBe(1);
    expect(counts.refreshed).toBe(0);
    const row = await readRawRow(T, accountId);
    expect(row.status).toBe("active"); // left alone, not shredded — it has not reached expires_at
  });

  it("a refresher that throws is counted as failed and the grant is left active for the next sweep", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "linkedin", accessToken: "at-boom", refreshToken: "rt-boom",
        expiresAt: new Date(Date.now() + 60_000),
      }), MODULES);
    registerTokenRefresher("linkedin", async () => {
      throw new Error("simulated token-endpoint failure");
    });
    const counts = await withTenants([T], (c) => purgeOAuthTokens(c, T, new Date(), 3600_000), MODULES);
    expect(counts.refreshFailed).toBe(1);
    const row = await readRawRow(T, accountId);
    expect(row.status).toBe("active");
    expect(row.access_token_enc).not.toBeNull(); // the OLD ciphertext survives a failed attempt
  });

  it("SHRED ON EXPIRY: a grant already past expires_at with no successful refresh is shredded to 'expired', and resolve refuses oauth_token_expired", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "linkedin", accessToken: "at-dead",
        expiresAt: new Date(Date.now() - 5000), // already in the past
      }), MODULES);
    const counts = await withTenants([T], (c) => purgeOAuthTokens(c, T, new Date()), MODULES);
    expect(counts.shredded).toBe(1);

    const row = await readRawRow(T, accountId);
    expect(row.status).toBe("expired");
    expect(row.access_token_enc).toBeNull();

    await expect(withTenants([T], (c) => resolveActiveAccessToken(c, accountId), MODULES))
      .rejects.toMatchObject({ code: "oauth_token_expired" });
  });

  it("idempotent: running the purge sweep twice shreds the same row ONCE and reports zero the second time", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "linkedin", accessToken: "at-dead2",
        expiresAt: new Date(Date.now() - 5000),
      }), MODULES);
    const now = new Date();
    const first = await withTenants([T], (c) => purgeOAuthTokens(c, T, now), MODULES);
    expect(first.shredded).toBe(1);
    const second = await withTenants([T], (c) => purgeOAuthTokens(c, T, now), MODULES);
    expect(second.shredded).toBe(0);
  });

  // ══ (6) the SMM-36 seam actually composes ══════════════════════════════════════════════════
  it("wireOAuthTokenCustody registers this file's purger into SMM-36's seam — it runs alongside the built-in inbox purger, same transaction", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "linkedin", accessToken: "at-seam",
        expiresAt: new Date(Date.now() - 5000),
      }), MODULES);

    wireOAuthTokenCustody();
    const result = await withTenants([T], (c) => purgeTenantInboxRetention(c, T, new Date()));
    expect(result.oauth_tokens).toBeDefined();
    expect(result.oauth_tokens.shredded).toBe(1);
    expect(result.inbox).toBeDefined(); // the built-in purger still ran in the SAME transaction
  });

  // ══ (7) the migration's shred-contract CHECK actually refuses ═════════════════════════════════
  it("the DB refuses a hand-written UPDATE that marks a grant revoked while leaving ciphertext behind (sot_shred_contract)", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "linkedin", accessToken: "at-7",
        expiresAt: new Date(Date.now() + 3600_000),
      }), MODULES);
    await expect(withTenants([T], (c) =>
      c.query(
        `UPDATE social_oauth_tokens SET status='revoked', revoked_at=now(), revoked_reason='bad update'
          WHERE account_id = $1`,
        [accountId],
      ), MODULES)).rejects.toThrow(/sot_shred_contract/);
  });

  it("the DB refuses a revoked row with no revoked_reason (sot_revocation_is_complete)", async () => {
    const T = await freshCompany();
    const accountId = await makeAccount(T, "linkedin");
    await withTenants([T], (c) =>
      storeOAuthGrant(c, {
        tenantId: T, accountId, network: "linkedin", accessToken: "at-8",
        expiresAt: new Date(Date.now() + 3600_000),
      }), MODULES);
    await expect(withTenants([T], (c) =>
      c.query(
        `UPDATE social_oauth_tokens
            SET status='revoked', access_token_enc=NULL, refresh_token_enc=NULL, revoked_at=now()
          WHERE account_id = $1`,
        [accountId],
      ), MODULES)).rejects.toThrow(/sot_revocation_is_complete/);
  });
});
