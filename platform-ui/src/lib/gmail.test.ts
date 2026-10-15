import { describe, it, expect } from "vitest";
import {
  bareAddress, clientContactEmail, composeHref, gmailErrorText, normalizeStatus, normalizeThread, normalizeThreadList, replyDraft,
  replySubject, splitAddresses, threadsPath, validateCompose, waitText, SIMULATED_LABEL,
} from "./gmail";
import { YOU_ROWS } from "./workspaces";
import { areaFor } from "./areas";

// DW-8j UI: the pure half of email through your own Gmail (BFF §48): shapes, sentences, compose rules, the reply prefill and the registry row.

describe("the You block's Inbox row", () => {
  it("keeps the label Inbox and has two tabs: Notifications and Mail", () => {
    const row = YOU_ROWS.find((r) => r.key === "inbox");
    expect(row?.label).toBe("Inbox");
    expect(row?.tabs.map((t) => [t.label, t.href])).toEqual([["Notifications", "/me/inbox"], ["Mail", "/me/mail"]]);
  });
  it("puts the mail pages in the personal area", () => {
    for (const p of ["/me/mail", "/me/mail/abc", "/me/mail/new"]) expect(areaFor(p)).toEqual({ kind: "personal" });
  });
});

describe("normalizers", () => {
  it("reads the status, and a refused shape is null", () => {
    expect(normalizeStatus({ configured: true, connected: true, needsReconnect: false, accountEmail: "a@b.test", mode: "simulated" }))
      .toEqual({ configured: true, connected: true, needsReconnect: false, accountEmail: "a@b.test", mode: "simulated" });
    expect(normalizeStatus({ configured: false, connected: true, mode: "live" })?.connected).toBe(false);
    expect(normalizeStatus({ nope: 1 })).toBeNull();
  });
  it("keeps a thread list's rows and its next page token", () => {
    const r = normalizeThreadList({ mode: "simulated", threads: [{ id: "t1", snippet: "s", subject: "Hi", from: "a@b.test", lastMessageDate: "2026-10-12T00:00:00Z", unread: true }], nextPageToken: "p2" });
    expect(r?.threads[0]).toMatchObject({ id: "t1", unread: true });
    expect(r?.nextPageToken).toBe("p2");
    expect(normalizeThreadList({ threads: "x" })).toBeNull();
  });
  it("keeps attachment names and sizes and no content", () => {
    const t = normalizeThread({ mode: "simulated", id: "t1", messages: [{ id: "m1", from: "a@b.test", to: "c@d.test", subject: "S", date: "d", text: "hello", html: null, attachments: [{ attachmentId: "x", filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 5, data: "SECRET" }] }] });
    expect(t?.messages[0].attachments).toEqual([{ filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 5 }]);
    expect(JSON.stringify(t)).not.toContain("SECRET");
  });
});

describe("gmailErrorText", () => {
  it("maps the tokens to sentences, from `reason` or the start of `error`", () => {
    expect(gmailErrorText({ status: 409, reason: "gmail_not_connected" })).toMatch(/Connect your Gmail/);
    expect(gmailErrorText({ status: 409, error: "gmail_needs_reconnect" })).toMatch(/Reconnect your Gmail/);
    expect(gmailErrorText({ status: 502, error: "gmail_unavailable" })).toBe("Gmail can't be reached right now.");
  });
  it("names the wait on a send rate limit", () => {
    expect(gmailErrorText({ status: 429, reason: "gmail_send_rate_limited", retryAfterSeconds: 600 })).toMatch(/10 minutes/);
    expect(gmailErrorText({ status: 429, reason: "gmail_send_rate_limited", retryAfterSeconds: 45 })).toMatch(/45 seconds/);
    expect(waitText(undefined)).toBe("a little while");
  });
  it("names the field on a send validation failure", () => {
    expect(gmailErrorText({ status: 400, reason: "gmail_send_invalid", field: "subject" })).toMatch(/Subject/);
  });
  it("says a 403 plainly and never calls an outage anything but an outage", () => {
    expect(gmailErrorText({ status: 403 })).toBe("Your role has no mailbox here.");
    expect(gmailErrorText({ status: 502 })).toBe("Gmail can't be reached right now.");
  });
});

describe("compose", () => {
  const ok = { to: "a@b.test", cc: "", subject: "Hello", body: "Text" };
  it("accepts a valid message", () => expect(validateCompose(ok)).toEqual({}));
  it("refuses no recipient, a bad address, a display name and a comma-less list", () => {
    expect(validateCompose({ ...ok, to: "" }).to).toMatch(/at least one/);
    expect(validateCompose({ ...ok, to: "nope" }).to).toMatch(/not a valid/);
    expect(validateCompose({ ...ok, to: "A <a@b.test>" }).to).toMatch(/not a valid/);
    expect(validateCompose({ ...ok, cc: "x" }).cc).toMatch(/not a valid/);
  });
  it("refuses an empty subject, a long subject, an empty body and more than 20 recipients", () => {
    expect(validateCompose({ ...ok, subject: " " }).subject).toBeTruthy();
    expect(validateCompose({ ...ok, subject: "x".repeat(301) }).subject).toBeTruthy();
    expect(validateCompose({ ...ok, body: "" }).body).toBeTruthy();
    const many = Array.from({ length: 21 }, (_, i) => `u${i}@b.test`).join(",");
    expect(validateCompose({ ...ok, to: many }).to).toMatch(/at most 20/);
  });
  it("splits addresses on commas, semicolons and lines", () => {
    expect(splitAddresses("a@b.test, c@d.test;e@f.test\ng@h.test")).toHaveLength(4);
  });
});

describe("reply prefill", () => {
  const msg = (id: string, from: string, to: string, subject = "Kickoff") => ({ id, threadId: "t1", labelIds: [], from, to, cc: null, subject, date: "d", text: "x", html: null, attachments: [] });
  it("answers the sender, threads on the last message, and says Re: once", () => {
    const d = replyDraft({ mode: "simulated", id: "t1", messages: [msg("m1", "Dewi <dewi@n.test>", "me@x.test")] }, "me@x.test");
    expect(d).toEqual({ to: "dewi@n.test", subject: "Re: Kickoff", inReplyTo: { threadId: "t1", messageId: "m1" } });
    expect(replySubject("Re: Kickoff")).toBe("Re: Kickoff");
  });
  it("answers who we wrote to when the last message is ours", () => {
    const d = replyDraft({ mode: "simulated", id: "t1", messages: [msg("m1", "me@x.test", "dewi@n.test, z@n.test")] }, "me@x.test");
    expect(d?.to).toBe("dewi@n.test");
  });
  it("reads a bare address out of a header", () => expect(bareAddress("A B <a@b.test>")).toBe("a@b.test"));
});

describe("links and paths", () => {
  it("builds the compose link with the client and the address", () => {
    expect(composeHref({ client: "c-1", to: "a@b.test" })).toBe("/me/mail/new?to=a%40b.test&client=c-1");
    expect(composeHref({})).toBe("/me/mail/new");
  });
  it("reads the primary contact address only when it is a real address", () => {
    expect(clientContactEmail({ email: " ops@n.test " })).toBe("ops@n.test");
    expect(clientContactEmail({ email: "—" })).toBeNull();
    expect(clientContactEmail(null)).toBeNull();
  });
  it("pages with the token", () => expect(threadsPath("co 1", "SENT", "p2")).toBe("/api/co%201/mail/me/threads?label=SENT&pageToken=p2"));
  it("has the simulated label the ruling asks for", () => expect(SIMULATED_LABEL).toBe("Simulated mailbox: nothing is really sent"));
});
