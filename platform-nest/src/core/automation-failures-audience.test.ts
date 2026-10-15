// DW-7i-1 (PERMISSION §42a) — the pure halves of the failing-workflows audience rule. The DB half (each passing kind and each
// refused kind against real seats) is automation-failures-audience.db.test.ts.
import { describe, it, expect } from "vitest";
import { gmUnitIds, isOwnerOf, isProjectManagerTitle, seatKinds } from "./automation-failures-audience";
import type { Principal } from "../rbac/principal";

const T = "00000000-0000-4000-8000-0000000000aa";
const principal = (roles: Principal["roles"]): Principal => ({ userId: "u1", assurance: "high", companies: [T], roles, sessionVersion: 0 });

const tree = {
  root: {
    id: "root", name: "Gaia", kind: "company", children: [
      { id: "d-gm", name: "GM", kind: "department", children: [{ id: "d-web", name: "Web Dev", kind: "department", children: [] }] },
      { id: "d-it", name: "IT", kind: "department", children: [] },
    ],
  },
};

describe("isProjectManagerTitle", () => {
  it("matches the seat title case-insensitively and trimmed", () => {
    for (const t of ["Project Manager", "project manager", "  PROJECT   Manager  "]) expect(isProjectManagerTitle(t), t).toBe(true);
  });
  it("does not match other titles", () => {
    for (const t of ["Assistant Project Manager", "Project Manager (Web)", "Manager", "PM", ""]) expect(isProjectManagerTitle(t), t).toBe(false);
  });
});

describe("gmUnitIds", () => {
  it("is the department that is the GM workspace for an agency", () => {
    expect([...gmUnitIds(tree, "agency")]).toEqual(["d-gm"]);
  });
  it("is empty for a vertical whose pack has no GM workspace, and for no tree", () => {
    expect(gmUnitIds(tree, "hospitality").size).toBe(0);
    expect(gmUnitIds(null, "agency").size).toBe(0);
  });
});

describe("seatKinds", () => {
  const gm = new Set(["d-gm"]);
  it("the GM is the LEAD seat of the GM unit, not any seat in it", () => {
    expect(seatKinds([{ unitNodeId: "d-gm", title: "General Manager", isLead: true }], gm)).toEqual({ gm: true, pm: false });
    expect(seatKinds([{ unitNodeId: "d-gm", title: "Analyst", isLead: false }], gm).gm).toBe(false);
    expect(seatKinds([{ unitNodeId: "d-web", title: "Head of Web Dev", isLead: true }], gm).gm).toBe(false);
  });
  it("the PM is a Project Manager seat wherever it sits", () => {
    expect(seatKinds([{ unitNodeId: "d-web", title: " project manager ", isLead: false }], gm)).toEqual({ gm: false, pm: true });
  });
  it("no seats is nobody", () => {
    expect(seatKinds([], gm)).toEqual({ gm: false, pm: false });
  });
});

describe("isOwnerOf", () => {
  it("needs a company-scope owner grant on exactly this company", () => {
    expect(isOwnerOf(principal([{ role: "owner", scopeType: "company", scopeId: T }]), T)).toBe(true);
    expect(isOwnerOf(principal([{ role: "owner", scopeType: "company", scopeId: "other" }]), T)).toBe(false);
    expect(isOwnerOf(principal([{ role: "owner", scopeType: "org_unit", scopeId: T }]), T)).toBe(false);
    for (const role of ["company_admin", "manager", "it_admin", "it"]) {
      expect(isOwnerOf(principal([{ role, scopeType: "company", scopeId: T }]), T), role).toBe(false);
    }
  });
});
