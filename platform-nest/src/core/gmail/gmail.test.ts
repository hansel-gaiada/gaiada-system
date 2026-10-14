// DW-8j (docs/FRONTEND-BFF-CONTRACT.md §48) — the pure parts of core/gmail: the mode switch and its boot refusals, the send limiter, the
// refusal mapping, the surface, the 429 answer, and the static guarantees (no network primitive, the controller's gate order, the owner is never
// a parameter). No database, no Cerbos.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HttpException } from "@nestjs/common";
import { config } from "../../config";
import { HttpErrorFilter } from "../../http-error.filter";
import { GOOGLE_PROVIDERS, googleSurfaceFor, isGoogleProvider } from "../google-oauth/registry";
import {
  GmailInvalidMessageError, GmailNotFoundError, GmailRateLimitedError, GmailRevokedError, GmailUnauthorizedError, GmailUnavailableError,
} from "../../integrations/gmail/errors";
import { assertGmailBootSafe, gmailMode } from "./mode";
import { SENDS_PER_HOUR, SendRateLimiter, WINDOW_MS } from "./rate-limit";
import { GMAIL_SCOPES, GOOGLE_GMAIL_SURFACE } from "./surface";
import { isListLabel, isPageToken, isThreadId, mapClientError, parseSendRequest } from "./service";

const reasonOf = (e: unknown) => ((e as HttpException).getResponse() as Record<string, unknown>).reason;

describe("GMAIL_MODE", () => {
  it("defaults to simulated, and only the exact word `live` is live at request time", () => {
    const saved = config.gmail.mode;
    try {
      for (const [raw, want] of [["simulated", "simulated"], ["", "simulated"], ["Live", "simulated"], ["real", "simulated"], ["live", "live"]] as const) {
        config.gmail.mode = raw;
        expect(gmailMode(), raw).toBe(want);
      }
    } finally {
      config.gmail.mode = saved;
    }
  });

  it("the boot refusals: any other word, and live without the whole Google client (id, secret and redirect URI)", () => {
    expect(assertGmailBootSafe({ mode: "simulated" })).toBe("simulated");
    expect(assertGmailBootSafe({ mode: " SIMULATED " })).toBe("simulated");
    expect(assertGmailBootSafe({ mode: "live", liveConfigured: true })).toBe("live");
    expect(() => assertGmailBootSafe({ mode: "live", liveConfigured: false })).toThrow(/GOOGLE_GMAIL_CLIENT_ID/);
    expect(() => assertGmailBootSafe({ mode: "lvie" })).toThrow(/GMAIL_MODE must be/);
    expect(() => assertGmailBootSafe({ mode: "" })).toThrow(/GMAIL_MODE must be/);
    expect(() => assertGmailBootSafe({ mode: "true" })).toThrow(/GMAIL_MODE must be/);
  });

  it("simulated needs no Google client at all", () => {
    expect(assertGmailBootSafe({ mode: "simulated", liveConfigured: false })).toBe("simulated");
  });

  it("main.ts calls the refusal unconditionally in bootstrap, outside any branch", () => {
    const text = readFileSync(join(__dirname, "..", "..", "main.ts"), "utf8");
    const line = text.split("\n").find((l) => l.includes("assertGmailBootSafe()"))!;
    expect(line, "bootstrap must call assertGmailBootSafe()").toBeTruthy();
    expect(line.startsWith("  console.log(") || line.startsWith("  assertGmailBootSafe")).toBe(true); // two-space indent: function scope
  });
});

describe("the send limiter (30 an hour, per person)", () => {
  it("allows 30 and refuses the 31st with the wait until the oldest leaves the window", () => {
    const l = new SendRateLimiter();
    expect(SENDS_PER_HOUR).toBe(30);
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) expect(l.consume("me", t0 + i * 1000)).toEqual({ ok: true });
    expect(l.consume("me", t0 + 40_000)).toEqual({ ok: false, retryAfterSeconds: Math.ceil((t0 + WINDOW_MS - (t0 + 40_000)) / 1000) });
    expect(l.used("me", t0 + 40_000)).toBe(30); // the refused attempt counted nothing
  });

  it("slides: the window frees one slot at a time", () => {
    const l = new SendRateLimiter(2, 1000);
    expect(l.consume("p", 0).ok).toBe(true);
    expect(l.consume("p", 400).ok).toBe(true);
    expect(l.consume("p", 500)).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(l.consume("p", 1001).ok).toBe(true); // the first left the window
    expect(l.consume("p", 1002)).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it("is per person, resets, and bounds what it tracks", () => {
    const l = new SendRateLimiter(1, 1000);
    expect(l.consume("a", 0).ok).toBe(true);
    expect(l.consume("b", 0).ok).toBe(true);
    expect(l.consume("a", 1).ok).toBe(false);
    l.reset();
    expect(l.trackedPeople()).toBe(0);
    expect(l.consume("a", 2).ok).toBe(true);
  });

  it("holds only a person id and times: consume takes (person, now), nothing of a message", () => {
    expect(SendRateLimiter.prototype.consume.length).toBeLessThanOrEqual(2);
  });
});

describe("the refusal mapping (§48 tokens)", () => {
  it("maps every seam error to its §48 status and token, with the extras the filter forwards", () => {
    const cases: Array<[unknown, number, string]> = [
      [new GmailInvalidMessageError("to", "bad"), 400, "gmail_send_invalid"],
      [new GmailRateLimitedError(42), 429, "gmail_rate_limited"],
      [new GmailNotFoundError("thread", "x"), 404, "gmail_not_found"],
      [new GmailUnauthorizedError(), 409, "gmail_needs_reconnect"],
      [new GmailRevokedError(), 409, "gmail_needs_reconnect"],
      [new GmailUnavailableError(), 502, "gmail_unavailable"],
    ];
    for (const [err, status, token] of cases) {
      const out = mapClientError(err) as HttpException;
      expect(out.getStatus(), token).toBe(status);
      expect(reasonOf(out), token).toBe(token);
      expect(String((out.getResponse() as { message: string }).message).startsWith(`${token}:`)).toBe(true);
    }
    expect((mapClientError(new GmailInvalidMessageError("cc", "bad")) as HttpException).getResponse()).toMatchObject({ field: "cc" });
    expect((mapClientError(new GmailRateLimitedError(42)) as HttpException).getResponse()).toMatchObject({ retryAfterSeconds: 42 });
  });

  it("a bug is not hidden: an unknown error comes back as itself, an HttpException as itself", () => {
    const boom = new Error("boom");
    expect(mapClientError(boom)).toBe(boom);
    const h = new HttpException("x", 418);
    expect(mapClientError(h)).toBe(h);
  });

  it("parseSendRequest answers the 400 gmail_send_invalid with the failing field, and a valid body untouched", () => {
    try {
      parseSendRequest({ to: ["nope"], subject: "s", body: "b" });
      expect.unreachable("should have refused");
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(400);
      expect((e as HttpException).getResponse()).toMatchObject({ reason: "gmail_send_invalid", field: "to" });
    }
    expect(parseSendRequest({ to: ["a@example.test"], subject: "s", body: "b" })).toEqual({ to: ["a@example.test"], subject: "s", body: "b" });
  });

  it("the shape guards for the read routes", () => {
    expect(isListLabel("INBOX")).toBe(true);
    expect(isListLabel("SENT")).toBe(true);
    for (const v of ["inbox", "TRASH", "", undefined, ["INBOX"]]) expect(isListLabel(v), String(v)).toBe(false);
    expect(isThreadId("t5")).toBe(true);
    expect(isThreadId("18f3a2b4c5d6e7f8")).toBe(true);
    for (const v of ["", "a b", "a/b", "a..b", "x".repeat(129), "t5\r\n"]) expect(isThreadId(v), v).toBe(false);
    expect(isPageToken("fixture:v1:sent:2")).toBe(true);
    for (const v of ["", "has space", "a\nb", "x".repeat(513)]) expect(isPageToken(v), v).toBe(false);
  });
});

describe("the 429 answer", () => {
  it("HttpErrorFilter forwards retryAfterSeconds in the body and as a Retry-After header, rounding up", () => {
    const sent: { status?: number; body?: Record<string, unknown>; headers: Record<string, string> } = { headers: {} };
    const reply = {
      header: (k: string, v: string) => { sent.headers[k] = v; return reply; },
      status: (s: number) => { sent.status = s; return reply; },
      send: (b: Record<string, unknown>) => { sent.body = b; return reply; },
    };
    const host = { switchToHttp: () => ({ getResponse: () => reply }) };
    const ex = new HttpException({ message: "gmail_send_rate_limited: wait", reason: "gmail_send_rate_limited", retryAfterSeconds: 61.2 }, 429);
    new HttpErrorFilter().catch(ex, host as never);
    expect(sent.status).toBe(429);
    expect(sent.body).toEqual({ error: "gmail_send_rate_limited: wait", reason: "gmail_send_rate_limited", retryAfterSeconds: 62 });
    expect(sent.headers["retry-after"]).toBe("62");
    // absent or invalid: nothing is added
    for (const bad of [undefined, 0, -3, "7", Number.NaN]) {
      const s2: { body?: Record<string, unknown>; headers: Record<string, string> } = { headers: {} };
      const r2 = { header: (k: string, v: string) => { s2.headers[k] = v; return r2; }, status: () => r2, send: (b: Record<string, unknown>) => { s2.body = b; return r2; } };
      new HttpErrorFilter().catch(new HttpException({ message: "x", retryAfterSeconds: bad }, 429), { switchToHttp: () => ({ getResponse: () => r2 }) } as never);
      expect(s2.body, String(bad)).toEqual({ error: "x" });
      expect(s2.headers).toEqual({});
    }
  });
});

describe("the surface", () => {
  it("is core (no module), the person's own, gated by personal_mailbox connect, with both Gmail scopes", () => {
    expect(GOOGLE_GMAIL_SURFACE).toMatchObject({
      provider: "google_gmail", module: null, ownerKind: "user", authz: { kind: "personal_mailbox", action: "connect" },
    });
    expect(GMAIL_SCOPES).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send", "openid", "email",
    ]);
    expect(GOOGLE_PROVIDERS).toContain("google_gmail");
    expect(isGoogleProvider("google_gmail")).toBe(true);
    expect(googleSurfaceFor("google_gmail")).toBe(GOOGLE_GMAIL_SURFACE);
  });
});

describe("static guarantees", () => {
  const dir = __dirname;
  const prod = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const code = (f: string) => readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("no file in core/gmail calls the network itself: Gmail is reached only through integrations/gmail, the token client only through google-oauth", () => {
    expect(prod).toEqual(expect.arrayContaining(["service.ts", "gmail.controller.ts", "surface.ts", "mode.ts", "rate-limit.ts"]));
    // (the two scope names in surface.ts are identifiers Google defines, not endpoints this code calls)
    for (const f of prod) {
      const text = code(f).replace(/https:\/\/www\.googleapis\.com\/auth\/gmail\.(?:readonly|send)/g, "");
      expect(text, f).not.toMatch(/\b\w*[fF]etch\w*\s*\(|\bhttps?:\/\/|XMLHttpRequest/);
    }
  });

  it("nothing in core/gmail writes a message's content: the only SQL is the owner-scoped connection read", () => {
    const sql = prod.flatMap((f) => [...code(f).matchAll(/\b(INSERT|UPDATE|DELETE)\b\s+(?:INTO\s+)?(\w+)/g)].map((m) => `${f}:${m[0]}`));
    expect(sql).toEqual([]);
    expect(code("service.ts")).toMatch(/owner_kind = 'user' AND owner_id = \$1 AND provider = \$2/);
  });

  it("the controller never reads an owner from a parameter: no :userId, no owner/user in a query or body read", () => {
    const text = code("gmail.controller.ts");
    expect(text).not.toMatch(/:userId|:ownerId/);
    expect(text).not.toMatch(/@Query\("(?:user|userId|owner|ownerId|me)"\)/);
    expect(text).not.toMatch(/b\.(?:ownerId|userId|owner|from)\b/);
    // every Cerbos check on the mailbox names the caller
    expect([...text.matchAll(/mailbox\(tenantId, me\)/g)].length).toBeGreaterThanOrEqual(6);
    expect(text).not.toMatch(/ownerId:\s*(?!me\b)\w+/);
  });

  it("the send handler authorises the mailbox, then the client, THEN validates (authorise first)", () => {
    const text = code("gmail.controller.ts");
    const send = text.slice(text.indexOf("async send("));
    const iMailbox = send.indexOf('"send")');
    const iClient = send.indexOf('kind: "client"');
    const iParse = send.indexOf("parseSendRequest(");
    const iSend = send.indexOf("sendAnswer(");
    expect(iMailbox).toBeGreaterThan(-1);
    expect(iMailbox).toBeLessThan(iClient);
    expect(iClient).toBeLessThan(iParse);
    expect(iParse).toBeLessThan(iSend);
  });

  it("the activity row carries only a count and the mode", () => {
    const text = code("gmail.controller.ts");
    expect(text).toContain('{ recipientCount: recipientCount(outgoing), mode: out.mode }');
    const call = text.slice(text.indexOf('"emailed"'), text.indexOf('"emailed"') + 200);
    expect(call).not.toMatch(/subject|body|\bto\b|address|cc/);
  });

  it("the simulated path never builds the live client", () => {
    const text = code("service.ts");
    const simBranch = text.slice(text.indexOf('if (mode === "simulated") {'), text.indexOf("if (!gmailLiveConfigured()) throw notConfigured();\n  let tok"));
    expect(simBranch).toContain("simulatedMailboxes.clientFor");
    expect(simBranch).not.toContain("createGmailApiClient");
    // and the live client is built in exactly one place
    expect([...text.matchAll(/createGmailApiClient\(/g)]).toHaveLength(1);
  });
});
