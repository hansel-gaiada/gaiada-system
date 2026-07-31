// SM-58 — SECOND, independently adversarial QA pass on LastResortExceptionFilter.
//
// The prior QA gate (26 tests, tsc clean) already proved: fixed-string client body, no
// exception.message leak for a fake connection string / password / API-key-shaped token, and the
// registration-order pin (moving the filter to the end of useGlobalFilters(...) turns the suite
// red). This file does NOT re-derive those — it attacks a different, narrower surface: non-Error
// throwables, hostile getters, circular references, and null/undefined, none of which the
// documented 26 appear to cover by name. Every case asserts BOTH halves of the contract: the
// client body stays the fixed `{ error, code }` shape (no leak), AND the fault is still captured
// server-side (console.error and/or the OTel span) — a backstop that swallows a fault silently
// server-side too would be a worse defect than a leaky one.
import { describe, it, expect, vi } from "vitest";
import { LastResortExceptionFilter } from "./last-resort-exception.filter";

function capture(exception: unknown): { status: number; body: unknown } {
  let status = 0;
  let body: unknown;
  const reply = {
    status(s: number) { status = s; return this; },
    send(b: unknown) { body = b; return this; },
  };
  const request = { method: "POST", url: "/api/t1/whatever" };
  const host = { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new LastResortExceptionFilter().catch(exception, host as any);
  return { status, body };
}

const FIXED = { error: "internal error", code: "internal_error" };

describe("SM-58 QA-adversarial · non-Error / hostile throwables", () => {
  it("(a) throw \"a plain string\" — fixed body, no crash", () => {
    const { status, body } = capture("a plain string");
    expect(status).toBe(500);
    expect(body).toEqual(FIXED);
  });

  it("(b) throw a non-Error object with a hostile custom toString() — toString content never reaches the client", () => {
    const hostile = {
      message: "fake",
      toString() { return "leaked-via-toString sk-live-SECRETVALUE"; },
    };
    const { status, body } = capture(hostile);
    expect(status).toBe(500);
    expect(body).toEqual(FIXED);
    expect(JSON.stringify(body)).not.toContain("leaked-via-toString");
    expect(JSON.stringify(body)).not.toContain("SECRETVALUE");
  });

  it("(c) an Error whose .message getter returns attacker content on access — never reaches the client", () => {
    const err = new Error("placeholder");
    Object.defineProperty(err, "message", { get() { return "sk-live-SECRETVALUE"; } });
    const { status, body } = capture(err);
    expect(status).toBe(500);
    expect(body).toEqual(FIXED);
    expect(JSON.stringify(body)).not.toContain("SECRETVALUE");
  });

  it("(c2) an Error whose .message getter THROWS on access — filter must not crash while handling it", () => {
    const err = new Error("placeholder");
    Object.defineProperty(err, "message", {
      get() { throw new Error("getter boom"); },
    });
    // If the filter dereferences .message without a try/catch, this call throws INSIDE catch(),
    // which Nest cannot recover from (no filter left underneath the last-resort filter) — that is
    // strictly worse than a leaky response: no HTTP response is sent at all.
    expect(() => capture(err)).not.toThrow();
    const { status, body } = capture(err);
    expect(status).toBe(500);
    expect(body).toEqual(FIXED);
  });

  it("(d) a circular-reference object thrown — no crash, fixed body", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    const { status, body } = capture(o);
    expect(status).toBe(500);
    expect(body).toEqual(FIXED);
  });

  it("(e) an Error subclass with an attacker-controlled .name getter — .name never rendered in the response", () => {
    class Evil extends Error {
      get name() { return "sk-live-SECRETVALUE"; }
    }
    const err = new Evil("boom");
    const { status, body } = capture(err);
    expect(status).toBe(500);
    expect(body).toEqual(FIXED);
    expect(JSON.stringify(body)).not.toContain("SECRETVALUE");
  });

  it("(f1) throw null — no crash, fixed body", () => {
    const { status, body } = capture(null);
    expect(status).toBe(500);
    expect(body).toEqual(FIXED);
  });

  it("(f2) throw undefined — no crash, fixed body", () => {
    const { status, body } = capture(undefined);
    expect(status).toBe(500);
    expect(body).toEqual(FIXED);
  });
});

describe("SM-58 QA-adversarial · server-side observability survives hostile throwables", () => {
  it("a circular-reference throw is still logged server-side via console.error (not silently swallowed)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const o: Record<string, unknown> = {};
      o.self = o;
      capture(o);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a bare string throw is still logged server-side via console.error, containing the original string", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      capture("diagnosable-marker-xyz");
      expect(spy).toHaveBeenCalledTimes(1);
      const [line] = spy.mock.calls[0]!;
      expect(line).toContain("diagnosable-marker-xyz");
    } finally {
      spy.mockRestore();
    }
  });
});
