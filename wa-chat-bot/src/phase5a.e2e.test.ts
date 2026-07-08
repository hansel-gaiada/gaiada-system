// Phase-5a end-to-end (5a.12): the production-grade media path proven whole with the new
// components — Telegram voice (getFile) + WhatsApp document (local extraction), each
// SCRUBBED before persist, then surfaced in a digest. The Gateway (whisper/vision) is
// faked; extraction of the docx is REAL.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import JSZip from "jszip";
import { config } from "./config";
import { resetRegistryCache } from "./groups";
import type { StoredMessage, MediaStatus } from "./store";

const db: StoredMessage[] = [];
vi.mock("./store", () => ({
  initStore: vi.fn(async () => undefined),
  saveMessage: vi.fn(async (m: StoredMessage) => void db.push(m)),
  getMessages: vi.fn(async (chatId: string, since = 0) => db.filter((m) => m.chatId === chatId && m.ts >= since)),
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
  // Gateway media: whisper transcript for audio (leaks a PAN → worker must scrub it).
  describeMedia: vi.fn(async (_b: Buffer, mime: string) =>
    mime.startsWith("audio/") ? "boss said wire it to card 4111 1111 1111 1111 today" : `[vision:${mime}]`,
  ),
}));

import { normalizeTelegram, TG_FILE_PREFIX } from "./telegram";
import { normalize } from "./waha";
import { handleInbound } from "./bot";
import { processPendingMedia } from "./media";
import { runDigests } from "./schedule";

const DIR = "data/test-e2e5a";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const gw = { sendText: async () => undefined };

async function buildDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

describe("phase 5a e2e: production media path", () => {
  beforeAll(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    writeFileSync(`${DIR}/groups.yaml`, `groups:\n  - id: "tg:-100"\n    name: Site\n    optIn: false\n`);
    config.groupsFile = `${DIR}/groups.yaml`;
    config.scheduleStateFile = `${DIR}/state.json`;
    config.databaseUrl = ""; // file-mode, hermetic
    config.managementGroupId = "mgmt@g.us";
    config.redisUrl = ""; // in-process poller path for the test
    resetRegistryCache();
  });

  it("Telegram VOICE note → getFile bytes → whisper transcript → PAN scrubbed → stored", async () => {
    // Fake the Telegram getFile download for the voice file.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/getFile")) {
          return { ok: true, json: async () => ({ result: { file_path: "voice/v.ogg" } }) };
        }
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode("oggbytes").buffer };
      }),
    );
    const voice = normalizeTelegram({
      message: { message_id: 9, date: Math.floor(Date.now() / 1000), chat: { id: -100, type: "supergroup" }, from: { id: 5, first_name: "Budi" }, voice: { file_id: "V1", mime_type: "audio/ogg" } },
    })!;
    expect(voice.media?.url).toBe(`${TG_FILE_PREFIX}V1`);
    await handleInbound(gw, voice);
    await processPendingMedia();
    vi.unstubAllGlobals();

    const row = db.find((m) => m.waMessageId === "tg:9")!;
    expect(row.mediaStatus).toBe("done");
    expect(row.mediaText).toContain("[REDACTED-CARD]");
    expect(row.mediaText).not.toContain("4111");
  });

  it("WhatsApp DOCUMENT (docx) → REAL local extraction → scrubbed → stored", async () => {
    const docx = await buildDocx("handover: pay vendor NIK 3201150812001234 by friday");
    // Fake WAHA serving the file bytes at the media url.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => docx.buffer.slice(docx.byteOffset, docx.byteOffset + docx.byteLength) })));
    const doc = normalize({
      event: "message",
      payload: {
        id: "wamid-doc", from: "tg:-100", participant: "628@c.us", notifyName: "Sari",
        timestamp: Math.floor(Date.now() / 1000), hasMedia: true,
        media: { url: "http://waha/doc.docx", mimetype: DOCX_MIME },
      },
    })!;
    // route it into the tg:-100 group so the digest picks it up (chatId from payload.from)
    await handleInbound(gw, doc);
    await processPendingMedia();
    vi.unstubAllGlobals();

    const row = db.find((m) => m.waMessageId === "wamid-doc")!;
    expect(row.mediaStatus).toBe("done");
    expect(row.mediaText).toContain("handover");
    expect(row.mediaText).toContain("[REDACTED-ID]"); // NIK scrubbed
    expect(row.mediaText).not.toContain("3201150812001234");
  });

  it("both media transcripts reach the digest (scrubbed)", async () => {
    prompts.length = 0;
    await runDigests(gw, "noon");
    const digestPrompt = prompts.find((p) => p.includes("TRANSCRIPT"))!;
    expect(digestPrompt).toContain("[REDACTED-CARD]"); // from the voice note
    expect(digestPrompt).toContain("handover"); // from the docx
    expect(digestPrompt).not.toContain("4111");
    expect(digestPrompt).not.toContain("3201150812001234");
  });
});
