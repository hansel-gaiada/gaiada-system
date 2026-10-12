import { describe, it, expect, vi } from "vitest";
import {
  GONE_WORDS, MAX_PAGES, NOT_OPENED_WORDS, ReplaysShapeError, classifyReplayFailure, fmtDuration, pagesLabel, parseChunksPage, parseRecordingList,
  playRecording, stopWords, unavailableWords, UNAVAILABLE_FALLBACK_WORDS,
  type ChunksPage, type PageFetcher, type PageResult, type ReplayEvent,
} from "./replaysModel";

const P = "0194a3b2-aaaa-7000-8000-00000000000a";
const V = "0194a3b2-1111-7000-8000-000000000001";
const R = "0194a3b2-bbbb-7000-8000-0000000000b1";
const OPENING = "0194a3b2-cccc-7000-8000-0000000000c1";
const ev = (t: number, type = 3): ReplayEvent => ({ type, timestamp: t, data: {} });

const listBody = (o: Record<string, unknown> = {}) => ({
  propertyId: P, visitorId: V,
  recordings: [{ recordingId: R, startedAt: "2026-10-12T09:00:00.000Z", lastChunkAt: "2026-10-12T09:03:20.000Z", durationSeconds: 200, pages: ["https://gaiada.com/", "https://gaiada.com/contact/"], chunks: 20 }],
  ...o,
});
const pageBody = (o: Record<string, unknown> = {}) => ({
  propertyId: P, recordingId: R, from: 0, chunks: [{ seq: 0, receivedAt: "2026-10-12T09:00:10.000Z", events: [ev(1, 4), ev(2, 2)] }],
  more: false, nextFrom: null, opened: true, openingId: OPENING, ...o,
});

describe("parseRecordingList", () => {
  it("reads the contract's shape and keeps the server's order", () => {
    const l = parseRecordingList(listBody({ recordings: [
      { recordingId: R, startedAt: "2026-10-12T09:00:00.000Z", lastChunkAt: "2026-10-12T09:03:20.000Z", durationSeconds: 200, pages: [], chunks: 1 },
      { recordingId: "0194a3b2-bbbb-7000-8000-0000000000b2", startedAt: "2026-10-10T09:00:00.000Z", lastChunkAt: "2026-10-10T09:00:30.000Z", durationSeconds: 30.5, pages: ["https://gaiada.com/"], chunks: 3 },
    ] }));
    expect(l.propertyId).toBe(P);
    expect(l.visitorId).toBe(V);
    expect(l.recordings.map((r) => r.recordingId)).toEqual([R, "0194a3b2-bbbb-7000-8000-0000000000b2"]);
  });

  it("an empty list is a real answer, not an error", () => {
    expect(parseRecordingList(listBody({ recordings: [] })).recordings).toEqual([]);
  });

  it("refuses an off-contract body as a defect, never as an empty list", () => {
    expect(() => parseRecordingList(null)).toThrow(ReplaysShapeError);
    expect(() => parseRecordingList(listBody({ recordings: "none" }))).toThrow(/expected an array/);
    expect(() => parseRecordingList(listBody({ propertyId: "nope" }))).toThrow(/expected an id/);
    expect(() => parseRecordingList(listBody({ recordings: [{ recordingId: R }] }))).toThrow(ReplaysShapeError);
    const bad = (k: string, v: unknown) => listBody({ recordings: [{ ...listBody().recordings[0], [k]: v }] });
    expect(() => parseRecordingList(bad("durationSeconds", -1))).toThrow(/seconds/);
    expect(() => parseRecordingList(bad("chunks", 1.5))).toThrow(/whole number/);
    expect(() => parseRecordingList(bad("startedAt", "yesterday"))).toThrow(/date/);
    expect(() => parseRecordingList(bad("pages", [3]))).toThrow(/string/);
  });
});

describe("parseChunksPage", () => {
  it("reads an opening page", () => {
    const p = parseChunksPage(pageBody());
    expect(p.opened).toBe(true);
    expect(p.openingId).toBe(OPENING);
    expect(p.more).toBe(false);
    expect(p.nextFrom).toBeNull();
    expect(p.chunks[0].events).toHaveLength(2);
  });

  it("reads a later page: not an opening, no opening id, a next page named when there is more", () => {
    const p = parseChunksPage(pageBody({ from: 20, opened: false, openingId: null, more: true, nextFrom: 40 }));
    expect(p.opened).toBe(false);
    expect(p.openingId).toBeNull();
    expect(p.nextFrom).toBe(40);
  });

  it("holds the opening rules of §28g", () => {
    expect(() => parseChunksPage(pageBody({ openingId: null }))).toThrow(/opening page must carry/);
    expect(() => parseChunksPage(pageBody({ opened: false }))).toThrow(/only an opening page/);
    expect(() => parseChunksPage(pageBody({ more: true, nextFrom: null }))).toThrow(/where the next one starts/);
    expect(() => parseChunksPage(pageBody({ more: false, nextFrom: 20 }))).toThrow(/must not name a next one/);
  });

  it("refuses an event the replayer would choke on, naming where", () => {
    expect(() => parseChunksPage(pageBody({ chunks: [{ seq: 0, receivedAt: "2026-10-12T09:00:10.000Z", events: [{ type: "x", timestamp: 1 }] }] }))).toThrow(/events\[0\]/);
    expect(() => parseChunksPage(pageBody({ chunks: [{ seq: 0, receivedAt: "2026-10-12T09:00:10.000Z", events: [{ type: 2 }] }] }))).toThrow(ReplaysShapeError);
    expect(() => parseChunksPage(pageBody({ chunks: "x" }))).toThrow(/expected an array/);
  });
});

describe("failures are words", () => {
  it("maps status and reason", () => {
    expect(classifyReplayFailure(401, null)).toEqual({ kind: "signed_out" });
    expect(classifyReplayFailure(403, null)).toEqual({ kind: "forbidden" });
    expect(classifyReplayFailure(404, "recording_not_found")).toEqual({ kind: "not_found", reason: "recording_not_found" });
    expect(classifyReplayFailure(409, "not_opened")).toEqual({ kind: "not_opened" });
    expect(classifyReplayFailure(400, "from_invalid")).toEqual({ kind: "bad_request" });
  });

  it("409 without the not_opened reason is not a restart", () => {
    expect(classifyReplayFailure(409, "something_else").kind).toBe("unavailable");
  });

  it("every 503 reason has its own sentence, none is the code", () => {
    const reasons = ["collector_unreachable", "collector_rejected", "not_configured", "no_website"];
    const sentences = reasons.map((r) => unavailableWords(r));
    expect(new Set(sentences).size).toBe(4);
    for (const [i, r] of reasons.entries()) {
      expect(sentences[i]).not.toContain(r);
      const f = classifyReplayFailure(503, r);
      expect(f).toEqual({ kind: "unavailable", reason: r, message: sentences[i] });
    }
    expect(unavailableWords("a_new_reason")).toBe(UNAVAILABLE_FALLBACK_WORDS);
    expect(classifyReplayFailure(500, "collector_unreachable")).toMatchObject({ kind: "unavailable", reason: null, message: UNAVAILABLE_FALLBACK_WORDS });
  });
});

describe("words for a list", () => {
  it("durations", () => {
    expect(fmtDuration(0)).toBe("0 s");
    expect(fmtDuration(45.4)).toBe("45 s");
    expect(fmtDuration(200)).toBe("3 min 20 s");
    expect(fmtDuration(125)).toBe("2 min 05 s");
    expect(fmtDuration(3720)).toBe("1 h 02 min");
  });
  it("pages", () => {
    expect(pagesLabel([])).toBe("no pages recorded");
    expect(pagesLabel(["https://a.com/", "https://a.com/b/"])).toBe("https://a.com/, https://a.com/b/");
    expect(pagesLabel(["1", "2", "3", "4", "5"])).toBe("1, 2, 3 and 2 more");
  });
});

// ── the paging state machine ─────────────────────────────────────────────────────────────────────────────────────
const page = (o: Partial<ChunksPage>): ChunksPage => parseChunksPage(pageBody(o as Record<string, unknown>));
const ok = (p: ChunksPage): PageResult => ({ kind: "ok", page: p });
const chunk = (seq: number, ...ts: number[]) => ({ seq, receivedAt: "2026-10-12T09:00:10.000Z", events: ts.map((t) => ev(t)) });
/** A fetcher answering from a script, recording what it was asked. */
function script(...answers: PageResult[]) {
  const calls: Array<{ from: number; opening: string | null }> = [];
  const f: PageFetcher = async (from, opening) => { calls.push({ from, opening }); return answers[calls.length - 1] ?? { kind: "unavailable", reason: null, message: "script ran out" }; };
  return { f, calls };
}

describe("playRecording", () => {
  it("one page: asks once with from 0 and no opening, and is ready", async () => {
    const s = script(ok(page({ chunks: [chunk(0, 1, 2, 3)] })));
    const out = await playRecording(s.f);
    expect(out).toMatchObject({ kind: "ready", chunks: 1, pages: 1 });
    expect(s.calls).toEqual([{ from: 0, opening: null }]);
    if (out.kind === "ready") expect(out.events.map((e) => e.timestamp)).toEqual([1, 2, 3]);
  });

  it("keeps the opening id from page 1 for the whole Play and pages on from nextFrom, in order", async () => {
    const s = script(
      ok(page({ chunks: [chunk(0, 1, 2), chunk(1, 3)], more: true, nextFrom: 20 })),
      ok(page({ from: 20, opened: false, openingId: null, chunks: [chunk(20, 4)], more: true, nextFrom: 40 })),
      ok(page({ from: 40, opened: false, openingId: null, chunks: [chunk(40, 5, 6)], more: false, nextFrom: null })),
    );
    const progress: Array<{ pages: number; chunks: number }> = [];
    const out = await playRecording(s.f, { onProgress: (p) => progress.push(p) });
    expect(s.calls).toEqual([{ from: 0, opening: null }, { from: 20, opening: OPENING }, { from: 40, opening: OPENING }]);
    expect(out).toMatchObject({ kind: "ready", chunks: 4, pages: 3 });
    if (out.kind === "ready") expect(out.events.map((e) => e.timestamp)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress).toEqual([{ pages: 1, chunks: 2 }, { pages: 2, chunks: 3 }, { pages: 3, chunks: 4 }]);
  });

  it("a second Play starts from the beginning with no opening (a new opening)", async () => {
    const first = script(ok(page({ chunks: [chunk(0, 1, 2)] })));
    await playRecording(first.f);
    const second = script(ok(page({ openingId: "0194a3b2-cccc-7000-8000-0000000000c2", chunks: [chunk(0, 1, 2)] })));
    await playRecording(second.f);
    expect(second.calls).toEqual([{ from: 0, opening: null }]);
  });

  it("409 not_opened on a later page stops with nothing played, and says to start again", async () => {
    const s = script(ok(page({ chunks: [chunk(0, 1, 2)], more: true, nextFrom: 20 })), { kind: "not_opened" });
    const out = await playRecording(s.f);
    expect(out).toEqual({ kind: "not_opened" });
    expect(stopWords({ kind: "not_opened" })).toBe(NOT_OPENED_WORDS);
    expect(NOT_OPENED_WORDS).toMatch(/Start again/);
  });

  it("404 mid-replay stops and says the recording is no longer available; no half play", async () => {
    const s = script(ok(page({ chunks: [chunk(0, 1, 2)], more: true, nextFrom: 20 })), { kind: "not_found", reason: "recording_not_found" });
    const out = await playRecording(s.f);
    expect(out).toEqual({ kind: "gone" });
    expect(out.kind).not.toBe("ready");
    expect(stopWords({ kind: "gone" })).toBe(GONE_WORDS);
    expect(GONE_WORDS).toMatch(/no longer available/);
  });

  it("404 on page 1 is the same: gone", async () => {
    expect(await playRecording(script({ kind: "not_found", reason: null }).f)).toEqual({ kind: "gone" });
  });

  it("503 is a stop in words, by reason", async () => {
    for (const reason of ["collector_unreachable", "collector_rejected", "not_configured", "no_website"]) {
      const out = await playRecording(script({ kind: "unavailable", reason, message: unavailableWords(reason) }).f);
      expect(out).toMatchObject({ kind: "unavailable", reason });
      if (out.kind === "unavailable") {
        expect(stopWords(out)).toBe(unavailableWords(reason));
        expect(stopWords(out)).not.toContain(reason);
      }
    }
  });

  it("forbidden, signed out and bad request stop at once", async () => {
    for (const kind of ["forbidden", "signed_out", "bad_request"] as const) {
      const s = script({ kind });
      expect(await playRecording(s.f)).toEqual({ kind });
      expect(s.calls).toHaveLength(1);
      expect(stopWords({ kind })).not.toBe("");
    }
  });

  it("a first page that is not an opening is a contract defect", async () => {
    const p = { ...page({}), opened: false, openingId: null };
    expect(await playRecording(script(ok(p)).f)).toMatchObject({ kind: "drift" });
  });

  it("a nextFrom that does not advance is a defect, not a loop", async () => {
    const s = script(ok(page({ chunks: [chunk(0, 1, 2)], more: true, nextFrom: 0 })));
    expect(await playRecording(s.f)).toMatchObject({ kind: "drift" });
    expect(s.calls).toHaveLength(1);
  });

  it("a server that always says more is cut at MAX_PAGES", async () => {
    let n = 0;
    const f: PageFetcher = async (from) => {
      n += 1;
      return from === 0 ? ok(page({ chunks: [chunk(0, 1, 2)], more: true, nextFrom: 20 })) : ok(page({ from, opened: false, openingId: null, chunks: [chunk(from, from)], more: true, nextFrom: from + 20 }));
    };
    const out = await playRecording(f);
    expect(out).toMatchObject({ kind: "drift" });
    expect(n).toBe(MAX_PAGES);
  });

  it("fewer than two events is 'empty', not a player that throws", async () => {
    expect(await playRecording(script(ok(page({ chunks: [chunk(0, 1)] }))).f)).toEqual({ kind: "empty" });
    expect(await playRecording(script(ok(page({ chunks: [] }))).f)).toEqual({ kind: "empty" });
  });

  it("a cancelled Play stops asking", async () => {
    let cancelled = false;
    const s = script(ok(page({ chunks: [chunk(0, 1, 2)], more: true, nextFrom: 20 })), ok(page({ from: 20, opened: false, openingId: null, chunks: [chunk(20, 4)] })));
    const out = await playRecording(s.f, { isCancelled: () => cancelled, onProgress: () => { cancelled = true; } });
    expect(out).toEqual({ kind: "cancelled" });
    expect(s.calls).toHaveLength(1);
    expect(stopWords({ kind: "cancelled" })).toBe("");
  });

  it("calls the progress callback once per page and not on a failure", async () => {
    const onProgress = vi.fn();
    await playRecording(script({ kind: "not_found", reason: null }).f, { onProgress });
    expect(onProgress).not.toHaveBeenCalled();
  });
});
