// DW-8j (§48.1) — the LIVE Gmail adapter, driven by a stubbed `fetch` (no network). It proves the mapping from Google's documented REST
// shapes to the seam's own, the RFC 5322 text that goes out, and the error taxonomy. It does NOT prove Google accepts any of it: that is the
// contract suite run against a real staging account at DW-11 (README honesty note).
import { describe, expect, it } from "vitest";
import { GmailApiClient, buildRawMessage, encodeSubject, type GmailFetch } from "./api-client";
import {
  GmailInvalidMessageError, GmailNotFoundError, GmailRateLimitedError, GmailRevokedError, GmailUnauthorizedError, GmailUnavailableError,
} from "./errors";

const TOKEN = "ya29.SECRET-ACCESS-TOKEN";
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
interface Call { url: URL; method: string; body: any; auth: string | undefined }

function stub(routes: Array<[RegExp, (c: Call) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }]>) {
  const calls: Call[] = [];
  const fetchImpl: GmailFetch = async (url, init) => {
    const call: Call = { url: new URL(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined, auth: init?.headers?.authorization };
    calls.push(call);
    for (const [re, h] of routes) {
      if (re.test(`${call.method} ${call.url.pathname}`)) {
        const r = h(call);
        const text = r.text ?? JSON.stringify(r.json ?? {});
        const headers = r.headers ?? {};
        return { status: r.status ?? 200, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => text };
      }
    }
    throw new Error(`unexpected request ${call.method} ${call.url.pathname}`);
  };
  return { calls, client: new GmailApiClient({ accessToken: TOKEN, fetchImpl, pageSize: 2 }) };
}
const gerr = (status: number, reason: string) => ({ status, json: { error: { code: status, message: "x", errors: [{ reason, message: "x" }] } } });

describe("reads", () => {
  it("listThreads: one list call (label, page size, token), then one minimal read per thread; the row carries ids, labels, last date", async () => {
    const { client, calls } = stub([
      [/^GET \/gmail\/v1\/users\/me\/threads$/, () => ({ json: { threads: [{ id: "a", snippet: "Tom &amp; Jerry&#39;s" }, { id: "b", snippet: "second" }], nextPageToken: "NEXT" } })],
      [/^GET \/gmail\/v1\/users\/me\/threads\/a$/, () => ({ json: { id: "a", messages: [{ id: "a1", labelIds: ["INBOX"], internalDate: "1785000000000" }, { id: "a2", labelIds: ["INBOX", "UNREAD"], internalDate: "1785000100000" }] } })],
      [/^GET \/gmail\/v1\/users\/me\/threads\/b$/, () => ({ json: { id: "b", messages: [{ id: "b1", labelIds: ["INBOX"], internalDate: "1784000000000" }] } })],
    ]);
    const page = await client.listThreads(undefined, { label: "SENT" });
    expect(calls[0].url.searchParams.get("labelIds")).toBe("SENT");
    expect(calls[0].url.searchParams.get("maxResults")).toBe("2");
    expect(calls[0].url.searchParams.has("pageToken")).toBe(false);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(page.nextPageToken).toBe("NEXT");
    expect(page.threads).toEqual([
      { id: "a", snippet: "Tom & Jerry's", labelIds: ["INBOX", "UNREAD"], messageIds: ["a1", "a2"], lastMessageDate: new Date(1785000100000).toISOString() },
      { id: "b", snippet: "second", labelIds: ["INBOX"], messageIds: ["b1"], lastMessageDate: new Date(1784000000000).toISOString() },
    ]);
    await client.listThreads("TOK");
    expect(calls.find((c) => c.url.searchParams.get("pageToken") === "TOK")!.url.searchParams.get("labelIds")).toBe("INBOX");
  });

  it("listThreads: a pageToken Google refuses (400) is not-found, like the contract's garbage token; no more pages leaves nextPageToken undefined", async () => {
    const bad = stub([[/threads$/, () => gerr(400, "invalid")]]);
    await expect(bad.client.listThreads("garbage")).rejects.toBeInstanceOf(GmailNotFoundError);
    const empty = stub([[/threads$/, () => ({ json: {} })]]);
    expect(await empty.client.listThreads()).toEqual({ threads: [], nextPageToken: undefined });
  });

  it("getThread: the message summaries, oldest first; an unknown thread is not-found", async () => {
    const { client } = stub([
      [/threads\/t1$/, () => ({ json: { id: "t1", messages: [{ id: "m1", labelIds: ["INBOX"], snippet: "hi", internalDate: "1785000000000" }] } })],
      [/threads\/nope$/, () => gerr(404, "notFound")],
    ]);
    const t = await client.getThread("t1");
    expect(t).toMatchObject({ id: "t1", labelIds: ["INBOX"], messages: [{ id: "m1", snippet: "hi", messageIds: ["m1"] }] });
    await expect(client.getThread("nope")).rejects.toBeInstanceOf(GmailNotFoundError);
  });

  it("getMessage: decodes the MIME tree (plain + html alternatives, nested), headers and attachment METADATA only", async () => {
    const { client } = stub([
      [/messages\/m1$/, () => ({
        json: {
          id: "m1", threadId: "t1", labelIds: ["INBOX"], internalDate: "1785000000000",
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "From", value: "a@example.test" }, { name: "to", value: "me@example.test" }, { name: "Subject", value: "Hello" },
              { name: "Cc", value: "c@example.test" }, { name: "In-Reply-To", value: "<p@x>" }, { name: "References", value: "<r@x> <p@x>" },
            ],
            parts: [
              { mimeType: "multipart/alternative", parts: [
                { mimeType: "text/plain", body: { size: 5, data: b64url("héllo") } },
                { mimeType: "text/html", body: { size: 12, data: b64url("<p>héllo</p>") } },
              ] },
              { mimeType: "application/pdf", filename: "a.pdf", body: { size: 321, attachmentId: "att-1", data: "SHOULD-NEVER-SURFACE" } },
            ],
          },
        },
      })],
    ]);
    const m = await client.getMessage("m1");
    expect(m.headers).toEqual({
      from: "a@example.test", to: "me@example.test", subject: "Hello", date: new Date(1785000000000).toISOString(),
      cc: "c@example.test", inReplyTo: "<p@x>", references: "<r@x> <p@x>",
    });
    expect(m.parts).toEqual([{ mimeType: "text/plain", body: "héllo" }, { mimeType: "text/html", body: "<p>héllo</p>" }]);
    expect(m.attachments).toEqual([{ attachmentId: "att-1", filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 321 }]);
    expect(JSON.stringify(m)).not.toContain("SHOULD-NEVER-SURFACE");
  });

  it("getMessage: a single-part message (the body on the payload itself)", async () => {
    const { client } = stub([[/messages\/m2$/, () => ({ json: { id: "m2", threadId: "t", internalDate: "1785000000000", payload: { mimeType: "text/plain", headers: [], body: { size: 2, data: b64url("hi") } } } })]]);
    expect((await client.getMessage("m2")).parts).toEqual([{ mimeType: "text/plain", body: "hi" }]);
  });

  it("listLabels maps system and user labels", async () => {
    const { client } = stub([[/labels$/, () => ({ json: { labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Clients", type: "user" }] } })]]);
    expect(await client.listLabels()).toEqual([{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Clients", type: "user" }]);
  });
});

describe("send", () => {
  it("sends a base64url RFC 5322 plain-text message; a new thread carries no threadId", async () => {
    const { client, calls } = stub([[/^POST .*\/messages\/send$/, () => ({ json: { id: "sent1", threadId: "newthread" } })]]);
    const out = await client.sendMessage({ to: ["a@example.test", "b@example.test"], cc: ["c@example.test"], subject: "Hello", body: "Line one\nLine two" });
    expect(out).toEqual({ messageId: "sent1", threadId: "newthread" });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.threadId).toBeUndefined();
    const raw = Buffer.from(calls[0].body.raw, "base64url").toString("utf8");
    const [head, bodyPart] = raw.split("\r\n\r\n");
    expect(head.split("\r\n")).toEqual([
      "To: a@example.test, b@example.test", "Cc: c@example.test", "Subject: Hello", "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64",
    ]);
    expect(Buffer.from(bodyPart.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Line one\r\nLine two");
    expect(JSON.stringify(calls[0].body)).not.toContain(TOKEN);
  });

  it("a reply reads the parent's Message-ID and References, sets In-Reply-To and References, and posts the threadId", async () => {
    const { client, calls } = stub([
      [/^GET .*\/messages\/p1$/, () => ({ json: { id: "p1", threadId: "t9", payload: { headers: [{ name: "Message-ID", value: "<abc@mail.example>" }, { name: "References", value: "<first@mail.example>" }] } } })],
      [/^POST .*\/messages\/send$/, () => ({ json: { id: "sent2", threadId: "t9" } })],
    ]);
    const out = await client.sendMessage({ to: ["a@example.test"], subject: "Re: x", body: "b", inReplyTo: { threadId: "t9", messageId: "p1" } });
    expect(out).toEqual({ messageId: "sent2", threadId: "t9" });
    const send = calls.find((c) => c.method === "POST")!;
    expect(send.body.threadId).toBe("t9");
    const head = Buffer.from(send.body.raw, "base64url").toString("utf8").split("\r\n\r\n")[0];
    expect(head).toContain("In-Reply-To: <abc@mail.example>");
    expect(head).toContain("References: <first@mail.example> <abc@mail.example>");
    expect(calls[0].url.searchParams.getAll("metadataHeaders")).toEqual(["Message-ID", "References"]);
  });

  it("refuses a reply whose parent is in another thread, has no usable Message-ID, or does not exist, and sends nothing", async () => {
    const wrong = stub([[/messages\/p1$/, () => ({ json: { id: "p1", threadId: "OTHER", payload: { headers: [{ name: "Message-ID", value: "<a@b>" }] } } })]]);
    await expect(wrong.client.sendMessage({ to: ["a@example.test"], subject: "s", body: "b", inReplyTo: { threadId: "t9", messageId: "p1" } })).rejects.toBeInstanceOf(GmailInvalidMessageError);
    const noId = stub([[/messages\/p1$/, () => ({ json: { id: "p1", threadId: "t9", payload: { headers: [] } } })]]);
    await expect(noId.client.sendMessage({ to: ["a@example.test"], subject: "s", body: "b", inReplyTo: { threadId: "t9", messageId: "p1" } })).rejects.toBeInstanceOf(GmailInvalidMessageError);
    const gone = stub([[/messages\/p1$/, () => gerr(404, "notFound")]]);
    await expect(gone.client.sendMessage({ to: ["a@example.test"], subject: "s", body: "b", inReplyTo: { threadId: "t9", messageId: "p1" } })).rejects.toBeInstanceOf(GmailNotFoundError);
    for (const s of [wrong, noId, gone]) expect(s.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("validates before any call (a header-injection address never reaches Google)", async () => {
    const { client, calls } = stub([]);
    await expect(client.sendMessage({ to: ["a@example.test\r\nBcc: v@example.test"], subject: "s", body: "b" })).rejects.toBeInstanceOf(GmailInvalidMessageError);
    expect(calls).toEqual([]);
  });

  it("Gmail refusing the message (400) is a send-invalid; a missing id in the answer is unavailable", async () => {
    const refused = stub([[/send$/, () => gerr(400, "invalidArgument")]]);
    await expect(refused.client.sendMessage({ to: ["a@example.test"], subject: "s", body: "b" })).rejects.toBeInstanceOf(GmailInvalidMessageError);
    const odd = stub([[/send$/, () => ({ json: {} })]]);
    await expect(odd.client.sendMessage({ to: ["a@example.test"], subject: "s", body: "b" })).rejects.toBeInstanceOf(GmailUnavailableError);
  });
});

describe("encoding", () => {
  it("an ASCII subject goes as is; a non-ASCII one becomes RFC 2047 encoded-words of at most 75 characters", () => {
    expect(encodeSubject("Hello world")).toBe("Hello world");
    const subject = "Réunion équipe — résumé 日本語のタイトル ".repeat(4);
    const enc = encodeSubject(subject);
    const words = enc.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(w.length).toBeLessThanOrEqual(75);
    }
    const back = words.map((w) => Buffer.from(w.slice("=?UTF-8?B?".length, -2), "base64").toString("utf8")).join("");
    expect(back).toBe(subject);
  });

  it("buildRawMessage wraps the base64 body at 76 columns and uses CRLF throughout", () => {
    const raw = buildRawMessage({ to: ["a@example.test"], subject: "s", body: "x".repeat(500) });
    expect(raw.includes("\n") && raw.replace(/\r\n/g, "").includes("\n")).toBe(false);
    for (const line of raw.split("\r\n").slice(-8)) expect(line.length).toBeLessThanOrEqual(76);
  });
});

describe("errors", () => {
  const run = (s: ReturnType<typeof gerr> | { status: number; json?: unknown; headers?: Record<string, string> }) =>
    stub([[/labels$/, () => s]]).client.listLabels();

  it("401 is unauthorized; a plain 403 is revoked; 403 with a quota reason, and 429, are rate-limited with a retry-after (default 60)", async () => {
    await expect(run(gerr(401, "authError"))).rejects.toBeInstanceOf(GmailUnauthorizedError);
    await expect(run(gerr(403, "insufficientPermissions"))).rejects.toBeInstanceOf(GmailRevokedError);
    await expect(run(gerr(403, "userRateLimitExceeded"))).rejects.toMatchObject({ status: 429, retryAfterSeconds: 60 });
    await expect(run({ status: 429, headers: { "retry-after": "12.5" }, json: {} })).rejects.toMatchObject({ status: 429, retryAfterSeconds: 13 });
    await expect(run({ status: 429, headers: { "retry-after": "bogus" }, json: {} })).rejects.toBeInstanceOf(GmailRateLimitedError);
  });

  it("a 5xx, an unexpected 4xx, a non-JSON body and a network failure are unavailable (an outage is never a revoked grant)", async () => {
    await expect(run({ status: 503, json: {} })).rejects.toBeInstanceOf(GmailUnavailableError);
    await expect(run({ status: 418, json: {} })).rejects.toBeInstanceOf(GmailUnavailableError);
    const html = stub([[/labels$/, () => ({ status: 502, text: "<html>bad gateway</html>" })]]);
    await expect(html.client.listLabels()).rejects.toBeInstanceOf(GmailUnavailableError);
    const down = new GmailApiClient({ accessToken: TOKEN, fetchImpl: async () => { throw new Error("ECONNRESET"); } });
    await expect(down.listLabels()).rejects.toBeInstanceOf(GmailUnavailableError);
  });

  it("no error ever carries the token, a header or a response body", async () => {
    for (const s of [gerr(401, "authError"), gerr(403, "insufficientPermissions"), gerr(403, "rateLimitExceeded"), { status: 500, json: { secret: "BODY-SECRET" } }]) {
      try {
        await run(s);
        expect.unreachable("should have thrown");
      } catch (e) {
        const dump = JSON.stringify({ m: (e as Error).message, d: (e as { detail?: unknown }).detail });
        expect(dump).not.toContain(TOKEN);
        expect(dump).not.toContain("BODY-SECRET");
        expect(dump.toLowerCase()).not.toContain("bearer");
      }
    }
  });
});
