// Phase-1 integration test (Task 1.10): normalize → registry filter → scrub → persist →
// scheduled digest delivery (opt-in + categorized management) → interaction triggers.
// The AI egress (llm) is faked; store is in-memory (crypto round-trip is covered by the
// envelope tests + the day-one drill).
import { describe, it, expect, beforeAll, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { config } from "./config";
import { resetRegistryCache } from "./groups";
import type { StoredMessage } from "./store";

const db: StoredMessage[] = [];
vi.mock("./store", () => ({
  initStore: vi.fn(async () => undefined),
  saveMessage: vi.fn(async (m: StoredMessage) => void db.push(m)),
  getMessages: vi.fn(async (chatId: string, sinceTs = 0) =>
    db.filter((m) => m.chatId === chatId && m.ts >= sinceTs),
  ),
  getGroupChatIds: vi.fn(async () => [...new Set(db.filter((m) => m.chatId.endsWith("@g.us")).map((m) => m.chatId))]),
}));

vi.mock("./llm", () => ({
  complete: vi.fn(async (prompt: string) => (prompt.includes("TRANSCRIPT") ? "AI-DIGEST" : "AI-ANSWER")),
}));

import { normalize } from "./waha";
import { handleInbound } from "./bot";
import { runDigests } from "./schedule";

const DIR = "data/test-e2e";
const sent: Array<{ chatId: string; text: string }> = [];
const gw = { sendText: async (chatId: string, text: string) => void sent.push({ chatId, text }) };

let eventSeq = 0;
function wahaEvent(from: string, body: string, extra: Record<string, unknown> = {}) {
  return {
    event: "message",
    // Unique id per event — real WhatsApp messages always carry one; the inbound
    // dedup guard drops redeliveries, so fixtures must not reuse a single id.
    payload: { id: `e${++eventSeq}`, from, participant: "628110@c.us", notifyName: "Budi", body, timestamp: Math.floor(Date.now() / 1000), fromMe: false, ...extra },
  };
}

describe("phase 1 end-to-end", () => {
  beforeAll(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    writeFileSync(
      `${DIR}/groups.yaml`,
      `groups:
  - id: "site@g.us"
    name: Site A
    category: construction
    optIn: true
  - id: "office@g.us"
    name: Back Office
    category: office
    optIn: false
  - id: "mgmt@g.us"
    name: Management
    isManagement: true
`,
    );
    config.groupsFile = `${DIR}/groups.yaml`;
    config.scheduleStateFile = `${DIR}/state.json`;
    resetRegistryCache();
  });

  it("ingests monitored groups (scrubbed), drops unlisted, ignores chatter", async () => {
    await handleInbound(gw, normalize(wahaEvent("site@g.us", "slab poured, pay to 4111 1111 1111 1111"))!);
    await handleInbound(gw, normalize(wahaEvent("office@g.us", "invoices sent to the client"))!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await handleInbound(gw, normalize(wahaEvent("random@g.us", "hello?"))!);
    warn.mockRestore();

    expect(db.filter((m) => m.chatId === "random@g.us").length).toBe(0);
    const site = db.find((m) => m.chatId === "site@g.us")!;
    expect(site.text).toContain("[REDACTED-CARD]");
    expect(site.text).not.toContain("4111");
    expect(sent.length).toBe(0); // plain chatter -> no reply
  });

  it("answers each trigger kind: /command, @mention, reply-to-bot, DM", async () => {
    await handleInbound(gw, normalize(wahaEvent("site@g.us", "/ping"))!);
    expect(sent.at(-1)).toEqual({ chatId: "site@g.us", text: "pong" });

    await handleInbound(gw, normalize(wahaEvent("site@g.us", "@bot what was poured?"))!);
    expect(sent.at(-1)).toEqual({ chatId: "site@g.us", text: "AI-ANSWER" });

    await handleInbound(gw, normalize(wahaEvent("site@g.us", "yes that", { _data: { quotedMsg: { fromMe: true } } }))!);
    expect(sent.at(-1)).toEqual({ chatId: "site@g.us", text: "AI-ANSWER" });

    await handleInbound(gw, normalize(wahaEvent("628110@c.us", "status of site A?"))!);
    expect(sent.at(-1)).toEqual({ chatId: "628110@c.us", text: "AI-ANSWER" });

    expect(db.filter((m) => m.fromBot).length).toBe(4); // every bot reply persisted
  });

  it("runs the scheduled digest: opt-in group + categorized management digest", async () => {
    sent.length = 0;
    const res = await runDigests(gw, "evening");
    expect(res.perGroup.map((g) => g.chatId).sort()).toEqual(["office@g.us", "site@g.us"]);

    expect(sent.filter((s) => s.chatId === "site@g.us").length).toBe(1); // optIn
    expect(sent.filter((s) => s.chatId === "office@g.us").length).toBe(0);

    const mgmt = sent.find((s) => s.chatId === "mgmt@g.us")!;
    expect(mgmt.text).toContain("Work Digest — evening");
    expect(mgmt.text).toContain("Site A");
    expect(mgmt.text).toContain("Back Office");
    expect(mgmt.text).toContain("AI-DIGEST");
  });

  it("the next slot's window starts where this one ended (gap-safe)", async () => {
    sent.length = 0;
    const res = await runDigests(gw, "evening"); // nothing new since the last run
    expect(res.perGroup.length).toBe(0);
    expect(sent.length).toBe(0);
  });
});
