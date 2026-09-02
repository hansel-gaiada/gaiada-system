// GH-01 §2.3/§4.1 — "cache the installation token IN MEMORY only, refresh at T-5min". These tests
// exercise the cache in isolation (a fake mint function, a fake clock) — no network, no DB.
import { describe, it, expect, vi } from "vitest";
import { InstallationTokenCache, type InstallationToken } from "./token-cache";

function tokenExpiringAt(iso: string, token = "tok-1"): InstallationToken {
  return { token, expiresAt: iso, permissions: { contents: "write" } };
}

describe("InstallationTokenCache", () => {
  it("mints on first use and reuses the cached token while it has headroom", async () => {
    let now = Date.parse("2026-08-31T00:00:00Z");
    const mint = vi.fn(async () => tokenExpiringAt("2026-08-31T01:00:00Z"));
    const cache = new InstallationTokenCache(mint, () => now);

    expect(await cache.getToken()).toBe("tok-1");
    now += 10 * 60 * 1000; // +10 min, well inside the 1h token life and outside the 5min refresh skew
    expect(await cache.getToken()).toBe("tok-1");
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("refreshes at T-5min, not merely at hard expiry", async () => {
    let now = Date.parse("2026-08-31T00:00:00Z");
    const mint = vi
      .fn()
      .mockResolvedValueOnce(tokenExpiringAt("2026-08-31T01:00:00Z", "tok-1"))
      .mockResolvedValueOnce(tokenExpiringAt("2026-08-31T02:00:00Z", "tok-2"));
    const cache = new InstallationTokenCache(mint, () => now);

    expect(await cache.getToken()).toBe("tok-1");
    // 56 minutes in: 4 minutes of headroom left, inside the 5-minute skew -> must remint.
    now = Date.parse("2026-08-31T00:56:00Z");
    expect(await cache.getToken()).toBe("tok-2");
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers at an expired boundary collapse into ONE mint call", async () => {
    const now = Date.parse("2026-08-31T00:56:00Z"); // inside the refresh skew for a token expiring at 01:00
    let resolveMint!: (t: InstallationToken) => void;
    const mint = vi.fn(
      () =>
        new Promise<InstallationToken>((resolve) => {
          resolveMint = resolve;
        }),
    );
    const cache = new InstallationTokenCache(mint, () => now);

    const p1 = cache.getToken();
    const p2 = cache.getToken();
    const p3 = cache.getToken();
    expect(mint).toHaveBeenCalledTimes(1); // not 3 — in-flight de-duplication

    resolveMint(tokenExpiringAt("2026-08-31T02:00:00Z", "tok-shared"));
    expect(await p1).toBe("tok-shared");
    expect(await p2).toBe("tok-shared");
    expect(await p3).toBe("tok-shared");
  });

  it("invalidate() forces the next getToken() to remint even with clock headroom left", async () => {
    let now = Date.parse("2026-08-31T00:00:00Z");
    const mint = vi
      .fn()
      .mockResolvedValueOnce(tokenExpiringAt("2026-08-31T01:00:00Z", "tok-1"))
      .mockResolvedValueOnce(tokenExpiringAt("2026-08-31T02:00:00Z", "tok-2"));
    const cache = new InstallationTokenCache(mint, () => now);
    expect(await cache.getToken()).toBe("tok-1");
    cache.invalidate();
    expect(await cache.getToken()).toBe("tok-2");
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("diagnostics() exposes ONLY hasToken + expiresAt — never the token string itself", async () => {
    const now = Date.parse("2026-08-31T00:00:00Z");
    const cache = new InstallationTokenCache(async () => tokenExpiringAt("2026-08-31T01:00:00Z"), () => now);
    expect(cache.diagnostics()).toEqual({ hasToken: false, expiresAt: null });
    await cache.getToken();
    const d = cache.diagnostics();
    expect(d).toEqual({ hasToken: true, expiresAt: "2026-08-31T01:00:00.000Z" });
    expect(JSON.stringify(d)).not.toContain("tok-1");
  });

  it("a mint failure propagates to the caller and does NOT poison the cache for the next attempt", async () => {
    const now = Date.parse("2026-08-31T00:00:00Z");
    const mint = vi
      .fn()
      .mockRejectedValueOnce(new Error("github token exchange failed"))
      .mockResolvedValueOnce(tokenExpiringAt("2026-08-31T01:00:00Z", "tok-recovered"));
    const cache = new InstallationTokenCache(mint, () => now);
    await expect(cache.getToken()).rejects.toThrow("github token exchange failed");
    expect(await cache.getToken()).toBe("tok-recovered");
  });
});
