import { expect, type Page } from "@playwright/test";
import { test } from "./settledPage";

// PV1-07 — the workspace shell's menus follow the company, end to end, in DEMO_MODE (PV-D11, PV-D15, PV-D18).
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
  await expect(switcher(page)).toBeVisible();
}

// The workspace sidebar (`aside#app-nav`) holds the rows of ONE area at a time, picked by the page: the Company area's rows on
// /departments, /clients ..., the Admin area's (Settings, Group, Platform) on /group, /systems/*. A row links to its first tab.
const switcher = (page: Page) => page.getByRole("button", { name: /\. Switch workspace$/ });
// By href, not by role: a role locator skips hidden elements, so it would report a present row as missing.
const sideLink = (page: Page, href: string) => page.locator(`aside#app-nav a[href="${href}"]`);
const menu = (page: Page, title: string) => page.getByRole("navigation", { name: `${title} menu` });

/** Opens the Admin area on a Platform page and returns once the area has drawn (its menu is the positive landmark). */
async function inAdminArea(page: Page, path = "/systems/bot"): Promise<void> {
  await page.goto(path);
  await expect(menu(page, "Admin")).toBeVisible();
}
/** Opens the Company area on /departments and returns once the area has drawn. */
async function inCompanyArea(page: Page): Promise<void> {
  await page.goto("/departments");
  await expect(menu(page, "Company")).toBeVisible();
}

async function switchTo(page: Page, company: string): Promise<void> {
  // The company switch lives in the workspace switcher's panel; the app routes home after the switch, so the URL changes.
  const before = page.url();
  const button = switcher(page);
  await expect.poll(() => button.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
  await button.click();
  await page.locator(".erp-company__form select").selectOption({ label: company });
  await page.waitForURL((u) => u.toString() !== before);
}

/** The switcher names the active company; the caller's next page load proves the switch took. */
async function expectCompany(page: Page, company: string): Promise<void> {
  await expect(switcher(page)).toHaveAttribute("aria-label", new RegExp(`, ${company}\\. Switch workspace$`));
}

test.describe("company context in the workspace menus", () => {
  test("the group owner sees Group only on the holding, and Platform in every company", async ({ page }) => {
    await signIn(page, "group-owner@gaiada.com");

    // The holding: the Admin area offers Group (its report) and Platform (its first page, WA/TG Bot).
    await inAdminArea(page, "/group");
    await expect(sideLink(page, "/group")).toHaveCount(1);
    await expect(sideLink(page, "/systems/bot")).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Admin", exact: true })).toBeVisible(); // the footer's door to the area

    await switchTo(page, "Gaia Digital Agency");
    await inAdminArea(page);
    await expectCompany(page, "Gaia Digital Agency");
    await expect(sideLink(page, "/group")).toHaveCount(0);
    await expect(sideLink(page, "/systems/bot")).toHaveCount(1);
    // The agency pack: the Company area has the agency rows.
    await inCompanyArea(page);
    await expect(sideLink(page, "/clients")).toHaveCount(1);
    await expect(sideLink(page, "/agency")).toHaveCount(1);

    await switchTo(page, "Viceroy");
    await inAdminArea(page);
    await expectCompany(page, "Viceroy");
    await expect(sideLink(page, "/group")).toHaveCount(0);
    await expect(sideLink(page, "/systems/bot")).toHaveCount(1);
    // A hospitality company gets the generic menu: no agency rows (PV-D15).
    await inCompanyArea(page);
    await expect(sideLink(page, "/departments").first()).toBeVisible(); // the area drew, so the absences below mean something
    await expect(sideLink(page, "/clients")).toHaveCount(0);
    await expect(sideLink(page, "/agency")).toHaveCount(0);
  });

  test("a member sees neither Group nor Platform", async ({ page }) => {
    // A member gets no company switcher, so this checks the company they land on.
    await signIn(page, "gede@gaiada.com");
    await inCompanyArea(page);
    await expect(sideLink(page, "/departments").first()).toBeVisible(); // the area drew
    // No Admin door at all: nothing in the member's menus is Group, Platform or Settings.
    await expect(page.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
    for (const href of ["/group", "/systems/bot", "/systems/gateway", "/admin"]) await expect(sideLink(page, href), href).toHaveCount(0);
  });

  test("the group report renders for the owner, with Sum of companies and the F9 note", async ({ page }) => {
    await signIn(page, "group-owner@gaiada.com");
    await page.goto("/group");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/group report/i);
    await expect(page.getByText(/sum of companies/i).first()).toBeVisible();
    await expect(page.getByText(/F9/).first()).toBeVisible();
  });
});
