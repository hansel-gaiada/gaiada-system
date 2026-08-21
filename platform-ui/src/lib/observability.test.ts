import { describe, expect, it } from "vitest";
import {
  ageSeconds,
  diskProjectionNote,
  fmt,
  formatAge,
  freshnessTier,
  hostRowFromSnapshot,
  hostTier,
  levelLabel,
  tierRank,
  utilLevel,
  type ObservabilitySnapshot,
  type Reading,
} from "./observability";

const reading = (value: number | null, note: string | null = null): Reading => ({ value, note });

function baseSnapshot(overrides: Partial<ObservabilitySnapshot> = {}): ObservabilitySnapshot {
  return {
    available: true,
    grafanaHint: "http://localhost:3001 (via SSH tunnel)",
    host: {
      cpuBusyPct: reading(20),
      memUsedPct: reading(40),
      diskUsedPct: reading(50),
      diskFreeGb: reading(20),
      diskFreeGb24h: reading(20),
      load1: reading(0.5),
      uptimeDays: reading(10),
    },
    targets: { up: 14, down: 0, downJobs: [] },
    datastores: {
      postgres: [{ instance: "pg", up: true }],
      redis: [{ instance: "redis", up: true }],
    },
    alerts: [],
    collectedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("fmt", () => {
  it("never renders null as 0 — prints an em dash instead", () => {
    expect(fmt(reading(null))).toBe("—");
    expect(fmt(reading(0), "%")).toBe("0.0%"); // a REAL zero still prints as zero
  });
  it("formats a real value with one decimal + suffix", () => {
    expect(fmt(reading(78.44), "%")).toBe("78.4%");
  });
});

describe("utilLevel / levelLabel", () => {
  it("null is unknown, never ok", () => {
    expect(utilLevel(null)).toBe("unknown");
    expect(levelLabel("unknown")).toBe("draft"); // idle family, never a pass
  });
  it("thresholds match the DiskSpaceLow alert (85%/70%)", () => {
    expect(utilLevel(84.9)).toBe("warn");
    expect(utilLevel(85)).toBe("critical");
    expect(utilLevel(69.9)).toBe("ok");
    expect(utilLevel(70)).toBe("warn");
  });
});

describe("diskProjectionNote", () => {
  it("says nothing when either side is unmeasured", () => {
    expect(diskProjectionNote(reading(null), reading(10))).toBeNull();
    expect(diskProjectionNote(reading(10), reading(null))).toBeNull();
  });
  it("flags a negative projection as filling within 24h", () => {
    expect(diskProjectionNote(reading(5), reading(-1))).toBe("projected to fill within 24h");
  });
  it("stays quiet when flat or recovering", () => {
    expect(diskProjectionNote(reading(10), reading(10.1))).toBeNull();
  });
  it("reports a real downward trend", () => {
    expect(diskProjectionNote(reading(10), reading(7))).toBe("trending down ~3.0 GB/day");
  });
});

describe("hostTier — the three-state rollup", () => {
  it("available:false is unknown, not critical and not ok", () => {
    expect(hostTier(baseSnapshot({ available: false, host: null, targets: null, datastores: null, alerts: null }))).toBe("unknown");
  });
  it("a fully-measured healthy box is ok", () => {
    expect(hostTier(baseSnapshot())).toBe("ok");
  });
  it("a down datastore makes the whole host critical even with green CPU/mem/disk", () => {
    const snap = baseSnapshot({ datastores: { postgres: [{ instance: "pg", up: false }], redis: [] } });
    expect(hostTier(snap)).toBe("critical");
  });
  it("a down scrape target is critical", () => {
    expect(hostTier(baseSnapshot({ targets: { up: 13, down: 1, downJobs: ["blackbox"] } }))).toBe("critical");
  });
  it("a page-severity alert is critical even with everything else green", () => {
    expect(hostTier(baseSnapshot({ alerts: [{ name: "X", severity: "page" }] }))).toBe("critical");
  });
  it("a warn-tier resource with no alert is warn, not critical", () => {
    const snap = baseSnapshot({
      host: {
        cpuBusyPct: reading(75), memUsedPct: reading(40), diskUsedPct: reading(50),
        diskFreeGb: reading(20), diskFreeGb24h: reading(20), load1: reading(0.5), uptimeDays: reading(10),
      },
    });
    expect(hostTier(snap)).toBe("warn");
  });
  it("available:true with literally nothing measured is unknown, never ok", () => {
    const snap = baseSnapshot({
      host: {
        cpuBusyPct: reading(null), memUsedPct: reading(null), diskUsedPct: reading(null),
        diskFreeGb: reading(null), diskFreeGb24h: reading(null), load1: reading(null), uptimeDays: reading(null),
      },
      targets: null,
      datastores: { postgres: [], redis: [] },
      alerts: [],
    });
    expect(hostTier(snap)).toBe("unknown");
  });
});

describe("tierRank", () => {
  it("orders most-unhappy first", () => {
    const order = (["ok", "unknown", "warn", "critical"] as const).map(tierRank);
    expect([...order].sort((a, b) => a - b)).toEqual([tierRank("critical"), tierRank("warn"), tierRank("unknown"), tierRank("ok")]);
  });
});

describe("hostRowFromSnapshot", () => {
  it("never invents an environment — null means not sent by the backend", () => {
    const row = hostRowFromSnapshot(baseSnapshot());
    expect(row.environment).toBeNull();
  });
  it("carries the reason through for an unavailable snapshot", () => {
    const row = hostRowFromSnapshot(baseSnapshot({ available: false, reason: "PROMETHEUS_URL is not set", host: null, targets: null, datastores: null, alerts: null }));
    expect(row.available).toBe(false);
    expect(row.reason).toBe("PROMETHEUS_URL is not set");
    expect(row.tier).toBe("unknown");
  });
});

describe("ageSeconds / formatAge / freshnessTier", () => {
  it("computes real elapsed seconds, floored at 0", () => {
    const now = Date.now();
    expect(ageSeconds(new Date(now - 5000).toISOString(), now)).toBe(5);
    expect(ageSeconds(new Date(now + 5000).toISOString(), now)).toBe(0); // future timestamp never goes negative
  });
  it("an unparseable timestamp is NaN, not 0", () => {
    expect(Number.isNaN(ageSeconds("not-a-date"))).toBe(true);
    expect(formatAge(ageSeconds("not-a-date"))).toBe("—");
  });
  it("formats bands: seconds, minutes, hours, days", () => {
    expect(formatAge(3)).toBe("just now");
    expect(formatAge(40)).toBe("40s ago");
    expect(formatAge(300)).toBe("5m ago");
    expect(formatAge(3 * 3600)).toBe("3h ago");
    expect(formatAge(3 * 86400)).toBe("3d ago");
  });
  it("freshness bands at 2min and 15min — the 40-minutes-ago trap lands in stale", () => {
    expect(freshnessTier(30)).toBe("fresh");
    expect(freshnessTier(5 * 60)).toBe("aging");
    expect(freshnessTier(40 * 60)).toBe("stale");
    expect(freshnessTier(NaN)).toBe("stale");
  });
});
