import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerSkill, routeCommand, resetSkills, registerBuiltins, type SkillCtx } from "./skills";
import { resolvePrincipal } from "./principal";
import { parsePmCommand } from "./pm";
import type { InboundMessage } from "./waha";

vi.mock("./store", () => ({
  saveMessage: vi.fn(async () => undefined),
  getMessages: vi.fn(async () => []),
  getGroupChatIds: vi.fn(async () => []),
  getPendingMedia: vi.fn(async () => []),
  updateMedia: vi.fn(async () => undefined),
  initStore: vi.fn(async () => undefined),
}));
vi.mock("./llm", () => ({
  complete: vi.fn(async () => "AI"),
  describeMedia: vi.fn(async () => ""),
}));

const callHubTool = vi.fn(async (_t: string, _a: Record<string, unknown>, _e: unknown) => "[]");
vi.mock("./hub", async (importOriginal) => {
  const real = await importOriginal<typeof import("./hub")>();
  return {
    HubDeniedError: real.HubDeniedError,
    callHubTool: (t: string, a: Record<string, unknown>, e: unknown) => callHubTool(t, a, e),
  };
});
import { config } from "./config";
import { HubDeniedError } from "./hub";

function ctx(over: Partial<InboundMessage> = {}, args = ""): SkillCtx {
  const msg: InboundMessage = {
    chatId: "g@g.us",
    senderId: "628110@c.us",
    senderName: "Budi",
    waMessageId: "w1",
    ts: 1,
    text: "",
    isGroup: true,
    fromMe: false,
    replyToBot: false,
    mentionedJids: [],
    media: null,
    ...over,
  };
  return { msg, args, principal: resolvePrincipal("whatsapp", msg.senderId) };
}

describe("parsePmCommand (P4-J4 natural-language parsing)", () => {
  it("empty / 'mine' / 'list' -> list-mine intent", () => {
    expect(parsePmCommand("")).toEqual({ kind: "mine" });
    expect(parsePmCommand("mine")).toEqual({ kind: "mine" });
    expect(parsePmCommand("my tasks")).toEqual({ kind: "mine" });
    expect(parsePmCommand("list")).toEqual({ kind: "mine" });
  });

  it("'show <id>' / bare id -> show intent", () => {
    expect(parsePmCommand("show TASK-1")).toEqual({ kind: "show", taskId: "TASK-1" });
    expect(parsePmCommand("TASK-1")).toEqual({ kind: "show", taskId: "TASK-1" });
  });

  it("'history <id>' -> history intent", () => {
    expect(parsePmCommand("history TASK-1")).toEqual({ kind: "history", taskId: "TASK-1" });
  });

  it("'status <id> <status>' normalizes friendly aliases and drops filler words", () => {
    expect(parsePmCommand("status TASK-1 doing")).toEqual({ kind: "status", taskId: "TASK-1", status: "doing", blockReason: undefined });
    expect(parsePmCommand("move TASK-1 to in progress")).toEqual({ kind: "status", taskId: "TASK-1", status: "doing", blockReason: undefined });
    expect(parsePmCommand("status TASK-1 blocked waiting on client")).toEqual({
      kind: "status",
      taskId: "TASK-1",
      status: "blocked",
      blockReason: "waiting on client",
    });
  });

  it("'due <id> <date|clear>' -> due intent", () => {
    expect(parsePmCommand("due TASK-1 2026-09-01")).toEqual({ kind: "due", taskId: "TASK-1", dueDate: "2026-09-01" });
    expect(parsePmCommand("due TASK-1 clear")).toEqual({ kind: "due", taskId: "TASK-1", dueDate: null });
  });

  it("'pass <id> <userId> [note]' -> pass intent", () => {
    expect(parsePmCommand("pass TASK-1 to user-9 heads up")).toEqual({
      kind: "pass",
      taskId: "TASK-1",
      refId: "user-9",
      note: "heads up",
    });
  });

  it("'comment <id> <text>' -> comment intent", () => {
    expect(parsePmCommand("comment TASK-1 looks good to me")).toEqual({
      kind: "comment",
      taskId: "TASK-1",
      body: "looks good to me",
    });
  });

  it("unrecognized shape -> help, never a guess", () => {
    expect(parsePmCommand("status TASK-1")).toEqual({ kind: "help" });
    expect(parsePmCommand("frobnicate widgets")).toEqual({ kind: "help" });
  });
});

describe("/pm skill (P4-J4)", () => {
  beforeEach(() => {
    resetSkills();
    registerBuiltins();
    callHubTool.mockClear();
    config.hubServiceToken = "hub-token";
    config.defaultTenantId = "tenant-1";
  });

  it("is registered as a built-in", () => {
    // registerBuiltins() in beforeEach already ran; routeCommand would 404 on an unknown name.
    expect(async () => routeCommand("pm", ctx())).not.toThrow();
  });

  it("guards on missing hub token / tenant config (same shape as /projects)", async () => {
    config.hubServiceToken = "";
    expect(await routeCommand("pm", ctx())).toContain("HUB_SERVICE_TOKEN");
    config.hubServiceToken = "hub-token";
    config.defaultTenantId = "";
    expect(await routeCommand("pm", ctx())).toContain("DEFAULT_TENANT_ID");
  });

  it("'/pm' with no args lists the caller's own tasks (mine:true) via pm.listTasks, forwarding the sender's envelope", async () => {
    callHubTool.mockResolvedValueOnce(
      JSON.stringify({
        items: [
          { id: "t1", title: "Fix header", status: "doing", dueDate: "2026-08-10", assignee: { kind: "person", refId: "u1", refName: "Budi", responsibleId: "u1", responsibleName: "Budi" } },
        ],
      }),
    );
    const reply = await routeCommand("pm", ctx({ chatId: "tg:-100", senderId: "tg:555" }));
    const [tool, args, envelope] = callHubTool.mock.calls[0];
    expect(tool).toBe("pm.listTasks");
    expect(args).toEqual({ tenantId: "tenant-1", mine: true, includeClosed: false, limit: 15 });
    expect(envelope).toEqual({ provider: "telegram", externalId: "tg:555" });
    expect(reply).toContain("Fix header");
    expect(reply).toContain("Budi");
  });

  it("no open tasks reads as an explicit empty state, not a blank reply", async () => {
    callHubTool.mockResolvedValueOnce(JSON.stringify({ items: [] }));
    const reply = await routeCommand("pm", ctx());
    expect(reply.toLowerCase()).toContain("no open tasks");
  });

  it("'/pm show <id>' renders task detail including a live-named blocker", async () => {
    callHubTool.mockResolvedValueOnce(
      JSON.stringify({
        id: "t1",
        title: "Ship banner",
        status: "backlog",
        dueDate: "2026-08-20",
        projectName: "Rebrand",
        assignee: { kind: "person", refId: "u1", refName: "Budi", responsibleId: "u1", responsibleName: "Budi" },
        blockedBy: [{ id: "t0", title: "Design mockup" }],
      }),
    );
    const reply = await routeCommand("pm", ctx({}, "show t1"));
    expect(reply).toContain("Ship banner");
    expect(reply).toContain('blocked by "Design mockup"');
    const [tool, args] = callHubTool.mock.calls[0];
    expect(tool).toBe("pm.getTask");
    expect(args).toEqual({ tenantId: "tenant-1", taskId: "t1" });
  });

  it("'/pm status <id> <status>' PATCHes via pm.setStatus", async () => {
    callHubTool.mockResolvedValueOnce(JSON.stringify({ id: "t1", status: "doing" }));
    const reply = await routeCommand("pm", ctx({}, "status t1 doing"));
    expect(reply).toContain('"doing"');
    const [tool, args] = callHubTool.mock.calls[0];
    expect(tool).toBe("pm.setStatus");
    expect(args).toEqual({ tenantId: "tenant-1", taskId: "t1", status: "doing" });
  });

  // ---- The acceptance criteria the plan calls out by name ----

  it("a chain-blocked status change surfaces the blocker's name verbatim, not a generic failure", async () => {
    callHubTool.mockRejectedValueOnce(
      new HubDeniedError('tool failed: cannot move to "doing": blocked by 1 open dependency (Design mockup)'),
    );
    const reply = await routeCommand("pm", ctx({}, "status t1 doing"));
    expect(reply).toContain("Design mockup");
    expect(reply).toContain('cannot move to "doing"');
    expect(reply).not.toMatch(/something went wrong/i);
    expect(reply).not.toContain("tool failed:"); // wrapper stripped, substance kept
  });

  it("a user without PM rights gets a legible refusal naming the real reason, not a generic failure", async () => {
    callHubTool.mockRejectedValueOnce(new HubDeniedError("denied by policy: pm.setStatus"));
    const reply = await routeCommand("pm", ctx({}, "status t1 done"));
    expect(reply).toContain("denied by policy");
    expect(reply).not.toMatch(/something went wrong/i);
  });

  it("a Cerbos-authoritative assurance denial also renders its own reason (pm.passBall is the privileged 'manage' action)", async () => {
    callHubTool.mockRejectedValueOnce(
      new HubDeniedError("denied: pm.passBall requires low assurance; caller has anonymous (step up on a verified surface)"),
    );
    const reply = await routeCommand("pm", ctx({}, "pass t1 u2"));
    expect(reply).toContain("requires low assurance");
  });

  it("a transport/hub failure (not a denial) renders as unavailable, distinct from a denial", async () => {
    callHubTool.mockRejectedValueOnce(new Error("hub 503"));
    const reply = await routeCommand("pm", ctx());
    expect(reply).toContain("unavailable");
    expect(reply).toContain("hub 503");
  });

  it("'/pm due <id> <date>' forwards YYYY-MM-DD, and 'clear' forwards null", async () => {
    callHubTool.mockResolvedValueOnce(JSON.stringify({ id: "t1" }));
    await routeCommand("pm", ctx({}, "due t1 2026-09-01"));
    expect(callHubTool.mock.calls[0][1]).toEqual({ tenantId: "tenant-1", taskId: "t1", dueDate: "2026-09-01" });

    callHubTool.mockResolvedValueOnce(JSON.stringify({ id: "t1" }));
    await routeCommand("pm", ctx({}, "due t1 clear"));
    expect(callHubTool.mock.calls[1][1]).toEqual({ tenantId: "tenant-1", taskId: "t1", dueDate: null });
  });

  it("'/pm pass <id> <userId> <note>' forwards refId + assignmentNote", async () => {
    callHubTool.mockResolvedValueOnce(JSON.stringify({ id: "t1" }));
    const reply = await routeCommand("pm", ctx({}, "pass t1 u2 heads up"));
    expect(callHubTool.mock.calls[0][1]).toEqual({ tenantId: "tenant-1", taskId: "t1", refId: "u2", assignmentNote: "heads up" });
    expect(reply).toContain("u2");
  });

  it("'/pm comment <id> <text>' posts via pm.comment", async () => {
    callHubTool.mockResolvedValueOnce(JSON.stringify({ id: "c1" }));
    const reply = await routeCommand("pm", ctx({}, "comment t1 looks great"));
    expect(callHubTool.mock.calls[0]).toEqual(["pm.comment", { tenantId: "tenant-1", taskId: "t1", body: "looks great" }, expect.anything()]);
    expect(reply.toLowerCase()).toContain("posted");
  });

  it("'/pm history <id>' renders the ledger newest-first", async () => {
    callHubTool.mockResolvedValueOnce(
      JSON.stringify([
        { refId: "u2", refName: "Sari", responsibleId: "u2", responsibleName: "Sari", statusId: "doing", note: null, changedByName: "Budi", createdAt: "2026-08-05T00:00:00Z" },
      ]),
    );
    const reply = await routeCommand("pm", ctx({}, "history t1"));
    expect(reply).toContain("Sari");
    expect(reply).toContain("doing");
  });

  it("unrecognized args return usage help instead of guessing at an action", async () => {
    const reply = await routeCommand("pm", ctx({}, "frobnicate"));
    expect(reply).toContain("Usage:");
    expect(callHubTool).not.toHaveBeenCalled();
  });
});
