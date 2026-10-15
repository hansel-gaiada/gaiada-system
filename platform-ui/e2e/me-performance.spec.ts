import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { loginAsPlacedWebDev } from "./personas";
import { tenantCookie } from "./appCookies";

// PV7-06: My performance (`/me/performance`), end to end under DEMO_MODE. The page is the person's own picture: this
// month's numbers, check-ins, the latest appraisal, learning and their own time, each on its own read. It is opened from
// the pilot sidebar (the first row of the Performance block) and from the command palette.
//
// Asserts CONTENT, not status codes: every section has an honest empty or failed state that renders happily on a broken
// read, so each section is checked for "Unavailable" and the appraisal for the absence of an effort or hours figure.

const SECTIONS = ["Your numbers", "Check-ins", "Appraisal", "Learning", "Your time", "Activity"];

async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}

/** The placed Web Dev employee (u-dev), on the workspace pilot (`gaiada_prefs.shell`, lib/prefs.ts). */
async function signIn(page: Page, context: BrowserContext) {
  await loginAsPlacedWebDev(page);
  const pilot = { name: "gaiada_prefs", value: encodeURIComponent(JSON.stringify({ shell: "workspaces" })), url: new URL("/", page.url()).toString() };
  await context.addCookies([tenantCookie(page.url()), pilot]);
}

async function expectThePage(page: Page) {
  await expect(page).toHaveURL(/\/me\/performance$/);
  await expect(page.getByRole("heading", { level: 1, name: "My performance" })).toBeVisible();
  const main = page.locator("#main-content");
  for (const name of SECTIONS) {
    const section = main.getByRole("region", { name, exact: true });
    await expect(section, name).toBeVisible();
    await expect(section.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
    await expect(section.getByText("Unavailable"), name).toHaveCount(0);
  }
  await expect(main.getByRole("region", { name: "Your time", exact: true }).getByText("Context, not a score")).toBeVisible();
  const appraisal = (await main.getByRole("region", { name: "Appraisal", exact: true }).innerText()).toLowerCase();
  expect(appraisal).not.toMatch(/effort|hours|utili[sz]ation|score|composite/);
}

test.describe("My performance (PV7-06)", () => {
  test("opens from the first row of the Performance block in the pilot sidebar", async ({ page, context }) => {
    await signIn(page, context);
    await page.goto("/departments/dept-1");
    const nav = page.getByRole("navigation", { name: "Web Dev menu" });
    const performance = nav.getByRole("group", { name: "Performance" });
    await expect(performance.getByRole("link").first()).toHaveText("My performance");

    await performance.getByRole("link", { name: "My performance", exact: true }).click();
    await expectThePage(page);
    // It keeps this workspace's sidebar and marks its own row current.
    await expect(nav).toBeVisible();
    await expect(performance.getByRole("link", { name: "My performance", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  });

  test("opens from the command palette", async ({ page, context }) => {
    await signIn(page, context);
    await page.goto("/departments/dept-1");
    const search = page.getByRole("searchbox", { name: "Search" });
    await expect(search).toBeVisible();
    await hydrated(search);
    await search.click();
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await palette.getByRole("combobox").fill("my performance");
    const option = palette.getByRole("option", { name: /My performance/ }).first();
    await expect(option).toBeVisible();
    await option.click();
    await expectThePage(page);
  });

  test("links each section to its full page", async ({ page, context }) => {
    await signIn(page, context);
    await page.goto("/me/performance");
    await expectThePage(page);
    const main = page.locator("#main-content");
    const link = (section: string, name: string) => main.getByRole("region", { name: section, exact: true }).getByRole("link", { name });
    await expect(link("Your numbers", "Open my report")).toHaveAttribute("href", /^\/reports\/person\?periodKind=month&start=\d{4}-\d{2}-\d{2}$/);
    await expect(link("Appraisal", "My appraisals")).toHaveAttribute("href", "/appraisals/mine");
    await expect(link("Learning", "My learning")).toHaveAttribute("href", "/me/learning");
    await expect(link("Your time", "My timesheet")).toHaveAttribute("href", "/timesheets");
    await expect(link("Activity", "Open my activity")).toHaveAttribute("href", "/pm?view=productivity");
  });
});
