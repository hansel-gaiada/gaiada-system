// WSK-61: `liveVersionOf` restates Zone B's LIVE_SQL (webdesk/api content-reads.service.ts) from an
// `item.get` answer. It decides whether a schedule took effect, so each arm of the rule is pinned here.
import { describe, it, expect } from "vitest";
import { liveVersionOf } from "./scheduled-rebuilds.service";

const NOW = Date.parse("2026-10-11T08:00:00.000Z");
const before = "2026-10-11T07:59:00.000Z";
const after = "2026-10-11T08:01:00.000Z";
const item = (over: Record<string, unknown>) => ({
  publishState: "published", publishedVersion: 3, publishAt: null, unpublishAt: null, deletedAt: null, ...over,
});

describe("liveVersionOf — the version production serves at `now`", () => {
  it("published → its version; unpublished, draft, or no published version → null", () => {
    expect(liveVersionOf(item({}), NOW)).toBe(3);
    expect(liveVersionOf(item({ publishState: "unpublished" }), NOW)).toBeNull();
    expect(liveVersionOf(item({ publishState: "draft" }), NOW)).toBeNull();
    expect(liveVersionOf(item({ publishedVersion: null }), NOW)).toBeNull();
  });

  it("scheduled → live only once publishAt has passed (the tick need not have run)", () => {
    expect(liveVersionOf(item({ publishState: "scheduled", publishAt: before }), NOW)).toBe(3);
    expect(liveVersionOf(item({ publishState: "scheduled", publishAt: after }), NOW)).toBeNull();
    expect(liveVersionOf(item({ publishState: "scheduled", publishAt: null }), NOW)).toBeNull();
  });

  it("unpublishAt at or before now takes it down, whatever the state; a future one does not", () => {
    expect(liveVersionOf(item({ unpublishAt: before }), NOW)).toBeNull();
    expect(liveVersionOf(item({ unpublishAt: new Date(NOW).toISOString() }), NOW)).toBeNull();
    expect(liveVersionOf(item({ publishState: "scheduled", publishAt: before, unpublishAt: before }), NOW)).toBeNull();
    expect(liveVersionOf(item({ unpublishAt: after }), NOW)).toBe(3);
  });

  it("deleted → null; an unparseable instant is treated as absent, never as 'now'", () => {
    expect(liveVersionOf(item({ deletedAt: before }), NOW)).toBeNull();
    expect(liveVersionOf(item({ publishState: "scheduled", publishAt: "soon" }), NOW)).toBeNull();
    expect(liveVersionOf(item({ unpublishAt: "soon" }), NOW)).toBe(3);
  });
});
