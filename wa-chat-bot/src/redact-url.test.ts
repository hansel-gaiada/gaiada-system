// SIM-F3 — the webhook shared secret must never reach a log line.
//
// Found by reading this container's own log while driving simulated traffic through it: Fastify's
// default request serialiser logs `req.url` verbatim, and WAHA is configured to call
// `POST /webhook?token=<secret>`, so the credential was written to stdout and onward to Loki on
// every inbound event.
//
// These are the assertions worth having for security-relevant string handling — the one thing worse
// than no redactor is a redactor nobody checked.
import { describe, it, expect } from "vitest";
import { redactUrl } from "./telemetry";

describe("redactUrl", () => {
  it("redacts the webhook token, which is the leak that prompted this", () => {
    expect(redactUrl("/webhook?token=d431cbafa0400ed84d463b6fe1b2812e")).toBe("/webhook?token=[redacted]");
  });

  it("leaves a url with no query string untouched", () => {
    expect(redactUrl("/health")).toBe("/health");
  });

  it("keeps non-credential parameters readable", () => {
    // A redactor that blanks the whole query string is safe but useless — someone reading logs is
    // trying to correlate a specific request.
    expect(redactUrl("/admin/groups?limit=50&cursor=abc")).toBe("/admin/groups?limit=50&cursor=abc");
  });

  it("redacts only the credential among several parameters, preserving order", () => {
    expect(redactUrl("/webhook?session=default&token=secret123&retry=2")).toBe(
      "/webhook?session=default&token=[redacted]&retry=2",
    );
  });

  it("matches the parameter name case-insensitively", () => {
    expect(redactUrl("/x?Token=abc&API_KEY=def")).toBe("/x?Token=[redacted]&API_KEY=[redacted]");
  });

  it("does not redact a parameter that merely CONTAINS a credential name", () => {
    // `tokenCount` is not a credential. Matching on a substring would blank harmless telemetry and
    // teach people to distrust the redactor.
    expect(redactUrl("/x?tokenCount=5")).toBe("/x?tokenCount=5");
  });

  it("survives a malformed query string without throwing", () => {
    // Logging must never be the thing that takes a request down.
    expect(redactUrl("/x?justakey&token=abc&=novalue")).toBe("/x?justakey&token=[redacted]&=novalue");
  });

  it("does not re-encode the rest of the url", () => {
    // Round-tripping through URLSearchParams would re-encode and the logged line would stop matching
    // the request that produced it.
    expect(redactUrl("/x?q=a%20b&token=z")).toBe("/x?q=a%20b&token=[redacted]");
  });
});
