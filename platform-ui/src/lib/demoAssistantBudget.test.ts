import { describe, it, expect } from "vitest";
import { assistantDemo, demoAssistantStreamBody } from "./demoAssistant";
import { parseTurnBudget } from "./aiBudget";

// AIP-18 (BFF §66.11) — the soft stop in demo mode: a reply with the `turn_budget` part, a stream whose FIRST frame is `event: budget`, and a hand-off held
// over budget with its cancel route. The shapes are the server's and are read back through the SAME parsers the screens use. `demoAssistant.ts`'s stores
// live on `globalThis`, so each test makes its own thread.
const USER = "demo-hansel";
const TENANT = "co-agency";
const call = (method: string, path: string, body?: unknown, user = USER) =>
  assistantDemo(method, `/api/${TENANT}/assistant/${path}`, new URLSearchParams(), body === undefined ? undefined : JSON.stringify(body), user)!;

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
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
const events = (raw: string) =>
  raw.split("\n\n").filter((b) => b.trim()).map((b) => ({ event: b.split("\n")[0].slice(6).trim(), data: JSON.parse(b.split("\n")[1].slice(5).trim()) as Record<string, unknown> }));

const newThread = (): string => (call("POST", "threads", {}).json as { id: string }).id;
type Msg = { id: string; role: string; parts: unknown };
const messages = (threadId: string) => (call("GET", `threads/${threadId}`).json as { messages: Msg[] }).messages;

describe("the seeded replies the soft stop answered in a lighter mode", () => {
  it("carry the `turn_budget` part (one for the allowance, one for the department), and no other reply does", () => {
    const stopped = messages("asst-thread-4").filter((m) => m.role === "assistant");
    expect(stopped.map((m) => parseTurnBudget(m.parts)?.kind)).toEqual(["allowance", "department"]);
    expect(parseTurnBudget(stopped[1].parts)?.unitNodeId).toBe("dept-1");
    for (const m of messages("asst-thread-1")) expect(parseTurnBudget(m.parts)).toBeNull();
  });
  it("carry a reset instant in the future: the next 00:00 UTC, and the first of next month", () => {
    const [a, d] = messages("asst-thread-4").filter((m) => m.role === "assistant").map((m) => new Date(parseTurnBudget(m.parts)!.resetsAt));
    expect(a.getTime()).toBeGreaterThan(Date.now());
    expect(a.getUTCHours()).toBe(0);
    expect(d.getTime()).toBeGreaterThan(Date.now());
    expect(d.getUTCDate()).toBe(1);
  });
});

describe("a message that asks for a stop is stopped LIVE", () => {
  it("BUDGET_TEST puts the part on the placeholder row and the stream's first frame is `budget`; the finished row keeps the part", async () => {
    const threadId = newThread();
    const sent = call("POST", `threads/${threadId}/messages`, { content: "BUDGET_TEST ERROR_TEST" }).json as { messageId: string };
    const placeholder = messages(threadId).find((m) => m.id === sent.messageId)!;
    expect(parseTurnBudget(placeholder.parts)).toMatchObject({ kind: "allowance" });
    const frames = events(await drain(demoAssistantStreamBody(TENANT, threadId, sent.messageId)!));
    expect(frames[0].event).toBe("budget");
    expect(frames[0].data).toMatchObject({ kind: "allowance" });
    expect(Object.keys(frames[0].data).sort()).toEqual(["kind", "resetsAt"]); // never a figure, never the part's `type`
    expect(frames.filter((f) => f.event === "budget")).toHaveLength(1);
    expect(parseTurnBudget(messages(threadId).find((m) => m.id === sent.messageId)!.parts)).toMatchObject({ kind: "allowance" });
  });
  it("BUDGET_DEPT_TEST is the department kind, with its unit", async () => {
    const threadId = newThread();
    const sent = call("POST", `threads/${threadId}/messages`, { content: "BUDGET_DEPT_TEST ERROR_TEST" }).json as { messageId: string };
    const frames = events(await drain(demoAssistantStreamBody(TENANT, threadId, sent.messageId)!));
    expect(frames[0]).toMatchObject({ event: "budget", data: { kind: "department", unitNodeId: "dept-1" } });
  });
  it("an ordinary message has no part and no `budget` frame: byte for byte what it was", async () => {
    const threadId = newThread();
    const sent = call("POST", `threads/${threadId}/messages`, { content: "hello ERROR_TEST" }).json as { messageId: string };
    expect(parseTurnBudget(messages(threadId).find((m) => m.id === sent.messageId)!.parts)).toBeNull();
    const frames = events(await drain(demoAssistantStreamBody(TENANT, threadId, sent.messageId)!));
    expect(frames.map((f) => f.event)).toEqual(["error"]);
  });
});

describe("held hand-offs (§66.11)", () => {
  type Row = { id: string; status: string; goalId: string | null; holdKind: string | null; holdUnitNodeId: string | null; heldAt: string | null };
  const list = (threadId: string) => call("GET", `threads/${threadId}/handoffs`).json as Row[];

  it("seeds one hand-off held over budget on the budget thread, with its hold fields and no goal", () => {
    const held = list("asst-thread-4").filter((h) => h.status === "held");
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ goalId: null, holdKind: "allowance", holdUnitNodeId: null });
    expect(held[0].heldAt).not.toBeNull();
  });
  it("holds a hand-off whose goal contains HOLD_TEST: 201 with `goalId: null`, status held and the hold; the list carries the three hold fields", () => {
    const threadId = newThread();
    const r = call("POST", `threads/${threadId}/handoff`, { agent: "status-reporter", goal: "HOLD_TEST write the report" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ goalId: null, status: "held", hold: { kind: "allowance" } });
    expect((r.json as { hold: { resetsAt: string } }).hold.resetsAt).toMatch(/Z$/);
    expect(list(threadId)[0]).toMatchObject({ status: "held", goalId: null, holdKind: "allowance" });
  });
  it("a department hold names its unit", () => {
    const threadId = newThread();
    const r = call("POST", `threads/${threadId}/handoff`, { agent: "status-reporter", goal: "HOLD_DEPT_TEST report" });
    expect(r.json).toMatchObject({ status: "held", hold: { kind: "department", unitNodeId: "dept-1" } });
    expect(list(threadId)[0]).toMatchObject({ holdKind: "department", holdUnitNodeId: "dept-1" });
  });
  it("an ordinary hand-off is as before: a goal id, no `hold` key, the three hold fields null", () => {
    const threadId = newThread();
    const r = call("POST", `threads/${threadId}/handoff`, { agent: "status-reporter", goal: "report" });
    expect(r.json).toMatchObject({ status: "ok" });
    expect("hold" in (r.json as object)).toBe(false);
    expect(list(threadId)[0]).toMatchObject({ holdKind: null, holdUnitNodeId: null, heldAt: null });
  });
  it("cancels a held hand-off (200, status cancelled), and then 409 not_held: a started or ended one is never stopped by this route", () => {
    const threadId = newThread();
    const id = (call("POST", `threads/${threadId}/handoff`, { agent: "status-reporter", goal: "HOLD_TEST x" }).json as { id: string }).id;
    const done = call("POST", `threads/${threadId}/handoffs/${id}/cancel`);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ id, status: "cancelled" });
    expect(list(threadId)[0].status).toBe("cancelled");
    expect(call("POST", `threads/${threadId}/handoffs/${id}/cancel`)).toMatchObject({ status: 409, json: { error: "not_held" } });
    const plain = (call("POST", `threads/${threadId}/handoff`, { agent: "status-reporter", goal: "report" }).json as { id: string }).id;
    expect(call("POST", `threads/${threadId}/handoffs/${plain}/cancel`).status).toBe(409);
  });
  it("404s an id that is not this thread's hand-off, and a thread that is not the caller's", () => {
    const threadId = newThread();
    expect(call("POST", `threads/${threadId}/handoffs/nope/cancel`).status).toBe(404);
    const id = (call("POST", `threads/${threadId}/handoff`, { agent: "status-reporter", goal: "HOLD_TEST y" }).json as { id: string }).id;
    expect(call("POST", `threads/${newThread()}/handoffs/${id}/cancel`).status).toBe(404);
    expect(call("POST", `threads/${threadId}/handoffs/${id}/cancel`, undefined, "someone-else").status).toBe(404);
    expect(list(threadId)[0].status).toBe("held");
  });
});
