import { describe, it, expect } from "vitest";
import { reportsDemo } from "./demoReports";
import { displayableSums, type GroupReport } from "./groupReport";

function group(tenant: string, userId: string, query: Record<string, string> = { periodKind: "month", start: "2026-07-15" }) {
  return reportsDemo("GET", `/api/${tenant}/reports/group`, new URLSearchParams(query), undefined, userId)!;
}

describe("demoReports: GET /api/:rootId/reports/group (PV1-06b)", () => {
  it("is 403 for everyone but the group owner and the platform admin", () => {
    expect(group("co-holding", "demo-owner").status).toBe(200);
    expect(group("co-holding", "demo-hansel").status).toBe(200);
    expect(group("co-holding", "gede-ic").status).toBe(403);
    expect(group("co-holding", "dept-manager").status).toBe(403);
  });

  it("authz comes before the root check: a member probing a child id gets 403, not 404", () => {
    expect(group("co-agency", "gede-ic").status).toBe(403);
  });

  it("is 404 for a non-root id, even for the owner", () => {
    expect(group("co-agency", "demo-owner").status).toBe(404);
    expect(group("nope", "demo-hansel").status).toBe(404);
  });

  it("returns a card per company with the module-off one as `figures: null`, and no ratio in the sums", () => {
    const report = group("co-holding", "demo-owner").json as GroupReport;
    expect(report.companies.map((c) => c.companyId)).toEqual(["co-holding", "co-agency", "co-resort"]);
    const resort = report.companies.find((c) => c.companyId === "co-resort")!;
    expect(resort.figures).toBeNull();
    expect(resort.figuresUnavailable).toBe("reports_module_not_enabled");
    expect(report.consolidated).toBeNull();
    expect(report.consolidatedReason).toBe("needs F9 eliminations");

    expect(report.sumOfCompanies.length).toBeGreaterThan(0);
    for (const s of report.sumOfCompanies) {
      expect(s.unit).not.toBe("percent");
      expect(s.companyCount).toBe(2); // the module-off company contributes nothing
    }
    // the page's own second lock agrees with the fixture: nothing is dropped
    expect(displayableSums(report)).toHaveLength(report.sumOfCompanies.length);
    expect(report.sumOfCompanies.map((s) => s.metricKey)).not.toContain("delivery.on_time_rate");
  });

  it("each sum is the plain addition of the cards' additive figures", () => {
    const report = group("co-holding", "demo-owner").json as GroupReport;
    const s = report.sumOfCompanies.find((x) => x.metricKey === "delivery.tasks_completed")!;
    const parts = report.companies.flatMap((c) => c.figures ?? []).filter((f) => f.metricKey === "delivery.tasks_completed");
    expect(s.value).toBe(parts.reduce((n, f) => n + f.value, 0));
  });

  it("the group owner can open each company's own Company Report in demo mode (PV1-06a)", () => {
    const q = new URLSearchParams({ grain: "company", periodKind: "month", start: "2026-07-15" });
    expect(reportsDemo("GET", "/api/co-agency/reports/document", q, undefined, "demo-owner")?.status).toBe(200);
    expect(reportsDemo("GET", "/api/co-agency/reports/document", q, undefined, "gede-ic")?.status).toBe(403);
  });
});
