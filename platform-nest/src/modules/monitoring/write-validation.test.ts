// MON-19/20 — pure unit tests for the write-surface validation/decisions. No DB, no Cerbos: these
// pin the SSRF host-extraction and allowlist logic that the live-DB suite only proves is WIRED, not
// that it is ARITHMETICALLY right (monitoring.controller.test.ts's model: pure suites carry the
// semantics, live suites carry the wiring — see uptime-parity.test.ts for the same split).
import { describe, it, expect } from "vitest";
import {
  parseSeverity,
  parseIntervalSec,
  parseTags,
  extractTargetHost,
  assertHostAllowlisted,
  buildRawDriverConfig,
  parseChannelKind,
  parseOptionalMatchSeverity,
  parseOptionalMatchKind,
  parseMaintenanceScope,
  parseMaintenanceWindow,
  parseResultWindow,
  MonitorValidationError,
} from "./write-validation";

describe("parseSeverity", () => {
  it("defaults to ticket when absent", () => {
    expect(parseSeverity(undefined)).toBe("ticket");
    expect(parseSeverity(null)).toBe("ticket");
    expect(parseSeverity("")).toBe("ticket");
  });
  it("accepts the three known values", () => {
    expect(parseSeverity("page")).toBe("page");
    expect(parseSeverity("ticket")).toBe("ticket");
    expect(parseSeverity("info")).toBe("info");
  });
  it("rejects anything else", () => {
    expect(() => parseSeverity("urgent")).toThrow(MonitorValidationError);
    expect(() => parseSeverity(1)).toThrow(MonitorValidationError);
  });
});

describe("parseIntervalSec", () => {
  it("defaults to 60 when absent", () => {
    expect(parseIntervalSec(undefined)).toBe(60);
  });
  it("accepts an integer >= 20", () => {
    expect(parseIntervalSec(20)).toBe(20);
    expect(parseIntervalSec("300")).toBe(300);
  });
  it("rejects below the floor, non-integers and garbage", () => {
    expect(() => parseIntervalSec(19)).toThrow(MonitorValidationError);
    expect(() => parseIntervalSec(30.5)).toThrow(MonitorValidationError);
    expect(() => parseIntervalSec("not-a-number")).toThrow(MonitorValidationError);
  });
});

describe("parseTags", () => {
  it("returns [] for non-arrays", () => {
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags("tag")).toEqual([]);
  });
  it("keeps only non-empty strings, trimmed", () => {
    expect(parseTags(["  a  ", "", 42, null, "b"])).toEqual(["a", "b"]);
  });
});

describe("extractTargetHost", () => {
  it("heartbeat has no target — always null", () => {
    expect(extractTargetHost("heartbeat", "")).toBeNull();
    expect(extractTargetHost("heartbeat", "https://ignored.example")).toBeNull();
  });

  it("http/keyword: hostname from a full URL", () => {
    expect(extractTargetHost("http", "https://example.com/page")).toBe("example.com");
    expect(extractTargetHost("keyword", "http://example.com:8080/x")).toBe("example.com");
  });
  it("http/keyword: rejects a non-http(s) scheme and a malformed URL", () => {
    expect(() => extractTargetHost("http", "file:///etc/passwd")).toThrow(MonitorValidationError);
    expect(() => extractTargetHost("http", "not a url")).toThrow(MonitorValidationError);
    expect(() => extractTargetHost("http", "")).toThrow(MonitorValidationError);
  });

  it("tcp/tls: host from host:port, including IPv6 brackets", () => {
    expect(extractTargetHost("tcp", "example.com:443")).toBe("example.com");
    expect(extractTargetHost("tls", "[::1]:443")).toBe("::1");
  });
  it("tcp/tls: rejects a target with no port", () => {
    expect(() => extractTargetHost("tcp", "example.com")).toThrow(MonitorValidationError);
  });

  it("dns: the target IS the hostname", () => {
    expect(extractTargetHost("dns", "example.com")).toBe("example.com");
  });

  it("a kind with no target-extraction rule throws rather than silently passing", () => {
    expect(() => extractTargetHost("mqtt", "example.com")).toThrow(MonitorValidationError);
  });
});

describe("assertHostAllowlisted — the SSRF floor at write time", () => {
  it("passes null through (heartbeat has nothing to dial)", () => {
    expect(() => assertHostAllowlisted(null, [])).not.toThrow();
  });
  it("allows an exact allowlist match", () => {
    expect(() => assertHostAllowlisted("example.com", ["example.com", "other.com"])).not.toThrow();
  });
  it("refuses a host absent from the allowlist — the create-as-SSRF-primitive case", () => {
    expect(() => assertHostAllowlisted("evil.example", ["example.com"])).toThrow(MonitorValidationError);
    expect(() => assertHostAllowlisted("169.254.169.254", [])).toThrow(MonitorValidationError);
  });
  it("does not allow a suffix/subdomain to ride in on a parent domain's allowlist entry", () => {
    expect(() => assertHostAllowlisted("evil-example.com", ["example.com"])).toThrow(MonitorValidationError);
    expect(() => assertHostAllowlisted("sub.example.com", ["example.com"])).toThrow(MonitorValidationError);
  });
});

describe("buildRawDriverConfig", () => {
  it("http: only the url", () => {
    expect(buildRawDriverConfig("http", { target: "https://example.com" })).toEqual({
      url: "https://example.com",
    });
  });
  it("keyword: pulls `expect` from a body_contains assertion", () => {
    expect(
      buildRawDriverConfig("keyword", {
        target: "https://example.com",
        assertions: [{ type: "body_contains", expr: "Book a table" }],
      }),
    ).toEqual({ url: "https://example.com", expect: "Book a table" });
  });
  it("keyword: expect is undefined with no matching assertion — the driver's own validate() refuses it", () => {
    expect(buildRawDriverConfig("keyword", { target: "https://example.com", assertions: [] })).toEqual({
      url: "https://example.com",
      expect: undefined,
    });
  });
  it("heartbeat: empty object when graceSec absent, letting the driver default it", () => {
    expect(buildRawDriverConfig("heartbeat", { target: "" })).toEqual({});
  });
  it("heartbeat: passes graceSec through untouched for the driver to validate", () => {
    expect(buildRawDriverConfig("heartbeat", { target: "", graceSec: 600 })).toEqual({ graceSec: 600 });
  });
  it("a kind with no config builder throws rather than silently returning {}", () => {
    expect(() => buildRawDriverConfig("tcp", { target: "example.com:443" })).toThrow(MonitorValidationError);
  });
});

describe("parseChannelKind", () => {
  it("accepts the six declared channel kinds", () => {
    for (const k of ["email", "telegram", "ntfy", "webhook", "wa", "mcp"]) {
      expect(parseChannelKind(k)).toBe(k);
    }
  });
  it("rejects an unknown kind rather than silently accepting a typo", () => {
    expect(() => parseChannelKind("carrier-pigeon")).toThrow(MonitorValidationError);
    expect(() => parseChannelKind(undefined)).toThrow(MonitorValidationError);
    expect(() => parseChannelKind(1)).toThrow(MonitorValidationError);
  });
});

describe("parseOptionalMatchSeverity", () => {
  it("returns null when unset — a catch-all, never a default severity", () => {
    expect(parseOptionalMatchSeverity(undefined)).toBeNull();
    expect(parseOptionalMatchSeverity(null)).toBeNull();
    expect(parseOptionalMatchSeverity("")).toBeNull();
  });
  it("accepts the three known severities", () => {
    expect(parseOptionalMatchSeverity("page")).toBe("page");
    expect(parseOptionalMatchSeverity("ticket")).toBe("ticket");
    expect(parseOptionalMatchSeverity("info")).toBe("info");
  });
  it("rejects anything else", () => {
    expect(() => parseOptionalMatchSeverity("urgent")).toThrow(MonitorValidationError);
  });
});

describe("parseOptionalMatchKind", () => {
  it("returns null when unset or blank", () => {
    expect(parseOptionalMatchKind(undefined)).toBeNull();
    expect(parseOptionalMatchKind(null)).toBeNull();
    expect(parseOptionalMatchKind("   ")).toBeNull();
  });
  it("trims and passes through any non-empty string — no re-validation against the driver registry", () => {
    expect(parseOptionalMatchKind(" http ")).toBe("http");
    expect(parseOptionalMatchKind("a-retired-kind")).toBe("a-retired-kind");
  });
});

describe("parseMaintenanceScope", () => {
  it("defaults to tenant-wide when absent", () => {
    expect(parseMaintenanceScope(undefined)).toEqual({ monitorId: null });
  });
  it("'all' means tenant-wide", () => {
    expect(parseMaintenanceScope("all")).toEqual({ monitorId: null });
  });
  it("'monitor:<uuid>' extracts the monitor id", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(parseMaintenanceScope(`monitor:${id}`)).toEqual({ monitorId: id });
  });
  it("rejects a malformed scope string rather than silently treating it as tenant-wide", () => {
    expect(() => parseMaintenanceScope("everything")).toThrow(MonitorValidationError);
    expect(() => parseMaintenanceScope("monitor:not-a-uuid")).toThrow(MonitorValidationError);
  });
});

describe("parseMaintenanceWindow", () => {
  it("accepts a forward-running window", () => {
    const w = parseMaintenanceWindow("2026-09-10T00:00:00Z", "2026-09-10T02:00:00Z");
    expect(w.endsAt.getTime()).toBeGreaterThan(w.startsAt.getTime());
  });
  it("rejects an inverted or zero-length window — K7's open-ended-alerting-mute failure", () => {
    expect(() => parseMaintenanceWindow("2026-09-10T02:00:00Z", "2026-09-10T00:00:00Z")).toThrow(
      MonitorValidationError,
    );
    expect(() => parseMaintenanceWindow("2026-09-10T00:00:00Z", "2026-09-10T00:00:00Z")).toThrow(
      MonitorValidationError,
    );
  });
  it("rejects unparseable dates", () => {
    expect(() => parseMaintenanceWindow("not-a-date", "2026-09-10T02:00:00Z")).toThrow(MonitorValidationError);
    expect(() => parseMaintenanceWindow("2026-09-10T00:00:00Z", "")).toThrow(MonitorValidationError);
  });
});

describe("parseResultWindow", () => {
  it("defaults to 24 hours when absent", () => {
    expect(parseResultWindow(undefined)).toBe("24 hours");
  });
  it("accepts 24h/7d/30d", () => {
    expect(parseResultWindow("24h")).toBe("24 hours");
    expect(parseResultWindow("7d")).toBe("7 days");
    expect(parseResultWindow("30d")).toBe("30 days");
  });
  it("rejects an unrecognised window rather than silently falling back to 24h", () => {
    expect(() => parseResultWindow("1y")).toThrow(MonitorValidationError);
  });
});
