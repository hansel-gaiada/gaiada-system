// PV5-14 / PV-D40 — the simulated step-up's pure rules, with an in-memory Redis stand-in (no database, no Cerbos).
// The HTTP-level proof is step-up.test.ts; this file pins the per-request raise in isolation so the flag, the
// session binding, the kind gate and the expiry each fail a test on their own.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Redis from "ioredis";
import { config } from "../config";
import { setRedis } from "../events/redis";
import type { Principal } from "../rbac/principal";
import {
  STEP_UP_TTL_MS, applySimulatedStepUp, recordSimulatedStepUp, sessionIdFromClaims, sessionRefFor, setStepUpClockForTest,
} from "./step-up";

function fakeRedis(): Redis {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => {
      m.set(k, v);
      return "OK";
    },
    del: async (k: string) => (m.delete(k) ? 1 : 0),
  } as unknown as Redis;
}

const USER = "11111111-0514-0000-0000-000000000001";
const OTHER = "11111111-0514-0000-0000-000000000002";
const linked = (over: Partial<Principal> = {}): Principal => ({
  userId: USER, kind: "employee", assurance: "linked", companies: ["c1"], rootCompanies: ["c1"],
  roles: [{ role: "finance_manager", scopeType: "company", scopeId: "c1" }], perms: [], sessionVersion: 1, ...over,
});

describe("PV5-14 · simulated step-up rules (unit)", () => {
  const origFlag = config.mfaSimulationEnabled;
  beforeEach(() => {
    setRedis(fakeRedis());
    config.mfaSimulationEnabled = true;
  });
  afterEach(() => {
    setRedis(null);
    setStepUpClockForTest(null);
    config.mfaSimulationEnabled = origFlag;
  });

  it("reads the IdP session from `sid`, else `session_state`; nothing else counts", () => {
    expect(sessionIdFromClaims({ sid: "s1", session_state: "s2" })).toBe("s1");
    expect(sessionIdFromClaims({ session_state: "s2" })).toBe("s2");
    expect(sessionIdFromClaims({ sid: "" })).toBeNull();
    expect(sessionIdFromClaims({ sid: 42 })).toBeNull();
    expect(sessionIdFromClaims({})).toBeNull();
  });

  it("the session reference binds user AND session: either one different is a different reference", () => {
    const a = sessionRefFor(USER, "sess-A");
    expect(sessionRefFor(USER, "sess-A")).toBe(a);
    expect(sessionRefFor(USER, "sess-B")).not.toBe(a);
    expect(sessionRefFor(OTHER, "sess-A")).not.toBe(a);
    expect(a).not.toContain("sess-A");
  });

  it("a recorded step-up raises THIS session's linked employee to high, marked simulated, with its expiry", async () => {
    const ref = sessionRefFor(USER, "sess-A");
    const rec = await recordSimulatedStepUp(USER, ref);
    const p = await applySimulatedStepUp(linked(), ref);
    expect(p).toMatchObject({ assurance: "high", assuranceSource: "simulated", assuranceExpiresAt: rec.expiresAt });
  });

  it("★ flag off: nothing is raised, even with a live record", async () => {
    const ref = sessionRefFor(USER, "sess-A");
    await recordSimulatedStepUp(USER, ref);
    config.mfaSimulationEnabled = false;
    expect((await applySimulatedStepUp(linked(), ref)).assurance).toBe("linked");
  });

  it("★ another session of the same user is not raised; neither is a token with no session", async () => {
    await recordSimulatedStepUp(USER, sessionRefFor(USER, "sess-A"));
    expect((await applySimulatedStepUp(linked(), sessionRefFor(USER, "sess-B"))).assurance).toBe("linked");
    expect((await applySimulatedStepUp(linked(), null)).assurance).toBe("linked");
  });

  it("★ a record never lends itself to another user", async () => {
    const ref = sessionRefFor(USER, "sess-A");
    await recordSimulatedStepUp(USER, ref);
    expect((await applySimulatedStepUp(linked({ userId: OTHER }), ref)).assurance).toBe("linked");
  });

  it("★ only an employee: client, bot, automation and a kind-less principal stay linked", async () => {
    const ref = sessionRefFor(USER, "sess-A");
    await recordSimulatedStepUp(USER, ref);
    for (const kind of ["client", "bot", "automation", undefined] as const) {
      expect((await applySimulatedStepUp(linked({ kind }), ref)).assurance, String(kind)).toBe("linked");
    }
  });

  it("never touches a real high, and never lifts low", async () => {
    const ref = sessionRefFor(USER, "sess-A");
    await recordSimulatedStepUp(USER, ref);
    const real = await applySimulatedStepUp(linked({ assurance: "high" }), ref);
    expect(real.assurance).toBe("high");
    expect(real.assuranceSource).toBeUndefined();
    expect((await applySimulatedStepUp(linked({ assurance: "low" }), ref)).assurance).toBe("low");
  });

  it("★ expires at 15 minutes, decided by the stored expiry and the clock (not the store's TTL)", async () => {
    const t0 = Date.parse("2026-10-13T08:00:00Z");
    setStepUpClockForTest(() => t0);
    const ref = sessionRefFor(USER, "sess-A");
    await recordSimulatedStepUp(USER, ref);
    setStepUpClockForTest(() => t0 + STEP_UP_TTL_MS - 1);
    expect((await applySimulatedStepUp(linked(), ref)).assurance).toBe("high");
    setStepUpClockForTest(() => t0 + STEP_UP_TTL_MS);
    expect((await applySimulatedStepUp(linked(), ref)).assurance).toBe("linked");
  });

  it("a store that cannot be read fails closed to linked", async () => {
    setRedis({ get: async () => { throw new Error("down"); } } as unknown as Redis);
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      expect((await applySimulatedStepUp(linked(), sessionRefFor(USER, "sess-A"))).assurance).toBe("linked");
    } finally {
      console.error = orig;
    }
    expect(errors).toHaveLength(1);
  });
});
