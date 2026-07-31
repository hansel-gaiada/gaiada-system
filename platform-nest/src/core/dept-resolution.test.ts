// TR-04 — pure unit tests for the server-side department resolver + membership sweep diff.
// No database, no skipIf: these must always run (same posture as work-activity-linker.test.ts).
import { describe, it, expect } from "vitest";
import {
  resolveDepartment,
  resolveMembershipAsOf,
  deriveBlobPlacements,
  diffMembershipSweep,
  todayIso,
  addDaysIso,
  isUuidShaped,
  type PersonMembershipLookup,
  type OrgNodeForWalk,
  type BlobPlacement,
  type OpenPrimaryMembership,
} from "./dept-resolution";

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TENANT_B = "bbbbbbbb-0000-0000-0000-000000000002";

describe("resolveMembershipAsOf", () => {
  const intervals = [
    { unitNodeId: "old-dept", validFrom: "2026-01-01", validTo: "2026-07-14" },
    { unitNodeId: "new-dept", validFrom: "2026-07-15", validTo: null },
  ];

  it("resolves to the interval covering the as-of date, inclusive both ends", () => {
    expect(resolveMembershipAsOf(intervals, "2026-01-01")?.unitNodeId).toBe("old-dept");
    expect(resolveMembershipAsOf(intervals, "2026-07-14")?.unitNodeId).toBe("old-dept");
    expect(resolveMembershipAsOf(intervals, "2026-07-15")?.unitNodeId).toBe("new-dept");
    expect(resolveMembershipAsOf(intervals, "2099-01-01")?.unitNodeId).toBe("new-dept"); // open row
  });

  it("returns null when no interval covers the date (pre-adoption history)", () => {
    expect(resolveMembershipAsOf(intervals, "2020-01-01")).toBeNull();
  });
});

describe("resolveDepartment: precedence ①-④", () => {
  const BASE = { asOfDate: "2026-07-01", factTenantId: TENANT_A };

  it("① owner-unit assignee wins over everything else", () => {
    const r = resolveDepartment({
      ...BASE,
      ownerUnitNodeId: "owner-unit",
      personMembership: { tenantId: TENANT_A, intervals: [{ unitNodeId: "person-unit", validFrom: "2020-01-01", validTo: null }] },
      projectDepartmentId: "project-dept",
    });
    expect(r).toEqual({ unitNodeId: "owner-unit", unitTenantId: TENANT_A, precedence: 1, providerTenantId: null, providerUnitNodeId: null });
  });

  it("② falls back to the person's primary membership as-of the fact date when no owner-unit", () => {
    const r = resolveDepartment({
      ...BASE,
      personMembership: { tenantId: TENANT_A, intervals: [{ unitNodeId: "person-unit", validFrom: "2020-01-01", validTo: null }] },
      projectDepartmentId: "project-dept",
    });
    expect(r).toEqual({ unitNodeId: "person-unit", unitTenantId: TENANT_A, precedence: 2, providerTenantId: null, providerUnitNodeId: null });
  });

  it("③ falls back to projects.department_id when there's no owner-unit and no covering membership", () => {
    const r = resolveDepartment({
      ...BASE,
      personMembership: { tenantId: TENANT_A, intervals: [{ unitNodeId: "person-unit", validFrom: "2030-01-01", validTo: null }] }, // doesn't cover asOfDate
      projectDepartmentId: "project-dept",
    });
    expect(r).toEqual({ unitNodeId: "project-dept", unitTenantId: TENANT_A, precedence: 3, providerTenantId: null, providerUnitNodeId: null });
  });

  it("③ also fires when there is no person at all (no responsible/owner person on the fact)", () => {
    const r = resolveDepartment({ ...BASE, projectDepartmentId: "project-dept" });
    expect(r.precedence).toBe(3);
    expect(r.unitNodeId).toBe("project-dept");
  });

  it("④ unattributed when nothing resolves", () => {
    const r = resolveDepartment({ ...BASE });
    expect(r).toEqual({ unitNodeId: null, unitTenantId: null, precedence: 4, providerTenantId: null, providerUnitNodeId: null });
  });

  // ─────────────── THE CASE THAT MATTERS: as-of transfer, history is never rewritten ───────────────
  it("as-of transfer: a July 10 fact resolves to the OLD unit, a July 20 fact to the NEW one, after a July 15 move", () => {
    const membership: PersonMembershipLookup = {
      tenantId: TENANT_A,
      intervals: [
        { unitNodeId: "engineering", validFrom: "2026-01-01", validTo: "2026-07-14" },
        { unitNodeId: "product", validFrom: "2026-07-15", validTo: null },
      ],
    };
    const oldFact = resolveDepartment({ factTenantId: TENANT_A, asOfDate: "2026-07-10", personMembership: membership });
    const newFact = resolveDepartment({ factTenantId: TENANT_A, asOfDate: "2026-07-20", personMembership: membership });
    const onMoveDay = resolveDepartment({ factTenantId: TENANT_A, asOfDate: "2026-07-15", personMembership: membership });

    expect(oldFact.precedence).toBe(2);
    expect(oldFact.unitNodeId).toBe("engineering");
    expect(newFact.precedence).toBe(2);
    expect(newFact.unitNodeId).toBe("product");
    expect(onMoveDay.unitNodeId).toBe("product"); // the transfer's own effective day resolves to the NEW unit
  });

  // ─────────────── provider stamp (shared-service case) ───────────────
  it("stamps provider_tenant_id/provider_unit_node_id ONLY for a cross-company ② resolution with an ACTIVE service_assignment", () => {
    const crossCompanyMembership: PersonMembershipLookup = {
      tenantId: TENANT_A, // person's home tenant differs from the fact's own tenant (TENANT_B)
      intervals: [{ unitNodeId: "it-dept", validFrom: "2020-01-01", validTo: null }],
    };

    const stamped = resolveDepartment({
      factTenantId: TENANT_B,
      asOfDate: "2026-07-01",
      personMembership: crossCompanyMembership,
      activeServiceAssignment: true,
    });
    expect(stamped.precedence).toBe(2);
    expect(stamped.unitNodeId).toBe("it-dept");
    expect(stamped.unitTenantId).toBe(TENANT_A);
    expect(stamped.providerTenantId).toBe(TENANT_A);
    expect(stamped.providerUnitNodeId).toBe("it-dept");
  });

  it("does NOT stamp when the service_assignment is not active (proposed/suspended/revoked -> caller passes false/undefined)", () => {
    const crossCompanyMembership: PersonMembershipLookup = {
      tenantId: TENANT_A,
      intervals: [{ unitNodeId: "it-dept", validFrom: "2020-01-01", validTo: null }],
    };
    const notActive = resolveDepartment({
      factTenantId: TENANT_B,
      asOfDate: "2026-07-01",
      personMembership: crossCompanyMembership,
      activeServiceAssignment: false,
    });
    expect(notActive.providerTenantId).toBeNull();
    expect(notActive.providerUnitNodeId).toBeNull();

    const omitted = resolveDepartment({
      factTenantId: TENANT_B,
      asOfDate: "2026-07-01",
      personMembership: crossCompanyMembership,
      // activeServiceAssignment omitted entirely
    });
    expect(omitted.providerTenantId).toBeNull();
  });

  it("does NOT stamp when the resolution is SAME-tenant, even if activeServiceAssignment is (incorrectly) passed true", () => {
    const sameTenantMembership: PersonMembershipLookup = {
      tenantId: TENANT_A,
      intervals: [{ unitNodeId: "it-dept", validFrom: "2020-01-01", validTo: null }],
    };
    const r = resolveDepartment({
      factTenantId: TENANT_A, // same as personMembership.tenantId -> not cross-company
      asOfDate: "2026-07-01",
      personMembership: sameTenantMembership,
      activeServiceAssignment: true,
    });
    expect(r.providerTenantId).toBeNull();
    expect(r.providerUnitNodeId).toBeNull();
  });

  it("does NOT stamp when precedence ① or ③ fired instead of ②, even cross-tenant + active", () => {
    const r1 = resolveDepartment({
      factTenantId: TENANT_B,
      asOfDate: "2026-07-01",
      ownerUnitNodeId: "owner-unit",
      personMembership: { tenantId: TENANT_A, intervals: [{ unitNodeId: "it-dept", validFrom: "2020-01-01", validTo: null }] },
      activeServiceAssignment: true,
    });
    expect(r1.precedence).toBe(1);
    expect(r1.providerTenantId).toBeNull();

    const r3 = resolveDepartment({
      factTenantId: TENANT_B,
      asOfDate: "2026-07-01",
      projectDepartmentId: "project-dept",
      activeServiceAssignment: true, // no personMembership at all -> ② never evaluated
    });
    expect(r3.precedence).toBe(3);
    expect(r3.providerTenantId).toBeNull();
  });
});

describe("date helpers", () => {
  it("todayIso formats a given Date as YYYY-MM-DD (UTC)", () => {
    expect(todayIso(new Date("2026-07-15T23:59:59.000Z"))).toBe("2026-07-15");
    expect(todayIso(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026-01-05");
  });

  it("addDaysIso shifts by whole days, including across month/year boundaries", () => {
    expect(addDaysIso("2026-07-15", -1)).toBe("2026-07-14");
    expect(addDaysIso("2026-08-01", -1)).toBe("2026-07-31");
    expect(addDaysIso("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDaysIso("2026-07-15", 1)).toBe("2026-07-16");
  });
});

describe("isUuidShaped", () => {
  it("accepts well-formed uuids, rejects legacy placeholder refs", () => {
    expect(isUuidShaped("00000000-0000-4000-8000-0000000000ff")).toBe(true);
    expect(isUuidShaped("u-dev")).toBe(false);
    expect(isUuidShaped("u-legacy-placeholder")).toBe(false);
    expect(isUuidShaped("")).toBe(false);
  });
});

// ─────────────────────────── deriveBlobPlacements: the org-blob tree walk ───────────────────────────

const dept = (id: string, children: OrgNodeForWalk[]): OrgNodeForWalk => ({ id, kind: "department", children });
const division = (id: string, children: OrgNodeForWalk[]): OrgNodeForWalk => ({ id, kind: "division", children });
const role = (id: string, children: OrgNodeForWalk[]): OrgNodeForWalk => ({ id, kind: "role", children });
const person = (id: string, assigneeId: string | null): OrgNodeForWalk => ({ id, kind: "person", assigneeId, children: [] });
const root = (children: OrgNodeForWalk[]): OrgNodeForWalk => ({ id: "root", kind: "company", children });

describe("deriveBlobPlacements", () => {
  it("a person nested department -> division -> role resolves to the DIVISION (nearest ancestor), not the department", () => {
    const tree = root([
      dept("eng", [division("eng-platform", [role("senior-dev", [person("p1", "alice")])])]),
    ]);
    expect(deriveBlobPlacements(tree)).toEqual([{ userId: "alice", unitNodeId: "eng-platform" }]);
  });

  it("a person placed directly under a department (no division) resolves to the department itself", () => {
    const tree = root([dept("ops", [person("p1", "bob")])]);
    expect(deriveBlobPlacements(tree)).toEqual([{ userId: "bob", unitNodeId: "ops" }]);
  });

  it("a person with no department/division ancestor at all is skipped (unrepresentable)", () => {
    const tree = root([person("p1", "erin")]); // directly under root/company
    expect(deriveBlobPlacements(tree)).toEqual([]);
  });

  it("a person node with no assigneeId is skipped entirely", () => {
    const tree = root([dept("ops", [person("p1", null)])]);
    expect(deriveBlobPlacements(tree)).toEqual([]);
  });

  it("duplicate assigneeId occurrences dedupe to the lexicographically smallest unit_node_id", () => {
    const tree = root([
      dept("z-dept", [person("p1", "dup-user")]),
      dept("a-dept", [person("p2", "dup-user")]),
    ]);
    expect(deriveBlobPlacements(tree)).toEqual([{ userId: "dup-user", unitNodeId: "a-dept" }]);
  });

  it("multiple distinct people across multiple departments all resolve independently", () => {
    const tree = root([
      dept("eng", [division("eng-platform", [person("p1", "alice")])]),
      dept("ops", [person("p2", "bob"), person("p3", "carol")]),
    ]);
    const result = deriveBlobPlacements(tree).sort((a, b) => a.userId.localeCompare(b.userId));
    expect(result).toEqual([
      { userId: "alice", unitNodeId: "eng-platform" },
      { userId: "bob", unitNodeId: "ops" },
      { userId: "carol", unitNodeId: "ops" },
    ]);
  });
});

// ─────────────────────────── diffMembershipSweep ───────────────────────────

describe("diffMembershipSweep", () => {
  const TODAY = "2026-07-15";

  it("a newly-placed person with no existing open row -> 'add'", () => {
    const ops = diffMembershipSweep([{ userId: "alice", unitNodeId: "eng" }], [], TODAY);
    expect(ops).toEqual([{ kind: "add", userId: "alice", unitNodeId: "eng", validFrom: TODAY }]);
  });

  it("same unit as the existing open row -> no-op (empty ops)", () => {
    const blob: BlobPlacement[] = [{ userId: "alice", unitNodeId: "eng" }];
    const open: OpenPrimaryMembership[] = [{ userId: "alice", unitNodeId: "eng", validFrom: "2020-01-01" }];
    expect(diffMembershipSweep(blob, open, TODAY)).toEqual([]);
  });

  it("a genuine transfer closes the old row the day BEFORE today and opens a new one starting today", () => {
    const blob: BlobPlacement[] = [{ userId: "alice", unitNodeId: "product" }];
    const open: OpenPrimaryMembership[] = [{ userId: "alice", unitNodeId: "eng", validFrom: "2020-01-01" }];
    expect(diffMembershipSweep(blob, open, TODAY)).toEqual([
      { kind: "transfer", userId: "alice", closeValidTo: "2026-07-14", openUnitNodeId: "product", openValidFrom: TODAY },
    ]);
  });

  it("a same-day flip (existing open row was ALSO opened today) amends in place instead of close+open", () => {
    const blob: BlobPlacement[] = [{ userId: "alice", unitNodeId: "product" }];
    const open: OpenPrimaryMembership[] = [{ userId: "alice", unitNodeId: "eng", validFrom: TODAY }];
    expect(diffMembershipSweep(blob, open, TODAY)).toEqual([{ kind: "amend", userId: "alice", unitNodeId: "product" }]);
  });

  it("a person removed from the blob (no longer resolvable anywhere) closes their open row, opens nothing", () => {
    const open: OpenPrimaryMembership[] = [{ userId: "alice", unitNodeId: "eng", validFrom: "2020-01-01" }];
    expect(diffMembershipSweep([], open, TODAY)).toEqual([{ kind: "remove", userId: "alice", closeValidTo: TODAY }]);
  });

  it("mixed batch: add + no-op + transfer + remove, independently, in one diff", () => {
    const blob: BlobPlacement[] = [
      { userId: "new-hire", unitNodeId: "eng" }, // add
      { userId: "stayed", unitNodeId: "eng" }, // no-op
      { userId: "moved", unitNodeId: "product" }, // transfer (was eng)
      // 'left' is intentionally absent -> remove
    ];
    const open: OpenPrimaryMembership[] = [
      { userId: "stayed", unitNodeId: "eng", validFrom: "2020-01-01" },
      { userId: "moved", unitNodeId: "eng", validFrom: "2020-01-01" },
      { userId: "left", unitNodeId: "eng", validFrom: "2020-01-01" },
    ];
    const ops = diffMembershipSweep(blob, open, TODAY);
    expect(ops).toEqual(
      expect.arrayContaining([
        { kind: "add", userId: "new-hire", unitNodeId: "eng", validFrom: TODAY },
        { kind: "transfer", userId: "moved", closeValidTo: "2026-07-14", openUnitNodeId: "product", openValidFrom: TODAY },
        { kind: "remove", userId: "left", closeValidTo: TODAY },
      ]),
    );
    expect(ops).toHaveLength(3); // 'stayed' produced nothing
  });

  it("running the diff twice against its OWN output (idempotent sweep) settles to no-op", () => {
    const blob: BlobPlacement[] = [{ userId: "alice", unitNodeId: "product" }];
    const openBefore: OpenPrimaryMembership[] = [{ userId: "alice", unitNodeId: "eng", validFrom: "2020-01-01" }];
    const firstPass = diffMembershipSweep(blob, openBefore, TODAY);
    expect(firstPass).toEqual([
      { kind: "transfer", userId: "alice", closeValidTo: "2026-07-14", openUnitNodeId: "product", openValidFrom: TODAY },
    ]);
    // Simulate the state AFTER applying firstPass: the new open row is now { unit: product, validFrom: TODAY }.
    const openAfter: OpenPrimaryMembership[] = [{ userId: "alice", unitNodeId: "product", validFrom: TODAY }];
    expect(diffMembershipSweep(blob, openAfter, TODAY)).toEqual([]);
  });
});
