// DW-5a (FRONTEND-BFF-CONTRACT §31.3/§31.4) — the PURE rules of agency-campaign-parts.service.ts: money arithmetic,
// the department check, and the body parsers. No database, no Cerbos: runs everywhere. The HTTP/DB proof of the same
// rules (including the concurrent-allocation race) is campaign-parts.test.ts, which runs on the Linux gate.
import { describe, it, expect } from "vitest";
import {
  PartRuleError, checkAllocation, checkCampaignMoneyChange, checkDates, indexOrgUnits, moneySnapshot,
  needsAllocationCheck, parseBrief, parseCampaignPatch, parseCurrency, parseDateOnly, parseLinkKind, parseMinorUnits,
  parseOwnerId, parsePartCreate, parsePartPatch, parsePartStatus, partPatchGates, requireDepartment, requireUuid,
  type OrgNodeLike,
} from "./agency-campaign-parts.service";

function refusal(fn: () => unknown): PartRuleError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PartRuleError);
    return e as PartRuleError;
  }
  throw new Error("expected a PartRuleError, but nothing was thrown");
}

const OWNER = "0190a000-0000-7000-8000-000000000001";

describe("DW-5a money rule 3 + 4: checkAllocation", () => {
  const ok = { campaignBudget: 1000n, campaignCurrency: "USD", allocatedByOthers: 400n, requested: 600n };

  it("allows an allocation that lands exactly on the budget", () => {
    expect(() => checkAllocation(ok)).not.toThrow();
  });

  it("refuses one minor unit over with allocation_exceeds_budget and the three figures", () => {
    const e = refusal(() => checkAllocation({ ...ok, requested: 601n }));
    expect(e.httpStatus).toBe(409);
    expect(e.reason).toBe("allocation_exceeds_budget");
    expect(e.detail).toEqual({ budgetMinor: 1000, allocatedMinor: 400, requestedMinor: 601 });
  });

  it("refuses with campaign_has_no_budget when the budget is NULL", () => {
    const e = refusal(() => checkAllocation({ ...ok, campaignBudget: null }));
    expect([e.httpStatus, e.reason]).toEqual([409, "campaign_has_no_budget"]);
  });

  it("refuses with campaign_has_no_budget when the currency is NULL, even with a budget", () => {
    const e = refusal(() => checkAllocation({ ...ok, campaignCurrency: null }));
    expect(e.reason).toBe("campaign_has_no_budget");
  });

  it("a zero allocation is allowed on a fully allocated campaign (zero adds nothing)", () => {
    expect(() => checkAllocation({ ...ok, allocatedByOthers: 1000n, requested: 0n })).not.toThrow();
  });

  it("is exact beyond 2^53: bigint, never a float", () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1, not representable as a JS number
    expect(() => checkAllocation({ campaignBudget: big, campaignCurrency: "IDR", allocatedByOthers: big - 1n, requested: 1n })).not.toThrow();
    const e = refusal(() => checkAllocation({ campaignBudget: big, campaignCurrency: "IDR", allocatedByOthers: big - 1n, requested: 2n }));
    expect(e.reason).toBe("allocation_exceeds_budget");
  });
});

describe("DW-5a money rule 5: checkCampaignMoneyChange", () => {
  const base = { currentCurrency: "USD", nextBudget: 1000n as bigint | null, nextCurrency: "USD" as string | null, allocatedMinor: 700n, allocationCount: 2 };

  it("is free while nothing is allocated (any budget, any currency, even clearing)", () => {
    expect(() => checkCampaignMoneyChange({ ...base, allocationCount: 0, allocatedMinor: 0n, nextBudget: null, nextCurrency: "EUR" })).not.toThrow();
  });

  it("allows lowering the budget to exactly the allocated sum", () => {
    expect(() => checkCampaignMoneyChange({ ...base, nextBudget: 700n })).not.toThrow();
  });

  it("refuses lowering below the allocated sum with budget_below_allocations", () => {
    const e = refusal(() => checkCampaignMoneyChange({ ...base, nextBudget: 699n }));
    expect([e.httpStatus, e.reason]).toEqual([409, "budget_below_allocations"]);
    expect(e.detail).toEqual({ budgetMinor: 699, allocatedMinor: 700 });
  });

  it("refuses clearing the budget while allocations exist", () => {
    const e = refusal(() => checkCampaignMoneyChange({ ...base, nextBudget: null }));
    expect(e.reason).toBe("budget_below_allocations");
    expect(e.detail).toEqual({ budgetMinor: null, allocatedMinor: 700 });
  });

  it("refuses clearing the budget even when the allocations are zero-valued (an allocation exists)", () => {
    const e = refusal(() => checkCampaignMoneyChange({ ...base, nextBudget: null, allocatedMinor: 0n, allocationCount: 1 }));
    expect(e.reason).toBe("budget_below_allocations");
  });

  it("refuses a currency change under allocations with currency_locked_by_allocations", () => {
    const e = refusal(() => checkCampaignMoneyChange({ ...base, nextCurrency: "EUR" }));
    expect([e.httpStatus, e.reason]).toEqual([409, "currency_locked_by_allocations"]);
  });

  it("refuses CLEARING the currency under allocations too", () => {
    const e = refusal(() => checkCampaignMoneyChange({ ...base, nextCurrency: null }));
    expect(e.reason).toBe("currency_locked_by_allocations");
  });

  it("checks currency before budget when both move", () => {
    const e = refusal(() => checkCampaignMoneyChange({ ...base, nextCurrency: "EUR", nextBudget: 1n }));
    expect(e.reason).toBe("currency_locked_by_allocations");
  });
});

describe("DW-5a money rule 6: needsAllocationCheck", () => {
  const t = { finalStatus: "active" as const, finalBudget: 5n as bigint | null, budgetTouched: false, leavingCancelled: false };
  it("is false when nothing money-relevant moved", () => expect(needsAllocationCheck(t)).toBe(false));
  it("is true when the allocation was touched", () => expect(needsAllocationCheck({ ...t, budgetTouched: true })).toBe(true));
  it("is true when a part leaves cancelled with an allocation (its share counts again)", () =>
    expect(needsAllocationCheck({ ...t, leavingCancelled: true })).toBe(true));
  it("is false for a part that ends cancelled: its allocation leaves the sum", () =>
    expect(needsAllocationCheck({ ...t, finalStatus: "cancelled", budgetTouched: true })).toBe(false));
  it("is false for a part with no allocation", () =>
    expect(needsAllocationCheck({ ...t, finalBudget: null, budgetTouched: true, leavingCancelled: true })).toBe(false));
});

describe("DW-5a money rule 7: moneySnapshot (the server does the sums)", () => {
  it("computes unallocatedMinor, and nulls it when there is no budget", () => {
    expect(moneySnapshot(1000n, "USD", 250n)).toEqual({ budgetMinor: 1000, currency: "USD", allocatedMinor: 250, unallocatedMinor: 750 });
    expect(moneySnapshot(null, null, 0n)).toEqual({ budgetMinor: null, currency: null, allocatedMinor: 0, unallocatedMinor: null });
  });
});

describe("DW-5a parsers", () => {
  it("parseMinorUnits takes whole non-negative numbers and null, nothing else", () => {
    expect(parseMinorUnits(0)).toBe(0n);
    expect(parseMinorUnits(12345)).toBe(12345n);
    expect(parseMinorUnits(null)).toBeNull();
    for (const bad of [-1, 1.5, "100", NaN, Infinity, 2 ** 53, true, {}, []]) {
      expect(refusal(() => parseMinorUnits(bad as unknown)).reason, String(bad)).toBe("budget_invalid");
    }
  });

  it("parseDateOnly takes real calendar dates only", () => {
    expect(parseDateOnly("2026-10-14", "dueOn")).toBe("2026-10-14");
    expect(parseDateOnly(null, "dueOn")).toBeNull();
    for (const bad of ["2026-02-30", "2026-13-01", "14/10/2026", "2026-1-1", 20261014, "", "2026-10-14T00:00:00Z"]) {
      expect(refusal(() => parseDateOnly(bad as unknown, "dueOn")).reason, String(bad)).toBe("date_invalid");
    }
  });

  it("checkDates refuses an end before a start, and tolerates a missing side", () => {
    expect(() => checkDates("2026-10-14", "2026-10-14")).not.toThrow();
    expect(() => checkDates(null, "2026-01-01")).not.toThrow();
    expect(() => checkDates("2026-10-15", null)).not.toThrow();
    expect(refusal(() => checkDates("2026-10-15", "2026-10-14")).reason).toBe("dates_invalid");
  });

  it("parseCurrency normalises to a 3-letter upper-case code", () => {
    expect(parseCurrency("usd")).toBe("USD");
    expect(parseCurrency(null)).toBeNull();
    for (const bad of ["US", "USDD", "12A", 5, ""]) expect(refusal(() => parseCurrency(bad as unknown)).reason).toBe("currency_invalid");
  });

  it("parseBrief caps at 4,000 characters", () => {
    expect(parseBrief("x".repeat(4000))).toHaveLength(4000);
    expect(refusal(() => parseBrief("x".repeat(4001))).reason).toBe("brief_too_long");
    expect(refusal(() => parseBrief(5 as unknown)).reason).toBe("brief_invalid");
  });

  it("parseOwnerId takes a uuid or null; anything else is owner_invalid", () => {
    expect(parseOwnerId(OWNER)).toBe(OWNER);
    expect(parseOwnerId(null)).toBeNull();
    for (const bad of ["u-dev", "", 7]) expect(refusal(() => parseOwnerId(bad as unknown)).reason).toBe("owner_invalid");
  });

  it("parsePartStatus / parseLinkKind accept the contract's values only", () => {
    for (const s of ["planned", "active", "blocked", "done", "cancelled"]) expect(parsePartStatus(s)).toBe(s);
    expect(refusal(() => parsePartStatus("paused")).reason).toBe("status_invalid");
    expect(parseLinkKind("search_campaign")).toBe("search_campaign");
    expect(parseLinkKind("social_campaign")).toBe("social_campaign");
    expect(refusal(() => parseLinkKind("work_request")).reason).toBe("link_kind_invalid");
  });

  it("requireUuid answers 404 with the given code for a non-uuid path param", () => {
    const e = refusal(() => requireUuid("nope", "part_not_found", "part not found"));
    expect([e.httpStatus, e.reason]).toEqual([404, "part_not_found"]);
    expect(requireUuid(OWNER, "part_not_found", "x")).toBe(OWNER);
  });
});

describe("DW-5a body shapes: never from the body", () => {
  it("parsePartCreate reads only unitId/ownerId/brief/dueOn/budgetMinor and ignores tenantId, campaignId, status, id", () => {
    const p = parsePartCreate({
      unitId: "d-seo", ownerId: OWNER, brief: "go", dueOn: "2026-11-01", budgetMinor: 500,
      tenantId: "evil", campaignId: "evil", status: "done", id: "evil", createdBy: "evil",
    });
    expect(p).toEqual({ unitId: "d-seo", ownerId: OWNER, brief: "go", dueOn: "2026-11-01", budgetMinor: 500n });
    expect(Object.keys(p).sort()).toEqual(["brief", "budgetMinor", "dueOn", "ownerId", "unitId"]);
  });

  it("parsePartCreate defaults: no owner, empty brief, no date, no allocation; unitId is required", () => {
    expect(parsePartCreate({ unitId: "d-seo" })).toEqual({ unitId: "d-seo", ownerId: null, brief: "", dueOn: null, budgetMinor: null });
    expect(refusal(() => parsePartCreate({})).reason).toBe("unit_invalid");
    expect(refusal(() => parsePartCreate(null)).reason).toBe("body_invalid");
    expect(refusal(() => parsePartCreate([])).reason).toBe("body_invalid");
  });

  it("parsePartPatch keeps only the five documented fields and refuses an empty patch", () => {
    expect(parsePartPatch({ status: "blocked", tenantId: "evil", campaignId: "evil", unitId: "d-other" })).toEqual({ status: "blocked" });
    expect(parsePartPatch({ ownerId: null, dueOn: null, budgetMinor: null })).toEqual({ ownerId: null, dueOn: null, budgetMinor: null });
    expect(refusal(() => parsePartPatch({ tenantId: "x" })).reason).toBe("nothing_to_update");
  });

  it("partPatchGates reads the RAW body: money and non-money are told apart before any value is validated", () => {
    expect(partPatchGates({ status: "nonsense" })).toEqual({ nonMoney: true, money: false });
    expect(partPatchGates({ budgetMinor: -5 })).toEqual({ nonMoney: false, money: true });
    expect(partPatchGates({ budgetMinor: null, brief: "x" })).toEqual({ nonMoney: true, money: true });
    expect(partPatchGates({})).toEqual({ nonMoney: false, money: false });
    expect(partPatchGates("not an object")).toEqual({ nonMoney: false, money: false });
  });

  it("parseCampaignPatch takes the seven documented fields; leadUnitId null clears; an empty patch is refused", () => {
    expect(
      parseCampaignPatch({
        name: " Q4 ", status: "paused", budgetMinor: 900, currency: "idr", leadUnitId: null, startsOn: "2026-10-01", endsOn: null, tenantId: "evil",
      }),
    ).toEqual({ name: "Q4", status: "paused", budgetMinor: 900n, currency: "IDR", leadUnitId: null, startsOn: "2026-10-01", endsOn: null });
    expect(refusal(() => parseCampaignPatch({ status: "planned" })).reason).toBe("status_invalid");
    expect(refusal(() => parseCampaignPatch({ projectId: "x" })).reason).toBe("nothing_to_update");
  });
});

describe("DW-5a org check: a department node, nothing else", () => {
  const node = (id: string, kind: string, name: string | undefined, children: OrgNodeLike[] = []): OrgNodeLike =>
    name === undefined ? { id, kind, children } : { id, kind, name, children };
  const tree = node("root", "company", "Gaia", [
    node("d-seo", "department", "SEO", [node("dv-tech", "division", "Technical", [node("p-1", "person", undefined)])]),
    node("d-social", "department", "Social"),
  ]);
  const units = indexOrgUnits(tree);

  it("indexes every node by id with its name and kind", () => {
    expect(units.get("d-seo")).toEqual({ name: "SEO", kind: "department" });
    expect(units.get("p-1")).toEqual({ name: null, kind: "person" });
    expect(units.size).toBe(5);
    expect(indexOrgUnits(null).size).toBe(0);
  });

  it("accepts a department and returns its name", () => {
    expect(requireDepartment(units, "d-social").name).toBe("Social");
  });

  it("refuses a division, the company root, a person and an unknown id with 400 unit_invalid", () => {
    for (const id of ["dv-tech", "root", "p-1", "d-gone"]) {
      const e = refusal(() => requireDepartment(units, id));
      expect([e.httpStatus, e.reason], id).toEqual([400, "unit_invalid"]);
    }
  });
});
