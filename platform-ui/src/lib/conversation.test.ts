import { describe, it, expect } from "vitest";
import {
  MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_BODY_CHARS, THREAD_POLL_MS,
  attachmentsError, bodyError, canEditNow, conversationErrorText, draftedByNames, newClientMessages, pendingDrafts, sortThreads,
  splitLinks, threadScope, threadTitle, type StaffDraft, type StaffMessage,
} from "./conversation";

const thread = (over: Partial<Parameters<typeof sortThreads>[0][number]> & { id?: string }) => ({
  id: "t", awaitingReply: false, lastMessageAt: "2026-10-01T10:00:00Z", createdAt: "2026-09-01T00:00:00Z", ...over,
});

describe("sortThreads", () => {
  it("puts threads awaiting our reply first, then newest activity first", () => {
    const rows = [
      thread({ id: "old-quiet", lastMessageAt: "2026-10-01T10:00:00Z" }),
      thread({ id: "new-quiet", lastMessageAt: "2026-10-05T10:00:00Z" }),
      thread({ id: "old-waiting", awaitingReply: true, lastMessageAt: "2026-09-20T10:00:00Z" }),
      thread({ id: "new-waiting", awaitingReply: true, lastMessageAt: "2026-10-04T10:00:00Z" }),
    ];
    expect(sortThreads(rows).map((r) => r.id)).toEqual(["new-waiting", "old-waiting", "new-quiet", "old-quiet"]);
  });

  it("does not mutate its input, and falls back to createdAt when a thread has no message", () => {
    const rows = [thread({ id: "a", lastMessageAt: null, createdAt: "2026-10-09T00:00:00Z" }), thread({ id: "b", lastMessageAt: "2026-10-02T00:00:00Z" })];
    const copy = [...rows];
    expect(sortThreads(rows).map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows).toEqual(copy);
  });
});

describe("thread labels", () => {
  it("uses the subject, else the project, else General", () => {
    expect(threadTitle({ subject: " Hero copy ", general: false, projectName: "Site" })).toBe("Hero copy");
    expect(threadTitle({ subject: null, general: false, projectName: "Site" })).toBe("Site");
    expect(threadTitle({ subject: null, general: true, projectName: null })).toBe("General conversation");
    expect(threadScope({ general: true, projectName: null })).toBe("General");
    expect(threadScope({ general: false, projectName: "Site" })).toBe("Site");
  });
});

describe("canEditNow (the 15 minute window is the server's)", () => {
  const base = { mine: true, retracted: false };
  const now = Date.parse("2026-10-13T10:00:00Z");
  it("offers edit while the server's editableUntil is in the future", () => {
    expect(canEditNow({ ...base, editableUntil: "2026-10-13T10:05:00Z" }, now)).toBe(true);
  });
  it("does not once the window has passed, or when the server gave none", () => {
    expect(canEditNow({ ...base, editableUntil: "2026-10-13T09:59:59Z" }, now)).toBe(false);
    expect(canEditNow({ ...base, editableUntil: null }, now)).toBe(false);
  });
  it("never for someone else's message or a removed one", () => {
    expect(canEditNow({ mine: false, retracted: false, editableUntil: "2026-10-13T10:05:00Z" }, now)).toBe(false);
    expect(canEditNow({ mine: true, retracted: true, editableUntil: "2026-10-13T10:05:00Z" }, now)).toBe(false);
  });
});

describe("composer limits", () => {
  it("refuses an empty or oversize body", () => {
    expect(bodyError("   ")).toMatch(/write a message/i);
    expect(bodyError("x".repeat(MAX_BODY_CHARS))).toBeNull();
    expect(bodyError("x".repeat(MAX_BODY_CHARS + 1))).toMatch(/at most 10,000/);
  });
  it("allows 5 files and 10 MB in total, and no more", () => {
    const f = (size: number) => ({ name: "a", size });
    expect(attachmentsError(Array.from({ length: MAX_ATTACHMENTS }, () => f(1)))).toBeNull();
    expect(attachmentsError(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => f(1)))).toMatch(/at most 5/);
    expect(attachmentsError([f(MAX_ATTACHMENT_BYTES)])).toBeNull();
    expect(attachmentsError([f(MAX_ATTACHMENT_BYTES), f(1)])).toMatch(/10 MB/);
  });
  it("polls every 20 seconds", () => { expect(THREAD_POLL_MS).toBe(20_000); });
});

describe("splitLinks: plain text in, data out", () => {
  it("makes http and https links and leaves the rest as text", () => {
    expect(splitLinks("See https://example.com/a?b=1, then reply.")).toEqual([
      { type: "text", value: "See " },
      { type: "link", value: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { type: "text", value: ", then reply." },
    ]);
  });
  it("never makes a link from a javascript: or data: URL", () => {
    expect(splitLinks("javascript:alert(1) data:text/html,<b>x</b>")).toEqual([{ type: "text", value: "javascript:alert(1) data:text/html,<b>x</b>" }]);
  });
  it("keeps markup characters as text parts", () => {
    const parts = splitLinks('<img src=x onerror="alert(1)">');
    expect(parts).toEqual([{ type: "text", value: '<img src=x onerror="alert(1)">' }]);
  });
});

const msg = (over: Partial<StaffMessage>): StaffMessage => ({
  id: "m", threadId: "t", authorId: "u", authorName: "Dana", authorSide: "client", body: "hi", retracted: false, edited: false,
  editedAt: null, createdAt: "2026-10-13T10:00:00Z", editableUntil: null, mine: false, attachments: [], draftedBy: null, ...over,
});

describe("newClientMessages", () => {
  it("returns only new, un-retracted messages from the client", () => {
    const prev = [msg({ id: "1" })];
    const next = [msg({ id: "1" }), msg({ id: "2" }), msg({ id: "3", authorSide: "staff" }), msg({ id: "4", mine: true }), msg({ id: "5", retracted: true })];
    expect(newClientMessages(prev, next).map((m) => m.id)).toEqual(["2"]);
  });
});

const draft = (over: Partial<StaffDraft>): StaffDraft => ({
  id: "d", threadId: "t", body: "b", draftedBy: "a1", draftedByName: "Atlas", status: "pending", decidedBy: null, decidedAt: null,
  sentMessageId: null, createdAt: "2026-10-13T10:00:00Z", clientVisible: false, ...over,
});

describe("drafts", () => {
  it("lists pending drafts oldest first and maps sent drafts to the agent's name", () => {
    const ds = [
      draft({ id: "late", createdAt: "2026-10-13T11:00:00Z" }), draft({ id: "early", createdAt: "2026-10-13T09:00:00Z" }),
      draft({ id: "sent", status: "sent", sentMessageId: "m9" }), draft({ id: "gone", status: "discarded" }),
    ];
    expect(pendingDrafts(ds).map((d) => d.id)).toEqual(["early", "late"]);
    expect(draftedByNames(ds).get("m9")).toBe("Atlas");
  });
});

describe("conversationErrorText", () => {
  it("says a closed thread needs reopening", () => {
    expect(conversationErrorText(409, "this conversation is closed")).toMatch(/Reopen it/);
  });
  it("passes through an unknown server sentence", () => {
    expect(conversationErrorText(500, "boom")).toBe("boom");
  });
});
