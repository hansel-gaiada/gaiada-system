// IT-03/IT-05 — pure-helper unit tests for network-discovery classification, derived status and the
// operator-override layer. No DB: these are the rules that decide what gets PERSISTED (privacy) and
// what a device's status MEANS, so they are worth pinning independently of Postgres availability.
//
// Fixtures are the REAL hostnames observed on the office network on 2026-08-03 (see
// docs/superpowers/specs/2026-08-03-it-network-discovery-design.md §1), not invented ones — the
// classifier's whole job is to separate those two populations correctly.
import { describe, it, expect } from "vitest";
import {
  applyOverrides, classifyDevice, compilePatterns, deriveStatus, normalizeKind, OVERRIDABLE,
  type ReportedDevice,
} from "./discovery.service";

const PATTERNS = compilePatterns(["^GDA-", "^DESKTOP-", "^LAPTOP-", "^MSI\\.", "^Dina\\.", "^Laptop-"]);
const dev = (d: Partial<ReportedDevice>): ReportedDevice => ({ externalId: "x", ...d });

describe("classifyDevice", () => {
  it("adopted UniFi devices are infrastructure regardless of hostname", () => {
    expect(classifyDevice(dev({ adopted: true, hostname: "unifi.localdomain" }), PATTERNS)).toBe("infrastructure");
    // Adoption wins even when the hostname would otherwise read as BYOD.
    expect(classifyDevice(dev({ adopted: true, hostname: "Ratihs-iPhone" }), PATTERNS)).toBe("infrastructure");
  });

  it("corporate hostnames classify as managed", () => {
    for (const h of ["GDA-01.local", "GDA-16.local", "GDA-AIO-02.local", "DESKTOP-GSQKIBQ.local",
                     "LAPTOP-0L17QEJV.local", "MSI.local", "Dina.local", "Laptop-Tini.local"]) {
      expect(classifyDevice(dev({ hostname: h }), PATTERNS), h).toBe("managed");
    }
  });

  it("personal phones classify as byod — the default-deny path", () => {
    // Every one of these was really on the network; each names a person, which is exactly why the
    // privacy gate drops them rather than storing them.
    for (const h of ["Ratihs-iPhone", "iphone-claraay", "A56-milik-Tini", "A04s-milik-I-Made-Ari",
                     "Irie-s-S23-FE", "Edward-s-AQUOS-R9-pro", "Redmi-Note-11-Pro-5G", "OPPO-Reno11-5G",
                     "TECNO-SPARK-Go-2", "Galaxy-A06-5G", "realme-C55", "Infinix-NOTE-50-Pro"]) {
      expect(classifyDevice(dev({ hostname: h }), PATTERNS), h).toBe("byod");
    }
  });

  it("an unidentified host (no hostname at all) is byod, not managed", () => {
    // ~12 of the 58 observed hosts had no reverse DNS. Default-deny means a nameless device is
    // never silently admitted to the registry.
    expect(classifyDevice(dev({}), PATTERNS)).toBe("byod");
    expect(classifyDevice(dev({ hostname: "   " }), PATTERNS)).toBe("byod");
    expect(classifyDevice(dev({ hostname: null, name: null }), PATTERNS)).toBe("byod");
  });

  it("falls back to `name` when hostname is absent, and is case-insensitive", () => {
    expect(classifyDevice(dev({ name: "gda-07" }), PATTERNS)).toBe("managed");
    expect(classifyDevice(dev({ hostname: "  GDA-02.local  " }), PATTERNS)).toBe("managed");
  });

  it("an empty pattern set classifies everything byod rather than everything managed", () => {
    // Fail-safe direction: a missing/misconfigured pattern list must not admit the whole network.
    expect(classifyDevice(dev({ hostname: "GDA-01.local" }), [])).toBe("byod");
  });
});

describe("compilePatterns", () => {
  it("skips patterns that don't compile instead of throwing", () => {
    const compiled = compilePatterns(["^GDA-", "([unclosed", "^MSI\\."]);
    expect(compiled).toHaveLength(2);
    expect(classifyDevice(dev({ hostname: "GDA-09.local" }), compiled)).toBe("managed");
  });
});

describe("deriveStatus", () => {
  const now = new Date("2026-08-03T12:00:00Z");
  const windows = { onlineWindowMs: 11 * 60 * 1000, degradedWindowMs: 31 * 60 * 1000 };
  const at = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60 * 1000);

  it("never-seen is unknown", () => {
    expect(deriveStatus(null, now, windows)).toBe("unknown");
    expect(deriveStatus(undefined, now, windows)).toBe("unknown");
  });

  it("unparseable timestamps are unknown, not offline", () => {
    expect(deriveStatus("not-a-date", now, windows)).toBe("unknown");
  });

  it("grades freshness online → degraded → offline", () => {
    expect(deriveStatus(at(0), now, windows)).toBe("online");
    expect(deriveStatus(at(10), now, windows)).toBe("online");
    expect(deriveStatus(at(11), now, windows)).toBe("online");   // boundary is inclusive
    expect(deriveStatus(at(12), now, windows)).toBe("degraded");
    expect(deriveStatus(at(31), now, windows)).toBe("degraded"); // boundary is inclusive
    expect(deriveStatus(at(32), now, windows)).toBe("offline");
    expect(deriveStatus(at(60 * 24), now, windows)).toBe("offline");
  });

  it("a future timestamp reads online rather than flapping the estate offline", () => {
    // A collector with skewed clock/NTP would otherwise push every device it reports to 'offline'.
    expect(deriveStatus(new Date(now.getTime() + 60_000), now, windows)).toBe("online");
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(deriveStatus("2026-08-03T11:59:00Z", now, windows)).toBe("online");
  });
});

describe("applyOverrides", () => {
  const row = { name: "GDA-01", kind: "workstation", ip: "10.10.2.39", mac: "aa:bb", vendor: null };

  it("returns the row untouched when there are no overrides", () => {
    expect(applyOverrides(row, null)).toEqual(row);
    expect(applyOverrides(row, {})).toEqual(row);
  });

  it("operator overrides win over collector-reported values", () => {
    const out = applyOverrides(row, { name: "Reception PC", vendor: "Dell" });
    expect(out.name).toBe("Reception PC");
    expect(out.vendor).toBe("Dell");
  });

  it("ignores keys outside the overridable set, so collector facts can't be spoofed on read", () => {
    // ip/mac are network facts; pinning them would make the registry disagree with reality.
    const out = applyOverrides(row, { ip: "1.2.3.4", mac: "de:ad", status: "online" } as Record<string, unknown>);
    expect(out.ip).toBe("10.10.2.39");
    expect(out.mac).toBe("aa:bb");
    expect((out as Record<string, unknown>).status).toBeUndefined();
  });

  it("does not mutate the input row", () => {
    const original = { ...row };
    applyOverrides(row, { name: "Changed" });
    expect(row).toEqual(original);
  });

  it("an explicit null override is applied but undefined is skipped", () => {
    expect(applyOverrides({ ...row, vendor: "Dell" }, { vendor: null }).vendor).toBeNull();
    expect(applyOverrides({ ...row, vendor: "Dell" }, { vendor: undefined }).vendor).toBe("Dell");
  });

  it("every OVERRIDABLE key actually round-trips", () => {
    const patch = Object.fromEntries(OVERRIDABLE.map((k) => [k, k === "labels" ? ["x"] : `v-${k}`]));
    const out = applyOverrides({} as Record<string, unknown>, patch);
    for (const k of OVERRIDABLE) expect(out[k]).toEqual(patch[k]);
  });
});

describe("normalizeKind", () => {
  it("adopted infrastructure is always 'network'", () => {
    expect(normalizeKind(dev({ adopted: true, kind: "workstation" }))).toBe("network");
  });
  it("passes through valid kinds and coerces anything else to 'other'", () => {
    expect(normalizeKind(dev({ kind: "printer" }))).toBe("printer");
    expect(normalizeKind(dev({ kind: "WORKSTATION" }))).toBe("workstation");
    expect(normalizeKind(dev({ kind: "toaster" }))).toBe("other");
    expect(normalizeKind(dev({}))).toBe("other");
  });
});
