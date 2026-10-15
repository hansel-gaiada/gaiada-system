import AxeBuilder from "@axe-core/playwright";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./settledPage";
import { tenantCookie } from "./appCookies";

// M5-W8 — the writer dashboard, against the STUBBED dashboard BFF (e2e/webdesk-stub/dashboard.mjs, run by playwright.webdesk.config.ts, no
// real service). The headline drive: open the dashboard -> an article's page address, its figures with arrows and words, its top queries,
// its lead COUNT and the decay badge that leads to the finding. Around it: an analytics outage (those figures say "Unavailable" in words,
// never 0, and the card stays), an article with no public page address, a viewer who sees only their own work, the filters, the empty,
// drift and unavailable states, and axe. The app runs NOT in demo mode: the real `platformFetch` and server components are under test.

const STUB = `http://127.0.0.1:${process.env.WD_STUB_PORT || 3991}`;
const DASH = "/departments/dept-1/website/writers/dashboard/gaiada/site-gaiada-com";

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

const card = (page: Page, text: string) => page.getByTestId("dash-card").filter({ hasText: text });

test.beforeEach(async ({ page, context }) => {
  await stub.reset();
  await loginAs(page, context, "hansel@gaiada.com");
});

test("an article's page address, its figures with arrows and words, its queries, its lead COUNT and a decay badge that leads to the finding", async ({ page }) => {
  await page.goto(DASH);
  await expect(page.getByTestId("writers-dashboard")).toBeVisible();
  await expect(page.getByTestId("dash-card")).toHaveCount(3);
  await expect(page.getByTestId("dash-windows")).toContainText("15 Sep 2026 to 12 Oct 2026");

  const c = card(page, "Local SEO for hotels");
  await expect(c.getByTestId("page-path")).toContainText("/services/local-seo/");
  await expect(c.getByTestId("mine-chip")).toBeVisible();
  await expect(c.getByTestId("views-value")).toHaveText("120");
  await expect(c.getByTestId("views-trend")).toContainText("up on the period before");
  await expect(c.getByTestId("views-previous")).toContainText("60");
  await expect(c.getByTestId("time-value")).toHaveText("3 min 30 s");
  await expect(c.getByTestId("clicks-value")).toHaveText("113");
  await expect(c.getByTestId("impressions-trend")).toContainText("down on the period before");
  await expect(c.getByTestId("queries-list").getByRole("listitem")).toHaveCount(3);
  await expect(c.getByTestId("queries-list")).toContainText("local seo bali");
  await expect(c.getByTestId("leads-value")).toHaveText("3");
  await expect(c.getByTestId("leads-trend")).toContainText("about the same");

  // the decay badge leads to the finding on the same card
  await expect(c.getByTestId("decay-badge")).toHaveText("Losing traffic");
  await c.getByTestId("decay-badge").click();
  await expect(page).toHaveURL(/#finding-fnd-1$/);
  await expect(c.getByTestId("decay-finding")).toContainText("Search clicks fell by 40 %");
  await expect(c.getByTestId("decay-finding")).toContainText("Open: nobody has looked at it yet");

  // a small cell is words, never a number, never a trend
  const small = card(page, "Web design");
  await expect(small.getByTestId("views-value")).toHaveText("fewer than 5");
  await expect(small.getByTestId("views-trend")).toHaveCount(0);
  await expect(small.getByTestId("tile-time")).toContainText("Fewer than 5 visits");
  await expect(small.getByTestId("queries-none")).toBeVisible();
  await expect(small.getByTestId("decay-none")).toHaveText("No decay alert");

  // an article with no public page address says so in words and shows no figure at all
  const bare = card(page, "Home banner");
  await expect(bare.getByTestId("page-path-na")).toContainText("No public page address");
  for (const t of ["tile-views", "tile-clicks", "tile-leads"]) await expect(bare.getByTestId(t)).toHaveAttribute("data-available", "false");
  await expect(bare.getByTestId("tile-views")).toContainText("Unavailable");

  // counts only: nothing on the page can be a person
  const text = (await page.getByTestId("writers-dashboard").innerText()).toLowerCase();
  for (const w of ["@", "e-mail", "phone"]) expect(text).not.toContain(w);
});

test("an analytics outage: its figures say 'Unavailable' with the reason, never 0; the cards stay and the other figures show", async ({ page }) => {
  await stub.config({ dashboardMode: "umamiDown" });
  await page.goto(DASH);
  await expect(page.getByTestId("dash-card")).toHaveCount(3);
  await expect(page.getByTestId("dash-sources")).toContainText("Website analytics could not be reached");
  const c = card(page, "Local SEO for hotels");
  await expect(c.getByTestId("tile-views")).toHaveAttribute("data-available", "false");
  await expect(c.getByTestId("tile-views")).toContainText("Unavailable");
  await expect(c.getByTestId("tile-views-reason")).toContainText("could not be reached");
  await expect(c.getByTestId("tile-time")).toHaveAttribute("data-available", "false");
  await expect(c.getByTestId("views-value")).toHaveCount(0);
  await expect(c.getByTestId("clicks-value")).toHaveText("113"); // search figures are untouched
});

test("a viewer sees only their own article, and the page says the list follows their access", async ({ page, context }) => {
  await loginAs(page, context, "gede@gaiada.com");
  await page.goto(DASH);
  await expect(page.getByTestId("dash-card")).toHaveCount(1);
  await expect(page.getByTestId("dash-card")).toContainText("Local SEO for hotels");
  await expect(page.getByTestId("writers-dashboard")).toContainText("the articles your access lets you see");
});

test("the filters: my articles, a collection, a period; Clear removes them", async ({ page }) => {
  await page.goto(DASH);
  await page.getByLabel("Show").selectOption("true");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/mine=true/);
  await expect(page.getByTestId("dash-card")).toHaveCount(1);

  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page.getByTestId("dash-card")).toHaveCount(3);
  await page.getByLabel("Collection").selectOption("banner");
  await page.getByLabel("Period").selectOption("7d");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/collection=banner/);
  await expect(page).toHaveURL(/period=7d/);
  await expect(page.getByTestId("dash-card")).toHaveCount(1);
  await expect(page.getByTestId("dash-card")).toContainText("Home banner");
});

test("empty, contract drift and an unavailable WebDesk are different, honest states", async ({ page }) => {
  await stub.config({ dashboardMode: "empty" });
  await page.goto(DASH);
  await expect(page.getByText("There are no published articles to show yet.")).toBeVisible();
  await expect(page.getByTestId("dash-card")).toHaveCount(0);

  await stub.config({ dashboardMode: "drift" }); // a figure with neither a value nor a reason
  await page.goto(DASH);
  await expect(page.getByTestId("wd-contract-drift")).toBeVisible();
  await expect(page.getByTestId("dash-card")).toHaveCount(0);

  await stub.config({ dashboardMode: "smallCell" }); // a raw 3 for a view count: the small-cell rule broken upstream
  await page.goto(DASH);
  await expect(page.getByTestId("wd-contract-drift")).toBeVisible();

  await stub.config({ dashboardMode: "ok", unavailable: true });
  await page.goto(DASH);
  await expect(page.getByTestId("wd-editorial-unavailable")).toBeVisible();
  await expect(page.getByTestId("writers-dashboard")).toHaveCount(0);
});

test("a11y: the dashboard has no serious axe violations", async ({ page }) => {
  await page.goto(DASH);
  await expect(page.getByTestId("writers-dashboard")).toBeVisible();
  const r = await new AxeBuilder({ page }).include('[data-testid="writers-dashboard"]').analyze();
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});
