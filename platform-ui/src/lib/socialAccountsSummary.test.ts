import { describe, it, expect } from "vitest";
import { accountStatText, asAccountsSummary, countText, deltaText, lastSyncedText } from "./socialAccountsSummary";

// SCP-Sg: the accounts read back, as pure parsing and words. "Not reported" is never drawn as 0, and the simulator's numbers carry their mark.

const acct = (over: Record<string, unknown> = {}) => ({
  accountId: "a-1", network: "instagram", handle: "@mock-brand-alpha", simulated: true, followers: 12400, followersDelta30d: 250, reach30d: 18200, impressions30d: 25000,
  lastSyncedAt: "2026-10-28T02:00:00.000Z", source: "simulated", ...over,
});
const answer = (over: Record<string, unknown> = {}) => ({
  accounts: [acct()], totals: { followers: 12400, reach30d: 18200 }, simulated: true, lastSyncedAt: "2026-10-28T02:00:00.000Z", ...over,
});

describe("asAccountsSummary", () => {
  it("reads the contract's fields", () => {
    expect(asAccountsSummary(answer())).toEqual({
      accounts: [{
        accountId: "a-1", network: "instagram", handle: "@mock-brand-alpha", simulated: true, followers: 12400, followersDelta30d: 250, reach30d: 18200, impressions30d: 25000,
        lastSyncedAt: "2026-10-28T02:00:00.000Z", source: "simulated",
      }],
      totals: { followers: 12400, reach30d: 18200 }, simulated: true, lastSyncedAt: "2026-10-28T02:00:00.000Z",
    });
  });
  it("reads a missing, null or wrongly typed number as null, never 0, and keeps a reported zero", () => {
    const v = asAccountsSummary(answer({
      accounts: [acct({ followers: undefined, followersDelta30d: null, reach30d: "18200", impressions30d: Number.NaN }), acct({ accountId: "a-2", followers: 0, followersDelta30d: 0 })],
      totals: { followers: null }, lastSyncedAt: "",
    }));
    expect(v.accounts[0]).toMatchObject({ followers: null, followersDelta30d: null, reach30d: null, impressions30d: null });
    expect(v.accounts[1]).toMatchObject({ followers: 0, followersDelta30d: 0 });
    expect(v.totals).toEqual({ followers: null, reach30d: null });
    expect(v.lastSyncedAt).toBeNull();
  });
  it("marks an account simulated by its flag or its source, and the totals by the flag or any account's source, never by anything else", () => {
    expect(asAccountsSummary(answer({ accounts: [acct({ simulated: false, source: "simulated" })], simulated: false })).accounts[0].simulated).toBe(true);
    expect(asAccountsSummary(answer({ accounts: [acct({ simulated: false, source: "simulated" })], simulated: false })).simulated).toBe(true);
    const real = asAccountsSummary(answer({ accounts: [acct({ simulated: false, source: "pull" })], simulated: false }));
    expect(real.simulated).toBe(false);
    expect(real.accounts[0]).toMatchObject({ simulated: false, source: "pull" });
    expect(asAccountsSummary(answer({ accounts: [acct({ source: "nonsense", simulated: false })], simulated: false })).accounts[0].source).toBeNull();
  });
  it("throws on a body that is not an answer, so a wrong shape never reads as a client with no followers", () => {
    expect(() => asAccountsSummary(null)).toThrow();
    expect(() => asAccountsSummary({ accounts: [], totals: null })).toThrow();
    expect(() => asAccountsSummary({ accounts: "x", totals: {} })).toThrow();
    expect(() => asAccountsSummary({ accounts: [{ accountId: "a" }], totals: {} })).toThrow();
  });
});

describe("the words", () => {
  it("counts with separators and says the 30-day change with its sign", () => {
    expect(countText(1234567)).toBe("1,234,567");
    expect(deltaText(250)).toBe("+250 in 30 days");
    expect(deltaText(-1040)).toBe("-1,040 in 30 days");
    expect(deltaText(0)).toBe("no change in 30 days");
  });
  it("says the last sync in the display zone, or 'Not synced yet'", () => {
    expect(lastSyncedText("2026-10-28T02:00:00.000Z")).toBe("Last synced 28 Oct, 10:00");
    expect(lastSyncedText(null)).toBe("Not synced yet");
    expect(lastSyncedText(undefined)).toBe("Not synced yet");
    expect(lastSyncedText("")).toBe("Not synced yet");
  });
  it("says one account's numbers, 'Not synced yet' for one with nothing, and 'Followers not reported' for a sync that reported none", () => {
    expect(accountStatText({ followers: 12400, lastSyncedAt: "2026-10-28T02:00:00.000Z" })).toBe("12,400 followers · Last synced 28 Oct, 10:00");
    expect(accountStatText({ followers: null, lastSyncedAt: null })).toBe("Not synced yet");
    expect(accountStatText({ followers: null, lastSyncedAt: "2026-10-28T02:00:00.000Z" })).toBe("Followers not reported · Last synced 28 Oct, 10:00");
  });
});
