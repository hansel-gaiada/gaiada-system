// WSUX-14 — the credential-vault primitive (secret-box.ts) in isolation: round-trip, tamper
// detection, key validation, and the FAIL-CLOSED behaviour that guarantees a token can never be
// stored in plaintext. No DB — pure crypto + config.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { config } from "../config";
import {
  encryptSecret, decryptSecret, isSealed, secretEquals, tokenVaultConfigured, TOKEN_KEY_VERSION,
} from "./secret-box";

const KEY_B64 = randomBytes(32).toString("base64");
const original = config.integrationTokenKey;

describe("secret-box (connection credential vault)", () => {
  beforeEach(() => {
    config.integrationTokenKey = KEY_B64;
  });
  afterAll(() => {
    config.integrationTokenKey = original;
  });

  it("round-trips a secret through the enc:v1 envelope", () => {
    const plaintext = "ghp_super-secret-oauth-token-value";
    const sealed = encryptSecret(plaintext);
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(sealed).not.toContain(plaintext); // ciphertext never contains the plaintext
    expect(isSealed(sealed)).toBe(true);
    expect(decryptSecret(sealed)).toBe(plaintext);
  });

  it("produces a distinct ciphertext each time (random IV) but both decrypt equal", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-value");
    expect(decryptSecret(b)).toBe("same-value");
  });

  it("reports the configured version + configured state", () => {
    expect(TOKEN_KEY_VERSION).toBe("v1");
    expect(tokenVaultConfigured()).toBe(true);
  });

  it("detects tampering (GCM auth tag) — a flipped ciphertext byte fails to decrypt", () => {
    const sealed = encryptSecret("tamper-me");
    const parts = sealed.slice("enc:v1:".length).split(":");
    // Flip a byte in the data segment.
    const data = Buffer.from(parts[2], "base64");
    data[0] = data[0] ^ 0xff;
    const tampered = `enc:v1:${parts[0]}:${parts[1]}:${data.toString("base64")}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("FAIL-CLOSED: encrypt throws 503 when INTEGRATION_TOKEN_KEY is unset (never stores plaintext)", () => {
    config.integrationTokenKey = "";
    expect(tokenVaultConfigured()).toBe(false);
    expect(() => encryptSecret("x")).toThrowError(/vault not configured/i);
    expect(() => decryptSecret("enc:v1:a:b:c")).toThrowError(/vault not configured/i);
  });

  it("rejects a present-but-wrong-length key loudly (misconfig is not silently weak)", () => {
    config.integrationTokenKey = randomBytes(16).toString("base64"); // 128-bit, too short for AES-256
    expect(() => encryptSecret("x")).toThrowError(/32 bytes/);
    // tokenVaultConfigured swallows the decode error and reports not-configured (consistent 503 path).
    expect(tokenVaultConfigured()).toBe(false);
  });

  it("secretEquals is a constant-time plaintext compare", () => {
    expect(secretEquals("abc", "abc")).toBe(true);
    expect(secretEquals("abc", "abd")).toBe(false);
    expect(secretEquals("abc", "abcd")).toBe(false);
  });
});
