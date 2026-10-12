// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// PV4-08 — the conversation write actions: what they send, and what they refuse before sending (§29a).
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: vi.fn() })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-1", name: "Example" })) }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1" })) };
});

import { platformFetch, PlatformError } from "./platform";
import { portalEditMessage, portalPostMessage, portalRetractMessage, portalStartConversation } from "./portalActions";
import { CONVERSATION_BODY_MAX, CONVERSATION_MAX_BYTES } from "./portal";

const fetchMock = vi.mocked(platformFetch);
const sent = () => JSON.parse(String(fetchMock.mock.calls[0][2]?.body));
const form = (fields: Record<string, string>, files: File[] = []) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  files.forEach((file) => f.append("attachments", file));
  return f;
};
const file = (name: string, size: number) => new File([new Uint8Array(size).fill(65)], name, { type: "text/plain" });

beforeEach(() => { fetchMock.mockReset(); });

describe("portalPostMessage", () => {
  it("posts only body (+ attachments) to the thread's messages route", async () => {
    fetchMock.mockResolvedValue({ id: "m1" });
    const r = await portalPostMessage(null, form({ threadId: "th1", body: "  Hello  ", authorSide: "staff", authorId: "x" }));
    expect(r).toEqual({ ok: true, id: "m1" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/portal/conversation/th1/messages");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(sent()).toEqual({ body: "Hello" });
  });

  it("sends files as base64 and refuses 6 files or >10 MB before calling the server", async () => {
    fetchMock.mockResolvedValue({ id: "m1" });
    await portalPostMessage(null, form({ threadId: "th1", body: "x" }, [file("a.txt", 3)]));
    expect(sent().attachments).toEqual([{ filename: "a.txt", contentType: "text/plain", content: Buffer.from("AAA").toString("base64") }]);

    fetchMock.mockClear();
    const six = await portalPostMessage(null, form({ threadId: "th1", body: "x" }, Array.from({ length: 6 }, (_, i) => file(`f${i}`, 1))));
    expect(six.ok).toBe(false);
    expect(six.field).toBe("attachments");
    const big = await portalPostMessage(null, form({ threadId: "th1", body: "x" }, [file("a", CONVERSATION_MAX_BYTES), file("b", 1)]));
    expect(big.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an empty body and one over 10,000 characters without calling the server", async () => {
    expect((await portalPostMessage(null, form({ threadId: "th1", body: "   " }))).ok).toBe(false);
    const long = await portalPostMessage(null, form({ threadId: "th1", body: "x".repeat(CONVERSATION_BODY_MAX + 1) }));
    expect(long.ok).toBe(false);
    expect(long.error).toMatch(/10,000/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a 409 means the thread was closed: said plainly, not a success", async () => {
    fetchMock.mockRejectedValue(new PlatformError(409, "thread is closed"));
    const r = await portalPostMessage(null, form({ threadId: "th1", body: "hi" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/closed/i);
  });
});

describe("portalStartConversation", () => {
  it("with a project: a new thread on it, subject and first message, no client id", async () => {
    fetchMock.mockResolvedValue({ threadId: "th9", messageId: "m1" });
    const r = await portalStartConversation(null, form({ projectId: "p1", clientId: "c1", subject: " Logo ", body: "Hi" }));
    expect(r).toEqual({ ok: true, id: "th9" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/portal/conversation");
    expect(sent()).toEqual({ projectId: "p1", subject: "Logo", body: "Hi" });
  });

  it("General (no project): sends clientId only to name the client", async () => {
    fetchMock.mockResolvedValue({ threadId: "th9", messageId: "m1" });
    await portalStartConversation(null, form({ projectId: "", clientId: "c2", body: "Hi" }));
    expect(sent()).toEqual({ clientId: "c2", body: "Hi" });
  });
});

describe("portalEditMessage / portalRetractMessage", () => {
  it("edit PATCHes the message; a 409 says the 15 minutes have passed", async () => {
    fetchMock.mockResolvedValue({ id: "m1", edited: true });
    expect(await portalEditMessage(null, form({ messageId: "m1", threadId: "th1", body: "fixed" }))).toEqual({ ok: true, id: "m1" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/portal/conversation/messages/m1");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("PATCH");
    fetchMock.mockRejectedValue(new PlatformError(409, "edit window closed"));
    const late = await portalEditMessage(null, form({ messageId: "m1", threadId: "th1", body: "fixed" }));
    expect(late.ok).toBe(false);
    expect(late.error).toMatch(/15 minutes/);
  });

  it("retract DELETEs the message; a 409 says the 15 minutes have passed", async () => {
    fetchMock.mockResolvedValue({ id: "m1", retracted: true });
    expect((await portalRetractMessage(null, form({ messageId: "m1", threadId: "th1" }))).ok).toBe(true);
    expect(fetchMock.mock.calls[0][2]?.method).toBe("DELETE");
    fetchMock.mockRejectedValue(new PlatformError(409, "window closed"));
    expect((await portalRetractMessage(null, form({ messageId: "m1", threadId: "th1" }))).error).toMatch(/15 minutes/);
  });
});
