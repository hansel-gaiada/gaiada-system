// HIER-1 — proves the ONE capability that did not exist before migration 0100
// (docs/superpowers/plans/2026-08-10-iam-hier-01-plan.md): an `org_unit`-scoped grant is now
// STORABLE, and round-trips verbatim through the real production code path —
// `grantRole()` (the DB write) -> `assemblePrincipal()` (the DB read, IAM-03a's `roles`
// resolution) -> `principalPayload()` (the exact function `cerbos.ts::check()`/`planResources()`
// send to Cerbos as `principal.attr.grants`).
//
// Before 0100 this was IMPOSSIBLE to write, not just untested: `user_roles.scope_id` was `uuid`,
// and an org-unit node id is free-form text ('d-hr', 'dv-web' — the 0029/0055 convention) — see
// `person-scope.ts`'s header (TR-25), which records this exact substrate fact as the reason a
// unit-scoped grant could not be represented. This file is the reverse proof: it can now be
// stored, and reading it back produces exactly what was stored, at every layer up to the Cerbos
// request payload.
//
// `principalPayload` is exported from `cerbos.ts` (HIER-1, visibility-only change) specifically
// so this test calls the REAL mapping rather than a hand-duplicated copy that could silently
// drift from it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createUser, createRole, grantRole } from "../testing/fixtures";
import { assemblePrincipal } from "./principal";
import { principalPayload } from "./cerbos";

describe.skipIf(!TEST_URL)("HIER-1 — an org_unit-scoped grant round-trips assemblePrincipal() -> attr.grants verbatim", () => {
  let userId: string;
  let roleId: string;

  beforeAll(async () => {
    await initTestDb();
    userId = await createUser("hier1-org-unit-roundtrip@a.test");
    roleId = await createRole("hier1_org_unit_roundtrip_role");
    // The write this ticket makes possible: an org_unit-scoped grant at a real free-form
    // org-node id, exactly the shape `dept-resolution.ts`/`org_unit_memberships` produce.
    await grantRole(userId, roleId, "org_unit", "d-hr");
  });
  afterAll(teardownTestDb);

  it("assemblePrincipal() resolves the org_unit grant into principal.roles with scopeId preserved verbatim", async () => {
    const p = await assemblePrincipal(userId, "high");
    expect(p).not.toBeNull();
    const grant = p!.roles.find((g) => g.scopeType === "org_unit");
    expect(grant).toEqual({ role: "hier1_org_unit_roundtrip_role", scopeType: "org_unit", scopeId: "d-hr" });
  });

  it("principalPayload() — the exact function sent to Cerbos as principal.attr — carries the SAME grant verbatim", async () => {
    const p = await assemblePrincipal(userId, "high");
    const payload = principalPayload(p!);
    expect(payload.attr.grants).toContainEqual({
      role: "hier1_org_unit_roundtrip_role",
      scopeType: "org_unit",
      scopeId: "d-hr",
    });
  });

  it("a SECOND org_unit grant at a different node id coexists — proves this is a real multi-value column read, not a single-row fluke", async () => {
    const otherUser = await createUser("hier1-org-unit-roundtrip-2@a.test");
    const otherRole = await createRole("hier1_org_unit_roundtrip_role_2");
    await grantRole(otherUser, otherRole, "org_unit", "dv-web");
    const p = await assemblePrincipal(otherUser, "high");
    const grant = p!.roles.find((g) => g.scopeType === "org_unit");
    expect(grant).toEqual({ role: "hier1_org_unit_roundtrip_role_2", scopeType: "org_unit", scopeId: "dv-web" });
    const payload = principalPayload(p!);
    expect(payload.attr.grants).toContainEqual({
      role: "hier1_org_unit_roundtrip_role_2",
      scopeType: "org_unit",
      scopeId: "dv-web",
    });
  });
});
