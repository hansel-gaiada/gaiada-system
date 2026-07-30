import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { config } from "./config";
import { recordDigestRun, digestHistory, resetDigestHistoryCache, type DigestRecord } from "./digest-history";

const DIR = "data/test-digest-history";
const FILE = `${DIR}/digest-history.json`;

function entry(over: Partial<DigestRecord> = {}): DigestRecord {
  return {
    ts: Date.now(),
    slot: "noon",
    trigger: "manual",
    groupsCovered: 1,
    delivered: 1,
    failed: 0,
    managementDelivered: true,
    ...over,
  };
}

describe("digest history (1b)", () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    config.digestHistoryFile = FILE;
    resetDigestHistoryCache();
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("starts empty when no file exists yet", () => {
    expect(digestHistory()).toEqual([]);
  });

  it("records newest-first", () => {
    recordDigestRun(entry({ ts: 1, slot: "noon" }));
    recordDigestRun(entry({ ts: 2, slot: "evening" }));
    const h = digestHistory();
    expect(h.map((r) => r.slot)).toEqual(["evening", "noon"]);
  });

  it("caps at the last 50 entries", () => {
    for (let i = 0; i < 55; i++) recordDigestRun(entry({ ts: i }));
    const h = digestHistory(100);
    expect(h).toHaveLength(50);
    expect(h[0].ts).toBe(54); // newest kept
    expect(h[49].ts).toBe(5); // the 5 oldest were evicted
  });

  it("digestHistory(limit) caps the returned slice", () => {
    for (let i = 0; i < 10; i++) recordDigestRun(entry({ ts: i }));
    expect(digestHistory(3)).toHaveLength(3);
  });

  it("persists across a cache reset (survives a restart)", () => {
    recordDigestRun(entry({ ts: 1, error: "model down" }));
    resetDigestHistoryCache();
    const [r] = digestHistory();
    expect(r.error).toBe("model down");
  });

  it("never includes message text or digest body — counts/status only by construction", () => {
    recordDigestRun(entry({ groupsCovered: 3, delivered: 2, failed: 1 }));
    const [stored] = digestHistory();
    // No "error" key was supplied, so it must be absent (not even undefined) — same
    // optional-field convention as GroupConfig/WriteGroupsError elsewhere in this codebase.
    expect(Object.keys(stored).sort()).toEqual(
      ["delivered", "failed", "groupsCovered", "managementDelivered", "slot", "trigger", "ts"].sort(),
    );
  });

  it("a corrupt persisted file degrades to empty history, not a throw", () => {
    writeFileSync(FILE, "{not json");
    resetDigestHistoryCache();
    expect(digestHistory()).toEqual([]);
    // and it's still writable afterward (persist() doesn't refuse because of the old corruption)
    recordDigestRun(entry({ ts: 99 }));
    resetDigestHistoryCache();
    expect(digestHistory()[0].ts).toBe(99);
  });

  it("a missing `history` array in the file degrades to empty rather than throwing", () => {
    writeFileSync(FILE, JSON.stringify({ notHistory: [1, 2, 3] }));
    resetDigestHistoryCache();
    expect(digestHistory()).toEqual([]);
  });
});
