import { describe, it, expect, beforeEach } from "vitest";
import { freelancersDemo, resetFreelancersDemo } from "./demoFreelancers";
import { getDemoResponse } from "./demoFixtures";
import type { FlPreview, Freelancer, FreelancerBill, DraftedBill } from "./freelancers";

// DW-10f-4b: the freelancer store behind DEMO_MODE and the e2e. It stands in for the API, so it must keep the server's gates, its order of checks
// and its refusal reasons (BFF §61.7, §61.8, §61.18): a page is only as honest as the fixture behind it.

const T = "co-agency";
const base = `/api/${T}/finance`;
const q = (o: Record<string, string> = {}) => new URLSearchParams(o);
const req = (method: string, path: string, body?: unknown, user = "demo-hansel", qs: Record<string, string> = {}) =>
  freelancersDemo(method, `${base}/${path}`, q(qs), body === undefined ? undefined : JSON.stringify(body), user)!;
const PERIOD = { periodStart: "2026-09-01", periodEnd: "2026-09-30" };
const previewOf = () => (req("GET", "freelancer-bills/preview", undefined, "demo-hansel", PERIOD).json as FlPreview).freelancers;
const listOf = () => req("GET", "freelancers").json as Freelancer[];
const billsOf = () => req("GET", "freelancer-bills").json as FreelancerBill[];
const reason = (r: { json: unknown }) => (r.json as { reason?: string }).reason;
const rate = { hourlyRate: "140000", validFrom: "2026-10-01", expenseAccountCode: "6100" };

beforeEach(() => resetFreelancersDemo());

describe("routing and access", () => {
  it("ignores paths that are not freelancers", () => {
    expect(freelancersDemo("GET", `${base}/ap/bills`, q(), undefined, "demo-hansel")).toBeNull();
    expect(freelancersDemo("GET", `${base}/ap/vendors/v1`, q(), undefined, "demo-hansel")).toBeNull();
    expect(freelancersDemo("GET", `/api/${T}/members`, q(), undefined, "demo-hansel")).toBeNull();
  });
  it("is reached through getDemoResponse, ahead of the finance fixtures", () => {
    expect(getDemoResponse("GET", `${base}/freelancers`, "demo-hansel").status).toBe(200);
    expect(getDemoResponse("GET", `${base}/ap/vendors`, "demo-hansel").status).toBe(200);
  });
  it("refuses everyone but finance access, on every route, before anything else", () => {
    for (const [m, p, b] of [
      ["GET", "freelancers", undefined], ["POST", "freelancers/u-dev/rates", rate], ["GET", "freelancer-bills", undefined],
      ["POST", "freelancer-bills", { userId: "gede-ic", ...PERIOD }], ["DELETE", "freelancer-bills/x", undefined],
      ["PATCH", "ap/vendors/vend-3/person", { userId: "u-creative" }], ["GET", "ap/vendors", undefined],
    ] as const) {
      const r = req(m, p, b, "gede-ic");
      expect(r.status, `${m} ${p}`).toBe(403);
    }
  });
});

describe("the people and their rates", () => {
  it("lists a person with a rate or a vendor, by name, with the rate in force and the history", () => {
    const rows = listOf();
    expect(rows.map((r) => r.user.name)).toEqual(["Gede Kusuma", "Made Putra", "Putu Rani"]);
    const made = rows.find((r) => r.user.id === "u-dev")!;
    expect(made.rates).toHaveLength(2);
    expect(made.currentRate?.hourlyRate).toBe(150000);
    expect(made.rates.find((r) => r.validTo !== null)?.used).toBe(true);
    expect(made.vendor?.withholdingCode).toBe("PPH23");
    expect(rows.find((r) => r.user.id === "gede-ic")!.vendor?.withholdingCode).toBeNull();
    expect(rows.find((r) => r.user.id === "u-creative")!.vendor).toBeNull();
  });

  it("adds a rate, closes the open one the day before, and lists it", () => {
    const r = req("POST", "freelancers/u-dev/rates", { ...rate, note: "raise" });
    expect(r.status).toBe(201);
    const j = r.json as { hourlyRate: number; used: boolean; closedRate: { validTo: string } | null };
    expect(j.hourlyRate).toBe(140000);
    expect(j.used).toBe(false);
    expect(j.closedRate?.validTo).toBe("2026-09-30");
    expect(listOf().find((p) => p.user.id === "u-dev")!.rates).toHaveLength(3);
  });

  it("a person with no rate becomes a freelancer by getting one, and shows in the list", () => {
    expect(listOf().some((p) => p.user.id === "u-social")).toBe(false);
    expect(req("POST", "freelancers/u-social/rates", rate).status).toBe(201);
    const row = listOf().find((p) => p.user.id === "u-social")!;
    expect(row.vendor).toBeNull();
  });

  it("refuses in the server's order, each with its machine reason", () => {
    expect(reason(req("POST", "freelancers/u-dev/rates", { ...rate, validFrom: "soon" }))).toBe("date_invalid");
    expect(reason(req("POST", "freelancers/u-dev/rates", { ...rate, hourlyRate: "0" }))).toBe("rate_invalid");
    expect(reason(req("POST", "freelancers/u-dev/rates", { ...rate, hourlyRate: "-3" }))).toBe("rate_invalid");
    expect(reason(req("POST", "freelancers/u-dev/rates", { ...rate, hourlyRate: "1.5" }))).toBe("rate_invalid");
    expect(reason(req("POST", "freelancers/u-dev/rates", { ...rate, expenseAccountCode: "" }))).toBe("expense_account_invalid");
    expect(reason(req("POST", "freelancers/u-dev/rates", { ...rate, expenseAccountCode: "1120" }))).toBe("expense_account_invalid");
    expect(reason(req("POST", "freelancers/nobody/rates", rate))).toBe("person_not_found");
    expect(reason(req("POST", "freelancers/u-hr/rates", rate))).toBe("freelancer_on_payroll");
    // Starting on or before the open rate's own start overlaps it.
    expect(reason(req("POST", "freelancers/u-dev/rates", { ...rate, validFrom: "2026-04-01" }))).toBe("rate_overlap");
    expect(reason(req("POST", "freelancers/u-dev/rates", { ...rate, validFrom: "2026-01-01" }))).toBe("rate_overlap");
  });

  it("ends a rate, but never one that priced a bill before its last day; withdraws only an unused one", () => {
    const made = listOf().find((p) => p.user.id === "u-dev")!;
    const used = made.rates.find((r) => r.used)!;
    const open = made.rates.find((r) => r.validTo === null)!;
    expect(reason(req("PATCH", `freelancers/u-dev/rates/${used.id}`, { validTo: "2026-01-31" }))).toBe("rate_used");
    expect(reason(req("DELETE", `freelancers/u-dev/rates/${used.id}`))).toBe("rate_used");
    // Before the rate's own start is not a range at all.
    expect(reason(req("PATCH", `freelancers/u-dev/rates/${open.id}`, { validTo: "2026-03-01" }))).toBe("date_invalid");
    expect(reason(req("PATCH", `freelancers/u-dev/rates/${open.id}`, { validTo: "bad" }))).toBe("date_invalid");
    expect(req("PATCH", `freelancers/u-dev/rates/${open.id}`, { validTo: "2026-12-31" }).status).toBe(200);
    expect(req("DELETE", `freelancers/u-dev/rates/${open.id}`).json).toEqual({ deleted: true });
    expect(reason(req("DELETE", `freelancers/u-dev/rates/${open.id}`))).toBe("rate_not_found");
  });
});

describe("the vendor link", () => {
  it("lists the vendors with the person each names, plus a free one to link", () => {
    const vendors = req("GET", "ap/vendors").json as { id: string; userId: string | null }[];
    expect(vendors.map((v) => [v.id, v.userId])).toEqual([["vend-1", "u-dev"], ["vend-2", "gede-ic"], ["vend-3", null]]);
  });
  it("links, then the person has a vendor and the vendor names the person", () => {
    expect(req("PATCH", "ap/vendors/vend-3/person", { userId: "u-creative" }).json).toEqual({ vendorId: "vend-3", userId: "u-creative" });
    expect(listOf().find((p) => p.user.id === "u-creative")!.vendor?.code).toBe("V-003");
    expect(reason(req("PATCH", "ap/vendors/vend-3/person", { userId: "u-dev" }))).toBe("person_has_vendor");
  });
  it("refuses a missing userId, an unknown vendor and an unknown person", () => {
    expect(reason(req("PATCH", "ap/vendors/vend-3/person", {}))).toBe("user_id_required");
    expect(reason(req("PATCH", "ap/vendors/nope/person", { userId: "u-dev" }))).toBe("vendor_not_found");
    expect(reason(req("PATCH", "ap/vendors/vend-3/person", { userId: "nobody" }))).toBe("person_not_found");
  });
});

describe("the preview", () => {
  it("lists the people with a rate or vendor who have unbilled hours, with lines, withholding, warnings and blockers", () => {
    const rows = previewOf();
    expect(rows.map((f) => f.user.name)).toEqual(["Gede Kusuma", "Made Putra", "Putu Rani"]);
    const made = rows.find((f) => f.user.id === "u-dev")!;
    expect(made.lines).toHaveLength(2);
    expect(made.lines[0]).toMatchObject({ minutes: 1260, hours: 21, hourlyRate: 150000, amount: 3150000 });
    expect(made.withholding).toEqual({ code: "PPH23", amount: 79500 });
    expect(made.subtotal).toBe(3975000);
    expect(made.amountPayable).toBe(3895500);
    expect(made.warnings.map((w) => w.code)).toEqual(["EARLIER_UNBILLED"]);
    expect(made.earlierUnbilled).toMatchObject({ count: 3, minutes: 180 });
    expect(made.blockers).toEqual([]);
  });
  it("warns, never blocks, when the vendor names no withholding code (DW-D47)", () => {
    const gede = previewOf().find((f) => f.user.id === "gede-ic")!;
    expect(gede.withholding).toBeNull();
    expect(gede.warnings).toEqual([{ code: "NO_WITHHOLDING", message: "CV Sinar Percetakan names no withholding code, so this bill withholds nothing (DW-D47)" }]);
    expect(gede.blockers).toEqual([]);
    expect(gede.amountPayable).toBe(gede.subtotal);
  });
  it("blocks a person with no vendor", () => {
    const putu = previewOf().find((f) => f.user.id === "u-creative")!;
    expect(putu.blockers.map((b) => b.code)).toEqual(["NO_VENDOR"]);
  });
  it("blocks a period no rate covers", () => {
    const r = req("GET", "freelancer-bills/preview", undefined, "demo-hansel", { periodStart: "2025-01-01", periodEnd: "2025-01-31" });
    const gede = (r.json as FlPreview).freelancers.find((f) => f.user.id === "gede-ic")!;
    expect(gede.blockers.map((b) => b.code)).toContain("NO_RATE");
  });
  it("refuses a period the server would", () => {
    expect(reason(req("GET", "freelancer-bills/preview", undefined, "demo-hansel", { periodStart: "2026-09-30", periodEnd: "2026-09-01" }))).toBe("period_invalid");
    expect(reason(req("GET", "freelancer-bills/preview"))).toBe("period_invalid");
  });
});

describe("drafting and discarding", () => {
  const draft = (userId: string, period = PERIOD) => req("POST", "freelancer-bills", { userId, ...period });

  it("drafts a bill, keeps the no-withholding warning on it, and takes the person out of the preview", () => {
    const r = draft("gede-ic");
    expect(r.status).toBe(201);
    const j = r.json as DraftedBill;
    expect(j.status).toBe("draft");
    expect(j.billNo).toMatch(/\/FB\/2026\/\d{4}$/);
    expect(j.warnings.map((w) => w.code)).toEqual(["NO_WITHHOLDING"]);
    expect(previewOf().some((f) => f.user.id === "gede-ic")).toBe(false);
    const row = billsOf().find((b) => b.billId === j.billId)!;
    expect(row.status).toBe("draft");
    expect(row.warnings.map((w) => w.code)).toEqual(["NO_WITHHOLDING"]);
    expect(row.subtotal).toBe(j.subtotal);
  });
  it("a replay answers the live draft with deduped: true and makes no second bill", () => {
    const first = draft("gede-ic").json as DraftedBill;
    const again = draft("gede-ic").json as DraftedBill;
    expect(again.deduped).toBe(true);
    expect(again.billId).toBe(first.billId);
    expect(billsOf().filter((b) => b.user.id === "gede-ic")).toHaveLength(1);
  });
  it("refuses a blocked person with every blocker, and writes nothing", () => {
    const before = billsOf().length;
    const r = draft("u-creative");
    expect(r.status).toBe(409);
    expect(reason(r)).toBe("bill_blocked");
    expect((r.json as { blockers: { code: string }[] }).blockers.map((b) => b.code)).toEqual(["NO_VENDOR"]);
    expect(billsOf()).toHaveLength(before);
  });
  it("says there is nothing to bill for someone with no hours, and refuses bad input first", () => {
    expect(reason(draft("u-pm"))).toBe("nothing_to_bill");
    expect(reason(draft("nobody"))).toBe("person_not_found");
    expect(reason(draft("gede-ic", { periodStart: "x", periodEnd: "y" }))).toBe("period_invalid");
    expect(reason(req("POST", "freelancer-bills", { userId: "gede-ic", ...PERIOD, billDate: "nope" }))).toBe("bill_date_invalid");
  });
  it("discards a draft, which hands the hours back to the preview; a second discard is not found", () => {
    const j = draft("gede-ic").json as DraftedBill;
    const r = req("DELETE", `freelancer-bills/${j.billId}`);
    expect(r.json).toMatchObject({ billId: j.billId, discarded: true });
    expect(previewOf().some((f) => f.user.id === "gede-ic")).toBe(true);
    expect(reason(req("DELETE", `freelancer-bills/${j.billId}`))).toBe("freelancer_bill_not_found");
  });
  it("the seeded bill is a draft for an earlier month; the list filters by status and refuses an unknown one", () => {
    expect(billsOf().map((b) => b.status)).toEqual(["draft"]);
    expect(req("GET", "freelancer-bills", undefined, "demo-hansel", { status: "approved" }).json).toEqual([]);
    expect(reason(req("GET", "freelancer-bills", undefined, "demo-hansel", { status: "weird" }))).toBe("status_invalid");
  });
});
