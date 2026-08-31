// GH-07 — pure unit tests, no DB. HMAC-SHA256 verification correctness + fail-closed edge cases.
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyGithubWebhookSignature } from "./github-webhook-signature";

const SECRET = "test-webhook-secret-value";

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyGithubWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    expect(verifyGithubWebhookSignature(body, sign(body.toString("utf8")), SECRET)).toBe(true);
  });

  it("rejects when the body is signed with a DIFFERENT secret", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    expect(verifyGithubWebhookSignature(body, sign(body.toString("utf8"), "wrong-secret"), SECRET)).toBe(false);
  });

  it("rejects when even ONE byte of the body differs from what was signed", () => {
    const original = JSON.stringify({ hello: "world" });
    const signature = sign(original);
    const tampered = Buffer.from(JSON.stringify({ hello: "worlD" }), "utf8");
    expect(verifyGithubWebhookSignature(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    const body = Buffer.from("{}", "utf8");
    expect(verifyGithubWebhookSignature(body, undefined, SECRET)).toBe(false);
  });

  it("rejects a header missing the sha256= prefix", () => {
    const body = Buffer.from("{}", "utf8");
    const bare = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyGithubWebhookSignature(body, bare, SECRET)).toBe(false);
  });

  it("FAIL-CLOSED when the configured secret is empty — refuses even a correctly-shaped signature", () => {
    const body = Buffer.from("{}", "utf8");
    const sig = `sha256=${createHmac("sha256", "").update(body).digest("hex")}`;
    expect(verifyGithubWebhookSignature(body, sig, "")).toBe(false);
  });

  it("rejects a malformed (non-hex, wrong-length) signature value without throwing", () => {
    const body = Buffer.from("{}", "utf8");
    expect(() => verifyGithubWebhookSignature(body, "sha256=not-hex-at-all!!", SECRET)).not.toThrow();
    expect(verifyGithubWebhookSignature(body, "sha256=not-hex-at-all!!", SECRET)).toBe(false);
    expect(verifyGithubWebhookSignature(body, "sha256=ab", SECRET)).toBe(false);
  });

  it("rejects an empty body signed against a different (non-empty) body's signature", () => {
    const realSig = sign(JSON.stringify({ a: 1 }));
    expect(verifyGithubWebhookSignature(Buffer.alloc(0), realSig, SECRET)).toBe(false);
  });
});
