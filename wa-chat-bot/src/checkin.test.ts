import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InboundMessage } from "./waha";

const callHubTool = vi.fn(async (_t: string, _a: Record<string, unknown>, _e: unknown) => "{}");
vi.mock("./hub", async (importOriginal) => {
  const real = await importOriginal<typeof import("./hub")>();
  return {
    HubDeniedError: real.HubDeniedError,
    callHubTool: (t: string, a: Record<string, unknown>, e: unknown) => callHubTool(t, a, e),
  };
});

import { HubDeniedError } from "./hub";
import { composeCheckinReminder, tryCheckinReply } from "./checkin";
import { resetPendingCheckins, getPendingCheckin, putPendingCheckin } from "./checkin-reminder";

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    chatId: "628110@c.us",
    senderId: "628110@c.us",
    senderName: "Budi",
    waMessageId: "w1",
    ts: 1,
    text: "",
    isGroup: false,
    fromMe: false,
    replyToBot: false,
    mentionedJids: [],
    media: null,
    ...over,
  };
}

describe("composeCheckinReminder (TR-11)", () => {
  beforeEach(() => {
    resetPendingCheckins();
    callHubTool.mockReset();
  });

  it("fetches the prefill AS the recipient's own OBO envelope, stores pending state, and returns the reminder text", async () => {
    callHubTool.mockResolvedValueOnce(
      JSON.stringify({ date: "2026-07-31", alreadySubmitted: false, draft: { summaryText: "Logged 2h on Client Site." } }),
    );
    const text = await composeCheckinReminder("t1", "628110@c.us", 60_000);
    expect(callHubTool).toHaveBeenCalledWith("checkin.getToday", { tenantId: "t1" }, { provider: "whatsapp", externalId: "628110@c.us" });
    expect(text).toContain("Logged 2h on Client Site.");
    expect(text).toContain("2026-07-31");
    const pending = getPendingCheckin("628110@c.us");
    expect(pending).toEqual({ tenantId: "t1", prefillSummary: "Logged 2h on Client Site.", date: "2026-07-31" });
  });

  it("already submitted -> null, and no pending state is stored (idempotent: never re-nag a done day)", async () => {
    callHubTool.mockResolvedValueOnce(
      JSON.stringify({ date: "2026-07-31", alreadySubmitted: true, draft: { summaryText: "Logged 2h." } }),
    );
    const text = await composeCheckinReminder("t1", "628110@c.us", 60_000);
    expect(text).toBeNull();
    expect(getPendingCheckin("628110@c.us")).toBeNull();
  });

  it("propagates a HubDeniedError (unverified/unlinked identity) rather than swallowing it", async () => {
    callHubTool.mockRejectedValueOnce(new HubDeniedError("denied"));
    await expect(composeCheckinReminder("t1", "628110@c.us", 60_000)).rejects.toBeInstanceOf(HubDeniedError);
    expect(getPendingCheckin("628110@c.us")).toBeNull();
  });
});

describe("tryCheckinReply (TR-11)", () => {
  beforeEach(() => {
    resetPendingCheckins();
    callHubTool.mockReset();
  });

  it("no pending reminder for this chat -> false, no hub call", async () => {
    const gw = { sendText: vi.fn(async () => {}) };
    const handled = await tryCheckinReply(gw as any, msg(), "hello");
    expect(handled).toBe(false);
    expect(callHubTool).not.toHaveBeenCalled();
  });

  it("a bare confirm reply submits the STORED prefill summary (not the reply text) with source:'wa'", async () => {
    putPendingCheckin("628110@c.us", { tenantId: "t1", prefillSummary: "Logged 2h on Client Site.", date: "2026-07-31" }, 60_000);
    callHubTool.mockResolvedValueOnce(JSON.stringify({ date: "2026-07-31", status: "submitted" }));
    const gw = { sendText: vi.fn(async () => {}) };

    const handled = await tryCheckinReply(gw as any, msg(), "ok");
    expect(handled).toBe(true);
    expect(callHubTool).toHaveBeenCalledWith(
      "checkin.submit",
      { tenantId: "t1", summary: "Logged 2h on Client Site.", source: "wa" },
      { provider: "whatsapp", externalId: "628110@c.us" },
    );
    expect(gw.sendText).toHaveBeenCalledWith("628110@c.us", expect.stringContaining("recorded"));
    // single-use: the pending state is gone after one reply.
    expect(getPendingCheckin("628110@c.us")).toBeNull();
  });

  it("an edited reply submits the REPLY TEXT, not the prefill", async () => {
    putPendingCheckin("628110@c.us", { tenantId: "t1", prefillSummary: "Logged 2h on Client Site.", date: "2026-07-31" }, 60_000);
    callHubTool.mockResolvedValueOnce(JSON.stringify({ date: "2026-07-31", status: "submitted" }));
    const gw = { sendText: vi.fn(async () => {}) };

    await tryCheckinReply(gw as any, msg(), "Actually spent the day on client X, blocked on legal review.");
    expect(callHubTool).toHaveBeenCalledWith(
      "checkin.submit",
      { tenantId: "t1", summary: "Actually spent the day on client X, blocked on legal review.", source: "wa" },
      { provider: "whatsapp", externalId: "628110@c.us" },
    );
  });

  it("a HubDeniedError on submit replies with a denial message and still returns true (consumed)", async () => {
    putPendingCheckin("628110@c.us", { tenantId: "t1", prefillSummary: "x", date: "2026-07-31" }, 60_000);
    callHubTool.mockRejectedValueOnce(new HubDeniedError("denied"));
    const gw = { sendText: vi.fn(async () => {}) };

    const handled = await tryCheckinReply(gw as any, msg(), "ok");
    expect(handled).toBe(true);
    expect(gw.sendText).toHaveBeenCalledWith("628110@c.us", expect.stringContaining("verify"));
  });

  it("a second reply after consumption is NOT treated as a check-in reply (single-use)", async () => {
    putPendingCheckin("628110@c.us", { tenantId: "t1", prefillSummary: "x", date: "2026-07-31" }, 60_000);
    callHubTool.mockResolvedValueOnce(JSON.stringify({ date: "2026-07-31", status: "submitted" }));
    const gw = { sendText: vi.fn(async () => {}) };

    await tryCheckinReply(gw as any, msg(), "ok");
    callHubTool.mockClear();
    const secondHandled = await tryCheckinReply(gw as any, msg(), "another message");
    expect(secondHandled).toBe(false);
    expect(callHubTool).not.toHaveBeenCalled();
  });

  it("an empty edited reply is rejected with a helpful message, never submitted as a blank summary", async () => {
    putPendingCheckin("628110@c.us", { tenantId: "t1", prefillSummary: "x", date: "2026-07-31" }, 60_000);
    const gw = { sendText: vi.fn(async () => {}) };

    const handled = await tryCheckinReply(gw as any, msg(), "   ");
    expect(handled).toBe(true);
    expect(callHubTool).not.toHaveBeenCalled();
    expect(gw.sendText).toHaveBeenCalledWith("628110@c.us", expect.stringContaining("empty"));
  });
});
