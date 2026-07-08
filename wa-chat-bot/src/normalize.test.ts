import { describe, it, expect } from "vitest";
import { normalize } from "./waha";

describe("normalize", () => {
  it("maps a WAHA group message event to InboundMessage", () => {
    const event = {
      event: "message",
      session: "default",
      payload: {
        id: "abc123",
        from: "12036300000000@g.us",
        participant: "628110000000@c.us",
        notifyName: "Budi",
        body: "Project Alpha update",
        timestamp: 1_700_000_000,
        fromMe: false,
      },
    };
    const m = normalize(event)!;
    expect(m.chatId).toBe("12036300000000@g.us");
    expect(m.isGroup).toBe(true);
    expect(m.senderId).toBe("628110000000@c.us");
    expect(m.senderName).toBe("Budi");
    expect(m.text).toBe("Project Alpha update");
    expect(m.ts).toBe(1_700_000_000_000);
    expect(m.fromMe).toBe(false);
  });

  it("captures media info (and empty url when WAHA served no file)", () => {
    const withFile = normalize({
      event: "message",
      payload: {
        from: "1@g.us",
        body: "site photo",
        hasMedia: true,
        media: { url: "http://waha/media/x.jpg", mimetype: "image/jpeg", filename: "x.jpg" },
      },
    })!;
    expect(withFile.media).toEqual({ url: "http://waha/media/x.jpg", mimetype: "image/jpeg", filename: "x.jpg" });

    const noFile = normalize({ event: "message", payload: { from: "1@g.us", body: "", hasMedia: true } })!;
    expect(noFile.media?.url).toBe("");

    const textOnly = normalize({ event: "message", payload: { from: "1@g.us", body: "hi" } })!;
    expect(textOnly.media).toBeNull();
  });

  it("returns null for non-message events", () => {
    expect(normalize({ event: "session.status" })).toBeNull();
    expect(normalize(null)).toBeNull();
  });

  it("flags direct messages as not group", () => {
    const m = normalize({ event: "message", payload: { from: "628110000000@c.us", body: "hi" } })!;
    expect(m.isGroup).toBe(false);
  });

  it("detects a reply to one of the bot's own messages", () => {
    const m = normalize({
      event: "message",
      payload: {
        from: "12036300000000@g.us",
        body: "yes, that one",
        _data: { quotedMsg: { fromMe: true, body: "Did you mean Project Alpha?" } },
      },
    })!;
    expect(m.replyToBot).toBe(true);
    const plain = normalize({ event: "message", payload: { from: "1@g.us", body: "hi" } })!;
    expect(plain.replyToBot).toBe(false);
    const replyToHuman = normalize({
      event: "message",
      payload: { from: "1@g.us", body: "ok", _data: { quotedMsg: { fromMe: false } } },
    })!;
    expect(replyToHuman.replyToBot).toBe(false);
  });
});
