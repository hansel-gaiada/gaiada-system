import { describe, it, expect, beforeEach, vi } from "vitest";
import { config } from "./config";
import type { StoredMessage } from "./store";

const pending: StoredMessage[] = [];
const updates: Array<{ id: string; status: string; text?: string }> = [];
vi.mock("./store", () => ({
  getPendingMedia: vi.fn(async () => [...pending]),
  updateMedia: vi.fn(async (id: string, patch: { status: string; text?: string }) =>
    void updates.push({ id, ...patch }),
  ),
  saveMessage: vi.fn(async () => undefined),
  getMessages: vi.fn(async () => []),
  getGroupChatIds: vi.fn(async () => []),
  initStore: vi.fn(async () => undefined),
}));

const describeMedia = vi.fn(async (_b: Buffer, _m: string) => "transcript");
vi.mock("./llm", () => ({
  complete: vi.fn(async () => "ok"),
  describeMedia: (b: Buffer, m: string) => describeMedia(b, m),
}));

import { processPendingMedia } from "./media";

function row(over: Partial<StoredMessage>): StoredMessage {
  return {
    chatId: "g@g.us",
    senderId: "s",
    senderName: "S",
    waMessageId: "m1",
    ts: 1,
    text: "",
    fromBot: false,
    mediaMime: "audio/ogg",
    mediaRef: "http://waha/media/1.ogg",
    mediaStatus: "pending",
    ...over,
  };
}

describe("media worker", () => {
  beforeEach(() => {
    pending.length = 0;
    updates.length = 0;
    describeMedia.mockClear();
    describeMedia.mockResolvedValue("transcript");
    config.wahaApiKey = "waha-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode("bytes").buffer })),
    );
  });

  it("downloads (with the WAHA api key), extracts, SCRUBS, and completes the row", async () => {
    describeMedia.mockResolvedValue("she read out the card 4111 1111 1111 1111 for the deposit");
    pending.push(row({ waMessageId: "voice-1" }));
    await processPendingMedia();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls[0][0]).toBe("http://waha/media/1.ogg");
    expect(fetchMock.mock.calls[0][1].headers["X-Api-Key"]).toBe("waha-key");

    expect(updates).toEqual([
      { id: "voice-1", status: "done", text: expect.stringContaining("[REDACTED-CARD]") },
    ]);
    expect(updates[0].text).not.toContain("4111"); // the day-one guarantee extends to media
  });

  it("marks a row with no served file as failed with an observable placeholder", async () => {
    pending.push(row({ waMessageId: "nofile-1", mediaRef: "" }));
    await processPendingMedia();
    expect(updates[0].status).toBe("failed");
    expect(updates[0].text).toContain("not served by WAHA");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an extraction failure marks that row failed and still processes the rest", async () => {
    describeMedia.mockImplementation(async (_b: Buffer, m: string) => {
      if (m === "audio/ogg") throw new Error("model down");
      return "a photo of the site";
    });
    pending.push(row({ waMessageId: "bad-1", mediaMime: "audio/ogg" }));
    pending.push(row({ waMessageId: "good-1", mediaMime: "image/jpeg" }));
    await processPendingMedia();
    expect(updates.find((u) => u.id === "bad-1")?.status).toBe("failed");
    expect(updates.find((u) => u.id === "good-1")).toEqual({
      id: "good-1",
      status: "done",
      text: "a photo of the site",
    });
  });

  it("rejects oversized files without downloading them into memory forever", async () => {
    config.mediaMaxBytes = 3;
    pending.push(row({ waMessageId: "big-1" }));
    await processPendingMedia();
    config.mediaMaxBytes = 15 * 1024 * 1024;
    expect(updates[0].status).toBe("failed");
    expect(updates[0].text).toContain("too large");
  });
});
