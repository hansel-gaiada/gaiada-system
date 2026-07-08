// Phase-2 integration test (Task 2.8): a voice note arrives → persisted pending →
// worker downloads + extracts + SCRUBS → digest includes the transcript.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { config } from "./config";
import { resetRegistryCache } from "./groups";
import type { StoredMessage, MediaStatus } from "./store";

const db: StoredMessage[] = [];
vi.mock("./store", () => ({
  initStore: vi.fn(async () => undefined),
  saveMessage: vi.fn(async (m: StoredMessage) => void db.push(m)),
  getMessages: vi.fn(async (chatId: string, sinceTs = 0) => db.filter((m) => m.chatId === chatId && m.ts >= sinceTs)),
  getGroupChatIds: vi.fn(async () => [...new Set(db.map((m) => m.chatId))]),
  getPendingMedia: vi.fn(async (limit = 10) => db.filter((m) => m.mediaStatus === "pending").slice(0, limit)),
  updateMedia: vi.fn(async (id: string, patch: { status: MediaStatus; text?: string }) => {
    const row = db.find((m) => m.waMessageId === id);
    if (row) {
      row.mediaStatus = patch.status;
      if (patch.text !== undefined) row.mediaText = patch.text;
    }
  }),
}));

const prompts: string[] = [];
vi.mock("./llm", () => ({
  complete: vi.fn(async (p: string) => {
    prompts.push(p);
    return "AI-DIGEST";
  }),
  // The "transcription" leaks a PAN — the worker must scrub it before persisting.
  describeMedia: vi.fn(async () => "supplier asked us to pay card 4111 1111 1111 1111 before friday"),
}));

import { normalize } from "./waha";
import { handleInbound } from "./bot";
import { processPendingMedia } from "./media";
import { runDigests } from "./schedule";

const DIR = "data/test-e2e2";
const gw = { sendText: async () => undefined };

describe("phase 2 end-to-end: voice note → scrubbed transcript → digest", () => {
  beforeAll(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    writeFileSync(`${DIR}/groups.yaml`, `groups:\n  - id: "site@g.us"\n    name: Site A\n    optIn: false\n`);
    config.groupsFile = `${DIR}/groups.yaml`;
    config.scheduleStateFile = `${DIR}/state.json`;
    config.managementGroupId = "mgmt@g.us";
    resetRegistryCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode("oggbytes").buffer })),
    );
  });

  it("intake: the voice note is stored pending with its reference", async () => {
    const event = {
      event: "message",
      payload: {
        id: "voice-9",
        from: "site@g.us",
        participant: "628110@c.us",
        notifyName: "Budi",
        body: "",
        timestamp: Math.floor(Date.now() / 1000),
        hasMedia: true,
        media: { url: "http://waha/media/voice-9.ogg", mimetype: "audio/ogg" },
      },
    };
    await handleInbound(gw, normalize(event)!);
    const row = db.find((m) => m.waMessageId === "voice-9")!;
    expect(row.mediaStatus).toBe("pending");
    expect(row.mediaRef).toBe("http://waha/media/voice-9.ogg");
  });

  it("worker: transcript is extracted and the PAN scrubbed before persist", async () => {
    await processPendingMedia();
    const row = db.find((m) => m.waMessageId === "voice-9")!;
    expect(row.mediaStatus).toBe("done");
    expect(row.mediaText).toContain("[REDACTED-CARD]");
    expect(row.mediaText).not.toContain("4111");
  });

  it("digest: the scrubbed transcript reaches the summarizer prompt", async () => {
    await runDigests(gw, "noon");
    const digestPrompt = prompts.find((p) => p.includes("TRANSCRIPT"))!;
    expect(digestPrompt).toContain("supplier asked us to pay card [REDACTED-CARD]");
  });
});
