// Phase G resilience: event-level replay/chaos. Proves the two idempotency guarantees hold
// under duplicate delivery — a redelivered message is processed once, and a redelivered
// button confirmation executes the write once (single-use token).
import { describe, it, expect, beforeEach, vi } from "vitest";

const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
let hubImpl: (tool: string, args: Record<string, unknown>) => Promise<string>;
vi.mock("../hub", () => ({
  HubDeniedError: class HubDeniedError extends Error {},
  callHubTool: (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    return hubImpl(tool, args);
  },
}));

const saved: unknown[] = [];
vi.mock("../store", () => ({
  saveMessage: vi.fn(async (m: unknown) => void saved.push(m)),
  getMessages: vi.fn(async () => []),
  getGroupChatIds: vi.fn(async () => []),
  initStore: vi.fn(async () => undefined),
}));

import { handleEvent } from "../bot";
import { registerBusinessActions } from "./builtins";
import { resetActions as resetActionRegistry } from "./registry";
import { getPending as pending, resetConfirm } from "./confirm";
import { resetDedup } from "../safety/dedup";
import { resetRateLimiter } from "../safety/rate-limit";
import { setActionsEnabled } from "../safety/kill-switch";
import { config } from "../config";
import type { InboundEvent } from "../gateway/events";

const sentButtons: string[] = [];
const gw = {
  sendText: async () => {},
  sendButtons: async (_c: string, t: string) => void sentButtons.push(t),
};

describe("chaos: duplicate delivery is idempotent", () => {
  beforeEach(() => {
    resetActionRegistry();
    registerBusinessActions();
    resetConfirm();
    resetDedup();
    resetRateLimiter();
    setActionsEnabled(true);
    config.defaultTenantId = "co-1";
    config.intentRoutingEnabled = false; // isolate command path
    calls.length = 0;
    saved.length = 0;
    sentButtons.length = 0;
    hubImpl = async (tool) => {
      if (tool === "authz.check") return JSON.stringify({ decision: "allow" });
      if (tool === "tasks.create") return JSON.stringify({ id: "task-1" });
      return "{}";
    };
  });

  it("a redelivered action command proposes only once", async () => {
    const ev: InboundEvent = {
      kind: "message",
      message: { chatId: "g@g.us", senderId: "u@c.us", senderName: "U", waMessageId: "MID-1", ts: 1,
        text: "/task create proj-1 Pour slab", isGroup: true, fromMe: false, replyToBot: false, media: null },
    };
    await handleEvent(gw as any, ev);
    await handleEvent(gw as any, ev); // webhook redelivery — dropped by dedup
    expect(sentButtons.length).toBe(1);
    const authzCalls = calls.filter((c) => c.tool === "authz.check").length;
    expect(authzCalls).toBe(1);
  });

  it("a redelivered button confirmation executes the write once", async () => {
    const cmd: InboundEvent = {
      kind: "message",
      message: { chatId: "g@g.us", senderId: "u@c.us", senderName: "U", waMessageId: "MID-2", ts: 1,
        text: "/task create proj-1 Pour slab", isGroup: true, fromMe: false, replyToBot: false, media: null },
    };
    await handleEvent(gw as any, cmd);
    const token = pending("g@g.us", "u@c.us")!.token;
    const press: InboundEvent = { kind: "button", chatId: "g@g.us", senderId: "u@c.us", token, messageId: "b1", ts: 2 };
    await handleEvent(gw as any, press);
    await handleEvent(gw as any, press); // duplicate press — single-use token
    const writes = calls.filter((c) => c.tool === "tasks.create").length;
    expect(writes).toBe(1);
  });
});
