import { describe, it, expect } from "vitest";
import {
  groupThreads, filterThreads, threadTitle, isPendingMessage,
  parseSSEBuffer, decodeAssistantEvent, streamReducer, initialStreamState, humanizeErrorKind,
  brainBadgeLabel, parseUsageMeta, usageMeterLabel,
  isPendingMemory, groupMemory,
  groupCapabilities, parseCitations, parseSessionResumeMismatch,
  deriveProposalCardState, isWriteProposal, canActOnProposal, proposalStateLabel, formatRedactedArgs,
  hasPendingProposalDecision, normalizeThreadToolCall, normalizeLiveToolCall, partitionToolCalls,
  formatExpiresAt,
  type AssistantThread, type AssistantMemory, type AssistantCapability, type ThreadToolCall, type LiveToolCall,
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
    // Pre-T4, this exact case ("tool_call") was the pin for "these four event names are not yet
    // decoded at all" (ASST-23's design doc §1.4 cites this line by number). T3a/T3b made
    // tool_call/tool_result/approval_required/confirm_required real events on the tool-turn path —
    // ASST-23 legitimately supersedes that finding, so the pin is inverted here (kept, not deleted)
    // onto a name that is STILL genuinely unrecognised, and the four real ones get their own
    // "decodes to a real event" cases directly below instead of asserting they decode to null.
    expect(decodeAssistantEvent({ event: "some_future_event", data: "{}" })).toBeNull();
  });

  // ── T4 (ASST-23, §7.4) — the four tool-turn frames now decode for real. ─────────────────────────
  it("decodes tool_call", () => {
    expect(decodeAssistantEvent({ event: "tool_call", data: '{"callId":"c1","toolName":"projects.list","args":{"k":"[redacted:string]"}}' }))
      .toEqual({ type: "tool_call", callId: "c1", toolName: "projects.list", args: { k: "[redacted:string]" } });
  });
  it("tool_call: a missing args object defaults to {}, never null/undefined", () => {
    expect(decodeAssistantEvent({ event: "tool_call", data: '{"callId":"c1","toolName":"projects.list"}' }))
      .toEqual({ type: "tool_call", callId: "c1", toolName: "projects.list", args: {} });
  });
  it("tool_call: missing callId/toolName decodes to null", () => {
    expect(decodeAssistantEvent({ event: "tool_call", data: '{"toolName":"projects.list"}' })).toBeNull();
    expect(decodeAssistantEvent({ event: "tool_call", data: '{"callId":"c1"}' })).toBeNull();
  });
  it("decodes tool_result for each status", () => {
    for (const status of ["succeeded", "failed", "denied"] as const) {
      expect(decodeAssistantEvent({ event: "tool_result", data: `{"callId":"c1","toolName":"t","status":"${status}","summary":"s"}` }))
        .toEqual({ type: "tool_result", callId: "c1", toolName: "t", status, summary: "s" });
    }
  });
  it("tool_result: an invalid status decodes to null (never coerced)", () => {
    expect(decodeAssistantEvent({ event: "tool_result", data: '{"callId":"c1","toolName":"t","status":"bogus"}' })).toBeNull();
  });
  it("tool_result: a null summary is preserved, never coerced to a string", () => {
    expect(decodeAssistantEvent({ event: "tool_result", data: '{"callId":"c1","toolName":"t","status":"succeeded"}' }))
      .toEqual({ type: "tool_result", callId: "c1", toolName: "t", status: "succeeded", summary: null });
  });
  it("decodes approval_required (the legacy/defensive filed-at-turn-time shape)", () => {
    expect(decodeAssistantEvent({ event: "approval_required", data: '{"callId":"c1","toolName":"pm.createTask","approvalId":"a1","impact":"high"}' }))
      .toEqual({ type: "approval_required", callId: "c1", toolName: "pm.createTask", approvalId: "a1", impact: "high" });
  });
  it("approval_required: a null impact is preserved (the row's own impact column can be absent)", () => {
    expect(decodeAssistantEvent({ event: "approval_required", data: '{"callId":"c1","toolName":"t","approvalId":"a1"}' }))
      .toEqual({ type: "approval_required", callId: "c1", toolName: "t", approvalId: "a1", impact: null });
  });
  it("approval_required: missing approvalId decodes to null", () => {
    expect(decodeAssistantEvent({ event: "approval_required", data: '{"callId":"c1","toolName":"t"}' })).toBeNull();
  });
  it("decodes confirm_required (the owner's confirm-chip draft — the normal chat-path suspension)", () => {
    expect(decodeAssistantEvent({
      event: "confirm_required",
      data: '{"callId":"c1","toolName":"pm.createTask","intentId":"i1","args":{"title":"[redacted:string]"},"impact":"high","expiresAt":"2026-08-06T10:00:00Z"}',
    })).toEqual({
      type: "confirm_required", callId: "c1", toolName: "pm.createTask", intentId: "i1",
      args: { title: "[redacted:string]" }, impact: "high", expiresAt: "2026-08-06T10:00:00Z",
    });
  });
  it("confirm_required: missing any required field decodes to null", () => {
    expect(decodeAssistantEvent({ event: "confirm_required", data: '{"callId":"c1","toolName":"t","intentId":"i1","impact":"high"}' })).toBeNull();
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
    expect(s).toEqual({ status: "streaming", text: "Hello", meta: null, usage: null, citations: [], toolCalls: [], error: null });
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
    expect(s).toEqual({ status: "error", text: "", meta: null, usage: null, citations: [], toolCalls: [], error: { message: "boom", kind: "upstream_error" } });
  });
  it("never mutates the previous state object", () => {
    const s0 = initialStreamState();
    const s1 = streamReducer(s0, { type: "token", text: "x" });
    expect(s0).toEqual({ status: "idle", text: "", meta: null, usage: null, citations: [], toolCalls: [], error: null });
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

// ============================================================== T4 (ASST-23, §7.4) ===================

describe("streamReducer — tool-turn frames accumulate a live tool-call list by callId", () => {
  it("tool_call inserts a running entry; the matching tool_result updates it in place, not a second row", () => {
    let s = initialStreamState();
    s = streamReducer(s, { type: "tool_call", callId: "c1", toolName: "projects.list", args: {} });
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0]).toMatchObject({ callId: "c1", toolName: "projects.list", status: "running" });
    s = streamReducer(s, { type: "tool_result", callId: "c1", toolName: "projects.list", status: "succeeded", summary: null });
    expect(s.toolCalls).toHaveLength(1); // still one row, updated — not appended
    expect(s.toolCalls[0]).toMatchObject({ callId: "c1", status: "succeeded" });
    expect(s.status).toBe("idle"); // non-terminal, same rule meta/citations already follow
  });

  it("two distinct callIds accumulate as two entries, in arrival order", () => {
    let s = initialStreamState();
    s = streamReducer(s, { type: "tool_call", callId: "a", toolName: "t1", args: {} });
    s = streamReducer(s, { type: "tool_call", callId: "b", toolName: "t2", args: {} });
    expect(s.toolCalls.map((c) => c.callId)).toEqual(["a", "b"]);
  });

  it("confirm_required inserts a card with intent:{status:'draft'} and approval left null — never both set", () => {
    let s = initialStreamState();
    s = streamReducer(s, {
      type: "confirm_required", callId: "c1", toolName: "pm.createTask", intentId: "i1",
      args: { title: "[redacted:string]" }, impact: "high", expiresAt: "2026-08-06T10:00:00Z",
    });
    expect(s.toolCalls).toHaveLength(1);
    const call = s.toolCalls[0];
    expect(call.intent).toEqual({ status: "draft" });
    expect(call.approval).toBeNull();
    expect(call.args).toEqual({ title: "[redacted:string]" });
    expect(deriveProposalCardState(call)).toBe("awaiting_confirmation");
  });

  it("approval_required (legacy/defensive) inserts a card with approval set and intent left null", () => {
    let s = initialStreamState();
    s = streamReducer(s, { type: "approval_required", callId: "c1", toolName: "pm.createTask", approvalId: "a1", impact: "high" });
    const call = s.toolCalls[0];
    expect(call.approval).toEqual({ status: "pending", executionStatus: "not_applicable", executionError: null });
    expect(call.intent).toBeNull();
    expect(deriveProposalCardState(call)).toBe("sent_for_approval");
  });

  it("a confirm_required/approval_required terminal error does not resurrect after the guard kicks in", () => {
    let s = initialStreamState();
    s = streamReducer(s, { type: "confirm_required", callId: "c1", toolName: "t", intentId: "i1", args: {}, impact: "high", expiresAt: "later" });
    s = streamReducer(s, { type: "error", error: "drafted", errorKind: "confirm_required" });
    expect(s.status).toBe("error");
    const after = streamReducer(s, { type: "tool_call", callId: "c2", toolName: "t2", args: {} });
    expect(after).toBe(s); // dropped — same guard every other post-terminal event already gets
  });
});

describe("deriveProposalCardState — THE TRAP: never infer from approvalId alone", () => {
  function joinable(over: Partial<ThreadToolCall> = {}): ThreadToolCall {
    return {
      id: "tc1", toolName: "pm.createTask", mcpServer: "mcp-hub", args: {}, resultSummary: null,
      status: "pending", approvalId: null, durationMs: null, createdAt: "2026-08-06T09:00:00Z",
      approval: null, intent: null, ...over,
    };
  }

  it("approval:null AND intent:null is a plain read/refusal, never a card — the two 'approvalId reads null' cases resolved", () => {
    // Case 1: a plain read that was never a write proposal at all.
    expect(deriveProposalCardState(joinable())).toBe("plain");
    expect(isWriteProposal(joinable())).toBe(false);
  });

  it("intent:{status:'draft'} with approvalId/approval BOTH still null is 'awaiting_confirmation', not 'plain'", () => {
    // Case 2: a drafted write, not yet confirmed — approvalId reads null here too, but this is NOT
    // the same fact as the plain-read case above. This is the exact defect class the ticket names.
    const call = joinable({ intent: { status: "draft", expiresAt: "2026-08-06T10:00:00Z" } });
    expect(deriveProposalCardState(call)).toBe("awaiting_confirmation");
    expect(isWriteProposal(call)).toBe(true);
    expect(canActOnProposal(deriveProposalCardState(call))).toBe(true);
  });

  it("intent:dismissed / intent:expired map to their own terminal-without-filing states", () => {
    expect(deriveProposalCardState(joinable({ intent: { status: "dismissed", expiresAt: "x" } }))).toBe("dismissed");
    expect(deriveProposalCardState(joinable({ intent: { status: "expired", expiresAt: "x" } }))).toBe("expired");
  });

  it("once approvalId is set, the approval join takes over — status pending is 'sent_for_approval'", () => {
    const call = joinable({ approvalId: "a1", approval: { status: "pending", executionStatus: "not_applicable", executionError: null } });
    expect(deriveProposalCardState(call)).toBe("sent_for_approval");
    expect(canActOnProposal(deriveProposalCardState(call))).toBe(false);
  });

  it("approved + executed / failed / not_applicable map to their own distinct states", () => {
    const approved = (executionStatus: string, executionError: string | null = null) =>
      joinable({ approvalId: "a1", approval: { status: "approved", executionStatus, executionError } });
    expect(deriveProposalCardState(approved("executed"))).toBe("executed");
    expect(deriveProposalCardState(approved("failed", "boom"))).toBe("execution_failed");
    expect(deriveProposalCardState(approved("not_applicable"))).toBe("not_executable");
    expect(deriveProposalCardState(approved("executing"))).toBe("executing");
    expect(deriveProposalCardState(approved("pending"))).toBe("executing");
  });

  it("rejected and cancelled are their own states, distinct from a plain read", () => {
    expect(deriveProposalCardState(joinable({ approvalId: "a1", approval: { status: "rejected", executionStatus: "not_applicable", executionError: null } }))).toBe("rejected");
    expect(deriveProposalCardState(joinable({ approvalId: "a1", approval: { status: "cancelled", executionStatus: "not_applicable", executionError: null } }))).toBe("cancelled");
  });

  it("proposalStateLabel has a non-empty label for every real state, and an empty one for 'plain' (no card to label)", () => {
    const states = [
      "awaiting_confirmation", "dismissed", "expired", "sent_for_approval", "executing",
      "executed", "execution_failed", "not_executable", "rejected", "cancelled",
    ] as const;
    for (const s of states) expect(proposalStateLabel(s)).not.toBe("");
    expect(proposalStateLabel("plain")).toBe("");
  });
});

describe("formatRedactedArgs — shape-only preview, never recovers a value that was never sent", () => {
  it("lists one key/hint pair per top-level key of an already-redacted args object", () => {
    expect(formatRedactedArgs({ title: "[redacted:string]", projectId: "[redacted:string]" }))
      .toEqual([{ key: "title", hint: "[redacted:string]" }, { key: "projectId", hint: "[redacted:string]" }]);
  });
  it("a non-string hint value is stringified, never left as an object the caller can't render", () => {
    expect(formatRedactedArgs({ tags: "[redacted:array(2)]" })).toEqual([{ key: "tags", hint: "[redacted:array(2)]" }]);
  });
  it("null/undefined/array/non-object input yields [], never throws", () => {
    expect(formatRedactedArgs(null)).toEqual([]);
    expect(formatRedactedArgs(undefined)).toEqual([]);
    expect(formatRedactedArgs([1, 2])).toEqual([]);
    expect(formatRedactedArgs("nope")).toEqual([]);
  });
});

describe("hasPendingProposalDecision — the out-of-band-decision poll's cue", () => {
  function msgWithCall(approval: { status: string; executionStatus: string; executionError: string | null } | null, intent: { status: string; expiresAt?: string } | null = null) {
    return { toolCalls: [{
      id: "tc1", toolName: "pm.createTask", mcpServer: "mcp-hub", args: {}, resultSummary: null,
      status: "pending", approvalId: approval ? "a1" : null, durationMs: null, createdAt: "x",
      approval, intent,
    } as unknown as ThreadToolCall] };
  }

  it("true while a filed proposal is still pending a decision", () => {
    expect(hasPendingProposalDecision([msgWithCall({ status: "pending", executionStatus: "not_applicable", executionError: null })])).toBe(true);
  });
  it("true while an approved write is still executing", () => {
    expect(hasPendingProposalDecision([msgWithCall({ status: "approved", executionStatus: "executing", executionError: null })])).toBe(true);
  });
  it("false once terminal (executed/failed/rejected) — nothing left to poll for", () => {
    expect(hasPendingProposalDecision([msgWithCall({ status: "approved", executionStatus: "executed", executionError: null })])).toBe(false);
    expect(hasPendingProposalDecision([msgWithCall({ status: "rejected", executionStatus: "not_applicable", executionError: null })])).toBe(false);
  });
  it("false for an awaiting-confirmation draft — only the owner's own click can move it, not an out-of-band decision", () => {
    expect(hasPendingProposalDecision([msgWithCall(null, { status: "draft", expiresAt: "x" })])).toBe(false);
  });
  it("false for a message with no toolCalls at all, or an undefined toolCalls field", () => {
    expect(hasPendingProposalDecision([{ toolCalls: [] }])).toBe(false);
    expect(hasPendingProposalDecision([{}])).toBe(false);
  });
});

describe("normalize + partition — ThreadToolCall and LiveToolCall render through ONE shape", () => {
  it("normalizeThreadToolCall reads expiresAt out of the nested intent join", () => {
    const persisted: ThreadToolCall = {
      id: "tc1", toolName: "pm.createTask", mcpServer: "mcp-hub", args: { title: "[redacted:string]" },
      resultSummary: null, status: "pending", approvalId: null, durationMs: null, createdAt: "x",
      approval: null, intent: { status: "draft", expiresAt: "2026-08-06T10:00:00Z" },
    };
    expect(normalizeThreadToolCall(persisted)).toEqual({
      callId: "tc1", toolName: "pm.createTask", args: { title: "[redacted:string]" }, status: "pending",
      resultSummary: null, approvalId: null, impact: null, expiresAt: "2026-08-06T10:00:00Z",
      approval: null, intent: { status: "draft", expiresAt: "2026-08-06T10:00:00Z" },
    });
  });

  it("normalizeLiveToolCall reads expiresAt off its own top-level field, and defaults args to {}", () => {
    const live: LiveToolCall = {
      callId: "c1", toolName: "pm.createTask", args: undefined, status: "pending", resultSummary: null,
      approvalId: null, impact: "high", intentId: "i1", expiresAt: "2026-08-06T10:00:00Z",
      approval: null, intent: { status: "draft" },
    };
    expect(normalizeLiveToolCall(live)).toEqual({
      callId: "c1", toolName: "pm.createTask", args: {}, status: "pending", resultSummary: null,
      approvalId: null, impact: "high", expiresAt: "2026-08-06T10:00:00Z",
      approval: null, intent: { status: "draft" },
    });
  });

  it("partitionToolCalls splits by isWriteProposal, preserving order within each bucket", () => {
    const read = normalizeLiveToolCall({
      callId: "a", toolName: "projects.list", args: {}, status: "succeeded", resultSummary: null,
      approvalId: null, impact: null, intentId: null, expiresAt: null, approval: null, intent: null,
    });
    const draft = normalizeLiveToolCall({
      callId: "b", toolName: "pm.createTask", args: {}, status: "pending", resultSummary: null,
      approvalId: null, impact: "high", intentId: "i1", expiresAt: "later", approval: null, intent: { status: "draft" },
    });
    const { proposals, chips } = partitionToolCalls([read, draft]);
    expect(proposals.map((c) => c.callId)).toEqual(["b"]);
    expect(chips.map((c) => c.callId)).toEqual(["a"]);
  });
});

describe("formatExpiresAt — pinned locale + timeZone, an honest null on garbage input", () => {
  it("formats a real ISO timestamp with a fixed UTC timezone", () => {
    expect(formatExpiresAt("2026-08-06T10:05:00Z")).toBe("06 Aug, 10:05 UTC");
  });
  it("returns null (never 'Invalid Date') for an unparseable value", () => {
    expect(formatExpiresAt("not a date")).toBeNull();
  });
});
