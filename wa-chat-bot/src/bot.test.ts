import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { config } from "./config";
import { resetRegistryCache, setIgnored, discoveredGroups } from "./groups";
import { isTriggered, respond, handleInbound } from "./bot";
import { setSelfJid, resetSessionState } from "./session-state";
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
    mentionedJids: [],
    media: null,
    ...over,
  };
}

describe("isTriggered", () => {
  it("DM reply policy gates 1:1 chats (default off protects a shared/personal number)", () => {
    const dm = { isGroup: false, senderId: "628999@c.us" };
    config.dmReplyPolicy = "off";
    expect(isTriggered(msg(dm), "hello")).toBe(false); // never auto-reply to DMs by default
    config.dmReplyPolicy = "all";
    expect(isTriggered(msg(dm), "hello")).toBe(true);
    config.dmReplyPolicy = "allowlist";
    config.dmAllowlist = ["628999"];
    expect(isTriggered(msg(dm), "hello")).toBe(true); // listed sender
    expect(isTriggered(msg({ isGroup: false, senderId: "628000@c.us" }), "hi")).toBe(false); // not listed
    config.dmReplyPolicy = "all"; // leave DMs on for the rest of this suite's group-focused cases
  });
  it("does not trigger on ordinary group chatter", () => {
    expect(isTriggered(msg({ isGroup: true }), "team lunch at 1pm")).toBe(false);
  });
  it("triggers on a command", () => {
    expect(isTriggered(msg({ isGroup: true }), "/ping")).toBe(true);
  });
  it("triggers on an @Rhea text mention (case-insensitive)", () => {
    expect(isTriggered(msg({ isGroup: true }), "hey @Rhea what's the status")).toBe(true);
    expect(isTriggered(msg({ isGroup: true }), "@rhea help")).toBe(true);
    expect(isTriggered(msg({ isGroup: true }), "status please @RHEA?")).toBe(true);
  });
  it("does NOT trigger on substrings that merely contain the mention token", () => {
    // loose includes() would fire on these — the standalone-token matcher must not
    expect(isTriggered(msg({ isGroup: true }), "the @rhealpha channel is quiet")).toBe(false);
    expect(isTriggered(msg({ isGroup: true }), "email ops@rhea.example.com please")).toBe(false);
    expect(isTriggered(msg({ isGroup: true }), "no mention here at all")).toBe(false);
  });
  it("triggers on a reply to the bot's own message", () => {
    expect(isTriggered(msg({ isGroup: true, replyToBot: true }), "yes that one")).toBe(true);
  });
  it("triggers on a real WhatsApp @mention (bot's own JID in mentionedJids, digit-tolerant)", () => {
    setSelfJid("628123456789@c.us");
    // WhatsApp may deliver the JID as @s.whatsapp.net; digit-matching handles both
    expect(isTriggered(msg({ isGroup: true, mentionedJids: ["628123456789@s.whatsapp.net"] }), "take a look")).toBe(true);
    // a mention of someone else must NOT trigger
    expect(isTriggered(msg({ isGroup: true, mentionedJids: ["628999999999@c.us"] }), "cc the lead")).toBe(false);
    resetSessionState();
    // with no known self JID (unpaired), a JID mention alone cannot trigger
    expect(isTriggered(msg({ isGroup: true, mentionedJids: ["628123456789@c.us"] }), "ping")).toBe(false);
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
    // Discovery + ignore-list persist next to the groups file; clear both so "first sighting"
    // and ignore-state assertions aren't satisfied by a previous run's file.
    rmSync("data/test-bot/discovered-groups.json", { force: true });
    rmSync("data/test-bot/ignored-groups.json", { force: true });
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

  it("1a: an ignored LISTED group is dropped in registry mode — never stored, but still discovered", async () => {
    setIgnored("listed@g.us", true);
    await handleInbound(gw, msg({ chatId: "listed@g.us", text: "/ping" }));
    expect(saved.length).toBe(0);
    expect(sent.length).toBe(0);
    // Still visible/un-ignorable: noteDiscovered() ran before the ignore gate.
    expect(discoveredGroups().map((g) => g.id)).toContain("listed@g.us");
  });

  it("1a: un-ignoring restores normal (registry-gated) ingestion", async () => {
    setIgnored("listed@g.us", true);
    await handleInbound(gw, msg({ chatId: "listed@g.us", waMessageId: "a", text: "/ping" }));
    expect(saved.length).toBe(0);

    setIgnored("listed@g.us", false);
    await handleInbound(gw, msg({ chatId: "listed@g.us", waMessageId: "b", text: "/ping" }));
    expect(saved.length).toBe(2); // inbound + reply
    expect(sent).toEqual(["pong"]);
  });
});

describe("handleInbound with the ignore list, trial mode (no registry)", () => {
  const sent: string[] = [];
  const gw: WhatsAppGateway = { sendText: async (_c, t) => void sent.push(t) };

  beforeEach(() => {
    saved.length = 0;
    sent.length = 0;
    resetDedup();
    mkdirSync("data/test-bot", { recursive: true });
    rmSync("data/test-bot/ignored-groups.json", { force: true });
    config.groupsFile = "data/test-bot/missing-registry.yaml"; // no file -> registry inactive
    resetRegistryCache();
  });

  it("1a: an ignored group is dropped even with no registry (trial mode monitors everything else)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setIgnored("blocked@g.us", true);
    await handleInbound(gw, msg({ chatId: "blocked@g.us", waMessageId: "trial-1", text: "/ping" }));
    expect(saved.length).toBe(0);
    expect(sent.length).toBe(0);

    // A DIFFERENT (non-ignored) group is still ingested normally in trial mode.
    await handleInbound(gw, msg({ chatId: "open@g.us", waMessageId: "trial-2", text: "/ping" }));
    expect(saved.length).toBe(2);
    expect(sent).toEqual(["pong"]);
    warn.mockRestore();
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
