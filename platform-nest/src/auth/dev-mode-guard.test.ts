// Behaviour pin for the passwordless-auth boot refusal (fault register finding 04, 2026-09-08).
//
// The case that matters is the FIRST one: production + dev auth must THROW. Everything else here
// exists to prove the guard is not simply throwing at everything — a guard that refuses too much
// gets disabled by the next person it inconveniences, and then protects nothing at all.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  assertAuthModeBootSafe,
  PasswordlessAuthInProductionError,
  DEV_AUTH_ACK_ENV,
} from "./dev-mode-guard";

describe("assertAuthModeBootSafe (finding 04)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("REFUSES production + dev auth — the whole reason this exists", () => {
    expect(() => assertAuthModeBootSafe("dev", "production", undefined))
      .toThrow(PasswordlessAuthInProductionError);
  });

  it("names the fix in the message, not just the problem", () => {
    // An operator meets this at 03:00 during a deploy. "Boot refused" without the remedy is a
    // guard that costs more than it saves.
    let msg = "";
    try { assertAuthModeBootSafe("dev", "production", undefined); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("PLATFORM_AUTH_MODE=oidc");
    expect(msg).toContain(DEV_AUTH_ACK_ENV);
    expect(msg).toMatch(/passwordless/i);
  });

  it("allows oidc and hybrid in production", () => {
    expect(() => assertAuthModeBootSafe("oidc", "production", undefined)).not.toThrow();
    expect(() => assertAuthModeBootSafe("hybrid", "production", undefined)).not.toThrow();
  });

  it("allows dev auth outside production — local stacks and the test suite must still work", () => {
    // The whole platform-nest suite runs with the config default of "dev" and no NODE_ENV. If this
    // case ever threw, every test in the component would fail at boot, someone would delete the
    // guard rather than debug it, and finding 04 would quietly reopen.
    expect(() => assertAuthModeBootSafe("dev", undefined, undefined)).not.toThrow();
    expect(() => assertAuthModeBootSafe("dev", "test", undefined)).not.toThrow();
    expect(() => assertAuthModeBootSafe("dev", "development", undefined)).not.toThrow();
  });

  it("the acknowledgement permits it, but says so loudly", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => assertAuthModeBootSafe("dev", "production", "1")).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toMatch(/PASSWORDLESS AUTH IS ACTIVE/);
  });

  it("only the exact string '1' acknowledges — no truthy-string escape", () => {
    // "0", "false" and "true" are all truthy strings in JS. A `if (ack)` here would mean
    // AUTH_MODE_DEV_ACK_NON_PRODUCTION=0 DISABLES the guard, which is the opposite of what
    // anyone typing that would expect.
    for (const ack of ["0", "false", "true", "yes", ""]) {
      expect(() => assertAuthModeBootSafe("dev", "production", ack), `ack=${ack}`)
        .toThrow(PasswordlessAuthInProductionError);
    }
  });
});
