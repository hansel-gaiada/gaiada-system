import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FlPreview, FreelancerBill, PreviewFreelancer } from "@/lib/freelancers";
import type { ReadResult } from "@/lib/readResult";

// DW-10f-4b — Finance > Payables > Freelancers > Bills. What is pinned: the preview shows the server's figures as sent (nothing is summed here),
// the DW-D47 "no withholding code" warning is visible on the preview and on the drafted bill, blockers hide the Draft button and say why, "Draft
// all ready" counts only the ready, and a refused read is never the empty note.
const fa = vi.hoisted(() => ({ draftBillAction: vi.fn(), draftAllReadyAction: vi.fn(), discardBillAction: vi.fn() }));
vi.mock("@/lib/freelancersActions", () => fa);
const su = vi.hoisted(() => ({ getStepUpStatusAction: vi.fn(), simulateSecondFactorAction: vi.fn() }));
vi.mock("@/lib/stepUpActions", () => su);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { FreelancerBills } from "./FreelancerBills";

const NO_WH = "CV Sinar Percetakan names no withholding code, so this bill withholds nothing (DW-D47)";
const line = { project: { id: "p1", name: "Client portal" }, minutes: 2400, hours: 40, hourlyRate: 120000, amount: 4800000, firstDate: "2026-09-01", lastDate: "2026-09-30" };
const gede: PreviewFreelancer = {
  user: { id: "gede-ic", name: "Gede Kusuma", email: "gede@gaiada.com" }, vendor: { id: "vend-2", code: "V-002", name: "CV Sinar Percetakan", withholdingCode: null },
  lines: [line], subtotal: 4800000, withholding: null, amountPayable: 4800000, currency: "IDR", entryCount: 4, earlierUnbilled: null, blockers: [],
  warnings: [{ code: "NO_WITHHOLDING", message: NO_WH }],
};
const made: PreviewFreelancer = {
  ...gede, user: { id: "u-dev", name: "Made Putra", email: "made@gaiada.com" }, vendor: { id: "vend-1", code: "V-001", name: "PT Kreatif", withholdingCode: "PPH23" },
  lines: [{ ...line, project: { id: "p2", name: "Website rebuild" }, hours: 21, minutes: 1260, hourlyRate: 150000, amount: 3150000 }],
  subtotal: 3150000, withholding: { code: "PPH23", amount: 63000 }, amountPayable: 3087000,
  warnings: [{ code: "EARLIER_UNBILLED", message: "3 unbilled time entries dated before this period (from 2026-08-12)" }],
};
const putu: PreviewFreelancer = {
  ...gede, user: { id: "u-creative", name: "Putu Rani", email: "creative@gaiada.com" }, vendor: null, warnings: [],
  blockers: [{ code: "NO_VENDOR", message: "no live vendor names Putu Rani: link one under Finance › Payables" }],
};
const preview = (...freelancers: PreviewFreelancer[]): ReadResult<FlPreview> =>
  ({ kind: "ok", data: { periodStart: "2026-09-01", periodEnd: "2026-09-30", freelancers } });
const draftBill = (over: Partial<FreelancerBill> = {}): FreelancerBill => ({
  billId: "b1", billNo: "GA/FB/2026/0001", user: { id: "u-dev", name: "Made Putra", email: "made@gaiada.com" },
  vendor: { id: "vend-1", code: "V-001", name: "PT Kreatif" }, periodStart: "2026-07-01", periodEnd: "2026-07-31", minutes: 1800,
  subtotal: 4500000, withholdingAmount: 90000, amountPayable: 4410000, currency: "IDR", status: "draft", createdAt: "2026-08-02T03:00:00Z",
  createdBy: null, warnings: [], ...over,
});
const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });
const period = { from: "2026-09-01", to: "2026-09-30" };
const mount = (p: ReadResult<FlPreview> | null, bills: ReadResult<FreelancerBill[]> = ok([]), previewError: string | null = null) =>
  render(<FreelancerBills preview={p} previewError={previewError} period={period} bills={bills} />);

beforeEach(() => {
  Object.values(fa).forEach((f) => f.mockReset().mockResolvedValue({ ok: true, result: {} }));
  Object.values(su).forEach((f) => f.mockReset().mockResolvedValue(null));
});

describe("the preview", () => {
  it("shows the lines, withholding and amount payable exactly as the server sent them", () => {
    mount(preview(made));
    const m = within(screen.getByRole("region", { name: "Preview for Made Putra" }));
    expect(m.getByText("Website rebuild")).toBeInTheDocument();
    expect(m.getByText("2026-09-01 to 2026-09-30")).toBeInTheDocument();
    expect(m.getByText("21")).toBeInTheDocument();
    expect(m.getByText(/^IDR\s150,000$/)).toBeInTheDocument();
    expect(m.getByText("Withholding (PPH23)")).toBeInTheDocument();
    expect(m.getByText(/^IDR\s63,000$/)).toBeInTheDocument();
    expect(m.getByText(/^IDR\s3,087,000$/)).toBeInTheDocument();
    expect(m.getByText("Ready")).toBeInTheDocument();
    expect(m.getByText(/Earlier hours unbilled\./)).toBeInTheDocument();
  });

  it("makes the DW-D47 'no withholding code' warning visible, says what to do, and still allows the draft", () => {
    mount(preview(gede));
    const g = within(screen.getByRole("region", { name: "Preview for Gede Kusuma" }));
    expect(g.getByText(NO_WH, { exact: false })).toBeInTheDocument();
    expect(g.getByText(/No withholding code\./)).toBeInTheDocument();
    expect(g.getByText(/Finance sets the withholding on the freelancer's vendor record/)).toBeInTheDocument();
    expect(g.getByText("None")).toBeInTheDocument();
    expect(g.getByRole("button", { name: "Draft bill for Gede Kusuma" })).toBeEnabled();
  });

  it("a blocked freelancer says why, points at the fix, and has no Draft button", () => {
    mount(preview(putu));
    const p = within(screen.getByRole("region", { name: "Preview for Putu Rani" }));
    expect(p.getByText("Blocked")).toBeInTheDocument();
    expect(p.getByText(/No vendor\./)).toBeInTheDocument();
    expect(p.getByText(/no live vendor names Putu Rani/)).toBeInTheDocument();
    expect(p.getByText(/Link a vendor to Putu Rani in the rates above/)).toBeInTheDocument();
    expect(p.queryByRole("button", { name: /Draft bill/ })).toBeNull();
  });

  it("drafts one bill for the picked period and says it is a draft", async () => {
    fa.draftBillAction.mockResolvedValue({ ok: true, result: { billNo: "GA/FB/2026/0002" } });
    mount(preview(gede, putu));
    fireEvent.click(screen.getByRole("button", { name: "Draft bill for Gede Kusuma" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Drafted bill GA/FB/2026/0002 for Gede Kusuma. It is a draft until someone approves it.");
    expect(fa.draftBillAction).toHaveBeenCalledWith("gede-ic", "2026-09-01", "2026-09-30");
  });

  it("a bill_blocked refusal lists every blocker the server named", async () => {
    fa.draftBillAction.mockResolvedValue({
      ok: false, error: "this bill cannot be drafted yet", reason: "bill_blocked",
      blockers: [{ code: "NO_OPEN_PERIOD", message: "no open fiscal period holds the bill date" }, { code: "NO_BILLING_PROFILE", message: "the company has no billing profile" }],
    });
    mount(preview(made));
    fireEvent.click(screen.getByRole("button", { name: "Draft bill for Made Putra" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("this bill cannot be drafted yet");
    expect(screen.getByText(/No open fiscal period\./)).toBeInTheDocument();
    expect(screen.getByText(/No billing profile\./)).toBeInTheDocument();
  });

  it("Draft all ready counts only the ready ones, and names each outcome", async () => {
    fa.draftAllReadyAction.mockResolvedValue({
      ok: true,
      result: [
        { userId: "gede-ic", name: "Gede Kusuma", ok: true, billNo: "GA/FB/2026/0002" },
        { userId: "u-dev", name: "Made Putra", ok: false, error: "Their time entries changed while the bill was being drafted." },
      ],
    });
    mount(preview(gede, made, putu));
    const all = screen.getByRole("button", { name: "Draft all ready (2)" });
    fireEvent.click(all);
    expect(await screen.findByRole("status")).toHaveTextContent("Drafted 1 bill. 1 could not be drafted; see below.");
    const list = screen.getByRole("list", { name: "Draft all results" });
    expect(list).toHaveTextContent("Gede Kusuma: drafted GA/FB/2026/0002.");
    expect(list).toHaveTextContent("Made Putra: Their time entries changed while the bill was being drafted.");
    expect(fa.draftAllReadyAction).toHaveBeenCalledWith("2026-09-01", "2026-09-30");
  });

  it("offers no Draft all when nobody is ready", () => {
    mount(preview(putu));
    expect(screen.queryByRole("button", { name: /Draft all ready/ })).toBeNull();
  });

  it("an empty preview from a real read says nobody has unbilled hours; a refused or failed one never does", () => {
    const { unmount } = mount(preview());
    expect(screen.getByText(/No freelancer has unbilled hours between 2026-09-01 and 2026-09-30/)).toBeInTheDocument();
    unmount();
    const forbidden = mount({ kind: "forbidden" });
    expect(screen.getByText(/You don.t have access to the freelancer preview/)).toBeInTheDocument();
    expect(screen.queryByText(/No freelancer has unbilled hours/)).toBeNull();
    forbidden.unmount();
    mount({ kind: "unavailable", reason: "platform 500" });
    expect(screen.getByText(/this is not a statement that there is nothing here/)).toBeInTheDocument();
  });

  it("a period the server would refuse is said, and nothing is previewed", () => {
    mount(null, ok([]), "The period ends before it starts.");
    expect(screen.getByRole("alert")).toHaveTextContent("The period ends before it starts.");
    expect(screen.queryByRole("button", { name: /^Draft / })).toBeNull();
  });

  it("the period picker is a plain GET form with both dates", () => {
    mount(preview());
    const form = screen.getByRole("form", { name: "Billing period" });
    expect(form).toHaveAttribute("method", "get");
    expect(within(form).getByLabelText("Period start")).toHaveValue("2026-09-01");
    expect(within(form).getByLabelText("Period end")).toHaveValue("2026-09-30");
    expect(within(form).getByLabelText("Period start")).toHaveAttribute("name", "from");
    expect(within(form).getByLabelText("Period end")).toHaveAttribute("name", "to");
  });
});

describe("the drafted bills", () => {
  it("a draft shows its figures, a link to approve it in Payables, and Discard", async () => {
    fa.discardBillAction.mockResolvedValue({ ok: true, result: { billId: "b1", discarded: true, releasedEntries: 4 } });
    mount(preview(), ok([draftBill()]));
    const row = within(screen.getByRole("heading", { level: 3, name: /Drafted bills/ }).closest("section") as HTMLElement);
    expect(row.getByText("GA/FB/2026/0001")).toBeInTheDocument();
    expect(row.getByText(/4,410,000/)).toBeInTheDocument();
    expect(row.getByRole("link", { name: "Approve GA/FB/2026/0001 in Payables" })).toHaveAttribute("href", "/finance/payables#bills-awaiting-approval");
    fireEvent.click(row.getByRole("button", { name: "Discard GA/FB/2026/0001" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Discarded GA/FB/2026/0001. 4 time entries are free to bill again.");
    expect(fa.discardBillAction).toHaveBeenCalledWith("b1");
  });

  it("keeps the no-withholding warning on the drafted bill until it is approved or discarded", () => {
    mount(preview(), ok([draftBill({ withholdingAmount: 0, warnings: [{ code: "NO_WITHHOLDING", message: NO_WH }] })]));
    const warnings = screen.getByRole("list", { name: "Warnings on GA/FB/2026/0001" });
    expect(warnings).toHaveTextContent("No withholding code.");
    expect(warnings).toHaveTextContent(NO_WH);
  });

  it("an approved bill of the period is listed without Discard or an approve link", () => {
    mount(preview(), ok([draftBill({ billId: "b2", billNo: "GA/FB/2026/0002", status: "approved", periodStart: "2026-09-01", periodEnd: "2026-09-30" })]));
    expect(screen.getByText("Other bills for 2026-09-01 to 2026-09-30")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Approve/ })).toBeNull();
  });

  it("a discard that is refused reads as the action's sentence", async () => {
    fa.discardBillAction.mockResolvedValue({ ok: false, error: "Only a draft can be discarded, and this bill has moved on.", reason: "bill_not_draft" });
    mount(preview(), ok([draftBill()]));
    fireEvent.click(screen.getByRole("button", { name: "Discard GA/FB/2026/0001" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only a draft can be discarded");
  });

  it("no drafts is said as such; a refused list is never that", () => {
    const { unmount } = mount(preview(), ok([]));
    expect(screen.getByText(/No freelancer bill is waiting/)).toBeInTheDocument();
    unmount();
    mount(preview(), { kind: "forbidden" });
    expect(screen.getByText(/You don.t have access to the freelancer bills/)).toBeInTheDocument();
    expect(screen.queryByText(/No freelancer bill is waiting/)).toBeNull();
  });
});
