import { test, expect, type Page } from "@playwright/test";

// PV1-07 — the staff menu follows the company, end to end, in DEMO_MODE (PV-D11, PV-D15, PV-D18).
//
// Its own project with NO stored session (playwright.config.ts "company-context"): each test signs in
// as a specific demo identity, and the shared staff session would silently test someone else.
//   group-owner@gaiada.com  demo-owner: `owner` on co-holding (the root), co-agency and co-resort
//   gede@gaiada.com         gede-ic: a member, no owner role, not platform_admin
// The demo companies: co-holding (holding, the root), co-agency (agency), co-resort "Viceroy"
// (hospitality). The active company starts as the first one, co-holding.
async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/");
}

const groupLabels = (page: Page) => page.locator(".erp-side__grouplabel").allTextContents();
// By href, not by role: collapsed sidebar groups keep their links in the DOM but hidden, and a role
// locator skips hidden elements, so it would report a present row as missing.
const sideLink = (page: Page, href: string) => page.locator(`.erp-side a[href="${href}"]`);

async function switchTo(page: Page, company: string): Promise<void> {
  await page.locator(".erp-company__form select").selectOption({ label: company });
  await page.waitForURL("**/");
  await expect(page.locator(".erp-company__form select")).toHaveValue(/.+/);
  await page.waitForLoadState("networkidle");
}

test.describe("company context in the staff menu", () => {
  test("the group owner sees Group only on the holding, and Platform in every company", async ({ page }) => {
    await signIn(page, "group-owner@gaiada.com");

    let labels = await groupLabels(page);
    expect(labels).toContain("Group");
    expect(labels).toContain("Platform");
    expect(labels).not.toContain("Systems");

    await switchTo(page, "Gaia Digital Agency");
    labels = await groupLabels(page);
    expect(labels).not.toContain("Group");
    expect(labels).toContain("Platform");
    // The agency pack: the agency rows are there.
    await expect(sideLink(page, "/clients")).toHaveCount(1);
    await expect(sideLink(page, "/pipeline")).toHaveCount(1);

    await switchTo(page, "Viceroy");
    labels = await groupLabels(page);
    expect(labels).not.toContain("Group");
    expect(labels).toContain("Platform");
    // A hospitality company gets the generic menu: no agency rows (PV-D15).
    await expect(sideLink(page, "/clients")).toHaveCount(0);
    await expect(sideLink(page, "/pipeline")).toHaveCount(0);
    await expect(sideLink(page, "/agency")).toHaveCount(0);
  });

  test("a member sees neither Group nor Platform", async ({ page }) => {
    // A member gets no company switcher, so this checks the company they land on.
    await signIn(page, "gede@gaiada.com");
    const labels = await groupLabels(page);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels).not.toContain("Group");
    expect(labels).not.toContain("Platform");
    expect(labels).not.toContain("Systems");
    await expect(sideLink(page, "/systems/gateway")).toHaveCount(0);
    await expect(sideLink(page, "/group")).toHaveCount(0);
  });

  test("the group report renders for the owner, with Sum of companies and the F9 note", async ({ page }) => {
    await signIn(page, "group-owner@gaiada.com");
    await page.goto("/group");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/group report/i);
    await expect(page.getByText(/sum of companies/i).first()).toBeVisible();
    await expect(page.getByText(/F9/).first()).toBeVisible();
  });
});
