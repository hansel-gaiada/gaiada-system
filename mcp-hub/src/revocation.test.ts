import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "./config";
import { isRevoked, resetRevocationCache } from "./revocation";
import { mintPrincipal } from "./principal";

const linked = mintPrincipal({ provider: "whatsapp", externalId: "628110@c.us" });
const anon = mintPrincipal({});

function resolveStub(revoked: boolean) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ revoked }) })) as unknown as typeof fetch;
}

describe("D11 revocation check (WS2 §5)", () => {
  beforeEach(() => {
    resetRevocationCache();
    config.revocationCheck = true;
    config.platformUrl = "http://platform.test";
    config.revocationTtlMs = 60_000;
  });
  afterEach(() => {
    config.revocationCheck = true;
  });

  it("denies a revoked (verified-then-deactivated) identity", async () => {
    expect(await isRevoked(linked, resolveStub(true), 1000)).toBe(true);
  });

  it("allows a live identity", async () => {
    expect(await isRevoked(linked, resolveStub(false), 1000)).toBe(false);
  });

  it("never treats an anonymous principal as revoked (no elevated access to revoke)", async () => {
    const spy = resolveStub(true);
    expect(await isRevoked(anon, spy, 1000)).toBe(false);
    expect((spy as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0); // no platform call
  });

  it("caches within the TTL (one platform round-trip per window)", async () => {
    const spy = resolveStub(true);
    await isRevoked(linked, spy, 1000);
    await isRevoked(linked, spy, 1000 + 30_000); // within TTL
    expect((spy as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
    const revoked = await isRevoked(linked, spy, 1000 + 61_000); // TTL expired → refetch
    expect((spy as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
    expect(revoked).toBe(true);
  });

  it("fails open (not revoked) when the platform is unreachable, and does not cache the failure", async () => {
    const bad = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await isRevoked(linked, bad, 1000)).toBe(false);
    const ok = resolveStub(true);
    expect(await isRevoked(linked, ok, 1000)).toBe(true); // not masked by a cached failure
  });

  it("is a no-op when disabled", async () => {
    config.revocationCheck = false;
    const spy = resolveStub(true);
    expect(await isRevoked(linked, spy, 1000)).toBe(false);
    expect((spy as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});
