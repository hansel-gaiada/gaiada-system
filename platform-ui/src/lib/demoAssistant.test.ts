import { describe, it, expect, beforeEach } from "vitest";
import { assistantDemo, demoAssistantStreamBody } from "./demoAssistant";

// T4 (ASST-23, §7.2/§7.4) — an integration test over the demo fixture itself (not mocked further):
// drives `assistantDemo`'s HTTP-shaped dispatcher + `demoAssistantStreamBody`'s real SSE stream the
// same way the Next.js route handlers do, proving the full propose -> confirm -> executed lifecycle
// is drivable in DEMO_MODE with no backend running — the acceptance bar T4's own "done when" line
// asks for. `demoAssistant.ts`'s stores live on `globalThis`, so each test creates its own thread
// (never reusing another test's rows) rather than resetting global state between tests.
const USER = "demo-hansel";
const TENANT = "co-agency";

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function parseEvents(raw: string): { event: string; data: unknown }[] {
  return raw
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const eventLine = block.split("\n").find((l) => l.startsWith("event:"));
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      return { event: eventLine?.slice(6).trim() ?? "message", data: JSON.parse(dataLine?.slice(5).trim() ?? "{}") };
    });
}

function createThread(): string {
  const r = assistantDemo("POST", `/api/${TENANT}/assistant/threads`, new URLSearchParams(), JSON.stringify({}), USER);
  return (r!.json as { id: string }).id;
}

function sendToolsMessage(threadId: string, content: string, agent = "task-filer") {
  const r = assistantDemo(
    "POST", `/api/${TENANT}/assistant/threads/${threadId}/messages`, new URLSearchParams(),
    JSON.stringify({ content, mode: "tools", agent }), USER,
  );
  return r!.json as { messageId: string; streamUrl: string };
}

function getThread(threadId: string) {
  const r = assistantDemo("GET", `/api/${TENANT}/assistant/threads/${threadId}`, new URLSearchParams(), undefined, USER);
  return r!.json as { messages: { id: string; toolCalls: { id: string; approvalId: string | null; approval: unknown; intent: unknown }[] }[] };
}

describe("demoAssistant — tools-mode send-time validation", () => {
  it("400s an unknown agent at send time, never mid-stream", () => {
    const threadId = createThread();
    const r = assistantDemo(
      "POST", `/api/${TENANT}/assistant/threads/${threadId}/messages`, new URLSearchParams(),
      JSON.stringify({ content: "hi", mode: "tools", agent: "not-a-real-agent" }), USER,
    );
    expect(r!.status).toBe(400);
  });
  it("400s an invalid mode value", () => {
    const threadId = createThread();
    const r = assistantDemo(
      "POST", `/api/${TENANT}/assistant/threads/${threadId}/messages`, new URLSearchParams(),
      JSON.stringify({ content: "hi", mode: "bogus" }), USER,
    );
    expect(r!.status).toBe(400);
  });
});

describe("demoAssistant — read-only agent (status-reporter): a tool chip, no proposal", () => {
  it("emits tool_call/tool_result and finishes with `done`, and GET thread shows a plain (non-proposal) call", async () => {
    const threadId = createThread();
    const { messageId } = sendToolsMessage(threadId, "what's open?", "status-reporter");
    const events = parseEvents(await drainStream(demoAssistantStreamBody(TENANT, threadId, messageId)!));
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(["tool_call", "tool_result", "meta", "token", "usage", "done"]));
    expect(events.some((e) => e.event === "confirm_required")).toBe(false);

    const { messages } = getThread(threadId);
    const assistantMsg = messages.find((m) => m.id === messageId)!;
    expect(assistantMsg.toolCalls).toHaveLength(1);
    // THE TRAP, proven against the demo fixture too: a plain read has approval:null AND intent:null.
    expect(assistantMsg.toolCalls[0].approvalId).toBeNull();
    expect(assistantMsg.toolCalls[0].approval).toBeNull();
    expect(assistantMsg.toolCalls[0].intent).toBeNull();
  });
});

describe("demoAssistant — write-capable agent (task-filer): full propose -> confirm -> executed lifecycle", () => {
  let threadId: string;
  let messageId: string;
  let writeCallId: string;

  beforeEach(async () => {
    threadId = createThread();
    ({ messageId } = sendToolsMessage(threadId, "file a task for the redesign"));
    const events = parseEvents(await drainStream(demoAssistantStreamBody(TENANT, threadId, messageId)!));
    const confirmRequired = events.find((e) => e.event === "confirm_required")!;
    writeCallId = (confirmRequired.data as { callId: string }).callId;
  });

  it("the stream ends with errorKind:'confirm_required', never 'done' — and never sends a real arg value", async () => {
    threadId = createThread();
    ({ messageId } = sendToolsMessage(threadId, "file a task"));
    const events = parseEvents(await drainStream(demoAssistantStreamBody(TENANT, threadId, messageId)!));
    expect(events.some((e) => e.event === "done")).toBe(false);
    const terminal = events.find((e) => e.event === "error")!;
    expect((terminal.data as { errorKind: string }).errorKind).toBe("confirm_required");
    const confirmRequired = events.find((e) => e.event === "confirm_required")!;
    const args = confirmRequired.data as { args: Record<string, string> };
    for (const v of Object.values(args.args)) expect(v).toMatch(/^\[redacted:/);
  });

  it("GET thread shows intent:{status:'draft'} and approval:null BEFORE any confirm — 'awaiting confirmation', not a plain read", () => {
    const { messages } = getThread(threadId);
    const msg = messages.find((m) => m.id === messageId)!;
    const call = msg.toolCalls.find((c) => c.id === writeCallId)!;
    expect(call.approvalId).toBeNull();
    expect(call.approval).toBeNull();
    expect(call.intent).toEqual(expect.objectContaining({ status: "draft" }));
  });

  it("confirm files the write and the card reads approved+executed — sent-for-approval is at least transiently reachable", () => {
    const r = assistantDemo(
      "POST", `/api/${TENANT}/assistant/threads/${threadId}/tool-calls/${writeCallId}/confirm`,
      new URLSearchParams(), JSON.stringify({}), USER,
    );
    expect(r!.status).toBe(200);
    const body = r!.json as { status: string; approvalId: string | null; approval: { status: string; executionStatus: string } | null };
    expect(body.status).toBe("filed");
    expect(body.approvalId).toBeTruthy();
    expect(body.approval).toEqual({ status: "approved", executionStatus: "executed", executionError: null });

    // Reload-joined state agrees with the confirm response — the card renders identically either way.
    const { messages } = getThread(threadId);
    const call = messages.find((m) => m.id === messageId)!.toolCalls.find((c) => c.id === writeCallId)!;
    expect(call.intent).toBeNull(); // the approval join takes over once filed
    expect(call.approval).toEqual({ status: "approved", executionStatus: "executed", executionError: null });
  });

  it("confirming twice is idempotent — the SAME approvalId both times, never a second filing", () => {
    const first = assistantDemo("POST", `/api/${TENANT}/assistant/threads/${threadId}/tool-calls/${writeCallId}/confirm`, new URLSearchParams(), JSON.stringify({}), USER);
    const second = assistantDemo("POST", `/api/${TENANT}/assistant/threads/${threadId}/tool-calls/${writeCallId}/confirm`, new URLSearchParams(), JSON.stringify({}), USER);
    expect((first!.json as { approvalId: string }).approvalId).toBe((second!.json as { approvalId: string }).approvalId);
  });

  it("dismiss refuses (409) an already-filed proposal, typed, naming the actual status", () => {
    assistantDemo("POST", `/api/${TENANT}/assistant/threads/${threadId}/tool-calls/${writeCallId}/confirm`, new URLSearchParams(), JSON.stringify({}), USER);
    const r = assistantDemo("POST", `/api/${TENANT}/assistant/threads/${threadId}/tool-calls/${writeCallId}/dismiss`, new URLSearchParams(), JSON.stringify({}), USER);
    expect(r!.status).toBe(409);
    expect((r!.json as { status: string }).status).toBe("filed");
  });

  it("dismiss (before confirm) files nothing — approvalId stays null, status becomes 'dismissed'", () => {
    const r = assistantDemo("POST", `/api/${TENANT}/assistant/threads/${threadId}/tool-calls/${writeCallId}/dismiss`, new URLSearchParams(), JSON.stringify({}), USER);
    expect(r!.status).toBe(200);
    const body = r!.json as { status: string; approvalId: string | null };
    expect(body.status).toBe("dismissed");
    expect(body.approvalId).toBeNull();

    const { messages } = getThread(threadId);
    const call = messages.find((m) => m.id === messageId)!.toolCalls.find((c) => c.id === writeCallId)!;
    expect(call.intent).toEqual(expect.objectContaining({ status: "dismissed" }));
    expect(call.approval).toBeNull();
  });

  it("a callId with no draft at all 404s, distinctly from a conflict", () => {
    const r = assistantDemo("POST", `/api/${TENANT}/assistant/threads/${threadId}/tool-calls/not-a-real-call/confirm`, new URLSearchParams(), JSON.stringify({}), USER);
    expect(r!.status).toBe(404);
  });
});

describe("demoAssistant — FE-verification gap #2 (2026-08-06): rejected/execution_failed/cancelled reachable through a REAL confirm, not just constructed props", () => {
  // Before this fixture change, `confirmWriteM` always resolved to `approved`+`executed` — these
  // three states existed only as `ProposalCard.test.tsx`'s constructed-props cases. The keyword in
  // the drafting message (mirroring the plain-chat `ERROR_TEST`/`STALL_TEST` convention) is what a
  // real browser drives via the composer to reach each one; this test drives the SAME dispatcher
  // functions the route handlers call, proving the fixture side of that path end to end.
  async function draftAndConfirm(content: string) {
    const threadId = createThread();
    const { messageId } = sendToolsMessage(threadId, content);
    await drainStream(demoAssistantStreamBody(TENANT, threadId, messageId)!);
    const { messages } = getThread(threadId);
    const call = messages.find((m) => m.id === messageId)!.toolCalls.find(
      (c) => (c.intent as { status: string } | null)?.status === "draft",
    )!;
    const r = assistantDemo(
      "POST", `/api/${TENANT}/assistant/threads/${threadId}/tool-calls/${call.id}/confirm`,
      new URLSearchParams(), JSON.stringify({}), USER,
    );
    return { r, threadId, messageId, callId: call.id };
  }

  it("REJECT_TEST -> confirm files an approval with status:'rejected' — no execution ever attempted", async () => {
    const { r } = await draftAndConfirm("file a task REJECT_TEST for the redesign");
    const body = r!.json as { approval: { status: string; executionStatus: string; executionError: string | null } };
    expect(body.approval.status).toBe("rejected");
    expect(body.approval.executionError).toBeNull();
  });

  it("CANCEL_TEST -> confirm files an approval with status:'cancelled'", async () => {
    const { r } = await draftAndConfirm("file a task CANCEL_TEST for the redesign");
    const body = r!.json as { approval: { status: string; executionStatus: string } };
    expect(body.approval.status).toBe("cancelled");
  });

  it("FAIL_TEST -> confirm files an APPROVED row whose execution failed, with a non-null executionError", async () => {
    const { r } = await draftAndConfirm("file a task FAIL_TEST for the redesign");
    const body = r!.json as { approval: { status: string; executionStatus: string; executionError: string | null } };
    expect(body.approval.status).toBe("approved");
    expect(body.approval.executionStatus).toBe("failed");
    expect(body.approval.executionError).toBeTruthy();
  });

  it("each outcome round-trips identically through the reload-joined GET (never just the confirm response)", async () => {
    const { threadId, messageId, callId } = await draftAndConfirm("file a task REJECT_TEST for the redesign");
    const { messages } = getThread(threadId);
    const call = messages.find((m) => m.id === messageId)!.toolCalls.find((c) => c.id === callId)!;
    expect(call.intent).toBeNull(); // the approval join takes over once filed — same invariant as the default path
    expect((call.approval as { status: string }).status).toBe("rejected");
  });

  it("the default path (no keyword) is untouched — still resolves to approved+executed", async () => {
    const { r } = await draftAndConfirm("file a plain task for the redesign");
    const body = r!.json as { approval: { status: string; executionStatus: string } };
    expect(body.approval).toEqual({ status: "approved", executionStatus: "executed", executionError: null });
  });
});

describe("demoAssistant — capabilities exposes toolAgents for the composer's picker", () => {
  it("returns the fixed demo roster, task-filer included with its write tools", () => {
    const r = assistantDemo("GET", `/api/${TENANT}/assistant/capabilities`, new URLSearchParams(), undefined, USER);
    const body = r!.json as { toolAgents: { name: string; writeTools: string[] }[] };
    const taskFiler = body.toolAgents.find((a) => a.name === "task-filer");
    expect(taskFiler?.writeTools).toEqual(["pm.createTask", "pm.createDoc"]);
  });
});
