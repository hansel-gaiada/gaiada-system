import { describe, it, expect } from "vitest";
import {
  groupThreads, filterThreads, threadTitle, isPendingMessage,
  parseSSEBuffer, decodeAssistantEvent, streamReducer, initialStreamState, humanizeErrorKind,
  type AssistantThread,
} from "./assistant";

function thread(overrides: Partial<AssistantThread> = {}): AssistantThread {
  return {
    id: "t1", ownerUserId: "u1", title: "Hello", brainProvider: null, brainModel: null,
    hermesSessionId: null, status: "active", pinned: false, lastMessageAt: "2026-08-04T09:00:00Z",
    totalTokens: 0, totalCostUsd: "0.00", compactionSummary: null, compactionSummaryUptoSeq: null,
    createdAt: "2026-08-04T09:00:00Z", updatedAt: "2026-08-04T09:00:00Z", ...overrides,
  };
}

describe("threadTitle / isPendingMessage", () => {
  it("falls back to 'New chat' for a null/blank title", () => {
    expect(threadTitle({ title: null })).toBe("New chat");
    expect(threadTitle({ title: "  " })).toBe("New chat");
    expect(threadTitle({ title: "Real title" })).toBe("Real title");
  });
  it("a pending message has null content AND null errorKind — either alone is not pending", () => {
    expect(isPendingMessage({ content: null, errorKind: null })).toBe(true);
    expect(isPendingMessage({ content: null, errorKind: "stopped" })).toBe(false);
    expect(isPendingMessage({ content: "", errorKind: null })).toBe(false);
  });
});

describe("groupThreads — pinned split + Today/Yesterday/Last 7 Days/Older", () => {
  const now = new Date("2026-08-05T12:00:00Z");
  it("pins take precedence over date grouping", () => {
    const t = thread({ id: "p1", pinned: true, lastMessageAt: "2026-01-01T00:00:00Z" });
    const g = groupThreads([t], now);
    expect(g.pinned.map((x) => x.id)).toEqual(["p1"]);
    expect(g.groups.every((grp) => grp.threads.every((x) => x.id !== "p1"))).toBe(true);
  });
  it("buckets by lastMessageAt (falling back to createdAt) at day granularity", () => {
    const today = thread({ id: "today", lastMessageAt: "2026-08-05T08:00:00Z" });
    const yesterday = thread({ id: "yesterday", lastMessageAt: "2026-08-04T08:00:00Z" });
    const last7 = thread({ id: "last7", lastMessageAt: "2026-08-01T08:00:00Z" });
    const older = thread({ id: "older", lastMessageAt: "2026-07-01T08:00:00Z" });
    const noMessagesYet = thread({ id: "fresh", lastMessageAt: null, createdAt: "2026-08-05T09:00:00Z" });
    const g = groupThreads([today, yesterday, last7, older, noMessagesYet], now);
    const byLabel = Object.fromEntries(g.groups.map((grp) => [grp.label, grp.threads.map((x) => x.id)]));
    expect(byLabel.Today).toEqual(["today", "fresh"]);
    expect(byLabel.Yesterday).toEqual(["yesterday"]);
    expect(byLabel["Last 7 Days"]).toEqual(["last7"]);
    expect(byLabel.Older).toEqual(["older"]);
  });
});

describe("filterThreads", () => {
  it("is a case-insensitive substring match on title, defaulting a null title to 'New chat'", () => {
    const rows = [thread({ id: "a", title: "Draft the Q3 update" }), thread({ id: "b", title: null })];
    expect(filterThreads(rows, "q3").map((t) => t.id)).toEqual(["a"]);
    expect(filterThreads(rows, "new chat").map((t) => t.id)).toEqual(["b"]);
    expect(filterThreads(rows, "").map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("parseSSEBuffer — the exact wire framing sseLine() produces", () => {
  it("parses a complete block and returns the remainder", () => {
    const { blocks, rest } = parseSSEBuffer('event: token\ndata: {"text":"hi"}\n\nevent: do');
    expect(blocks).toEqual([{ event: "token", data: '{"text":"hi"}' }]);
    expect(rest).toBe("event: do");
  });
  it("parses a default (unnamed) event as 'message'", () => {
    const { blocks } = parseSSEBuffer('data: "hello"\n\n');
    expect(blocks).toEqual([{ event: "message", data: '"hello"' }]);
  });
  it("ignores a comment-only block (no data: line)", () => {
    const { blocks, rest } = parseSSEBuffer(": ping\n\n");
    expect(blocks).toEqual([]);
    expect(rest).toBe("");
  });
  it("accumulates across chunk boundaries — a block split mid-stream parses once the rest arrives", () => {
    const first = parseSSEBuffer('event: token\ndata: {"te');
    expect(first.blocks).toEqual([]);
    const second = parseSSEBuffer(`${first.rest}xt":"hi"}\n\n`);
    expect(second.blocks).toEqual([{ event: "token", data: '{"text":"hi"}' }]);
  });
});

describe("decodeAssistantEvent — guards against malformed/unrecognised blocks", () => {
  it("decodes token/usage/done/error", () => {
    expect(decodeAssistantEvent({ event: "token", data: '{"text":"hi"}' })).toEqual({ type: "token", text: "hi" });
    expect(decodeAssistantEvent({ event: "usage", data: '{"tokens":10,"latencyMs":200}' })).toEqual({ type: "usage", tokens: 10, latencyMs: 200 });
    expect(decodeAssistantEvent({ event: "done", data: "{}" })).toEqual({ type: "done" });
    expect(decodeAssistantEvent({ event: "error", data: '{"error":"boom","errorKind":"upstream_error"}' }))
      .toEqual({ type: "error", error: "boom", errorKind: "upstream_error" });
  });
  it("returns null for malformed JSON", () => {
    expect(decodeAssistantEvent({ event: "token", data: "not json" })).toBeNull();
  });
  it("returns null for a token block whose data.text is not a string", () => {
    expect(decodeAssistantEvent({ event: "token", data: "{}" })).toBeNull();
    expect(decodeAssistantEvent({ event: "token", data: '{"text":123}' })).toBeNull();
  });
  it("returns null for an unrecognised event name", () => {
    expect(decodeAssistantEvent({ event: "tool_call", data: "{}" })).toBeNull();
  });
});

describe("streamReducer — pure, immutable, guarded against terminal-state resurrection", () => {
  it("accumulates tokens instantly (no smoothing in the reducer itself)", () => {
    let s = initialStreamState();
    s = streamReducer(s, { type: "token", text: "Hel" });
    s = streamReducer(s, { type: "token", text: "lo" });
    expect(s).toEqual({ status: "streaming", text: "Hello", usage: null, error: null });
  });
  it("done is terminal", () => {
    let s = initialStreamState();
    s = streamReducer(s, { type: "token", text: "hi" });
    s = streamReducer(s, { type: "done" });
    expect(s.status).toBe("done");
  });
  it("guard: an event after a terminal state is dropped, not applied", () => {
    let s = initialStreamState();
    s = streamReducer(s, { type: "done" });
    const after = streamReducer(s, { type: "token", text: "late token" });
    expect(after).toBe(s); // same reference — proves it was a no-op, not just an equal value
  });
  it("an error with errorKind 'stopped' is its own terminal status, distinct from 'error'", () => {
    let s = initialStreamState();
    s = streamReducer(s, { type: "error", error: "Stopped.", errorKind: "stopped" });
    expect(s.status).toBe("stopped");
  });
  it("any other errorKind lands status 'error' and records the message/kind", () => {
    const s = streamReducer(initialStreamState(), { type: "error", error: "boom", errorKind: "upstream_error" });
    expect(s).toEqual({ status: "error", text: "", usage: null, error: { message: "boom", kind: "upstream_error" } });
  });
  it("never mutates the previous state object", () => {
    const s0 = initialStreamState();
    const s1 = streamReducer(s0, { type: "token", text: "x" });
    expect(s0).toEqual({ status: "idle", text: "", usage: null, error: null });
    expect(s1).not.toBe(s0);
  });
});

describe("humanizeErrorKind", () => {
  it("has a friendly label for every backend-documented kind plus the client-synthesized ones", () => {
    for (const kind of [
      "upstream_error", "abnormal_drop", "idle_timeout", "stopped", "client_disconnected",
      "not_configured", "transport_error", "client_idle_timeout", "client_abnormal_drop", "client_error",
    ]) {
      expect(humanizeErrorKind(kind)).not.toBe("Something went wrong.");
    }
  });
  it("falls back gracefully for an unknown kind", () => {
    expect(humanizeErrorKind("some_new_kind_the_ui_has_never_seen")).toBe("Something went wrong.");
  });
});
