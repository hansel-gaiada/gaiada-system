// MON-11a — registry tests. Pure: no DB, no network, so this suite CANNOT silently skip for want of
// DATABASE_URL_TEST. That matters here: the whole point of these assertions is to be the thing that
// notices, and a guard that skips is worse than no guard because the run still reports green.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registerDriver,
  resetDrivers,
  getDriver,
  hasDriver,
  parseKind,
  listKindSpecs,
  kindSupports,
  KNOWN_KINDS,
  MonitorDriverUnavailableError,
  type MonitorDriver,
} from "./registry";

function stubDriver(over: Partial<MonitorDriver<{ url: string }>> = {}): MonitorDriver<{ url: string }> {
  return {
    kind: "http",
    capabilities: ["status", "latency"],
    validate: (c) => c as { url: string },
    probe: async () => ({ status: "up", latencyMs: 12, detail: null }),
    ...over,
  } as MonitorDriver<{ url: string }>;
}

beforeEach(() => resetDrivers());
afterEach(() => resetDrivers());

describe("absent means absent, never silently inert", () => {
  it("getDriver THROWS for an unregistered kind rather than returning undefined", () => {
    // The Optional shape invites `if (driver) probe()`, which skips the check and leaves the monitor
    // looking un-probed rather than un-runnable. That distinction is the whole ticket.
    expect(() => getDriver("dns")).toThrow(MonitorDriverUnavailableError);
  });

  it("the error says the gap is permanent, so nobody treats it as a transient failure", () => {
    try {
      getDriver("mqtt");
      throw new Error("expected a throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("mqtt");
      expect(msg).toMatch(/deployment gap/i);
      expect(msg).toMatch(/nothing will retry/i);
    }
  });

  it("hasDriver reports availability without throwing, for the read paths that legitimately ask", () => {
    expect(hasDriver("http")).toBe(false);
    registerDriver(stubDriver());
    expect(hasDriver("http")).toBe(true);
  });
});

describe("parseKind has no default branch", () => {
  it("returns null for unknown input instead of inventing a fallback", () => {
    // SM-61's lesson: two callers each silently picked a different convenient default, so "absent"
    // meant one thing in one place and something else elsewhere.
    expect(parseKind("nope")).toBeNull();
    expect(parseKind("")).toBeNull();
    expect(parseKind(undefined)).toBeNull();
    expect(parseKind(null)).toBeNull();
    expect(parseKind(42)).toBeNull();
    expect(parseKind({ kind: "http" })).toBeNull();
  });

  it("round-trips every known kind", () => {
    for (const k of KNOWN_KINDS) expect(parseKind(k)).toBe(k);
  });

  it("does not accept a kind by case-insensitive or trimmed match", () => {
    // A monitor created as "HTTP" must fail loudly, not quietly become a different stored value than
    // the operator typed.
    expect(parseKind("HTTP")).toBeNull();
    expect(parseKind(" http")).toBeNull();
  });
});

describe("registration pin — a correct-but-unwired driver is indistinguishable from an absent one", () => {
  it("listKindSpecs enumerates EVERY known kind, marking availability rather than hiding it", () => {
    registerDriver(stubDriver());
    const specs = listKindSpecs();
    // Pinned by name on purpose: this is the assertion that fails when someone adds a kind to the
    // union and forgets the declaration, or removes a driver and leaves the UI offering it.
    expect(specs.map((s) => s.kind).sort()).toEqual(
      ["database", "dns", "docker", "grpc", "heartbeat", "http", "keyword", "mqtt", "snmp", "steam", "tcp", "tls"],
    );
    expect(specs.find((s) => s.kind === "http")?.available).toBe(true);
    // Unavailable kinds are RETURNED, not omitted: hiding them makes "not built yet" and "never
    // designed" look identical, and would let the UI accept a kind that can never run.
    expect(specs.find((s) => s.kind === "steam")?.available).toBe(false);
    expect(specs.every((s) => s.label.length > 0)).toBe(true);
  });

  it("every kind declares at least one capability", () => {
    // A kind with no capabilities can have no meaningful assertion, so the API would accept a monitor
    // that checks nothing.
    for (const s of listKindSpecs()) expect(s.capabilities.length).toBeGreaterThan(0);
  });
});

describe("capability contract", () => {
  it("refuses a driver whose capabilities exceed its kind contract", () => {
    // Otherwise the API would accept assertions the rest of the system does not expect this kind to
    // evaluate — the silently-ignored-assertion failure.
    expect(() =>
      registerDriver(stubDriver({ capabilities: ["status", "body_contains"] })),
    ).toThrow(/outside its kind contract/);
  });

  it("kindSupports gates assertions to what the kind can actually evaluate", () => {
    expect(kindSupports("keyword", "body_contains")).toBe(true);
    // The distinction that matters: plain http cannot check content, so a body assertion against it
    // must be refused rather than stored and ignored.
    expect(kindSupports("http", "body_contains")).toBe(false);
    expect(kindSupports("tls", "expiry")).toBe(true);
    expect(kindSupports("heartbeat", "status")).toBe(false);
  });

  it("refuses an unknown kind and a double registration", () => {
    expect(() => registerDriver(stubDriver({ kind: "bogus" as never }))).toThrow(/unknown kind/);
    registerDriver(stubDriver());
    expect(() => registerDriver(stubDriver())).toThrow(/already registered/);
  });
});
