import { describe, it, expect, vi } from "vitest";
import { normalizeTelegram, TelegramGateway } from "./telegram";

describe("Telegram adapter (Task 3.6)", () => {
  it("normalizes a group message to the same InboundMessage shape", () => {
    const m = normalizeTelegram({
      message: {
        message_id: 7,
        date: 1_700_000_000,
        text: "site update",
        chat: { id: -100123, type: "supergroup" },
        from: { id: 555, first_name: "Budi", last_name: "S" },
      },
    })!;
    expect(m.chatId).toBe("tg:-100123");
    expect(m.isGroup).toBe(true);
    expect(m.senderId).toBe("tg:555");
    expect(m.senderName).toBe("Budi S");
    expect(m.ts).toBe(1_700_000_000_000);
    expect(m.replyToBot).toBe(false);
  });

  it("flags DMs, reply-to-bot, and drops bot/non-text updates", () => {
    const dm = normalizeTelegram({
      message: { message_id: 1, date: 1, text: "hi", chat: { id: 9, type: "private" }, from: { id: 9 } },
    })!;
    expect(dm.isGroup).toBe(false);

    const reply = normalizeTelegram({
      message: {
        message_id: 2, date: 1, text: "yes", chat: { id: 9, type: "private" }, from: { id: 9 },
        reply_to_message: { from: { is_bot: true } },
      },
    })!;
    expect(reply.replyToBot).toBe(true);

    expect(normalizeTelegram({ message: { chat: { id: 9 }, from: { id: 1, is_bot: true }, text: "x" } })).toBeNull();
    expect(normalizeTelegram({ message: { chat: { id: 9 }, from: { id: 1 } } })).toBeNull(); // no text, no media
    expect(normalizeTelegram({ edited_message: {} })).toBeNull();
  });

  it("captures media (voice/photo/document) as tg-file refs; caption becomes the text (5a.7)", () => {
    const voice = normalizeTelegram({
      message: { message_id: 3, date: 1, chat: { id: 9, type: "private" }, from: { id: 9 }, voice: { file_id: "AA1", mime_type: "audio/ogg" } },
    })!;
    expect(voice.media).toEqual({ url: "tg-file:AA1", mimetype: "audio/ogg" });
    expect(voice.text).toBe("");

    const photo = normalizeTelegram({
      message: {
        message_id: 4, date: 1, chat: { id: 9, type: "private" }, from: { id: 9 },
        caption: "site progress", photo: [{ file_id: "small" }, { file_id: "large" }],
      },
    })!;
    expect(photo.media).toEqual({ url: "tg-file:large", mimetype: "image/jpeg" }); // largest size
    expect(photo.text).toBe("site progress");

    const doc = normalizeTelegram({
      message: { message_id: 5, date: 1, chat: { id: 9, type: "private" }, from: { id: 9 }, document: { file_id: "D1", mime_type: "application/pdf" } },
    })!;
    expect(doc.media).toEqual({ url: "tg-file:D1", mimetype: "application/pdf" });
  });

  it("downloadTelegramFile resolves via getFile then downloads (5a.7)", async () => {
    const { downloadTelegramFile } = await import("./telegram");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/getFile"))
        return { ok: true, json: async () => ({ result: { file_path: "voice/file_1.ogg" } }) };
      expect(url).toBe("https://api.telegram.org/file/botTOK/voice/file_1.ogg");
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode("oggbytes").buffer };
    });
    vi.stubGlobal("fetch", fetchMock);
    const bytes = await downloadTelegramFile("tg-file:AA1", "TOK");
    vi.unstubAllGlobals();
    expect(bytes.toString()).toBe("oggbytes");
  });

  it("pollTelegramOnce feeds updates through onMessage and advances the offset", async () => {
    const { pollTelegramOnce } = await import("./telegram");
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("/botTOKEN/getUpdates");
      expect(url).toContain("offset=5");
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [
            {
              update_id: 9,
              message: { message_id: 1, date: 1, text: "hello", chat: { id: 7, type: "private" }, from: { id: 7, first_name: "B" } },
            },
            { update_id: 10 }, // non-message update — skipped, offset still advances
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const seen: string[] = [];
    const next = await pollTelegramOnce("TOKEN", 5, async (m) => void seen.push(m.text));
    expect(next).toBe(11);
    expect(seen).toEqual(["hello"]);
    vi.unstubAllGlobals();
  });

  it("SurfaceRouter sends tg: chats via Telegram and the rest via WAHA", async () => {
    const { SurfaceRouter } = await import("./surface");
    const sent: string[] = [];
    const router = new SurfaceRouter(
      { sendText: async (c) => void sent.push(`wa:${c}`) },
      { sendText: async (c) => void sent.push(`telegram:${c}`) },
    );
    await router.sendText("tg:123", "x");
    await router.sendText("456@g.us", "x");
    expect(sent).toEqual(["telegram:tg:123", "wa:456@g.us"]);
  });

  it("sendText posts to the Bot API with the unprefixed chat id", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) => ({ ok: true, text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);
    await new TelegramGateway("TOKEN").sendText("tg:-100123", "pong");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    expect(JSON.parse(init?.body ?? "")).toEqual({ chat_id: "-100123", text: "pong" });
    vi.unstubAllGlobals();
  });
});
