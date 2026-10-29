import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-6a (BFF §63.23.6): the "Import from your sheet" wizard, with the three actions mocked. A plan import walks paste -> parse -> columns guessed ->
// preview (a refused row and a client the server could not match) -> pick the client -> preview again -> untick a row -> import -> the result and its
// links; a 409 `import_rows_refused` draws the returned preview again with the refused rows marked. Invented names only.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/socialImportActions", () => ({ parseSheet: vi.fn(), previewImport: vi.fn(), applyImport: vi.fn() }));

import { applyImport, parseSheet, previewImport } from "@/lib/socialImportActions";
import type { ImportAnswer, ImportRow } from "@/lib/sheetImport";
import { SheetImport } from "./SheetImport";

const parse = vi.mocked(parseSheet);
const preview = vi.mocked(previewImport);
const apply = vi.mocked(applyImport);

const PLAN_ROWS = [
  ["Client", "Date", "Title"],
  ["Brand Alpha", "3/11/2026", "Hello"],
  ["Alfa Co", "4/11/2026", "Second"],
  ["Brand Beta", "5/10/2026", "Old"],
  ["", "", ""],
];
const PASTED = PLAN_ROWS.map((r) => r.join("\t")).join("\n");

const rowOf = (over: Partial<ImportRow> & Pick<ImportRow, "row" | "outcome">): ImportRow => ({
  refusals: [], warnings: [], engagementId: null, clientName: null, changes: null, cycle: null, post: null, ...over,
});
const post = (title: string) => ({ id: `p-${title}`, title, format: "feed", scheduledAt: "2026-11-03T02:00:00.000Z", isExtra: false, placement: ["instagram"] });
const answer = (rows: ImportRow[], over: Partial<ImportAnswer> = {}): ImportAnswer => ({
  dryRun: true, importId: null, summary: { rows: rows.length, ready: 0, unchanged: 0, refused: 0, skipped: 0 },
  unmatched: { clients: [], officers: [] }, rows, ...over,
});

const alpha = rowOf({ row: 1, outcome: "ready", engagementId: "e-alpha", clientName: "Brand Alpha", post: post("Hello"), warnings: [{ field: "time", code: "default_time_used" }] });
const alfaRefused = rowOf({ row: 2, outcome: "refused", refusals: [{ field: "client", code: "client_not_found" }] });
const alfaReady = rowOf({ row: 2, outcome: "ready", engagementId: "e-alpha2", clientName: "Alpha Co", post: post("Second"), cycle: { cycleId: null, deadline: "2026-10-31", created: true } });
const betaRefused = rowOf({ row: 3, outcome: "refused", clientName: "Brand Beta", refusals: [{ field: "date", code: "date_outside_month" }] });
const blank = rowOf({ row: 4, outcome: "skipped" });

const FIRST = answer([alpha, alfaRefused, betaRefused, blank], {
  unmatched: { clients: [{ sheetName: "Alfa Co", rows: [2], suggestions: [{ engagementId: "e-alpha2", clientName: "Alpha Co" }] }], officers: [] },
});
const SECOND = answer([alpha, alfaReady, betaRefused, blank]);

const props = {
  deptId: "d-soc", thisMonth: "2026-10", officers: [{ id: "u-sam", name: "Sam Officer" }], officersKnown: true,
  engagements: [{ id: "e-alpha", name: "Brand Alpha" }, { id: "e-alpha2", name: "Alpha Co" }, { id: "e-gamma", name: "Gamma Ltd" }],
} as const;
const mount = (over: Partial<Parameters<typeof SheetImport>[0]> = {}) => render(<SheetImport {...props} {...over} />);

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const pickPlan = () => fireEvent.click(screen.getByRole("radio", { name: /A month's plan/ }));

/** Step 1 to 3 on a pasted plan: leaves the wizard on the columns step. */
async function toColumns(tabs = [{ name: "Pasted", rows: PLAN_ROWS }]) {
  parse.mockResolvedValue({ ok: true, tabs });
  mount();
  pickPlan();
  click("Next: the sheet");
  fireEvent.click(screen.getByRole("radio", { name: /Paste rows/ }));
  fireEvent.change(screen.getByLabelText("Pasted rows"), { target: { value: PASTED } });
  click("Read the sheet");
  await screen.findByText(/The first rows of/);
  click("Next: the columns");
  await screen.findByRole("heading", { name: /Which column is which/ });
}

beforeEach(() => { parse.mockReset(); preview.mockReset(); apply.mockReset(); });
afterEach(() => vi.restoreAllMocks());

describe("the steps", () => {
  it("lists the six steps with the current one marked", () => {
    mount();
    const list = screen.getByRole("list", { name: "Steps" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["What", "The sheet", "Columns", "Names", "Preview", "Import"]);
    expect(items[0]).toHaveAttribute("aria-current", "step");
    expect(items.filter((i) => i.hasAttribute("aria-current"))).toHaveLength(1);
  });

  it("starts on the allocation, and offers next month for a plan, never before this one", () => {
    mount();
    expect(screen.getByRole("radio", { name: /The allocation/ })).toBeChecked();
    expect(screen.queryByLabelText("Month of the plan")).toBeNull();
    pickPlan();
    const month = screen.getByLabelText("Month of the plan");
    expect(month).toHaveValue("2026-11");
    expect(month).toHaveAttribute("min", "2026-10");
  });

  it("rolls December over to January for the default month", () => {
    mount({ thisMonth: "2026-12" });
    pickPlan();
    expect(screen.getByLabelText("Month of the plan")).toHaveValue("2027-01");
  });

  it("moves the current mark to the step the person is on", async () => {
    await toColumns();
    const items = within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    expect(items[2]).toHaveAttribute("aria-current", "step");
    expect(items[0]).not.toHaveAttribute("aria-current");
  });
});

describe("the sheet", () => {
  it("sends pasted text to import/parse and shows the first rows", async () => {
    await toColumns();
    expect(parse).toHaveBeenCalledWith({ text: PASTED });
  });

  it("reads a chosen file as base64 for import/parse", async () => {
    parse.mockResolvedValue({ ok: true, tabs: [{ name: "plan", rows: PLAN_ROWS }] });
    mount();
    click("Next: the sheet");
    const file = new File(["a,b"], "sheet.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText(/Sheet file/), { target: { files: [file] } });
    click("Read the sheet");
    await waitFor(() => expect(parse).toHaveBeenCalledWith({ filename: "sheet.csv", contentBase64: "YSxi" }));
  });

  it("asks for a file or rows before it reads, and ties the words to the box", () => {
    mount();
    click("Next: the sheet");
    click("Read the sheet");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Choose an .xlsx or .csv file first.");
    expect(screen.getByLabelText(/Sheet file/)).toHaveAttribute("aria-describedby", alert.id);
    expect(parse).not.toHaveBeenCalled();
  });

  it("shows the server's refusal in words, tied to the pasted box", async () => {
    parse.mockResolvedValue({ ok: false, error: "invalid_field", field: "text", message: "The pasted text is over 2 MB." });
    mount();
    click("Next: the sheet");
    fireEvent.click(screen.getByRole("radio", { name: /Paste rows/ }));
    fireEvent.change(screen.getByLabelText("Pasted rows"), { target: { value: "x" } });
    click("Read the sheet");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The pasted text is over 2 MB.");
    expect(screen.getByLabelText("Pasted rows")).toHaveAttribute("aria-describedby", alert.id);
    expect(screen.getByRole("button", { name: "Next: the columns" })).toBeDisabled();
  });

  it("offers a tab picker only when there are several tabs, and guesses again for the tab chosen", async () => {
    const tabs = [{ name: "Notes", rows: [["Memo"], ["x"]] }, { name: "Plan", rows: PLAN_ROWS }];
    parse.mockResolvedValue({ ok: true, tabs });
    mount();
    pickPlan();
    click("Next: the sheet");
    fireEvent.click(screen.getByRole("radio", { name: /Paste rows/ }));
    fireEvent.change(screen.getByLabelText("Pasted rows"), { target: { value: "x" } });
    click("Read the sheet");
    const picker = await screen.findByLabelText("Tab");
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["Notes (2 rows)", "Plan (5 rows)"]);
    fireEvent.change(picker, { target: { value: "1" } });
    click("Next: the columns");
    expect(await screen.findByLabelText(/^Client/)).toHaveValue("0");
  });

  it("does not offer a tab picker for one tab, and refuses an empty tab", async () => {
    parse.mockResolvedValue({ ok: true, tabs: [{ name: "Pasted", rows: [["Client", "Date"]] }] });
    mount();
    click("Next: the sheet");
    fireEvent.click(screen.getByRole("radio", { name: /Paste rows/ }));
    fireEvent.change(screen.getByLabelText("Pasted rows"), { target: { value: "x" } });
    click("Read the sheet");
    expect(await screen.findByText("This tab has no rows to import.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Tab")).toBeNull();
    expect(screen.getByRole("button", { name: "Next: the columns" })).toBeDisabled();
  });

  it("says when a tab is over the row limit", async () => {
    const rows = [["Client"], ...Array.from({ length: 300 }, (_, i) => [`Brand ${i}`])];
    parse.mockResolvedValue({ ok: true, tabs: [{ name: "Big", rows }] });
    mount();
    click("Next: the sheet");
    fireEvent.click(screen.getByRole("radio", { name: /Paste rows/ }));
    fireEvent.change(screen.getByLabelText("Pasted rows"), { target: { value: "x" } });
    click("Read the sheet");
    expect(await screen.findByText(/301 rows; one import takes 300 at most/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next: the columns" })).toBeDisabled();
  });
});

describe("the columns", () => {
  it("guesses each column from the header row, marks the required fields, and offers every column", async () => {
    await toColumns();
    expect(screen.getByLabelText(/^Client/)).toHaveValue("0");
    expect(screen.getByLabelText(/^Posting date/)).toHaveValue("1");
    expect(screen.getByLabelText(/^Title/)).toHaveValue("2");
    expect(screen.getByLabelText(/^Caption/)).toHaveValue("");
    expect(screen.getByText("Client").parentElement).toHaveTextContent("(required)");
    expect(screen.getByLabelText(/^Posting date/).parentElement).toHaveTextContent("(required)");
    const opts = within(screen.getByLabelText(/^Title/)).getAllByRole("option").map((o) => o.textContent);
    expect(opts).toEqual(["Not in my sheet", "Column A: Client", "Column B: Date", "Column C: Title"]);
    expect(screen.getByLabelText("Date order")).toHaveValue("dmy");
  });

  it("guesses nothing when the first row is not a header, and stops the preview until the required columns are chosen", async () => {
    await toColumns();
    click("Back");
    fireEvent.click(screen.getByLabelText("The first row is the header"));
    click("Next: the columns");
    expect(await screen.findByLabelText(/^Client/)).toHaveValue("");
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByText(/Choose a column for: Client, Posting date\./)).toBeInTheDocument();
    expect(within(screen.getByLabelText(/^Title/)).getAllByRole("option").map((o) => o.textContent)).toContain("Column A");
  });

  it("will not preview with one column given to two fields", async () => {
    await toColumns();
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByText(/One column can hold one field only: A is given to Client and Title/)).toBeInTheDocument();
  });

  it("offers the allocation's fields, and no date order, for an allocation", async () => {
    parse.mockResolvedValue({ ok: true, tabs: [{ name: "Pasted", rows: [["Klien", "PIC", "Jumlah Post"], ["Brand Alpha", "Sam", "12"]] }] });
    mount();
    click("Next: the sheet");
    fireEvent.click(screen.getByRole("radio", { name: /Paste rows/ }));
    fireEvent.change(screen.getByLabelText("Pasted rows"), { target: { value: "x" } });
    click("Read the sheet");
    await screen.findByText(/The first rows of/);
    click("Next: the columns");
    expect(await screen.findByLabelText(/^Officer/)).toHaveValue("1");
    expect(screen.getByLabelText(/^Posts per month/)).toHaveValue("2");
    expect(screen.queryByLabelText("Date order")).toBeNull();
  });
});

describe("a plan import, end to end", () => {
  it("previews with the right body, matches the unmatched client, skips a row, imports, and links the result", async () => {
    preview.mockResolvedValueOnce({ ok: true, answer: FIRST }).mockResolvedValueOnce({ ok: true, answer: SECOND });
    await toColumns();
    click("Preview");

    // The first preview: the body carries the columns, the plan's month, date order and zone, and the blank row already skipped.
    await screen.findByRole("heading", { name: /Names the ERP could not match/ });
    const first = preview.mock.calls[0];
    expect(first[0]).toBe("plan");
    expect(first[1]).toMatchObject({
      dryRun: true, headerRow: true, columns: { client: 0, date: 1, title: 2 }, rows: PLAN_ROWS, skip: [4], month: "2026-11", dateOrder: "dmy",
    });
    expect(typeof first[1].timeZone).toBe("string");
    expect(first[1]).not.toHaveProperty("clientMatches");

    // The names step: the suggestion first, then every other open client.
    const pick = screen.getByLabelText(/Client for .Alfa Co./);
    expect(screen.getByText("Row 3")).toBeInTheDocument();
    const groups = pick.querySelectorAll("optgroup");
    expect([...groups].map((g) => g.label)).toEqual(["Suggested", "All open clients"]);
    expect([...groups[0].querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Alpha Co"]);
    expect([...groups[1].querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Brand Alpha", "Gamma Ltd"]);
    fireEvent.change(pick, { target: { value: "e-alpha2" } });
    click("Preview again");

    // The second preview carries the pick.
    await screen.findByRole("heading", { name: /5\. Preview/ });
    expect(preview.mock.calls[1][1]).toMatchObject({ clientMatches: { "Alfa Co": "e-alpha2" }, skip: [4] });
    expect(screen.getByText("4 rows: 2 ready, 0 already there, 1 refused, 1 skipped.")).toBeInTheDocument();

    // The table: a real table, with a caption and header cells, every row's outcome and the reasons in words.
    const table = screen.getByRole("table", { name: /every row of the sheet/ });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Import", "Row", "Client", "What it does", "Outcome", "Why"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByText("Ready")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/There is no time, so the client's default time/)).toBeInTheDocument();
    expect(within(rows[1]).getByText("Alpha Co")).toBeInTheDocument();
    expect(within(rows[1]).getByText(/Opens the month.s cycle, deadline 2026-10-31/)).toBeInTheDocument();
    expect(within(rows[2]).getByText("Refused")).toBeInTheDocument();
    expect(within(rows[2]).getByText(/The date is outside the month you chose/)).toBeInTheDocument();
    expect(rows[2]).toHaveClass("scp-import__row--refused");
    expect(within(rows[3]).getByText("Skipped")).toBeInTheDocument();

    // A refused row stops the import until it is unticked; the button says how many rows it would write.
    const go = screen.getByRole("button", { name: "Import 2 rows" });
    expect(go).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Import row 4" }));
    expect(screen.getByText("4 rows: 2 ready, 0 already there, 0 refused, 2 skipped.")).toBeInTheDocument();
    expect(go).toBeEnabled();

    // The import: the same body with dryRun false and the row skipped as well.
    apply.mockResolvedValue({
      ok: true, answer: answer([alpha, alfaReady, rowOf({ row: 3, outcome: "skipped" }), blank], {
        dryRun: false, importId: "imp-1", summary: { rows: 4, ready: 2, unchanged: 0, refused: 0, skipped: 2 },
      }),
    });
    fireEvent.click(go);
    await screen.findByRole("heading", { name: /6\. Imported/ });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toBe("plan");
    expect(apply.mock.calls[0][1]).toMatchObject({ dryRun: false, skip: [3, 4], clientMatches: { "Alfa Co": "e-alpha2" }, month: "2026-11" });

    // The result: counts, announced in the polite status region, and the links.
    expect(screen.getAllByText("Imported 2 rows, 2 skipped.")).toHaveLength(2);
    expect(screen.getAllByRole("status").some((s) => s.getAttribute("aria-live") === "polite" && /Imported 2 rows/.test(s.textContent ?? ""))).toBe(true);
    const link = (name: string | RegExp) => screen.getByRole("link", { name });
    expect(link("Open the Allocation")).toHaveAttribute("href", "/departments/d-soc/allocation");
    expect(link("Brand Alpha: Plan tab")).toHaveAttribute("href", "/departments/d-soc/profile/e-alpha?tab=plan&month=2026-11");
    expect(link("Alpha Co: Plan tab")).toHaveAttribute("href", "/departments/d-soc/profile/e-alpha2?tab=plan&month=2026-11");
    expect(link(/Open Settings/)).toHaveAttribute("href", "/departments/d-soc/settings");
    expect(screen.getByText(/Import reference: imp-1/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Steps" }).querySelector('[aria-current="step"]')).toHaveTextContent("Import");
  });

  it("skips straight to the preview when every name matched", async () => {
    preview.mockResolvedValue({ ok: true, answer: SECOND });
    await toColumns();
    click("Preview");
    await screen.findByRole("heading", { name: /5\. Preview/ });
    expect(screen.queryByRole("heading", { name: /Names the ERP/ })).toBeNull();
    // Back from the preview goes to the columns when there were no names to pick.
    click("Back");
    expect(await screen.findByRole("heading", { name: /Which column is which/ })).toBeInTheDocument();
  });

  it("asks for a new preview before importing a row that was ticked back in", async () => {
    preview.mockResolvedValue({ ok: true, answer: SECOND });
    await toColumns();
    click("Preview");
    await screen.findByRole("heading", { name: /5\. Preview/ });
    fireEvent.click(screen.getByRole("checkbox", { name: "Import row 5" })); // the blank row, skipped for the person
    expect(screen.getByText(/You ticked rows back in/)).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("Not checked yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Import \d/ })).toBeDisabled();
    click("Update the preview");
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    expect(preview.mock.calls[1][1].skip).toBeUndefined();
  });

  it("offers the officer picker, from the company's members, for an officer the server could not match", async () => {
    parse.mockResolvedValue({ ok: true, tabs: [{ name: "Pasted", rows: [["Client", "Officer"], ["Brand Alpha", "Sammy"]] }] });
    preview.mockResolvedValueOnce({
      ok: true, answer: answer([rowOf({ row: 1, outcome: "refused", clientName: "Brand Alpha", refusals: [{ field: "officer", code: "officer_not_found" }] })], {
        unmatched: { clients: [], officers: [{ sheetName: "Sammy", rows: [1] }] },
      }),
    }).mockResolvedValueOnce({ ok: true, answer: answer([rowOf({ row: 1, outcome: "ready", clientName: "Brand Alpha", engagementId: "e-alpha", changes: { officer: { from: null, to: { id: "u-sam", name: "Sam Officer" } } } })]) });
    mount();
    click("Next: the sheet");
    fireEvent.click(screen.getByRole("radio", { name: /Paste rows/ }));
    fireEvent.change(screen.getByLabelText("Pasted rows"), { target: { value: "x" } });
    click("Read the sheet");
    await screen.findByText(/The first rows of/);
    click("Next: the columns");
    click("Preview");
    const pick = await screen.findByLabelText(/Officer for .Sammy./);
    expect(within(pick).getAllByRole("option").map((o) => o.textContent)).toEqual(["Leave unmatched (its rows are refused)", "Sam Officer"]);
    fireEvent.change(pick, { target: { value: "u-sam" } });
    click("Preview again");
    await screen.findByRole("heading", { name: /5\. Preview/ });
    expect(preview.mock.calls[1][1]).toMatchObject({ officerMatches: { Sammy: "u-sam" } });
    expect(preview.mock.calls[1][1]).not.toHaveProperty("month");
    expect(screen.getByText("Officer: none to Sam Officer")).toBeInTheDocument();
  });
});

describe("a refused apply (409 import_rows_refused)", () => {
  async function toPreview() {
    preview.mockResolvedValue({ ok: true, answer: SECOND });
    await toColumns();
    click("Preview");
    await screen.findByRole("heading", { name: /5\. Preview/ });
  }

  it("writes nothing, says so, and draws the returned preview with the refused rows marked", async () => {
    await toPreview();
    // The server found a refusal the preview did not.
    const detail = answer([alpha, rowOf({ row: 2, outcome: "refused", clientName: "Alpha Co", refusals: [{ field: "title", code: "missing_title" }] }), betaRefused, blank], {
      dryRun: true, summary: { rows: 4, ready: 1, unchanged: 0, refused: 2, skipped: 1 },
    });
    apply.mockResolvedValue({ ok: false, error: "import_rows_refused", message: "Some rows are refused, so nothing was written.", detail });
    fireEvent.click(screen.getByRole("checkbox", { name: "Import row 4" }));
    click("Import 2 rows");
    expect(await screen.findByText(/Nothing was written: the rows marked Refused need fixing/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /5\. Preview/ })).toBeInTheDocument();
    expect(screen.getByText("4 rows: 1 ready, 0 already there, 1 refused, 2 skipped.")).toBeInTheDocument();
    // Row 4 (index 3) stays unticked by the person, so it counts as skipped; the row the server now refuses is the one marked.
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows[1]).toHaveClass("scp-import__row--refused");
    expect(within(rows[1]).getByText(/There is no title, and no caption to take one from/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import 1 row" })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: /6\. Imported/ })).toBeNull();
  });

  it("shows any other refusal of the apply in words, and stays on the preview", async () => {
    await toPreview();
    apply.mockResolvedValue({ ok: false, error: "not_a_social_approver", message: "Only the Social Media head, the GM, the owner and the superadmin can import from a sheet." });
    fireEvent.click(screen.getByRole("checkbox", { name: "Import row 4" }));
    click("Import 2 rows");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Only the Social Media head, the GM, the owner and the superadmin/);
    expect(screen.getByRole("heading", { name: /5\. Preview/ })).toBeInTheDocument();
  });

  it("says so when the platform answers in a shape the page cannot read", async () => {
    await toPreview();
    apply.mockRejectedValue(new Error("bad shape"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Import row 4" }));
    click("Import 2 rows");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Nothing was written/);
  });
});

describe("the CSV template", () => {
  it("downloads the headers of the chosen kind as a file made in the browser", async () => {
    const create = vi.fn(() => "blob:template");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const seen: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { seen.push(`${this.download}|${this.href}`); });
    mount();
    click("Download CSV template");
    pickPlan();
    click("Download CSV template");
    expect(seen).toEqual(["social-allocation-import-template.csv|blob:template", "social-plan-import-template.csv|blob:template"]);
    const blobs = create.mock.calls.map((c) => (c as unknown as [Blob])[0]);
    expect(blobs[0].size).toBe("Client,Officer,Posts per month,Creative source,Batch,Report format,Report due day,Platforms,Formats,Default post time\r\n".length);
    expect(blobs[1].type).toContain("text/csv");
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
