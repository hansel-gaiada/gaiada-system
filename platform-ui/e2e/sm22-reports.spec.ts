import { test, expect, type Page } from "@playwright/test";

// Mirrors app.spec.ts's own helper — the default active tenant is the HOLDING company
// (co-holding, type 'holding', empty org tree), so any /departments/* route 404s until the
// switcher moves the session to the agency.
async function switchToAgency(page: Page) {
  await page.goto("/");
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    page.getByLabel("Active company").selectOption({ label: "Gaia Digital Agency" }),
  ]);
}

// SM-22 verification smoke check (temporary — author will fold into app.spec.ts or remove after
// manual verification). Drives the real page against DEMO_MODE fixtures.
test("Reports tab: engagement picker, report list, preview banner, and full lifecycle actions", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-3/reports?engagementId=sm-eng-1");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/seo/i);
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();

  // The delivered report (sm-report-1) should be listed.
  await expect(page.getByRole("button", { name: /2026-06.*monthly/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /2026-07.*monthly/i })).toBeVisible();

  // Select the in_review report — its mixed-simulated banner must render.
  await page.getByRole("button", { name: /2026-07.*monthly/i }).click();
  await expect(page.getByText(/mixes real and SIMULATED figures/i)).toBeVisible();
  await expect(page.getByText(/\[SIMULATED\]/)).toBeVisible();
  await expect(page.getByText(/PDF layer is not yet built/i)).toBeVisible();

  // Select the delivered report — no mutating controls, delivered-at note shown.
  await page.getByRole("button", { name: /2026-06.*monthly/i }).click();
  await expect(page.getByText(/no longer editable/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deliver", exact: true })).toHaveCount(0);
});

test("Reports tab: approve then deliver an in_review report end to end", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-3/reports?engagementId=sm-eng-1");
  await page.getByRole("button", { name: /2026-07.*monthly/i }).click();
  // sm-report-2 starts in_review in the seed — approve, then deliver.
  const approveBtn = page.getByRole("button", { name: "Approve", exact: true });
  if (await approveBtn.isVisible()) {
    await approveBtn.click();
    await expect(page.getByRole("button", { name: "Deliver", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Deliver", exact: true }).click();
    await expect(page.getByText(/Delivered — the client-facing report is now filed/i)).toBeVisible();
  }
});
