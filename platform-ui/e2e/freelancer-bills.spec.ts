import { expect, test } from "./settledPage";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { tenantCookie } from "./appCookies";

// DW-10f-4b (BFF §61.7 to §61.9, as built §61.18): Finance > Payables > Freelancers, end to end under DEMO_MODE (src/lib/demoFreelancers.ts).
//
// Finance adds a rate for a person, reads the preview for last month (a freelancer whose vendor names no withholding code carries the
// DW-D47 warning and can still be drafted), drafts one bill, sees it among the drafted bills with the warning kept and a link to approve it in
// Payables, and discards it, which hands the hours back to the preview. The rate is withdrawn at the end so the run leaves the store as it
// found it (the store is module state in the dev server).
//
// Same setup as requests-across.spec.ts: the spec signs in itself as hansel@gaiada.com (demo-hansel, the one demo identity with finance
// access) and plants the tenant cookie, so NO stored session. Facts it rests on (the demo store's seed):
//   - Gede Kusuma is a freelancer paid through V-002 CV Sinar Percetakan, which names NO withholding code: his preview is ready with a warning.
//   - Made Putra is paid through V-001 with PPh 23: withholding is shown. Putu Rani has no vendor: her preview is blocked.
//   - Komang Lestari (social@gaiada.com) is a company member with no rate: the person the new rate is for.
//   - The preview defaults to the whole of last month; the demo store offers its unbilled hours for any period.
test.describe.configure({ mode: "serial" });

async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function press(loc: Locator) {
  await expect(loc).toBeVisible();
  await hydrated(loc);
  await loc.click();
}

// Next streams a hidden copy of each resolved chunk at the end of <body> before React moves it into place, so every locator is scoped to the page.
const main = (page: Page) => page.locator("#main-content");

async function signIn(page: Page, context: BrowserContext) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("hansel@gaiada.com");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await context.addCookies([tenantCookie(page.url(), "co-agency")]);
}

const TODAY = new Date().toISOString().slice(0, 10);
const STAMP = String(Date.now());
let billNo = "";

test.describe("Freelancer rates and bills (DW-10f-4b)", () => {
  test("the Freelancers tab sits in the Payables row and opens the page", async ({ page, context }) => {
    await signIn(page, context);
    await page.goto("/finance/payables");
    const tab = page.getByRole("link", { name: "Freelancers", exact: true }).filter({ visible: true }).first();
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(page).toHaveURL(/\/finance\/payables\/freelancers$/);
    await expect(main(page).getByRole("heading", { level: 1, name: "Freelancers", exact: true })).toBeVisible();
    // The rates as seeded: a person with two rates and their vendor's withholding code, and one with no vendor.
    const made = main(page).getByRole("region", { name: "Rates for Made Putra", exact: true });
    await expect(made.getByText("Withholding code PPH23", { exact: false })).toBeVisible();
    await expect(made.getByText("from 2026-04-01, no end", { exact: true })).toBeVisible();
    await expect(main(page).getByRole("region", { name: "Rates for Putu Rani", exact: true }).getByText("No vendor.", { exact: true })).toBeVisible();
  });

  test("adds a rate for a member who had none", async ({ page, context }) => {
    await signIn(page, context);
    await page.goto("/finance/payables/freelancers");
    const form = main(page).getByRole("form", { name: "Add a rate", exact: true });
    await expect(form).toBeVisible();
    await hydrated(form);
    await form.getByLabel("Person", { exact: true }).selectOption({ label: "Komang Lestari (social@gaiada.com)" });
    await form.getByLabel("Hourly rate", { exact: true }).fill("140000");
    await form.getByLabel("Starts on", { exact: true }).fill(TODAY);
    await form.getByLabel("Expense account", { exact: true }).selectOption("6100");
    await form.getByLabel("Note (optional)", { exact: true }).fill(`e2e ${STAMP}`);
    await press(form.getByRole("button", { name: "Add rate", exact: true }));

    await expect(main(page).getByRole("status").filter({ hasText: "Added a rate for Komang Lestari" })).toBeVisible();
    const komang = main(page).getByRole("region", { name: "Rates for Komang Lestari", exact: true });
    await expect(komang.getByText(`from ${TODAY}, no end`, { exact: true })).toBeVisible();
    await expect(komang.getByText(`e2e ${STAMP}`, { exact: true })).toBeVisible();
    // With no vendor yet, the new freelancer is blocked in the preview and has no Draft button.
    const preview = main(page).getByRole("region", { name: "Preview for Komang Lestari", exact: true });
    await expect(preview.getByText("No vendor.", { exact: false }).first()).toBeVisible();
    await expect(preview.getByRole("button", { name: /^Draft bill/ })).toHaveCount(0);
  });

  test("a freelancer whose vendor names no withholding code shows the warning in the preview and can still be drafted", async ({ page, context }) => {
    await signIn(page, context);
    await page.goto("/finance/payables/freelancers");
    const gede = main(page).getByRole("region", { name: "Preview for Gede Kusuma", exact: true });
    await expect(gede).toBeVisible();
    await expect(gede.getByText("CV Sinar Percetakan names no withholding code", { exact: false })).toBeVisible();
    await expect(gede.getByText("No withholding code.", { exact: false }).first()).toBeVisible();
    await expect(gede.getByText("None", { exact: true })).toBeVisible();
    await expect(gede.getByRole("button", { name: "Draft bill for Gede Kusuma", exact: true })).toBeEnabled();
    // The one with a withholding code shows it, and the one with a blocker has none to press.
    await expect(main(page).getByRole("region", { name: "Preview for Made Putra", exact: true }).getByText("Withholding (PPH23)", { exact: true })).toBeVisible();
    await expect(main(page).getByRole("region", { name: "Preview for Putu Rani", exact: true }).getByRole("button", { name: /^Draft bill/ })).toHaveCount(0);
  });

  test("drafts one bill: it leaves the preview and is listed as a draft, warning kept, with a link to approve it", async ({ page, context }) => {
    await signIn(page, context);
    await page.goto("/finance/payables/freelancers");
    await press(main(page).getByRole("button", { name: "Draft bill for Gede Kusuma", exact: true }));

    const status = main(page).getByRole("status").filter({ hasText: "Drafted bill" });
    await expect(status).toBeVisible();
    const said = (await status.textContent()) ?? "";
    const m = /Drafted bill (\S+\/FB\/\d{4}\/\d{4}) for Gede Kusuma\. It is a draft until someone approves it\./.exec(said);
    expect(m, said).not.toBeNull();
    billNo = m![1];

    await expect(main(page).getByRole("region", { name: "Preview for Gede Kusuma", exact: true })).toHaveCount(0);
    await expect(main(page).getByText(billNo, { exact: true })).toBeVisible();
    const warnings = main(page).getByRole("list", { name: `Warnings on ${billNo}`, exact: true });
    await expect(warnings).toContainText("No withholding code.");
    const approve = main(page).getByRole("link", { name: `Approve ${billNo} in Payables`, exact: true });
    await expect(approve).toHaveAttribute("href", "/finance/payables#bills-awaiting-approval");
  });

  test("discards the draft, which hands the hours back to the preview", async ({ page, context }) => {
    test.skip(!billNo, "needs the bill drafted by the previous test");
    await signIn(page, context);
    await page.goto("/finance/payables/freelancers");
    await expect(main(page).getByText(billNo, { exact: true })).toBeVisible();
    await press(main(page).getByRole("button", { name: `Discard ${billNo}`, exact: true }));

    await expect(main(page).getByRole("status").filter({ hasText: `Discarded ${billNo}` })).toBeVisible();
    await expect(main(page).getByText(billNo, { exact: true })).toHaveCount(0);
    await expect(main(page).getByRole("region", { name: "Preview for Gede Kusuma", exact: true })).toBeVisible();
  });

  test("withdraws the new rate again, so the run leaves the store as it found it", async ({ page, context }) => {
    await signIn(page, context);
    await page.goto("/finance/payables/freelancers");
    const komang = main(page).getByRole("region", { name: "Rates for Komang Lestari", exact: true });
    await expect(komang).toBeVisible();
    await press(komang.getByRole("button", { name: `Withdraw Komang Lestari, rate from ${TODAY}, no end`, exact: true }));
    await expect(main(page).getByRole("status").filter({ hasText: "Withdrew Komang Lestari" })).toBeVisible();
    await expect(main(page).getByRole("region", { name: "Rates for Komang Lestari", exact: true })).toHaveCount(0);
  });
});
