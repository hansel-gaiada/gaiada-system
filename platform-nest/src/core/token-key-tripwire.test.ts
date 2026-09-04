// VLT-4 precondition — the DO-NOT-ROTATE tripwire in isolation. Proves the exact claim the ticket
// makes: WITHOUT this module, a wrong INTEGRATION_TOKEN_KEY produces no error at all until something
// later tries to read a sealed credential; WITH it wired into bootstrap(), a wrong key throws
// synchronously at boot, before the app accepts a single request. No DB — pure crypto + config,
// mirrors secret-box.test.ts's own isolation.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { config } from "../config";
import { decryptSecret, encryptSecret } from "./secret-box";
import { assertIntegrationTokenKeyMatchesCanary, CANARY_PLAINTEXT } from "./token-key-tripwire";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64"); // a different, equally well-formed 32-byte key
const originalKey = config.integrationTokenKey;
const originalCanary = config.integrationTokenKeyCanary;

describe("token-key-tripwire (DO-NOT-ROTATE)", () => {
  beforeEach(() => {
    config.integrationTokenKey = KEY_A;
    config.integrationTokenKeyCanary = "";
  });
  afterAll(() => {
    config.integrationTokenKey = originalKey;
    config.integrationTokenKeyCanary = originalCanary;
  });

  it("mints a canary and warns (does NOT throw) on first-ever boot, before any canary exists", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => assertIntegrationTokenKeyMatchesCanary()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("UNARMED"));
    warn.mockRestore();
  });

  it("passes silently when the configured key matches the canary it minted", () => {
    config.integrationTokenKeyCanary = encryptSecret(CANARY_PLAINTEXT);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => assertIntegrationTokenKeyMatchesCanary()).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("unchanged"));
    log.mockRestore();
  });

  it("THE CLAIM UNDER TEST: without the tripwire, a wrong key fails the READ silently late, not at " +
     "the moment of the mistake — decryptSecret() throws only when something actually tries to read", () => {
    // Mint under key A, exactly like a real deploy would have done weeks earlier.
    const sealedUnderA = encryptSecret("some-real-hosting-credential-value");
    // Swap to key B — same shape as a real INTEGRATION_TOKEN_KEY edit. Nothing observes this yet;
    // this line alone raises no error, logs nothing, and boot (without the tripwire) would succeed.
    config.integrationTokenKey = KEY_B;
    // Only a LATER read notices, and only when one actually happens:
    expect(() => decryptSecret(sealedUnderA)).toThrow();
  });

  it("WITH the tripwire wired in: the same wrong-key swap throws IMMEDIATELY at boot, before any " +
     "read of a real row happens", () => {
    // Arm the tripwire under key A first (the "previous, correct deploy" step).
    config.integrationTokenKeyCanary = encryptSecret(CANARY_PLAINTEXT);
    // Now the box comes back up with key B — the same silent swap as the test above.
    config.integrationTokenKey = KEY_B;
    expect(() => assertIntegrationTokenKeyMatchesCanary()).toThrow(/REFUSING TO BOOT/);
  });

  it("also refuses boot if the canary decrypts cleanly but to the wrong value (belt-and-suspenders)", () => {
    // Construct a canary that is validly sealed under key A but of the WRONG plaintext — simulates a
    // corrupted/misconfigured INTEGRATION_TOKEN_KEY_CANARY rather than a key swap.
    config.integrationTokenKeyCanary = encryptSecret("not-the-real-canary-value");
    expect(() => assertIntegrationTokenKeyMatchesCanary()).toThrow(/REFUSING TO BOOT/);
  });

  it("never throws when no vault key is configured at all (the vault's own 503 already covers it)", () => {
    config.integrationTokenKey = "";
    config.integrationTokenKeyCanary = "not-even-a-real-envelope";
    expect(() => assertIntegrationTokenKeyMatchesCanary()).not.toThrow();
  });

  it("the minted canary value never contains the plaintext key or the canary plaintext itself", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    assertIntegrationTokenKeyMatchesCanary();
    const [message] = warn.mock.calls[0] as [string];
    expect(message).not.toContain(KEY_A);
    expect(message).not.toContain(CANARY_PLAINTEXT);
    warn.mockRestore();
  });
});
