// IAM-06b — proves the persona fixture's ergonomics in BOTH directions (ALLOW and DENY), against
// a real HTTP round-trip (app.inject) over a real Cerbos decision, not an internal function call.
// This is the reference example the README points at — if this file stops reading like "one line
// per persona", the helper needs redesigning, not this test.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "./setup";
import { seedPersonaTenant, isDeniedStatus } from "./personas";

describe.skipIf(!TEST_URL)("IAM-06b · persona fixtures — one line, both directions", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("ALLOW — it_admin CAN register a device (resource_device.yaml: create -> company_admin, it_staff)", async () => {
    const p = await seedPersonaTenant(["it_admin"]);
    const res = await app.inject({
      method: "POST",
      url: `/api/${p.tenantId}/it/devices`,
      headers: p.as("it_admin"),
      payload: { name: "Persona Test Switch", kind: "network" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("DENY — viewer CANNOT register a device (resource_device.yaml explicitly excludes it from create)", async () => {
    const p = await seedPersonaTenant(["viewer"]);
    const res = await app.inject({
      method: "POST",
      url: `/api/${p.tenantId}/it/devices`,
      headers: p.as("viewer"),
      payload: { name: "Persona Test Switch", kind: "network" },
    });
    expect(res.statusCode).toBe(403);
    expect(isDeniedStatus(res.statusCode)).toBe(true);
  });

  it("DENY — member CANNOT register a device either (same rule; member is read-only on devices)", async () => {
    const p = await seedPersonaTenant(["member"]);
    const res = await app.inject({
      method: "POST",
      url: `/api/${p.tenantId}/it/devices`,
      headers: p.as("member"),
      payload: { name: "Persona Test Switch", kind: "network" },
    });
    expect(isDeniedStatus(res.statusCode)).toBe(true);
  });

  it("ALLOW — company/member-tier staff personas CAN read the device registry (baseline read rule)", async () => {
    const p = await seedPersonaTenant(["manager", "member", "viewer", "company_admin"]);
    for (const persona of ["manager", "member", "viewer", "company_admin"] as const) {
      const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/it/devices`, headers: p.as(persona) });
      expect(res.statusCode, `persona "${persona}" should be able to read /it/devices`).toBe(200);
    }
  });

  // Caught by writing this test, not assumed going in: `resource_device.yaml` LISTS team_lead in
  // its read rule's derivedRoles, but device is a company-wide resource with no `teamId` attribute
  // — and derived_roles.yaml's `team_lead` condition only activates when
  // `g.scopeId == request.resource.attr.teamId`. A team-scoped grant does NOT blanket-cover a
  // company resource (the exact scope-cascade nuance rbac.ts's own `scopeCovers` comment documents
  // for `can()` — this is the same rule enforced on the Cerbos side). So the honest answer for
  // team_lead on /it/devices is DENY, not the ALLOW every other staff tier gets — and a fixture
  // that assumed otherwise would have hidden a real boundary instead of proving it.
  it("DENY — team_lead is TEAM-scoped and devices carry no teamId attribute, so the read rule never activates for it", async () => {
    const p = await seedPersonaTenant(["team_lead"]);
    const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/it/devices`, headers: p.as("team_lead") });
    expect(isDeniedStatus(res.statusCode)).toBe(true);
  });

  it("the client_contact persona is portal-only — has NO staff membership row", async () => {
    const p = await seedPersonaTenant(["client_contact"]);
    // Asking for the staff device registry as a client contact must be denied, not 500 — a client
    // contact is not `inTenant` via company_memberships at all.
    const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/it/devices`, headers: p.as("client_contact") });
    expect(isDeniedStatus(res.statusCode)).toBe(true);
  });

  it("team_lead is TEAM-scoped — asking for a persona not in the seeded set throws loudly, not a silent 401", async () => {
    const p = await seedPersonaTenant(["manager"]);
    expect(() => p.as("team_lead")).toThrow(/was not seeded/);
  });

  it("group_executive is seeded (D-7: obsolete, not yet removed) and still passes the platform_admin/group_executive wildcard", async () => {
    const p = await seedPersonaTenant(["group_executive"]);
    const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/it/devices`, headers: p.as("group_executive") });
    expect(res.statusCode).toBe(200);
  });
});
