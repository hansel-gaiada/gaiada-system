import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { tenantCookie } from "./appCookies";

// PV7-05: Clients › Health (`/clients/health`), end to end under DEMO_MODE. It is opened from the Health tab of the Clients
// row in the pilot sidebar and from the command palette. It asserts CONTENT: the order of the rows (worst first), the chip
// on each, the filters narrowing the list, and that Unknown appears only where the demo says a source could not be read.
//
// `gaiada_tenant` is pinned to `co-agency` (the demo fixtures are keyed by tenant: see client-hub.spec.ts), and the pilot
// shell is selected through `gaiada_prefs`, the same way me-performance.spec.ts does.

async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}

async function openPilot(page: Page, context: BrowserContext, path: string) {
  await page.goto("/");
  const pilot = { name: "gaiada_prefs", value: encodeURIComponent(JSON.stringify({ shell: "workspaces" })), url: new URL("/", page.url()).toString() };
  await context.addCookies([tenantCookie(page.url()), pilot]);
  await page.goto(path);
}

const ORDER = ["Northwind Traders", "Orchard Dental", "Cedar Group", "Harbour Coffee Co", "Lumen Studio", "Tidewater Hotels", "Viceroy"];

async function expectTheBoard(page: Page) {
  await expect(page).toHaveURL(/\/clients\/health$/);
  await expect(page.getByRole("heading", { level: 1, name: "Client health" })).toBeVisible();
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(ORDER.length);
}

test.describe("Clients › Health (PV7-05)", () => {
  test("opens from the Health tab of the Clients row, worst first, each client opening its page", async ({ page, context }) => {
    await openPilot(page, context, "/clients");
    const health = page.getByRole("link", { name: "Health", exact: true }).first();
    await expect(health).toBeVisible();
    await hydrated(health);
    await health.click();
    await expectTheBoard(page);

    // Worst first: both off-track clients, then both at-risk, then on track, then quiet. Within a state the oldest wait leads.
    const names = await page.locator("tbody tr a.dt__link").allTextContents();
    expect(names).toEqual(ORDER);
    const states = await page.locator("tbody tr .ch-health-chip").allTextContents();
    expect(states).toEqual(["Off track", "Off track", "At risk", "At risk", "On track", "On track", "Quiet"]);
    // No Unknown on the default company: nothing failed to read there.
    await expect(page.getByText("Unknown", { exact: true })).toHaveCount(0);

    await page.getByRole("link", { name: "Northwind Traders" }).click();
    await expect(page).toHaveURL(/\/clients\/cl-1$/);
  });

  test("opens from the command palette", async ({ page, context }) => {
    await openPilot(page, context, "/departments/dept-1");
    const search = page.getByRole("searchbox", { name: "Search" });
    await expect(search).toBeVisible();
    await hydrated(search);
    await search.click();
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await palette.getByRole("combobox").fill("health");
    const option = palette.getByRole("option", { name: /· Health$/ }).first();
    await expect(option).toBeVisible();
    await option.click();
    await expectTheBoard(page);
  });

  test("the state filter narrows the board, and the chips keep the order within it", async ({ page, context }) => {
    await openPilot(page, context, "/clients/health");
    await expectTheBoard(page);
    const facet = page.getByRole("group", { name: "Filter by health" });
    await facet.getByRole("link", { name: /^At risk/ }).click();
    await expect(page).toHaveURL(/state=at_risk/);
    await expect(page.locator("tbody tr a.dt__link")).toHaveText(["Cedar Group", "Harbour Coffee Co"]);
    await expect(page.locator("tbody tr .ch-health-chip")).toHaveText(["At risk", "At risk"]);
  });

  test("the Clients list carries the same chip, and a Health facet", async ({ page, context }) => {
    await openPilot(page, context, "/clients");
    await expect(page.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Health/ })).toBeVisible();
    const facet = page.getByRole("group", { name: "Filter by health" });
    await expect(facet).toBeVisible();
    await facet.getByRole("link", { name: /Off track/ }).click();
    await expect(page).toHaveURL(/health=off_track/);
    await expect(page.locator("tbody tr a.dt__link")).toHaveText(["Northwind Traders"]);
  });

  test("the client page links to its delivery report", async ({ page, context }) => {
    await openPilot(page, context, "/clients/cl-1");
    const link = page.getByRole("link", { name: "Delivery report" });
    await expect(link).toHaveAttribute("href", "/reports/client?scopeRef=cl-1");
    await link.click();
    await expect(page).toHaveURL(/\/reports\/client\?scopeRef=cl-1/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("/reports/client: a client picker, then a report with Export and Print for that client", async ({ page, context }) => {
    await openPilot(page, context, "/reports/client?periodKind=month");
    await expect(page.getByRole("heading", { level: 1, name: "Client Reports" })).toBeVisible();
    await page.getByRole("link", { name: "View report" }).first().click();
    await expect(page).toHaveURL(/\/reports\/client\?.*scopeRef=/);
    await expect(page.getByRole("group", { name: "Export this report" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Export this report as PDF" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Print this report" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Change client" })).toBeVisible();
  });
});
