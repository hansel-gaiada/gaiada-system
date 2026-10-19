import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { test } from "./settledPage";
import { tenantCookie } from "./appCookies";

// DW-10f-2b / 10f-3b (BFF §61.9): the CONTRACT-BILLING screens, end to end under DEMO_MODE (src/lib/demoBilling.ts, demoFixtures.ts, demoPortal.ts).
//
//   1. The payment schedule on the staff contracts page: a signed agreement reads its instalments with their states and links its invoice; a schedule
//      added after signing says who and when; a draft with a 50/50 schedule opens its editor with the saved rows and the live line.
//   2. The editor's presets on a draft with a value and NO schedule: Send is disabled with the sentence; Monthly x 3 puts the remainder on Month 1 and
//      clamps month ends; the live line says short, over and adds up; Save; Send then works and the schedule is read-only.
//   3. "Add a payment schedule" on a signed agreement (DW-D49): the editor, the CONFIRM step with its wording, then the one-time addition.
//   4. /invoices/new: client and "Due up to", the checklist (due rows ticked, upcoming disabled), Create from the schedule.
//   5. The invoice page: an instalment line is a fixed fee linked to its contract, never "undefined"; Cancel draft behind its confirm gives the
//      instalments back to the schedule.
//   6. The portal contract page's "Payment schedule" (client login), and a schedule added after signing.
//
// Facts it rests on (all from the demo stores, which this spec's own client owns):
//   - Viceroy (`cl-4`) carries every case. No other spec reads or changes it, so nothing here disturbs the Northwind (cl-1), Cedar (cl-2) and Lumen
//     (cl-3) specs, which assert their own seeds. The store is module state in the dev server: the tests are SERIAL and ORDER-DEPENDENT (the later ones
//     spend what the earlier ones made), so a retry sees a spent store; run the file fresh to re-seed.
//   - dk-10 draft, 120,000,000 IDR, 50/50 saved. dk-11 draft, 10,000,000 IDR, no schedule. dk-12 signed, 90,000,000: Deposit invoiced (inv-sch-1),
//     "Milestone: design approved" due, "Milestone: launch" upcoming. dk-13 signed amendment, "Amendment fee" due. dk-14 signed, 24,000,000, no
//     schedule (addable). dk-15 signed, schedule added after signing by Olive Owner.
//   - hansel@gaiada.com is demo-hansel (platform_admin): company.manage, and every contract and invoice right.
//   - The portal fixture (Northwind, as dana@northwind.example): ctr-msa-2026 has Deposit (invoiced, DEMO/2026/0014), a due and an upcoming instalment;
//     ctr-amd-msa-1 had its schedule added after signing.
//
// Locators on the staff pages are scoped to `#main-content` (Next streams a hidden copy of each resolved chunk at the end of <body>), names are exact,
// and every click on a client control waits for hydration first.
test.describe.configure({ mode: "serial" });

async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function press(loc: Locator) {
  await expect(loc).toBeVisible();
  await hydrated(loc);
  await loc.click();
}

async function signInStaff(page: Page, context: BrowserContext) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("hansel@gaiada.com");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await context.addCookies([tenantCookie(page.url())]);
}
async function signInClient(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dana@northwind.example");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/portal");
}

const main = (page: Page) => page.locator("#main-content");
const BILLING = "/clients/cl-4/billing";
const contractRow = (page: Page, id: string) => main(page).locator(`#contract-${id}`);
const draftUrl: { value: string } = { value: "" };

test.describe("contract billing (DW-10f)", () => {
  test.beforeEach(({ page }) => {
    // Send asks first.
    page.on("dialog", (d) => void d.accept());
  });

  test("a signed agreement shows its schedule read-only with each instalment's state and its invoice; one added after signing says who and when", async ({ page, context }) => {
    await signInStaff(page, context);
    await page.goto(BILLING);

    const signed = contractRow(page, "dk-12");
    const table = signed.getByRole("table", { name: "Payment schedule instalments", exact: true });
    await expect(table).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(5); // header, three instalments, total
    // The deposit is on an issued invoice: its number is the state, and it links the invoice.
    await expect(table.getByRole("link", { name: "Invoiced, DEMO/2026/0002", exact: true })).toHaveAttribute("href", "/invoices/inv-sch-1");
    await expect(table.getByText("Due: ready to invoice", { exact: true })).toBeVisible();
    await expect(table.getByText(/^Upcoming, /)).toBeVisible();
    // A signed contract that has a schedule has no editor and no addition.
    await expect(signed.getByRole("button", { name: "Add a payment schedule", exact: true })).toHaveCount(0);
    await expect(signed.getByRole("button", { name: "Save schedule", exact: true })).toHaveCount(0);

    // A schedule added after signing (DW-D49): who and when, and that the agreement was signed without it.
    const added = contractRow(page, "dk-15");
    await expect(added.getByText(/^Added after signing by Olive Owner, \d{2} [A-Za-z]{3,4} \d{4}\./)).toBeVisible();
    await expect(added.getByText(/The agreement was signed without this schedule/)).toBeVisible();

    // An amendment has its own schedule.
    const amendment = contractRow(page, "dk-13");
    await expect(amendment.getByText(/^Amendment · /)).toBeVisible();
    await expect(amendment.getByRole("table", { name: "Payment schedule instalments", exact: true }).getByText("Amendment fee", { exact: true })).toBeVisible();
  });

  test("a draft with a 50/50 schedule opens its editor with the saved rows, and the live line reads adds up, short and over", async ({ page, context }) => {
    await signInStaff(page, context);
    await page.goto(BILLING);

    const draft = contractRow(page, "dk-10");
    await expect(draft.getByRole("button", { name: "Send to client", exact: true })).toBeEnabled(); // the schedule adds up to the value
    await press(draft.getByRole("button", { name: "Edit", exact: true }));
    const editor = draft.getByRole("region", { name: "Payment schedule", exact: true });
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("Label, instalment 1", { exact: true })).toHaveValue("Deposit (50%)");
    await expect(editor.getByLabel("Amount, instalment 2", { exact: true })).toHaveValue("60000000");
    await expect(editor.getByText("Adds up to IDR 120,000,000 of 120,000,000.", { exact: true })).toBeVisible();

    await editor.getByLabel("Amount, instalment 2", { exact: true }).fill("59995000");
    await expect(editor.getByText(/IDR 5,000 short/)).toBeVisible();
    await editor.getByLabel("Amount, instalment 2", { exact: true }).fill("60005000");
    await expect(editor.getByText(/IDR 5,000 over/)).toBeVisible();
    await editor.getByLabel("Amount, instalment 2", { exact: true }).fill("60000000");
    await expect(editor.getByText("Adds up to IDR 120,000,000 of 120,000,000.", { exact: true })).toBeVisible();
  });

  test("the presets: Monthly x 3 puts the remainder on Month 1 and clamps month ends; Send is disabled until the schedule is saved", async ({ page, context }) => {
    await signInStaff(page, context);
    await page.goto(BILLING);

    const draft = contractRow(page, "dk-11");
    const send = draft.getByRole("button", { name: "Send to client", exact: true });
    await expect(send).toBeDisabled();
    await expect(draft.getByText("The payment schedule must add up to the value before sending.", { exact: true })).toBeVisible();

    await press(draft.getByRole("button", { name: "Edit", exact: true }));
    const editor = draft.getByRole("region", { name: "Payment schedule", exact: true });
    await expect(editor).toBeVisible();
    await expect(editor.getByText("No instalments yet. Pick a preset or add a row.", { exact: true })).toBeVisible();

    await editor.getByLabel("Months (N)", { exact: true }).fill("3");
    await editor.getByLabel("First due on", { exact: true }).fill("2027-01-31");
    await press(editor.getByRole("button", { name: "Monthly × N", exact: true }));

    // 10,000,000 in three: the odd unit is on Month 1, and 31 Jan, 28 Feb, 31 Mar (the day is the first one's, clamped, never chained).
    const amounts = ["3333334", "3333333", "3333333"];
    const dates = ["2027-01-31", "2027-02-28", "2027-03-31"];
    for (let n = 1; n <= 3; n++) {
      await expect(editor.getByLabel(`Label, instalment ${n}`, { exact: true })).toHaveValue(`Month ${n}`);
      await expect(editor.getByLabel(`Amount, instalment ${n}`, { exact: true })).toHaveValue(amounts[n - 1]);
      await expect(editor.getByLabel(`Due date, instalment ${n}`, { exact: true })).toHaveValue(dates[n - 1]);
    }
    await expect(editor.getByText("Adds up to IDR 10,000,000 of 10,000,000.", { exact: true })).toBeVisible();

    // Edit one row: the line says by how much it is off, and goes back when it is put right.
    await editor.getByLabel("Amount, instalment 1", { exact: true }).fill("3333333");
    await expect(editor.getByText(/IDR 1 short/)).toBeVisible();
    await editor.getByLabel("Amount, instalment 1", { exact: true }).fill("3333334");
    await expect(editor.getByText("Adds up to IDR 10,000,000 of 10,000,000.", { exact: true })).toBeVisible();

    await press(editor.getByRole("button", { name: "Save schedule", exact: true }));
    await expect(editor.getByText(/Schedule saved\. It adds up to the value, so the contract can be sent\./)).toBeVisible();
    await expect(send).toBeEnabled();
    await expect(draft.getByText("The payment schedule must add up to the value before sending.", { exact: true })).toHaveCount(0);
  });

  test("Send: the draft moves to Sent, and its schedule is fixed and read-only", async ({ page, context }) => {
    await signInStaff(page, context);
    await page.goto(BILLING);

    await press(contractRow(page, "dk-11").getByRole("button", { name: "Send to client", exact: true }));
    // It left Draft: the row now says what a sent contract waits for, offers no Edit and no Send, and carries its fixed schedule.
    const sent = contractRow(page, "dk-11");
    await expect(sent.getByText("Waiting for both parties to sign.", { exact: true })).toBeVisible();
    await expect(sent.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(sent.getByRole("button", { name: "Send to client", exact: true })).toHaveCount(0);
    const table = sent.getByRole("table", { name: "Payment schedule instalments", exact: true });
    await expect(table.getByRole("row")).toHaveCount(5); // header, three instalments, total
    await expect(table.getByText("Scheduled", { exact: true })).toHaveCount(3);
    await expect(table.getByText("IDR 3,333,334", { exact: true })).toBeVisible();
  });

  test("Add a payment schedule to a signed agreement: the editor, then a confirm step that says what it is, then the one-time addition", async ({ page, context }) => {
    await signInStaff(page, context);
    await page.goto(BILLING);

    const hosting = contractRow(page, "dk-14");
    await expect(hosting.getByRole("table", { name: "Payment schedule instalments", exact: true })).toHaveCount(0); // none yet
    await press(hosting.getByRole("button", { name: "Add a payment schedule", exact: true }));
    const editor = hosting.getByRole("region", { name: "Add a payment schedule", exact: true });
    await expect(editor).toBeVisible();
    const WARNING = "This agreement is already signed. The schedule must restate the payment terms the agreement states. It can be added once and never changed.";
    await expect(editor.getByText(WARNING, { exact: true }).first()).toBeVisible();

    // Two halves: the first on signing, the second on a date.
    await editor.getByLabel("Balance due on", { exact: true }).fill("2027-06-30");
    await press(editor.getByRole("button", { name: "50/50", exact: true }));
    await expect(editor.getByText("Adds up to IDR 24,000,000 of 24,000,000.", { exact: true })).toBeVisible();

    // It cannot be added until it adds up: off by one is refused on the review.
    await editor.getByLabel("Amount, instalment 2", { exact: true }).fill("11999999");
    await press(editor.getByRole("button", { name: "Review the schedule", exact: true }));
    await expect(editor.getByRole("alert")).toContainText("must add up exactly to the contract's value");
    await editor.getByLabel("Amount, instalment 2", { exact: true }).fill("12000000");

    // The confirm step: the rows, the total and the wording, and nothing has been sent yet.
    await press(editor.getByRole("button", { name: "Review the schedule", exact: true }));
    const confirm = hosting.getByRole("form", { name: "Confirm adding the payment schedule", exact: true });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(WARNING, { exact: true })).toBeVisible();
    const rows = confirm.getByRole("table", { name: "The schedule to be added", exact: true });
    await expect(rows.getByText("Deposit (50%)", { exact: true })).toBeVisible();
    await expect(rows.getByText("On signing", { exact: true })).toBeVisible();
    await expect(rows.getByText("IDR 24,000,000", { exact: true })).toBeVisible();
    await expect(hosting.getByRole("table", { name: "Payment schedule instalments", exact: true })).toHaveCount(0);

    await press(confirm.getByRole("button", { name: "Add the payment schedule", exact: true }));
    // Afterwards the read-only schedule says who added it and when, and the control is gone: it can be added once.
    await expect(hosting.getByText(/^Added after signing by .+, \d{2} [A-Za-z]{3,4} \d{4}\./)).toBeVisible();
    await expect(hosting.getByRole("table", { name: "Payment schedule instalments", exact: true }).getByRole("row")).toHaveCount(4); // header, two, total
    await expect(hosting.getByRole("button", { name: "Add a payment schedule", exact: true })).toHaveCount(0);
  });

  test("/invoices/new: pick a client, see the instalments that are due ticked and the upcoming one disabled, and create the draft from the schedule", async ({ page, context }) => {
    await signInStaff(page, context);
    await page.goto("/invoices/new");

    // It opens on the payment schedule; the hourly form is the closed exception.
    await expect(main(page).getByText("Choose a client to see what is due to invoice.", { exact: true })).toBeVisible();
    const exception = main(page).locator("details.bs-exception");
    await expect(exception).not.toHaveAttribute("open", "");
    await expect(exception.getByText("From logged hours (exception)", { exact: true })).toBeVisible();

    // The choice is a plain GET form (the hourly form's own "Client" sits in the closed disclosure, so scope to this one).
    const choose = main(page).getByRole("form", { name: "Choose what to bill", exact: true });
    await choose.getByLabel("Client", { exact: true }).selectOption("cl-4");
    await Promise.all([
      page.waitForURL(/\/invoices\/new\?.*clientId=cl-4/),
      choose.getByRole("button", { name: "Show instalments", exact: true }).click(),
    ]);

    const picker = main(page).getByRole("form", { name: "Create an invoice from the payment schedule", exact: true });
    await expect(picker).toBeVisible();
    // Every due row is ticked; the upcoming one shows its date and cannot be ticked.
    await expect(picker.getByRole("checkbox", { name: /^Invoice Milestone: design approved \(2 of 3\)/ })).toBeChecked();
    await expect(picker.getByRole("checkbox", { name: /^Invoice Amendment fee \(1 of 1\)/ })).toBeChecked();
    await expect(picker.getByRole("checkbox", { name: /^Invoice Deposit \(50%\) \(1 of 2\)/ })).toBeChecked(); // the hosting agreement's, added after signing
    await expect(picker.getByRole("checkbox", { name: /^Milestone: launch \(3 of 3\).*not due yet/ })).toBeDisabled();
    await expect(picker.getByText(/^Upcoming, /).first()).toBeVisible();
    await expect(picker.getByText(/\d instalments? ticked, IDR /)).toBeVisible();

    await press(picker.getByRole("button", { name: "Create from the schedule", exact: true }));
    await page.waitForURL(/\/invoices\/(?!new(?:\?|$))[^/?]+$/);
    draftUrl.value = new URL(page.url()).pathname;
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Viceroy");
  });

  test("the invoice page: an instalment line is a fixed fee linked to its contract and never prints 'undefined'", async ({ page, context }) => {
    expect(draftUrl.value, "the previous test creates the draft").not.toBe("");
    await signInStaff(page, context);
    await page.goto(draftUrl.value);

    const lines = main(page).getByRole("heading", { name: /^Line items/ }).locator("xpath=ancestor::section[1]");
    await expect(lines.getByText("Fixed fee", { exact: true }).first()).toBeVisible();
    await expect(lines.getByText(/Milestone: design approved \(2 of 3\)/)).toBeVisible();
    await expect(lines.getByRole("link", { name: "Contract", exact: true }).first()).toHaveAttribute("href", /^\/clients\/cl-4\/billing#contract-dk-/);
    await expect(main(page).getByText(/undefined/)).toHaveCount(0);
    // A draft that was never issued offers Cancel draft, saying what it gives back.
    await expect(main(page).getByText("The instalments go back to the payment schedule.", { exact: true })).toBeVisible();
  });

  test("Cancel draft: a confirm step, then the instalments go back to the payment schedule, ready to invoice again", async ({ page, context }) => {
    expect(draftUrl.value, "the invoice test creates the draft").not.toBe("");
    await signInStaff(page, context);
    await page.goto(draftUrl.value);

    await press(main(page).getByRole("button", { name: "Cancel draft…", exact: true }));
    const confirm = main(page).getByRole("form", { name: "Confirm cancelling this draft", exact: true });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(/go back to the payment schedule, due again and ready to invoice\./)).toBeVisible();
    await press(confirm.getByRole("button", { name: "Cancel this draft", exact: true }));
    await expect(main(page).getByText(/^Draft cancelled\. \d+ instalments? goes? back to the payment schedule, ready to invoice again\.$/)).toBeVisible();

    // They are on the schedule again: ticked, ready to invoice.
    await page.goto("/invoices/new?clientId=cl-4");
    const picker = main(page).getByRole("form", { name: "Create an invoice from the payment schedule", exact: true });
    await expect(picker.getByRole("checkbox", { name: /^Invoice Milestone: design approved \(2 of 3\)/ })).toBeChecked();
    await expect(picker.getByRole("checkbox", { name: /^Invoice Amendment fee \(1 of 1\)/ })).toBeChecked();
  });

  test("the portal: a client reads the agreement's payment schedule, with the invoice number linking the invoice, and one added after signing", async ({ page }) => {
    await signInClient(page);
    await page.goto("/portal/contracts/ctr-msa-2026");

    const table = page.getByRole("table", { name: "Payment schedule instalments", exact: true });
    await expect(table).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(5); // header, three instalments, total
    await expect(table.getByText("Milestone: design approved", { exact: true })).toBeVisible();
    await expect(table.getByRole("cell", { name: "Due", exact: true })).toBeVisible(); // the second instalment's status; the column header is not a cell
    const invoiced = table.getByRole("link", { name: "Invoiced, DEMO/2026/0014", exact: true });
    await expect(invoiced).toHaveAttribute("href", "/portal/invoices/inv-2026-014");
    await invoiced.click();
    await page.waitForURL(/\/portal\/invoices\/inv-2026-014$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("DEMO/2026/0014");

    // An amendment whose schedule Finance added after it was signed says so, with the date, and never who.
    await page.goto("/portal/contracts/ctr-amd-msa-1");
    await expect(page.getByRole("table", { name: "Payment schedule instalments", exact: true })).toBeVisible();
    await expect(page.getByText(/^Added by .+ on \d{2} [A-Za-z]{3,4} \d{4}, after the agreement was signed\.$/)).toBeVisible();
  });
});
