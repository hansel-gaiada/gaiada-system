import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { config } from "./config";
import { resetRegistryCache, setIgnored } from "./groups";
import { setPostToGroups } from "./safety/post-toggle";
import { resetDigestHistoryCache, digestHistory } from "./digest-history";
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

import { runDigests, startDigestRun, isDigestRunInFlight, resetDigestRunGuardForTest } from "./schedule";
import { getMessages } from "./store";

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
    resetDigestRunGuardForTest();
    for (const k of Object.keys(messagesByChat)) delete messagesByChat[k];
    rmSync(DIR, { recursive: true, force: true });
    config.databaseUrl = ""; // force file-mode schedule state (hermetic; ignore any .env DATABASE_URL)
    config.scheduleStateFile = `${DIR}/state.json`;
    config.digestHistoryFile = `${DIR}/digest-history.json`;
    resetDigestHistoryCache();
    config.managementGroupId = "";
    config.postToGroups = false;
    setPostToGroups(false); // A2: runtime toggle, independent of config.postToGroups after boot
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

  it("A2: in trial mode (no registry), the postToGroups runtime toggle gates per-group posting", async () => {
    config.groupsFile = `${DIR}/missing.yaml`;
    config.managementGroupId = "envmgmt@g.us";
    resetRegistryCache();

    setPostToGroups(false);
    const off = await runDigests(gw, "noon");
    expect(off.perGroup.length).toBeGreaterThan(0);
    expect(sent.some((s) => s.chatId === "site@g.us" || s.chatId === "office@g.us" || s.chatId === "random@g.us")).toBe(false);

    sent = [];
    setPostToGroups(true);
    const on = await runDigests(gw, "evening");
    expect(on.perGroup.length).toBeGreaterThan(0);
    expect(sent.some((s) => s.chatId === "site@g.us")).toBe(true);
    expect(sent.some((s) => s.chatId === "office@g.us")).toBe(true);
    expect(sent.some((s) => s.chatId === "random@g.us")).toBe(true);
  });

  it("1a: an ignored group is skipped in registry mode (excluded from perGroup + never sent to)", async () => {
    setIgnored("site@g.us", true);
    const res = await runDigests(gw, "noon");
    expect(res.perGroup.map((g) => g.chatId)).toEqual(["office@g.us"]);
    expect(sent.some((s) => s.chatId === "site@g.us")).toBe(false);
  });

  it("1a: an ignored group is skipped in trial mode too (no registry)", async () => {
    config.groupsFile = `${DIR}/missing.yaml`;
    resetRegistryCache();
    setIgnored("random@g.us", true);
    const res = await runDigests(gw, "noon");
    expect(res.perGroup.map((g) => g.chatId).sort()).toEqual(["office@g.us", "site@g.us"]);
  });

  it("1b: records one history entry per run — scheduled path (idempotent) vs manual", async () => {
    await runDigests(gw, "noon", Date.now(), { idempotent: true });
    let history = digestHistory();
    expect(history).toHaveLength(1);
    // registry mode: site@g.us's opt-in postback (optIn:true) + the combined management send
    // (registry's isManagement:true group wins over config.managementGroupId) both succeed.
    expect(history[0]).toMatchObject({ slot: "noon", trigger: "scheduled", groupsCovered: 2, delivered: 2, failed: 0 });
    expect(history[0].error).toBeUndefined();

    await runDigests(gw, "evening"); // manual/admin path — no opts
    history = digestHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ slot: "evening", trigger: "manual" }); // newest-first
  });

  it("1b: a skipped (already-claimed) idempotent run does NOT add a duplicate history entry", async () => {
    await runDigests(gw, "noon", Date.now(), { idempotent: true });
    await runDigests(gw, "noon", Date.now(), { idempotent: true }); // claim already taken -> skipped
    expect(digestHistory()).toHaveLength(1);
  });

  it("1b: a send failure is reflected in failed/delivered counts and the error field", async () => {
    const flaky = {
      sendText: async (chatId: string, text: string) => {
        if (chatId === "site@g.us") throw new Error("send failed");
        sent.push({ chatId, text });
      },
    };
    await runDigests(flaky, "noon");
    const [entry] = digestHistory();
    expect(entry.failed).toBeGreaterThanOrEqual(1);
    expect(entry.managementDelivered).toBe(true); // management send still succeeded
    expect(entry.error).toContain("send failed");
  });

  // Async admin trigger (POST /admin/digests/run/:slot) — overlap guard + unhandled-rejection safety.
  it("startDigestRun marks a slot in-flight synchronously and refuses an overlapping run of the same slot", async () => {
    const first = startDigestRun(gw, "noon");
    expect(first.started).toBe(true);
    expect(isDigestRunInFlight("noon")).toBe(true);

    // Same slot, still in flight -> refused, not a second concurrent sweep (would double-post).
    const second = startDigestRun(gw, "noon");
    expect(second.started).toBe(false);
    expect(isDigestRunInFlight("noon")).toBe(true); // unchanged by the refused attempt

    // A different slot is a separate guard.
    const evening = startDigestRun(gw, "evening");
    expect(evening.started).toBe(true);

    await vi.waitFor(() => expect(isDigestRunInFlight("noon")).toBe(false));
    await vi.waitFor(() => expect(isDigestRunInFlight("evening")).toBe(false));
    // The detached run actually ran to completion and recorded history, same as a direct call.
    expect(digestHistory().filter((h) => h.trigger === "manual")).toHaveLength(2);
  });

  it("a failure that escapes runDigests entirely is caught and recorded to history, never an unhandled rejection", async () => {
    // getMessages throwing (rather than a per-group summarize failure, which runDigests already
    // swallows into a placeholder) escapes the loop entirely — exactly the case startDigestRun
    // must catch so it never becomes an unhandled rejection in the detached promise.
    vi.mocked(getMessages).mockImplementationOnce(async () => {
      throw new Error("store exploded");
    });

    const { started } = startDigestRun(gw, "noon");
    expect(started).toBe(true);

    await vi.waitFor(() => expect(isDigestRunInFlight("noon")).toBe(false));
    const [entry] = digestHistory();
    expect(entry.slot).toBe("noon");
    expect(entry.trigger).toBe("manual");
    expect(entry.groupsCovered).toBe(0);
    expect(entry.error).toContain("store exploded");
  });
});
