// MSO-05 — pure unit tests for the two things this console class has shipped wrong repeatedly:
// the freshness state machine (the LEAD signal, contract §20.1a note 1) and the null-vs-zero
// mapping (§20.1a note 2). No Prometheus, no Alertmanager, no database — every function under test
// takes already-fetched data and returns a value; these tests feed it absent/empty/zero shapes and
// assert the three outcomes are never collapsed into one.
import { describe, it, expect } from "vitest";
import {
  computeFreshness,
  readingFromResult,
  scalarsByHost,
  hostReading,
  buildTargetSummary,
  buildDatastoreHealth,
  groupTargetsByHost,
  groupInstancesByHost,
  mapAlertmanagerAlerts,
  mergeHostInventory,
  computeEstateSummary,
  seriesEnvByHost,
  CONTAINERS_RUNNING_UNAVAILABLE,
  FRESH_MAX_AGE_SECONDS,
  DARK_BOUNDARY_SECONDS,
  type HostMetricMaps,
  type InfraHostRow,
} from "./estate-observability";

function emptyMaps(overrides: Partial<HostMetricMaps> = {}): HostMetricMaps {
  return {
    freshness: new Map(),
    cpuBusyPct: new Map(),
    cores: new Map(),
    memUsedPct: new Map(),
    diskUsedPct: new Map(),
    diskFreeGb: new Map(),
    diskFreeGb24h: new Map(),
    load1: new Map(),
    uptimeDays: new Map(),
    targetsByHost: new Map(),
    pgByHost: new Map(),
    redisByHost: new Map(),
    seriesEnvByHost: new Map(),
    ...overrides,
  };
}

describe("computeFreshness — the lead signal's state machine", () => {
  const now = 1_000_000;

  it("never: no sample in the 48h lookback at all", () => {
    expect(computeFreshness(now, undefined)).toEqual({ state: "never", lastSampleAgeSeconds: null });
    expect(computeFreshness(now, null)).toEqual({ state: "never", lastSampleAgeSeconds: null });
  });

  it("fresh: at and just under the 90s boundary", () => {
    expect(computeFreshness(now, now).state).toBe("fresh");
    expect(computeFreshness(now, now - FRESH_MAX_AGE_SECONDS).state).toBe("fresh");
    expect(computeFreshness(now, now - FRESH_MAX_AGE_SECONDS).lastSampleAgeSeconds).toBe(FRESH_MAX_AGE_SECONDS);
  });

  it("stale: just over 90s, at and under the 600s (10m) dark boundary", () => {
    expect(computeFreshness(now, now - (FRESH_MAX_AGE_SECONDS + 1)).state).toBe("stale");
    expect(computeFreshness(now, now - DARK_BOUNDARY_SECONDS).state).toBe("stale");
  });

  it("dark: past the 600s boundary — SAME boundary RemoteWriteStalled uses, by construction", () => {
    expect(DARK_BOUNDARY_SECONDS).toBe(600); // 10m — must never silently drift from the alert rule
    const r = computeFreshness(now, now - (DARK_BOUNDARY_SECONDS + 1));
    expect(r.state).toBe("dark");
    expect(r.lastSampleAgeSeconds).toBe(DARK_BOUNDARY_SECONDS + 1);
  });

  it("clock skew: a sample stamped in the future never reads as negative age", () => {
    const r = computeFreshness(now, now + 500);
    expect(r.lastSampleAgeSeconds).toBe(0);
    expect(r.state).toBe("fresh");
  });
});

describe("readingFromResult — absent vs empty vs measured-zero never collapse", () => {
  it("absent (empty vector): value null, distinguishable from zero", () => {
    const r = readingFromResult([]);
    expect(r.value).toBeNull();
    expect(r.note).toBeTruthy();
  });

  it("measured zero: value is literally 0, note is null — NOT the same object shape as absent", () => {
    const r = readingFromResult([{ metric: {}, value: [1700000000, "0"] }]);
    expect(r.value).toBe(0);
    expect(r.note).toBeNull();
    // The failure this class of bug ships: a caller doing `reading.value ?? 0` cannot tell these
    // apart downstream, but the Reading itself must still carry the distinction here.
    expect(r).not.toEqual(readingFromResult([]));
  });

  it("a query error is reported as null with the error message as the note, not swallowed", () => {
    const r = readingFromResult([], "prometheus HTTP 503");
    expect(r.value).toBeNull();
    expect(r.note).toBe("prometheus HTTP 503");
  });

  it("a non-numeric sample value degrades to null, not NaN", () => {
    const r = readingFromResult([{ metric: {}, value: [1700000000, "NaN"] }]);
    expect(r.value).toBeNull();
  });
});

describe("scalarsByHost / hostReading — per-host null-vs-zero, and host:\"\" is never emitted", () => {
  it("a host absent from an otherwise non-empty map reads null, not 0", () => {
    const map = scalarsByHost([{ metric: { host: "gda-aicenter" }, value: [1, "42"] }]);
    expect(hostReading(map, "gda-aicenter")).toEqual({ value: 42, note: null });
    expect(hostReading(map, "sumopod").value).toBeNull();
  });

  it("a host reporting a measured zero is 0, not indistinguishable from the absent host above", () => {
    const map = scalarsByHost([
      { metric: { host: "gda-aicenter" }, value: [1, "42"] },
      { metric: { host: "sumopod" }, value: [1, "0"] },
    ]);
    expect(hostReading(map, "sumopod")).toEqual({ value: 0, note: null });
    expect(hostReading(map, "sumopod").value).not.toBeNull();
  });

  it('host:"" (pre-MSO-01 legacy unlabeled series) is dropped, never emitted as a host', () => {
    const map = scalarsByHost([
      { metric: { host: "" }, value: [1, "99"] },
      { metric: {}, value: [1, "5"] }, // no host label at all
      { metric: { host: "gda-aicenter" }, value: [1, "7"] },
    ]);
    expect(map.has("")).toBe(false);
    expect(map.size).toBe(1);
    expect(map.get("gda-aicenter")).toBe(7);
  });

  it("a cAdvisor-shaped empty result (the real MON-09n case) yields null for every host, never 0", () => {
    // count(container_last_seen{name!=""}) is verified empty estate-wide — model that exact shape.
    const map = scalarsByHost([]);
    expect(hostReading(map, "gda-aicenter").value).toBeNull();
    expect(hostReading(map, "sumopod").value).toBeNull();
    // The controller doesn't even query this — it hardcodes the constant. Prove the constant itself
    // never reads as measured-zero.
    expect(CONTAINERS_RUNNING_UNAVAILABLE.value).toBeNull();
    expect(CONTAINERS_RUNNING_UNAVAILABLE.note).toMatch(/MON-09n/);
  });
});

describe("targets — null (no scrape data) is not {up:0,down:0}", () => {
  it("a host with zero rows gets null, never a zeroed summary", () => {
    expect(buildTargetSummary(undefined)).toBeNull();
    expect(buildTargetSummary([])).toBeNull();
  });

  it("a host with rows gets real counts and sorted downJobs", () => {
    const grouped = groupTargetsByHost([
      { metric: { host: "gda-aicenter", job: "node" }, value: [1, "1"] },
      { metric: { host: "gda-aicenter", job: "cadvisor" }, value: [1, "0"] },
      { metric: { host: "gda-aicenter", job: "blackbox" }, value: [1, "0"] },
      { metric: { host: "sumopod", job: "node" }, value: [1, "1"] },
    ]);
    expect(buildTargetSummary(grouped.get("gda-aicenter"))).toEqual({
      up: 1,
      down: 2,
      downJobs: ["blackbox", "cadvisor"],
    });
    expect(buildTargetSummary(grouped.get("sumopod"))).toEqual({ up: 1, down: 0, downJobs: [] });
    expect(grouped.has("")).toBe(false);
  });
});

describe("datastores — null (nothing shipped) vs measured-and-down are distinct", () => {
  it("a host shipping neither exporter gets null", () => {
    expect(buildDatastoreHealth(undefined, undefined)).toBeNull();
    expect(buildDatastoreHealth([], [])).toBeNull();
  });

  it("a host shipping only postgres gets postgres populated and redis as an empty (measured) array", () => {
    const d = buildDatastoreHealth([{ host: "h", instance: "pg:5432", up: false }], undefined);
    expect(d).not.toBeNull();
    expect(d!.postgres).toEqual([{ instance: "pg:5432", up: false }]);
    expect(d!.redis).toEqual([]); // measured "none configured", not null
  });

  it("pg_up/redis_up measured-and-down is a real boolean, not the same as absent", () => {
    const grouped = groupInstancesByHost([{ metric: { host: "h", instance: "pg:5432" }, value: [1, "0"] }]);
    const d = buildDatastoreHealth(grouped.get("h"), undefined);
    expect(d!.postgres[0]).toEqual({ instance: "pg:5432", up: false });
  });
});

describe("mapAlertmanagerAlerts — Watchdog excluded, RemoteWriteStalled never excluded", () => {
  it("drops Watchdog", () => {
    const alerts = mapAlertmanagerAlerts([
      { labels: { alertname: "Watchdog", severity: "none" }, status: { state: "active" } },
      { labels: { alertname: "DiskSpaceLow", severity: "page" }, status: { state: "active" } },
    ]);
    expect(alerts.map((a) => a.name)).toEqual(["DiskSpaceLow"]);
  });

  it("keeps RemoteWriteStalled — it is the whole-board banner, must never be filtered", () => {
    const alerts = mapAlertmanagerAlerts([
      { labels: { alertname: "RemoteWriteStalled", severity: "page" }, status: { state: "active" } },
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].name).toBe("RemoteWriteStalled");
  });

  it("silenced/inhibited maps to state:suppressed, distinct from active — never both read as firing", () => {
    const alerts = mapAlertmanagerAlerts([
      { labels: { alertname: "DiskSpaceLow", severity: "page" }, status: { state: "suppressed", silencedBy: ["s1"] } },
      { labels: { alertname: "DiskSpaceLow", severity: "page", host: "sumopod" }, status: { state: "active" } },
    ]);
    expect(alerts[0].state).toBe("suppressed");
    expect(alerts[0].host).toBeNull(); // app-level / unattributed
    expect(alerts[1].state).toBe("active");
    expect(alerts[1].host).toBe("sumopod");
  });
});

describe("mergeHostInventory — inventory-driven, both drift directions visible", () => {
  const registered: InfraHostRow[] = [
    { key: "gda-aicenter", display_name: "gda-aicenter", env: "production", role: "erp-core", status: "active" },
    { key: "sumopod", display_name: "SumoPod", env: "ops", role: "observability-hub", status: "active" },
  ];

  it("a registered host with NO series ever appears as never, not omitted", () => {
    const hosts = mergeHostInventory(registered, emptyMaps(), 1_000_000);
    const gda = hosts.find((h) => h.key === "gda-aicenter")!;
    expect(gda).toBeDefined();
    expect(gda.registered).toBe(true);
    expect(gda.freshness).toEqual({ state: "never", lastSampleAgeSeconds: null });
    expect(gda.host).toBeNull();
    expect(gda.targets).toBeNull();
    expect(gda.datastores).toBeNull();
  });

  it("a series-only host with no infra_hosts row is unregistered — visibly abnormal, not silently dropped", () => {
    const maps = emptyMaps({ freshness: new Map([["mystery-box", 999_950]]) });
    const hosts = mergeHostInventory([], maps, 1_000_000);
    const mystery = hosts.find((h) => h.key === "mystery-box")!;
    expect(mystery).toBeDefined();
    expect(mystery.registered).toBe(false);
    expect(mystery.env).toBeNull();
    expect(mystery.status).toBeNull();
    expect(mystery.displayName).toBe("mystery-box"); // = key when unregistered
  });

  it("a decommissioned row with still-live series is included (muted by the UI via status)", () => {
    const rows: InfraHostRow[] = [
      { key: "old-box", display_name: "Old Box", env: "dev", role: "", status: "decommissioned" },
    ];
    const maps = emptyMaps({ freshness: new Map([["old-box", 999_990]]) });
    const hosts = mergeHostInventory(rows, maps, 1_000_000);
    expect(hosts.find((h) => h.key === "old-box")).toMatchObject({ status: "decommissioned", registered: true });
  });

  it("a decommissioned row whose series have fully aged out disappears entirely", () => {
    const rows: InfraHostRow[] = [
      { key: "old-box", display_name: "Old Box", env: "dev", role: "", status: "decommissioned" },
    ];
    const hosts = mergeHostInventory(rows, emptyMaps(), 1_000_000);
    expect(hosts.find((h) => h.key === "old-box")).toBeUndefined();
  });

  it('host key "" is never emitted even if it somehow reached the merge', () => {
    const maps = emptyMaps({ freshness: new Map([["", 999_990]]) });
    const hosts = mergeHostInventory([], maps, 1_000_000);
    expect(hosts.find((h) => h.key === "")).toBeUndefined();
  });

  it("envDrift fires when the series' env label disagrees with the inventory, table wins for display", () => {
    const maps = emptyMaps({
      freshness: new Map([["gda-aicenter", 999_990]]),
      seriesEnvByHost: new Map([["gda-aicenter", "staging"]]), // series says staging
    });
    const hosts = mergeHostInventory(registered, maps, 1_000_000); // row says production
    const gda = hosts.find((h) => h.key === "gda-aicenter")!;
    expect(gda.env).toBe("production"); // inventory is authoritative for display
    expect(gda.envDrift).toBe(true);
  });

  it("no drift when the series env label agrees, or is simply absent", () => {
    const agree = mergeHostInventory(
      registered,
      emptyMaps({
        freshness: new Map([["gda-aicenter", 999_990]]),
        seriesEnvByHost: new Map([["gda-aicenter", "production"]]),
      }),
      1_000_000,
    );
    expect(agree.find((h) => h.key === "gda-aicenter")!.envDrift).toBe(false);

    const absent = mergeHostInventory(registered, emptyMaps({ freshness: new Map([["gda-aicenter", 999_990]]) }), 1_000_000);
    expect(absent.find((h) => h.key === "gda-aicenter")!.envDrift).toBe(false);
  });

  it("containersRunning is ALWAYS the unavailable reading, for a live host and a never-reported one alike", () => {
    const maps = emptyMaps({ freshness: new Map([["gda-aicenter", 999_990]]) });
    const hosts = mergeHostInventory(registered, maps, 1_000_000);
    for (const h of hosts) expect(h.containersRunning).toEqual(CONTAINERS_RUNNING_UNAVAILABLE);
  });

  it("dark hosts null their host/targets/datastores even if a stray reading map entry exists", () => {
    const maps = emptyMaps({
      freshness: new Map([["gda-aicenter", 1_000_000 - 1000]]), // 1000s ago -> dark
      cpuBusyPct: new Map([["gda-aicenter", 5]]), // should be ignored: host is dark
    });
    const hosts = mergeHostInventory(registered, maps, 1_000_000);
    const gda = hosts.find((h) => h.key === "gda-aicenter")!;
    expect(gda.freshness.state).toBe("dark");
    expect(gda.host).toBeNull();
  });
});

describe("computeEstateSummary — counts by freshness state, alert counts null-safe", () => {
  it("buckets hosts correctly and never invents an alert count", () => {
    const hosts = mergeHostInventory(
      [
        { key: "a", display_name: "a", env: "production", role: "", status: "active" },
        { key: "b", display_name: "b", env: "production", role: "", status: "active" },
      ],
      emptyMaps({ freshness: new Map([["a", 1_000_000]]) }), // b -> never
      1_000_000,
    );
    const summary = computeEstateSummary(hosts, null, null);
    expect(summary.hosts).toEqual({ total: 2, fresh: 1, stale: 0, dark: 0, never: 1 });
    expect(summary.alertsActive).toBeNull();
    expect(summary.alertsSuppressed).toBeNull();
  });
});
