import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { FileStore } from "./file";
import type { StoredMessage } from "./types";

const DIR = "data/test-filestore";

function m(over: Partial<StoredMessage>): StoredMessage {
  return {
    chatId: "g@g.us",
    senderId: "s1",
    senderName: "Siti",
    waMessageId: "w1",
    ts: Date.now(),
    text: "hello",
    fromBot: false,
    ...over,
  };
}

describe("FileStore media queue", () => {
  let store: FileStore;

  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    store = new FileStore(`${DIR}/messages.json`);
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("persists media fields and lists pending media", async () => {
    await store.saveMessage(m({ waMessageId: "text-1" }));
    await store.saveMessage(
      m({ waMessageId: "voice-1", mediaMime: "audio/ogg", mediaRef: "http://waha/m/1", mediaStatus: "pending" }),
    );
    const pending = await store.getPendingMedia();
    expect(pending.map((p) => p.waMessageId)).toEqual(["voice-1"]);
    expect(pending[0].mediaMime).toBe("audio/ogg");
  });

  it("updateMedia completes a row and removes it from the queue", async () => {
    await store.saveMessage(m({ waMessageId: "img-1", mediaMime: "image/jpeg", mediaStatus: "pending" }));
    await store.updateMedia("img-1", { status: "done", text: "a crane lifting beams" });
    expect(await store.getPendingMedia()).toEqual([]);
    const [row] = await store.getMessages("g@g.us");
    expect(row.mediaStatus).toBe("done");
    expect(row.mediaText).toBe("a crane lifting beams");
  });

  it("failed media keeps its placeholder and leaves the queue", async () => {
    await store.saveMessage(m({ waMessageId: "vid-1", mediaMime: "video/mp4", mediaStatus: "pending" }));
    await store.updateMedia("vid-1", { status: "failed", text: "[media unavailable]" });
    expect(await store.getPendingMedia()).toEqual([]);
    const [row] = await store.getMessages("g@g.us");
    expect(row.mediaStatus).toBe("failed");
  });
});
