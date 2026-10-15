// DW-7h (BFF §52.6) — the four alert rules, edge by edge. Pure: no database, no Keycloak.
import { describe, it, expect } from "vitest";
import {
  computeAlerts, densestWindow, FAILED_SPAN_MS,
  type ActiveBlockHits, type AlertInput, type FailedSignIn, type SeenConnection,
} from "./security-alerts";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const MIN = 60_000;
const at = (minutesAgo: number) => NOW.getTime() - minutesAgo * MIN;

const fail = (minutesAgo: number, over: Partial<FailedSignIn> = {}): FailedSignIn => ({
  atMs: at(minutesAgo), ip: "203.0.113.9", userId: "u1", email: "a@ex.com", ...over,
});
const run = (over: Partial<AlertInput> = {}) =>
  computeAlerts({ now: NOW, window: "24h", signIns: "on", failed: [], seen: [], blocks: [], ...over });

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const seen = (daysAgo: number, over: Partial<SeenConnection> = {}): SeenConnection => ({
  userId: "u1", email: "a@ex.com", ip: "198.51.100.7", userAgent: CHROME_WIN,
  firstSeenAt: new Date(NOW.getTime() - daysAgo * 86_400_000), ...over,
});

describe("densestWindow (the sliding window)", () => {
  it("counts the most failures that fit in the span, inclusive of the span itself", () => {
    expect(densestWindow([0, 1, 2].map((m) => m * MIN), FAILED_SPAN_MS, 3)).toEqual({ count: 3, endMs: 2 * MIN });
    // exactly 15:00 apart is one window; one millisecond more is not
    expect(densestWindow([0, 15 * MIN], FAILED_SPAN_MS, 2)).toEqual({ count: 2, endMs: 15 * MIN });
    expect(densestWindow([0, 15 * MIN + 1], FAILED_SPAN_MS, 2)).toBeNull();
  });
  it("is order independent and keeps the latest of equally dense windows", () => {
    const t = [100 * MIN, 0, 1 * MIN, 101 * MIN];
    expect(densestWindow(t, FAILED_SPAN_MS, 2)).toEqual({ count: 2, endMs: 101 * MIN });
  });
  it("returns null for nothing", () => {
    expect(densestWindow([], FAILED_SPAN_MS, 1)).toBeNull();
  });
});

describe("failed_signins_account", () => {
  it("🔴 4 failures are NO alert; 5 inside 15 minutes are high", () => {
    expect(run({ failed: [1, 2, 3, 4].map((m) => fail(m)) }).filter((a) => a.kind === "failed_signins_account")).toEqual([]);
    const alerts = run({ failed: [1, 2, 3, 4, 5].map((m) => fail(m)) }).filter((a) => a.kind === "failed_signins_account");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "high", count: 5, subject: { userId: "u1", email: "a@ex.com" }, at: new Date(at(1)).toISOString(),
    });
  });

  it("the window slides: 5 failures straddling a clock quarter-hour still alert, 5 spread over 16 minutes do not", () => {
    // 11:46..11:58 minus bucket edges: spread over 14 minutes
    expect(run({ failed: [14, 10, 6, 3, 0].map((m) => fail(m)) }).some((a) => a.kind === "failed_signins_account")).toBe(true);
    // first and fifth are 16 minutes apart, and no five fit in any 15 minutes
    expect(run({ failed: [16, 12, 8, 4, 0].map((m) => fail(m)) }).some((a) => a.kind === "failed_signins_account")).toBe(false);
  });

  it("exactly 15:00 between the first and the fifth is an alert; 15:00.001 is not", () => {
    const exact = [15, 11, 7, 3, 0].map((m) => fail(m));
    expect(run({ failed: exact }).some((a) => a.kind === "failed_signins_account")).toBe(true);
    const over = [15, 11, 7, 3, 0].map((m, i) => (i === 0 ? { ...fail(m), atMs: at(15) - 1 } : fail(m)));
    expect(run({ failed: over }).some((a) => a.kind === "failed_signins_account")).toBe(false);
  });

  it("failures spread over an hour (5 in total, never 5 within 15 minutes) do not alert", () => {
    expect(run({ failed: [60, 45, 30, 15, 0].map((m) => fail(m)) }).some((a) => a.kind === "failed_signins_account")).toBe(false);
  });

  it("counts per account: 3 + 3 failures on two accounts are no alert", () => {
    const failed = [1, 2, 3].map((m) => fail(m)).concat([1, 2, 3].map((m) => fail(m, { userId: "u2", email: "b@ex.com" })));
    expect(run({ failed }).some((a) => a.kind === "failed_signins_account")).toBe(false);
  });

  it("an unknown account (userId null) never raises an account alert", () => {
    const failed = Array.from({ length: 8 }, (_, i) => fail(i + 1, { userId: null, email: null }));
    expect(run({ failed }).some((a) => a.kind === "failed_signins_account")).toBe(false);
  });

  it("only failures inside the window count (15m window ignores older ones)", () => {
    const failed = [4, 8, 12, 16, 19].map((m) => fail(m));
    expect(run({ failed, window: "15m" }).some((a) => a.kind === "failed_signins_account")).toBe(false);
    expect(run({ failed, window: "24h" }).some((a) => a.kind === "failed_signins_account")).toBe(true);
  });

  it("reports the densest window's size, even when more failures follow", () => {
    const failed = [1, 2, 3, 4, 5, 6, 7].map((m) => fail(m));
    expect(run({ failed }).find((a) => a.kind === "failed_signins_account")!.count).toBe(7);
  });
});

describe("failed_signins_ip", () => {
  const fromIp = (n: number, ip = "203.0.113.50", mk: (i: number) => Partial<FailedSignIn> = () => ({})) =>
    Array.from({ length: n }, (_, i) => fail(i + 1, { ip, ...mk(i) }));

  it("🔴 9 failures from one address are no alert; 10 inside 15 minutes are high", () => {
    expect(run({ failed: fromIp(9, "203.0.113.50", (i) => ({ userId: `u${i}`, email: `${i}@ex.com` })) }).some((a) => a.kind === "failed_signins_ip")).toBe(false);
    const alerts = run({ failed: fromIp(10, "203.0.113.50", (i) => ({ userId: `u${i}`, email: `${i}@ex.com` })) }).filter((a) => a.kind === "failed_signins_ip");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "high", count: 10, subject: { ip: "203.0.113.50" } });
  });

  it("counts members AND unknown accounts together (a password spray across names)", () => {
    const failed = fromIp(10, "203.0.113.50", (i) => (i % 2 ? { userId: null, email: null } : { userId: `u${i}`, email: `${i}@ex.com` }));
    expect(run({ failed }).some((a) => a.kind === "failed_signins_ip")).toBe(true);
  });

  it("spread over two addresses it does not alert, and an unknown address is never an address", () => {
    const failed = [...fromIp(6, "203.0.113.50"), ...fromIp(6, "203.0.113.51")];
    expect(run({ failed }).some((a) => a.kind === "failed_signins_ip")).toBe(false);
    expect(run({ failed: fromIp(12, "203.0.113.50", () => ({ ip: null })) }).some((a) => a.kind === "failed_signins_ip")).toBe(false);
  });

  it("an unknown-account alert carries no usernames anywhere", () => {
    const failed = fromIp(10, "203.0.113.50", () => ({ userId: null, email: null }));
    const text = JSON.stringify(run({ failed }));
    expect(text).toContain("203.0.113.50");
    expect(text).not.toContain("@");
  });
});

describe("sign-in rules need sign-ins", () => {
  it("off and unavailable run neither sign-in rule", () => {
    const failed = Array.from({ length: 12 }, (_, i) => fail(i + 1));
    for (const state of ["off", "unavailable"] as const) expect(run({ failed, signIns: state })).toEqual([]);
    expect(run({ failed }).length).toBe(2);
  });
  it("but the two rules that need no Keycloak still run", () => {
    const blocks: ActiveBlockHits[] = [{ ip: "203.0.113.77", hitCount: 4, lastHitAt: new Date(at(30)) }];
    expect(run({ signIns: "off", blocks }).map((a) => a.kind)).toEqual(["blocked_ip_hits"]);
  });
});

describe("new_device", () => {
  it("🔴 a known member's first connection from a new (address, device) pair inside the window is medium", () => {
    const rows = [seen(20), seen(0.2, { ip: "203.0.113.9", userAgent: SAFARI_IPHONE })];
    const a = run({ seen: rows }).filter((x) => x.kind === "new_device");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ severity: "medium", count: 1, subject: { userId: "u1", email: "a@ex.com", ip: "203.0.113.9" } });
    expect(a[0].detail).toContain("Safari / iOS");
  });

  it("a member whose first-ever connection is inside the window has nothing to be new against", () => {
    expect(run({ seen: [seen(0.2)] }).some((a) => a.kind === "new_device")).toBe(false);
  });

  it("the same pair that was seen before the window is not new (a new session from the usual place)", () => {
    const rows = [seen(20), seen(0.1, { firstSeenAt: new Date(NOW.getTime() - 0.1 * 86_400_000) })];
    // same address and same device, second row is another session
    expect(run({ seen: rows }).some((a) => a.kind === "new_device")).toBe(false);
  });

  it("a new address on the SAME device is new; a browser update on the same address is not", () => {
    expect(run({ seen: [seen(20), seen(0.2, { ip: "203.0.113.9" })] }).some((a) => a.kind === "new_device")).toBe(true);
    const updated = CHROME_WIN.replace("141.0.0.0", "142.0.0.0");
    expect(run({ seen: [seen(20), seen(0.2, { userAgent: updated })] }).some((a) => a.kind === "new_device")).toBe(false);
  });

  it("one alert per pair even over several sessions, and an unknown address makes none", () => {
    const rows = [seen(20), seen(0.3, { ip: "203.0.113.9" }), seen(0.2, { ip: "203.0.113.9" }), seen(0.1, { ip: null })];
    expect(run({ seen: rows }).filter((a) => a.kind === "new_device")).toHaveLength(1);
  });

  it("a pair first seen before the window start is outside this window (15m)", () => {
    const rows = [seen(20), seen(0.2, { ip: "203.0.113.9" })]; // first seen about 4.8 hours ago
    expect(run({ seen: rows, window: "15m" }).some((a) => a.kind === "new_device")).toBe(false);
    expect(run({ seen: rows, window: "24h" }).some((a) => a.kind === "new_device")).toBe(true);
  });
});

describe("blocked_ip_hits", () => {
  it("a block whose latest hit is inside the window is low, with the block's hit count", () => {
    const blocks: ActiveBlockHits[] = [{ ip: "203.0.113.77", hitCount: 1, lastHitAt: new Date(at(5)) }];
    const a = run({ blocks });
    expect(a).toEqual([
      expect.objectContaining({ kind: "blocked_ip_hits", severity: "low", count: 1, subject: { ip: "203.0.113.77" }, at: new Date(at(5)).toISOString() }),
    ]);
    expect(a[0].detail).toBe("The block on 203.0.113.77 has stopped 1 request");
  });
  it("no hits, or a latest hit before the window, is no alert", () => {
    expect(run({ blocks: [{ ip: "203.0.113.77", hitCount: 0, lastHitAt: null }] })).toEqual([]);
    expect(run({ blocks: [{ ip: "203.0.113.77", hitCount: 9, lastHitAt: new Date(at(25 * 60)) }] })).toEqual([]);
  });
});

describe("ordering", () => {
  it("newest first, across kinds", () => {
    const failed = [1, 2, 3, 4, 5].map((m) => fail(m)); // at = 1 minute ago
    const blocks: ActiveBlockHits[] = [{ ip: "203.0.113.77", hitCount: 2, lastHitAt: new Date(at(30)) }];
    const rows = [seen(20), seen(0.01, { ip: "203.0.113.9" })]; // 14.4 minutes ago
    expect(run({ failed, blocks, seen: rows }).map((a) => a.kind)).toEqual(["failed_signins_account", "new_device", "blocked_ip_hits"]);
  });
  it("nothing in, nothing out", () => {
    expect(run()).toEqual([]);
  });
});
