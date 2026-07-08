import { describe, it, expect } from "vitest";
import { normalizeWahaEvent, normalizeTelegramEvent } from "./events";

describe("normalizeWahaEvent", () => {
  it("wraps a text message", () => {
    const ev = normalizeWahaEvent({ event: "message", payload: { from: "g@g.us", body: "hi", id: "m1" } });
    expect(ev?.kind).toBe("message");
    if (ev?.kind === "message") expect(ev.message.text).toBe("hi");
  });

  it("parses a reaction", () => {
    const ev = normalizeWahaEvent({
      event: "message.reaction",
      payload: { from: "g@g.us", participant: "u@c.us", reaction: { text: "✅", messageId: "m1" }, timestamp: 5 },
    });
    expect(ev).toEqual({ kind: "reaction", chatId: "g@g.us", senderId: "u@c.us", emoji: "✅", messageId: "m1", ts: 5000 });
  });

  it("parses a button reply", () => {
    const ev = normalizeWahaEvent({ event: "button.reply", payload: { from: "g@g.us", participant: "u@c.us", selectedId: "tok123" } });
    expect(ev?.kind).toBe("button");
    if (ev?.kind === "button") expect(ev.token).toBe("tok123");
  });

  it("parses a member add", () => {
    const ev = normalizeWahaEvent({ event: "group.v2.participants", payload: { id: "g@g.us", action: "add", participants: ["new@c.us"] } });
    expect(ev?.kind).toBe("member");
    if (ev?.kind === "member") { expect(ev.change).toBe("joined"); expect(ev.userId).toBe("new@c.us"); }
  });

  it("returns null for unknown events", () => {
    expect(normalizeWahaEvent({ event: "presence.update", payload: {} })).toBeNull();
  });
});

describe("normalizeTelegramEvent", () => {
  it("parses a callback_query as a button press with the token", () => {
    const ev = normalizeTelegramEvent({ callback_query: { from: { id: 7 }, data: "confirm:abc", message: { message_id: 42, chat: { id: -100 } } } });
    expect(ev?.kind).toBe("button");
    if (ev?.kind === "button") { expect(ev.token).toBe("confirm:abc"); expect(ev.chatId).toBe("tg:-100"); expect(ev.senderId).toBe("tg:7"); }
  });

  it("parses a message_reaction", () => {
    const ev = normalizeTelegramEvent({ message_reaction: { chat: { id: -100 }, user: { id: 7 }, message_id: 42, new_reaction: [{ type: "emoji", emoji: "👍" }], date: 3 } });
    expect(ev).toEqual({ kind: "reaction", chatId: "tg:-100", senderId: "tg:7", emoji: "👍", messageId: "tg:42", ts: 3000 });
  });

  it("parses a new member join", () => {
    const ev = normalizeTelegramEvent({ message: { chat: { id: -100 }, date: 1, new_chat_members: [{ id: 9 }] } });
    expect(ev?.kind).toBe("member");
    if (ev?.kind === "member") { expect(ev.change).toBe("joined"); expect(ev.userId).toBe("tg:9"); }
  });

  it("falls back to a text message", () => {
    const ev = normalizeTelegramEvent({ message: { chat: { id: -100, type: "group" }, from: { id: 7, first_name: "A" }, message_id: 1, date: 1, text: "hello" } });
    expect(ev?.kind).toBe("message");
    if (ev?.kind === "message") expect(ev.message.text).toBe("hello");
  });
});
