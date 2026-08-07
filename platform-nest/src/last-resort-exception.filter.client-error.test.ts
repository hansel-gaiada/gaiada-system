// SM-58 addendum (2026-08-07 live-defect fix) — unit tests for the client-error (4xx) mapping added
// to LastResortExceptionFilter.
//
// THE LIVE DEFECT this reproduces: `POST /api/mail/inbound/brevo` with no/unrecognized
// content-type made Fastify raise its own `FST_ERR_CTP_INVALID_MEDIA_TYPE` — a plain object on the
// Error prototype chain carrying `statusCode: 415` as an own data property (see
// `node_modules/fastify/lib/errors.js`'s `createError()` and `contentTypeParser.js`'s
// `reply.send(new FST_ERR_CTP_INVALID_MEDIA_TYPE(contentType || undefined))`) — and this filter's
// unconditional `reply.status(500)` swallowed it into a bodyless-detail server fault. `[malformed]`
// in `mail/inbound/corpus.test.ts` reproduces the SAME defect end-to-end through the real HTTP route;
// this file is the unit-level proof of the mapping/leak/severity rules in isolation, matching how the
// sibling `last-resort-exception.filter.test.ts` / `.qa-adversarial.test.ts` are structured.
//
// EVERY case here asserts the SAME two things the existing adversarial suite already established for
// the 500 path, now extended to the new 4xx path:
//   (a) the reply status/body are exactly what the file header promises — honest status, fixed
//       per-status generic body, NEVER exception.message/stack/name text; and
//   (b) a 4xx never gets treated as a server fault (no `[unhandled-exception]` log line, no
//       `span.recordException`/`setStatus(ERROR)`), while a genuine 5xx / unclassified fault is
//       UNCHANGED from the pre-existing behaviour (still 500, still logged/spanned as a fault).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { context, trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { LastResortExceptionFilter } from "./last-resort-exception.filter";

// `@opentelemetry/api`'s DEFAULT context manager (no SDK registered) is a `NoopContextManager` whose
// `with()` just calls the function directly WITHOUT actually making the passed context active — so
// `trace.getSpan(context.active())` inside the filter would never see a span this test installs
// unless a REAL context manager backs `context`/`trace` for the duration of this file, exactly as
// `telemetry.ts`'s NodeSDK does in the real app (via `@opentelemetry/sdk-trace-node`, which this
// pulls in the async-hooks half of directly). Scoped to this file only (enabled in `beforeAll`,
// disabled in `afterAll`) so it can't leak into any other suite's global @opentelemetry/api state.
let contextManager: AsyncHooksContextManager;
beforeAll(() => {
  contextManager = new AsyncHooksContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
});
afterAll(() => {
  contextManager.disable();
});

function capture(exception: unknown): { status: number; body: unknown } {
  let status = 0;
  let body: unknown;
  const reply = {
    status(s: number) { status = s; return this; },
    send(b: unknown) { body = b; return this; },
  };
  const request = { method: "POST", url: "/api/mail/inbound/brevo" };
  const host = { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new LastResortExceptionFilter().catch(exception, host as any);
  return { status, body };
}

/** Runs `fn` with a fake, minimally-shaped OTel span made active via the real `context`/`trace` API
 *  (not a mock of the filter's internals) — the filter calls `trace.getSpan(context.active())` itself,
 *  so this is the only way to observe whether it marks a span ERROR without booting a full tracer
 *  SDK. The fake only implements the two methods the filter actually calls. */
function withFakeSpan<T>(fn: () => T): {
  result: T;
  recordExceptionCalls: unknown[][];
  setStatusCalls: unknown[][];
} {
  const recordExceptionCalls: unknown[][] = [];
  const setStatusCalls: unknown[][] = [];
  const fakeSpan = {
    recordException: (...args: unknown[]) => { recordExceptionCalls.push(args); },
    setStatus: (...args: unknown[]) => { setStatusCalls.push(args); },
  } as unknown as Span;
  const ctx = trace.setSpan(context.active(), fakeSpan);
  const result = context.with(ctx, fn);
  return { result, recordExceptionCalls, setStatusCalls };
}

/** A FastifyError-shaped object, matching exactly what `@fastify/error`'s `createError()` produces
 *  (own `.statusCode`/`.code`/`.name`/`.message` properties on an Error instance) — not a hand-typed
 *  stand-in, so these tests exercise the real shape the live defect hit. */
function fastifyError(name: string, code: string, message: string, statusCode: number): Error {
  const err = new Error(message);
  err.name = name;
  (err as unknown as { code: string; statusCode: number }).code = code;
  (err as unknown as { code: string; statusCode: number }).statusCode = statusCode;
  return err;
}

describe("SM-58 addendum · client-error (4xx) mapping — the live-defect fix", () => {
  it("(THE live defect) FST_ERR_CTP_INVALID_MEDIA_TYPE (415, no content-type) maps to 415, not 500", () => {
    const err = fastifyError(
      "FastifyError",
      "FST_ERR_CTP_INVALID_MEDIA_TYPE",
      "Unsupported Media Type: undefined",
      415,
    );
    const { status, body } = capture(err);
    expect(status).toBe(415);
    expect(body).toEqual({ error: "unsupported media type", code: "unsupported_media_type" });
    // Never the raw Fastify message, even though it happens to be harmless here — the rule is
    // structural (fixed table lookup), not "this particular message was safe".
    expect(JSON.stringify(body)).not.toContain("Unsupported Media Type");
  });

  it("FST_ERR_CTP_INVALID_CONTENT_LENGTH / malformed JSON (400) maps to 400, not 500", () => {
    const err = fastifyError("FastifyError", "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
      "Request body size did not match Content-Length", 400);
    const { status, body } = capture(err);
    expect(status).toBe(400);
    expect(body).toEqual({ error: "bad request", code: "bad_request" });
  });

  it("FST_ERR_CTP_BODY_TOO_LARGE (413) maps to 413, not 500", () => {
    const err = fastifyError("RangeError", "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large", 413);
    const { status, body } = capture(err);
    expect(status).toBe(413);
    expect(body).toEqual({ error: "payload too large", code: "payload_too_large" });
  });

  it("a 4xx status not in the named lookup table still maps honestly, via the generic fallback body", () => {
    const err = fastifyError("FastifyError", "FST_ERR_SOMETHING_ELSE", "some 4xx nobody named yet", 451);
    const { status, body } = capture(err);
    expect(status).toBe(451);
    expect(body).toEqual({ error: "client error", code: "client_error" });
  });

  // ── no-leak: the new path inherits the SAME rule the 500 path has always enforced ────────────────
  it("NEVER forwards exception.message on the 4xx path either, however sensitive", () => {
    const err = fastifyError(
      "FastifyError",
      "FST_ERR_CTP_INVALID_MEDIA_TYPE",
      "Unsupported Media Type: application/x-secret-internal-format?key=sk-live-SECRETVALUE",
      415,
    );
    const { body } = capture(err);
    const text = JSON.stringify(body);
    expect(text).not.toContain("SECRETVALUE");
    expect(text).not.toContain("secret-internal-format");
  });

  it("(adversarial) a hostile thrown value forging BOTH statusCode=404 and a leaking message still gets ONLY the fixed 404 body", () => {
    const hostile = {
      statusCode: 404,
      message: "leaked-marker sk-live-SECRETVALUE — internal path /etc/gaiada/secrets.env",
      toString() { return "also-leaked-via-toString sk-live-SECRETVALUE"; },
    };
    const { status, body } = capture(hostile);
    expect(status).toBe(404);
    expect(body).toEqual({ error: "not found", code: "not_found" });
    const text = JSON.stringify(body);
    expect(text).not.toContain("SECRETVALUE");
    expect(text).not.toContain("secrets.env");
    expect(text).not.toContain("leaked-marker");
  });

  // ── bounds: only a validated 4xx integer status is ever honoured ──────────────────────────────────
  it("a 5xx statusCode is NOT downgraded — still 500 with the existing generic body", () => {
    const err = fastifyError("FastifyError", "FST_ERR_SOME_BOOT_MISCONFIG", "internal misconfiguration", 500);
    const { status, body } = capture(err);
    expect(status).toBe(500);
    expect(body).toEqual({ error: "internal error", code: "internal_error" });
  });

  it("a 503 statusCode is NOT downgraded to a 4xx — still 500", () => {
    const err = fastifyError("GatewayNotConfiguredError-lookalike", "SOME_5XX", "unavailable", 503);
    const { status } = capture(err);
    expect(status).toBe(500);
  });

  it("a non-integer statusCode (404.5) is rejected — falls back to 500, never rounds or floors", () => {
    const err = fastifyError("FastifyError", "X", "weird", 404.5);
    const { status } = capture(err);
    expect(status).toBe(500);
  });

  it("a string statusCode ('404') is rejected — never coerced to a number", () => {
    const err = new Error("weird");
    (err as unknown as { statusCode: string }).statusCode = "404";
    const { status } = capture(err);
    expect(status).toBe(500);
  });

  it("statusCode 399 (just below 400) and 500 (just above 499) are both rejected — exact boundary", () => {
    const below = new Error("boundary");
    (below as unknown as { statusCode: number }).statusCode = 399;
    expect(capture(below).status).toBe(500);

    const above = new Error("boundary");
    (above as unknown as { statusCode: number }).statusCode = 500;
    expect(capture(above).status).toBe(500);
  });

  it("statusCode 400 and 499 (the exact boundary values) ARE honoured", () => {
    const low = new Error("boundary-low");
    (low as unknown as { statusCode: number }).statusCode = 400;
    expect(capture(low).status).toBe(400);

    const high = new Error("boundary-high");
    (high as unknown as { statusCode: number }).statusCode = 499;
    expect(capture(high).status).toBe(499);
  });

  it("NaN / Infinity / -Infinity statusCode values are all rejected — falls back to 500", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const err = new Error("weird-numeric");
      (err as unknown as { statusCode: number }).statusCode = bad;
      expect(capture(err).status).toBe(500);
    }
  });

  it("a missing statusCode property falls back to 500 exactly as before this addendum", () => {
    const { status, body } = capture(new Error("plain unclassified fault"));
    expect(status).toBe(500);
    expect(body).toEqual({ error: "internal error", code: "internal_error" });
  });

  it("(adversarial) a getter for .statusCode that THROWS on access must not crash the filter — falls back to 500", () => {
    const err = new Error("placeholder");
    Object.defineProperty(err, "statusCode", { get() { throw new Error("statusCode getter boom"); } });
    expect(() => capture(err)).not.toThrow();
    const { status, body } = capture(err);
    expect(status).toBe(500);
    expect(body).toEqual({ error: "internal error", code: "internal_error" });
  });

  it("(adversarial) a non-object thrown value (bare string) is unaffected by the new statusCode check", () => {
    const { status, body } = capture("a plain string, no statusCode possible");
    expect(status).toBe(500);
    expect(body).toEqual({ error: "internal error", code: "internal_error" });
  });

  it("(adversarial) a circular-reference object with a forged 4xx statusCode still maps cleanly, no crash", () => {
    const o: Record<string, unknown> = { statusCode: 400 };
    o.self = o;
    const { status, body } = capture(o);
    expect(status).toBe(400);
    expect(body).toEqual({ error: "bad request", code: "bad_request" });
  });

  // ── logging severity: 4xx is routine noise, not a server fault ────────────────────────────────────
  it("a 4xx logs under [client-error] via console.warn — NOT [unhandled-exception] via console.error", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const err = fastifyError("FastifyError", "FST_ERR_CTP_INVALID_MEDIA_TYPE", "Unsupported Media Type: undefined", 415);
      capture(err);
      expect(errSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [line] = warnSpy.mock.calls[0]!;
      expect(line).toContain("[client-error]");
      expect(line).not.toContain("[unhandled-exception]");
      expect(line).toContain("POST");
      expect(line).toContain("/api/mail/inbound/brevo");
      expect(line).toContain("415");
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("a genuine unclassified fault (no statusCode) is STILL logged under [unhandled-exception] via console.error — unchanged", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      capture(new Error("a totally unclassified fault"));
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledTimes(1);
      const [line] = errSpy.mock.calls[0]!;
      expect(line).toContain("[unhandled-exception]");
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // ── OTel span severity: a 4xx must never present as a failed span ────────────────────────────────
  it("a 4xx does NOT call span.recordException or mark the span ERROR", () => {
    const err = fastifyError("FastifyError", "FST_ERR_CTP_INVALID_MEDIA_TYPE", "Unsupported Media Type: undefined", 415);
    const { recordExceptionCalls, setStatusCalls } = withFakeSpan(() => capture(err));
    expect(recordExceptionCalls).toHaveLength(0);
    expect(setStatusCalls).toHaveLength(0);
  });

  it("a genuine unclassified fault STILL calls span.recordException + setStatus(ERROR) — unchanged", () => {
    const { recordExceptionCalls, setStatusCalls } = withFakeSpan(() =>
      capture(new Error("a totally unclassified fault")));
    expect(recordExceptionCalls).toHaveLength(1);
    expect(setStatusCalls).toHaveLength(1);
    expect(setStatusCalls[0]![0]).toMatchObject({ code: SpanStatusCode.ERROR });
  });

  it("a 5xx statusCode STILL calls span.recordException + setStatus(ERROR) — the fault path is unchanged", () => {
    const err = fastifyError("FastifyError", "FST_ERR_SOME_BOOT_MISCONFIG", "internal misconfiguration", 500);
    const { recordExceptionCalls, setStatusCalls } = withFakeSpan(() => capture(err));
    expect(recordExceptionCalls).toHaveLength(1);
    expect(setStatusCalls).toHaveLength(1);
  });
});
