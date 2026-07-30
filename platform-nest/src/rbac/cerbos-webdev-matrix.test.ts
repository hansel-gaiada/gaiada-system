// WD-20 (Phase-1 QA gate, P1-11) — full Cerbos role × ownership matrix for the two WSUX-14/P1-04
// resources that only had partial coverage elsewhere: `work_activity` (read=member-tier,
// create=admin-tier per resource_work_activity.yaml) and `integration_connection` (self-service
// own-row vs company.manage per resource_integration_connection.yaml).
//
// integrations.test.ts and work-activity.test.ts already prove member vs company_admin vs a
// cross-tenant rival admin end-to-end over HTTP+PG+RLS. This file closes the gap the ticket calls
// out explicitly: manager and group_executive (exec) were untested for these two resources, and no
// single place shows the full member/manager/company_admin/exec × own/other/company grid at once.
// Talks to Cerbos directly (same `check()` used by the controllers) — needs live CERBOS_URL,
// skips otherwise (same convention as cerbos.test.ts).
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-1111-0000-0000-000000000001"; // home tenant
const T2 = "aaaaaaaa-1111-0000-0000-000000000002"; // rival tenant
const ME = "user-self";
const OTHER_USER = "user-other";

function principal(role: string, scopeType: RoleGrant["scopeType"], scopeId: string | null, userId = ME): Principal {
  return { userId, assurance: "high", companies: [T1], roles: [{ role, scopeType, scopeId }], sessionVersion: 1 };
}
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

describe.skipIf(!live)("WD-20 Cerbos matrix — work_activity (member/manager/company_admin/exec)", () => {
  const wa: Resource = { kind: "work_activity", tenantId: T1 };
  const waOtherTenant: Resource = { kind: "work_activity", tenantId: T2 };

  it("member: read allowed, ingest (create) denied", async () => {
    const p = principal("member", "company", T1);
    expect(await allow(p, wa, "read")).toBe(true);
    expect(await allow(p, wa, "create")).toBe(false);
  });

  it("manager: read allowed, ingest (create) denied — create is company_admin-only, not manager", async () => {
    const p = principal("manager", "company", T1);
    expect(await allow(p, wa, "read")).toBe(true);
    expect(await allow(p, wa, "create")).toBe(false);
  });

  it("company_admin: read AND ingest (create) allowed within their tenant", async () => {
    const p = principal("company_admin", "company", T1);
    expect(await allow(p, wa, "read")).toBe(true);
    expect(await allow(p, wa, "create")).toBe(true);
  });

  it("company_admin of T1 gets nothing on T2 (cross-tenant deny, independent of RLS)", async () => {
    const p = principal("company_admin", "company", T1);
    expect(await allow(p, waOtherTenant, "read")).toBe(false);
    expect(await allow(p, waOtherTenant, "create")).toBe(false);
  });

  it("exec (group_executive, global scope): read allowed, ingest (create) denied", async () => {
    // WD-20-R1 FIXED 2026-07-30. This test previously asserted read === false, characterizing the
    // gap the QA gate found: resource_work_activity.yaml listed no group_executive rule, and derived
    // roles do NOT cascade (each is gated on an explicit grant of its own name), so a pure exec
    // matched no rule. The policy now carries the same explicit exec carve-out as the sibling
    // resource_integration_connection.yaml, so the correct expectation is read=true. Ingest stays
    // company_admin-only — exec is an oversight role, not a service principal.
    const p: Principal = { userId: ME, assurance: "high", companies: [], roles: [{ role: "group_executive", scopeType: "global", scopeId: null }], sessionVersion: 1 };
    expect(await allow(p, wa, "read")).toBe(true);
    expect(await allow(p, wa, "create")).toBe(false);
  });

  it("platform_admin: full access regardless of tenant", async () => {
    const p: Principal = { userId: ME, assurance: "high", companies: [], roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }], sessionVersion: 1 };
    expect(await allow(p, wa, "create")).toBe(true);
    expect(await allow(p, waOtherTenant, "create")).toBe(true);
  });
});

describe.skipIf(!live)("WD-20 Cerbos matrix — integration_connection (own/other/company × role)", () => {
  const ownRow: Resource = { kind: "integration_connection", tenantId: T1, ownerId: ME };
  const otherUserRow: Resource = { kind: "integration_connection", tenantId: T1, ownerId: OTHER_USER };
  const companyRow: Resource = { kind: "integration_connection", tenantId: T1, ownerId: "" }; // controller convention: ownerId="" for company rows

  it("member: full CRUD on OWN row; denied on another member's row and on company rows", async () => {
    const p = principal("member", "company", T1);
    for (const action of ["read", "create", "update", "delete"]) {
      expect(await allow(p, ownRow, action)).toBe(true);
    }
    for (const action of ["read", "create", "update", "delete"]) {
      expect(await allow(p, otherUserRow, action)).toBe(false);
      expect(await allow(p, companyRow, action)).toBe(false);
    }
  });

  it("manager: company.manage tier — full CRUD on company rows AND other members' rows (+ own)", async () => {
    const p = principal("manager", "company", T1);
    for (const action of ["read", "create", "update", "delete"]) {
      expect(await allow(p, companyRow, action)).toBe(true);
      expect(await allow(p, otherUserRow, action)).toBe(true);
      expect(await allow(p, ownRow, action)).toBe(true);
    }
  });

  it("company_admin: same company.manage tier as manager", async () => {
    const p = principal("company_admin", "company", T1);
    for (const action of ["read", "create", "update", "delete"]) {
      expect(await allow(p, companyRow, action)).toBe(true);
      expect(await allow(p, otherUserRow, action)).toBe(true);
    }
  });

  it("company_admin of T1 is denied on T2's rows — cross-tenant deny", async () => {
    const p = principal("company_admin", "company", T1);
    const t2CompanyRow: Resource = { kind: "integration_connection", tenantId: T2, ownerId: "" };
    for (const action of ["read", "create", "update", "delete"]) {
      expect(await allow(p, t2CompanyRow, action)).toBe(false);
    }
  });

  it("exec (group_executive, global): explicit carve-out — full CRUD on ANY tenant's rows, gated only by assurance", async () => {
    const execP: Principal = { userId: ME, assurance: "high", companies: [], roles: [{ role: "group_executive", scopeType: "global", scopeId: null }], sessionVersion: 1 };
    for (const action of ["read", "create", "update", "delete"]) {
      expect(await allow(execP, companyRow, action)).toBe(true);
      expect(await allow(execP, otherUserRow, action)).toBe(true);
      // cross-tenant too — group_executive is a global, cross-company role for this resource
      expect(await allow(execP, { kind: "integration_connection", tenantId: T2, ownerId: "" }, action)).toBe(true);
    }
  });

  it("exec at LOW assurance is denied (D4 ceiling applies even to the exec carve-out)", async () => {
    const execLow: Principal = { userId: ME, assurance: "low", companies: [], roles: [{ role: "group_executive", scopeType: "global", scopeId: null }], sessionVersion: 1 };
    expect(await allow(execLow, companyRow, "read")).toBe(false);
  });

  it("viewer gets the same self-service-only tier as member (own row only, no company.manage)", async () => {
    const p = principal("viewer", "company", T1);
    expect(await allow(p, ownRow, "read")).toBe(true);
    expect(await allow(p, companyRow, "read")).toBe(false);
    expect(await allow(p, otherUserRow, "update")).toBe(false);
  });

  it("team_lead is listed in the self-service rule but its derived role needs resource.attr.teamId — " +
     "the controller never sets teamId on integration_connection, so a team-scoped grant can never " +
     "derive here even for the caller's OWN row (dead tier for this resource; not exploitable, just noted)", async () => {
    const p: Principal = { userId: ME, assurance: "high", companies: [T1], roles: [{ role: "team_lead", scopeType: "team", scopeId: "team-x" }], sessionVersion: 1 };
    expect(await allow(p, ownRow, "read")).toBe(false);
  });
});
