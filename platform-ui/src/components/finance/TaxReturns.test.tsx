import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReadResult } from "@/lib/readResult";
import type { TaxReturn, TaxReturnDrift } from "@/lib/taxReturns";

// DW-7g-1 — the Returns section on Finance > Tax. The server is the boundary (Cerbos prepare/file, the period and amend
// rules); what is pinned here is that every read is told honestly, a draft shows no figure the server did not just give,
// the controls follow the capability, filing needs the typed period and a reference, and the drift is never "none" by default.
const fa = vi.hoisted(() => ({ prepareTaxReturn: vi.fn(), fileTaxReturn: vi.fn() }));
vi.mock("@/lib/financeTaxActions", () => fa);
const su = vi.hoisted(() => ({ getStepUpStatusAction: vi.fn(), simulateSecondFactorAction: vi.fn() }));
vi.mock("@/lib/stepUpActions", () => su);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { TaxReturns } from "./TaxReturns";

const draft: TaxReturn = {
  id: "r-draft", kind: "ppn", periodYear: 2026, periodMonth: 9, periodStart: "2026-09-01", periodEnd: "2026-09-30", status: "draft",
  filedOutput: null, filedInput: null, filedNet: null, filedAt: null, filingReference: null, notes: null,
};
const filed: TaxReturn = {
  id: "r-filed", kind: "ppn", periodYear: 2026, periodMonth: 8, periodStart: "2026-08-01", periodEnd: "2026-08-31", status: "filed",
  filedOutput: "5000000.0000", filedInput: "2000000.0000", filedNet: "3000000.0000", filedAt: "2026-09-20T03:00:00.000Z", filingReference: "NTPN-AUG", notes: null,
};
const clean: ReadResult<TaxReturnDrift> = { kind: "ok", data: { problems: [], clean: true } };
const ok = (rows: TaxReturn[]): ReadResult<TaxReturn[]> => ({ kind: "ok", data: rows });
const view = (over: Partial<Parameters<typeof TaxReturns>[0]> = {}) =>
  render(<TaxReturns returns={ok([draft, filed])} drift={clean} canAct defaultPeriod={{ year: 2026, month: 9 }} {...over} />);

beforeEach(() => {
  fa.prepareTaxReturn.mockReset().mockResolvedValue({ ok: true });
  fa.fileTaxReturn.mockReset().mockResolvedValue({ ok: true });
  Object.values(su).forEach((f) => f.mockReset().mockResolvedValue(null));
});
afterEach(cleanup);

describe("the returns list", () => {
  it("shows kind and period, status, the figures as filed, the filed date and the reference", () => {
    view();
    expect(screen.getByText("PPN 2026-08")).toBeInTheDocument();
    expect(screen.getByText("2026-08-01 to 2026-08-31")).toBeInTheDocument();
    expect(screen.getByText("IDR 5,000,000")).toBeInTheDocument();
    expect(screen.getByText("IDR 2,000,000")).toBeInTheDocument();
    expect(screen.getByText(/IDR 3,000,000/)).toBeInTheDocument();
    expect(screen.getByText("2026-09-20")).toBeInTheDocument();
    expect(screen.getByText("NTPN-AUG")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Returns · 2/ })).toBeInTheDocument();
  });

  it("a draft shows no figure: it stores none, and says so", () => {
    view({ returns: ok([draft]) });
    expect(screen.getByText("PPN 2026-09")).toBeInTheDocument();
    expect(screen.getByText(/not stored until filed/)).toBeInTheDocument();
    expect(screen.getByText("Not filed")).toBeInTheDocument();
    expect(screen.queryByText(/IDR/)).toBeNull();
  });

  it("a net below zero is called refundable, with the server's figure", () => {
    view({ returns: ok([{ ...filed, filedNet: "-250000.0000" }]) });
    expect(screen.getByText(/250,000/)).toBeInTheDocument();
    expect(screen.getByText(/refundable/)).toBeInTheDocument();
  });

  it("an empty list is said as empty only when the read succeeded", () => {
    view({ returns: ok([]) });
    expect(screen.getByText(/No return has been prepared for this company/)).toBeInTheDocument();
  });

  it("a refused read says so in words and is never the empty note", () => {
    view({ returns: { kind: "forbidden" } });
    expect(screen.getByText(/You don't have access to tax returns/)).toBeInTheDocument();
    expect(screen.queryByText(/No return has been prepared/)).toBeNull();
  });

  it("a failed read says it cannot tell, with the server's words, and is never the empty note", () => {
    view({ returns: { kind: "unavailable", reason: "platform 500" } });
    const a = screen.getByText(/Could not load the tax returns/);
    expect(a).toHaveTextContent("not a statement that none were prepared");
    expect(a).toHaveTextContent("platform 500");
    expect(screen.queryByText(/No return has been prepared/)).toBeNull();
  });
});

describe("the controls follow the capability", () => {
  it("without it there is no Prepare, no Show figures, no Record filing and no Amend, but the list is still there", () => {
    view({ canAct: false });
    expect(screen.queryByRole("button", { name: /Prepare return/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Record filing/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Show figures/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Amend/ })).toBeNull();
    expect(screen.getByText("NTPN-AUG")).toBeInTheDocument();
  });

  it("with it a draft offers Show figures and Record filing, and a filed return offers Amend, not Record filing", () => {
    view();
    expect(screen.getByRole("button", { name: "Show figures for PPN 2026-09" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record filing for PPN 2026-09" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Amend PPN 2026-08" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record filing for PPN 2026-08" })).toBeNull();
  });
});

describe("preparing a return", () => {
  it("defaults to PPN for the last closed month and sends it", async () => {
    fa.prepareTaxReturn.mockResolvedValue({
      ok: true,
      result: { id: "r-new", kind: "ppn", periodYear: 2026, periodMonth: 9, status: "draft", computed: { output: 1000000, input: 400000, net: 600000 } },
    });
    view({ returns: ok([]) });
    expect(screen.getByLabelText("Year")).toHaveValue("2026");
    expect(screen.getByLabelText("Month")).toHaveValue("9");
    fireEvent.click(screen.getByRole("button", { name: "Prepare return" }));
    const status = await screen.findByRole("status");
    expect(fa.prepareTaxReturn).toHaveBeenCalledWith("ppn", 2026, 9);
    expect(status).toHaveTextContent("Prepared PPN 2026-09 as a draft");
    expect(status).toHaveTextContent("Output VAT IDR 1,000,000");
    expect(status).toHaveTextContent("Net payable IDR 600,000");
    expect(status).toHaveTextContent("Nothing is stored until it is filed");
  });

  it("offers the five kinds; the annual one has no month and sends none", async () => {
    view({ returns: ok([]) });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(expect.arrayContaining([
      "PPN (VAT), monthly", "PPh 21, monthly", "PPh 23, monthly", "PPh 4(2), monthly", "PPh Badan, annual",
    ]));
    fireEvent.change(screen.getByLabelText("Return"), { target: { value: "pph_badan" } });
    expect(screen.getByLabelText("Month")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Prepare return" }));
    await waitFor(() => expect(fa.prepareTaxReturn).toHaveBeenCalledWith("pph_badan", 2026, null));
  });

  it("shows the server's refusal verbatim (a period already filed, a 403 in words)", async () => {
    fa.prepareTaxReturn.mockResolvedValue({ ok: false, error: "the ppn return for 2026-9 is already filed" });
    view({ returns: ok([]) });
    fireEvent.click(screen.getByRole("button", { name: "Prepare return" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("the ppn return for 2026-9 is already filed");
    fa.prepareTaxReturn.mockResolvedValue({ ok: false, error: "You don't have permission to prepare tax returns." });
    fireEvent.click(screen.getByRole("button", { name: "Prepare return" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("You don't have permission to prepare tax returns."));
  });

  it("Show figures asks the server and shows its live answer on that draft, marked as not stored", async () => {
    fa.prepareTaxReturn.mockResolvedValue({
      ok: true, result: { id: "r-draft", kind: "ppn", periodYear: 2026, periodMonth: 9, status: "draft", computed: { output: 700, input: 200, net: 500 } },
    });
    view({ returns: ok([draft]) });
    fireEvent.click(screen.getByRole("button", { name: "Show figures for PPN 2026-09" }));
    expect(await screen.findByText("IDR 700")).toBeInTheDocument();
    expect(fa.prepareTaxReturn).toHaveBeenCalledWith("ppn", 2026, 9);
    expect(screen.getByText("IDR 200")).toBeInTheDocument();
    expect(screen.getByText(/live, not stored/)).toBeInTheDocument();
  });
});

describe("recording a filing", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Record filing for PPN 2026-09" }));

  it("says what it does, and arms only with a reference and the period typed exactly", () => {
    view();
    open();
    expect(screen.getByText(/This marks the return as filed with the tax office; it cannot be undone except by an amendment\./)).toBeInTheDocument();
    const go = screen.getByRole("button", { name: "Record filing" });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Filing reference (NTPN or receipt)"), { target: { value: "NTPN-SEP" } });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Type the period to confirm"), { target: { value: "ppn 2026-09" } });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Type the period to confirm"), { target: { value: "PPN 2026-09" } });
    expect(go).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Filing reference (NTPN or receipt)"), { target: { value: "   " } });
    expect(go).toBeDisabled();
  });

  it("sends the reference and the typed period, then reports the figures of record the server returned", async () => {
    fa.fileTaxReturn.mockResolvedValue({
      ok: true,
      result: { id: "r-draft", status: "filed", period: "PPN 2026-09", filingReference: "NTPN-SEP", filed: { output: 900, input: 300, net: 600 } },
    });
    view();
    open();
    fireEvent.change(screen.getByLabelText("Filing reference (NTPN or receipt)"), { target: { value: "NTPN-SEP" } });
    fireEvent.change(screen.getByLabelText("Type the period to confirm"), { target: { value: "PPN 2026-09" } });
    fireEvent.click(screen.getByRole("button", { name: "Record filing" }));
    const status = await screen.findByRole("status");
    expect(fa.fileTaxReturn).toHaveBeenCalledWith("r-draft", { filingReference: "NTPN-SEP", confirm: "PPN 2026-09", amend: false });
    expect(status).toHaveTextContent("Filing recorded for PPN 2026-09, reference NTPN-SEP");
    expect(status).toHaveTextContent("Net payable IDR 600");
    // The form closes: the page re-reads the list, this component carries nothing over.
    expect(screen.queryByLabelText("Type the period to confirm")).toBeNull();
  });

  it("keeps the form open and shows the server's words when it refuses (period not ended, 403)", async () => {
    fa.fileTaxReturn.mockResolvedValue({ ok: false, error: "period ends 2026-10-31 — cannot file before it closes" });
    view();
    open();
    fireEvent.change(screen.getByLabelText("Filing reference (NTPN or receipt)"), { target: { value: "N" } });
    fireEvent.change(screen.getByLabelText("Type the period to confirm"), { target: { value: "PPN 2026-09" } });
    fireEvent.click(screen.getByRole("button", { name: "Record filing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot file before it closes");
    expect(screen.getByLabelText("Type the period to confirm")).toBeInTheDocument();
  });

  it("offers the second-factor step when only assurance stands in the way", async () => {
    fa.fileTaxReturn.mockResolvedValue({ ok: false, error: "You need a second factor before you can record a tax filing.", reason: "assurance_required" });
    view();
    open();
    fireEvent.change(screen.getByLabelText("Filing reference (NTPN or receipt)"), { target: { value: "N" } });
    fireEvent.change(screen.getByLabelText("Type the period to confirm"), { target: { value: "PPN 2026-09" } });
    fireEvent.click(screen.getByRole("button", { name: "Record filing" }));
    expect(await screen.findByText(/This action needs a second factor/)).toBeInTheDocument();
  });

  it("Cancel closes the form without sending anything", () => {
    view();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Type the period to confirm")).toBeNull();
    expect(fa.fileTaxReturn).not.toHaveBeenCalled();
  });
});

describe("amending a filed return", () => {
  it("says it is a separate statement, and sends amend:true with its own reference", async () => {
    fa.fileTaxReturn.mockResolvedValue({
      ok: true,
      result: { id: "r-filed", status: "amended", period: "PPN 2026-08", filingReference: "NTPN-AMD", filed: { output: 5100000, input: 2000000, net: 3100000 } },
    });
    view();
    fireEvent.click(screen.getByRole("button", { name: "Amend PPN 2026-08" }));
    expect(screen.getByText(/records an amendment to a return that is already filed/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filing reference (NTPN or receipt)"), { target: { value: "NTPN-AMD" } });
    fireEvent.change(screen.getByLabelText("Type the period to confirm"), { target: { value: "PPN 2026-08" } });
    fireEvent.click(screen.getByRole("button", { name: "Record amendment" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Amendment recorded for PPN 2026-08, reference NTPN-AMD");
    expect(fa.fileTaxReturn).toHaveBeenCalledWith("r-filed", { filingReference: "NTPN-AMD", confirm: "PPN 2026-08", amend: true });
  });
});

describe("the drift banner", () => {
  const drifted: ReadResult<TaxReturnDrift> = {
    kind: "ok",
    data: {
      clean: false,
      problems: [{ problem: "TAX_RETURN_LEDGER_DRIFT", detail: "ppn 2026-08: filed net 3000000 but the ledger now computes 3200000 (difference 200000) — a journal was posted into a filed period" }],
    },
  };

  it("lists each drifted return verbatim, says to amend or carry forward, and marks the row", () => {
    view({ drift: drifted });
    expect(screen.getByText("Filed returns that no longer match the ledger")).toBeInTheDocument();
    expect(screen.getByText(/filed net 3000000 but the ledger now computes 3200000/)).toBeInTheDocument();
    expect(screen.getByText(/amend that return/)).toBeInTheDocument();
    expect(screen.getByText(/carry the difference into a later return/)).toBeInTheDocument();
    expect(screen.getByText(/ledger has moved/)).toBeInTheDocument();
    expect(screen.queryByText(/Every filed return still matches the ledger/)).toBeNull();
  });

  it("says the filed returns match only when the drift read succeeded and was clean", () => {
    view();
    expect(screen.getByText("Every filed return still matches the ledger.")).toBeInTheDocument();
  });

  it("a failed drift read says it could not check, never 'no drift' and never the match line", () => {
    view({ drift: { kind: "unavailable", reason: "ledger function failed" } });
    const a = screen.getByText(/Could not check whether the filed returns still match the ledger/);
    expect(a).toHaveTextContent("not a statement that they do");
    expect(a).toHaveTextContent("ledger function failed");
    expect(screen.queryByText(/Every filed return still matches the ledger/)).toBeNull();
    expect(screen.queryByText(/no longer match/)).toBeNull();
  });

  it("a refused drift read says so in words, and does not claim a match", () => {
    view({ drift: { kind: "forbidden" } });
    expect(screen.getByText(/You don't have access to the check of filed returns against the ledger/)).toBeInTheDocument();
    expect(screen.queryByText(/Every filed return still matches the ledger/)).toBeNull();
  });

  it("with no filed return there is nothing to claim a match about", () => {
    view({ returns: ok([draft]) });
    expect(screen.queryByText(/Every filed return still matches the ledger/)).toBeNull();
  });
});
