import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { ANONYMOUS, type Principal } from "../../rbac/principal";
import { enforceRequestSecurity, IP_BLOCKED_MESSAGE, SESSION_REVOKED_MESSAGE, type RequestSecurity } from "./request-guard";
import type { AccessSeen } from "./access-recorder";

// DW-7h (BFF §52.3 to §52.5): the hook's order and what each step sees, with the three parts faked. The real parts run
// over HTTP in request-guard.db.test.ts.
const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-00000000000a";

const principal = (over: Partial<Principal> = {}): Principal => ({
  ...ANONYMOUS, userId: USER, assurance: "linked", companies: [TENANT], sessionVersion: 1,
  sessionId: "sess-1", tokenIssuedAt: 1_760_000_000, ...over,
});

function fakes(opts: { revoked?: boolean; blockId?: string | null } = {}) {
  const calls: string[] = [];
  const recorded: AccessSeen[] = [];
  const sec: RequestSecurity = {
    sessionCutoff: { isRevoked: async (tok) => { calls.push(`cutoff:${tok.sessionId}:${tok.tokenIssuedAt}`); return !!opts.revoked; } },
    ipBlocks: {
      blockFor: async (tenantId, ip) => { calls.push(`block:${tenantId}:${ip}`); return opts.blockId ?? null; },
      countHit: (_t, blockId) => { calls.push(`hit:${blockId}`); },
    },
    recorder: { record: (row) => { calls.push("record"); recorded.push(row); } },
  };
  return { sec, calls, recorded };
}

const request = (p: Principal, params: Record<string, string> = { tenantId: TENANT }, headers: Record<string, string> = {}) =>
  ({ principal: p, params, headers, ip: "10.0.0.5" });

describe("enforceRequestSecurity", () => {
  it("passes a clean request through the three steps in order and records it", async () => {
    const f = fakes();
    await enforceRequestSecurity(request(principal(), { tenantId: TENANT }, { "x-gaiada-client-ip": "203.0.113.7", "x-gaiada-client-ua": "Firefox" }), f.sec);
    expect(f.calls).toEqual([`cutoff:sess-1:1760000000`, `block:${TENANT}:203.0.113.7`, "record"]);
    expect(f.recorded).toEqual([{ tenantId: TENANT, userId: USER, sessionId: "sess-1", ip: "203.0.113.7", userAgent: "Firefox" }]);
  });

  it("refuses a revoked session with 401 session_revoked, before the block check and without recording", async () => {
    const f = fakes({ revoked: true, blockId: "b1" });
    const err = await enforceRequestSecurity(request(principal()), f.sec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toEqual({ message: SESSION_REVOKED_MESSAGE, reason: "session_revoked" });
    expect(f.calls).toEqual([`cutoff:sess-1:1760000000`]);
  });

  it("refuses a blocked address with 403 ip_blocked, counts the hit and does not record", async () => {
    const f = fakes({ blockId: "b1" });
    const err = await enforceRequestSecurity(request(principal()), f.sec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toEqual({ message: IP_BLOCKED_MESSAGE, reason: "ip_blocked" });
    expect(f.calls).toEqual([`cutoff:sess-1:1760000000`, `block:${TENANT}:10.0.0.5`, "hit:b1"]);
    expect(f.recorded).toEqual([]);
  });

  it("checks no block and records nothing on a route without :tenantId", async () => {
    const f = fakes({ blockId: "b1" });
    await enforceRequestSecurity(request(principal(), {}), f.sec);
    expect(f.calls).toEqual([`cutoff:sess-1:1760000000`]);
  });

  it("records a token with no sid under session ''", async () => {
    const f = fakes();
    await enforceRequestSecurity(request(principal({ sessionId: null })), f.sec);
    expect(f.recorded[0].sessionId).toBe("");
  });

  it("still applies the address block to a principal with no user, but neither cuts nor records it", async () => {
    const anon: Principal = { ...ANONYMOUS };
    const blocked = fakes({ blockId: "b1" });
    await expect(enforceRequestSecurity(request(anon), blocked.sec)).rejects.toBeInstanceOf(ForbiddenException);
    const clean = fakes();
    await enforceRequestSecurity(request(anon), clean.sec);
    expect(clean.calls).toEqual([`block:${TENANT}:10.0.0.5`]);
  });

  it("uses nginx's address, not the forwarded header, for a request that came through nginx", async () => {
    const f = fakes();
    await enforceRequestSecurity(
      request(principal(), { tenantId: TENANT }, { "x-real-ip": "198.51.100.4", "x-gaiada-client-ip": "203.0.113.7" }),
      f.sec,
    );
    expect(f.calls[1]).toBe(`block:${TENANT}:198.51.100.4`);
    expect(f.recorded[0].ip).toBe("198.51.100.4");
  });
});
