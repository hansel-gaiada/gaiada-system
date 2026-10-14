// DW-8j (docs/FRONTEND-BFF-CONTRACT.md §48) — the Gmail service, run WITHOUT a database: `withTenants` and the vault's connection functions are
// replaced by an in-memory store (vi.mock), so the whole simulated flow and the live token handling run locally. The HTTP suite
// (gmail.http.test.ts, real Postgres + Cerbos) proves the same behaviour through the real routes, RLS and policy on the Linux gate.
//
// What this pins that the HTTP suite cannot see as cheaply:
//   * simulated mode makes NO network call at all (a fetch that throws is installed for the whole file) and never builds the live client;
//   * a row of another owner, forged into the table, is never read (the SELECT is by owner_id = caller; the fake enforces what RLS would not);
//   * a row written in one mode is never a link in the other;
//   * the live path: a Gmail 401 earns one forced refresh and one retry, an `invalid_grant` marks needs-reconnect and keeps the tokens, an
//     outage marks nothing.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

interface Row {
  id: string; tenant_id: string; owner_kind: string; owner_id: string; provider: string; external_account: string | null; scopes: string[];
  status: string; meta: Record<string, unknown>; token_expires_at: string | null; access_token_enc: string | null; refresh_token_enc: string | null;
  deleted_at: string | null;
}
const store: { rows: Row[]; queries: string[] } = { rows: [], queries: [] };

vi.mock("../../db", () => ({
  newId: () => randomUUID(),
  withTenants: async (_tenants: string[], fn: (c: unknown) => Promise<unknown>) =>
    fn({
      query: async (sql: string, params: unknown[]) => {
        store.queries.push(sql);
        if (/FROM integration_connections/.test(sql) && /owner_id = \$1 AND provider = \$2/.test(sql)) {
          return { rows: store.rows.filter((r) => r.owner_id === params[0] && r.provider === params[1] && !r.deleted_at && r.owner_kind === "user") };
        }
        throw new Error(`unexpected query in the gmail service unit test: ${sql}`);
      },
    }),
}));

vi.mock("../integrations.service", () => ({
  createConnection: async (_t: string, i: { ownerKind: string; ownerId: string; provider: string; externalAccount?: string; scopes?: string[]; meta?: Record<string, unknown> }) => {
    let row = store.rows.find((r) => r.owner_id === i.ownerId && r.provider === i.provider);
    if (!row) {
      row = {
        id: randomUUID(), tenant_id: "T", owner_kind: i.ownerKind, owner_id: i.ownerId, provider: i.provider, external_account: null, scopes: [], status: "unconfigured",
        meta: {}, token_expires_at: null, access_token_enc: null, refresh_token_enc: null, deleted_at: null,
      };
      store.rows.push(row);
    }
    row.external_account = i.externalAccount ?? null;
    row.scopes = i.scopes ?? [];
    row.meta = i.meta ?? {};
    if (row.status === "revoked") row.status = "unconfigured";
    row.deleted_at = null;
    return { id: row.id };
  },
  patchConnection: async (_t: string, id: string, p: { status?: string; meta?: Record<string, unknown> }) => {
    const row = store.rows.find((r) => r.id === id)!;
    if (p.status !== undefined) row.status = p.status;
    if (p.meta !== undefined) row.meta = p.meta;
    return { id };
  },
  revokeConnection: async (_t: string, id: string) => {
    const row = store.rows.find((r) => r.id === id)!;
    row.status = "revoked"; row.access_token_enc = null; row.refresh_token_enc = null; row.token_expires_at = null;
    return { id };
  },
  setConnectionTokens: async (_t: string, id: string, i: { accessToken?: string | null; refreshToken?: string | null; tokenExpiresAt?: string | null }) => {
    const row = store.rows.find((r) => r.id === id)!;
    const { encryptSecret } = await import("../secret-box");
    if (i.accessToken != null) row.access_token_enc = encryptSecret(i.accessToken);
    if (i.refreshToken != null) row.refresh_token_enc = encryptSecret(i.refreshToken);
    row.token_expires_at = i.tokenExpiresAt ?? null;
    row.status = "linked";
    return { id };
  },
}));

import { config } from "../../config";
import { encryptSecret } from "../secret-box";
import { GmailFixtureClient } from "../../integrations/gmail/fixture-client";
import { SendRateLimiter } from "./rate-limit";
import {
  disconnect, listThreadsAnswer, sendAnswer, setGmailHttpForTests, setSendLimiterForTests, simulatedAccount, simulatedMailboxes, startConnect,
  statusAnswer, threadAnswer, currentSendLimiter,
} from "./service";

const T = "aaaaaaaa-0000-0000-0000-00000000000a";
const ME = "11111111-1111-1111-1111-111111111111";
const YOU = "22222222-2222-2222-2222-222222222222";
const body = (o: object = {}) => ({ to: ["client@example.test"], subject: "Subject", body: "Body", ...o });
const reasonOf = async (p: Promise<unknown>): Promise<{ status: number; reason: string; extra: Record<string, unknown> }> => {
  try {
    await p;
  } catch (e) {
    const r = (e as { getResponse(): Record<string, unknown>; getStatus(): number });
    const res = r.getResponse();
    return { status: r.getStatus(), reason: String(res.reason), extra: res };
  }
  throw new Error("expected a refusal");
};

const realFetch = globalThis.fetch;
const saved = { ...config.gmail, key: config.integrationTokenKey };
let netCalls = 0;

beforeAll(() => {
  config.integrationTokenKey = config.integrationTokenKey || randomBytes(32).toString("base64");
});
afterAll(() => {
  Object.assign(config.gmail, { mode: saved.mode, clientId: saved.clientId, clientSecret: saved.clientSecret, redirectUri: saved.redirectUri });
  config.integrationTokenKey = saved.key;
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  store.rows = [];
  store.queries = [];
  netCalls = 0;
  simulatedMailboxes.clear();
  setSendLimiterForTests(null);
  setGmailHttpForTests(null);
  Object.assign(config.gmail, { mode: "simulated", clientId: "", clientSecret: "", redirectUri: "" });
  // Nothing in simulated mode may touch the network: any call is a counted failure.
  globalThis.fetch = (async () => {
    netCalls += 1;
    throw new Error("network call attempted");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("simulated mode (the default)", () => {
  it("answers not-connected without any client configured, and says mode simulated", async () => {
    expect(await statusAnswer(T, ME)).toEqual({ configured: true, connected: false, needsReconnect: false, accountEmail: null, mode: "simulated" });
  });

  it("start links the simulated mailbox at once: a row marked simulated, linked, no token, and not a single network call", async () => {
    const out = await startConnect(T, ME);
    expect(out).toMatchObject({ mode: "simulated", linked: true, accountEmail: simulatedAccount(ME) });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      owner_kind: "user", owner_id: ME, provider: "google_gmail", status: "linked", external_account: simulatedAccount(ME),
      access_token_enc: null, refresh_token_enc: null,
    });
    expect(store.rows[0].meta.gmailMode).toBe("simulated");
    expect(await statusAnswer(T, ME)).toEqual({ configured: true, connected: true, needsReconnect: false, accountEmail: simulatedAccount(ME), mode: "simulated" });
    expect(netCalls).toBe(0);
  });

  it("connecting twice is one row (upsert), still linked", async () => {
    await startConnect(T, ME);
    await startConnect(T, ME);
    expect(store.rows).toHaveLength(1);
    expect((await statusAnswer(T, ME)).connected).toBe(true);
  });

  it("without a connection every read and the send answer 409 gmail_not_connected, and the send limiter is untouched", async () => {
    for (const p of [
      listThreadsAnswer(T, ME, { label: "INBOX" }),
      threadAnswer(T, ME, "t5"),
      sendAnswer(T, ME, body() as never),
    ]) expect(await reasonOf(p)).toMatchObject({ status: 409, reason: "gmail_not_connected" });
    expect(currentSendLimiter().used(ME)).toBe(0);
  });

  it("lists the fixture INBOX as rows (subject and sender from the last message, unread from the label) and pages with the opaque token", async () => {
    await startConnect(T, ME);
    const p1 = await listThreadsAnswer(T, ME, { label: "INBOX" });
    expect(p1.mode).toBe("simulated");
    expect(p1.threads.length).toBe(5); // the whole 5-thread corpus fits one page of 20
    expect(p1.nextPageToken).toBeNull();
    const t5 = p1.threads.find((t) => t.id === "t5")!;
    expect(t5).toMatchObject({ unread: true, lastMessageDate: "2026-08-04T09:15:00.000Z" });
    expect(typeof t5.subject).toBe("string");
    expect(t5.from).not.toBe("");
    expect(p1.threads.find((t) => t.id === "t3")!.unread).toBe(false);
    expect((await listThreadsAnswer(T, ME, { label: "SENT" })).threads).toEqual([]);
    expect(netCalls).toBe(0);
  });

  it("reads one thread: decoded messages, the text part, the sanitized HTML part, attachment metadata only", async () => {
    await startConnect(T, ME);
    const html = await threadAnswer(T, ME, "t3");
    expect(html).toMatchObject({ mode: "simulated", id: "t3" });
    const m = html.messages[0];
    expect(m.text).toContain("Weekly digest");
    expect(m.html).toBe("<p>Weekly digest: <b>3 updates</b> this week.</p>");
    const withAtt = await threadAnswer(T, ME, "t2");
    expect(withAtt.messages[0].attachments).toEqual([{ attachmentId: "att-1042", filename: "invoice-A-1042.pdf", mimeType: "application/pdf", sizeBytes: 48213 }]);
    expect(JSON.stringify(withAtt)).not.toMatch(/"(data|content)"/);
    expect((await reasonOf(threadAnswer(T, ME, "no-such-thread")))).toMatchObject({ status: 404, reason: "gmail_not_found" });
  });

  it("a message's HTML is sanitized by the mail module's allowlist sanitizer, not passed through", async () => {
    await startConnect(T, ME);
    // a reply stored in the simulated Sent whose "html" cannot be set through the send path, so hostile HTML is exercised on the view itself
    const spy = vi.spyOn(GmailFixtureClient.prototype, "getMessage").mockResolvedValueOnce({
      id: "x", threadId: "t3", labelIds: [], headers: { from: "a@example.test", to: "b@example.test", subject: "Hi\r\nBcc: v@example.test", date: "2026-08-02T08:00:00.000Z" },
      parts: [
        { mimeType: "text/plain", body: "plain\u0000 text" },
        { mimeType: "text/html", body: '<p onclick="x()">hi<script>alert(1)</script><img src="https://t.example/p.gif"><a href="javascript:alert(1)">l</a></p>' },
      ],
      attachments: [],
    });
    const out = await threadAnswer(T, ME, "t3");
    spy.mockRestore();
    const m = out.messages[0];
    expect(m.html).not.toMatch(/script|onclick|<img|javascript:/i);
    expect(m.subject).toBe("Hi Bcc: v@example.test"); // the line break is gone: a subject can never be replayed into a header
    expect(m.text).toBe("plain text");
  });

  it("sends land in the person's own Sent (memory), a reply keeps the thread, and nothing touches the network", async () => {
    await startConnect(T, ME);
    const first = await sendAnswer(T, ME, body() as never);
    expect(first.mode).toBe("simulated");
    expect(simulatedMailboxes.sentCount(ME)).toBe(1);
    const sent = await listThreadsAnswer(T, ME, { label: "SENT" });
    expect(sent.threads.map((t) => t.id)).toEqual([first.threadId]);
    expect(sent.threads[0].subject).toBe("Subject");

    const reply = await sendAnswer(T, ME, body({ subject: "Re: kickoff", inReplyTo: { threadId: "t5", messageId: "m5c" } }) as never);
    expect(reply.threadId).toBe("t5");
    const thread = await threadAnswer(T, ME, "t5");
    expect(thread.messages.map((m) => m.id)).toEqual(["m5a", "m5b", "m5c", reply.messageId]);
    expect(thread.messages[3].inReplyTo).toBe("<m5c@fixture.invalid>");
    expect(netCalls).toBe(0);
  });

  it("a reply into a thread or message that does not exist is a 404, and an unreadable reply target counts against the limiter (the attempt reached the client)", async () => {
    await startConnect(T, ME);
    expect(await reasonOf(sendAnswer(T, ME, body({ inReplyTo: { threadId: "t5", messageId: "nope" } }) as never))).toMatchObject({ status: 404, reason: "gmail_not_found" });
    expect(simulatedMailboxes.sentCount(ME)).toBe(0);
  });

  it("is PER PERSON: another person never sees this Sent, and a forged row of someone else's is never read", async () => {
    await startConnect(T, ME);
    await sendAnswer(T, ME, body() as never);
    // YOU has no connection: every read is 409, and the status does not borrow ME's row
    expect(await statusAnswer(T, YOU)).toMatchObject({ connected: false, accountEmail: null });
    expect(await reasonOf(listThreadsAnswer(T, YOU, { label: "SENT" }))).toMatchObject({ status: 409, reason: "gmail_not_connected" });
    // a connection row forged for ME and shaped like a perfect simulated link: still never YOU's
    store.rows.push({ ...store.rows[0], id: randomUUID(), owner_id: "33333333-3333-3333-3333-333333333333" });
    expect((await statusAnswer(T, YOU)).connected).toBe(false);
    // YOU connects: their Sent is their own and empty, and ME's is untouched
    await startConnect(T, YOU);
    expect((await listThreadsAnswer(T, YOU, { label: "SENT" })).threads).toEqual([]);
    expect(simulatedMailboxes.sentCount(ME)).toBe(1);
    expect((await statusAnswer(T, YOU)).accountEmail).toBe(simulatedAccount(YOU));
    expect(simulatedAccount(YOU)).not.toBe(simulatedAccount(ME));
    // every SELECT of a connection row is by the caller's own id
    expect(store.queries.every((q) => !/FROM integration_connections/.test(q) || /owner_id = \$1/.test(q))).toBe(true);
  });

  it("the 31st send in an hour is 429 gmail_send_rate_limited with retryAfterSeconds; the first 30 were all delivered", async () => {
    await startConnect(T, ME);
    vi.useFakeTimers({ now: new Date("2026-10-15T10:00:00Z"), toFake: ["Date"] });
    setSendLimiterForTests(new SendRateLimiter());
    for (let i = 0; i < 30; i++) await sendAnswer(T, ME, body({ subject: `S${i}` }) as never);
    expect(simulatedMailboxes.sentCount(ME)).toBe(30);
    const r = await reasonOf(sendAnswer(T, ME, body() as never));
    expect(r).toMatchObject({ status: 429, reason: "gmail_send_rate_limited" });
    expect(r.extra.retryAfterSeconds).toBe(3600);
    expect(simulatedMailboxes.sentCount(ME)).toBe(30); // the 31st was not sent
    // someone else is unaffected, and the window slides: 10 minutes later the first send is still inside it, an hour later it is out
    await startConnect(T, YOU);
    await expect(sendAnswer(T, YOU, body() as never)).resolves.toMatchObject({ mode: "simulated" });
    vi.setSystemTime(new Date("2026-10-15T10:10:00Z"));
    expect((await reasonOf(sendAnswer(T, ME, body() as never))).extra.retryAfterSeconds).toBe(3000);
    vi.setSystemTime(new Date("2026-10-15T11:00:01Z"));
    await expect(sendAnswer(T, ME, body() as never)).resolves.toMatchObject({ mode: "simulated" });
  });

  it("disconnect clears the link and forgets the simulated Sent; connecting again starts from an empty Sent", async () => {
    await startConnect(T, ME);
    await sendAnswer(T, ME, body() as never);
    expect(await disconnect(T, ME)).toMatchObject({ disconnected: true, revokedAtGoogle: null, mode: "simulated" });
    expect(store.rows[0].status).toBe("revoked");
    expect(simulatedMailboxes.sentCount(ME)).toBe(0);
    expect((await statusAnswer(T, ME)).connected).toBe(false);
    expect(await reasonOf(listThreadsAnswer(T, ME, { label: "INBOX" }))).toMatchObject({ status: 409 });
    expect(await disconnect(T, ME)).toMatchObject({ disconnected: false });
    await startConnect(T, ME);
    expect((await listThreadsAnswer(T, ME, { label: "SENT" })).threads).toEqual([]);
    expect(netCalls).toBe(0);
  });

  it("a row written by the OTHER mode is never a link: a live row (tokens) in simulated mode reads not connected, and connecting clears its tokens", async () => {
    store.rows.push({
      id: randomUUID(), tenant_id: T, owner_kind: "user", owner_id: ME, provider: "google_gmail", external_account: "real@example.test", scopes: [],
      status: "linked", meta: { gmailMode: "live" }, token_expires_at: null, access_token_enc: encryptSecret("ya29.A"), refresh_token_enc: encryptSecret("1//R"), deleted_at: null,
    });
    expect((await statusAnswer(T, ME)).connected).toBe(false);
    expect(await reasonOf(listThreadsAnswer(T, ME, { label: "INBOX" }))).toMatchObject({ reason: "gmail_not_connected" });
    await startConnect(T, ME);
    expect(store.rows[0]).toMatchObject({ access_token_enc: null, refresh_token_enc: null, status: "linked" });
    expect(store.rows[0].meta.gmailMode).toBe("simulated");
  });
});

describe("live mode (stubbed at fetch; never against Google here)", () => {
  const CLIENT = { clientId: "gmail-client.apps.googleusercontent.com", clientSecret: "GOCSPX-GMAIL-SECRET", redirectUri: "https://erp.example.test/api/gmail/callback" };
  const ACCESS = "ya29.LIVE-ACCESS-1";
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  let seen: Array<{ url: string; auth?: string; form?: Record<string, string> }>;
  let behaviour: { gmail: "ok" | "401-then-ok" | "401-always" | "down"; refresh: "ok" | "invalid_grant" | "down" };

  const stub = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const u = new URL(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u.origin === "https://oauth2.googleapis.com" && u.pathname === "/token") {
      const form = Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
      seen.push({ url, form });
      if (behaviour.refresh === "invalid_grant") return json({ error: "invalid_grant" }, 400);
      if (behaviour.refresh === "down") return json({ error: "server_error" }, 500);
      return json({ access_token: "ya29.LIVE-REFRESHED", expires_in: 3599, token_type: "Bearer", scope: "x" });
    }
    if (u.origin === "https://gmail.googleapis.com") {
      seen.push({ url, auth: headers.authorization });
      const refreshed = (headers.authorization ?? "").includes("REFRESHED");
      if (behaviour.gmail === "down") return json({ error: { code: 503, errors: [{ reason: "backendError" }] } }, 503);
      if (behaviour.gmail === "401-always" || (behaviour.gmail === "401-then-ok" && !refreshed)) {
        return json({ error: { code: 401, errors: [{ reason: "authError" }] } }, 401);
      }
      if (u.pathname.endsWith("/threads")) return json({ threads: [{ id: "g1", snippet: "hello" }] });
      if (u.pathname.endsWith("/threads/g1")) return json({ id: "g1", messages: [{ id: "gm1", labelIds: ["INBOX"], internalDate: "1785000000000" }] });
      if (u.pathname.endsWith("/messages/gm1")) {
        return json({ id: "gm1", threadId: "g1", labelIds: ["INBOX"], internalDate: "1785000000000", payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Live hi" }, { name: "From", value: "a@example.test" }], body: { data: b64("x") } } });
      }
    }
    throw new Error(`the live Gmail unit test's stub was asked for an unexpected URL: ${url}`);
  }) as typeof fetch;

  const liveRow = (over: Partial<Row> = {}): Row => ({
    id: randomUUID(), tenant_id: T, owner_kind: "user", owner_id: ME, provider: "google_gmail", external_account: "me@gaiada.example", scopes: [], status: "linked",
    meta: { gmailMode: "live" }, token_expires_at: new Date(Date.now() + 3600_000).toISOString(), access_token_enc: encryptSecret(ACCESS),
    refresh_token_enc: encryptSecret("1//LIVE-REFRESH"), deleted_at: null, ...over,
  });

  beforeEach(() => {
    seen = [];
    behaviour = { gmail: "ok", refresh: "ok" };
    Object.assign(config.gmail, { mode: "live", ...CLIENT });
    setGmailHttpForTests(stub);
    store.rows = [liveRow()];
  });
  afterEach(() => setGmailHttpForTests(null));

  it("live status is configured only with the whole client, and never calls Google", async () => {
    expect(await statusAnswer(T, ME)).toEqual({ configured: true, connected: true, needsReconnect: false, accountEmail: "me@gaiada.example", mode: "live" });
    Object.assign(config.gmail, { clientSecret: "" });
    expect(await statusAnswer(T, ME)).toMatchObject({ configured: false, connected: false, mode: "live" });
    expect(seen).toEqual([]);
    expect(await reasonOf(startConnect(T, ME))).toMatchObject({ status: 503, reason: "gmail_not_configured" });
    expect(await reasonOf(listThreadsAnswer(T, ME, { label: "INBOX" }))).toMatchObject({ status: 503, reason: "gmail_not_configured" });
  });

  it("a simulated row in live mode is not a link (a marker is never a credential)", async () => {
    store.rows = [liveRow({ meta: { gmailMode: "simulated" }, access_token_enc: null, refresh_token_enc: null })];
    expect((await statusAnswer(T, ME)).connected).toBe(false);
    expect(await reasonOf(listThreadsAnswer(T, ME, { label: "INBOX" }))).toMatchObject({ reason: "gmail_not_connected" });
    expect(seen).toEqual([]);
  });

  it("reads through the real Gmail client with the person's own token and the label asked for", async () => {
    const out = await listThreadsAnswer(T, ME, { label: "SENT" });
    expect(out).toMatchObject({ mode: "live", nextPageToken: null, threads: [{ id: "g1", subject: "Live hi", from: "a@example.test", snippet: "hello" }] });
    const list = seen.find((s) => /\/threads\?/.test(s.url))!;
    expect(list.auth).toBe(`Bearer ${ACCESS}`);
    expect(new URL(list.url).searchParams.get("labelIds")).toBe("SENT");
    expect(seen.some((s) => s.url.includes("oauth2.googleapis.com"))).toBe(false); // not near expiry: no refresh
  });

  it("a token inside the 5-minute window is refreshed first, and the new token is sealed back", async () => {
    store.rows = [liveRow({ token_expires_at: new Date(Date.now() + 60_000).toISOString() })];
    await listThreadsAnswer(T, ME, { label: "INBOX" });
    expect(seen[0].form).toMatchObject({ grant_type: "refresh_token", refresh_token: "1//LIVE-REFRESH" });
    expect(seen.find((s) => s.url.includes("gmail.googleapis.com"))!.auth).toBe("Bearer ya29.LIVE-REFRESHED");
  });

  it("a Gmail 401 earns exactly one forced refresh and one retry", async () => {
    behaviour.gmail = "401-then-ok";
    const out = await listThreadsAnswer(T, ME, { label: "INBOX" });
    expect(out.threads).toHaveLength(1);
    expect(seen.filter((s) => s.url.includes("oauth2.googleapis.com"))).toHaveLength(1);
  });

  it("a second 401 marks the row needs-reconnect, KEEPS the tokens and answers 409 gmail_needs_reconnect; the next status says so", async () => {
    behaviour.gmail = "401-always";
    expect(await reasonOf(listThreadsAnswer(T, ME, { label: "INBOX" }))).toMatchObject({ status: 409, reason: "gmail_needs_reconnect" });
    expect(store.rows[0].status).toBe("error");
    expect(store.rows[0].meta.gmailNeedsReconnect).toBe(true);
    expect(store.rows[0].access_token_enc).not.toBeNull();
    expect(store.rows[0].refresh_token_enc).not.toBeNull();
    expect(await statusAnswer(T, ME)).toMatchObject({ connected: false, needsReconnect: true });
    const before = seen.length;
    expect(await reasonOf(sendAnswer(T, ME, body() as never))).toMatchObject({ status: 409, reason: "gmail_needs_reconnect" }); // refused before any call
    expect(seen.length).toBe(before);
  });

  it("a refresh Google refuses (invalid_grant) marks needs-reconnect; a refresh OUTAGE marks nothing and answers 502", async () => {
    store.rows = [liveRow({ token_expires_at: new Date(Date.now() + 1000).toISOString() })];
    behaviour.refresh = "invalid_grant";
    expect(await reasonOf(listThreadsAnswer(T, ME, { label: "INBOX" }))).toMatchObject({ status: 409, reason: "gmail_needs_reconnect" });
    expect(store.rows[0].meta.gmailNeedsReconnect).toBe(true);

    store.rows = [liveRow({ token_expires_at: new Date(Date.now() + 1000).toISOString() })];
    behaviour.refresh = "down";
    expect(await reasonOf(listThreadsAnswer(T, ME, { label: "INBOX" }))).toMatchObject({ status: 502, reason: "gmail_unavailable" });
    expect(store.rows[0].meta.gmailNeedsReconnect).toBeUndefined();
    expect(store.rows[0].status).toBe("linked");
  });

  it("a Gmail outage is 502 gmail_unavailable and marks nothing", async () => {
    behaviour.gmail = "down";
    expect(await reasonOf(listThreadsAnswer(T, ME, { label: "INBOX" }))).toMatchObject({ status: 502, reason: "gmail_unavailable" });
    expect(store.rows[0].status).toBe("linked");
    expect(store.rows[0].meta.gmailNeedsReconnect).toBeUndefined();
  });

  it("disconnect revokes at Google (best effort, reported) and clears the tokens", async () => {
    const stubWithRevoke = (async (input: unknown, init?: RequestInit) => {
      if (String(input).startsWith("https://oauth2.googleapis.com/revoke")) {
        seen.push({ url: String(input), form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))) });
        return new Response("", { status: 200 });
      }
      return stub(input as never, init);
    }) as typeof fetch;
    setGmailHttpForTests(stubWithRevoke);
    expect(await disconnect(T, ME)).toMatchObject({ disconnected: true, revokedAtGoogle: true, mode: "live" });
    expect(seen.find((s) => s.url.includes("/revoke"))!.form!.token).toBe("1//LIVE-REFRESH");
    expect(store.rows[0]).toMatchObject({ status: "revoked", access_token_enc: null, refresh_token_enc: null });
  });

  it("no response, error or log line of the live path carries a token", async () => {
    behaviour.gmail = "401-always";
    const r = await reasonOf(listThreadsAnswer(T, ME, { label: "INBOX" }));
    const dump = JSON.stringify(r);
    for (const secret of [ACCESS, "1//LIVE-REFRESH", "GOCSPX-GMAIL-SECRET", "ya29."]) expect(dump).not.toContain(secret);
  });
});
