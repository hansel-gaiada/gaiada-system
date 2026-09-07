// AD-2 — pure-function coverage for agency-intake-tokens.service.ts.
//
// NO DB: DATABASE_URL_TEST is unset and the 16-container stack is off by owner decision. Every
// function this suite calls is one that never opens a connection — `hashIntakeToken` and
// `computeExpiresAt` are pure, and `AGENCY_INTAKE_LOCK_NS` is a constant. `mintInviteToken`,
// `revokeIntakeToken` and `findIntakeTokenByPlaintext` all call `withTenants` (a real Postgres
// round-trip) and are DELIBERATELY NOT exercised here — see this ticket's report for what remains
// unverified.
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  AGENCY_INTAKE_LOCK_NS,
  hashIntakeToken,
  computeExpiresAt,
  setInviteTokenTtlMsForTests,
} from "./agency-intake-tokens.service";

describe("AGENCY_INTAKE_LOCK_NS", () => {
  it("is the design's namespace constant — 'AI' + 1 (design §6.1)", () => {
    expect(AGENCY_INTAKE_LOCK_NS).toBe(0x41490001);
  });

  it("is distinct from the pipeline run lock namespace, so a token-id hash can never collide with a run-id hash", () => {
    const PIPELINE_RUN_LOCK_NS = 0x50520001;
    expect(AGENCY_INTAKE_LOCK_NS).not.toBe(PIPELINE_RUN_LOCK_NS);
  });
});

describe("hashIntakeToken", () => {
  it("is deterministic — the same plaintext always hashes the same", () => {
    const a = hashIntakeToken("same-plaintext");
    const b = hashIntakeToken("same-plaintext");
    expect(a.equals(b)).toBe(true);
  });

  it("is sha256 of the utf8 plaintext, matching node's own digest byte-for-byte", () => {
    const expected = createHash("sha256").update("hello-token", "utf8").digest();
    expect(hashIntakeToken("hello-token").equals(expected)).toBe(true);
  });

  it("distinct plaintexts hash to distinct values", () => {
    const a = hashIntakeToken("token-a");
    const b = hashIntakeToken("token-b");
    expect(a.equals(b)).toBe(false);
  });

  it("returns a 32-byte Buffer — the shape the bytea column and the pg driver both expect", () => {
    expect(Buffer.isBuffer(hashIntakeToken("x"))).toBe(true);
    expect(hashIntakeToken("x").length).toBe(32);
  });

  it("a single-character difference in the plaintext still changes every byte class of trust — no shared prefix reliance", () => {
    // Not a cryptographic proof (that's sha256's job), just a regression guard against someone
    // "optimizing" this into a non-cryptographic hash later.
    const a = hashIntakeToken("gVeryLongOpaqueTokenPlaintextAAAA");
    const b = hashIntakeToken("gVeryLongOpaqueTokenPlaintextAAAB");
    expect(a.equals(b)).toBe(false);
  });
});

describe("computeExpiresAt", () => {
  afterEach(() => setInviteTokenTtlMsForTests(null));

  it("defaults to 30 days out (design §11 OQ-4)", () => {
    const now = Date.now();
    const deltaMs = new Date(computeExpiresAt()).getTime() - now;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    // Generous slack for test execution time; never for the constant's correctness.
    expect(Math.abs(deltaMs - thirtyDaysMs)).toBeLessThan(5_000);
  });

  it("honours an explicit ttlMs override, ignoring the default entirely", () => {
    const deltaMs = new Date(computeExpiresAt(1_000)).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(0);
    expect(deltaMs).toBeLessThan(2_000);
  });

  it("setInviteTokenTtlMsForTests changes the default the same way an explicit ttlMs would", () => {
    setInviteTokenTtlMsForTests(2_000);
    const deltaMs = new Date(computeExpiresAt()).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(0);
    expect(deltaMs).toBeLessThan(3_000);
  });

  it("setInviteTokenTtlMsForTests(null) restores the 30-day default — the test-seam convention every other TTL setter in this codebase follows", () => {
    setInviteTokenTtlMsForTests(1_000);
    setInviteTokenTtlMsForTests(null);
    const deltaMs = new Date(computeExpiresAt()).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  });
});
