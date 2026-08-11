// HIER-2 (DR-9) — the org_unit_lead subtree cascade: the capability that has never existed in this
// codebase before this ticket. `team_lead`'s own team-scope match requires a real `teams` row (0
// live rows, and unstorable for a report_document teamId anyway per person-scope.ts's TR-25
// header) — no role in this program has ever let a grant at ONE org-chart node cover every
// resource beneath it. This file proves that mechanism directly against live Cerbos: the RESOURCE
// carries `unitAncestors` (IAM-09's org_unit_closure, self-inclusive at depth 0), and
// `org_unit_lead`'s derived role (derived_roles.yaml) ALLOWs iff its grant's `scopeId` is anywhere
// in that list.
//
// Talks to Cerbos directly (`check()`, the same client every controller uses) — needs live
// CERBOS_URL, skips otherwise (same convention as cerbos.test.ts/cerbos-webdev-matrix.test.ts).
// ⚠ STALENESS: a healthy container can still be serving a stale policy — this suite proves
// nothing if CERBOS_URL points at a container that predates this file's own policy edits
// (`docker inspect <container> --format '{{.State.StartedAt}}'` must postdate them).
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-2222-0000-0000-000000000001";
const T2 = "aaaaaaaa-2222-0000-0000-000000000002";

function principal(roles: RoleGrant[], companies: string[] = [T1]): Principal {
  return { userId: "lead-1", assurance: "high", companies, roles, sessionVersion: 1 };
}
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

// A realistic ancestor chain from IAM-09's closure: 'dv-frontend' sits under 'd-web' under
// 'd-corp' — self-inclusive at depth 0, nearest-first, exactly loadUnitAncestors()'s own shape.
const DESCENDANT_ANCESTORS = ["dv-frontend", "d-web", "d-corp"];
// A SIBLING subtree — 'd-hr' shares the same root ('d-corp') but is NOT an ancestor of
// 'dv-frontend', and 'd-web' does not appear anywhere in its own ancestor chain.
const SIBLING_ANCESTORS = ["dv-hr-ops", "d-hr", "d-corp"];

const reportDoc = (unitAncestors: string[], extra: Partial<Resource> = {}): Resource => ({
  kind: "report_document",
  id: "doc-1",
  tenantId: T1,
  module: "reports",
  unitAncestors,
  ...extra,
});
const appraisal = (unitAncestors: string[], extra: Partial<Resource> = {}): Resource => ({
  kind: "appraisal",
  id: "appr-1",
  tenantId: T1,
  unitAncestors,
  ...extra,
});

describe.skipIf(!live)("HIER-2 (DR-9) — org_unit_lead subtree cascade, live against Cerbos", () => {
  describe("report_document.read_department", () => {
    it("a grant at an ANCESTOR unit ('d-web') ALLOWS a resource in a DESCENDANT unit ('dv-frontend')", async () => {
      const p = principal([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web" }]);
      expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS), "read_department")).toBe(true);
    });

    it("the SAME grant DENIES a resource in a SIBLING subtree ('d-hr')", async () => {
      const p = principal([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web" }]);
      expect(await allow(p, reportDoc(SIBLING_ANCESTORS), "read_department")).toBe(false);
    });

    it("a grant AT THE RESOURCE'S OWN unit ALLOWS (self-inclusive at depth 0, not only strict ancestors)", async () => {
      const p = principal([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "dv-frontend" }]);
      expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS), "read_department")).toBe(true);
    });

    it("a grant at a DESCENDANT ('dv-frontend') does NOT cover its own ANCESTOR ('d-web') — the cascade is one-directional (down, never up)", async () => {
      const p = principal([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "dv-frontend" }]);
      // 'd-web' resource's own ancestor chain is ["d-web", "d-corp"] — does not contain "dv-frontend".
      expect(await allow(p, reportDoc(["d-web", "d-corp"]), "read_department")).toBe(false);
    });

    it("a COMPANY-scoped org_unit_lead grant confers nothing (the role's own condition has no scope-type branch other than org_unit — DR-9's acceptance criterion (c))", async () => {
      const p = principal([{ role: "org_unit_lead", scopeType: "company", scopeId: T1 }]);
      expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS), "read_department")).toBe(false);
    });

    it("a GLOBAL-scoped org_unit_lead grant confers nothing either", async () => {
      const p = principal([{ role: "org_unit_lead", scopeType: "global", scopeId: null }]);
      expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS), "read_department")).toBe(false);
    });

    it("an ORPHANED-node grant (scopeId absent from the live tree, so it can never appear in ANY resource's unitAncestors) confers nothing — fail-closed by construction, no special-case code needed", async () => {
      const p = principal([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-deleted-node" }]);
      expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS), "read_department")).toBe(false);
      expect(await allow(p, reportDoc(SIBLING_ANCESTORS), "read_department")).toBe(false);
    });

    it("an unfed resource (no unitAncestors attribute at all) confers nothing to ANY org_unit_lead grant", async () => {
      const p = principal([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web" }]);
      const bare: Resource = { kind: "report_document", id: "doc-2", tenantId: T1, module: "reports" };
      expect(await allow(p, bare, "read_department")).toBe(false);
    });

    it("org_unit_lead does NOT bleed into read_person/read_project — its rule lists read_department ONLY (the one grain reports.controller.ts actually resolves an ancestor list for)", async () => {
      const p = principal([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web" }]);
      expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS, { ownerId: "some-user" }), "read_person")).toBe(false);
      expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS, { projectId: "some-project" }), "read_project")).toBe(false);
    });

    it("cross-tenant: the ancestor grant does not leak into a resource in a DIFFERENT tenant (variables.inTenant is a separate, unchanged gate)", async () => {
      const p = principal([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web" }], [T1, T2]);
      expect(await allow(p, { ...reportDoc(DESCENDANT_ANCESTORS), tenantId: T2 }, "read_department")).toBe(true);
      // ^ org_unit_lead's OWN condition never checks tenantId at all (only ancestor containment) —
      // deliberately mirroring team_lead's identical shape (derived_roles.yaml's team_lead rule
      // has no tenant check either; the resource-policy RULE's `variables.inTenant` is what would
      // gate this in the real controller, since the caller must also be authorized for that
      // tenant to reach this action at all — see the next case).
    });

    it("the RESOURCE-POLICY RULE's own inTenant gate denies when the caller is not authorized for the resource's tenant at all", async () => {
      const p = principal([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web" }], [T1]); // NOT authorized for T2
      expect(await allow(p, { ...reportDoc(DESCENDANT_ANCESTORS), tenantId: T2 }, "read_department")).toBe(false);
    });

    it("low assurance still gets nothing (D4 ceiling honored, not bypassed by the cascade)", async () => {
      const p: Principal = { ...principal([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web" }]), assurance: "low" };
      expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS), "read_department")).toBe(false);
    });
  });

  describe("appraisal.read (DR-11: the dept-lead appraisal tier, landed WITH this ticket)", () => {
    it("a grant at an ANCESTOR unit ALLOWS reading the appraisal of a subject placed in a DESCENDANT unit", async () => {
      const p = principal([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web" }]);
      expect(await allow(p, appraisal(DESCENDANT_ANCESTORS, { subjectUserId: "someone-else" }), "read")).toBe(true);
    });

    it("the SAME grant DENIES the appraisal of a subject in a SIBLING subtree", async () => {
      const p = principal([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web" }]);
      expect(await allow(p, appraisal(SIBLING_ANCESTORS, { subjectUserId: "someone-else" }), "read")).toBe(false);
    });

    it("org_unit_lead does NOT reach write/submit/confirm_evidence/finalize/cycle_admin — read only (DR-11's own boundary: a dept head does not gain score-write access merely by leading the subtree)", async () => {
      const p = principal([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web" }]);
      const r = appraisal(DESCENDANT_ANCESTORS, { subjectUserId: "someone-else" });
      for (const action of ["write", "submit", "confirm_evidence", "finalize", "cycle_admin"]) {
        expect(await allow(p, r, action), `org_unit_lead must NOT reach appraisal.${action}`).toBe(false);
      }
    });
  });

  it("SANITY: role-arm only — no `perm_*` permission grant is involved anywhere in this cascade (org_unit_lead has no permission-arm mirror in this ticket)", async () => {
    // Same principal as the very first test, but via the PERMISSION arm instead of the role arm —
    // must be denied, proving the cascade above was genuinely decided by the role-arm grant, not by
    // an accidental permission-arm path this ticket never built.
    const p: Principal = {
      userId: "lead-1",
      assurance: "high",
      companies: [T1],
      roles: [],
      perms: [{ key: "reports.document.read_department", scopeType: "org_unit", scopeId: "d-web" }],
      sessionVersion: 1,
    };
    expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS), "read_department")).toBe(false);
  });
});
