// GET /admin/digests (1b): auth (401/503), history shape (newest-first, capped), and the
// nextRun/timezone fields. ./schedule (runDigests) isn't touched — this route only reads
// digest-history.ts + next-run.ts, so no ./store mock is needed.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { buildApp } from "./server";
import { config } from "./config";
import { recordDigestRun, resetDigestHistoryCache, type DigestRecord } from "./digest-history";

const gw = { sendText: async () => {} };
const DIR = "data/test-admin-digests";

function entry(over: Partial<DigestRecord> = {}): DigestRecord {
  return {
    ts: Date.now(),
    slot: "noon",
    trigger: "scheduled",
    groupsCovered: 2,
    delivered: 2,
    failed: 0,
    managementDelivered: true,
    ...over,
  };
}

describe("GET /admin/digests", () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    config.adminToken = "sekret";
    config.digestHistoryFile = `${DIR}/digest-history.json`;
    config.scheduleTimezone = "Asia/Singapore";
    resetDigestHistoryCache();
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("401s without the admin token", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/digests" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("503s when ADMIN_TOKEN is unset (fail-closed)", async () => {
    config.adminToken = "";
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/digests", headers: { authorization: "Bearer whatever" } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("returns {history, nextRun, timezone}; history is newest-first", async () => {
    recordDigestRun(entry({ ts: 1, slot: "noon" }));
    recordDigestRun(entry({ ts: 2, slot: "evening" }));

    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/digests", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      history: Array<{ slot: string; ts: number }>;
      nextRun: { noon: number | null; evening: number | null };
      timezone: string;
    };
    expect(body.history.map((h) => h.slot)).toEqual(["evening", "noon"]);
    expect(body.timezone).toBe("Asia/Singapore");
    expect(typeof body.nextRun.noon).toBe("number");
    expect(typeof body.nextRun.evening).toBe("number");
    await app.close();
  });

  it("empty history returns an empty array, not an error", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/digests", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { history: unknown[] }).history).toEqual([]);
    await app.close();
  });

  it("respects the `limit` querystring", async () => {
    for (let i = 0; i < 5; i++) recordDigestRun(entry({ ts: i }));
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/digests?limit=2", headers: { authorization: "Bearer sekret" } });
    expect((res.json() as { history: unknown[] }).history).toHaveLength(2);
    await app.close();
  });

  it("nextRun is null for an invalid timezone (fail-soft, no 500)", async () => {
    config.scheduleTimezone = "Not/AZone";
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/digests", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { nextRun: { noon: number | null; evening: number | null } };
    expect(body.nextRun).toEqual({ noon: null, evening: null });
    await app.close();
  });
});
