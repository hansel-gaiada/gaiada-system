// Durable inbound intake — the crash window that used to lose real client messages.
//
// The old path answered 200 then processed detached, so a death in that gap lost the message
// permanently (WAHA never redelivers a 200). These tests pin the new contract:
//   1. the event is DURABLE before the webhook answers 200,
//   2. a crash after the ACK leaves it replayable, and the reconciler replays it,
//   3. a store that cannot persist gets a NON-2xx, so WAHA retries instead of dropping.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { config } from "./config";

const DIR = "data/test-intake";

// The bot's handleEvent is the thing that dies mid-processing in the scenarios below.
const handled: string[] = [];
let handleShouldThrow = false;
vi.mock("./bot", () => ({
  handleEvent: vi.fn(async (_gw: unknown, ev: { kind: string }) => {
    if (handleShouldThrow) throw new Error("simulated crash during processing");
    handled.push(ev.kind);
  }),
  handleInbound: vi.fn(async () => undefined),
}));

// The store module builds its FileStore at IMPORT time from config, so the temp paths must be
// set BEFORE these dynamic imports — setting them in beforeEach would be too late and the suite
// would quietly read/write the real data/ files.
config.databaseUrl = "";
config.messagesFile = `${DIR}/messages.json`;
config.inboundEventsFile = `${DIR}/inbound-events.json`;

const { recordInbound, processRecorded, reconcileInbound } = await import("./intake");
const { getPendingInboundEvents, resetStoreForTest } = await import("./store");

const gw = { sendText: async () => undefined } as never;

function messageEvent(text: string, waMessageId: string) {
  return {
    kind: "message" as const,
    message: {
      chatId: "111@g.us",
      senderId: "628999@c.us",
      senderName: "Budi",
      waMessageId,
      ts: Date.now(),
      text,
      isGroup: true,
      fromMe: false,
      replyToBot: false,
      mentionedJids: [],
      media: null,
    },
  };
}

describe("durable inbound intake", () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    // Rebuild the store so its in-memory cache doesn't shadow the fresh temp dir.
    config.messagesFile = `${DIR}/messages.json`;
    config.inboundEventsFile = `${DIR}/inbound-events.json`;
    resetStoreForTest();
    handled.length = 0;
    handleShouldThrow = false;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(DIR, { recursive: true, force: true });
  });

  it("persists the event as pending BEFORE anything processes it", async () => {
    const id = await recordInbound(messageEvent("hello", "M1"));
    expect(id).toBeTruthy();

    // This is the state the webhook ACKs in: durable, not yet processed.
    const pending = await getPendingInboundEvents(0);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe("message");
    expect(handled).toEqual([]); // nothing processed yet
  });

  it("round-trips the payload through encryption at rest", async () => {
    await recordInbound(messageEvent("secret plan", "M2"));
    const [row] = await getPendingInboundEvents(0);
    const payload = row?.payload as ReturnType<typeof messageEvent>;
    expect(payload.message.text).toBe("secret plan");
    expect(payload.message.waMessageId).toBe("M2");
  });

  it("a crash AFTER the ACK leaves the event replayable, and the reconciler replays it", async () => {
    // Webhook: persist, ACK... then the process dies before processing. Nothing marks it done.
    const id = await recordInbound(messageEvent("survive me", "M3"));
    expect(id).toBeTruthy();
    expect(handled).toEqual([]);

    // New process boots and sweeps with minAge 0 (no in-flight work of its own).
    const replayed = await reconcileInbound(gw, 0);
    expect(replayed).toBe(1);
    expect(handled).toEqual(["message"]); // the message was NOT lost

    // ...and it is settled, so a second sweep is a no-op (no infinite replay).
    expect(await getPendingInboundEvents(0)).toHaveLength(0);
    expect(await reconcileInbound(gw, 0)).toBe(0);
  });

  it("marks a row done after successful processing so it is never replayed", async () => {
    const id = await recordInbound(messageEvent("ok", "M4"));
    await processRecorded(gw, id!, messageEvent("ok", "M4"));
    expect(handled).toEqual(["message"]);
    expect(await getPendingInboundEvents(0)).toHaveLength(0);
  });

  it("a poison event is marked failed, not retried forever", async () => {
    const id = await recordInbound(messageEvent("poison", "M5"));
    handleShouldThrow = true;
    await processRecorded(gw, id!, messageEvent("poison", "M5")); // must not throw
    // Failed rows are out of the pending set: an operator can see them, the reconciler won't loop.
    expect(await getPendingInboundEvents(0)).toHaveLength(0);
    expect(await reconcileInbound(gw, 0)).toBe(0);
  });

  it("recordInbound returns null when the store cannot persist (caller must NOT ack 200)", async () => {
    // Stand in for a store outage with a path whose PARENT is a regular file: mkdirSync then
    // fails EEXIST on both Windows and POSIX (a NUL-byte path is tolerated on Windows).
    writeFileSync(`${DIR}/blocker`, "not a directory");
    config.inboundEventsFile = `${DIR}/blocker/inbound-events.json`;
    resetStoreForTest();

    const id = await recordInbound(messageEvent("nope", "M6"));
    expect(id).toBeNull(); // the webhook MUST answer non-2xx so WAHA redelivers
  });

  it("minAgeMs shields a row that is still legitimately in flight", async () => {
    await recordInbound(messageEvent("in flight", "M7"));
    // A large minAge means "only rows older than this" — the fresh row is skipped, so the
    // periodic sweep cannot double-process something the inline path is still working on.
    expect(await reconcileInbound(gw, 60_000)).toBe(0);
    expect(handled).toEqual([]);
    // With no age floor (boot sweep) it is picked up.
    expect(await reconcileInbound(gw, 0)).toBe(1);
  });

  it("session events carry no PII axes and still persist", async () => {
    const id = await recordInbound({ kind: "session", session: "default", status: "WORKING", ts: Date.now() });
    expect(id).toBeTruthy();
    const [row] = await getPendingInboundEvents(0);
    expect(row?.kind).toBe("session");
  });
});
