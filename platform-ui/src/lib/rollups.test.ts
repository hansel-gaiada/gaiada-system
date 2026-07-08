import { describe, it, expect } from "vitest";
import { groupRollups } from "./rollups";
import type { RollupRow } from "./entities";

const rows: RollupRow[] = [
  {
    tenant_id: "t-agency",
    company: "Gaiada Agency",
    module: "agency",
    metric_key: "revenue",
    numerator: 50000,
    denominator: null,
    currency: "USD",
    period: "2026-07",
  },
  {
    tenant_id: "t-agency",
    company: "Gaiada Agency",
    module: "agency",
    metric_key: "win_rate",
    numerator: 12,
    denominator: 20,
    currency: null,
    period: "2026-07",
  },
  {
    tenant_id: "t-resort",
    company: "Gaiada Resort",
    module: "resort",
    metric_key: "occupancy",
    numerator: 80,
    denominator: 100,
    currency: null,
    period: "2026-07",
  },
];

describe("groupRollups", () => {
  it("groups rows by tenant, preserving first-seen company order", () => {
    const groups = groupRollups(rows);
    expect(groups.map((g) => g.tenantId)).toEqual(["t-agency", "t-resort"]);
    expect(groups.map((g) => g.company)).toEqual(["Gaiada Agency", "Gaiada Resort"]);
  });

  it("computes value and ratio correctly per metric", () => {
    const groups = groupRollups(rows);
    const agency = groups[0];
    expect(agency.metrics).toEqual([
      { key: "revenue", value: 50000, ratio: null, currency: "USD" },
      { key: "win_rate", value: 12, ratio: 0.6, currency: null },
    ]);

    const resort = groups[1];
    expect(resort.metrics).toEqual([
      { key: "occupancy", value: 80, ratio: 0.8, currency: null },
    ]);
  });

  it("returns an empty array for no rows", () => {
    expect(groupRollups([])).toEqual([]);
  });
});
