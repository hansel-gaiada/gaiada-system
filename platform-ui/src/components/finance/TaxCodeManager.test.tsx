import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaxCode } from "@/lib/finance";

// PV5-F2 — the tax-code setup card. The server is the boundary (authorization, overlap, dates); what is tested here is
// that the screen offers the right actions, never offers a rate edit, and shows the server's answer verbatim.
const fa = vi.hoisted(() => ({ addTaxCode: vi.fn(), endTaxCode: vi.fn(), addStandardPpnCodes: vi.fn() }));
vi.mock("@/lib/financeActions", () => fa);
// PV5-14: the second-factor prompt the card shows on an `assurance_required` refusal.
const su = vi.hoisted(() => ({ getStepUpStatusAction: vi.fn(), simulateSecondFactorAction: vi.fn() }));
vi.mock("@/lib/stepUpActions", () => su);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { TaxCodeManager, baseLabel } from "./TaxCodeManager";

const ppn2025: TaxCode = {
  id: "c2", code: "PPN", name: "PPN 12% on 11/12", kind: "ppn_output", rate: 12, baseMultiplier: 0.9166666667,
  effectiveFrom: "2025-01-01", effectiveTo: null, notes: null, accountCode: "2140", inUse: true,
};
const ppn2022: TaxCode = {
  id: "c1", code: "PPN", name: "PPN 11%", kind: "ppn_output", rate: 11, baseMultiplier: 1,
  effectiveFrom: "2022-04-01", effectiveTo: "2024-12-31", notes: null, accountCode: "2140", inUse: true,
};

beforeEach(() => {
  Object.values(fa).forEach((f) => f.mockReset().mockResolvedValue({ ok: true }));
  Object.values(su).forEach((f) => f.mockReset().mockResolvedValue(null));
});

describe("TaxCodeManager", () => {
  it("a company with no codes is told taxed entries are refused, and can add the standard PPN codes", async () => {
    fa.addStandardPpnCodes.mockResolvedValue({ ok: true, result: { created: ["PPN from 2022-04-01", "PPN from 2025-01-01"], skipped: [] } });
    render(<TaxCodeManager codes={[]} />);
    expect(screen.getByText(/no tax codes, so an invoice, bill or journal line that carries tax is refused/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add the standard PPN codes" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Added PPN from 2022-04-01 and PPN from 2025-01-01.");
    expect(fa.addStandardPpnCodes).toHaveBeenCalledTimes(1);
  });

  it("running the standard action again reports nothing was added", async () => {
    fa.addStandardPpnCodes.mockResolvedValue({ ok: true, result: { created: [], skipped: ["PPN from 2022-04-01", "PPN from 2025-01-01"] } });
    render(<TaxCodeManager codes={[ppn2022, ppn2025]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add the standard PPN codes" }));
    expect(await screen.findByRole("status")).toHaveTextContent("already set up; nothing was added");
  });

  it("lists rate, share of the base and dates; only an open-ended row can be end-dated; no rate is editable", () => {
    render(<TaxCodeManager codes={[ppn2025, ppn2022]} />);
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.getByText("11/12 of the base")).toBeInTheDocument();
    expect(screen.getByText("full base")).toBeInTheDocument();
    expect(screen.getByText("2024-12-31")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "End-date" })).toHaveLength(1);
    // A rate is shown, never offered as a field: no input anywhere holds a listed rate.
    expect(screen.queryByDisplayValue("12")).toBeNull();
    expect(screen.queryByDisplayValue("11")).toBeNull();
    expect(baseLabel(1)).toBe("full base");
  });

  it("end-dating asks for a date first, then sends it", async () => {
    render(<TaxCodeManager codes={[ppn2025]} />);
    fireEvent.click(screen.getByRole("button", { name: "End-date" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Pick the last day this row applies.");
    expect(fa.endTaxCode).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Last day for PPN from 2025-01-01"), { target: { value: "2025-12-31" } });
    fireEvent.click(screen.getByRole("button", { name: "End-date" }));
    expect(await screen.findByRole("status")).toHaveTextContent("PPN from 2025-01-01 now ends on 2025-12-31.");
    expect(fa.endTaxCode).toHaveBeenCalledWith("c2", "2025-12-31");
  });

  it("adding a code sends the form; a refusal is shown verbatim", async () => {
    fa.addTaxCode.mockResolvedValue({ ok: false, error: "tax code PPN already has a row in force from 2025-01-01 with no end date, which overlaps these dates" });
    render(<TaxCodeManager codes={[ppn2025]} />);
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "PPN" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "PPN 13%" } });
    fireEvent.change(screen.getByLabelText("Rate (%)"), { target: { value: "13" } });
    fireEvent.change(screen.getByLabelText("Applies from"), { target: { value: "2026-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tax code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("overlaps these dates");
    expect(fa.addTaxCode).toHaveBeenCalledWith({
      code: "PPN", name: "PPN 13%", kind: "ppn_output", rate: "13", baseMultiplier: "1",
      effectiveFrom: "2026-01-01", effectiveTo: null,
    });
  });

  it("PV5-14: a refusal that names assurance shows 'This action needs a second factor' and, when the server offers it, the simulate button", async () => {
    su.getStepUpStatusAction.mockResolvedValue({ available: true, active: false, simulated: false, expiresAt: null, assurance: "linked", ttlSeconds: 900 });
    fa.addStandardPpnCodes.mockResolvedValue({ ok: false, error: "not authorized: cerbos denied configure on finance_tax (this action needs a second factor)", reason: "assurance_required" });
    render(<TaxCodeManager codes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add the standard PPN codes" }));
    expect(await screen.findByText("This action needs a second factor")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Simulate second factor (dev stage)" })).toBeInTheDocument();
  });

  it("PV5-14: any other refusal shows no second-factor prompt", async () => {
    fa.addStandardPpnCodes.mockResolvedValue({ ok: false, error: "not authorized: cerbos denied configure on finance_tax" });
    render(<TaxCodeManager codes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add the standard PPN codes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cerbos denied configure");
    expect(screen.queryByText("This action needs a second factor")).not.toBeInTheDocument();
    expect(su.getStepUpStatusAction).not.toHaveBeenCalled();
  });
});
