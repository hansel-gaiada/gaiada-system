import { describe, it, expect } from "vitest";
import { describeDegrade, isBehindLatest, type ContractPinStatus, type DegradeMeta } from "./webdesk";

function meta(over: Partial<DegradeMeta> = {}): DegradeMeta {
  return { stale: true, source: "facts", asOf: "2026-08-27T00:00:00Z", reason: "zone_b_has_no_live_environment_status_read_endpoint_yet", ...over };
}

describe("describeDegrade — every reason token this backend can send maps to plain language", () => {
  it("has copy for every token console-reads.service.ts actually emits (kept in sync by hand — see that file's own reason strings)", () => {
    const knownReasons = [
      "zone_b_has_no_live_environment_status_read_endpoint_yet",
      "zone_b_has_no_live_release_read_endpoint_yet",
      "slim_pii_free_projection_from_zoneb_event_log_only",
      "control_channel_not_configured",
      "control_channel_egress_error",
      "live_control_channel_read",
    ];
    for (const reason of knownReasons) {
      expect(describeDegrade(meta({ reason }))).not.toMatch(/^Showing the most recently known value\.$/);
    }
  });

  it("an UNKNOWN reason token falls back to an honest generic sentence, never a raw token or a crash", () => {
    expect(describeDegrade(meta({ reason: "some_future_reason_this_ui_has_never_seen" }))).toBe(
      "Showing the most recently known value.",
    );
    expect(describeDegrade(meta({ reason: "some_future_reason_this_ui_has_never_seen", stale: false }))).toBe(
      "Live from WebDesk.",
    );
  });
});

function pin(over: Partial<ContractPinStatus> = {}): ContractPinStatus {
  return {
    webdeskTenantSlug: "acme",
    pinned: null,
    latest: { version: null, vocabularyVersion: null, ...meta() },
    ...over,
  };
}

describe("isBehindLatest — null means 'can't tell', never coerced to false", () => {
  it("no pin yet -> null, not false (there is nothing to compare)", () => {
    expect(isBehindLatest(pin({ pinned: null }))).toBeNull();
  });

  it("pinned exists but latest.version is unknown (fully degraded, no cache/fact) -> null, not false", () => {
    const status = pin({
      pinned: { snapshotId: "s1", contractVersion: "1.0.0", vocabularyVersion: "1.0.0", contentHash: "sha256:x", fetchedAt: "2026-08-01T00:00:00Z" },
      latest: { version: null, vocabularyVersion: null, ...meta({ source: "unavailable", asOf: null }) },
    });
    expect(isBehindLatest(status)).toBeNull();
  });

  it("pinned matches latest -> false", () => {
    const status = pin({
      pinned: { snapshotId: "s1", contractVersion: "1.0.0", vocabularyVersion: "1.0.0", contentHash: "sha256:x", fetchedAt: "2026-08-01T00:00:00Z" },
      latest: { version: "1.0.0", vocabularyVersion: "1.0.0", ...meta({ source: "live", stale: false }) },
    });
    expect(isBehindLatest(status)).toBe(false);
  });

  it("pinned is older than latest -> true, even when latest is only known via a degraded fact", () => {
    const status = pin({
      pinned: { snapshotId: "s1", contractVersion: "1.0.0", vocabularyVersion: "1.0.0", contentHash: "sha256:x", fetchedAt: "2026-08-01T00:00:00Z" },
      latest: { version: "1.2.0", vocabularyVersion: "1.1.0", ...meta({ source: "facts" }) },
    });
    expect(isBehindLatest(status)).toBe(true);
  });
});
