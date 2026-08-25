import { describe, it, expect } from "vitest";
import {
  formatBytes, topTalkers, egressByCountry, summarizeThreats, isFeedStale, describeFeed,
  describeExpiry, canProposeIsolation,
  type TrafficRollup, type NetworkThreat, type FeedRun,
} from "./network";

const roll = (over: Partial<TrafficRollup>): TrafficRollup => ({
  deviceId: over.deviceId !== undefined ? over.deviceId : "d1",
  deviceName: over.deviceName ?? "GDA-01",
  ip: over.ip !== undefined ? over.ip : "10.10.0.10",
  destAsn: over.destAsn !== undefined ? over.destAsn : "AS15169",
  destCountry: over.destCountry !== undefined ? over.destCountry : "US",
  app: over.app ?? "HTTPS",
  bytesIn: over.bytesIn ?? 0,
  bytesOut: over.bytesOut ?? 0,
  sessions: over.sessions ?? 1,
});

const threat = (over: Partial<NetworkThreat>): NetworkThreat => ({
  id: over.id ?? "t", occurredAt: over.occurredAt ?? "2026-08-25T00:00:00Z",
  severity: over.severity ?? "high", signature: over.signature ?? "SIG",
  srcIp: over.srcIp ?? "10.10.0.10", dstIp: over.dstIp ?? "1.1.1.1",
  direction: over.direction ?? "outbound",
  deviceId: over.deviceId !== undefined ? over.deviceId : "d1",
  deviceName: over.deviceName !== undefined ? over.deviceName : "GDA-01",
  action: over.action ?? "detected", triageState: over.triageState ?? "new",
});

describe("formatBytes", () => {
  it("scales through binary units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3 * 2.5)).toBe("2.5 GB");
  });
  it("drops the decimal above 100 so columns stay narrow", () => {
    expect(formatBytes(1024 * 250)).toBe("250 KB");
  });
  it("returns a dash for nonsense rather than NaN", () => {
    expect(formatBytes(NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("topTalkers", () => {
  it("collapses rollups per device and ranks on in+out combined", () => {
    const t = topTalkers([
      roll({ deviceId: "a", deviceName: "A", bytesIn: 100, bytesOut: 0, destAsn: "AS1" }),
      roll({ deviceId: "a", deviceName: "A", bytesIn: 100, bytesOut: 0, destAsn: "AS2" }),
      roll({ deviceId: "b", deviceName: "B", bytesIn: 0, bytesOut: 150, destAsn: "AS1" }),
    ]);
    expect(t.map((x) => x.deviceName)).toEqual(["A", "B"]);
    expect(t[0].total).toBe(200);
    expect(t[0].destinations).toBe(2);
  });

  // The reason the ranking is on the sum: a host that is quiet outbound but loud inbound (pulling a
  // payload) must not be sorted below one that is merely busy. Ranking on bytesOut alone would put
  // B first here and hide A entirely at limit=1.
  it("does not let an outbound-heavy host outrank a larger inbound-heavy one", () => {
    const t = topTalkers([
      roll({ deviceId: "a", deviceName: "A", bytesIn: 900, bytesOut: 0 }),
      roll({ deviceId: "b", deviceName: "B", bytesIn: 0, bytesOut: 400 }),
    ], 1);
    expect(t).toHaveLength(1);
    expect(t[0].deviceName).toBe("A");
  });

  it("keys unregistered hosts on IP so they are not merged into one row", () => {
    const t = topTalkers([
      roll({ deviceId: null, deviceName: "Unregistered host", ip: "10.10.2.1", bytesIn: 10 }),
      roll({ deviceId: null, deviceName: "Unregistered host", ip: "10.10.2.2", bytesIn: 20 }),
    ]);
    expect(t).toHaveLength(2);
  });
});

describe("egressByCountry", () => {
  it("sums volume and counts distinct devices per country, ranked by bytes", () => {
    const e = egressByCountry([
      roll({ deviceId: "a", destCountry: "US", bytesIn: 100, sessions: 2 }),
      roll({ deviceId: "b", destCountry: "US", bytesOut: 100, sessions: 3 }),
      roll({ deviceId: "a", destCountry: "CN", bytesOut: 500, sessions: 9 }),
    ]);
    expect(e[0]).toEqual({ country: "CN", bytes: 500, sessions: 9, devices: 1 });
    expect(e[1]).toEqual({ country: "US", bytes: 200, sessions: 5, devices: 2 });
  });

  it("buckets a missing country as Unknown rather than dropping the row", () => {
    const e = egressByCountry([roll({ destCountry: null, bytesIn: 5 }), roll({ destCountry: "  ", bytesIn: 5 })]);
    expect(e).toEqual([{ country: "Unknown", bytes: 10, sessions: 2, devices: 1 }]);
  });
});

describe("summarizeThreats", () => {
  it("counts open as new + investigating only", () => {
    const s = summarizeThreats([
      threat({ triageState: "new" }),
      threat({ triageState: "investigating" }),
      threat({ triageState: "resolved" }),
      threat({ triageState: "false_positive" }),
    ]);
    expect(s.total).toBe(4);
    expect(s.open).toBe(2);
  });

  it("splits blocked from detected", () => {
    const s = summarizeThreats([
      threat({ action: "blocked" }), threat({ action: "detected" }), threat({ action: "detected" }),
    ]);
    expect(s.blocked).toBe(1);
    expect(s.detected).toBe(2);
  });

  it("tallies severities", () => {
    const s = summarizeThreats([threat({ severity: "critical" }), threat({ severity: "low" }), threat({ severity: "low" })]);
    expect(s.bySeverity).toEqual({ critical: 1, high: 0, medium: 0, low: 2 });
  });
});

describe("isFeedStale", () => {
  const now = new Date("2026-08-25T12:00:00Z");
  const run = (over: Partial<FeedRun>): FeedRun => ({
    startedAt: null, finishedAt: null, ok: true, error: null, ...over,
  });

  // The whole point of the function: silence must never read as health.
  it("treats no run at all as stale", () => {
    expect(isFeedStale(null, now)).toBe(true);
  });
  it("treats a failed run as stale even if recent", () => {
    expect(isFeedStale(run({ finishedAt: "2026-08-25T11:59:00Z", ok: false }), now)).toBe(true);
  });
  it("treats a run with no timestamp as stale", () => {
    expect(isFeedStale(run({ ok: true }), now)).toBe(true);
  });
  it("accepts a fresh successful run", () => {
    expect(isFeedStale(run({ finishedAt: "2026-08-25T11:55:00Z" }), now)).toBe(false);
  });
  it("goes stale past the threshold", () => {
    expect(isFeedStale(run({ finishedAt: "2026-08-25T11:40:00Z" }), now)).toBe(true);
  });
});

describe("describeFeed", () => {
  const now = new Date("2026-08-25T12:00:00Z");
  it("words the relative age", () => {
    expect(describeFeed(null, now)).toBe("never");
    expect(describeFeed({ startedAt: null, finishedAt: "2026-08-25T11:59:40Z", ok: true, error: null }, now)).toBe("just now");
    expect(describeFeed({ startedAt: null, finishedAt: "2026-08-25T11:45:00Z", ok: true, error: null }, now)).toBe("15 min ago");
    expect(describeFeed({ startedAt: null, finishedAt: "2026-08-25T09:00:00Z", ok: true, error: null }, now)).toBe("3h ago");
    expect(describeFeed({ startedAt: null, finishedAt: "2026-08-22T12:00:00Z", ok: true, error: null }, now)).toBe("3d ago");
  });
});

describe("describeExpiry", () => {
  const now = new Date("2026-08-25T12:00:00Z");
  it("counts down while in force", () => {
    expect(describeExpiry("2026-08-25T12:30:00Z", now)).toBe("30 min left");
    expect(describeExpiry("2026-08-25T15:00:00Z", now)).toBe("3h left");
  });
  // A lapsed isolation protects nothing. Rendering "-14 min left" would invite the reader to think
  // it is still holding.
  it("says expired rather than showing a negative duration", () => {
    expect(describeExpiry("2026-08-25T11:46:00Z", now)).toBe("expired");
  });
  it("handles a missing expiry", () => {
    expect(describeExpiry(null, now)).toBe("no expiry");
  });
});

describe("canProposeIsolation", () => {
  // There is nothing of ours to quarantine when the attacker is outside the perimeter.
  it("refuses an inbound threat", () => {
    expect(canProposeIsolation(threat({ direction: "inbound" }))).toBe(false);
  });
  it("refuses a host with no registry row", () => {
    expect(canProposeIsolation(threat({ deviceId: null }))).toBe(false);
  });
  it("refuses a protected IP", () => {
    expect(canProposeIsolation(threat({ srcIp: "10.10.0.1" }), ["10.10.0.1"])).toBe(false);
  });
  it("refuses an already-closed event", () => {
    expect(canProposeIsolation(threat({ triageState: "resolved" }))).toBe(false);
    expect(canProposeIsolation(threat({ triageState: "false_positive" }))).toBe(false);
  });
  it("allows an open outbound or internal threat from a known host", () => {
    expect(canProposeIsolation(threat({ direction: "outbound", triageState: "new" }))).toBe(true);
    expect(canProposeIsolation(threat({ direction: "internal", triageState: "investigating" }))).toBe(true);
  });
});
