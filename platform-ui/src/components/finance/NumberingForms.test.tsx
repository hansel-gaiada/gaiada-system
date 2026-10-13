import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { NumberCodes, ServiceLine } from "@/lib/billingNumbering";

// PV5-04b (PV-D35) — the "Service lines" and "Number codes" sections of the billing profile page. The server actions are mocked:
// what is pinned is what the components send and what they show. The decode table is STAFF-ONLY and has no edit control on a code.
const saveLine = vi.fn();
const preassign = vi.fn();
vi.mock("@/lib/billingNumberingActions", () => ({
  saveServiceLineAction: (...a: unknown[]) => saveLine(...a),
  preassignCodeAction: (...a: unknown[]) => preassign(...a),
}));

import { NumberCodesPanel, ServiceLinesPanel } from "./NumberingForms";

const LINES: ServiceLine[] = [
  { key: "web", name: "Web development", departmentId: "dept-web", active: true, updatedAt: "2026-10-01T00:00:00Z", invoiceCount: 2 },
  { key: "old", name: "Retired line", departmentId: null, active: false, updatedAt: "2026-10-01T00:00:00Z", invoiceCount: 1 },
];
const CODES: NumberCodes = {
  codes: [
    { serviceLineKey: "web", serviceLineName: "Web development", businessType: "hotel", businessTypeLabel: "Hotel / villa", code: "7K3", createdAt: "2026-10-01T00:00:00Z", invoiceCount: 2, used: true },
  ],
  businessTypes: [{ id: "hotel", label: "Hotel / villa" }, { id: "retail", label: "Retail / shop" }],
};
const formData = () => saveLine.mock.calls.at(-1)![1] as FormData;

beforeEach(() => { saveLine.mockReset(); preassign.mockReset(); });

describe("ServiceLinesPanel", () => {
  it("🔴 lists each line with its name and department, says a line is switched off, and never offers Delete", () => {
    render(<ServiceLinesPanel lines={LINES} />);
    expect(screen.getByRole("heading", { name: "Service lines" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name", { selector: "#sl-name-web" })).toHaveValue("Web development");
    expect(screen.getByLabelText("Department", { selector: "#sl-dept-web" })).toHaveValue("dept-web");
    expect(screen.getByRole("button", { name: "Switch off" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch on" })).toBeInTheDocument();
    expect(screen.getByText(/· switched off/, { selector: ".bs-note" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete|remove/i })).toBeNull();
  });

  it("a company with no lines is told it cannot issue yet", () => {
    render(<ServiceLinesPanel lines={[]} />);
    expect(screen.getByText(/No service lines yet, so no invoice can be issued/)).toBeInTheDocument();
  });

  it("🔴 switching off sends the key and active=false ONLY: it must not rename the line or clear its department", async () => {
    saveLine.mockResolvedValue({ ok: true, notice: "Saved." });
    render(<ServiceLinesPanel lines={LINES} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch off" }));
    await waitFor(() => expect(saveLine).toHaveBeenCalledTimes(1));
    const fd = formData();
    expect(fd.get("key")).toBe("web");
    expect(fd.get("active")).toBe("false");
    expect(fd.has("name")).toBe(false);
    expect(fd.has("departmentId")).toBe(false);
  });

  it("adding a line suggests its key from the name, and sends the key the user ends up with", async () => {
    saveLine.mockResolvedValue({ ok: true, notice: "Saved. Invoices not yet issued can now use it." });
    render(<ServiceLinesPanel lines={[]} />);
    const form = within(screen.getByRole("form", { name: "Add a service line" }));
    fireEvent.change(form.getByLabelText("Name"), { target: { value: "Search & SEO" } });
    expect(form.getByLabelText("Key")).toHaveValue("search_seo");
    fireEvent.change(form.getByLabelText("Key"), { target: { value: "seo" } });
    fireEvent.change(form.getByLabelText("Name"), { target: { value: "Search and SEO" } });
    expect(form.getByLabelText("Key")).toHaveValue("seo"); // a typed key is never overwritten by the suggestion
    fireEvent.click(form.getByRole("button", { name: "Add service line" }));
    await waitFor(() => expect(saveLine).toHaveBeenCalledTimes(1));
    expect(formData().get("key")).toBe("seo");
    expect(formData().get("name")).toBe("Search and SEO");
    expect(await screen.findByText(/can now use it/)).toBeInTheDocument();
  });

  it("shows the refusal in words next to the form", async () => {
    saveLine.mockResolvedValue({ ok: false, error: "Changing invoice numbering is limited to finance managers and company administrators." });
    render(<ServiceLinesPanel lines={[]} />);
    const form = within(screen.getByRole("form", { name: "Add a service line" }));
    fireEvent.change(form.getByLabelText("Name"), { target: { value: "Web" } });
    fireEvent.click(form.getByRole("button", { name: "Add service line" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/limited to finance managers/);
  });
});

describe("NumberCodesPanel", () => {
  it("🔴 is the decode table: each code with its service line and business type, and NO edit control on a code", () => {
    render(<NumberCodesPanel data={CODES} lines={LINES} />);
    expect(screen.getByRole("heading", { name: "Number codes" })).toBeInTheDocument();
    expect(screen.getByText("7K3")).toBeInTheDocument();
    // The label shows in the table and as a pre-assign option.
    expect(screen.getAllByText("Hotel / villa").length).toBeGreaterThanOrEqual(2);
    // The only inputs are the pre-assign form's: a code in the table is plain text, never a field.
    expect(screen.queryByDisplayValue("7K3")).toBeNull();
    expect(screen.getByText(/never changed or reused/)).toBeInTheDocument();
  });

  it("with no codes it says one is created at the first invoice of each pair", () => {
    render(<NumberCodesPanel data={{ ...CODES, codes: [] }} lines={LINES} />);
    expect(screen.getByText(/No codes yet/)).toBeInTheDocument();
  });

  it("pre-assigning sends the pair, and the code only when one is typed (blank = generated)", async () => {
    preassign.mockResolvedValue({ ok: true, notice: "Assigned the code QX7. It is used from the first invoice of this pair." });
    render(<NumberCodesPanel data={CODES} lines={LINES} />);
    fireEvent.change(screen.getByLabelText("Service line"), { target: { value: "web" } });
    fireEvent.change(screen.getByLabelText("Client business type"), { target: { value: "retail" } });
    fireEvent.click(screen.getByRole("button", { name: "Assign code" }));
    await waitFor(() => expect(preassign).toHaveBeenCalledTimes(1));
    const fd = preassign.mock.calls[0][1] as FormData;
    expect(fd.get("serviceLineKey")).toBe("web");
    expect(fd.get("businessType")).toBe("retail");
    expect(String(fd.get("code") ?? "")).toBe("");
    expect(await screen.findByText(/Assigned the code QX7/)).toBeInTheDocument();
  });

  it("a company with no lines cannot assign a code", () => {
    render(<NumberCodesPanel data={{ ...CODES, codes: [] }} lines={[]} />);
    expect(screen.getByRole("button", { name: "Assign code" })).toBeDisabled();
  });
});
