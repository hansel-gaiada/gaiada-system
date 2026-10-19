import { describe, expect, it } from "vitest";
import {
  BILLABLE_LIMIT, UNAVAILABLE_LEAD, cancelErrorText, cancelledWords, contractHref, contractName, countDue, defaultSelection, draftErrorText,
  dueByOrToday, hasInstalmentLines, instalmentName, isFixedFeeLine, isTickable, lineCells, summariseSelection, unavailableWords,
  type BillableInstalment,
} from "./contractBilling";
import { blockerFix } from "./billingView";
import { readingOfInstalmentsDue } from "./overviewPulse";
import { pulseValueText } from "./overviewPulse";

// DW-10f-3b (BFF §61.5, §61.9) — the pure rules behind /invoices/new and the invoice page: which rows can be ticked, what the ticked
// rows add up to (exact), every refusal of the draft in a sentence, and what an instalment line prints (never the text "undefined").

const item = (over: Partial<BillableInstalment> = {}): BillableInstalment => ({
  instalmentId: "i1", client: { id: "cl-4", name: "Viceroy" }, contract: { id: "k1", title: "Website build", reference: "GDA-1", kind: "agreement", projectId: null },
  position: 1, count: 2, label: "Deposit", amount: 45_000_000, currency: "IDR", due: { kind: "on_signing", on: "2026-10-01" }, state: "due", invoice: null,
  ...over,
});

describe("what can be ticked", () => {
  it("only a `due` instalment is tickable; `upcoming` and `invoicing` are not", () => {
    expect(isTickable(item({ state: "due" }))).toBe(true);
    expect(isTickable(item({ state: "upcoming" }))).toBe(false);
    expect(isTickable(item({ state: "invoicing" }))).toBe(false);
    expect(isTickable(item({ state: "something new" }))).toBe(false);
  });

  it("🔴 every due row is ticked when the list opens, and nothing else", () => {
    const rows = [item({ instalmentId: "a" }), item({ instalmentId: "b", state: "upcoming" }), item({ instalmentId: "c", state: "invoicing", invoice: { id: "inv", status: "draft" } }), item({ instalmentId: "d" })];
    expect(defaultSelection(rows)).toEqual(["a", "d"]);
    expect(defaultSelection([])).toEqual([]);
  });

  it("counts the due rows for the Finance tile", () => {
    expect(countDue([item(), item({ state: "upcoming" }), item({ state: "invoicing" }), item()])).toBe(2);
  });
});

describe("summariseSelection · exact, in the currency's minor unit", () => {
  it("adds the ticked rows in one currency", () => {
    const rows = [item({ instalmentId: "a", amount: 30_000_000 }), item({ instalmentId: "b", amount: 15_000_000 })];
    expect(summariseSelection(rows, ["a", "b"])).toEqual({ count: 2, currency: "IDR", mixed: false, totalText: "IDR 45,000,000" });
  });

  it("is exact to the cent (a float sum of 0.1 + 0.2 is not 0.3)", () => {
    const rows = [item({ instalmentId: "a", amount: 0.1, currency: "USD" }), item({ instalmentId: "b", amount: 0.2, currency: "USD" })];
    expect(summariseSelection(rows, ["a", "b"]).totalText).toBe("USD 0.30");
  });

  it("🔴 flags a mix of currencies before the click, and totals nothing", () => {
    const rows = [item({ instalmentId: "a" }), item({ instalmentId: "b", currency: "USD", amount: 100 })];
    expect(summariseSelection(rows, ["a", "b"])).toEqual({ count: 2, currency: null, mixed: true, totalText: null });
  });

  it("an empty selection, and a tick that is not tickable or not on the list, count for nothing", () => {
    const rows = [item({ instalmentId: "a" }), item({ instalmentId: "b", state: "upcoming" })];
    expect(summariseSelection(rows, [])).toEqual({ count: 0, currency: null, mixed: false, totalText: null });
    expect(summariseSelection(rows, ["b", "zzz"]).count).toBe(0);
  });
});

describe("names and links", () => {
  it("names an instalment and its agreement, and links the contract's own row on the client's page", () => {
    expect(instalmentName(item())).toBe("Deposit (1 of 2)");
    expect(contractName(item().contract)).toBe("Website build · GDA-1");
    expect(contractName({ ...item().contract, reference: null })).toBe("Website build");
    expect(contractHref("cl-4", "dk 12")).toBe("/clients/cl-4/billing#contract-dk%2012");
  });
});

describe("Due up to", () => {
  it("defaults to today, and a malformed or impossible date falls back to it and says so", () => {
    expect(dueByOrToday(undefined, "2026-10-19")).toEqual({ dueBy: "2026-10-19", invalid: false });
    expect(dueByOrToday("", "2026-10-19")).toEqual({ dueBy: "2026-10-19", invalid: false });
    expect(dueByOrToday("2026-12-01", "2026-10-19")).toEqual({ dueBy: "2026-12-01", invalid: false });
    expect(dueByOrToday("2026-02-30", "2026-10-19")).toEqual({ dueBy: "2026-10-19", invalid: true });
    expect(dueByOrToday("tomorrow", "2026-10-19")).toEqual({ dueBy: "2026-10-19", invalid: true });
  });
});

describe("every refusal of the draft is a sentence", () => {
  const CODES = [
    "instalment_unavailable", "source_fields_mixed", "source_invalid", "instalment_ids_invalid", "due_by_invalid", "tax_code_invalid",
    "client_not_found", "currency_mixed",
  ];

  it("🔴 words every code of §61.5, and none is the code or the raw message", () => {
    for (const code of CODES) {
      const text = draftErrorText(409, code, "RAW SERVER TEXT");
      expect(text, code).not.toBe(code);
      expect(text, code).not.toMatch(/RAW SERVER TEXT|_/);
    }
    expect(draftErrorText(409, "instalment_unavailable", "x")).toBe(UNAVAILABLE_LEAD);
    expect(draftErrorText(400, "source_fields_mixed", "x")).toMatch(/never both/);
    expect(draftErrorText(400, "currency_mixed", "x")).toMatch(/one invoice per currency/i);
  });

  it("a 403 is a sentence, and an unknown code keeps the server's message", () => {
    expect(draftErrorText(403, undefined, "forbidden")).toMatch(/finance administrators/);
    expect(draftErrorText(500, "novel", "the server said this")).toBe("the server said this");
  });

  it("words each reason an instalment can no longer be billed", () => {
    for (const r of ["not_found", "other_client", "not_signed", "superseded", "not_due", "already_invoiced", "something_else"]) {
      expect(unavailableWords(r), r).not.toMatch(/_/);
    }
    expect(unavailableWords("already_invoiced")).toBe("is already on another invoice");
    expect(unavailableWords("not_due")).toBe("is not due yet for the date you chose");
  });
});

describe("Cancel draft", () => {
  it("says how many instalments went back to the schedule", () => {
    expect(cancelledWords(0)).toMatch(/Draft cancelled\. Nothing was posted/);
    expect(cancelledWords(1)).toBe("Draft cancelled. 1 instalment goes back to the payment schedule, ready to invoice again.");
    expect(cancelledWords(3)).toBe("Draft cancelled. 3 instalments go back to the payment schedule, ready to invoice again.");
  });

  it("words its refusals: forbidden, gone, issued, and a cancelled instalment invoice that cannot come back", () => {
    expect(cancelErrorText(403, undefined, "x")).toMatch(/finance administrators/);
    expect(cancelErrorText(404, undefined, "x")).toMatch(/could not be found/);
    expect(cancelErrorText(409, undefined, "RAW")).toMatch(/issued/);
    expect(cancelErrorText(409, "invoice_unvoid_refused", "RAW")).toMatch(/cannot be brought back/);
    expect(cancelErrorText(500, undefined, "the server said this")).toBe("the server said this");
  });
});

describe("an invoice line never prints 'undefined'", () => {
  it("an instalment line is a fixed fee, quantity 1, linked to its contract", () => {
    const l = { kind: "instalment" as const, description: "GDA-1 Website build · Deposit (1 of 2)", amount: 30_000_000, contractId: "k1", instalmentId: "i1" };
    expect(isFixedFeeLine(l)).toBe(true);
    expect(lineCells(l)).toEqual({ description: l.description, quantity: "1", rate: "Fixed fee", amount: 30_000_000, contractId: "k1", fixedFee: true });
  });

  it("a line with no hours and no rate reads as a fixed fee even without a kind", () => {
    expect(lineCells({ description: "Fee", amount: 5 }).fixedFee).toBe(true);
    expect(lineCells({ description: "Fee", amount: 5, hours: null, rate: null }).quantity).toBe("1");
  });

  it("an hourly line keeps its hours and leaves the rate for the page to format", () => {
    expect(lineCells({ kind: "hours", description: "Time", hours: 42, rate: 150, amount: 6300 })).toEqual({
      description: "Time", quantity: "42", rate: null, amount: 6300, contractId: null, fixedFee: false,
    });
    // every line written before 10f has no kind: it is an hourly line
    expect(lineCells({ description: "Time", hours: 10, rate: 100, amount: 1000 }).fixedFee).toBe(false);
  });

  it("no cell is ever the text 'undefined' or 'null'", () => {
    for (const l of [{ description: "A", amount: 1 }, { kind: "instalment" as const, description: "B", amount: 2 }, { description: "C", hours: 1, rate: 2, amount: 2 }]) {
      const c = lineCells(l);
      expect(JSON.stringify(c)).not.toMatch(/undefined/);
      expect(c.quantity).not.toMatch(/undefined|null/);
    }
  });

  it("knows an invoice has instalment lines", () => {
    expect(hasInstalmentLines([{ kind: "instalment" }])).toBe(true);
    expect(hasInstalmentLines([{ kind: "hours" }, {}])).toBe(false);
    expect(hasInstalmentLines([])).toBe(false);
  });
});

describe("the three new issue blockers link the client's contracts", () => {
  it("only when the page says where; never a guessed link", () => {
    for (const code of ["INSTALMENT_LINES_INVALID", "INSTALMENT_CONTRACT_NOT_SIGNED", "INSTALMENT_SUPERSEDED"]) {
      expect(blockerFix(code, { contractsHref: "/clients/cl-4/billing" })).toEqual({ href: "/clients/cl-4/billing", label: "Open the client's contracts" });
      expect(blockerFix(code)).toBeNull();
    }
    expect(blockerFix("NO_SERVICE_LINE")).toEqual({ href: "#service-line", label: "Choose a service line" });
  });
});

describe("the Finance Overview tile · 'Instalments due to invoice'", () => {
  const answer = (items: Pick<BillableInstalment, "state">[]) => ({ kind: "ok" as const, data: { dueBy: "2026-10-19", items: items as BillableInstalment[] } });

  it("counts only the due instalments", () => {
    const r = readingOfInstalmentsDue(answer([{ state: "due" }, { state: "upcoming" }, { state: "invoicing" }, { state: "due" }]));
    expect(r).toEqual({ kind: "ok", value: 2 });
    expect(pulseValueText(r)).toBe("2");
  });

  it("🔴 a failed read is 'Unavailable' and a refused one 'No access': never 0", () => {
    const failed = readingOfInstalmentsDue({ kind: "unavailable", reason: "boom" });
    expect(failed).toEqual({ kind: "unavailable" });
    expect(pulseValueText(failed)).toBe("Unavailable");
    const refused = readingOfInstalmentsDue({ kind: "forbidden" });
    expect(pulseValueText(refused)).toBe("No access");
  });

  it("an honest zero is 0, and a full page of rows says 'N or more'", () => {
    expect(pulseValueText(readingOfInstalmentsDue(answer([])))).toBe("0");
    const full = readingOfInstalmentsDue(answer(Array.from({ length: BILLABLE_LIMIT }, () => ({ state: "due" }))));
    expect(full).toEqual({ kind: "ok", value: BILLABLE_LIMIT, detail: `${BILLABLE_LIMIT} or more` });
  });
});
