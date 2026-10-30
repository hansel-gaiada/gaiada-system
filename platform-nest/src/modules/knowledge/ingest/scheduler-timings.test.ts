// AIP-03e: the sweep's summary line says where the time went (`sweepTimings`). Pure: no DB, no network.
import { describe, expect, it } from "vitest";
import { sweepTimings } from "./scheduler";
import type { IngestRunResult } from "./types";

const at = (s: number): string => new Date(Date.UTC(2026, 9, 30, 1, 28, 0) + s * 1000).toISOString();
const run = (tier: "public" | "internal", tenantId: string, from: number, to: number, extra: Partial<IngestRunResult> = {}): IngestRunResult => ({
  tier, tenantId, sources: 1, chunks: 1, retired: 0, errors: [], startedAt: at(from), finishedAt: at(to), ...extra,
});

describe("sweepTimings", () => {
  it("names the public tier with its crawl, the companies' total and the slowest company", () => {
    const line = sweepTimings([
      run("public", "019fb652-c68b", 0, 135, { crawlMs: 70_400 }),
      run("internal", "019fb652-c68b-728f", 135, 222),
      run("internal", "019fb652-c68f-778c", 222, 223),
    ]);
    expect(line).toBe("public 135s (crawl 70s), companies 88s, slowest 019fb652… 87s");
  });

  it("leaves out the crawl when the public tier never reached it (a config refusal or a failed crawl)", () => {
    expect(sweepTimings([run("public", "t", 0, 0)])).toBe("public 0s");
  });

  it("works with no public tier, and with nothing at all", () => {
    expect(sweepTimings([run("internal", "aaaaaaaa-1", 0, 5)])).toBe("companies 5s, slowest aaaaaaaa… 5s");
    expect(sweepTimings([])).toBe("");
  });

  it("reads an unparseable or reversed time as 0s instead of NaN or a negative", () => {
    expect(sweepTimings([{ ...run("internal", "bbbbbbbb-2", 10, 5) }])).toBe("companies 0s, slowest bbbbbbbb… 0s");
    expect(sweepTimings([{ ...run("internal", "cccccccc-3", 0, 1), startedAt: "not a date" }])).toBe("companies 0s, slowest cccccccc… 0s");
  });
});
