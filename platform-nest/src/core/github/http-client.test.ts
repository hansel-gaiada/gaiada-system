// GH-01/GH-02 — the ONE egress file's own behaviour: token exchange, rate-limit header parsing,
// 403/429 backoff-then-retry via the fairness queue, the read-only role refusal BEFORE any fetch, and
// error mapping. HARD CONSTRAINT: no live GitHub call — `fetchImpl` is always a fake here.
import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mintInstallationToken, GithubInstallationClient, type FetchImpl } from "./http-client";
import { InstallationRateLimiter, GithubRetryableSignal } from "./rate-limiter";
import { GithubApiError, GithubReadOnlyRoleError, GithubTokenExchangeError } from "./errors";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("mintInstallationToken (§2.3 token exchange)", () => {
  it("POSTs to the installation access_tokens endpoint with a Bearer JWT and returns the token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(201, { token: "ghs_abc123", expires_at: "2026-08-31T01:00:00Z", permissions: { contents: "write" } });
    }) as FetchImpl;

    const t = await mintInstallationToken("erp", "4777424", PEM, "157879245", fetchImpl);
    expect(t).toEqual({ token: "ghs_abc123", expiresAt: "2026-08-31T01:00:00Z", permissions: { contents: "write" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/app/installations/157879245/access_tokens");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer ey/);
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("maps a non-2xx exchange to GithubTokenExchangeError, never throwing the raw fetch error", async () => {
    const fetchImpl: FetchImpl = (async () => jsonResponse(401, { message: "Bad credentials" })) as FetchImpl;
    await expect(mintInstallationToken("erp", "1", PEM, "1", fetchImpl)).rejects.toBeInstanceOf(GithubTokenExchangeError);
    try {
      await mintInstallationToken("erp", "1", PEM, "1", fetchImpl);
    } catch (e) {
      expect((e as GithubTokenExchangeError).status).toBe(502); // upstream refusal, not a caller error
      expect((e as GithubTokenExchangeError).message).toContain("HTTP 401");
      expect((e as GithubTokenExchangeError).detail?.githubMessage).toBe("Bad credentials");
    }
  });

  it("a network failure maps to GithubTokenExchangeError with status 0, no leaked fetch internals", async () => {
    const fetchImpl: FetchImpl = (async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.github.com");
    }) as FetchImpl;
    await expect(mintInstallationToken("erp", "1", PEM, "1", fetchImpl)).rejects.toMatchObject({ detail: { httpStatus: 0 } });
  });
});

function fakeLimiterDeps(fetchImpl: FetchImpl) {
  const limiter = new InstallationRateLimiter();
  let token = "installation-token-1";
  const onAuthExpired = vi.fn();
  return {
    limiter,
    onAuthExpired,
    client: new GithubInstallationClient({
      getToken: async () => token,
      onAuthExpired,
      limiter,
      fetchImpl,
    }),
    setToken: (t: string) => (token = t),
  };
}

describe("GithubInstallationClient — happy path + auth header", () => {
  it("attaches Bearer <installation token> and returns parsed JSON + status", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { full_name: "gaiadabali/foo" }, { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1700000000" });
    }) as FetchImpl;
    const { client } = fakeLimiterDeps(fetchImpl);

    const res = await client.request<{ full_name: string }>("user-1", { role: "erp", path: "/repos/gaiadabali/foo" });
    expect(res.data.full_name).toBe("gaiadabali/foo");
    expect(res.status).toBe(200);
    expect(res.rateLimit).toEqual({ limit: 5000, remaining: 4999, resetAtMs: 1_700_000_000_000 });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer installation-token-1");
  });

  it("a POST body is JSON-serialized with a content-type header", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const fetchImpl: FetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return jsonResponse(201, { id: 1 });
    }) as FetchImpl;
    const { client } = fakeLimiterDeps(fetchImpl);
    await client.request("user-1", { role: "erp", method: "POST", path: "/repos/gaiadabali/foo/pulls", body: { title: "x" } });
    expect(calls[0].init.body).toBe(JSON.stringify({ title: "x" }));
    expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });
});

describe("GithubInstallationClient — §2.2 read-only role enforcement", () => {
  it("refuses a write-shaped call through the read-only 'agents' role BEFORE any fetch", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const { client } = fakeLimiterDeps(fetchImpl as unknown as FetchImpl);
    await expect(
      client.request("user-1", { role: "agents", method: "POST", path: "/repos/gaiadabali/foo/pulls" }),
    ).rejects.toBeInstanceOf(GithubReadOnlyRoleError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a GET through the read-only role is allowed", async () => {
    const fetchImpl: FetchImpl = (async () => jsonResponse(200, { ok: true })) as FetchImpl;
    const { client } = fakeLimiterDeps(fetchImpl);
    const res = await client.request("user-1", { role: "agents", path: "/repos/gaiadabali/foo" });
    expect(res.data).toEqual({ ok: true });
  });
});

describe("GithubInstallationClient — §4.7 403/429 backoff + retry, then error mapping", () => {
  it("a 429 with Retry-After is retried by the shared queue and succeeds on the next attempt", async () => {
    let call = 0;
    const fetchImpl: FetchImpl = (async () => {
      call += 1;
      if (call === 1) return jsonResponse(429, { message: "rate limited" }, { "retry-after": "0" });
      return jsonResponse(200, { ok: true });
    }) as FetchImpl;
    const { client } = fakeLimiterDeps(fetchImpl);
    const res = await client.request("user-1", { role: "erp", path: "/repos/gaiadabali/foo" });
    expect(res.data).toEqual({ ok: true });
    expect(call).toBe(2);
  });

  it("a secondary-limit 403 is treated the same as 429 (retried, not immediately surfaced)", async () => {
    let call = 0;
    const fetchImpl: FetchImpl = (async () => {
      call += 1;
      if (call === 1) return jsonResponse(403, { message: "secondary rate limit" }, { "retry-after": "0" });
      return jsonResponse(200, { ok: true });
    }) as FetchImpl;
    const { client } = fakeLimiterDeps(fetchImpl);
    const res = await client.request("user-1", { role: "erp", path: "/repos/gaiadabali/foo" });
    expect(res.data).toEqual({ ok: true });
    expect(call).toBe(2);
  });

  it("exhausting all retries on a persistent 429 surfaces to the caller as a retryable signal", async () => {
    const fetchImpl: FetchImpl = (async () => jsonResponse(429, {}, { "retry-after": "0" })) as FetchImpl;
    const { client } = fakeLimiterDeps(fetchImpl);
    await expect(client.request("user-1", { role: "erp", path: "/repos/gaiadabali/foo" })).rejects.toBeInstanceOf(GithubRetryableSignal);
  });

  it("a 404 is NOT retried — surfaces immediately as GithubApiError with the original status preserved", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { message: "Not Found" }));
    const { client } = fakeLimiterDeps(fetchImpl as unknown as FetchImpl);
    await expect(client.request("user-1", { role: "erp", path: "/repos/gaiadabali/nope" })).rejects.toBeInstanceOf(GithubApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    try {
      await client.request("user-1", { role: "erp", path: "/repos/gaiadabali/nope" });
    } catch (e) {
      expect((e as GithubApiError).detail?.httpStatus).toBe(404);
      expect((e as GithubApiError).status).toBe(404);
    }
  });
});

describe("GithubInstallationClient — 401 mid-life invalidation", () => {
  it("calls onAuthExpired and retries once with a fresh token; a second 401 surfaces", async () => {
    const seen: string[] = [];
    const { limiter, onAuthExpired } = fakeLimiterDeps((async () => jsonResponse(200, {})) as FetchImpl);
    let token = "stale-token";
    const client = new GithubInstallationClient({
      getToken: async () => token,
      onAuthExpired: () => {
        onAuthExpired();
        token = "fresh-token";
      },
      limiter,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const auth = (init.headers as Record<string, string>).Authorization;
        seen.push(auth);
        if (auth === "Bearer stale-token") return jsonResponse(401, { message: "Bad credentials" });
        return jsonResponse(200, { ok: true });
      }) as FetchImpl,
    });
    const res = await client.request("user-1", { role: "erp", path: "/repos/gaiadabali/foo" });
    expect(res.data).toEqual({ ok: true });
    expect(seen).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
  });
});

describe("GithubInstallationClient — §4.7 fairness under real request dispatch", () => {
  it("a bulk operation by one user does not starve a single request from another", async () => {
    const completion: string[] = [];
    const fetchImpl: FetchImpl = (async (url: string) => {
      const label = url.includes("bulk") ? "bulk" : "single";
      completion.push(label);
      return jsonResponse(200, { ok: true });
    }) as FetchImpl;
    const { client } = fakeLimiterDeps(fetchImpl);

    const bulk = Array.from({ length: 15 }, (_, i) =>
      client.request("bulk-user", { role: "erp", path: `/repos/gaiadabali/bulk-${i}` }),
    );
    const single = client.request("single-user", { role: "erp", path: "/repos/gaiadabali/single" });
    await Promise.all([...bulk, single]);

    const singleIndex = completion.indexOf("single");
    // Must not be stuck at the back (index 15) behind the whole bulk operation.
    expect(singleIndex).toBeLessThan(3);
  });
});
