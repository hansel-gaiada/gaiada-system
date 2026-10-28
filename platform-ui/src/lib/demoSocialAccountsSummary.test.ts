import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-Sg: the demo store answers the client's accounts read back (BFF §63.10, §63.16), SIMULATED, deterministic, with the server's order of checks. The clock is
// pinned (Friday 16 October 2026, 04:00 UTC) before the store is imported, so "Last synced" is the hour before: 03:00 UTC. Only Date is faked.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { socialDemo } from "./demoSocial";
import { asAccountsSummary } from "./socialAccountsSummary";

const call = (method: string, tail: string, userId?: string) =>
  socialDemo(method, `/api/co-agency/modules/social/${tail}`, new URLSearchParams(), undefined, userId);
const summary = (eng: string) => asAccountsSummary(call("GET", `engagements/${eng}/accounts-summary`)?.json);
const NORTHWIND = "soc-eng-1";
const SPA = "soc-eng-3";
const HOTEL = "soc-eng-4";
const SYNCED = "2026-10-16T03:00:00.000Z";

describe("GET engagements/:engagementId/accounts-summary (demo)", () => {
  it("answers each of the spa's three simulated accounts with followers, a 30-day change, reach and the last sync, marked simulated", () => {
    const v = summary(SPA);
    expect(v.accounts.map((a) => a.network)).toEqual(["facebook", "instagram", "tiktok"]);
    for (const a of v.accounts) {
      expect(a).toMatchObject({ simulated: true, source: "simulated", lastSyncedAt: SYNCED });
      expect(a.followers).toBeGreaterThan(0);
      expect(a.followersDelta30d).toBeGreaterThan(0);
      expect(a.reach30d).toBeGreaterThan(0);
      expect(a.impressions30d as number).toBeGreaterThan(a.reach30d as number);
    }
    expect(v.simulated).toBe(true);
    expect(v.lastSyncedAt).toBe(SYNCED);
  });

  it("is deterministic (the same numbers on every read) and adds up its totals", () => {
    const a = summary(HOTEL);
    expect(summary(HOTEL)).toEqual(a);
    expect(a.totals.followers).toBe(a.accounts.reduce((n, x) => n + (x.followers as number), 0));
    expect(a.totals.reach30d).toBe(a.accounts.reduce((n, x) => n + (x.reach30d as number), 0));
    expect(summary(SPA).accounts[0].followers).not.toBe(a.accounts[0].followers); // another client's account, other numbers
  });

  it("leaves Northwind's expired TikTok account never synced: nulls and no source, so 'Not synced yet' is drivable; the others are synced", () => {
    const v = summary(NORTHWIND);
    const tiktok = v.accounts.find((a) => a.network === "tiktok")!;
    expect(tiktok).toMatchObject({ followers: null, followersDelta30d: null, reach30d: null, impressions30d: null, lastSyncedAt: null, source: null });
    expect(v.accounts.filter((a) => a.network !== "tiktok").every((a) => a.followers !== null && a.source === "simulated")).toBe(true);
    expect(v.totals.followers).toBe(v.accounts.reduce((n, x) => n + (x.followers ?? 0), 0));
  });

  it("refuses a client contact (403, before the engagement is looked at) and says 404 for an engagement that is not in the demo", () => {
    expect(call("GET", `engagements/${SPA}/accounts-summary`, "demo-client")?.status).toBe(403);
    expect(call("GET", "engagements/nope/accounts-summary", "demo-client")?.status).toBe(403);
    const r = call("GET", "engagements/nope/accounts-summary");
    expect(r?.status).toBe(404);
    expect(r?.json).toEqual({ error: "engagement_not_found" });
  });

  it("is a GET only", () => {
    expect(call("POST", `engagements/${SPA}/accounts-summary`)?.json ?? {}).not.toHaveProperty("accounts");
  });
});
