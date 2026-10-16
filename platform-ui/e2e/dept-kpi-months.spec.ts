import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { loginAsPlacedWebDev, loginAsWebDevHead } from "./personas";
import { tenantCookie } from "./appCookies";

// DW-10b-2 (BFF section 58): the department KPI page's By month view, end to end, under DEMO_MODE. Facts it relies on (src/lib/demoDeptKpis.ts):
//   - webhead@gaiada.com is u-webhead, the head of Web Dev (`org_unit_lead` on dept-1): reads the months and may propose targets for the unit.
//   - webdev@gaiada.com is u-dev, a plain member placed in Web Dev: reads the months, proposes nothing.
//   - The demo series is 12 months ending with the current month (partial), Web Dev has a target in force for some of them and an unavailable
//     reading for others, and the store is module state in the dev server, so the head's test proposes under a target value no seed uses (91%).
// Each test signs in fresh and plants the tenant cookie itself, so there is NO stored session.

async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function press(loc: Locator) {
  await expect(loc).toBeVisible();
  await hydrated(loc);
  await loc.click();
}

// Next streams a hidden copy of each resolved chunk at the end of <body> before React moves it into place, so every locator is scoped to the page body.
const main = (page: Page) => page.locator("#main-content");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** The long name of the month `ahead` months from now (UTC, as the demo store counts), the way the plan form words it: "November 2026". */
function monthAhead(ahead: number): string {
  const d = new Date();
  const idx = d.getUTCFullYear() * 12 + d.getUTCMonth() + ahead;
  return `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`;
}

async function signIn(page: Page, context: BrowserContext, who: "head" | "member") {
  await (who === "head" ? loginAsWebDevHead(page) : loginAsPlacedWebDev(page));
  await context.addCookies([tenantCookie(page.url())]);
}

const table = (page: Page) => main(page).getByRole("table", { name: /^Web Dev: each KPI by month/ });

test.describe("Department KPIs by month (DW-10b-2)", () => {
  test("the head of Web Dev opens By month, sees twelve months and a trend, plans the next two months and sees them as proposals", async ({ page, context }) => {
    await signIn(page, context, "head");

    // The switch, from the period view, keeps the department.
    await page.goto("/appraisals/department?unit=dept-1");
    const switcher = main(page).getByRole("navigation", { name: "KPI view" });
    await expect(switcher.getByRole("link", { name: "This period", exact: true })).toHaveAttribute("aria-current", "page");
    await press(switcher.getByRole("link", { name: "By month", exact: true }));
    await expect(page).toHaveURL(/\/appraisals\/department\?unit=dept-1&view=months/);

    // Twelve month columns, oldest first, the current one marked so far; one row per KPI.
    const t = table(page);
    await expect(t).toBeVisible();
    const months = t.getByRole("columnheader").filter({ hasText: /^[A-Z][a-z]{2} \d{4}/ });
    await expect(months).toHaveCount(12);
    await expect(months.last()).toContainText("so far");
    await expect(t.getByText("so far", { exact: true })).toHaveCount(1);
    await expect(t.getByRole("rowheader")).toHaveText([
      "Projects on time", "Requests delivered by the date needed", "Client site uptime", "Reopened work rate",
    ]);
    // A cell is words: its value, its target and its condition; an unreadable one says why.
    const onTime = t.getByRole("row", { name: /^Projects on time/ });
    await expect(onTime.getByRole("cell").last()).toContainText("target 85%");
    await expect(t.getByText("Unavailable · Not measured yet").first()).toBeVisible();
    await expect(t.getByText(/^(On track|At risk|Off track)$/).first()).toBeVisible();

    // The trend opens under the table: a chart and its data table, for that KPI.
    await expect(main(page).getByRole("img", { name: /Projects on time by month/ })).toHaveCount(0);
    await press(main(page).getByRole("button", { name: "Show the trend for Projects on time", exact: true }));
    await expect(main(page).getByRole("img", { name: /Projects on time by month/ })).toBeVisible();
    await expect(main(page).getByRole("button", { name: "Hide the trend for Projects on time", exact: true })).toHaveAttribute("aria-expanded", "true");

    // The head may plan the coming months: the next two, pre-filled with the target in force (85%).
    const plan = main(page).getByRole("heading", { name: /Plan the coming months/ });
    await expect(plan).toBeVisible();
    const next = monthAhead(1);
    const after = monthAhead(2);
    await main(page).getByLabel("How many coming months").selectOption("2");
    await expect(main(page).getByLabel(`Target for Projects on time, ${next}`)).toHaveValue("85");
    await expect(main(page).getByLabel(`Target for Projects on time, ${after}`)).toHaveValue("85");
    await expect(main(page).getByLabel(/^Target for Projects on time, /)).toHaveCount(2);
    await main(page).getByLabel(`Target for Projects on time, ${next}`).fill("91");
    await main(page).getByLabel(`Tolerance for Projects on time, ${next}`).fill("4");
    await main(page).getByLabel(`Target for Projects on time, ${after}`).fill("91");
    await main(page).getByLabel(`Tolerance for Projects on time, ${after}`).fill("4");
    await press(main(page).getByRole("button", { name: "Send 2 proposals", exact: true }));
    await expect(main(page).getByRole("status").filter({ hasText: "Sent 2 proposals" })).toBeVisible();

    // They are listed as proposals, for both months, and the head (not an approver) has no way to decide them.
    const targets = main(page).locator("section", { has: page.getByRole("heading", { name: /^Targets/ }) });
    await expect(targets).toContainText(`Proposed: 91%, tolerance 4 pts, from ${next}.`);
    await expect(targets).toContainText(`Proposed: 91%, tolerance 4 pts, from ${after}.`);
    await expect(main(page).getByRole("checkbox")).toHaveCount(0);
    await expect(main(page).getByRole("button", { name: /Approve selected|Reject selected/ })).toHaveCount(0);
  });

  test("a plain Web Dev member sees the table and no plan form", async ({ page, context }) => {
    await signIn(page, context, "member");
    await page.goto("/appraisals/department?unit=dept-1&view=months");
    const t = table(page);
    await expect(t).toBeVisible();
    await expect(t.getByRole("columnheader").filter({ hasText: /^[A-Z][a-z]{2} \d{4}/ })).toHaveCount(12);
    await expect(main(page).getByRole("button", { name: "Show the trend for Projects on time", exact: true })).toBeVisible();
    // No planning, no targets screen: that is for the unit's heads and the approver tier.
    await expect(main(page).getByRole("heading", { name: /Plan the coming months/ })).toHaveCount(0);
    await expect(main(page).getByLabel("How many coming months")).toHaveCount(0);
    await expect(main(page).getByRole("heading", { name: /^Targets/ })).toHaveCount(0);
    await expect(main(page).getByRole("checkbox")).toHaveCount(0);
  });

  test("the page works at phone width: the table scrolls inside its own container, never the page", async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await signIn(page, context, "member");
    await page.goto("/appraisals/department?unit=dept-1&view=months");
    await expect(table(page)).toBeVisible();
    const scroll = main(page).getByRole("region", { name: /KPIs by month/ });
    // Twelve month columns are wider than a phone, so the table scrolls sideways inside its own container, and the container itself stays inside the screen.
    expect(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const box = await scroll.boundingBox();
    expect(box).not.toBeNull();
    expect((box as { x: number; width: number }).x + (box as { x: number; width: number }).width).toBeLessThanOrEqual(390 + 1);
  });
});
