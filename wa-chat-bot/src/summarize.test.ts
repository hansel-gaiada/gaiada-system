import { describe, it, expect, vi } from "vitest";
import type { StoredMessage } from "./store";

const complete = vi.fn(async (_prompt: string) => "DIGEST");
vi.mock("./llm", () => ({
  complete: (p: string) => complete(p),
  describeMedia: vi.fn(async () => ""),
}));

import { summarizeChat } from "./summarize";
import { config } from "./config";

function m(over: Partial<StoredMessage>): StoredMessage {
  return {
    chatId: "g@g.us",
    senderId: "s",
    senderName: "Siti",
    waMessageId: "w",
    ts: 1_700_000_000_000,
    text: "",
    fromBot: false,
    ...over,
  };
}

describe("digest transcript includes media-derived text (Task 2.7)", () => {
  it("a completed transcription appears; pending degrades to a placeholder; failed shows its reason", async () => {
    await summarizeChat([
      m({ text: "voice note", mediaStatus: "done", mediaText: "we need two more welders on site B" }),
      m({ text: "", mediaStatus: "pending", mediaMime: "image/jpeg" }),
      m({ text: "", mediaStatus: "failed", mediaText: "[media processing failed: download 404]" }),
      m({ text: "plain message" }),
    ]);
    const prompt = complete.mock.calls[0][0];
    expect(prompt).toContain("we need two more welders on site B");
    expect(prompt).toContain("[media attached — still processing]");
    expect(prompt).toContain("[media processing failed: download 404]");
    expect(prompt).toContain("plain message");
  });
});

describe("map-reduce for oversized windows (5a.6)", () => {
  it("small window → a single call (no map-reduce)", async () => {
    complete.mockClear();
    await summarizeChat([m({ text: "short standup note" })]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("oversized window → chunk summaries + one reduce, covering first AND last facts", async () => {
    complete.mockClear();
    complete.mockImplementation(async (prompt: string) =>
      prompt.includes("PARTIAL DIGESTS") ? "MERGED DIGEST" : `PARTIAL(${prompt.length})`,
    );
    config.summarizeMaxChars = 500;
    // Many messages so the rendered transcript far exceeds 500 chars.
    const msgs = Array.from({ length: 60 }, (_, i) =>
      m({ ts: 1_700_000_000_000 + i * 1000, text: i === 0 ? "FIRST-FACT pour slab" : i === 59 ? "LAST-FACT crane booked" : `update number ${i}` }),
    );
    const result = await summarizeChat(msgs);

    expect(result).toBe("MERGED DIGEST");
    const mapCalls = complete.mock.calls.filter((c) => !c[0].includes("PARTIAL DIGESTS"));
    const reduceCalls = complete.mock.calls.filter((c) => c[0].includes("PARTIAL DIGESTS"));
    expect(mapCalls.length).toBeGreaterThan(1); // actually chunked
    expect(reduceCalls.length).toBe(1); // exactly one reduce
    // No fact is lost across the chunk boundary: first chunk has FIRST-FACT, last has LAST-FACT.
    expect(mapCalls[0][0]).toContain("FIRST-FACT");
    expect(mapCalls.at(-1)![0]).toContain("LAST-FACT");
    config.summarizeMaxChars = 12000;
  });
});
