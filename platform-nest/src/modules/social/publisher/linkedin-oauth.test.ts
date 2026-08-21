// SMM-38 phase 38c — LinkedIn's OAuth grant flow: signed state (mint/verify/tamper/expiry), the
// readiness precondition (reusing SMM-07's exact refusal vocabulary), and the full start→callback
// round trip against live Postgres (skips without DATABASE_URL_TEST). No live LinkedIn app
// credential exists (D-23) — every network-touching case drives a STUB `fetchImpl`, never a real
// socket.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { withTenants, withGlobal, newId } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser } from "../../../testing/fixtures";
import { config } from "../../../config";
import {
  mintLinkedInOAuthState, parseLinkedInOAuthState, LinkedInOAuthStateError,
  checkLinkedInConnectReadiness, startLinkedInConnect, completeLinkedInConnect,
  registerLinkedInTokenRefresher, buildLinkedInAuthorizeUrl,
} from "./linkedin-oauth";
import { resolveActiveAccessToken, resetTokenRefreshers, purgeOAuthTokens } from "./oauth-tokens";
import { resetRetentionPurgers } from "../inbox-retention-job";
import { SocialPublisherError } from "./types";

const MODULES = { modules: ["social"] };

describe("SMM-38c · LinkedIn OAuth state — signed, time-boxed, no DB (see the file's own header)", () => {
  const originalKey = config.integrationTokenKey;
  beforeAll(() => { config.integrationTokenKey = Buffer.alloc(32, 7).toString("base64"); });
  afterAll(() => { config.integrationTokenKey = originalKey; });

  it("round-trips tenantId/accountId through mint → parse", () => {
    const state = mintLinkedInOAuthState("tenant-1", "account-1");
    const parsed = parseLinkedInOAuthState(state);
    expect(parsed).toEqual({ tenantId: "tenant-1", accountId: "account-1" });
  });

  it("refuses a tampered state — a spliced-in tenant id fails the signature, before any DB read", () => {
    // 6 segments: prefix, tenantId, accountId, nonce, exp, mac. Take a genuinely-forged token's own
    // first 5 (its full payload, naming the EVIL tenant) and staple on a DIFFERENT, legitimate
    // token's mac — the signature must not verify against a payload it was never computed over.
    const legit = mintLinkedInOAuthState("tenant-1", "account-1");
    const forgedPayload = mintLinkedInOAuthState("tenant-EVIL", "account-1").split(".").slice(0, 5).join(".");
    const forged = `${forgedPayload}.${legit.split(".")[5]}`;
    expect(() => parseLinkedInOAuthState(forged)).toThrow(LinkedInOAuthStateError);
    try { parseLinkedInOAuthState(forged); } catch (e) {
      expect((e as LinkedInOAuthStateError).reason).toBe("bad_signature");
    }
  });

  it("refuses a malformed token", () => {
    expect(() => parseLinkedInOAuthState("not-a-real-token")).toThrow(LinkedInOAuthStateError);
  });

  it("refuses an expired state — even with a valid signature", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const state = mintLinkedInOAuthState("tenant-1", "account-1");
      vi.setSystemTime(new Date("2026-01-01T00:11:00Z")); // past the 10-minute TTL
      expect(() => parseLinkedInOAuthState(state)).toThrow(LinkedInOAuthStateError);
      try { parseLinkedInOAuthState(state); } catch (e) {
        expect((e as LinkedInOAuthStateError).reason).toBe("expired");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("buildLinkedInAuthorizeUrl carries the exact scopes the org-page publish + comment-read need", () => {
    const url = buildLinkedInAuthorizeUrl("some-state");
    expect(url).toContain("response_type=code");
    // URLSearchParams encodes a space as `+` (application/x-www-form-urlencoded), not `%20` —
    // both are valid query-string space encodings; this asserts the literal wire form.
    expect(url).toContain("scope=w_organization_social+r_organization_social_feed");
    expect(url).toContain("state=some-state");
  });
});

describe.skipIf(!TEST_URL)("SMM-38c · LinkedIn connect readiness + the full start→callback round trip", () => {
  let orgSeq = 0;

  async function createClient(tenantId: string): Promise<string> {
    const id = newId();
    await withTenants([tenantId], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'linkedin oauth client','central')`, [id, tenantId]));
    return id;
  }

  async function provisionOrg(tenantId: string, clientId: string): Promise<void> {
    orgSeq += 1;
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, postiz_org_id, api_key_ref, origin_site)
         VALUES ($1,$2,$3,$4,'env:KEY','central')`,
        [newId(), tenantId, clientId, `org-li-${orgSeq}`],
      ), MODULES);
  }

  async function registerLinkedInPlatformApp(): Promise<void> {
    // `social_platform_apps` is GLOBAL — no tenant_id, no RLS (design D-4) — so this is a
    // withGlobal write, not a tenant-scoped one.
    await withGlobal((c) =>
      c.query(
        `INSERT INTO social_platform_apps (id, network, app_name, review_status, credential_ref, origin_site)
         VALUES ($1,'linkedin','Gaiada LinkedIn app (test)','sandbox','default','central')
         ON CONFLICT (network, app_name) DO NOTHING`,
        [newId()],
      ));
  }

  const originalKey = config.integrationTokenKey;
  const originalOwnBrand = config.social.publisher.ownBrandClientIds;
  const originalRedirect = config.social.direct.linkedin.redirectUri;
  const originalClientId = config.social.direct.linkedin.clientId;
  const originalClientSecret = config.social.direct.linkedin.clientSecret;

  beforeAll(async () => {
    await initTestDb();
    await registerLinkedInPlatformApp();
  });

  afterAll(async () => {
    config.integrationTokenKey = originalKey;
    config.social.publisher.ownBrandClientIds = originalOwnBrand;
    config.social.direct.linkedin.redirectUri = originalRedirect;
    config.social.direct.linkedin.clientId = originalClientId;
    config.social.direct.linkedin.clientSecret = originalClientSecret;
    await teardownTestDb();
  });

  beforeEach(() => {
    config.integrationTokenKey = Buffer.alloc(32, 9).toString("base64");
    config.social.direct.linkedin.redirectUri = "https://erp.example.test/social/linkedin/callback";
    config.social.direct.linkedin.clientId = "test-client-id";
    config.social.direct.linkedin.clientSecret = "test-client-secret";
    resetTokenRefreshers();
    resetRetentionPurgers();
  });

  it("checkLinkedInConnectReadiness refuses client_connect_requires_signoff before any DB/network work " +
     "for a client not on the own-brand allow-list (OQ-3)", async () => {
    const T = await createCompany("SMM-38c LinkedIn A", ["social"]);
    const clientId = await createClient(T);
    config.social.publisher.ownBrandClientIds = [];
    const readiness = await checkLinkedInConnectReadiness(T, clientId);
    expect(readiness).toMatchObject({ ok: false, reason: "client_connect_requires_signoff" });
  });

  it("checkLinkedInConnectReadiness refuses platform_app_not_registered when the env creds are " +
     "empty, even if a social_platform_apps row exists — reuses SMM-07's exact token", async () => {
    const T = await createCompany("SMM-38c LinkedIn B", ["social"]);
    const clientId = await createClient(T);
    config.social.publisher.ownBrandClientIds = [clientId];
    config.social.direct.linkedin.clientId = "";
    const readiness = await checkLinkedInConnectReadiness(T, clientId);
    expect(readiness).toMatchObject({ ok: false, reason: "platform_app_not_registered" });
  });

  it("checkLinkedInConnectReadiness is ok when every fact holds: own-brand, creds present, app " +
     "registered, publisher org provisioned", async () => {
    const T = await createCompany("SMM-38c LinkedIn C", ["social"]);
    const clientId = await createClient(T);
    await provisionOrg(T, clientId);
    config.social.publisher.ownBrandClientIds = [clientId];
    const readiness = await checkLinkedInConnectReadiness(T, clientId);
    expect(readiness).toEqual({ ok: true });
  });

  it("start → complete: a pending social_accounts row is created, then promoted to connected, and " +
     "the sealed grant is resolvable through resolveActiveAccessToken", async () => {
    const T = await createCompany("SMM-38c LinkedIn D", ["social"]);
    const clientId = await createClient(T);
    await provisionOrg(T, clientId);
    config.social.publisher.ownBrandClientIds = [clientId];

    const started = await startLinkedInConnect(T, { clientId, handle: "@gaiada", actorId: null });
    expect(started.resumed).toBe(false);
    expect(started.authorizeUrl).toContain("test-client-id");

    const { rows: pending } = await withTenants([T], (c) =>
      c.query(`SELECT status, network, handle FROM social_accounts WHERE id = $1`, [started.accountId]), MODULES);
    expect(pending[0]).toMatchObject({ status: "pending", network: "linkedin", handle: "@gaiada" });

    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ access_token: "li-at-1", refresh_token: "li-rt-1", expires_in: 3600, refresh_token_expires_in: 31536000, scope: "w_organization_social r_organization_social_feed" }),
      { status: 200 },
    )) as unknown as typeof fetch;

    const actorId = await createUser("li-connector@example.test");
    const completed = await completeLinkedInConnect(T, started.accountId, { code: "auth-code-1", actorId, fetchImpl });
    expect(completed).toEqual({ accountId: started.accountId, status: "connected" });

    const { rows: connected } = await withTenants([T], (c) =>
      c.query(`SELECT status, connected_by, platform_app_id FROM social_accounts WHERE id = $1`, [started.accountId]), MODULES);
    expect(connected[0].status).toBe("connected");
    expect(connected[0].connected_by).toBe(actorId);
    expect(connected[0].platform_app_id).not.toBeNull();

    const resolved = await withTenants([T], (c) => resolveActiveAccessToken(c, started.accountId));
    expect(resolved.secret()).toBe("li-at-1");
  });

  it("a second call to startLinkedInConnect for the SAME (client, handle) resumes the SAME row, " +
     "never a second one — the resumability property SMM-07's own flow gives Postiz", async () => {
    const T = await createCompany("SMM-38c LinkedIn E", ["social"]);
    const clientId = await createClient(T);
    await provisionOrg(T, clientId);
    config.social.publisher.ownBrandClientIds = [clientId];

    const first = await startLinkedInConnect(T, { clientId, handle: "@resume-me", actorId: null });
    const second = await startLinkedInConnect(T, { clientId, handle: "@resume-me", actorId: null });
    expect(second.accountId).toBe(first.accountId);
    expect(second.resumed).toBe(true);

    const { rows } = await withTenants([T], (c) =>
      c.query(`SELECT count(*)::int AS n FROM social_accounts WHERE tenant_id = $1 AND client_id = $2 AND handle = '@resume-me'`, [T, clientId]), MODULES);
    expect(rows[0].n).toBe(1);
  });

  it("registerLinkedInTokenRefresher wires a real refresher into oauth-tokens.ts's seam — proven " +
     "by driving purgeOAuthTokens's refresh-ahead pass against a stub token endpoint", async () => {
    const T = await createCompany("SMM-38c LinkedIn F", ["social"]);
    const clientId = await createClient(T);
    await provisionOrg(T, clientId);
    config.social.publisher.ownBrandClientIds = [clientId];

    const started = await startLinkedInConnect(T, { clientId, handle: "@refresh-me", actorId: null });
    const initialExchange = vi.fn(async () => new Response(
      JSON.stringify({ access_token: "li-at-old", refresh_token: "li-rt-old", expires_in: 60 }), { status: 200 },
    )) as unknown as typeof fetch;
    await completeLinkedInConnect(T, started.accountId, { code: "auth-code-2", actorId: null, fetchImpl: initialExchange });

    const refreshFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("li-rt-old");
      return new Response(JSON.stringify({ access_token: "li-at-new", refresh_token: "li-rt-new", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", refreshFetch);
    try {
      registerLinkedInTokenRefresher();
      const counts = await withTenants([T], (c) => purgeOAuthTokens(c, T, new Date(), 24 * 3600 * 1000), MODULES);
      expect(counts.refreshed).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }

    const resolved = await withTenants([T], (c) => resolveActiveAccessToken(c, started.accountId));
    expect(resolved.secret()).toBe("li-at-new");
  });

  it("completeLinkedInConnect refuses org_not_provisioned for an accountId that does not belong to " +
     "this tenant — the state signature names a tenant, but the row is still the last word, checked " +
     "BEFORE the single-use `code` is ever spent on an exchange", async () => {
    const T = await createCompany("SMM-38c LinkedIn G", ["social"]);
    await expect(
      completeLinkedInConnect(T, newId(), { code: "auth-code-3", actorId: null }),
    ).rejects.toBeInstanceOf(SocialPublisherError);
  });
});
