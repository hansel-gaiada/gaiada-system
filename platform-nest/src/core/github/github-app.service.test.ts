// GH-01/GH-02 — the wiring test for the single chokepoint (§4.1): credential-store + jwt +
// token-cache + rate-limiter + http-client, assembled exactly as production does. `loadAppCredentialOrThrow`
// is mocked (it needs Postgres — credential-store.test.ts already covers the vault half against a
// real DB); `fetch` is stubbed globally (hard constraint: no live GitHub calls). Everything else here
// — the JWT actually being minted, the token actually being cached, the fairness queue actually
// running — is the REAL production code.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { config } from "../../config";
import * as credentialStore from "./credential-store";
import { githubRequest, sealGithubAppCredential, githubAdminDetail, resetGithubRuntimesForTest } from "./github-app.service";
import { GithubNotConfiguredError, GithubRateLimitedError } from "./errors";

vi.mock("./credential-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credential-store")>();
  return { ...actual, loadAppCredentialOrThrow: vi.fn(), sealAppCredential: vi.fn() };
});

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const TENANT = "tenant-1";

const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

beforeEach(() => {
  resetGithubRuntimesForTest();
  config.githubApps.erp = { appId: "4777424", installationId: "157879245" };
  config.githubApps.agents = { appId: "4777699", installationId: "157885994" };
  vi.mocked(credentialStore.loadAppCredentialOrThrow).mockResolvedValue({
    connectionId: "conn-1", appId: "4777424", installationId: "157879245", privateKeyPem: PEM,
  });
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  resetGithubRuntimesForTest();
});

describe("githubRequest — end-to-end wiring (mint -> cache -> fairness -> fetch)", () => {
  it("mints a real JWT, exchanges it, caches the installation token, and calls the API", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/access_tokens")) {
        const auth = (init.headers as Record<string, string>).Authorization;
        expect(auth).toMatch(/^Bearer ey/); // a real RS256 JWT, not a placeholder
        return jsonResponse(201, { token: "ghs_live1", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      return jsonResponse(200, { full_name: "gaiadabali/foo" }, { "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000" });
    }) as unknown as typeof fetch;

    const res = await githubRequest<{ full_name: string }>(TENANT, "erp", "user-1", { path: "/repos/gaiadabali/foo" });
    expect(res.data.full_name).toBe("gaiadabali/foo");
    expect(calls).toEqual([
      "https://api.github.com/app/installations/157879245/access_tokens",
      "https://api.github.com/repos/gaiadabali/foo",
    ]);
  });

  it("a second call reuses the cached installation token — only ONE token-exchange call total", async () => {
    let exchanges = 0;
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith("/access_tokens")) {
        exchanges += 1;
        return jsonResponse(201, { token: "ghs_live1", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;

    await githubRequest(TENANT, "erp", "user-1", { path: "/repos/gaiadabali/a" });
    await githubRequest(TENANT, "erp", "user-1", { path: "/repos/gaiadabali/b" });
    expect(exchanges).toBe(1);
  });

  it("erp and agents are independent buckets — a mint for one role never touches the other's cache", async () => {
    const exchangedInstallations: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      const m = /installations\/(\d+)\/access_tokens/.exec(String(url));
      if (m) {
        exchangedInstallations.push(m[1]);
        return jsonResponse(201, { token: `tok-${m[1]}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;

    vi.mocked(credentialStore.loadAppCredentialOrThrow).mockImplementation(async (_tenant, role) =>
      role === "erp"
        ? { connectionId: "c1", appId: "4777424", installationId: "157879245", privateKeyPem: PEM }
        : { connectionId: "c2", appId: "4777699", installationId: "157885994", privateKeyPem: PEM },
    );

    await githubRequest(TENANT, "erp", "user-1", { path: "/repos/gaiadabali/a" });
    await githubRequest(TENANT, "agents", "user-1", { path: "/repos/gaiadabali/a" });
    expect(exchangedInstallations.sort()).toEqual(["157879245", "157885994"]);
  });

  it("propagates GithubNotConfiguredError when config.githubApps has no identity for the role", async () => {
    config.githubApps.erp = { appId: "", installationId: "" };
    global.fetch = vi.fn() as unknown as typeof fetch;
    await expect(githubRequest(TENANT, "erp", "user-1", { path: "/repos/gaiadabali/a" })).rejects.toBeInstanceOf(
      GithubNotConfiguredError,
    );
    expect(global.fetch).not.toHaveBeenCalled(); // fails before any egress
  });

  it("exhausting the fairness queue's retry budget surfaces GithubRateLimitedError, never the internal signal type", async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith("/access_tokens")) {
        return jsonResponse(201, { token: "ghs_live1", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      return jsonResponse(429, { message: "rate limited" }, { "retry-after": "0" });
    }) as unknown as typeof fetch;

    await expect(githubRequest(TENANT, "erp", "user-1", { path: "/repos/gaiadabali/a" })).rejects.toBeInstanceOf(
      GithubRateLimitedError,
    );
  });
});

describe("sealGithubAppCredential — rotation invalidates the cache", () => {
  it("invalidates a role's cached token immediately after a re-seal, before the next call", async () => {
    let exchanges = 0;
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith("/access_tokens")) {
        exchanges += 1;
        return jsonResponse(201, { token: `tok-${exchanges}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;

    await githubRequest(TENANT, "erp", "user-1", { path: "/repos/gaiadabali/a" });
    expect(exchanges).toBe(1);

    vi.mocked(credentialStore.sealAppCredential).mockResolvedValue({
      id: "conn-1", tenantId: TENANT, ownerKind: "github_app", ownerId: "0564b82a-cfc5-57ea-b00e-22ffe2d4c743",
      provider: "github", externalAccount: "gaiada-erp", scopes: ["read", "write"], status: "linked",
      hasToken: true, hasRefreshToken: false, tokenExpiresAt: null, tokenKeyVersion: "v1", meta: {},
      createdBy: null, originSite: "test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await sealGithubAppCredential(TENANT, "erp", { appId: "4777424", installationId: "157879245", privateKeyPem: PEM, createdBy: null });

    await githubRequest(TENANT, "erp", "user-1", { path: "/repos/gaiadabali/b" });
    expect(exchanges).toBe(2); // re-minted, not reused from before the rotation
  });
});

describe("githubAdminDetail — §4.7 quota surfacing", () => {
  it("reports both roles, unconfigured before any credential/config exists", () => {
    config.githubApps.erp = { appId: "", installationId: "" };
    config.githubApps.agents = { appId: "", installationId: "" };
    const detail = githubAdminDetail(TENANT);
    expect(detail.map((d) => d.role)).toEqual(["erp", "agents"]);
    expect(detail.every((d) => !d.configured)).toBe(true);
    expect(detail.every((d) => !d.tokenCached)).toBe(true);
  });

  it("reflects the observed rate-limit snapshot and cached-token state after a real call", async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith("/access_tokens")) {
        return jsonResponse(201, { token: "ghs_live1", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      return jsonResponse(200, { ok: true }, { "x-ratelimit-remaining": "4321", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1700000000" });
    }) as unknown as typeof fetch;

    await githubRequest(TENANT, "erp", "user-1", { path: "/repos/gaiadabali/a" });
    const detail = githubAdminDetail(TENANT);
    const erp = detail.find((d) => d.role === "erp")!;
    expect(erp.configured).toBe(true);
    expect(erp.tokenCached).toBe(true);
    expect(erp.rateLimit).toEqual({ limit: 5000, remaining: 4321, resetAt: "2023-11-14T22:13:20.000Z" });
    expect(erp.readOnly).toBe(false);
    const agents = detail.find((d) => d.role === "agents")!;
    expect(agents.readOnly).toBe(true);
  });

  it("never includes a token string anywhere in the detail payload", async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith("/access_tokens")) {
        return jsonResponse(201, { token: "ghs_super_secret_value", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;
    await githubRequest(TENANT, "erp", "user-1", { path: "/repos/gaiadabali/a" });
    const json = JSON.stringify(githubAdminDetail(TENANT));
    expect(json).not.toContain("ghs_super_secret_value");
  });
});
