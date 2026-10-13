// WSK-61: `liveVersionOf` restates Zone B's LIVE_SQL (webdesk/api content-reads.service.ts) from an
// `item.get` answer. It decides whether a schedule took effect, so each arm of the rule is pinned here.
import { describe, it, expect } from "vitest";
import { liveVersionNow } from "../search/indexnow-webdesk";
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

// M5-P5a2: the search module cannot import webdev statically, so it restates the rule as `liveVersionNow`
// (search/indexnow-webdesk.ts). This table pins the two together: if either side changes alone, a row fails.
// A deliberately divergent change this would catch: `liveVersionNow` treating `unpublishAt === now` as still live
// (`<` instead of `<=`) breaks the "unpublishAt exactly now" row; one ignoring `deletedAt` breaks the deleted row.
describe("liveVersionOf and search's liveVersionNow agree", () => {
  const nowIso = new Date(NOW).toISOString();
  const cases: Array<[string, Record<string, unknown>]> = [
    ["published", item({})],
    ["unpublished", item({ publishState: "unpublished" })],
    ["draft", item({ publishState: "draft" })],
    ["no published version", item({ publishedVersion: null })],
    ["published version of the wrong type", item({ publishedVersion: "3" })],
    ["scheduled, publishAt past", item({ publishState: "scheduled", publishAt: before })],
    ["scheduled, publishAt exactly now", item({ publishState: "scheduled", publishAt: nowIso })],
    ["scheduled, publishAt future", item({ publishState: "scheduled", publishAt: after })],
    ["scheduled, no publishAt", item({ publishState: "scheduled", publishAt: null })],
    ["scheduled, unparseable publishAt", item({ publishState: "scheduled", publishAt: "soon" })],
    ["unpublishAt past", item({ unpublishAt: before })],
    ["unpublishAt exactly now", item({ unpublishAt: nowIso })],
    ["unpublishAt future", item({ unpublishAt: after })],
    ["unpublishAt unparseable", item({ unpublishAt: "soon" })],
    ["scheduled, publishAt and unpublishAt both past", item({ publishState: "scheduled", publishAt: before, unpublishAt: before })],
    ["deleted", item({ deletedAt: before })],
    ["deletedAt undefined", item({ deletedAt: undefined })],
    ["deleted and scheduled past", item({ publishState: "scheduled", publishAt: before, deletedAt: before })],
  ];
  for (const [name, it_] of cases) {
    it(name, () => expect(liveVersionNow(it_, NOW)).toBe(liveVersionOf(it_, NOW)));
  }
});