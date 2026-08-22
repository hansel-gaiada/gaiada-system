// SMM-38 phase 38d — YouTube's OAuth grant flow: the readiness precondition (reusing SMM-07's exact
// refusal vocabulary) and the full start→callback round trip against live Postgres (skips without
// DATABASE_URL_TEST). No live YouTube app credential exists (D-23) — every network-touching case
// drives a STUB `fetchImpl`, never a real socket. Mirrors `linkedin-oauth.test.ts` (38c) closely —
// "Follow that shape" was this ticket's own instruction.
//
// ── STATE COVERAGE MOVED ─────────────────────────────────────────────────────────────────────────
// The signed-state mint/verify/tamper/expiry cases that used to live in THIS file (against this
// file's own now-removed `mintYouTubeOAuthState`/`parseYouTubeOAuthState`) moved to
// `oauth-state.test.ts` when the security follow-up that closed the state-replay gap consolidated
// LinkedIn's and YouTube's per-network signing code into the ONE shared `oauth-state.ts` module — see
// that file's own header. This file still proves `startYouTubeConnect`/`completeYouTubeConnect`
// work end to end (they call into the shared module transparently; their own signature is unchanged).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { withTenants, withGlobal, newId } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser } from "../../../testing/fixtures";
import { config } from "../../../config";
import {
  checkYouTubeConnectReadiness, startYouTubeConnect, completeYouTubeConnect,
  registerYouTubeTokenRefresher, buildYouTubeAuthorizeUrl,
} from "./youtube-oauth";
import { resolveActiveAccessToken, resetTokenRefreshers, purgeOAuthTokens } from "./oauth-tokens";
import { resetRetentionPurgers } from "../inbox-retention-job";
import { SocialPublisherError } from "./types";

const MODULES = { modules: ["social"] };

describe("SMM-38d · buildYouTubeAuthorizeUrl (pure, no key/DB needed)", () => {
  it("carries EXACTLY the upload + comment-read scopes (dossier §6.2 (a)/(b)) — never the broad " +
     "manage scope, never analytics, never anything DM-shaped (none exists)", () => {
    const url = buildYouTubeAuthorizeUrl("some-state");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("state")).toBe("some-state");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    const scopes = (parsed.searchParams.get("scope") ?? "").split(" ");
    expect(scopes.sort()).toEqual([
      "https://www.googleapis.com/auth/youtube.force-ssl",
      "https://www.googleapis.com/auth/youtube.upload",
    ]);
  });
});

describe.skipIf(!TEST_URL)("SMM-38d · YouTube connect readiness + the full start→callback round trip", () => {
  let orgSeq = 0;

  async function createClient(tenantId: string): Promise<string> {
    const id = newId();
    await withTenants([tenantId], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'youtube oauth client','central')`, [id, tenantId]));
    return id;
  }

  async function provisionOrg(tenantId: string, clientId: string): Promise<void> {
    orgSeq += 1;
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, postiz_org_id, api_key_ref, origin_site)
         VALUES ($1,$2,$3,$4,'env:KEY','central')`,
        [newId(), tenantId, clientId, `org-yt-${orgSeq}`],
      ), MODULES);
  }

  async function registerYouTubePlatformApp(): Promise<void> {
    // `social_platform_apps` is GLOBAL — no tenant_id, no RLS (design D-4) — so this is a
    // withGlobal write, not a tenant-scoped one.
    await withGlobal((c) =>
      c.query(
        `INSERT INTO social_platform_apps (id, network, app_name, review_status, credential_ref, origin_site)
         VALUES ($1,'youtube','Gaiada YouTube app (test)','sandbox','default','central')
         ON CONFLICT (network, app_name) DO NOTHING`,
        [newId()],
      ));
  }

  const originalKey = config.integrationTokenKey;
  const originalOwnBrand = config.social.publisher.ownBrandClientIds;
  const originalEnabledNetworks = config.social.publisher.enabledNetworks;
  const originalRedirect = config.social.direct.youtube.redirectUri;
  const originalClientId = config.social.direct.youtube.clientId;
  const originalClientSecret = config.social.direct.youtube.clientSecret;

  beforeAll(async () => {
    await initTestDb();
    await registerYouTubePlatformApp();
  });

  afterAll(async () => {
    config.integrationTokenKey = originalKey;
    config.social.publisher.ownBrandClientIds = originalOwnBrand;
    config.social.publisher.enabledNetworks = originalEnabledNetworks;
    config.social.direct.youtube.redirectUri = originalRedirect;
    config.social.direct.youtube.clientId = originalClientId;
    config.social.direct.youtube.clientSecret = originalClientSecret;
    await teardownTestDb();
  });

  beforeEach(() => {
    config.integrationTokenKey = Buffer.alloc(32, 9).toString("base64");
    // Default deployment config leaves 'youtube' OFF (design addendum: audit-locked, off by default)
    // — this suite deliberately turns it on so the readiness/round-trip cases below exercise the
    // REAL logic rather than tripping on network_disabled for every case.
    config.social.publisher.enabledNetworks = [...originalEnabledNetworks, "youtube"];
    config.social.direct.youtube.redirectUri = "https://erp.example.test/social/youtube/callback";
    config.social.direct.youtube.clientId = "test-client-id";
    config.social.direct.youtube.clientSecret = "test-client-secret";
    resetTokenRefreshers();
    resetRetentionPurgers();
  });

  it("checkYouTubeConnectReadiness refuses network_disabled when 'youtube' is not on " +
     "SOCIAL_NETWORKS_ENABLED — the deployment-level dial outranking everything else", async () => {
    const T = await createCompany("SMM-38d YouTube network-off", ["social"]);
    const clientId = await createClient(T);
    config.social.publisher.enabledNetworks = originalEnabledNetworks; // youtube NOT included
    const readiness = await checkYouTubeConnectReadiness(T, clientId);
    expect(readiness).toMatchObject({ ok: false, reason: "network_disabled" });
  });

  it("checkYouTubeConnectReadiness refuses client_connect_requires_signoff before any DB/network work " +
     "for a client not on the own-brand allow-list (OQ-3)", async () => {
    const T = await createCompany("SMM-38d YouTube A", ["social"]);
    const clientId = await createClient(T);
    config.social.publisher.ownBrandClientIds = [];
    const readiness = await checkYouTubeConnectReadiness(T, clientId);
    expect(readiness).toMatchObject({ ok: false, reason: "client_connect_requires_signoff" });
  });

  it("checkYouTubeConnectReadiness refuses platform_app_not_registered when the env creds are " +
     "empty, even if a social_platform_apps row exists — reuses SMM-07's exact token", async () => {
    const T = await createCompany("SMM-38d YouTube B", ["social"]);
    const clientId = await createClient(T);
    config.social.publisher.ownBrandClientIds = [clientId];
    config.social.direct.youtube.clientId = "";
    const readiness = await checkYouTubeConnectReadiness(T, clientId);
    expect(readiness).toMatchObject({ ok: false, reason: "platform_app_not_registered" });
  });

  it("checkYouTubeConnectReadiness is ok when every fact holds: network enabled, own-brand, creds " +
     "present, app registered, publisher org provisioned", async () => {
    const T = await createCompany("SMM-38d YouTube C", ["social"]);
    const clientId = await createClient(T);
    await provisionOrg(T, clientId);
    config.social.publisher.ownBrandClientIds = [clientId];
    const readiness = await checkYouTubeConnectReadiness(T, clientId);
    expect(readiness).toEqual({ ok: true });
  });

  it("start → complete: a pending social_accounts row is created, then promoted to connected, and " +
     "the sealed grant is resolvable through resolveActiveAccessToken", async () => {
    const T = await createCompany("SMM-38d YouTube D", ["social"]);
    const clientId = await createClient(T);
    await provisionOrg(T, clientId);
    config.social.publisher.ownBrandClientIds = [clientId];

    const started = await startYouTubeConnect(T, { clientId, handle: "@gaiada", actorId: null });
    expect(started.resumed).toBe(false);
    expect(started.authorizeUrl).toContain("test-client-id");

    const { rows: pending } = await withTenants([T], (c) =>
      c.query(`SELECT status, network, handle FROM social_accounts WHERE id = $1`, [started.accountId]), MODULES);
    expect(pending[0]).toMatchObject({ status: "pending", network: "youtube", handle: "@gaiada" });

    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ access_token: "yt-at-1", refresh_token: "yt-rt-1", expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl" }),
      { status: 200 },
    )) as unknown as typeof fetch;

    const actorId = await createUser("yt-connector@example.test");
    const completed = await completeYouTubeConnect(T, started.accountId, { code: "auth-code-1", actorId, fetchImpl });
    expect(completed).toEqual({ accountId: started.accountId, status: "connected" });

    const { rows: connected } = await withTenants([T], (c) =>
      c.query(`SELECT status, connected_by, platform_app_id, postiz_integration_id FROM social_accounts WHERE id = $1`, [started.accountId]), MODULES);
    expect(connected[0].status).toBe("connected");
    expect(connected[0].connected_by).toBe(actorId);
    expect(connected[0].platform_app_id).not.toBeNull();
    // SMM-38 phase 38e — the SAME gap `linkedin-oauth.test.ts` pins, network swapped: see that
    // file's own comment on this exact assertion.
    expect(connected[0].postiz_integration_id).toBe("direct:youtube");

    const resolved = await withTenants([T], (c) => resolveActiveAccessToken(c, started.accountId));
    expect(resolved.secret()).toBe("yt-at-1");
  });

  it("a second call to startYouTubeConnect for the SAME (client, handle) resumes the SAME row, " +
     "never a second one", async () => {
    const T = await createCompany("SMM-38d YouTube E", ["social"]);
    const clientId = await createClient(T);
    await provisionOrg(T, clientId);
    config.social.publisher.ownBrandClientIds = [clientId];

    const first = await startYouTubeConnect(T, { clientId, handle: "@resume-me", actorId: null });
    const second = await startYouTubeConnect(T, { clientId, handle: "@resume-me", actorId: null });
    expect(second.accountId).toBe(first.accountId);
    expect(second.resumed).toBe(true);

    const { rows } = await withTenants([T], (c) =>
      c.query(`SELECT count(*)::int AS n FROM social_accounts WHERE tenant_id = $1 AND client_id = $2 AND handle = '@resume-me'`, [T, clientId]), MODULES);
    expect(rows[0].n).toBe(1);
  });

  it("registerYouTubeTokenRefresher wires a real refresher into oauth-tokens.ts's seam — proven " +
     "by driving purgeOAuthTokens's refresh-ahead pass against a stub token endpoint", async () => {
    const T = await createCompany("SMM-38d YouTube F", ["social"]);
    const clientId = await createClient(T);
    await provisionOrg(T, clientId);
    config.social.publisher.ownBrandClientIds = [clientId];

    const started = await startYouTubeConnect(T, { clientId, handle: "@refresh-me", actorId: null });
    const initialExchange = vi.fn(async () => new Response(
      JSON.stringify({ access_token: "yt-at-old", refresh_token: "yt-rt-old", expires_in: 60 }), { status: 200 },
    )) as unknown as typeof fetch;
    await completeYouTubeConnect(T, started.accountId, { code: "auth-code-2", actorId: null, fetchImpl: initialExchange });

    const refreshFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("yt-rt-old");
      return new Response(JSON.stringify({ access_token: "yt-at-new", refresh_token: "yt-rt-new", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", refreshFetch);
    try {
      registerYouTubeTokenRefresher();
      const counts = await withTenants([T], (c) => purgeOAuthTokens(c, T, new Date(), 24 * 3600 * 1000), MODULES);
      expect(counts.refreshed).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }

    const resolved = await withTenants([T], (c) => resolveActiveAccessToken(c, started.accountId));
    expect(resolved.secret()).toBe("yt-at-new");
  });

  it("completeYouTubeConnect refuses org_not_provisioned for an accountId that does not belong to " +
     "this tenant — the state signature names a tenant, but the row is still the last word, checked " +
     "BEFORE the single-use `code` is ever spent on an exchange", async () => {
    const T = await createCompany("SMM-38d YouTube G", ["social"]);
    await expect(
      completeYouTubeConnect(T, newId(), { code: "auth-code-3", actorId: null }),
    ).rejects.toBeInstanceOf(SocialPublisherError);
  });
});
