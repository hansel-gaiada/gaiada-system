import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// SCP-5a (BFF §63.18): "Draft this month's report". The officer picks a client and a month and the report is drafted and opened; the month's existing report is opened as it is; a refusal is
// said in words and names who may.
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock("@/lib/socialReportsActions", () => ({ draftReport: vi.fn() }));

import { draftReport } from "@/lib/socialReportsActions";
import { DRAFT_REASON, reportRefusalText } from "@/lib/socialReports";
import { DraftReportForm } from "./DraftReportForm";

const clients = [{ engagementId: "e1", clientName: "Northwind Traders" }, { engagementId: "e2", clientName: "Harborlight Hotel" }];
const mount = () => render(<DraftReportForm deptId="d-soc" clients={clients} thisMonth="2026-10" />);
const created = (id: string, draftedVia = "ai") => ({ ok: true as const, report: { id, status: "draft", simulated: false, draftedVia } });

beforeEach(() => { vi.clearAllMocks(); });

describe("DraftReportForm", () => {
  it("draws nothing for a person with no clients", () => {
    const { container } = render(<DraftReportForm deptId="d-soc" clients={[]} thisMonth="2026-10" />);
    expect(container).toBeEmptyDOMElement();
  });
  it("defaults to last month (the one that is due), and offers this month as so far", () => {
    mount();
    const month = screen.getByLabelText("Month") as HTMLSelectElement;
    expect(month.value).toBe("2026-09");
    expect([...month.options].map((o) => o.textContent)).toEqual(["September 2026 (due now)", "October 2026 (so far)"]);
  });
  it("drafts the chosen client's monthly report for the chosen month with a fresh id, then opens it", async () => {
    vi.mocked(draftReport).mockResolvedValue(created("r-new"));
    mount();
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "e2" } });
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2026-10" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft this month's report" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/departments/d-soc/social-reports/r-new"));
    const [eng, kind, period, id] = vi.mocked(draftReport).mock.calls[0];
    expect(kind).toBe("monthly");
    expect([eng, period]).toEqual(["e2", "2026-10"]);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });
  it("opens the month's existing report when there already is one (the server's idempotency)", async () => {
    vi.mocked(draftReport).mockResolvedValue(created("r-old", "existing"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Draft this month's report" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/departments/d-soc/social-reports/r-old"));
  });
  it("says a refusal in words, naming who may draft, and opens nothing", async () => {
    const refusal = { status: 403, error: "not authorized: cerbos denied create on social_report" };
    vi.mocked(draftReport).mockResolvedValue({ ok: false, refusal, message: reportRefusalText(refusal, "create") });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Draft this month's report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(DRAFT_REASON);
    expect(push).not.toHaveBeenCalled();
  });
});
