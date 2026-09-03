import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { demoModeRequested, isDemoMode, assertDemoModeAllowed } from "./demoMode";

// The whole point of this module is a REFUSAL, so the tests that matter are the ones asserting it
// throws. A test that only checks the happy path would pass just as well with no guard at all.

const prevDemo = process.env.DEMO_MODE;
const prevNode = process.env.NODE_ENV;

function setEnv(demo: string | undefined, node: string | undefined) {
  if (demo === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = demo;
  // NODE_ENV is readonly in the Next type surface; assign through a cast, same as the existing
  // suites that manipulate it.
  (process.env as Record<string, string | undefined>).NODE_ENV = node;
}

beforeEach(() => setEnv(undefined, "test"));
afterEach(() => setEnv(prevDemo, prevNode));

describe("demoMode", () => {
  it("is off when the flag is unset — the production default", () => {
    setEnv(undefined, "production");
    expect(demoModeRequested()).toBe(false);
    expect(isDemoMode()).toBe(false);
    expect(() => assertDemoModeAllowed()).not.toThrow();
  });

  it("REFUSES when the flag is set in a production runtime", () => {
    setEnv("1", "production");
    expect(() => assertDemoModeAllowed()).toThrow(/Refusing to start/);
    // isDemoMode must never answer "yes" where fixtures are forbidden — it throws instead, so a
    // caller cannot accidentally take the fixture branch.
    expect(() => isDemoMode()).toThrow(/NODE_ENV=production/);
  });

  it("names the actual consequences in the error, so whoever hits it knows why it is fatal", () => {
    setEnv("1", "production");
    // Not cosmetic: the person who sees this message at 2am is deciding whether to force it back up.
    // "bypasses login" is the fact that stops them.
    expect(() => assertDemoModeAllowed()).toThrow(/bypasses login/);
    expect(() => assertDemoModeAllowed()).toThrow(/DEMO_MODE/);
  });

  it("allows the harness outside production, which is the only place it is valid", () => {
    setEnv("1", "development");
    expect(isDemoMode()).toBe(true);
    setEnv("1", "test");
    expect(isDemoMode()).toBe(true);
  });

  it("treats only the exact string \"1\" as on, matching every existing call site", () => {
    for (const v of ["0", "true", "yes", "", "TRUE"]) {
      setEnv(v, "development");
      expect(demoModeRequested()).toBe(false);
      expect(isDemoMode()).toBe(false);
    }
  });

  it("demoModeRequested reports the raw flag even where it is forbidden", () => {
    // The /about diagnostics panel uses this: a misconfigured deployment must be able to SHOW its
    // own misconfiguration rather than hide the cause behind the guard.
    setEnv("1", "production");
    expect(demoModeRequested()).toBe(true);
  });
});
