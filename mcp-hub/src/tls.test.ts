import { describe, it, expect, afterEach } from "vitest";
import type { IncomingMessage } from "node:http";
import { config } from "./config";
import { checkPeer, peerAllowed, tlsEnabled } from "./tls";

// Fake an https request with a given TLS peer state.
function reqWith(opts: { cn?: string; authorized?: boolean; authError?: string }): IncomingMessage {
  const cert = opts.cn ? { subject: { CN: opts.cn } } : {};
  return {
    socket: {
      authorized: opts.authorized ?? false,
      authorizationError: opts.authError,
      getPeerCertificate: () => cert,
    },
  } as unknown as IncomingMessage;
}

describe("mTLS peer check (WS2 §3)", () => {
  afterEach(() => {
    config.tlsMode = "off";
  });

  it("is a no-op when TLS is off", () => {
    config.tlsMode = "off";
    expect(tlsEnabled()).toBe(false);
    expect(checkPeer(reqWith({})).ok).toBe(true);
  });

  it("enforced: allows an authorized cert with an allowlisted CN", () => {
    config.tlsMode = "enforced";
    const r = checkPeer(reqWith({ cn: "bot", authorized: true }));
    expect(r.ok).toBe(true);
    expect(r.cn).toBe("bot");
  });

  it("enforced: rejects an unauthorized/absent cert", () => {
    config.tlsMode = "enforced";
    const r = checkPeer(reqWith({ authorized: false, authError: "UNABLE_TO_GET_ISSUER_CERT" }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not authorized/);
  });

  it("enforced: rejects a valid cert whose CN is not allowlisted (right CA, wrong service)", () => {
    config.tlsMode = "enforced";
    const r = checkPeer(reqWith({ cn: "attacker", authorized: true }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not in allowlist/);
  });

  it("permissive: serves an unverified peer but flags it", () => {
    config.tlsMode = "permissive";
    const r = checkPeer(reqWith({ authorized: false }));
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/permissive/);
  });

  it("peerAllowed honors the configured allowlist", () => {
    expect(peerAllowed("bot")).toBe(true);
    expect(peerAllowed("nope")).toBe(false);
    expect(peerAllowed(undefined)).toBe(false);
  });
});
