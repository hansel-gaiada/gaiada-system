// SM-57 — pins the GatewayNotConfiguredError -> HTTP mapping, mirroring provider-dispatch-error.
// filter.test.ts's approach: test at the filter rather than over HTTP, because the mapping IS the
// unit and a route test would additionally need a live DB + Cerbos to reach the throw.
import { describe, it, expect } from "vitest";
import { GatewayNotConfiguredErrorFilter } from "./gateway-not-configured-error.filter";
import { GatewayNotConfiguredError } from "./providers/gateway-client";

function capture(err: GatewayNotConfiguredError): { status: number; body: unknown } {
  let status = 0;
  let body: unknown;
  const reply = {
    status(s: number) { status = s; return this; },
    send(b: unknown) { body = b; return this; },
  };
  const host = { switchToHttp: () => ({ getResponse: () => reply }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new GatewayNotConfiguredErrorFilter().catch(err, host as any);
  return { status, body };
}

describe("SM-57 · GatewayNotConfiguredError maps to HTTP, never to a bare 500", () => {
  it("is 503 — an unconfigured gateway is a deployment state, not a caller error or a crash", () => {
    const { status, body } = capture(new GatewayNotConfiguredError());
    expect(status).toBe(503);
    const b = body as { error: string; code: string };
    expect(b.code).toBe("gateway_not_configured");
  });

  it("carries an ACTIONABLE message — a 503 with an empty body is no better than the 500 it replaces", () => {
    const { body } = capture(new GatewayNotConfiguredError());
    const b = body as { error: string };
    expect(typeof b.error).toBe("string");
    expect(b.error.length).toBeGreaterThan(0);
    expect(b.error).toContain("GATEWAY_URL");
  });

  it("keeps `error` for app-wide contract parity and adds `code` for branching", () => {
    const { body } = capture(new GatewayNotConfiguredError());
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("code");
  });
});
