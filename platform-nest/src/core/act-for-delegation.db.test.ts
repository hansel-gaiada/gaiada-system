// AGN-7 / [agent-attribution-gate] STEP 2 — delegation: effective permission = caller ∩ acting user.
//
// Owner-accepted 2026-08-22, over the alternative (persona authority + a redaction layer), because
// this is an architectural guarantee rather than a filter that must be right on every field forever.
//
// THE PROBLEM. `Principal` holds ONE `userId` and OBO resolves to either the human or the bot, so
// there was no delegation at all: whichever identity the envelope named acted with that identity's
// FULL authority. "A persona helps an employee within that employee's scope" was inexpressible — a
// persona holding `hr_manager` helping a junior would act as hr_manager.
//
// THE MODEL. `authorize()` checks Cerbos TWICE — once as the caller, once as the human named by
// `x-act-for` — and denies if EITHER denies.
//
// ⚠ WHAT THESE TESTS ARE REALLY FOR: the claim that a HEADER may decide authorization. That is only
// defensible because an intersection is MONOTONICALLY NARROWING — presenting an `actFor` can never
// grant the caller anything it lacked alone. Asserting that in a comment is worthless; both
// directions are proven below, including the case where the acting user is far MORE privileged than
// the caller and the call is still refused.
//
// ⚠ Needs DATABASE_URL_TEST and a live Cerbos. Skips silently otherwise, and a skipped run of this
// file proves nothing while looking identical to a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { assemblePrincipal } from "../rbac/principal";
import { authorize } from "./http";
import type { Principal } from "../rbac/principal";

const live = !!process.env.CERBOS_URL;

let tenant: string;
let manager: string;      // may DELETE a pm task
let member: string;       // may read/update, may NOT delete
let persona: string;      // a bot-kind principal holding the manager role
let weakPersona: string;  // a bot-kind principal holding only member

async function principalFor(userId: string): Promise<Principal> {
  const p = await assemblePrincipal(userId, "high");
  if (!p) throw new Error(`fixture bug: no principal for ${userId}`);
  return p;
}

describe.skipIf(!TEST_URL || !live)("AGN-7 · act-for delegation is an intersection", () => {
  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("ActFor Co");

    const managerRole = await createRole("manager");
    const memberRole = await createRole("member");

    manager = await createUser("actfor-manager@a.test");
    member = await createUser("actfor-member@a.test");
    persona = await createUser("persona-hr@a.test");
    weakPersona = await createUser("persona-weak@a.test");

    for (const u of [manager, member, persona, weakPersona]) await addMembership(tenant, u);
    await grantRole(manager, managerRole, "company", tenant);
    await grantRole(member, memberRole, "company", tenant);
    await grantRole(persona, managerRole, "company", tenant);
    await grantRole(weakPersona, memberRole, "company", tenant);

    // PK-01: personas are `bot`, not people. Set explicitly so this suite exercises the real shape
    // rather than an employee pretending to be a persona.
    await adminPool().query(`UPDATE users SET kind = 'bot' WHERE id = ANY($1)`, [[persona, weakPersona]]);
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  const task = () => ({ kind: "pm_task", tenantId: tenant, id: "00000000-0000-0000-0000-00000000aaaa" });

  it("baseline: the persona alone MAY delete, and the plain member alone MAY NOT", async () => {
    // ⚠ This control already earned its keep: the first version used "update", which the policy
    // grants to member/viewer as an "execution update". Every intersection assertion below would
    // have passed for the wrong reason — both sides allowed — while proving nothing. `delete` is
    // company_admin/manager only, so it genuinely separates the two fixtures.
    // Positive controls first. Without these, every refusal below could be a fixture that cannot do
    // anything at all, and the intersection would look enforced while being untested.
    await expect(authorize(await principalFor(persona), task(), "delete")).resolves.toBeUndefined();
    await expect(authorize(await principalFor(member), task(), "delete")).rejects.toThrow(ForbiddenException);
  });

  it("🔴 the capable persona is REFUSED when acting for someone who may not — the intersection bites", async () => {
    const p = { ...(await principalFor(persona)), actFor: { userId: member } };
    await expect(
      authorize(p, task(), "delete"),
      "the persona may delete and was acting for a member who may not; an intersection must refuse. " +
        "If this passes, a persona lends its own authority to whoever it serves — the escalation this " +
        "whole mechanism exists to prevent",
    ).rejects.toThrow(/on behalf of that user/);
  });

  it("the same persona acting for a CAPABLE user is allowed — narrowing, not blanket refusal", async () => {
    // The other half of the pair. A mechanism that refused every delegated call would also pass the
    // test above, and would be useless.
    const p = { ...(await principalFor(persona)), actFor: { userId: manager } };
    await expect(authorize(p, task(), "delete")).resolves.toBeUndefined();
  });

  it("🔴 MONOTONICALLY NARROWING: a weak caller acting for a POWERFUL user is still refused", async () => {
    // This is the property that makes trusting the header defensible. The acting user here is a
    // manager who genuinely may update; the caller may not. If delegation could ever ADD reach, this
    // would succeed and `x-act-for` would be a privilege-escalation primitive.
    const p = { ...(await principalFor(weakPersona)), actFor: { userId: manager } };
    await expect(
      authorize(p, task(), "delete"),
      "a caller gained reach by naming a more privileged user. `x-act-for` must only ever subtract.",
    ).rejects.toThrow(ForbiddenException);
  });

  it("the caller's OWN denial is reported as its own, not as the acting user's", async () => {
    // Error legibility, deliberately pinned: the caller is checked first so a persona lacking the
    // capability outright is refused for its own missing reach. Reporting "Alice may not do this"
    // when the truth is "this persona may not, for anyone" sends debugging after the wrong identity.
    const p = { ...(await principalFor(weakPersona)), actFor: { userId: manager } };
    await expect(authorize(p, task(), "delete")).rejects.toThrow(/^(?!.*on behalf of).*not authorized/s);
  });

  it("an unresolvable acting user FAILS CLOSED rather than falling back to the caller's authority", async () => {
    const p = { ...(await principalFor(persona)), actFor: { userId: "00000000-0000-0000-0000-0000000000ff" } };
    await expect(
      authorize(p, task(), "delete"),
      "a bad act-for must refuse. Proceeding with the caller's own authority would silently convert " +
        "a delegated call into a full-authority one — the escalation, arrived at by accident.",
    ).rejects.toThrow(/acts for is unknown or inactive/);
  });

  it("actFor naming the caller itself is a no-op, not a second redundant check", async () => {
    const p = { ...(await principalFor(persona)), actFor: { userId: persona } };
    await expect(authorize(p, task(), "delete")).resolves.toBeUndefined();
  });

  it("the acting user's authority is read FRESH, so a DISABLED human cannot be acted for", async () => {
    // Replaces a first attempt that bumped `session_version` and expected a D11 failure. It could
    // never fail: the acting user's principal is assembled inside authorize() from the database, so
    // its session_version is current by construction. That is a stronger guarantee than D11 (no
    // stale window at all), and the redundant check was removed rather than left looking meaningful.
    //
    // What IS worth pinning is the freshness itself: a human disabled after the caller obtained its
    // own principal must stop being actable-for on the very next call.
    const target = await createUser("actfor-disabled@a.test");
    await addMembership(tenant, target);
    await grantRole(target, await createRole("manager"), "company", tenant);
    const p = { ...(await principalFor(persona)), actFor: { userId: target } };
    // Allowed while active — the positive half, without which the refusal below proves nothing.
    await expect(authorize(p, task(), "delete")).resolves.toBeUndefined();

    await adminPool().query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [target]);
    await expect(
      authorize(p, task(), "delete"),
      "a disabled human was still actable-for. The acting user's state must be read at decision " +
        "time, or a persona becomes a way to keep using a deactivated account.",
    ).rejects.toThrow(/acts for is unknown or inactive/);
  });

  it("a READ is delegated the same way — the intersection is not write-only", async () => {
    const p = { ...(await principalFor(persona)), actFor: { userId: member } };
    // `member` CAN read a pm_task, so this must be allowed: the point is that reads go through the
    // same second check rather than skipping it.
    await expect(authorize(p, { kind: "pm_task", tenantId: tenant }, "read")).resolves.toBeUndefined();
  });
});
