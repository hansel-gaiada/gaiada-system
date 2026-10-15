import { describe, it, expect } from "vitest";
import { canBeRevoked, createSessionCutoff, isRevoked, snapshotOf, REVOCATION_CACHE_TTL_MS, type RevocationRow } from "./session-cutoff";

// DW-7h (BFF §52.4): which tokens a revocation row cuts. The DB half (the query, `expires_at`) is in
// request-guard.db.test.ts; this pins the matching rules.
const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";
const at = (iso: string) => new Date(iso);
const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const rows: RevocationRow[] = [
  { user_id: ALICE, session_id: "sess-signed-out", revoked_at: at("2026-10-15T10:00:00.000Z") },
  { user_id: BOB, session_id: null, revoked_at: at("2026-10-15T09:00:00.000Z") },
  { user_id: BOB, session_id: null, revoked_at: at("2026-10-15T11:00:00.500Z") }, // the later block wins
];
const snap = snapshotOf(rows);

describe("isRevoked", () => {
  it("cuts a token whose sid IT signed out", () => {
    expect(isRevoked(snap, { userId: ALICE, sessionId: "sess-signed-out", tokenIssuedAt: secs("2026-10-15T09:59:00Z") })).toBe(true);
  });

  it("leaves the same user's other sessions alone", () => {
    expect(isRevoked(snap, { userId: ALICE, sessionId: "sess-other", tokenIssuedAt: secs("2026-10-15T09:00:00Z") })).toBe(false);
  });

  it("'Block login' cuts a token issued before the latest block, and not one issued after it", () => {
    expect(isRevoked(snap, { userId: BOB, sessionId: "s1", tokenIssuedAt: secs("2026-10-15T10:30:00Z") })).toBe(true);
    expect(isRevoked(snap, { userId: BOB, sessionId: "s2", tokenIssuedAt: secs("2026-10-15T11:00:01Z") })).toBe(false);
  });

  it("compares in milliseconds: a token issued in the same second as the block is cut", () => {
    // iat 11:00:00 (whole seconds) against a block at 11:00:00.500.
    expect(isRevoked(snap, { userId: BOB, sessionId: null, tokenIssuedAt: secs("2026-10-15T11:00:00Z") })).toBe(true);
  });

  it("does not apply the user rule without an iat (the dev and OBO paths), nor to another user", () => {
    expect(isRevoked(snap, { userId: BOB, sessionId: null })).toBe(false);
    expect(isRevoked(snap, { userId: BOB, sessionId: null, tokenIssuedAt: null })).toBe(false);
    expect(isRevoked(snap, { userId: ALICE, sessionId: null, tokenIssuedAt: secs("2026-10-15T08:00:00Z") })).toBe(false);
  });

  it("has nothing to match for a request with no sid and no iat", () => {
    expect(canBeRevoked({ userId: ALICE })).toBe(false);
    expect(canBeRevoked({ userId: ALICE, sessionId: "s" })).toBe(true);
    expect(canBeRevoked({ userId: ALICE, tokenIssuedAt: 1 })).toBe(true);
  });
});

describe("createSessionCutoff", () => {
  it("reads the table at most once per 10 seconds, and sees a new revocation after that", async () => {
    let t = 1_000_000;
    let table: RevocationRow[] = [];
    let loads = 0;
    const cutoff = createSessionCutoff(async () => { loads += 1; return snapshotOf(table); }, () => t);
    const tok = { userId: ALICE, sessionId: "sess-x", tokenIssuedAt: 1 };

    expect(await cutoff.isRevoked(tok)).toBe(false);
    table = [{ user_id: ALICE, session_id: "sess-x", revoked_at: new Date() }];
    t += REVOCATION_CACHE_TTL_MS - 1;
    expect(await cutoff.isRevoked(tok)).toBe(false); // still the cached snapshot
    t += 1;
    expect(await cutoff.isRevoked(tok)).toBe(true);
    expect(loads).toBe(2);
  });

  it("makes no lookup for a request that carries nothing to match", async () => {
    let loads = 0;
    const cutoff = createSessionCutoff(async () => { loads += 1; return snapshotOf([]); });
    expect(await cutoff.isRevoked({ userId: ALICE })).toBe(false);
    expect(loads).toBe(0);
  });

  it("fails the request when the lookup fails, rather than letting it past", async () => {
    const cutoff = createSessionCutoff(async () => { throw new Error("db down"); });
    await expect(cutoff.isRevoked({ userId: ALICE, sessionId: "s" })).rejects.toThrow("db down");
  });
});
