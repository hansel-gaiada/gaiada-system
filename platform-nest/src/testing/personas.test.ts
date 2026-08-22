// IAM-06b — proves the persona fixture's ergonomics in BOTH directions (ALLOW and DENY), against
// a real HTTP round-trip (app.inject) over a real Cerbos decision, not an internal function call.
// This is the reference example the README points at — if this file stops reading like "one line
// per persona", the helper needs redesigning, not this test.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "./setup";
import { seedPersonaTenant, isDeniedStatus, ALL_PERSONA_KEYS } from "./personas";

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

  // HIER-3 (2026-08-11): `team_lead` is retired; `org_unit_lead` (HIER-2's subtree-cascade
  // replacement) is the persona now. `resource_device.yaml` does NOT list `org_unit_lead` at all
  // (the role's only two landing surfaces are report_document.read_department and appraisal.read,
  // per HIER-2's own "ship what a handler feeds, not what would recreate the dead-grant pattern"
  // rule), and device carries no `unitAncestors` attribute regardless — so the honest answer for
  // org_unit_lead on /it/devices is DENY, not the ALLOW every other staff tier gets, for a
  // different (and now genuinely correct-by-design) reason than team_lead's old dead-tier bug.
  it("DENY — org_unit_lead has no landing rule on /it/devices at all (its two rules are report_document/appraisal only)", async () => {
    const p = await seedPersonaTenant(["org_unit_lead"]);
    const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/it/devices`, headers: p.as("org_unit_lead") });
    expect(isDeniedStatus(res.statusCode)).toBe(true);
  });

  it("the client_contact persona is portal-only — has NO staff membership row", async () => {
    const p = await seedPersonaTenant(["client_contact"]);
    // Asking for the staff device registry as a client contact must be denied, not 500 — a client
    // contact is not `inTenant` via company_memberships at all.
    const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/it/devices`, headers: p.as("client_contact") });
    expect(isDeniedStatus(res.statusCode)).toBe(true);
  });

  it("asking for a persona not in the seeded set throws loudly, not a silent 401", async () => {
    const p = await seedPersonaTenant(["manager"]);
    expect(() => p.as("org_unit_lead")).toThrow(/was not seeded/);
  });

  it("🔴 IAM-15 — `group_executive` is no longer a seedable persona at all", () => {
    // Was: "group_executive is seeded (D-7: obsolete, not yet removed) and still passes the wildcard".
    // D-7 has now removed it, so the persona is gone from PERSONA_DEFS and the KEY itself no longer
    // typechecks — which is why this asserts against the registry rather than trying to seed it.
    expect(ALL_PERSONA_KEYS as readonly string[]).not.toContain("group_executive");
  });

  it("control: the wildcard tier still works — platform_admin reaches the same route", async () => {
    // The positive half of the case above. Without it, the removal could have taken the whole
    // wildcard path with it and this file would not notice.
    // `superadmin` is this registry's key for the platform_admin grant — not "platform_admin",
    // which is the ROLE name. The two vocabularies differ here and the type catches it.
    const p = await seedPersonaTenant(["superadmin"]);
    const res = await app.inject({ method: "GET", url: `/api/${p.tenantId}/it/devices`, headers: p.as("superadmin") });
    expect(res.statusCode).toBe(200);
  });
});
