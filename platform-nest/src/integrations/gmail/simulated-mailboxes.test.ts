// DW-8j (§48.1) — the simulated mailboxes: per-person Sent in process memory; a reply keeps the thread; nothing leaves the box.
// (The MAIL-16D contract suite runs against the same client in fixture-client.contract.test.ts, with the new send cases.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailInvalidMessageError, GmailNotFoundError } from "./errors";
import { SIMULATED_SENT_CAP } from "./fixture-client";
import { SIMULATED_MAILBOX_CAP, SimulatedMailboxes } from "./simulated-mailboxes";

const ME = "11111111-1111-1111-1111-111111111111";
const YOU = "22222222-2222-2222-2222-222222222222";
const send = { to: ["client@example.test"], subject: "Subject A", body: "Body A" };

let boxes: SimulatedMailboxes;
beforeEach(() => {
  boxes = new SimulatedMailboxes();
});

describe("a simulated mailbox holds a per-person Sent in memory", () => {
  it("a sent message lands in that person's SENT list and is readable by id, from the account", async () => {
    const mine = boxes.clientFor(ME, "me@simulated.invalid");
    const out = await mine.sendMessage({ ...send, cc: ["cc@example.test"] });
    expect(boxes.sentCount(ME)).toBe(1);
    const page = await mine.listThreads(undefined, { label: "SENT" });
    expect(page.threads.map((t) => t.id)).toEqual([out.threadId]);
    expect(page.threads[0].labelIds).toEqual(["SENT"]);
    expect(page.threads[0].messageIds).toEqual([out.messageId]);
    const msg = await mine.getMessage(out.messageId);
    expect(msg.headers).toMatchObject({ from: "me@simulated.invalid", to: "client@example.test", cc: "cc@example.test", subject: "Subject A" });
    expect(msg.parts).toEqual([{ mimeType: "text/plain", body: "Body A" }]);
    expect(msg.attachments).toEqual([]);
  });

  it("is per person: nobody sees another person's Sent, by list, thread or message id", async () => {
    const mine = boxes.clientFor(ME, "me@simulated.invalid");
    const yours = boxes.clientFor(YOU, "you@simulated.invalid");
    const out = await mine.sendMessage(send);
    expect((await yours.listThreads(undefined, { label: "SENT" })).threads).toEqual([]);
    await expect(yours.getMessage(out.messageId)).rejects.toBeInstanceOf(GmailNotFoundError);
    await expect(yours.getThread(out.threadId)).rejects.toBeInstanceOf(GmailNotFoundError);
    expect(boxes.sentCount(YOU)).toBe(0);
    // a fresh client for the same person sees the same Sent (the list outlives one request)
    expect((await boxes.clientFor(ME, "me@simulated.invalid").listThreads(undefined, { label: "SENT" })).threads).toHaveLength(1);
  });

  it("a reply keeps the thread: same thread id, joins the INBOX thread it answered, and carries In-Reply-To and References", async () => {
    const mine = boxes.clientFor(ME, "me@simulated.invalid");
    const thread = await mine.getThread("t5");
    const last = thread.messages[thread.messages.length - 1];
    const out = await mine.sendMessage({ ...send, subject: "Re: kickoff", inReplyTo: { threadId: "t5", messageId: last.id } });
    expect(out.threadId).toBe("t5");

    const after = await mine.getThread("t5");
    expect(after.messages.map((m) => m.id)).toEqual([...thread.messages.map((m) => m.id), out.messageId]);
    const reply = await mine.getMessage(out.messageId);
    expect(reply.threadId).toBe("t5");
    expect(reply.headers.inReplyTo).toBe(`<${last.id}@fixture.invalid>`);
    expect(reply.headers.references).toContain(reply.headers.inReplyTo);

    // the INBOX row of that thread now lists the reply too; the SENT view has the thread once
    const inbox = await mine.listThreads(undefined, { label: "INBOX" });
    expect(inbox.threads.find((t) => t.id === "t5")!.messageIds).toContain(out.messageId);
    expect((await mine.listThreads(undefined, { label: "SENT" })).threads.map((t) => t.id)).toEqual(["t5"]);

    // another person's view of t5 is the untouched fixture
    expect((await boxes.clientFor(YOU, "you@simulated.invalid").getThread("t5")).messages).toHaveLength(thread.messages.length);
  });

  it("a reply to a message sent here keeps the sim thread and chains References", async () => {
    const mine = boxes.clientFor(ME, "me@simulated.invalid");
    const first = await mine.sendMessage(send);
    const second = await mine.sendMessage({ ...send, inReplyTo: { threadId: first.threadId, messageId: first.messageId } });
    expect(second.threadId).toBe(first.threadId);
    const third = await mine.sendMessage({ ...send, inReplyTo: { threadId: second.threadId, messageId: second.messageId } });
    const m3 = await mine.getMessage(third.messageId);
    expect(m3.headers.references!.split(" ")).toHaveLength(2); // the two ancestors of the third message
    expect((await mine.listThreads(undefined, { label: "SENT" })).threads[0].messageIds).toHaveLength(3);
  });

  it("refuses a reply to nothing, and to a message that is not in that thread, without sending", async () => {
    const mine = boxes.clientFor(ME, "me@simulated.invalid");
    await expect(mine.sendMessage({ ...send, inReplyTo: { threadId: "t5", messageId: "no-such-message" } })).rejects.toBeInstanceOf(GmailNotFoundError);
    await expect(mine.sendMessage({ ...send, inReplyTo: { threadId: "no-such-thread", messageId: "m5a" } })).rejects.toBeInstanceOf(GmailNotFoundError);
    await expect(mine.sendMessage({ ...send, inReplyTo: { threadId: "t4", messageId: "m5a" } })).rejects.toBeInstanceOf(GmailInvalidMessageError);
    expect(boxes.sentCount(ME)).toBe(0);
  });

  it("re-validates every send (a caller that skipped the service cannot smuggle a header)", async () => {
    const mine = boxes.clientFor(ME, "me@simulated.invalid");
    await expect(mine.sendMessage({ ...send, to: ["a@example.test\r\nBcc: x@example.test"] })).rejects.toBeInstanceOf(GmailInvalidMessageError);
    await expect(mine.sendMessage({ ...send, subject: "x\r\nBcc: y" })).rejects.toBeInstanceOf(GmailInvalidMessageError);
    expect(boxes.sentCount(ME)).toBe(0);
  });

  it("the SENT list pages with its own opaque token, newest thread first; an INBOX token is refused on SENT and a SENT token on INBOX", async () => {
    let t = 0;
    const mine = boxes.clientFor(ME, "me@simulated.invalid", { pageSize: 2, now: () => new Date(Date.UTC(2026, 9, 15, 10, 0, t++)) });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await mine.sendMessage({ ...send, subject: `S${i}` })).threadId);

    const seen: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const page = await mine.listThreads(token, { label: "SENT" });
      seen.push(...page.threads.map((x) => x.id));
      token = page.nextPageToken;
      pages++;
    } while (token && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());

    const sentTok = (await mine.listThreads(undefined, { label: "SENT" })).nextPageToken!;
    const inboxTok = (await mine.listThreads(undefined, { label: "INBOX" })).nextPageToken!;
    await expect(mine.listThreads(sentTok, { label: "INBOX" })).rejects.toBeInstanceOf(GmailNotFoundError);
    await expect(mine.listThreads(inboxTok, { label: "SENT" })).rejects.toBeInstanceOf(GmailNotFoundError);
    await expect(mine.listThreads("garbage", { label: "SENT" })).rejects.toBeInstanceOf(GmailNotFoundError);
  });

  it("the INBOX is the MAIL-16D fixture corpus (so a simulated mailbox has content before anything is sent)", async () => {
    const page = await boxes.clientFor(ME, "me@simulated.invalid").listThreads();
    expect(page.threads.length).toBeGreaterThan(0);
    expect(page.threads.map((t) => t.id)).toContain("t5");
  });

  it("one person's Sent is capped, dropping the oldest", async () => {
    const mine = boxes.clientFor(ME, "me@simulated.invalid");
    for (let i = 0; i < SIMULATED_SENT_CAP + 3; i++) await mine.sendMessage({ ...send, subject: `S${i}` });
    expect(boxes.sentCount(ME)).toBe(SIMULATED_SENT_CAP);
  });

  it("the number of mailboxes is capped, dropping the least recently used", async () => {
    for (let i = 0; i < SIMULATED_MAILBOX_CAP + 2; i++) await boxes.clientFor(`user-${i}`, "x@simulated.invalid").sendMessage(send);
    expect(boxes.mailboxCount()).toBe(SIMULATED_MAILBOX_CAP);
    expect(boxes.sentCount("user-0")).toBe(0);
    expect(boxes.sentCount(`user-${SIMULATED_MAILBOX_CAP + 1}`)).toBe(1);
  });

  it("clear(person) forgets one person's Sent (disconnect), clear() everyone's", async () => {
    await boxes.clientFor(ME, "a@simulated.invalid").sendMessage(send);
    await boxes.clientFor(YOU, "b@simulated.invalid").sendMessage(send);
    boxes.clear(ME);
    expect(boxes.sentCount(ME)).toBe(0);
    expect(boxes.sentCount(YOU)).toBe(1);
    boxes.clear();
    expect(boxes.mailboxCount()).toBe(0);
  });
});

describe("nothing leaves the box", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("a full session (list, read, send, reply) makes no network call at all", async () => {
    const spy = vi.fn(() => {
      throw new Error("the simulated mailbox tried to use the network");
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    const mine = boxes.clientFor(ME, "me@simulated.invalid");
    const page = await mine.listThreads(undefined, { label: "INBOX" });
    const thread = await mine.getThread(page.threads[0].id);
    await mine.getMessage(thread.messages[0].id);
    await mine.listLabels();
    const out = await mine.sendMessage({ ...send, inReplyTo: { threadId: thread.id, messageId: thread.messages[0].id } });
    await mine.listThreads(undefined, { label: "SENT" });
    await mine.getMessage(out.messageId);
    expect(spy).not.toHaveBeenCalled();
  });
});
