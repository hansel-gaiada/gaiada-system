import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { config } from "./config";
import { resetRegistryCache } from "./groups";
import type { StoredMessage } from "./store";

const messagesByChat: Record<string, StoredMessage[]> = {};
vi.mock("./store", () => ({
  getGroupChatIds: vi.fn(async () => Object.keys(messagesByChat)),
  getMessages: vi.fn(async (chatId: string) => messagesByChat[chatId] ?? []),
  saveMessage: vi.fn(async () => undefined),
  initStore: vi.fn(async () => undefined),
}));

const summarizeChat = vi.fn(async (_msgs: StoredMessage[]) => "DIGEST");
vi.mock("./summarize", () => ({
  summarizeChat: (msgs: StoredMessage[]) => summarizeChat(msgs),
  answerQuestion: vi.fn(async () => "ANSWER"),
}));

import { runDigests } from "./schedule";

const DIR = "data/test-schedule";

function m(chatId: string, text: string): StoredMessage {
  return { chatId, senderId: "s", senderName: "S", waMessageId: "w", ts: Date.now() - 1000, text, fromBot: false };
}

function setupRegistry(): void {
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
  resetRegistryCache();
}

describe("runDigests (registry-driven delivery)", () => {
  let sent: Array<{ chatId: string; text: string }>;
  const gw = { sendText: async (chatId: string, text: string) => void sent.push({ chatId, text }) };

  beforeEach(() => {
    sent = [];
    summarizeChat.mockClear();
    summarizeChat.mockResolvedValue("DIGEST");
    for (const k of Object.keys(messagesByChat)) delete messagesByChat[k];
    rmSync(DIR, { recursive: true, force: true });
    config.databaseUrl = ""; // force file-mode schedule state (hermetic; ignore any .env DATABASE_URL)
    config.scheduleStateFile = `${DIR}/state.json`;
    config.managementGroupId = "";
    config.postToGroups = false;
    setupRegistry();
    messagesByChat["site@g.us"] = [m("site@g.us", "poured the slab")];
    messagesByChat["office@g.us"] = [m("office@g.us", "invoices sent")];
    messagesByChat["random@g.us"] = [m("random@g.us", "should be ignored")];
  });

  it("idempotent cron runs a slot at most once per day; a second fire is skipped (5a.8)", async () => {
    const first = await runDigests(gw, "noon", Date.now(), { idempotent: true });
    expect(first.skipped).toBeFalsy();
    expect(first.perGroup.length).toBeGreaterThan(0);
    const second = await runDigests(gw, "noon", Date.now(), { idempotent: true });
    expect(second.skipped).toBe(true);
    expect(second.perGroup).toEqual([]);
    // A different slot the same day still runs.
    const evening = await runDigests(gw, "evening", Date.now(), { idempotent: true });
    expect(evening.skipped).toBeFalsy();
  });

  it("delivers opt-in group digest, skips non-opt-in, sends categorized combined to management", async () => {
    const res = await runDigests(gw, "noon");
    expect(res.perGroup.map((g) => g.chatId).sort()).toEqual(["office@g.us", "site@g.us"]);

    const toSite = sent.filter((s) => s.chatId === "site@g.us");
    const toOffice = sent.filter((s) => s.chatId === "office@g.us");
    expect(toSite.length).toBe(1); // optIn: true
    expect(toOffice.length).toBe(0); // optIn: false

    const toMgmt = sent.filter((s) => s.chatId === "mgmt@g.us");
    expect(toMgmt.length).toBe(1);
    expect(toMgmt[0].text).toContain("Site A"); // names, not raw chat ids
    expect(toMgmt[0].text).toContain("Back Office");
    expect(toMgmt[0].text).toContain("construction"); // category headings
    expect(toMgmt[0].text).toContain("office");
    expect(toMgmt[0].text).not.toContain("random@g.us"); // unlisted group excluded
  });

  it("a summarizer failure becomes a placeholder for that group; others still deliver", async () => {
    summarizeChat.mockImplementation(async (msgs: StoredMessage[]) => {
      if (msgs[0]?.chatId === "site@g.us") throw new Error("model down");
      return "DIGEST";
    });
    await runDigests(gw, "noon");
    const toMgmt = sent.find((s) => s.chatId === "mgmt@g.us");
    expect(toMgmt?.text).toContain("digest unavailable");
    expect(toMgmt?.text).toContain("DIGEST"); // office digest still present
  });

  it("a per-group send failure does not stop the management digest", async () => {
    const flaky = {
      sendText: async (chatId: string, text: string) => {
        if (chatId === "site@g.us") throw new Error("send failed");
        sent.push({ chatId, text });
      },
    };
    await runDigests(flaky, "noon");
    expect(sent.some((s) => s.chatId === "mgmt@g.us")).toBe(true);
  });

  it("without a registry file, falls back to all stored groups + env management id", async () => {
    config.groupsFile = `${DIR}/missing.yaml`;
    config.managementGroupId = "envmgmt@g.us";
    resetRegistryCache();
    const res = await runDigests(gw, "evening");
    expect(res.perGroup.map((g) => g.chatId).sort()).toEqual(["office@g.us", "random@g.us", "site@g.us"]);
    expect(sent.some((s) => s.chatId === "envmgmt@g.us")).toBe(true);
  });
});
