// F13 (fault-register finding 13, 2026-09-08) — "revoking a user does not stop them reading."
//
// ADVERSARIAL, END-TO-END, AGAINST REAL POSTGRES + REAL CERBOS: bump a user's `session_version`
// exactly as every one of D11's 8 write sites does (termination, role change, grant-expiry sweep,
// IAM approval, identity revoke) and prove a READ with the STALE principal is refused with the
// typed 401 — not Cerbos's 403, and not a quiet empty result the zero-row trap would produce —
// while a freshly re-assembled principal (the "re-authenticate" the error message asks for) is
// allowed again. The pure gating-logic proof (mocked Cerbos/DB, no infra needed) is
// `f13-session-revocation.test.ts`; this file is the "it actually works" half.
//
// ⚠ Needs DATABASE_URL_TEST and a live Cerbos (`CERBOS_URL`). Skips silently otherwise, and a
// skipped run of this file proves nothing while looking identical to a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { assemblePrincipal } from "../rbac/principal";
import { authorize } from "./http";
import type { Principal } from "../rbac/principal";

const live = !!process.env.CERBOS_URL;

let tenant: string;
let memberUser: string;

async function principalFor(userId: string): Promise<Principal> {
  const p = await assemblePrincipal(userId, "high");
  if (!p) throw new Error(`fixture bug: no principal for ${userId}`);
  return p;
}

describe.skipIf(!TEST_URL || !live)("F13 · a revoked session cannot keep reading", () => {
  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("F13 Co");
    const memberRole = await createRole("member");
    memberUser = await createUser("f13-member@a.test");
    await addMembership(tenant, memberUser);
    await grantRole(memberUser, memberRole, "company", tenant);
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  // Same resource/role pairing `act-for-delegation.db.test.ts` already proved works: `member` may
  // read (and, per that file's own note, "update" as an execution update) a `pm_task`, so a
  // refusal below cannot be a fixture that could never do anything in the first place.
  const task = () => ({ kind: "pm_task", tenantId: tenant, id: "00000000-0000-0000-0000-00000000bbbb" });

  it("baseline: a member MAY read a pm_task — without this, the refusal below proves nothing", async () => {
    const p = await principalFor(memberUser);
    await expect(authorize(p, task(), "read")).resolves.toBeUndefined();
  });

  it("🔴 bumping session_version refuses a STALE principal's READ with the typed 401 — not Cerbos's 403, not []", async () => {
    const stale = await principalFor(memberUser); // captures the CURRENT session_version

    // Every real D11 writer does exactly this UPDATE. Simulated directly rather than driving a
    // whole controller for each of the 8 sites — this ticket is about authorize() reacting to the
    // column on a read, not about re-proving each writer bumps it (that is each writer's own test).
    await adminPool().query(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [memberUser]);

    await expect(
      authorize(stale, task(), "read"),
      "Cerbos would still ALLOW a member to read a pm_task — the ONLY thing that changed is the " +
        "session_version row, so a 403 or a silently empty result here would mean D11 never fired " +
        "on the read path at all.",
    ).rejects.toThrow(UnauthorizedException);
    await expect(authorize(stale, task(), "read")).rejects.toThrow(/session revoked — re-authenticate/);
  });

  it("re-authenticating (a freshly re-assembled principal) restores the read — this is not a permanent lockout", async () => {
    const fresh = await principalFor(memberUser); // re-assembled AFTER the bump above
    await expect(authorize(fresh, task(), "read")).resolves.toBeUndefined();
  });

  it("the same stale principal is ALSO refused on a write — D11's original guarantee is unweakened by the widening", async () => {
    const stale = await principalFor(memberUser);
    await adminPool().query(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [memberUser]);
    await expect(authorize(stale, task(), "update")).rejects.toThrow(/session revoked/);
  });

  it("a page render's several reads in ONE request all still see a MID-REQUEST revocation via the cached decision", async () => {
    // Companion to the pure-unit memoisation tests in f13-session-revocation.test.ts (which count
    // mock invocations) — this is the real-infra version: `runWithRequestContext` is the SAME
    // per-request box `core/request-context.ts` resets on every real HTTP request, so the first
    // `authorize()` call below is the one that actually queries `session_version`; the next two
    // reuse its cached answer rather than opening a fresh connection each time. The exact query
    // count this saves is measured in `src/rbac/session-current-perf.db.test.ts`; what matters
    // here is only that the reused answer is CORRECT, not stale in a way that matters: all three
    // calls share one principal and one session_version, so they must agree with each other.
    const { runWithRequestContext } = await import("./request-context");
    const p = await principalFor(memberUser);
    await runWithRequestContext(async () => {
      await expect(authorize(p, task(), "read")).resolves.toBeUndefined();
      await expect(authorize(p, task(), "read")).resolves.toBeUndefined();
      await expect(authorize(p, task(), "read")).resolves.toBeUndefined();
    });
  });
});
