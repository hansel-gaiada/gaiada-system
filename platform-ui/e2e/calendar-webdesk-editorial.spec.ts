import AxeBuilder from "@axe-core/playwright";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { tenantCookie } from "./appCookies";

// M5-W5 — the writers' room calendar and workflow board, against the STUBBED BFF (e2e/webdesk-stub/editorial.mjs, run by
// playwright.webdesk.config.ts, no real service). The app runs NOT in demo mode, so the real `platformFetch`, server components and
// the URL-driven month/week navigation are under test.
//
// FILE NAME ON PURPOSE: both Playwright configs select the WebDesk stub specs by the suffix `webdesk-editorial.spec.ts`
// (`playwright.config.ts` ignores it, `playwright.webdesk.config.ts` runs it), so this name is matched by the webdesk config's `testMatch`
// and kept out of the demo-mode suite without editing either config.
//
// The dates are fixed (the stub's seed: local SEO due 20 Oct 2026, a pending schedule request for web design on 25 Oct 2026, the SEO item
// undated with a brief) and every test names its month in the URL, so none of this depends on the day it runs.

const STUB = `http://127.0.0.1:${process.env.WD_STUB_PORT || 3991}`;
const WRITERS = "/departments/dept-1/website/writers";
const SITE = "gaiada/site-gaiada-com";
const CAL = `${WRITERS}/calendar/${SITE}`;
const OCT = `${CAL}?view=month&day=2026-10-15`;

const stub = {
  post: async (cmd: string, body: unknown = {}) => {
    const r = await fetch(`${STUB}/__stub/${cmd}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as unknown;
  },
  reset: () => stub.post("reset"),
  config: (c: Record<string, unknown>) => stub.post("config", c),
};

async function loginAs(page: Page, context: BrowserContext, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/");
  await context.addCookies([tenantCookie(page.url())]);
}

test.beforeEach(async ({ page, context }) => {
  await stub.reset();
  await loginAs(page, context, "hansel@gaiada.com");
});

test("the month view puts each item on one day and says which kind of day it is; undated drafts are in Unscheduled", async ({ page }) => {
  await page.goto(OCT);
  await expect(page.getByTestId("writers-calendar")).toBeVisible();
  await expect(page.getByTestId("calendar-title")).toHaveText("October 2026");
  await expect(page.getByTestId("calendar-legend")).toContainText("Publish requested for");

  // local SEO is DUE on 20 Oct
  const due = page.getByTestId("day-2026-10-20");
  await expect(due.getByTestId("calendar-entry")).toHaveCount(1);
  await expect(due.getByTestId("entry-kind")).toContainText("Due");
  await expect(due.getByRole("link", { name: /Local SEO/ })).toHaveAttribute("href", /\/website\/content\/gaiada\/site-gaiada-com\/service\/service\.local-seo\?locale=en$/);

  // web design has a pending schedule request for 25 Oct: placed there, badged, and the badge is a word
  const asked = page.getByTestId("day-2026-10-25");
  await expect(asked.getByTestId("entry-kind")).toContainText("Publish requested for");
  await expect(asked.getByTestId("entry-request")).toHaveText("Publish request pending for 25 Oct");

  // the undated draft, with its brief
  const un = page.getByTestId("unscheduled-list");
  await expect(un.getByTestId("calendar-entry")).toHaveCount(1);
  await expect(un.getByTestId("entry-brief")).toContainText("SEO services in Bali");

  // no action buttons on the calendar: only the filter's Apply
  await expect(page.getByTestId("writers-calendar").getByRole("button")).toHaveCount(1);
});

test("a card's brief link opens the brief; the editor link opens the item", async ({ page }) => {
  await page.goto(OCT);
  await page.getByTestId("unscheduled-list").getByTestId("entry-brief").click();
  await expect(page).toHaveURL(/\/website\/writers\/briefs\/gaiada\/site-gaiada-com\/brief-seo-2$/);
  await expect(page.getByTestId("brief-view")).toContainText("agensi seo bali");
  await page.goto(`${WRITERS}/${SITE}`);
  await page.getByTestId("col-changes_requested").getByTestId("card-brief").click();
  await expect(page).toHaveURL(/\/website\/writers\/briefs\/gaiada\/site-gaiada-com\/brief-seo-1$/);
  await expect(page.getByTestId("brief-view")).toContainText("seo agency bali");
  await expect(page.getByTestId("brief-view")).toContainText("How much does SEO cost in Bali?");
  await expect(page.getByTestId("brief-view")).toContainText("Assigned to");
  await expect(page.getByTestId("brief-view").getByRole("button")).toHaveCount(0);

  await page.goto(OCT);
  await page.getByTestId("day-2026-10-20").getByRole("link", { name: /Local SEO/ }).click();
  await expect(page).toHaveURL(/\/website\/content\/gaiada\/site-gaiada-com\/service\/service\.local-seo\?locale=en$/);
  await expect(page.getByTestId("review-state")).toHaveAttribute("data-state", "in_review");
});

test("an unknown brief is 'not found or not yours', not an empty page", async ({ page }) => {
  await page.goto(`${WRITERS}/briefs/${SITE}/nope`);
  await expect(page.getByText(/doesn.t exist on this site, or you can.t read it/)).toBeVisible();
});

test("month and week navigation keep the view and the filters in the URL", async ({ page }) => {
  await page.goto(OCT);
  await page.getByTestId("view-week").click();
  await expect(page).toHaveURL(/view=week&day=2026-10-15/);
  await expect(page.getByTestId("calendar-grid")).toHaveAttribute("data-view", "week");
  await expect(page.getByTestId("calendar-title")).toHaveText("12 Oct – 18 Oct 2026");
  await page.getByTestId("cal-next").click();
  await expect(page.getByTestId("calendar-title")).toHaveText("19 Oct – 25 Oct 2026");
  await expect(page.getByTestId("day-2026-10-20").getByTestId("calendar-entry")).toHaveCount(1);
  await expect(page.getByTestId("day-2026-10-25").getByTestId("entry-request")).toBeVisible();

  await page.getByTestId("view-month").click();
  await expect(page.getByTestId("calendar-title")).toHaveText("October 2026");
  await page.getByTestId("cal-next").click();
  await expect(page.getByTestId("calendar-title")).toHaveText("November 2026");
  await expect(page.getByTestId("day-2026-11-05").getByTestId("calendar-entry")).toHaveCount(0);
});

test("filters: a collection with nothing in it, and 'assigned to me' (the author is somebody else) say so in words", async ({ page }) => {
  await page.goto(`${OCT}&collection=service&assignee=me`);
  await expect(page.getByTestId("calendar-empty")).toContainText("No items match these filters");
  await expect(page.getByText(/No undated drafts match these filters/)).toBeVisible();
  await expect(page.getByLabel("Assigned to me")).toBeChecked();

  // the Apply form: untick it again
  await page.getByLabel("Assigned to me").uncheck();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).not.toHaveURL(/assignee=me/);
  await expect(page.getByTestId("day-2026-10-20").getByTestId("calendar-entry")).toHaveCount(1);
});

test("'assigned to me' for the author shows their items", async ({ page, context }) => {
  await loginAs(page, context, "gede@gaiada.com"); // the stub's author of all three items
  await page.goto(`${OCT}&assignee=me`);
  await expect(page.getByTestId("day-2026-10-20").getByTestId("calendar-entry")).toHaveCount(1);
  await expect(page.getByTestId("unscheduled-list").getByTestId("calendar-entry")).toHaveCount(1);
});

test("the workflow board: columns by review state, and each card shows the brief and the pending publish request", async ({ page }) => {
  await page.goto(`${WRITERS}/${SITE}`);
  await expect(page.getByTestId("writers-board")).toBeVisible();
  await expect(page.getByTestId("tab-board")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("col-in_review").getByTestId("board-card")).toHaveCount(1);
  await expect(page.getByTestId("col-approved").getByTestId("card-request")).toHaveText("Publish request pending for 25 Oct");
  await expect(page.getByTestId("col-changes_requested").getByTestId("card-brief")).toContainText("SEO services in Bali");
  await expect(page.getByTestId("col-in_review").getByText(/Due /)).toBeVisible();

  // the board's filters
  await page.getByLabel("Assigned to me").check();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("No items match these filters.")).toBeVisible();

  // and across to the calendar
  await page.goto(`${WRITERS}/${SITE}`);
  await page.getByTestId("tab-calendar").click();
  await expect(page.getByTestId("writers-calendar")).toBeVisible();
});

test("a brief the caller may not read is said in words, on the card and on the calendar", async ({ page }) => {
  await stub.config({ briefHidden: true });
  await page.goto(`${WRITERS}/${SITE}`);
  await expect(page.getByTestId("card-brief-hidden")).toHaveCount(2); // the two items that point at a brief
  await expect(page.getByTestId("card-brief-hidden").first()).toContainText("you can't read it");
  await expect(page.getByTestId("card-brief")).toHaveCount(0);
  await page.goto(OCT);
  await expect(page.getByTestId("entry-brief-hidden").first()).toContainText("you can't read it");
});

test("withheld counts are said in words on the calendar", async ({ page }) => {
  await stub.config({ reviewCountsWithheld: true });
  await page.goto(OCT);
  await expect(page.getByTestId("counts-withheld")).toContainText("Counts are hidden for your access");
  await expect(page.getByTestId("calendar-entry").first()).toBeVisible();
});

test("a part the BFF could not read: the calendar and the board show a notice that names it, never an empty grid", async ({ page }) => {
  for (const [part, words] of [["requests", /pending publish requests/], ["briefs", /briefs/], ["scheduled", /scheduled publish dates/], ["board", /review board/]] as const) {
    await stub.config({ calendarFail: part });
    await page.goto(OCT);
    await expect(page.getByTestId("calendar-part-unreadable")).toContainText(words);
    await expect(page.getByTestId("calendar-part-unreadable")).toContainText("Nothing is shown");
    await expect(page.getByTestId("calendar-grid")).toHaveCount(0);
    await expect(page.getByTestId("calendar-empty")).toHaveCount(0);
    await page.goto(`${WRITERS}/${SITE}`);
    await expect(page.getByTestId("calendar-part-unreadable")).toBeVisible();
    await expect(page.getByTestId("writers-board")).toHaveCount(0);
  }
});

test("the whole BFF down is the full-page notice, never an empty grid", async ({ page }) => {
  await stub.config({ unavailable: true });
  await page.goto(OCT);
  await expect(page.getByTestId("wd-editorial-unavailable")).toBeVisible();
  await expect(page.getByTestId("calendar-grid")).toHaveCount(0);
});

test("a11y: the calendar and the brief have no serious axe violations", async ({ page }) => {
  await page.goto(OCT);
  await expect(page.getByTestId("writers-calendar")).toBeVisible();
  const cal = await new AxeBuilder({ page }).include('[data-testid="writers-calendar"]').analyze();
  expect(cal.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await page.goto(`${WRITERS}/briefs/${SITE}/brief-seo-1`);
  await expect(page.getByTestId("brief-view")).toBeVisible();
  const brief = await new AxeBuilder({ page }).include('[data-testid="brief-view"]').analyze();
  expect(brief.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});
