import { describe, it, expect, vi, beforeEach } from "vitest";
import { readGmailStatus, readThread, readThreads } from "./gmail-data";

// DW-8j UI: the readers behind /me/mail. A refusal or a failure is DATA in words, never an empty mailbox.

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});
const reply = (status: number, body: unknown = {}) => vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify(body), { status }));

describe("the Gmail readers", () => {
  it("asks the status route for the active company and reads it", async () => {
    const f = reply(200, { configured: true, connected: true, needsReconnect: false, accountEmail: "a@b.test", mode: "simulated" });
    vi.stubGlobal("fetch", f);
    const r = await readGmailStatus("u", "co-1");
    expect(String(f.mock.calls[0][0])).toBe("http://p.test/api/co-1/integrations/gmail");
    expect(r).toEqual({ kind: "ok", data: { configured: true, connected: true, needsReconnect: false, accountEmail: "a@b.test", mode: "simulated" } });
  });

  it("reads a thread list with its label and page token", async () => {
    const f = reply(200, { mode: "simulated", threads: [], nextPageToken: null });
    vi.stubGlobal("fetch", f);
    const r = await readThreads("u", "co-1", "SENT", "p2");
    expect(String(f.mock.calls[0][0])).toBe("http://p.test/api/co-1/mail/me/threads?label=SENT&pageToken=p2");
    expect(r.kind).toBe("ok"); // an empty list here is evidence of an empty folder
  });

  it("403 is forbidden (a viewer has no mailbox), never an empty mailbox", async () => {
    vi.stubGlobal("fetch", reply(403, { error: "forbidden" }));
    expect(await readGmailStatus("u", "co-1")).toEqual({ kind: "forbidden" });
    expect(await readThreads("u", "co-1", "INBOX")).toEqual({ kind: "forbidden" });
  });

  it("409 gmail_not_connected says connect", async () => {
    vi.stubGlobal("fetch", reply(409, { error: "gmail_not_connected", reason: "gmail_not_connected" }));
    const r = await readThreads("u", "co-1", "INBOX");
    expect(r.kind === "unavailable" && r.reason).toMatch(/Connect your Gmail/);
  });

  it("409 gmail_needs_reconnect says reconnect", async () => {
    vi.stubGlobal("fetch", reply(409, { error: "gmail_needs_reconnect" }));
    const r = await readThread("u", "co-1", "t1");
    expect(r.kind === "unavailable" && r.reason).toMatch(/Reconnect your Gmail/);
  });

  it("502 gmail_unavailable is an outage, in the sentence the contract gives", async () => {
    vi.stubGlobal("fetch", reply(502, { error: "gmail_unavailable", reason: "gmail_unavailable" }));
    expect(await readThreads("u", "co-1", "INBOX")).toEqual({ kind: "unavailable", reason: "Gmail can't be reached right now." });
  });

  it("429 carries the wait", async () => {
    vi.stubGlobal("fetch", reply(429, { error: "gmail_rate_limited", reason: "gmail_rate_limited", retryAfterSeconds: 120 }));
    const r = await readThreads("u", "co-1", "INBOX");
    expect(r.kind === "unavailable" && r.reason).toMatch(/2 minutes/);
  });

  it("400 is a sentence about the request", async () => {
    vi.stubGlobal("fetch", reply(400, { error: "gmail_request_invalid", reason: "gmail_request_invalid", field: "label" }));
    const r = await readThreads("u", "co-1", "INBOX");
    expect(r.kind).toBe("unavailable");
  });

  it("an answer we cannot read is unavailable, not empty", async () => {
    vi.stubGlobal("fetch", reply(200, { threads: "nope" }));
    expect((await readThreads("u", "co-1", "INBOX")).kind).toBe("unavailable");
  });

  it("a network failure is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket"); }));
    expect(await readThreads("u", "co-1", "INBOX")).toEqual({ kind: "unavailable", reason: "Gmail can't be reached right now." });
  });
});
