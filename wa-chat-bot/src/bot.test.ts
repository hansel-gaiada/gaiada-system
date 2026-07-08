import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { config } from "./config";
import { resetRegistryCache } from "./groups";
import { isTriggered, respond, handleInbound } from "./bot";
import { resetDedup } from "./safety/dedup";
import type { InboundMessage, WhatsAppGateway } from "./waha";

const saved: unknown[] = [];
vi.mock("./store", () => ({
  saveMessage: vi.fn(async (m: unknown) => void saved.push(m)),
  getMessages: vi.fn(async () => []),
  getGroupChatIds: vi.fn(async () => []),
  initStore: vi.fn(async () => undefined),
}));

function msg(over: Partial<InboundMessage>): InboundMessage {
  return {
    chatId: "x@g.us",
    senderId: "s",
    senderName: "S",
    waMessageId: "1",
    ts: Date.now(),
    text: "",
    isGroup: true,
    fromMe: false,
    replyToBot: false,
    media: null,
    ...over,
  };
}

describe("isTriggered", () => {
  it("always triggers in a DM", () => {
    expect(isTriggered(msg({ isGroup: false }), "hello")).toBe(true);
  });
  it("does not trigger on ordinary group chatter", () => {
    expect(isTriggered(msg({ isGroup: true }), "team lunch at 1pm")).toBe(false);
  });
  it("triggers on a command", () => {
    expect(isTriggered(msg({ isGroup: true }), "/ping")).toBe(true);
  });
  it("triggers on an @mention", () => {
    expect(isTriggered(msg({ isGroup: true }), "hey @bot what's the status")).toBe(true);
  });
  it("triggers on a reply to the bot's own message", () => {
    expect(isTriggered(msg({ isGroup: true, replyToBot: true }), "yes that one")).toBe(true);
  });
});

describe("handleInbound with the group registry active", () => {
  const sent: string[] = [];
  const gw: WhatsAppGateway = { sendText: async (_c, t) => void sent.push(t) };

  beforeEach(() => {
    saved.length = 0;
    sent.length = 0;
    resetDedup();
    mkdirSync("data/test-bot", { recursive: true });
    writeFileSync(
      "data/test-bot/groups.yaml",
      `groups:\n  - id: "listed@g.us"\n    name: Listed\n    optIn: true\n`,
    );
    config.groupsFile = "data/test-bot/groups.yaml";
    resetRegistryCache();
  });

  it("persists and replies for a listed group", async () => {
    await handleInbound(gw, msg({ chatId: "listed@g.us", text: "/ping" }));
    expect(saved.length).toBe(2); // inbound + bot reply
    expect(sent).toEqual(["pong"]);
  });

  it("drops an unlisted group's message (no persist, no reply) and logs discovery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await handleInbound(gw, msg({ chatId: "unlisted@g.us", text: "/ping" }));
    expect(saved.length).toBe(0);
    expect(sent.length).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("DMs are unaffected by the registry", async () => {
    await handleInbound(gw, msg({ chatId: "62811@c.us", isGroup: false, text: "hello" }));
    expect(saved.length).toBe(2);
    expect(sent.length).toBe(1);
  });

  it("drops a redelivered message (idempotent): stores + replies once", async () => {
    const dup = msg({ chatId: "listed@g.us", waMessageId: "DUP1", text: "/ping" });
    await handleInbound(gw, dup);
    await handleInbound(gw, dup); // webhook redelivery
    expect(sent).toEqual(["pong"]); // replied exactly once
    expect(saved.length).toBe(2); // inbound + reply stored once
  });
});

describe("respond", () => {
  it("answers /ping with pong (no AI needed)", async () => {
    expect(await respond(msg({}), "/ping")).toBe("pong");
  });
  it("lists commands on /help", async () => {
    expect(await respond(msg({}), "/help")).toContain("summarize");
  });
});
