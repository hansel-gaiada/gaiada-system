import { describe, expect, it } from "vitest";
import {
  ageSeconds,
  alarmRank,
  diskProjectionNote,
  estateHostTier,
  fmt,
  formatAge,
  hostAlarmState,
  hostAlerts,
  hostRowFromEstateHost,
  levelLabel,
  liveSampleAgeSeconds,
  remoteWriteStalledActive,
  tierRank,
  unattributedAlerts,
  utilLevel,
  type EstateAlert,
  type HostSnapshot,
  type Reading,
} from "./observability";

const reading = (value: number | null, note: string | null = null): Reading => ({ value, note });

function baseHost(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    key: "gda-aicenter",
    displayName: "gda-aicenter",
    env: "production",
    role: "erp-core",
    registered: true,
    status: "active",
    envDrift: false,
    freshness: { state: "fresh", lastSampleAgeSeconds: 10 },
    host: {
      cpuBusyPct: reading(20),
      cores: reading(4),
      memUsedPct: reading(40),
      diskUsedPct: reading(50),
      diskFreeGb: reading(20),
      diskFreeGb24h: reading(20),
      load1: reading(0.5),
      uptimeDays: reading(10),
    },
    targets: { up: 14, down: 0, downJobs: [] },
    containersRunning: { value: null, note: "per-container discovery broken estate-wide (MON-09n)" },
    datastores: {
      postgres: [{ instance: "pg", up: true }],
      redis: [{ instance: "redis", up: true }],
    },
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

describe("hostAlerts / unattributedAlerts", () => {
  const all: EstateAlert[] = [
    { name: "DiskWillFillIn24h", severity: "page", state: "active", host: "gda-aicenter" },
    { name: "GatewayBudgetNearCap", severity: "ticket", state: "suppressed", host: null },
  ];
  it("narrows to a host's own alerts", () => {
    expect(hostAlerts(all, "gda-aicenter")).toHaveLength(1);
    expect(hostAlerts(all, "sumopod")).toHaveLength(0);
  });
  it("app-level alerts (host: null) are rendered estate-wide, not dropped", () => {
    expect(unattributedAlerts(all)).toHaveLength(1);
    expect(unattributedAlerts(all)[0].name).toBe("GatewayBudgetNearCap");
  });
  it("null alerts list narrows to empty arrays, never throws", () => {
    expect(hostAlerts(null, "x")).toEqual([]);
    expect(unattributedAlerts(null)).toEqual([]);
  });
});

describe("remoteWriteStalledActive", () => {
  it("fires the whole-board banner when RemoteWriteStalled is active on ANY host", () => {
    expect(remoteWriteStalledActive([{ name: "RemoteWriteStalled", severity: "page", state: "active", host: "edge-02" }])).toBe(true);
  });
  it("does NOT fire when RemoteWriteStalled is only suppressed", () => {
    expect(remoteWriteStalledActive([{ name: "RemoteWriteStalled", severity: "page", state: "suppressed", host: "edge-02" }])).toBe(false);
  });
  it("false for null (Alertmanager unreadable) and for an unrelated alert", () => {
    expect(remoteWriteStalledActive(null)).toBe(false);
    expect(remoteWriteStalledActive([{ name: "DiskWillFillIn24h", severity: "page", state: "active", host: "x" }])).toBe(false);
  });
});

describe("estateHostTier — the health axis, independent of freshness", () => {
  it("a fully-measured healthy live host is ok", () => {
    expect(estateHostTier(baseHost(), [])).toBe("ok");
  });
  it("a down datastore makes the whole host critical even with green CPU/mem/disk", () => {
    const h = baseHost({ datastores: { postgres: [{ instance: "pg", up: false }], redis: [] } });
    expect(estateHostTier(h, [])).toBe("critical");
  });
  it("a down scrape target is critical", () => {
    const h = baseHost({ targets: { up: 13, down: 1, downJobs: ["blackbox"] } });
    expect(estateHostTier(h, [])).toBe("critical");
  });
  it("a page-severity ACTIVE alert is critical even with everything else green", () => {
    const alerts: EstateAlert[] = [{ name: "X", severity: "page", state: "active", host: "gda-aicenter" }];
    expect(estateHostTier(baseHost(), alerts)).toBe("critical");
  });
  it("a page-severity SUPPRESSED alert is only warn, not critical — a silence must not read as firing", () => {
    const alerts: EstateAlert[] = [{ name: "X", severity: "page", state: "suppressed", host: "gda-aicenter" }];
    expect(estateHostTier(baseHost(), alerts)).toBe("warn");
  });
  it("a warn-tier resource with no alert is warn, not critical", () => {
    const h = baseHost({
      host: {
        cpuBusyPct: reading(75), cores: reading(4), memUsedPct: reading(40), diskUsedPct: reading(50),
        diskFreeGb: reading(20), diskFreeGb24h: reading(20), load1: reading(0.5), uptimeDays: reading(10),
      },
    });
    expect(estateHostTier(h, [])).toBe("warn");
  });
  it("a dark/never host (host/targets/datastores all null) measures unknown, never ok", () => {
    const h = baseHost({ host: null, targets: null, datastores: null, freshness: { state: "dark", lastSampleAgeSeconds: 900 } });
    expect(estateHostTier(h, [])).toBe("unknown");
  });
});

describe("hostRowFromEstateHost", () => {
  it("carries real env/role/status/freshness straight through — no invented placeholder", () => {
    const row = hostRowFromEstateHost(baseHost(), null);
    expect(row.env).toBe("production");
    expect(row.role).toBe("erp-core");
    expect(row.registered).toBe(true);
    expect(row.freshness).toEqual({ state: "fresh", lastSampleAgeSeconds: 10 });
  });
  it("narrows the estate alert list to this host's own alerts", () => {
    const all: EstateAlert[] = [
      { name: "A", severity: "page", state: "active", host: "gda-aicenter" },
      { name: "B", severity: "page", state: "active", host: "sumopod" },
    ];
    const row = hostRowFromEstateHost(baseHost(), all);
    expect(row.alerts).toEqual([all[0]]);
  });
  it("an unregistered host has env/role/status null and registered:false", () => {
    const h = baseHost({ key: "mystery", displayName: "mystery", env: null, role: null, registered: false, status: null });
    const row = hostRowFromEstateHost(h, null);
    expect(row.registered).toBe(false);
    expect(row.env).toBeNull();
  });
  it("containersRunning rides through untouched — never coerced to 0", () => {
    const row = hostRowFromEstateHost(baseHost(), null);
    expect(row.containersRunning.value).toBeNull();
    expect(row.containersRunning.note).toContain("MON-09n");
  });
});

describe("hostAlarmState — the row-level triage signal combining registration/status/freshness", () => {
  it("registered, active, fresh/stale: reporting", () => {
    expect(hostAlarmState({ registered: true, status: "active", freshness: { state: "fresh", lastSampleAgeSeconds: 1 } })).toBe("reporting");
    expect(hostAlarmState({ registered: true, status: "active", freshness: { state: "stale", lastSampleAgeSeconds: 300 } })).toBe("reporting");
  });
  it("registered, active, dark/never: stopped-reporting — the dangerous case", () => {
    expect(hostAlarmState({ registered: true, status: "active", freshness: { state: "dark", lastSampleAgeSeconds: 900 } })).toBe("stopped-reporting");
    expect(hostAlarmState({ registered: true, status: "active", freshness: { state: "never", lastSampleAgeSeconds: null } })).toBe("stopped-reporting");
  });
  it("registered, onboarding, dark/never: expected-pending — must NOT read like stopped-reporting", () => {
    expect(hostAlarmState({ registered: true, status: "onboarding", freshness: { state: "never", lastSampleAgeSeconds: null } })).toBe("expected-pending");
  });
  it("registered, decommissioned: decommissioned-muted regardless of freshness", () => {
    expect(hostAlarmState({ registered: true, status: "decommissioned", freshness: { state: "stale", lastSampleAgeSeconds: 400 } })).toBe("decommissioned-muted");
  });
  it("unregistered wins over everything else — the other drift direction", () => {
    expect(hostAlarmState({ registered: false, status: null, freshness: { state: "fresh", lastSampleAgeSeconds: 5 } })).toBe("unregistered");
  });
});

describe("alarmRank — default sort puts the dangerous-dark case first", () => {
  it("a stopped-reporting host outranks a measured-critical host", () => {
    const stopped = hostRowFromEstateHost(baseHost({ status: "active", freshness: { state: "dark", lastSampleAgeSeconds: 900 }, host: null, targets: null, datastores: null }), null);
    const critical = hostRowFromEstateHost(baseHost({ datastores: { postgres: [{ instance: "pg", up: false }], redis: [] } }), null);
    expect(alarmRank(stopped)).toBeLessThan(alarmRank(critical));
  });
  it("expected-pending and decommissioned sort to the bottom, below a plain ok host", () => {
    const ok = hostRowFromEstateHost(baseHost(), null);
    const pending = hostRowFromEstateHost(baseHost({ status: "onboarding", freshness: { state: "never", lastSampleAgeSeconds: null }, host: null, targets: null, datastores: null }), null);
    expect(alarmRank(ok)).toBeLessThan(alarmRank(pending));
  });
});

describe("tierRank", () => {
  it("orders most-unhappy first", () => {
    const order = (["ok", "unknown", "warn", "critical"] as const).map(tierRank);
    expect([...order].sort((a, b) => a - b)).toEqual([tierRank("critical"), tierRank("warn"), tierRank("unknown"), tierRank("ok")]);
  });
});

describe("ageSeconds / formatAge", () => {
  it("computes real elapsed seconds, floored at 0", () => {
    const now = Date.now();
    expect(ageSeconds(new Date(now - 5000).toISOString(), now)).toBe(5);
    expect(ageSeconds(new Date(now + 5000).toISOString(), now)).toBe(0); // future timestamp never goes negative
  });
  it("an unparseable timestamp is NaN, not 0", () => {
    expect(Number.isNaN(ageSeconds("not-a-date"))).toBe(true);
  });
  it("formats bands: seconds, minutes, hours, days", () => {
    expect(formatAge(3)).toBe("just now");
    expect(formatAge(40)).toBe("40s ago");
    expect(formatAge(300)).toBe("5m ago");
    expect(formatAge(3 * 3600)).toBe("3h ago");
    expect(formatAge(3 * 86400)).toBe("3d ago");
  });
  it("null (the 'never' case) and NaN both render as a dash, never as '0s ago'", () => {
    expect(formatAge(null)).toBe("—");
    expect(formatAge(NaN)).toBe("—");
  });
});

describe("liveSampleAgeSeconds", () => {
  it("adds elapsed time since collectedAt to the server-measured age", () => {
    const now = Date.now();
    const collectedAt = new Date(now - 30_000).toISOString(); // snapshot generated 30s ago
    const age = liveSampleAgeSeconds({ state: "stale", lastSampleAgeSeconds: 200 }, collectedAt, now);
    expect(age).toBe(230);
  });
  it("never invents an age for the never state", () => {
    const age = liveSampleAgeSeconds({ state: "never", lastSampleAgeSeconds: null }, new Date().toISOString(), Date.now());
    expect(age).toBeNull();
  });
});
