// WD-23A-1's first hard acceptance criterion: prove the PER-ROW module gate BOTH ways.
//
// Migration 0060's policy hard-coded `app_module_allowed('search')` — the module wall lived in the
// TABLE, not in `authorize()` (which is Cerbos-only and knows nothing about module scope). Sharing the
// table with core surfaces meant that gate could not stay hard-coded, and simply dropping it would have
// been a security regression smuggled in as a refactor: nothing would fail, and search's third wall
// would be gone. So 0076 stamps `module` on the row and gates per-row.
//
// WHY BOTH DIRECTIONS, and why the second test is the one that matters: a test showing only that Drive
// works proves nothing about the gate — an absent gate passes it identically. The positive control is
// the same connection, in the same tenant, failing to reach a `module='search'` row. Correct-but-unwired
// is indistinguishable from absent without it, a pattern this estate has hit repeatedly.
//
// THE MECHANIC being asserted (migration 0028): `app_module_allowed(mod)` reads the REQUEST-DECLARED
// `app.scopes` GUC set by `withTenants(..., {modules})`. It is not about which modules a company has
// enabled. So the row's `module` and the request's declared scope must MATCH.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { config } from "../../config";
import { withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser } from "../../testing/fixtures";
import { createAuthorizationState, consumeAuthorizationState } from "./state";

const AUTHORIZE_URL = "http://localhost:8080/realms/gaiada/protocol/openid-connect/auth";
const REDIRECT = "http://localhost:3004/api/integrations/google/callback";

describe.skipIf(!TEST_URL)("WD-23A-1 · the per-row module gate, both directions", () => {
  let co: string;
  let user: string;

  beforeAll(async () => {
    await initTestDb();
    // The state row seals its PKCE verifier with the same vault box as a credential, so minting a state
    // needs this key — it gates OAuth STATE-MINT, not just token storage. Every other Google suite sets
    // it the same way; a fresh box therefore fails earlier than the old docs implied.
    config.integrationTokenKey = randomBytes(32).toString("base64");
    co = await createCompany("Module Gate Co");
    user = await createUser("gate@wd23a1.test");
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("a CORE surface (module null) completes end to end WITHOUT declaring any module scope", async () => {
    // This is webdev's Drive case: no module, so no module scope declared anywhere in the flow.
    const state = await createAuthorizationState({
      tenantId: co,
      ownerKind: "user",
      ownerId: user,
      module: null,
      provider: "google_drive",
      redirectUri: REDIRECT,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      authorizeUrl: AUTHORIZE_URL,
      createdBy: user,
    });
    expect(state.stateId).toBeTruthy();

    const consumed = await consumeAuthorizationState(state.stateToken, {
      redirectUri: REDIRECT,
      principalUserId: user,
      provider: "google_drive",
      module: null,
    });
    expect(consumed).toMatchObject({
      ownerKind: "user",
      ownerId: user,
      module: null,
      provider: "google_drive",
    });
    // The verifier round-trips, which is what proves the sealed column was written and read as itself
    // rather than the row merely existing.
    expect(consumed.codeVerifier).toBe(state.codeVerifier);
  });

  it("THE POSITIVE CONTROL — the same tenant cannot reach a module='search' row without that scope", async () => {
    // Minted WITH the search scope declared, exactly as the search adapter does.
    const state = await createAuthorizationState({
      tenantId: co,
      ownerKind: "client",
      ownerId: user, // any uuid: the column is polymorphic and deliberately carries no FK
      module: "search",
      provider: "google_search_console",
      redirectUri: REDIRECT,
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
      authorizeUrl: AUTHORIZE_URL,
      createdBy: user,
    });

    // Consuming WITHOUT declaring the module — a core-surface caller, or search having forgotten.
    // It must refuse, and it must refuse with the SAME coarse reason as a forged/expired state: the
    // caller must not be able to distinguish "exists but not mine" from "does not exist".
    await expect(
      consumeAuthorizationState(state.stateToken, {
        redirectUri: REDIRECT,
        principalUserId: user,
        provider: "google_search_console",
        module: null,
      }),
      // `reason` lives in the error's `detail` bag, not top-level: GoogleOAuthStateError deliberately
      // maps EVERY refusal to one coarse message + status, and carries the reason separately for logs.
      // Asserting the detail is what distinguishes "refused because the wall held" from "refused for
      // some other reason", which a bare rejects.toThrow() would not.
    ).rejects.toMatchObject({ code: "google_oauth_invalid_state", detail: { reason: "unknown_or_expired" } });

    // And the row is genuinely invisible to a connection that has not declared the scope — asserted
    // directly against the table, so this does not depend on the consume predicate's own filtering.
    const unscoped = await withTenants([co], (c) =>
      c.query(`SELECT id FROM google_oauth_states WHERE id = $1`, [state.stateId]),
    );
    expect(unscoped.rows).toEqual([]);

    // Same connection shape, same tenant, WITH the scope declared: the row is there. This is what makes
    // the refusal above meaningful rather than a row that never existed.
    const scoped = await withTenants(
      [co],
      (c) => c.query(`SELECT id, module FROM google_oauth_states WHERE id = $1`, [state.stateId]),
      { modules: ["search"] },
    );
    expect(scoped.rows).toHaveLength(1);
    expect(scoped.rows[0]).toMatchObject({ module: "search" });
  });

  it("declaring the module lets search consume its own row — the wall is not a one-way door", async () => {
    const state = await createAuthorizationState({
      tenantId: co,
      ownerKind: "client",
      ownerId: user,
      module: "search",
      provider: "google_analytics",
      redirectUri: REDIRECT,
      scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
      authorizeUrl: AUTHORIZE_URL,
      createdBy: user,
    });
    const consumed = await consumeAuthorizationState(state.stateToken, {
      redirectUri: REDIRECT,
      principalUserId: user,
      provider: "google_analytics",
      module: "search",
    });
    expect(consumed).toMatchObject({ module: "search", provider: "google_analytics" });
  });

  it("a core caller cannot reach a search row even by declaring a DIFFERENT module", async () => {
    // Guards the obvious bypass attempt: declaring some module (any module) rather than the right one.
    const state = await createAuthorizationState({
      tenantId: co,
      ownerKind: "client",
      ownerId: user,
      module: "search",
      provider: "google_ads",
      redirectUri: REDIRECT,
      scopes: ["https://www.googleapis.com/auth/adwords"],
      authorizeUrl: AUTHORIZE_URL,
      createdBy: user,
    });
    const wrongScope = await withTenants(
      [co],
      (c) => c.query(`SELECT id FROM google_oauth_states WHERE id = $1`, [state.stateId]),
      { modules: ["hr"] },
    );
    expect(wrongScope.rows).toEqual([]);
    expect(config.originSite).toBeTruthy();
  });

  it("the provider CHECK admits google_drive — the one thing 0060 rejected", async () => {
    // 0060's provider CHECK was the ONLY thing standing between Drive and this table; the vault (0033)
    // already permitted `google_drive` + owner_kind='user'. Asserted so a future CHECK edit that drops
    // it fails here rather than in webdev's link flow.
    const rows = await withTenants([co], (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM google_oauth_states WHERE provider = 'google_drive' AND tenant_id = $1`,
        [co],
      ),
    );
    expect(Number(rows.rows[0].n)).toBeGreaterThanOrEqual(1);
  });
});
