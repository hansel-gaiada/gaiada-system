import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";

// DW-10f-4b — the page and the writes driven through the REAL readers, actions and DEMO_MODE store (only the session, the tenant cookie and
// Next's cache are faked). It is the e2e's path without a browser: add a rate, see the preview with the withholding warning, draft one bill,
// discard it. It checks that the demo store answers the shapes the readers and the components read, so a drift between them cannot hide
// behind mocks. DEMO_MODE is a local harness; the flag is set here and nowhere else.
vi.hoisted(() => { process.env.DEMO_MODE = "1"; });
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "demo-hansel") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-agency") }));
vi.mock("@/lib/format", async (orig) => ({ ...(await orig<typeof import("@/lib/format")>()), todayIsoInDisplayZone: () => "2026-10-19" }));
vi.mock("@/lib/stepUpActions", () => ({ getStepUpStatusAction: vi.fn(async () => null), simulateSecondFactorAction: vi.fn() }));

import { resetFreelancersDemo } from "@/lib/demoFreelancers";
import { addRateAction, discardBillAction, draftBillAction, withdrawRateAction } from "@/lib/freelancersActions";
import FinanceFreelancersPage from "./page";

const PERIOD = ["2026-09-01", "2026-09-30"] as const;
const show = async () => { cleanup(); return render(await FinanceFreelancersPage({ searchParams: Promise.resolve({}) })); };
const region = (name: string) => within(screen.getByRole("region", { name }));
const queryRegion = (name: string) => screen.queryByRole("region", { name });
const drafted = () => within(screen.getByRole("heading", { level: 3, name: /Drafted bills/ }).closest("section") as HTMLElement);

beforeEach(() => resetFreelancersDemo());

describe("Freelancers page against the demo store", () => {
  it("opens with the people, their vendors, the preview for last month and a seeded draft", async () => {
    await show();
    expect(region("Rates for Made Putra").getByText(/Withholding code PPH23/)).toBeInTheDocument();
    expect(region("Rates for Made Putra").getAllByText(/^(from 2026-04-01, no end|2025-09-01 to 2026-03-31)$/)).toHaveLength(2);
    expect(region("Rates for Gede Kusuma").getByText(/No withholding code on the vendor/)).toBeInTheDocument();
    expect(region("Rates for Putu Rani").getByText("No vendor.")).toBeInTheDocument();
    // The preview, as the server computes it: Made at 150,000 an hour, PPh 23 withheld.
    expect(region("Preview for Made Putra").getByText(/^IDR\s79,500$/)).toBeInTheDocument();
    expect(region("Preview for Made Putra").getByText(/Earlier hours unbilled\./)).toBeInTheDocument();
    // DW-D47: no withholding code, a visible warning that does not block the draft.
    const gede = region("Preview for Gede Kusuma");
    expect(gede.getByText(/CV Sinar Percetakan names no withholding code/)).toBeInTheDocument();
    expect(gede.getByRole("button", { name: "Draft bill for Gede Kusuma" })).toBeEnabled();
    expect(region("Preview for Putu Rani").queryByRole("button", { name: /Draft bill/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Draft all ready (2)" })).toBeInTheDocument();
    expect(drafted().getByText("GA/FB/2026/0001")).toBeInTheDocument();
  });

  it("add a rate, see the new freelancer blocked for want of a vendor, then withdraw the rate", async () => {
    const added = await addRateAction("u-social", { hourlyRate: "140000", validFrom: "2026-10-01", expenseAccountCode: "6100", note: "e2e" });
    expect(added.ok).toBe(true);
    await show();
    expect(region("Rates for Komang Lestari").getByText("from 2026-10-01, no end")).toBeInTheDocument();
    expect(region("Preview for Komang Lestari").getByText("Blocked")).toBeInTheDocument();

    const rateId = (added.result as { id: string }).id;
    expect((await withdrawRateAction("u-social", rateId)).ok).toBe(true);
    await show();
    expect(queryRegion("Rates for Komang Lestari")).toBeNull();
  });

  it("a refused rate reads as a sentence", async () => {
    const r = await addRateAction("u-dev", { hourlyRate: "140000", validFrom: "2026-04-01", expenseAccountCode: "6100" });
    expect(r).toMatchObject({ ok: false, reason: "rate_overlap" });
    expect(r.error).toMatch(/overlaps another rate for this person/);
    expect((await addRateAction("u-hr", { hourlyRate: "140000", validFrom: "2026-10-01", expenseAccountCode: "6100" })).error).toMatch(/on payroll/);
  });

  it("drafts one bill, which leaves the preview and keeps its warning as a draft, then discards it", async () => {
    const made = await draftBillAction("gede-ic", ...PERIOD);
    expect(made.ok).toBe(true);
    const billNo = (made.result as { billNo: string }).billNo;
    await show();
    expect(queryRegion("Preview for Gede Kusuma")).toBeNull();
    const warnings = drafted().getByRole("list", { name: `Warnings on ${billNo}` });
    expect(warnings).toHaveTextContent("No withholding code.");

    const billId = (made.result as { billId: string }).billId;
    expect((await discardBillAction(billId)).ok).toBe(true);
    await show();
    expect(screen.getByRole("region", { name: "Preview for Gede Kusuma" })).toBeInTheDocument();
    expect(drafted().queryByText(billNo)).toBeNull();
  });

  it("a blocked freelancer is refused with the blockers the preview already showed", async () => {
    const r = await draftBillAction("u-creative", ...PERIOD);
    expect(r).toMatchObject({ ok: false, reason: "bill_blocked" });
    expect(r.blockers?.map((b) => b.code)).toEqual(["NO_VENDOR"]);
  });
});
