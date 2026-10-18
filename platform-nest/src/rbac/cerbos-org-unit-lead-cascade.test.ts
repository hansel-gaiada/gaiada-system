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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, principalPayload, type Resource } from "./cerbos";
import type { Principal, RoleGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-2222-0000-0000-000000000001";
const T2 = "aaaaaaaa-2222-0000-0000-000000000002";

function principal(roles: RoleGrant[], companies: string[] = [T1]): Principal {
  return { userId: "lead-1", assurance: "high", companies, roles, sessionVersion: 1 };
}
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;
// DW-10g-2 Part B: an org_unit_lead grant carries `tenantIds`, the companies whose own lead seat backs it (assemblePrincipal()
// resolves them under the seat tables' principal_lookup policies). Default: T1, this suite's company; `null` = a grant WITHOUT
// the attribute (an older or hand-built principal).
const ul = (unit: string, tenantIds: string[] | null = [T1]): RoleGrant =>
  tenantIds === null ? { role: "org_unit_lead", scopeType: "org_unit", scopeId: unit } : { role: "org_unit_lead", scopeType: "org_unit", scopeId: unit, tenantIds };

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

// ── DW-10g-2 Part B: static pins (always run, no Cerbos needed) ──────────────────────────────────────────────────────────
describe("DW-10g-2 static pin: the org_unit_lead derived role needs the company, and no permission mirror reads an org_unit grant", () => {
  const defs = new Map<string, string>();
  for (const doc of yaml.loadAll(readFileSync(join(__dirname, "..", "..", "cerbos", "policies", "derived_roles.yaml"), "utf8")) as any[]) {
    for (const d of doc?.derivedRoles?.definitions ?? []) {
      const expr = d?.condition?.match?.expr;
      if (expr) defs.set(d.name, String(expr).replace(/\s+/g, " ").trim());
    }
  }

  it("org_unit_lead = the node in unitAncestors AND has(g.tenantIds) AND the resource's company in g.tenantIds, in ONE grant", () => {
    expect(defs.get("org_unit_lead")).toBe(
      'request.principal.attr.grants.exists(g, g.role == "org_unit_lead" && g.scopeType == "org_unit" && ' +
        'g.scopeId in request.resource.attr.unitAncestors && has(g.tenantIds) && request.resource.attr.tenantId in g.tenantIds)',
    );
  });

  it("no perm_* mirror and no other derived role ever matches an org_unit-scoped grant or permission", () => {
    const perm = [...defs.entries()].filter(([n]) => n.startsWith("perm_"));
    expect(perm.length).toBeGreaterThan(100); // a scan that matched nothing proves nothing
    for (const [name, expr] of defs) {
      if (name === "org_unit_lead") continue;
      expect(expr, name).not.toMatch(/org_unit/);
    }
  });

  it("principalPayload sends tenantIds on an org_unit_lead grant only, and keeps every other grant's exact shape", () => {
    const p: Principal = {
      userId: "u", assurance: "high", companies: [T1], sessionVersion: 1,
      roles: [ul("d-web", [T1]), { role: "member", scopeType: "company", scopeId: T1 }, ul("d-seo", null)],
    };
    expect(principalPayload(p).attr.grants).toEqual([
      { role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web", tenantIds: [T1] },
      { role: "member", scopeType: "company", scopeId: T1 },
      { role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-seo" },
    ]);
  });
});

describe.skipIf(!live)("HIER-2 (DR-9) — org_unit_lead subtree cascade, live against Cerbos", () => {
  describe("report_document.read_department", () => {
    it("a grant at an ANCESTOR unit ('d-web') ALLOWS a resource in a DESCENDANT unit ('dv-frontend')", async () => {
      const p = principal([ul("d-web")]);
      expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS), "read_department")).toBe(true);
    });

    it("the SAME grant DENIES a resource in a SIBLING subtree ('d-hr')", async () => {
      const p = principal([ul("d-web")]);
      expect(await allow(p, reportDoc(SIBLING_ANCESTORS), "read_department")).toBe(false);
    });

    it("a grant AT THE RESOURCE'S OWN unit ALLOWS (self-inclusive at depth 0, not only strict ancestors)", async () => {
      const p = principal([ul("dv-frontend")]);
      expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS), "read_department")).toBe(true);
    });

    it("a grant at a DESCENDANT ('dv-frontend') does NOT cover its own ANCESTOR ('d-web') — the cascade is one-directional (down, never up)", async () => {
      const p = principal([ul("dv-frontend")]);
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
      const p = principal([ul("d-deleted-node")]);
      expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS), "read_department")).toBe(false);
      expect(await allow(p, reportDoc(SIBLING_ANCESTORS), "read_department")).toBe(false);
    });

    it("an unfed resource (no unitAncestors attribute at all) confers nothing to ANY org_unit_lead grant", async () => {
      const p = principal([ul("d-web")]);
      const bare: Resource = { kind: "report_document", id: "doc-2", tenantId: T1, module: "reports" };
      expect(await allow(p, bare, "read_department")).toBe(false);
    });

    it("org_unit_lead does NOT bleed into read_person/read_project — its rule lists read_department ONLY (the one grain reports.controller.ts actually resolves an ancestor list for)", async () => {
      const p = principal([ul("d-web")]);
      expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS, { ownerId: "some-user" }), "read_person")).toBe(false);
      expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS, { projectId: "some-project" }), "read_project")).toBe(false);
    });

    it("cross-tenant (DW-10g-2): a member of BOTH companies whose seat backs the grant in T1 only is NOT a head of T2's same-id node; a seat in T2 too makes one", async () => {
      // Before DW-10g-2 this case ALLOWED: the derived role checked only ancestor containment, and the grant has no company,
      // so a grant made for T1's d-web acted on T2's d-web for anyone who was also a member of T2.
      expect(await allow(principal([ul("d-web", [T1])], [T1, T2]), { ...reportDoc(DESCENDANT_ANCESTORS), tenantId: T2 }, "read_department")).toBe(false);
      expect(await allow(principal([ul("d-web", [T1, T2])], [T1, T2]), { ...reportDoc(DESCENDANT_ANCESTORS), tenantId: T2 }, "read_department")).toBe(true);
    });

    it("the RESOURCE-POLICY RULE's own inTenant gate denies when the caller is not authorized for the resource's tenant at all", async () => {
      const p = principal([ul("d-web")], [T1]); // NOT authorized for T2
      expect(await allow(p, { ...reportDoc(DESCENDANT_ANCESTORS), tenantId: T2 }, "read_department")).toBe(false);
    });

    it("low assurance still gets nothing (D4 ceiling honored, not bypassed by the cascade)", async () => {
      const p: Principal = { ...principal([ul("d-web")]), assurance: "low" };
      expect(await allow(p, reportDoc(DESCENDANT_ANCESTORS), "read_department")).toBe(false);
    });
  });

  describe("appraisal.read (DR-11: the dept-lead appraisal tier, landed WITH this ticket)", () => {
    it("a grant at an ANCESTOR unit ALLOWS reading the appraisal of a subject placed in a DESCENDANT unit", async () => {
      const p = principal([ul("d-web")]);
      expect(await allow(p, appraisal(DESCENDANT_ANCESTORS, { subjectUserId: "someone-else" }), "read")).toBe(true);
    });

    it("the SAME grant DENIES the appraisal of a subject in a SIBLING subtree", async () => {
      const p = principal([ul("d-web")]);
      expect(await allow(p, appraisal(SIBLING_ANCESTORS, { subjectUserId: "someone-else" }), "read")).toBe(false);
    });

    it("org_unit_lead does NOT reach write/submit/confirm_evidence/finalize/cycle_admin — read only (DR-11's own boundary: a dept head does not gain score-write access merely by leading the subtree)", async () => {
      const p = principal([ul("d-web")]);
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

  describe("DW-10g-2 Part B: the grant counts only in a company whose own lead seat backs it (`tenantIds`)", () => {
    const docFor = (tenantId: string) => ({ ...reportDoc(DESCENDANT_ANCESTORS), tenantId });
    const apprFor = (tenantId: string) => ({ ...appraisal(DESCENDANT_ANCESTORS, { subjectUserId: "someone-else" }), tenantId });

    it("THE FOREIGN GRANT: a member of T1 holding a grant whose seat is in T2 only gets nothing on T1's same-id unit", async () => {
      const p = principal([ul("d-web", [T2])], [T1, T2]);
      expect(await allow(p, docFor(T1), "read_department")).toBe(false);
      expect(await allow(p, apprFor(T1), "read")).toBe(false);
      // and keeps it in T2, where the seat is
      expect(await allow(p, docFor(T2), "read_department")).toBe(true);
      expect(await allow(p, apprFor(T2), "read")).toBe(true);
    });

    it("THE SAME COMPANY: the seat's company allows (report document and appraisal)", async () => {
      const p = principal([ul("d-web", [T1])]);
      expect(await allow(p, docFor(T1), "read_department")).toBe(true);
      expect(await allow(p, apprFor(T1), "read")).toBe(true);
    });

    it("no backing seat anywhere (`tenantIds: []`) and an older or hand-built grant WITHOUT `tenantIds` both match nothing (fail closed)", async () => {
      for (const g of [ul("d-web", []), ul("d-web", null)]) {
        expect(await allow(principal([g]), docFor(T1), "read_department"), JSON.stringify(g)).toBe(false);
        expect(await allow(principal([g]), apprFor(T1), "read"), JSON.stringify(g)).toBe(false);
      }
    });
  });
});
