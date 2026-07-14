import { test, expect, type Page } from "@playwright/test";

function sidebar(page: Page) {
  return page.locator(".erp-side");
}

test("My Work dashboard loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("sidebar navigates the business modules", async ({ page }) => {
  await page.goto("/");
  for (const [label, heading] of [
    ["Projects", /projects/i],
    ["Tasks", /tasks/i],
    ["Companies", /companies/i],
    ["Agency", /agency|campaign/i],
  ] as const) {
    await sidebar(page).getByRole("link", { name: label, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
  }
});

test("global search returns cross-entity results", async ({ page }) => {
  await page.goto("/");
  // "gaiada" matches companies, which are searched across every tenant the
  // user can access (independent of the active company).
  await page.getByLabel("Search").fill("gaiada");
  await page.getByLabel("Search").press("Enter");
  await page.waitForURL("**/search?q=gaiada");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/results for/i);
  await expect(page.getByRole("link", { name: /Gaiada Agency/i })).toBeVisible();
});

test("notifications surface shows items and unread badge", async ({ page }) => {
  await page.goto("/");
  const bell = page.getByRole("link", { name: /notifications/i });
  await expect(bell).toBeVisible();
  await bell.click();
  await page.waitForURL("**/notifications");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/notifications/i);
  await expect(page.getByText(/approval requested/i)).toBeVisible();
});

test("admin audit lists activity and filters", async ({ page }) => {
  await page.goto("/admin/audit");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/audit/i);
  await expect(page.getByRole("form", { name: /audit filters/i })).toBeVisible();
  // At least one activity row is rendered.
  await expect(page.locator(".lux-table__row").first()).toBeVisible();
});

test("account page + density preference", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /clement hansel/i }).click();
  const acct = page.getByRole("menuitem", { name: /account settings/i });
  await expect(acct).toBeVisible();
  await acct.click();
  await page.waitForURL("**/account");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/your profile/i);

  await page.locator('select[name="density"]').selectOption("compact");
  await page.getByRole("button", { name: /^save$/i }).click();
  await expect(page.locator(".erp-app")).toHaveAttribute("data-density", "compact");

  // Reset back to comfortable so other runs start clean.
  await page.locator('select[name="density"]').selectOption("comfortable");
  await page.getByRole("button", { name: /^save$/i }).click();
});

test("people directory opens an employee 360", async ({ page }) => {
  await page.goto("/");
  await sidebar(page).getByRole("link", { name: "People", exact: true }).click();
  await page.waitForURL("**/people");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/people/i);
  // Open a colleague from the directory.
  await page.getByRole("link", { name: "Made Putra" }).click();
  await page.waitForURL(/\/people\/u-dev/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/made putra/i);
  await expect(page.getByText(/open tasks/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Assigned tasks", exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: /projects owned/i })).toBeVisible();
});

test("company org builder shows agency departments and editor", async ({ page }) => {
  await page.goto("/companies/co-agency/org");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/org structure/i);
  // Seeded agency departments appear in the preview chart.
  for (const dept of ["Web Dev", "SEO", "SMM", "Video Editor", "Design Graphic"]) {
    await expect(page.getByText(dept, { exact: true }).first()).toBeVisible();
  }
  // Elevated viewer gets the editor (Save button present).
  await expect(page.getByRole("button", { name: /save structure/i })).toBeVisible();
});

test("account links to own employee page", async ({ page }) => {
  await page.goto("/account");
  await page.getByRole("link", { name: /my employee page/i }).click();
  await page.waitForURL(/\/people\/demo-hansel/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/clement hansel/i);
  await expect(page.getByText("You", { exact: true })).toBeVisible();
});

test("sign out returns to login", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /clement hansel/i }).click();
  const signOut = page.getByRole("menuitem", { name: /sign out/i });
  await expect(signOut).toBeVisible();
  await signOut.click();
  await page.waitForURL("**/login", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});
