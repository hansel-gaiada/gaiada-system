import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the hub boundary: authz.check + write tools. HubDeniedError must be the SAME class
// the authorizer does `instanceof` against, so export it from the mock.
const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
let hubImpl: (tool: string, args: Record<string, unknown>) => Promise<string> = async () => "";
vi.mock("../hub", () => ({
  HubDeniedError: class HubDeniedError extends Error {},
  callHubTool: (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    return hubImpl(tool, args);
  },
}));

import { dispatchActionCommand, tryConfirmByReply, handleButton, isActionCommand } from "./dispatch";
import { registerBusinessActions } from "./builtins";
import { resetActions } from "./registry";
import { resetConfirm, getPending } from "./confirm";
import { resetRateLimiter } from "../safety/rate-limit";
import { setActionsEnabled } from "../safety/kill-switch";
import { config } from "../config";
import type { InboundMessage } from "../waha";

const sent: Array<{ kind: string; text: string }> = [];
const gw = {
  sendText: async (_c: string, t: string) => void sent.push({ kind: "text", text: t }),
  sendButtons: async (_c: string, t: string) => void sent.push({ kind: "buttons", text: t }),
};

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    chatId: "site@g.us", senderId: "u@c.us", senderName: "U", waMessageId: "m1", ts: 1,
    text: "", isGroup: true, fromMe: false, replyToBot: false, media: null, ...over,
  };
}

describe("action dispatch (command → propose → confirm → execute)", () => {
  beforeEach(() => {
    resetActions();
    registerBusinessActions();
    resetConfirm();
    resetRateLimiter();
    setActionsEnabled(true);
    config.defaultTenantId = "co-1";
    calls.length = 0;
    sent.length = 0;
    hubImpl = async (tool) => {
      if (tool === "authz.check") return JSON.stringify({ decision: "allow" });
      if (tool === "tasks.create") return JSON.stringify({ id: "task-9" });
      if (tool === "tasks.update") return JSON.stringify({ id: "task-9" });
      if (tool === "projects.create") return JSON.stringify({ id: "proj-9" });
      return "{}";
    };
  });

  it("recognizes action commands", () => {
    expect(isActionCommand("task create proj-1 Pour slab")).toBe(true);
    expect(isActionCommand("ping")).toBe(false);
    expect(isActionCommand("summarize")).toBe(false);
  });

  it("authorized command proposes with a confirm card and does NOT execute yet", async () => {
    const handled = await dispatchActionCommand(gw as any, msg(), "task create proj-1 Pour slab");
    expect(handled).toBe(true);
    expect(sent[0].kind).toBe("buttons");
    expect(sent[0].text).toMatch(/Create task "Pour slab"/);
    expect(getPending("site@g.us", "u@c.us")).not.toBeNull();
    // authz.check happened; the write did NOT
    expect(calls.map((c) => c.tool)).toContain("authz.check");
    expect(calls.map((c) => c.tool)).not.toContain("tasks.create");
  });

  it("a button confirmation executes the write exactly once", async () => {
    await dispatchActionCommand(gw as any, msg(), "task create proj-1 Pour slab");
    const token = getPending("site@g.us", "u@c.us")!.token;
    await handleButton(gw as any, "site@g.us", "u@c.us", token);
    expect(calls.some((c) => c.tool === "tasks.create" && c.args.title === "Pour slab")).toBe(true);
    expect(sent.at(-1)!.text).toMatch(/Created task "Pour slab"/);
    // a second press is a no-op (single-use token)
    calls.length = 0;
    await handleButton(gw as any, "site@g.us", "u@c.us", token);
    expect(calls.some((c) => c.tool === "tasks.create")).toBe(false);
  });

  it("an affirmative reply confirms and executes", async () => {
    await dispatchActionCommand(gw as any, msg(), "project create Rebrand");
    const handled = await tryConfirmByReply(gw as any, msg({ text: "yes" }), "yes");
    expect(handled).toBe(true);
    expect(calls.some((c) => c.tool === "projects.create" && c.args.name === "Rebrand")).toBe(true);
  });

  it("unverified identity (hub denies authz.check) gets step-up, no pending, no write", async () => {
    const { HubDeniedError } = (await import("../hub")) as unknown as { HubDeniedError: new (m: string) => Error };
    hubImpl = async (tool) => {
      if (tool === "authz.check") throw new HubDeniedError("unlinked");
      return "{}";
    };
    const handled = await dispatchActionCommand(gw as any, msg(), "task create proj-1 Pour slab");
    expect(handled).toBe(true);
    expect(sent[0].text).toMatch(/verified login|link/i);
    expect(getPending("site@g.us", "u@c.us")).toBeNull();
    expect(calls.some((c) => c.tool === "tasks.create")).toBe(false);
  });

  it("tryConfirmByReply returns false when nothing is pending", async () => {
    expect(await tryConfirmByReply(gw as any, msg({ text: "yes" }), "yes")).toBe(false);
  });
});
