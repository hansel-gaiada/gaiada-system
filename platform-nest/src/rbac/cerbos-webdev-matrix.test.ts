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
  // MON-00c: rootCompanies mirrors the fixture's single-root world.
  return { userId, assurance: "high", companies: [T1], rootCompanies: [T1], roles: [{ role, scopeType, scopeId }], sessionVersion: 1 };
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

  it("🔴 IAM-15 — exec (group_executive) now reads nothing here either", async () => {
    // This assertion has flipped twice, which is worth recording. It first asserted read === false
    // (WD-20-R1: resource_work_activity.yaml carried no exec rule and derived roles do not cascade),
    // then true when the carve-out was added 2026-07-30 — and now false again, for a different reason
    // than the first time: not a missing rule, but a REMOVED role (D-7). `create` was always denied.
    const p: Principal = { userId: ME, assurance: "high", companies: [], rootCompanies: [T1], roles: [{ role: "group_executive", scopeType: "global", scopeId: null }], sessionVersion: 1 };
    expect(await allow(p, wa, "read")).toBe(false);
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

  it("🔴 IAM-15 — the exec carve-out on integration_connection is GONE, all four actions", async () => {
    // This was the widest exec reach in the estate: full CRUD on any tenant's rows in its root,
    // including the credential vault (`integration_connection` holds connection secrets by reference).
    // D-7's "last unrestricted cross-company business role" was not an abstraction — this rule was it.
    const execP: Principal = { userId: ME, assurance: "high", companies: [], rootCompanies: [T1, T2], roles: [{ role: "group_executive", scopeType: "global", scopeId: null }], sessionVersion: 1 };
    for (const action of ["read", "create", "update", "delete"]) {
      expect(await allow(execP, companyRow, action)).toBe(false);
      expect(await allow(execP, otherUserRow, action)).toBe(false);
      expect(await allow(execP, { kind: "integration_connection", tenantId: T2, ownerId: "" }, action)).toBe(false);
    }
    // Positive control: the kind is still reachable by the tier that should reach it. Without this the
    // twelve DENYs above would pass against a policy file that failed to load at all.
    const admin: Principal = { userId: ME, assurance: "high", companies: [], rootCompanies: [T1], roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }], sessionVersion: 1 };
    expect(await allow(admin, companyRow, "read")).toBe(true);
  });

  it("exec at LOW assurance is denied (D4 ceiling applies even to the exec carve-out)", async () => {
    const execLow: Principal = { userId: ME, assurance: "low", companies: [], rootCompanies: [T1], roles: [{ role: "group_executive", scopeType: "global", scopeId: null }], sessionVersion: 1 };
    expect(await allow(execLow, companyRow, "read")).toBe(false);
  });

  it("viewer gets the same self-service-only tier as member (own row only, no company.manage)", async () => {
    const p = principal("viewer", "company", T1);
    expect(await allow(p, ownRow, "read")).toBe(true);
    expect(await allow(p, companyRow, "read")).toBe(false);
    expect(await allow(p, otherUserRow, "update")).toBe(false);
  });

  // HIER-3 (2026-08-11): the "team_lead is listed in the self-service rule but ... dead tier for
  // this resource" case that used to sit here is REMOVED, not replaced — `team_lead` and the
  // `team` scope_type are retired everywhere, including from
  // resource_integration_connection.yaml's rule list (docs/superpowers/plans/2026-08-11-hier-3-report.md).
});

// W0-4 QA gate — resource_client_contact.yaml. Governance-action tier (create/update/revoke) is
// company_admin/manager only, never member/viewer; read is team-level (everyone delivering
// the work needs to know who the client's stakeholders are). group_executive gets its OWN rule gated
// on `notLow` ONLY, never `inTenant` — the WD-20-R1 lesson: `inTenant` is
// `resource.tenantId in principal.companies`, which never holds for a global grant, so an exec who is
// NOT a member of the tenant must still succeed here, or the separate rule is pointless.
describe.skipIf(!live)("W0-4 Cerbos matrix — client_contact (governance tier vs read tier vs exec)", () => {
  const cc: Resource = { kind: "client_contact", tenantId: T1 };
  const ccT2: Resource = { kind: "client_contact", tenantId: T2 };

  it("company_admin: create/update/revoke AND read allowed within their tenant", async () => {
    const p = principal("company_admin", "company", T1);
    for (const action of ["create", "update", "revoke", "read"]) {
      expect(await allow(p, cc, action)).toBe(true);
    }
  });

  it("manager: create/update/revoke AND read allowed within their tenant (D-2 ratification)", async () => {
    const p = principal("manager", "company", T1);
    for (const action of ["create", "update", "revoke", "read"]) {
      expect(await allow(p, cc, action)).toBe(true);
    }
  });

  it("member: read allowed (team-level), but create/update/revoke denied — inviting an external " +
     "person is a governance action, never plain member", async () => {
    const p = principal("member", "company", T1);
    expect(await allow(p, cc, "read")).toBe(true);
    for (const action of ["create", "update", "revoke"]) {
      expect(await allow(p, cc, action)).toBe(false);
    }
  });

  // HIER-3 (2026-08-11): the "team_lead: listed in the read rule, but SAME dead-tier gap ..." case
  // that used to sit here is REMOVED, not replaced — `team_lead` is retired from
  // resource_client_contact.yaml's rule list too.

  it("viewer: read allowed, create/update/revoke denied", async () => {
    const p = principal("viewer", "company", T1);
    expect(await allow(p, cc, "read")).toBe(true);
    for (const action of ["create", "update", "revoke"]) {
      expect(await allow(p, cc, action)).toBe(false);
    }
  });

  it("company_admin of T1 is denied on T2's rows — cross-tenant deny for the tenant-scoped rules", async () => {
    const p = principal("company_admin", "company", T1);
    for (const action of ["create", "update", "revoke", "read"]) {
      expect(await allow(p, ccT2, action)).toBe(false);
    }
  });

  it("🔴 IAM-15 — group_executive reaches no client_contact, in its root or across it", async () => {
    // `client_contact` is the staff/client trust boundary (design §7), so an exec with CRUD here could
    // reach every client's stakeholder records across the holding. That reach is now gone.
    const execP: Principal = { userId: ME, assurance: "high", companies: [], rootCompanies: [T1, T2], roles: [{ role: "group_executive", scopeType: "global", scopeId: null }], sessionVersion: 1 };
    for (const action of ["read", "create", "update", "revoke"]) {
      expect(await allow(execP, cc, action)).toBe(false);
      expect(await allow(execP, ccT2, action)).toBe(false);
    }
    // Positive control, as above: prove the kind is still reachable by someone.
    const admin: Principal = { userId: ME, assurance: "high", companies: [], rootCompanies: [T1], roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }], sessionVersion: 1 };
    expect(await allow(admin, cc, "read")).toBe(true);
  });

  it("group_executive at LOW assurance is denied (D4 ceiling applies even to the exec carve-out)", async () => {
    const execLow: Principal = { userId: ME, assurance: "low", companies: [], rootCompanies: [T1], roles: [{ role: "group_executive", scopeType: "global", scopeId: null }], sessionVersion: 1 };
    expect(await allow(execLow, cc, "read")).toBe(false);
    expect(await allow(execLow, cc, "create")).toBe(false);
  });

  it("everything is denied at assurance low, regardless of role", async () => {
    for (const role of ["company_admin", "manager", "member", "viewer"]) {
      const p: Principal = { userId: ME, assurance: "low", companies: [T1], roles: [{ role, scopeType: "company", scopeId: T1 }], sessionVersion: 1 };
      for (const action of ["read", "create", "update", "revoke"]) {
        expect(await allow(p, cc, action)).toBe(false);
      }
    }
  });

  it("platform_admin: full access regardless of tenant", async () => {
    const p: Principal = { userId: ME, assurance: "high", companies: [], roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }], sessionVersion: 1 };
    expect(await allow(p, cc, "create")).toBe(true);
    expect(await allow(p, ccT2, "create")).toBe(true);
  });
});

// resource_scope_signoff.yaml was widened 2026-08-03 (D-2 ratification): `create` used to be
// company_admin/exec only, and a `manager` calling it (e.g. the automation account `wf:scope`) was
// correctly 403'd. This proves the widening landed: manager can now create a scope_signoff.
describe.skipIf(!live)("W0-4 Cerbos matrix — scope_signoff.create now includes manager", () => {
  const signoff: Resource = { kind: "scope_signoff", tenantId: T1 };

  it("manager: create allowed (was company_admin/exec only before the D-2 widening)", async () => {
    const p = principal("manager", "company", T1);
    expect(await allow(p, signoff, "create")).toBe(true);
  });

  it("member: create still denied — a named accountable person signs, not any team member", async () => {
    const p = principal("member", "company", T1);
    expect(await allow(p, signoff, "create")).toBe(false);
  });
});

// PRV-03 (provision <-> ERP seam, docs/blueprints/provision-erp-seam-design.md §06) —
// resource_webdev_provisioned_site.yaml. Byte-level sibling of resource_webdev_change_request.yaml
// (same module tiers, same TRAP #4 exec carve-out, same "no client role anywhere" invariant), so
// this matrix mirrors that resource's own coverage rather than inventing a new shape.
describe.skipIf(!live)("PRV-03 Cerbos matrix — webdev_provisioned_site (manager/exec/module tiers, client denial)", () => {
  const site: Resource = { kind: "webdev_provisioned_site", tenantId: T1, module: "webdev" };
  const siteT2: Resource = { kind: "webdev_provisioned_site", tenantId: T2, module: "webdev" };
  const ACTIONS = ["read", "provision", "reconcile"];

  it("company_admin: read + provision + reconcile all ALLOWED within their tenant", async () => {
    const p = principal("company_admin", "company", T1);
    for (const action of ACTIONS) expect(await allow(p, site, action)).toBe(true);
  });

  it("manager: read + provision + reconcile all ALLOWED within their tenant (a staff human driving the manual trigger)", async () => {
    const p = principal("manager", "company", T1);
    for (const action of ACTIONS) expect(await allow(p, site, action)).toBe(true);
  });

  it("manager of T1 is denied on T2's rows — cross-tenant deny, independent of RLS", async () => {
    const p = principal("manager", "company", T1);
    for (const action of ACTIONS) expect(await allow(p, siteT2, action)).toBe(false);
  });

  it("PLAIN MEMBER: denied on every action — no rule in this policy names `member` at all (provisioning is never a plain-member act)", async () => {
    const p = principal("member", "company", T1);
    for (const action of ACTIONS) expect(await allow(p, site, action)).toBe(false);
  });

  it("viewer: denied on every action too (same exclusion as member — this table has no self-service tier)", async () => {
    const p = principal("viewer", "company", T1);
    for (const action of ACTIONS) expect(await allow(p, site, action)).toBe(false);
  });

  it("🔴 IAM-15 — group_executive with no membership is now DENIED read/provision/reconcile (TRAP #4 inverted)", async () => {
    const execNoMembership: Principal = {
      userId: ME,
      assurance: "high",
      companies: [], // no company_memberships row at all — inTenant would be false for ANY tenant-gated rule
      // MON-00c: T1 and T2 anchored as the SAME root — this fixture had no rootCompanies key at all
      // before the boundary landed, which now denies via `inRoot`'s has() guard. T1 and T2 are still
      // cross-company (no membership row in either), which is what this test is about; the anchor
      // just says both belong to the exec's own holding.
      rootCompanies: [T1, T2],
      roles: [{ role: "group_executive", scopeType: "global", scopeId: null }],
      sessionVersion: 1,
    };
    for (const action of ACTIONS) {
      expect(await allow(execNoMembership, site, action)).toBe(false);
      expect(await allow(execNoMembership, siteT2, action)).toBe(false);
    }
    // Positive control: the kind is still reachable, so the DENYs above are the removal and not a
    // policy file that failed to load.
    const admin: Principal = {
      userId: ME, assurance: "high", companies: [], rootCompanies: [T1],
      roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }], sessionVersion: 1,
    };
    expect(await allow(admin, site, "read")).toBe(true);
  });

  it("group_executive at LOW assurance is denied (D4 ceiling applies even to the exec carve-out)", async () => {
    const execLow: Principal = {
      userId: ME, assurance: "low", companies: [],
      roles: [{ role: "group_executive", scopeType: "global", scopeId: null }], sessionVersion: 1,
    };
    for (const action of ACTIONS) expect(await allow(execLow, site, action)).toBe(false);
  });

  it("module_manager (webdev dept manager, ORG-6): read + provision + reconcile ALLOWED in the served company", async () => {
    const p = principal("webdev_manager", "company", T1);
    for (const action of ACTIONS) expect(await allow(p, site, action)).toBe(true);
  });

  it("module_staff (webdev dept staff, ORG-6): read ALLOWED, provision/reconcile DENIED — creating infrastructure is manager-tier only", async () => {
    const p = principal("webdev_staff", "company", T1);
    expect(await allow(p, site, "read")).toBe(true);
    expect(await allow(p, site, "provision")).toBe(false);
    expect(await allow(p, site, "reconcile")).toBe(false);
  });

  it("A CLIENT-ONLY PRINCIPAL IS DENIED ON EVERYTHING — the `client` derived role appears nowhere in this policy, deliberately (same invariant resource_webdev_change_request.yaml states for its sibling table)", async () => {
    const clientOnly: Principal = {
      userId: ME, assurance: "high", companies: [T1],
      roles: [{ role: "client", scopeType: "company", scopeId: T1 }], sessionVersion: 1,
    };
    for (const action of ACTIONS) expect(await allow(clientOnly, site, action)).toBe(false);
  });

  it("platform_admin: full access regardless of tenant", async () => {
    const p: Principal = { userId: ME, assurance: "high", companies: [], roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }], sessionVersion: 1 };
    for (const action of ACTIONS) {
      expect(await allow(p, site, action)).toBe(true);
      expect(await allow(p, siteT2, action)).toBe(true);
    }
  });

  it("everything is denied at assurance low, regardless of role", async () => {
    for (const role of ["company_admin", "manager", "member", "webdev_manager", "webdev_staff", "viewer"]) {
      const p: Principal = { userId: ME, assurance: "low", companies: [T1], roles: [{ role, scopeType: "company", scopeId: T1 }], sessionVersion: 1 };
      for (const action of ACTIONS) expect(await allow(p, site, action)).toBe(false);
    }
  });
});
