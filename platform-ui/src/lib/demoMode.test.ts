import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { demoModeRequested, isDemoMode, assertDemoModeAllowed } from "./demoMode";

// The whole point of this module is a REFUSAL, so the tests that matter are the ones asserting it
// throws. A test that only checks the happy path would pass just as well with no guard at all.

const prevDemo = process.env.DEMO_MODE;
const prevNode = process.env.NODE_ENV;

function setEnv(demo: string | undefined, node: string | undefined, ack?: string | undefined) {
  if (ack === undefined) delete process.env.DEMO_MODE_ACK_NON_PRODUCTION;
  else process.env.DEMO_MODE_ACK_NON_PRODUCTION = ack;
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

  it("permits demo fixtures in a production RUNTIME only when acknowledged by name — this is what CI does", () => {
    // CI builds and smoke-tests a production artifact against the fixtures; `next build` always sets
    // NODE_ENV=production, so without this the guard breaks CI (it did, on 2026-09-03).
    setEnv("1", "production", "1");
    expect(() => assertDemoModeAllowed()).not.toThrow();
    expect(isDemoMode()).toBe(true);
  });

  it("STILL refuses when the acknowledgement is absent or not exactly \"1\" — the live case", () => {
    // The property that matters: the real deployment sets NEITHER variable, so a stray DEMO_MODE=1
    // there is still fatal. The escape hatch must not be reachable by accident.
    for (const ack of [undefined, "0", "true", "yes", ""]) {
      setEnv("1", "production", ack);
      expect(() => assertDemoModeAllowed()).toThrow(/Refusing to start/);
    }
  });

  it("the acknowledgement alone never turns demo mode ON", () => {
    // It only removes a refusal. A production process carrying just this variable is an ordinary
    // production process and every read still goes to the real platform — otherwise the CI-only
    // variable would become a way to serve fixtures by setting one thing instead of two.
    setEnv(undefined, "production", "1");
    expect(isDemoMode()).toBe(false);
    expect(() => assertDemoModeAllowed()).not.toThrow();
  });
});

// ── The boot guard is a HAND-WRITTEN DUPLICATE, and nothing else stops it drifting ───────────────
// `next.config.ts` loads outside the app's module graph and its TS path aliases, so it cannot import
// this module and instead repeats the same condition inline. Drift is silent in BOTH directions and
// both are bad: if the library allows what the boot guard kills, the build gate breaks again exactly
// as it did from alpha.330 to alpha.332; if the boot guard allows what the library forbids, a
// deployment gets a chance to boot with fixtures. A text assertion is crude, and it is the only
// thing available across that module boundary.
describe("the next.config.ts boot guard mirrors this module", () => {
  // Read from the project root, not `import.meta.url` — under the jsdom environment that is not a
  // `file:` URL and `readFileSync` rejects it ("The URL must be of scheme file"). vitest runs with
  // cwd at the package root.
  async function readNextConfig(): Promise<string> {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    return readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  }

  it("keys on the same three environment variables, with the same comparisons", async () => {
    const config = await readNextConfig();
    expect(config).toContain('process.env.DEMO_MODE === "1"');
    expect(config).toContain('process.env.NODE_ENV === "production"');
    // `!== "1"` and not a truthiness check: the acknowledgement has to fail CLOSED on a typo here
    // too, which is the property the suite above pins for the library half.
    expect(config).toContain('process.env.DEMO_MODE_ACK_NON_PRODUCTION !== "1"');
  });

  it("does NOT try to key on NEXT_PHASE, which is undefined at config load", async () => {
    // Kept as a test because it is the obvious fix and it does not work. Exempting
    // `NEXT_PHASE === "phase-production-build"` reads as strictly safer than an env override — a
    // build serves nobody, so fixtures during one cannot reach a user — but the build still dies:
    // NEXT_PHASE is UNDEFINED when next.config.ts is evaluated, because Next passes the phase only
    // to a function-shaped config and this file exports an object. Measured with a probe, not
    // reasoned. Without this test the next person re-derives the theory and re-breaks CI.
    const config = await readNextConfig();
    const guard = config.slice(0, config.indexOf("const nextConfig"));
    expect(guard).not.toMatch(/NEXT_PHASE\s*(!==|===)/);
  });
});
