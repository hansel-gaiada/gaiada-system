import { describe, it, expect } from "vitest";
import {
  groupThreads, filterThreads, threadTitle, isPendingMessage,
  parseSSEBuffer, decodeAssistantEvent, streamReducer, initialStreamState, humanizeErrorKind,
  brainBadgeLabel, parseUsageMeta, usageMeterLabel,
  isPendingMemory, groupMemory,
  groupCapabilities, parseCitations, parseSessionResumeMismatch,
  type AssistantThread, type AssistantMemory, type AssistantCapability,
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
    expect(decodeAssistantEvent({ event: "usage", data: '{"tokens":10,"latencyMs":200}' }))
      .toEqual({ type: "usage", tokens: 10, latencyMs: 200, source: "estimate", promptTokens: undefined, completionTokens: undefined });
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

  // ── ASST-12: meta + real usage ────────────────────────────────────────────────────────────────
  it("decodes a meta event naming the serving provider/model", () => {
    expect(decodeAssistantEvent({ event: "meta", data: '{"provider":"ollama","model":"llama3.2"}' }))
      .toEqual({ type: "meta", provider: "ollama", model: "llama3.2" });
  });
  it("model:\"\" is a truthful absence, decoded as-is, never dropped", () => {
    expect(decodeAssistantEvent({ event: "meta", data: '{"provider":"echo","model":""}' }))
      .toEqual({ type: "meta", provider: "echo", model: "" });
  });
  it("returns null for a meta block missing provider/model", () => {
    expect(decodeAssistantEvent({ event: "meta", data: "{}" })).toBeNull();
  });
  it("decodes real usage with source:'provider' plus the prompt/completion breakdown", () => {
    expect(decodeAssistantEvent({ event: "usage", data: '{"tokens":15,"latencyMs":300,"source":"provider","promptTokens":10,"completionTokens":5}' }))
      .toEqual({ type: "usage", tokens: 15, latencyMs: 300, source: "provider", promptTokens: 10, completionTokens: 5 });
  });
  it("an unrecognised source value defaults to 'estimate' — never assumed 'provider'", () => {
    const decoded = decodeAssistantEvent({ event: "usage", data: '{"tokens":5,"latencyMs":10,"source":"bogus"}' });
    expect(decoded).toMatchObject({ type: "usage", source: "estimate" });
  });
});

describe("streamReducer — pure, immutable, guarded against terminal-state resurrection", () => {
  it("accumulates tokens instantly (no smoothing in the reducer itself)", () => {
    let s = initialStreamState();
    s = streamReducer(s, { type: "token", text: "Hel" });
    s = streamReducer(s, { type: "token", text: "lo" });
    expect(s).toEqual({ status: "streaming", text: "Hello", meta: null, usage: null, citations: [], error: null });
  });
  it("meta sets the live badge state as soon as it arrives, non-terminal", () => {
    let s = initialStreamState();
    s = streamReducer(s, { type: "meta", provider: "ollama", model: "llama3.2" });
    expect(s.meta).toEqual({ provider: "ollama", model: "llama3.2" });
    expect(s.status).toBe("idle"); // meta alone doesn't start "streaming" — a token does
  });
  it("real usage overrides what the reducer is holding — the meter can then say 'measured'", () => {
    let s = initialStreamState();
    s = streamReducer(s, { type: "usage", tokens: 15, latencyMs: 300, source: "provider", promptTokens: 10, completionTokens: 5 });
    expect(s.usage).toEqual({ tokens: 15, latencyMs: 300, source: "provider", promptTokens: 10, completionTokens: 5 });
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
    expect(s).toEqual({ status: "error", text: "", meta: null, usage: null, citations: [], error: { message: "boom", kind: "upstream_error" } });
  });
  it("never mutates the previous state object", () => {
    const s0 = initialStreamState();
    const s1 = streamReducer(s0, { type: "token", text: "x" });
    expect(s0).toEqual({ status: "idle", text: "", meta: null, usage: null, citations: [], error: null });
    expect(s1).not.toBe(s0);
  });
});

describe("brainBadgeLabel — absent meta is 'Unknown provider', never blank or an error", () => {
  it("renders provider + model when both are known", () => {
    expect(brainBadgeLabel("ollama", "llama3.2")).toBe("ollama · llama3.2");
  });
  it("a null provider (no meta ever arrived) renders 'Unknown provider'", () => {
    expect(brainBadgeLabel(null, null)).toBe("Unknown provider");
    expect(brainBadgeLabel(null, "some-model")).toBe("Unknown provider");
  });
  it("model:\"\" (a provider with no fixed-model concept, e.g. echo) renders 'unknown model', not blank", () => {
    expect(brainBadgeLabel("echo", "")).toBe("echo · unknown model");
  });
});

describe("parseUsageMeta — reads the persisted parts[]; the source is never re-derived in the UI", () => {
  it("finds the usage_meta entry among other parts", () => {
    expect(parseUsageMeta([{ type: "usage_meta", usageSource: "provider", promptTokens: 10, completionTokens: 5 }]))
      .toEqual({ type: "usage_meta", usageSource: "provider", promptTokens: 10, completionTokens: 5 });
  });
  it("returns null for a message predating ASST-12 (empty parts, or not an array)", () => {
    expect(parseUsageMeta([])).toBeNull();
    expect(parseUsageMeta(null)).toBeNull();
    expect(parseUsageMeta(undefined)).toBeNull();
  });
});

describe("usageMeterLabel — distinguishes a real measurement from the estimate, out loud", () => {
  it("labels a provider-sourced count as measured", () => {
    expect(usageMeterLabel(78, "provider")).toBe("78 tokens (measured)");
  });
  it("labels an estimate-sourced count as estimated", () => {
    expect(usageMeterLabel(42, "estimate")).toBe("42 tokens (estimated)");
  });
  it("null usageSource (predates ASST-12) still renders — defaults to estimated, never crashes", () => {
    expect(usageMeterLabel(10, null)).toBe("10 tokens (estimated)");
  });
  it("returns null when there is nothing to show yet", () => {
    expect(usageMeterLabel(null, null)).toBeNull();
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

function memory(overrides: Partial<AssistantMemory> = {}): AssistantMemory {
  return {
    id: "m1", ownerUserId: "u1", scope: "user", content: "likes dark mode",
    provenance: "user", trust: "untrusted", pinned: false, confirmedAt: null, sourceThreadId: null,
    createdAt: "2026-08-04T09:00:00Z", updatedAt: "2026-08-04T09:00:00Z", ...overrides,
  };
}

describe("isPendingMemory", () => {
  it("a null confirmedAt is pending (a proposal, inert on the backend)", () => {
    expect(isPendingMemory(memory({ confirmedAt: null }))).toBe(true);
  });
  it("a set confirmedAt is not pending", () => {
    expect(isPendingMemory(memory({ confirmedAt: "2026-08-04T09:05:00Z" }))).toBe(false);
  });
});

describe("groupMemory", () => {
  it("splits pending vs confirmed, each pinned-first-then-most-recent", () => {
    const items: AssistantMemory[] = [
      memory({ id: "old-confirmed", confirmedAt: "2026-08-01T00:00:00Z" }),
      memory({ id: "pinned-confirmed", pinned: true, confirmedAt: "2026-08-02T00:00:00Z" }),
      memory({ id: "new-confirmed", confirmedAt: "2026-08-03T00:00:00Z" }),
      memory({ id: "pending-1", confirmedAt: null, createdAt: "2026-08-01T00:00:00Z" }),
      memory({ id: "pinned-pending", pinned: true, confirmedAt: null, createdAt: "2026-08-02T00:00:00Z" }),
    ];
    const { pending, confirmed } = groupMemory(items);
    expect(pending.map((m) => m.id)).toEqual(["pinned-pending", "pending-1"]);
    expect(confirmed.map((m) => m.id)).toEqual(["pinned-confirmed", "new-confirmed", "old-confirmed"]);
  });

  it("an empty list yields two empty groups, not an error", () => {
    expect(groupMemory([])).toEqual({ pending: [], confirmed: [] });
  });
});

// ============================================================== ASST-18 =============================

describe("groupCapabilities — dot-prefix category, sorted", () => {
  it("groups by the dot-prefix and sorts groups + tools by name", () => {
    const tools: AssistantCapability[] = [
      { name: "tasks.list", description: "List tasks", module: null },
      { name: "projects.list", description: "List projects", module: null },
      { name: "agency.pendingApprovals", description: "Approvals", module: "agency" },
    ];
    const groups = groupCapabilities(tools);
    expect(groups.map((g) => g.category)).toEqual(["agency", "projects", "tasks"]);
    expect(groups.find((g) => g.category === "agency")?.tools.map((t) => t.name)).toEqual(["agency.pendingApprovals"]);
    const withoutDot: AssistantCapability = { name: "ping", description: "", module: null };
    const grouped = groupCapabilities([...tools, withoutDot]);
    expect(grouped.find((g) => g.category === "general")?.tools.map((t) => t.name)).toEqual(["ping"]);
  });

  it("an empty list yields an empty group array, not an error", () => {
    expect(groupCapabilities([])).toEqual([]);
  });
});

describe("decodeAssistantEvent — the citations frame (ASST-18)", () => {
  it("decodes a well-formed citations block", () => {
    expect(decodeAssistantEvent({ event: "citations", data: '{"items":[{"sourceRef":"erp:project:1","text":"Project: Acme"}]}' }))
      .toEqual({ type: "citations", items: [{ sourceRef: "erp:project:1", text: "Project: Acme" }] });
  });
  it("drops malformed items rather than throwing", () => {
    expect(decodeAssistantEvent({ event: "citations", data: '{"items":[{"sourceRef":"ok","text":"t"},{"sourceRef":123}]}' }))
      .toEqual({ type: "citations", items: [{ sourceRef: "ok", text: "t" }] });
  });
  it("a missing items array decodes to an empty list, never null/undefined", () => {
    expect(decodeAssistantEvent({ event: "citations", data: "{}" })).toEqual({ type: "citations", items: [] });
  });
});

describe("streamReducer — citations", () => {
  it("citations set the live state the instant they arrive, non-terminal", () => {
    let s = initialStreamState();
    s = streamReducer(s, { type: "citations", items: [{ sourceRef: "erp:project:1", text: "t" }] });
    expect(s.citations).toEqual([{ sourceRef: "erp:project:1", text: "t" }]);
    expect(s.status).toBe("idle"); // same non-terminal rule `meta` follows
  });
});

describe("parseCitations — reads the persisted parts[], mirrors platform-nest's CitationsPart", () => {
  it("finds the citations part among other part types and returns its items", () => {
    const parts = [
      { type: "usage_meta", usageSource: "estimate" },
      { type: "citations", items: [{ sourceRef: "erp:client:1", text: "Client: Acme" }] },
    ];
    expect(parseCitations(parts)).toEqual([{ sourceRef: "erp:client:1", text: "Client: Acme" }]);
  });
  it("returns [] (never null) for parts with no citations, or a malformed/absent parts value", () => {
    expect(parseCitations([{ type: "usage_meta", usageSource: "estimate" }])).toEqual([]);
    expect(parseCitations([])).toEqual([]);
    expect(parseCitations(null)).toEqual([]);
    expect(parseCitations("not an array")).toEqual([]);
  });
});

describe("parseSessionResumeMismatch — ASST-24: reads the persisted 'conversation restarted' note", () => {
  it("finds the session_resume_mismatch part among other part types", () => {
    const parts = [
      { type: "usage_meta", usageSource: "estimate" },
      { type: "session_resume_mismatch", requestedSession: "sess-stale-123" },
    ];
    expect(parseSessionResumeMismatch(parts)).toEqual({ type: "session_resume_mismatch", requestedSession: "sess-stale-123" });
  });
  it("returns null for a genuine resume / turn 1 / an older gateway — all render identically (nothing)", () => {
    expect(parseSessionResumeMismatch([{ type: "usage_meta", usageSource: "estimate" }])).toBeNull();
    expect(parseSessionResumeMismatch([])).toBeNull();
  });
  it("returns null for a malformed/absent parts value, never throws", () => {
    expect(parseSessionResumeMismatch(null)).toBeNull();
    expect(parseSessionResumeMismatch(undefined)).toBeNull();
    expect(parseSessionResumeMismatch("not an array")).toBeNull();
  });
});
