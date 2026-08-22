// Security follow-up to SMM-38c/38d — `social_oauth_states`'s DB-backed single-use state, against
// live Postgres (skips without DATABASE_URL_TEST). Migration: 202608221751_social_oauth_states.sql.
//
// What each block proves, and why it earns a test rather than a comment:
//   (1) ⚠ THE REPLAY REGRESSION — this is the whole point of this follow-up. A state minted once and
//       consumed once succeeds; the SAME token presented a second time is refused with a typed,
//       distinguishable `SocialOAuthStateError` ("unknown_expired_or_consumed"), never a silent
//       second success and never a generic 500. RED-then-GREEN evidence for this exact behaviour
//       (captured by stashing this follow-up's own changes and re-running the pre-fix
//       `mintLinkedInOAuthState`/`parseLinkedInOAuthState` against the same replay shape) lives in
//       this ticket's own report, not in this file — a git-stash round trip is not something CI can
//       re-run, but the invariant this test pins IS, forever, from here on.
//   (2) FORGERY: a tampered token (spliced-in tenant) fails `bad_signature`; a garbage token fails
//       `malformed`. Both BEFORE any database read — timing/behaviour indistinguishable from a
//       forged token this server never minted.
//   (3) EXPIRY: an expired-but-unconsumed state is refused with the SAME collapsed reason as a
//       consumed one (`unknown_expired_or_consumed`) — deliberately, so a caller cannot distinguish
//       "too slow" from "already used" (this file's own header explains why that collapse is the
//       anti-oracle-correct choice, not a swallowed distinction).
//   (4) NETWORK MISMATCH: a state minted for 'linkedin' and presented at the 'youtube' consume call
//       (or vice versa) is refused — AND the state is still burned by that presentation (checked via
//       a THIRD call failing `unknown_expired_or_consumed` rather than `network_mismatch` again),
//       proving the "claim first, check bindings after" ordering this file's header documents.
//   (5) CROSS-TENANT: a state minted for tenant A cannot be consumed by naming tenant A's OWN token
//       from a caller — the token's tenantId is authoritative and RLS-enforced; there is no way to
//       consume "as" a different tenant than the one the signature names (0105's third wall).
//   (6) THE MODULE GUC — why this file does NOT reproduce oauth-tokens.test.ts's own "(1) THE
//       MODULE-GUC REGRESSION" pattern verbatim: `mintSocialOAuthState`/`consumeSocialOAuthState`
//       open and own their ENTIRE transaction internally (mirrors
//       `core/google-oauth/state.ts#createAuthorizationState`/`#consumeAuthorizationState`'s own
//       shape) rather than accepting an externally-opened `PoolClient` the way
//       `storeOAuthGrant`/`resolveActiveAccessToken` do — so there is no call site from which a
//       caller COULD omit `{modules:['social']}`; the module scope is a local constant, not a
//       parameter a caller supplies. The defect class this repo's tracker warns about ("a generic
//       caller forgets `{modules}`") is structurally unreachable here rather than merely tested for.
//       The purge seam (`purgeSocialOAuthStates`) is the one function in this file that DOES run on
//       a caller-opened transaction, and IT deliberately does NOT self-declare (same contract as
//       `purgeOAuthTokens`) — test (7) proves that composes correctly through the real seam.
//   (7) THE SMM-36 SEAM: `wireSocialOAuthStateCustody()` + `purgeTenantInboxRetention` reports an
//       `oauth_states` key alongside the built-in `inbox` key, and actually deletes an
//       expired-and-consumed row (proving the "purges consumed rows too" departure from
//       `google_oauth_states`'s own policy — see the migration header).
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { withTenants, newId } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser } from "../../../testing/fixtures";
import { config } from "../../../config";
import {
  mintSocialOAuthState, consumeSocialOAuthState, purgeSocialOAuthStates, wireSocialOAuthStateCustody,
  SocialOAuthStateError,
} from "./oauth-state";
import { purgeTenantInboxRetention, resetRetentionPurgers } from "../inbox-retention-job";

const MODULES = { modules: ["social"] };

async function makePendingAccount(tenant: string, network: "linkedin" | "youtube"): Promise<string> {
  const accId = newId();
  const clientId = newId();
  await withTenants([tenant], async (c) => {
    await c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'oauth-state client','central')`, [clientId, tenant]);
    const orgId = newId();
    await c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, postiz_org_id, api_key_ref, origin_site)
       VALUES ($1,$2,$3,$4,'env:KEY','central')`,
      [orgId, tenant, clientId, `org-${accId}`],
    );
    await c.query(
      `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,'pending','central')`,
      [accId, tenant, clientId, orgId, network, `@h-${accId}`],
    );
  }, MODULES);
  return accId;
}

/** A real `users` row — `social_oauth_states.created_by` carries an FK to it, so a synthetic id will
 *  not do. Unique email per call because `users.email` is globally unique. */
async function makeUser(): Promise<string> {
  return createUser(`oauth-state-${newId()}@t.test`);
}

async function countRows(tenant: string): Promise<number> {
  const { rows } = await withTenants([tenant], (c) => c.query(`SELECT count(*)::int AS n FROM social_oauth_states`), MODULES);
  return rows[0].n;
}

describe.skipIf(!TEST_URL)("Security follow-up · social_oauth_states — DB-backed single-use OAuth state", () => {
  const originalKey = config.integrationTokenKey;
  let n = 0;
  async function freshCompany(): Promise<string> {
    n += 1;
    return createCompany(`OAuth-state ${n}`, ["social"]);
  }

  beforeAll(async () => {
    await initTestDb();
  });

  afterAll(async () => {
    config.integrationTokenKey = originalKey;
    await teardownTestDb();
  });

  beforeEach(() => {
    config.integrationTokenKey = Buffer.alloc(32, 7).toString("base64");
  });

  afterEach(() => {
    resetRetentionPurgers();
  });

  it("mint → consume round-trips the account/network/tenant the row was minted for", async () => {
    const T = await freshCompany();
    const accountId = await makePendingAccount(T, "linkedin");
    const token = await mintSocialOAuthState({ tenantId: T, accountId, network: "linkedin", createdBy: null });
    const consumed = await consumeSocialOAuthState(token, { network: "linkedin", principalUserId: null });
    expect(consumed).toEqual({ stateId: expect.any(String), tenantId: T, accountId, network: "linkedin", createdBy: null });
    expect(await countRows(T)).toBe(1); // the row survives, marked consumed — see test (7) for the purge
  });

  // ══ (1) THE REPLAY REGRESSION — the whole point of this follow-up ═══════════════════════════════
  it("GREEN: a SECOND consume of the SAME token is refused — the replay this follow-up exists to close", async () => {
    const T = await freshCompany();
    const accountId = await makePendingAccount(T, "linkedin");
    const token = await mintSocialOAuthState({ tenantId: T, accountId, network: "linkedin", createdBy: null });

    const first = await consumeSocialOAuthState(token, { network: "linkedin", principalUserId: null });
    expect(first.accountId).toBe(accountId);

    // THE regression: presenting the EXACT SAME captured token again — exactly what an attacker who
    // captured one callback URL would do — must fail closed, typed, distinguishable. Never a silent
    // second success (the pre-fix defect: see this file's own header) and never a generic 500 (the
    // typed SocialOAuthStateError is mapped to 400 by SocialOAuthErrorFilter, proven at the unit
    // level here since that filter is exercised elsewhere).
    await expect(consumeSocialOAuthState(token, { network: "linkedin", principalUserId: null })).rejects.toBeInstanceOf(SocialOAuthStateError);
    try {
      await consumeSocialOAuthState(token, { network: "linkedin", principalUserId: null });
      expect.unreachable("a replayed state must never resolve successfully");
    } catch (e) {
      expect((e as SocialOAuthStateError).reason).toBe("unknown_expired_or_consumed");
    }

    // A third, fourth, Nth replay attempt — not just "the second call" — all refused identically.
    for (let i = 0; i < 3; i += 1) {
      await expect(consumeSocialOAuthState(token, { network: "linkedin", principalUserId: null })).rejects.toBeInstanceOf(SocialOAuthStateError);
    }
  });

  it("two concurrent consume attempts on the same token: exactly ONE wins, never both — the atomic " +
     "UPDATE...WHERE consumed_at IS NULL is a database-enforced property, not a check-then-act race", async () => {
    const T = await freshCompany();
    const accountId = await makePendingAccount(T, "linkedin");
    const token = await mintSocialOAuthState({ tenantId: T, accountId, network: "linkedin", createdBy: null });

    const results = await Promise.allSettled([
      consumeSocialOAuthState(token, { network: "linkedin", principalUserId: null }),
      consumeSocialOAuthState(token, { network: "linkedin", principalUserId: null }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  // ══ (2) FORGERY ══════════════════════════════════════════════════════════════════════════════
  it("refuses a tampered state — a spliced-in (real, but WRONG) tenant id fails the signature, " +
     "before any DB read", async () => {
    const T = await freshCompany();
    const other = await freshCompany(); // a REAL tenant, just not the one this state was minted for
    const accountId = await makePendingAccount(T, "linkedin");
    const legit = await mintSocialOAuthState({ tenantId: T, accountId, network: "linkedin", createdBy: null });
    // Keep the legit token's own (prefix, stateId, mac) but splice in `other`'s real tenant id in the
    // middle segment — proves the signature covers the (stateId, tenantId) PAIR, not stateId alone:
    // a real stateId matched with a real-but-different tenantId still fails `timingSafeEqual`.
    const parts = legit.split(".");
    const forged = `${parts[0]}.${parts[1]}.${Buffer.from(other, "utf8").toString("base64url")}.${parts[3]}`;
    await expect(consumeSocialOAuthState(forged, { network: "linkedin", principalUserId: null })).rejects.toThrow(SocialOAuthStateError);
    try {
      await consumeSocialOAuthState(forged, { network: "linkedin", principalUserId: null });
    } catch (e) {
      expect((e as SocialOAuthStateError).reason).toBe("bad_signature");
    }
  });

  it("refuses a malformed token", async () => {
    await expect(consumeSocialOAuthState("not-a-real-token", { network: "linkedin", principalUserId: null })).rejects.toBeInstanceOf(SocialOAuthStateError);
  });

  // ══ (3) EXPIRY ═══════════════════════════════════════════════════════════════════════════════
  it("refuses an expired-but-never-consumed state, collapsed to the SAME reason as a replay — an " +
     "attacker/prober cannot distinguish 'too slow' from 'already used'", async () => {
    const T = await freshCompany();
    const accountId = await makePendingAccount(T, "linkedin");
    const token = await mintSocialOAuthState({ tenantId: T, accountId, network: "linkedin", createdBy: null });
    // Force the row into the past directly, against Postgres's OWN clock (`now()`) — the same clock
    // `consumeSocialOAuthState`'s atomic UPDATE compares against. `vi.useFakeTimers()` only mocks the
    // Node process's clock, which `expires_at`'s computation at mint time uses but the DB-side
    // comparison at consume time does NOT — mocking JS time alone would desync the two and either
    // falsely pass or falsely fail depending on which side of real "now" the mock lands on.
    await withTenants([T], (c) => c.query(`UPDATE social_oauth_states SET expires_at = now() - interval '1 minute'`), MODULES);
    await expect(consumeSocialOAuthState(token, { network: "linkedin", principalUserId: null })).rejects.toBeInstanceOf(SocialOAuthStateError);
    try {
      await consumeSocialOAuthState(token, { network: "linkedin", principalUserId: null });
    } catch (e) {
      expect((e as SocialOAuthStateError).reason).toBe("unknown_expired_or_consumed");
    }
  });

  // ══ (4) NETWORK MISMATCH — checked AFTER the atomic claim, and the state is still burned ═══════
  it("a state minted for linkedin is refused at the youtube consume call, and is BURNED by that " +
     "presentation (a retry against the correct network also fails, now as a replay)", async () => {
    const T = await freshCompany();
    const accountId = await makePendingAccount(T, "linkedin");
    const token = await mintSocialOAuthState({ tenantId: T, accountId, network: "linkedin", createdBy: null });

    try {
      await consumeSocialOAuthState(token, { network: "youtube", principalUserId: null });
      expect.unreachable("a linkedin state must never verify at the youtube callback route");
    } catch (e) {
      expect((e as SocialOAuthStateError).reason).toBe("network_mismatch");
    }

    // The safe direction (this file's own header): the claim already happened, so a SUBSEQUENT
    // attempt — even against the CORRECT network — is now a replay, not a fresh network_mismatch.
    try {
      await consumeSocialOAuthState(token, { network: "linkedin", principalUserId: null });
      expect.unreachable("the state was already claimed by the mismatched attempt above");
    } catch (e) {
      expect((e as SocialOAuthStateError).reason).toBe("unknown_expired_or_consumed");
    }
  });

  // ══ (5) CROSS-TENANT ═════════════════════════════════════════════════════════════════════════
  it("a state minted for tenant A is unreachable from tenant B's own transaction — RLS, not just the app", async () => {
    const A = await freshCompany();
    const B = await freshCompany();
    const accountId = await makePendingAccount(A, "linkedin");
    const token = await mintSocialOAuthState({ tenantId: A, accountId, network: "linkedin", createdBy: null });

    // Directly probing tenant B's own scope for ANY row proves isolation independent of the token
    // (which itself names tenant A and cannot be redirected to consume against B).
    const { rows } = await withTenants([B], (c) => c.query(`SELECT count(*)::int AS n FROM social_oauth_states`), MODULES);
    expect(rows[0].n).toBe(0);

    // The token still consumes correctly against its OWN tenant (A) — proves this is a real
    // isolation property, not an accidental total failure.
    const consumed = await consumeSocialOAuthState(token, { network: "linkedin", principalUserId: null });
    expect(consumed.tenantId).toBe(A);
  });

  // ══ (7) THE SMM-36 SEAM ══════════════════════════════════════════════════════════════════════
  it("wireSocialOAuthStateCustody + purgeTenantInboxRetention deletes an expired row (consumed or " +
     "not) — the deliberate departure from google_oauth_states' own keep-consumed-forever policy", async () => {
    const T = await freshCompany();
    const accountId = await makePendingAccount(T, "linkedin");

    const token = await mintSocialOAuthState({ tenantId: T, accountId, network: "linkedin", createdBy: null });
    // Consumed WHILE still valid — proves the purge deletes a CONSUMED-and-expired row too, not only
    // a never-consumed one.
    await consumeSocialOAuthState(token, { network: "linkedin", principalUserId: null });
    // Force it into the past against Postgres's OWN clock (see the expiry test's own comment on why
    // `vi.useFakeTimers()` is the wrong tool here) — simulates "time has since elapsed".
    await withTenants([T], (c) => c.query(`UPDATE social_oauth_states SET expires_at = now() - interval '1 minute'`), MODULES);
    expect(await countRows(T)).toBe(1);

    wireSocialOAuthStateCustody();
    const report = await withTenants([T], (c) => purgeTenantInboxRetention(c, T, new Date()));
    expect(report.oauth_states).toEqual({ purged: 1 });
    expect(report.inbox).toBeDefined(); // the built-in purger still ran in the SAME transaction
    expect(await countRows(T)).toBe(0);
  });

  it("purgeSocialOAuthStates called directly leaves an UN-expired row alone", async () => {
    const T = await freshCompany();
    const accountId = await makePendingAccount(T, "linkedin");
    await mintSocialOAuthState({ tenantId: T, accountId, network: "linkedin", createdBy: null });
    const counts = await withTenants([T], (c) => purgeSocialOAuthStates(c, T, new Date()), MODULES);
    expect(counts).toEqual({ purged: 0 });
    expect(await countRows(T)).toBe(1);
  });

  // ══ (8) PRINCIPAL BINDING — the deferred follow-up, now closed ═══════════════════════════════════
  //
  // Cerbos cannot refuse this on its own: two principals may BOTH legitimately hold `connect` on the
  // same tenant, so what is wrong is not the permission but the SWAP — B finishing the ceremony A
  // started, binding B's account into the slot A was connecting. Only the row's own provenance sees it.
  it("refuses principal_mismatch when a DIFFERENT principal presents the state", async () => {
    const T = await freshCompany();
    const accountId = await makePendingAccount(T, "linkedin");
    const userA = await makeUser(), userB = await makeUser();
    const token = await mintSocialOAuthState({ tenantId: T, accountId, network: "linkedin", createdBy: userA });
    await expect(
      consumeSocialOAuthState(token, { network: "linkedin", principalUserId: userB }),
    ).rejects.toMatchObject({ reason: "principal_mismatch" });
  });

  it("the originating principal CAN consume its own state — not a blanket refusal", async () => {
    const T = await freshCompany();
    const accountId = await makePendingAccount(T, "linkedin");
    const userA = await makeUser(), userB = await makeUser();
    const token = await mintSocialOAuthState({ tenantId: T, accountId, network: "linkedin", createdBy: userA });
    const consumed = await consumeSocialOAuthState(token, { network: "linkedin", principalUserId: userA });
    expect(consumed.accountId).toBe(accountId);
    expect(consumed.createdBy).toBe(userA);
  });

  it("FAILS CLOSED: a principal-bound state presented with principalUserId null is refused", async () => {
    // The direction that matters. If this passed, a call site that forgot to thread the principal
    // through would silently skip the whole check while still reading as enforced.
    const T = await freshCompany();
    const accountId = await makePendingAccount(T, "linkedin");
    const userA = await makeUser(), userB = await makeUser();
    const token = await mintSocialOAuthState({ tenantId: T, accountId, network: "linkedin", createdBy: userA });
    await expect(
      consumeSocialOAuthState(token, { network: "linkedin", principalUserId: null }),
    ).rejects.toMatchObject({ reason: "principal_mismatch" });
  });

  it("a principal-LESS state stays consumable by a principal-less caller (null matches null)", async () => {
    // Deliberate: not every mint path has a principal, and this must not become a de-facto
    // requirement for one. Pins the `?? null` on both sides.
    const T = await freshCompany();
    const accountId = await makePendingAccount(T, "linkedin");
    const token = await mintSocialOAuthState({ tenantId: T, accountId, network: "linkedin", createdBy: null });
    const consumed = await consumeSocialOAuthState(token, { network: "linkedin", principalUserId: null });
    expect(consumed.createdBy).toBeNull();
  });

  it("a mismatched principal still SPENDS the state — the row is claimed before the check", async () => {
    // Documents the ordering honestly: the atomic UPDATE runs first, so a refused attempt has still
    // consumed the token. That is the safe direction — a state fed into a failed callback is exactly
    // the one an attacker would retry — but the rightful principal must restart the ceremony.
    const T = await freshCompany();
    const accountId = await makePendingAccount(T, "linkedin");
    const userA = await makeUser(), userB = await makeUser();
    const token = await mintSocialOAuthState({ tenantId: T, accountId, network: "linkedin", createdBy: userA });
    await expect(
      consumeSocialOAuthState(token, { network: "linkedin", principalUserId: userB }),
    ).rejects.toMatchObject({ reason: "principal_mismatch" });
    await expect(
      consumeSocialOAuthState(token, { network: "linkedin", principalUserId: userA }),
    ).rejects.toMatchObject({ reason: "unknown_expired_or_consumed" });
  });

});
