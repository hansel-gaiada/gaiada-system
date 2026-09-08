// F13 (fault-register finding 13, 2026-09-08) — "revoking a user does not stop them reading."
// D11 (rbac/principal.ts's `sessionVersionCurrent`) used to be re-checked in authorize() for
// mutations only; this file pins the WIDENED gate — every action, guarded on `principal.userId`
// rather than on `action` — and the per-request memoisation added alongside it.
//
// PURE UNIT TEST: Cerbos's `check()` and principal.ts's `sessionVersionCurrent`/`auditDecision`
// are all mocked, so this file needs neither a live Postgres nor a live Cerbos — it pins
// `authorize()`'s OWN gating logic (which branch calls which function, and when, and how often) in
// isolation from whether the underlying systems are reachable. The end-to-end proof — a REAL
// revoked session refusing a REAL read against REAL Cerbos and RLS — is
// `f13-session-revocation.db.test.ts`.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";

const checkMock = vi.fn();
vi.mock("../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rbac/cerbos")>();
  return { ...actual, check: (...args: unknown[]) => checkMock(...args) };
});

const sessionVersionCurrentMock = vi.fn();
const auditDecisionMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../rbac/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rbac/principal")>();
  return {
    ...actual,
    sessionVersionCurrent: (...args: unknown[]) => sessionVersionCurrentMock(...args),
    auditDecision: (...args: unknown[]) => auditDecisionMock(...args),
  };
});

import { authorize } from "./http";
import { runWithRequestContext } from "./request-context";
import { ANONYMOUS, type Principal } from "../rbac/principal";

const resource = { kind: "employee", tenantId: "11111111-1111-1111-1111-111111111111" };

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: "u-1",
    assurance: "high",
    companies: [resource.tenantId],
    rootCompanies: [resource.tenantId],
    roles: [],
    perms: [],
    sessionVersion: 5,
    ...overrides,
  };
}

beforeEach(() => {
  checkMock.mockReset();
  sessionVersionCurrentMock.mockReset();
  auditDecisionMock.mockReset();
});

describe("F13 · authorize() re-checks D11 on reads, not only writes", () => {
  it("a current session's READ is allowed", async () => {
    checkMock.mockResolvedValue({ allow: true });
    sessionVersionCurrentMock.mockResolvedValue(true);
    await expect(authorize(principal(), resource, "read")).resolves.toBeUndefined();
    expect(sessionVersionCurrentMock).toHaveBeenCalledTimes(1);
  });

  it("a REVOKED session's READ is refused with the typed 401 — not a silent empty result", async () => {
    checkMock.mockResolvedValue({ allow: true }); // Cerbos itself would still allow this read
    sessionVersionCurrentMock.mockResolvedValue(false); // but the session is stale
    await expect(authorize(principal(), resource, "read")).rejects.toThrow(UnauthorizedException);
    await expect(authorize(principal(), resource, "read")).rejects.toThrow(/session revoked/);
  });

  it("Cerbos denial still wins a 403 over a stale session — the session check never runs on a deny", async () => {
    checkMock.mockResolvedValue({ allow: false, reason: "cerbos denied read on employee" });
    sessionVersionCurrentMock.mockResolvedValue(false);
    await expect(authorize(principal(), resource, "read")).rejects.toThrow(ForbiddenException);
    expect(sessionVersionCurrentMock).not.toHaveBeenCalled();
  });

  it("an ANONYMOUS principal's ALLOWED read is not blocked by a phantom session check (hard constraint C)", async () => {
    // An unauthenticated/unresolved-OBO principal has no userId and so no session to be current or
    // stale. Deliberately do NOT stub sessionVersionCurrentMock to resolve true here: the real
    // `sessionVersionCurrent()` returns false unconditionally for a null userId, so if authorize()
    // called it at all for ANONYMOUS, this test would fail closed exactly as it should — the
    // assertion that matters is that it is never CALLED, proving the guard skips it rather than
    // happening to get lucky with a mock default.
    checkMock.mockResolvedValue({ allow: true });
    await expect(authorize({ ...ANONYMOUS }, resource, "read")).resolves.toBeUndefined();
    expect(sessionVersionCurrentMock).not.toHaveBeenCalled();
  });

  it("an ANONYMOUS principal's ALLOWED write is likewise never session-checked (fixes a latent inconsistency, not a new grant)", async () => {
    // Before F13 this path was write-only and STILL called sessionVersionCurrent(ANONYMOUS-shaped),
    // which always returns false — so an anonymous write Cerbos happened to allow would have been
    // thrown "session revoked", a wrong reason for a principal that never had a session. F13 removes
    // that call entirely for null-userId principals, on both actions; nothing about what Cerbos may
    // decide has changed.
    checkMock.mockResolvedValue({ allow: true });
    await expect(authorize({ ...ANONYMOUS }, resource, "update")).resolves.toBeUndefined();
    expect(sessionVersionCurrentMock).not.toHaveBeenCalled();
  });

  it("writes are still covered — the pre-existing D11 behaviour is not weakened", async () => {
    checkMock.mockResolvedValue({ allow: true });
    sessionVersionCurrentMock.mockResolvedValue(false);
    await expect(authorize(principal(), resource, "update")).rejects.toThrow(/session revoked/);
  });
});

describe("F13 · per-request memoisation (core/request-context.ts's memoiseSessionCurrent)", () => {
  it("two authorize() calls in the SAME request share ONE sessionVersionCurrent() call", async () => {
    checkMock.mockResolvedValue({ allow: true });
    sessionVersionCurrentMock.mockResolvedValue(true);
    const p = principal();
    await runWithRequestContext(async () => {
      await authorize(p, resource, "read");
      await authorize(p, { ...resource, kind: "payroll" }, "read");
    });
    expect(sessionVersionCurrentMock).toHaveBeenCalledTimes(1);
  });

  it("two authorize() calls OUTSIDE a request context each recompute — memoisation never survives past a request", async () => {
    checkMock.mockResolvedValue({ allow: true });
    sessionVersionCurrentMock.mockResolvedValue(true);
    const p = principal();
    await authorize(p, resource, "read");
    await authorize(p, resource, "read");
    expect(sessionVersionCurrentMock).toHaveBeenCalledTimes(2);
  });

  it("a revocation between two DIFFERENT requests is never masked, even reusing the SAME principal object", async () => {
    // The scenario the memoisation design comment calls out by name: a caller that captured a
    // principal once (exactly how `act-for-delegation.db.test.ts`'s `principalFor()` helper is
    // reused across several authorize() calls) and calls authorize() with it again later must NOT
    // see a cached "current" from an earlier request bleed into a later one.
    const p = principal();
    checkMock.mockResolvedValue({ allow: true });

    sessionVersionCurrentMock.mockResolvedValueOnce(true);
    await expect(runWithRequestContext(() => authorize(p, resource, "read"))).resolves.toBeUndefined(); // request 1: current

    sessionVersionCurrentMock.mockResolvedValueOnce(false);
    await expect(
      runWithRequestContext(() => authorize(p, resource, "read")), // request 2: revoked meanwhile
    ).rejects.toThrow(/session revoked/);
  });

  it("a mismatched (userId, sessionVersion) key misses the cache instead of returning a stale answer", async () => {
    // Defensive case named in memoiseSessionCurrent's own comment: two DIFFERENT principals should
    // never share a request scope in real life, but if they did, keying on the pair (not caching
    // unconditionally) means the second principal gets its OWN query rather than the first
    // principal's cached answer.
    checkMock.mockResolvedValue({ allow: true });
    sessionVersionCurrentMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const p1 = principal({ userId: "u-1", sessionVersion: 1 });
    const p2 = principal({ userId: "u-2", sessionVersion: 1 });
    await runWithRequestContext(async () => {
      await expect(authorize(p1, resource, "read")).resolves.toBeUndefined();
      await expect(authorize(p2, resource, "read")).rejects.toThrow(/session revoked/);
    });
    expect(sessionVersionCurrentMock).toHaveBeenCalledTimes(2);
  });
});
