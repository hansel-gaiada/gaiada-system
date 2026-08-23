import { describe, it, expect } from "vitest";
import { findSeqGaps, hasSeqGap, nextCursor, type AgentRunEvent } from "./agentEvents";

function ev(seq: number): Pick<AgentRunEvent, "seq"> {
  return { seq };
}

describe("findSeqGaps", () => {
  it("no gap: a contiguous run from since=0 reports nothing missing", () => {
    expect(findSeqGaps([ev(1), ev(2), ev(3)], 0)).toEqual([]);
  });

  it("no gap: a contiguous continuation from a prior cursor reports nothing missing", () => {
    expect(findSeqGaps([ev(4), ev(5)], 3)).toEqual([]);
  });

  it("detects a single internal hole (e.g. seq 2 failed to write)", () => {
    expect(findSeqGaps([ev(1), ev(3)], 0)).toEqual([{ afterSeq: 1, beforeSeq: 3 }]);
  });

  it("detects a LEADING hole: the first page never starts above sinceSeq+1", () => {
    // A fresh load (since=0) whose first event is seq=5 means events 1..4 for this run were
    // dropped before the client ever asked — this is the case the task exists to catch.
    expect(findSeqGaps([ev(5), ev(6)], 0)).toEqual([{ afterSeq: 0, beforeSeq: 5 }]);
  });

  it("detects multiple non-adjacent holes in one page", () => {
    expect(findSeqGaps([ev(1), ev(3), ev(4), ev(7)], 0)).toEqual([
      { afterSeq: 1, beforeSeq: 3 },
      { afterSeq: 4, beforeSeq: 7 },
    ]);
  });

  it("an empty page relative to a nonzero cursor is not itself a gap", () => {
    expect(findSeqGaps([], 5)).toEqual([]);
  });
});

describe("hasSeqGap", () => {
  it("mirrors findSeqGaps as a boolean", () => {
    expect(hasSeqGap([ev(1), ev(2)], 0)).toBe(false);
    expect(hasSeqGap([ev(1), ev(3)], 0)).toBe(true);
  });
});

describe("nextCursor", () => {
  it("is the highest seq seen in the page", () => {
    expect(nextCursor([ev(1), ev(3), ev(2)], 0)).toBe(3);
  });

  it("never regresses on an empty page — returns the previous cursor unchanged", () => {
    expect(nextCursor([], 7)).toBe(7);
  });

  it("defaults to 0 for a fresh poller with no prior cursor and an empty page", () => {
    expect(nextCursor([])).toBe(0);
  });
});
