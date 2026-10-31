// M5-P5b2 — the pull job's ingest script: arguments, chunking, the grep pattern and the run loop. No database.
import { describe, it, expect, vi } from "vitest";
import { AI_CRAWLERS } from "../modules/search/ai-crawler-bots";
import { MAX_CHUNK_CHARS } from "../modules/search/ai-crawler-store";
import { chunkLines, grepPattern, parseArgs, runIngest, type RunDeps } from "./ai-crawler-ingest";

const T = "0190aaaa-0000-7000-8000-000000000001";
const P = "0190aaaa-0000-7000-8000-000000000002";

describe("parseArgs", () => {
  it("accepts --tenant and --property in either order", () => {
    expect(parseArgs(["--tenant", T, "--property", P])).toEqual({ mode: "ingest", tenantId: T, propertyId: P });
    expect(parseArgs(["--property", P, "--tenant", T])).toEqual({ mode: "ingest", tenantId: T, propertyId: P });
  });
  it("--grep-pattern is a mode only on its own", () => {
    expect(parseArgs(["--grep-pattern"])).toEqual({ mode: "grep" });
    expect(parseArgs(["--grep-pattern", "--tenant", T]).mode).toBe("error");
  });
  it("rejects missing, malformed and unknown arguments", () => {
    expect(parseArgs([]).mode).toBe("error");
    expect(parseArgs(["--tenant", T]).mode).toBe("error");
    expect(parseArgs(["--tenant", "nope", "--property", P]).mode).toBe("error");
    expect(parseArgs(["--tenant", T, "--property"]).mode).toBe("error");
    expect(parseArgs(["--tenant", T, "--property", "--tenant"]).mode).toBe("error");
    expect(parseArgs(["--tenant", T, "--property", P, "--x", "1"]).mode).toBe("error");
  });
});

describe("grepPattern", () => {
  it("holds every UA token of the allow-list and nothing else", () => {
    const parts = grepPattern().split("|");
    const tokens = AI_CRAWLERS.map((b) => b.uaToken).filter((t): t is string => t !== null);
    expect(new Set(parts)).toEqual(new Set(tokens));
    expect(parts).toContain("GPTBot");
    expect(parts).not.toContain("Google-Extended");
  });
  it("is a valid regex that matches a bot line and not a human line", () => {
    const re = new RegExp(grepPattern(), "i");
    expect(re.test('1.2.3.4 - - [x] "GET / HTTP/1.1" 200 1 "-" "Mozilla/5.0 (compatible; gptbot/1.1)"')).toBe(true);
    expect(re.test('1.2.3.4 - - [x] "GET / HTTP/1.1" 200 1 "-" "Mozilla/5.0 Chrome/126"')).toBe(false);
  });
});

describe("chunkLines", () => {
  it("returns no chunk for empty or blank input", () => {
    expect(chunkLines("")).toEqual([]);
    expect(chunkLines("\n \r\n\n")).toEqual([]);
  });
  it("keeps small input in one chunk, normalising CRLF", () => {
    expect(chunkLines("a\r\nb\n\nc\n")).toEqual(["a\nb\nc"]);
  });
  it("splits on line boundaries and never exceeds the limit", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}-${"x".repeat(20)}`);
    const chunks = chunkLines(lines.join("\n"), 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join("\n").split("\n")).toEqual(lines);
  });
  it("drops a single line longer than the limit", () => {
    expect(chunkLines(`ok\n${"y".repeat(50)}\nok2`, 20)).toEqual(["ok\nok2"]);
  });
  it("the default limit is the store's", () => {
    expect(chunkLines("a".repeat(MAX_CHUNK_CHARS - 1))).toHaveLength(1);
    expect(chunkLines(`${"a".repeat(MAX_CHUNK_CHARS - 5)}\n${"b".repeat(MAX_CHUNK_CHARS - 5)}`)).toHaveLength(2);
  });
});

const outcome = (chunk: "new" | "duplicate", rows: number) => ({
  chunk, rows, verification: "claimed" as const,
  stats: chunk === "new" ? { linesSeen: 2, malformed: 0, dropped: 0, kept: 2, outOfRange: 0, overflow: 0 } : null,
});

describe("runIngest", () => {
  const mk = (ingest: RunDeps["ingest"]) => {
    const activity = vi.fn(async () => {});
    return { deps: { ingest, activity, verifier: () => undefined } satisfies RunDeps, activity };
  };
  it("empty input is ok: no ingest, no activity", async () => {
    const ingest = vi.fn();
    const { deps, activity } = mk(ingest as never);
    const r = await runIngest("\n", { tenantId: T, propertyId: P }, deps);
    expect(r).toEqual({ ok: true, summary: { chunks: 0, new: 0, duplicate: 0, rows: 0, stats: {} } });
    expect(ingest).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
  });
  it("sums chunks and writes ONE activity", async () => {
    const ingest = vi.fn()
      .mockResolvedValueOnce(outcome("new", 3))
      .mockResolvedValueOnce(outcome("duplicate", 0))
      .mockResolvedValueOnce(outcome("new", 4));
    const { deps, activity } = mk(ingest as never);
    const big = (c: string) => c.repeat(MAX_CHUNK_CHARS - 5);
    const r = await runIngest([big("a"), big("b"), big("c")].join("\n"), { tenantId: T, propertyId: P }, deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary).toMatchObject({ chunks: 3, new: 2, duplicate: 1, rows: 7 });
      expect(r.summary.stats).toMatchObject({ linesSeen: 4, kept: 4 });
    }
    expect(activity).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![0]).toMatchObject({ userId: null, tenantId: T, propertyId: P });
  });
  it("no_property stops the run and writes no activity", async () => {
    const { deps, activity } = mk((async () => "no_property") as never);
    const r = await runIngest("line", { tenantId: T, propertyId: P }, deps);
    expect(r).toEqual({ ok: false, code: 3, reason: "no_property" });
    expect(activity).not.toHaveBeenCalled();
  });
});
