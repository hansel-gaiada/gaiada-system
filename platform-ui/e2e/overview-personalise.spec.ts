import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { loginAsPersona, loginAsPlacedWebDev } from "./personas";
import { tenantCookie } from "./appCookies";

// DW-10d (DW-D34): a person personalises their Overview, end to end, under DEMO_MODE. They hide the blocks they do not want and switch
// on optional ones (Client health first); the order never changes; Needs you cannot be hidden; the choice lives in the `gaiada_prefs`
// cookie, per workspace, so it survives a reload (and would not follow the person to another browser).
//
// Same setup as workspace-shell.spec.ts: every test signs in fresh and plants the `workspaces` pilot cookie itself. Facts it relies on:
//   - webdev@gaiada.com is u-dev, a plain member placed in Web Dev (dept-1): their Overview has Needs you, Today, My activity, ...
//   - hansel@gaiada.com (platform_admin) lands on the Office of the GM, whose Overview is the company list (stored under "company").
//   - The demo company is co-agency (agency pack): the Clients row exists, and the demo board holds seven clients (client-health-board.spec.ts):
//     two off track, two at risk, two on track, one quiet.
//   - The default Overview is unchanged: no block is hidden and no optional block is on until the person chooses.

async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}

/** The pilot switch, written the way lib/prefs.ts reads it. Next URL-encodes cookie values, so the value is encoded here. */
function pilotCookie(at: string, shell: "workspaces" | "classic" = "workspaces") {
  return { name: "gaiada_prefs", value: encodeURIComponent(JSON.stringify({ shell })), url: new URL("/", at).toString() };
}

async function signInWebDev(page: Page, context: BrowserContext, opts: { pilot?: boolean } = {}) {
  await loginAsPlacedWebDev(page);
  await context.addCookies([tenantCookie(page.url()), ...(opts.pilot === false ? [] : [pilotCookie(page.url())])]);
}
async function signInSuperadmin(page: Page, context: BrowserContext) {
  await loginAsPersona(page, "superadmin");
  await context.addCookies([tenantCookie(page.url()), pilotCookie(page.url())]);
}

const main = (page: Page) => page.locator("#main-content");
const block = (page: Page, name: string) => main(page).getByRole("region", { name, exact: true });
const panel = (page: Page) => page.getByRole("group", { name: "Customise this Overview" });
const row = (page: Page, key: string) => panel(page).locator(`li[data-widget="${key}"]`);

/** Opens the Customise disclosure if it is closed (it is closed by default, and a redraw may leave it open). */
async function openCustomise(page: Page) {
  const summary = page.locator("summary", { hasText: "Customise" });
  await expect(summary).toBeVisible();
  if (!(await panel(page).isVisible())) {
    await hydrated(summary);
    await summary.click();
  }
  await expect(panel(page)).toBeVisible();
}

async function press(btn: Locator) {
  await expect(btn).toBeVisible();
  await hydrated(btn);
  await btn.click();
}

test.describe("Overview: personalise (DW-10d)", () => {
  test("hiding My activity removes it, and it stays gone after a reload; showing it brings it back, in its place", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/departments/dept-1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Made$/);

    // The default Overview is today's: nothing hidden, and Customise is closed.
    await expect(block(page, "My activity")).toBeVisible();
    await expect(panel(page)).toBeHidden();

    await openCustomise(page);
    await expect(row(page, "my-activity")).toContainText("Shown");
    await press(row(page, "my-activity").getByRole("button", { name: "Hide My activity" }));
    await expect(block(page, "My activity")).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Made$/);
    await expect(block(page, "My activity")).toHaveCount(0);
    // The blocks beside it are untouched.
    await expect(block(page, "Needs you")).toBeVisible();
    await expect(block(page, "Your numbers")).toBeVisible();

    await openCustomise(page);
    await expect(row(page, "my-activity")).toContainText("Hidden");
    await press(row(page, "my-activity").getByRole("button", { name: "Show My activity" }));
    await expect(block(page, "My activity")).toBeVisible();

    await page.reload();
    await expect(block(page, "My activity")).toBeVisible();
    // The order is the registry's: Your numbers comes before My activity in the You band.
    const youBlocks = main(page).locator(".ov-band", { has: page.getByRole("heading", { level: 2, name: "You", exact: true }) }).locator("section.ov-block");
    await expect(youBlocks.first()).toHaveAttribute("aria-label", "Your numbers");
  });

  test("a choice belongs to one workspace: hiding a block in Web Dev leaves another department's Overview alone", async ({ page, context }) => {
    await signInSuperadmin(page, context);
    await page.goto("/departments/dept-1");
    await expect(block(page, "Today")).toBeVisible();
    await openCustomise(page);
    await press(row(page, "today").getByRole("button", { name: "Hide Today" }));
    await expect(block(page, "Today")).toHaveCount(0);

    await page.goto("/departments/dept-2");
    await expect(block(page, "Today")).toBeVisible();
    await page.goto("/departments/dept-1");
    await expect(block(page, "Needs you")).toBeVisible();
    await expect(block(page, "Today")).toHaveCount(0);
  });

  test("Needs you is always shown: Customise lists it with no control", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/departments/dept-1");
    await openCustomise(page);
    await expect(row(page, "needs-you")).toContainText("Always shown");
    await expect(row(page, "needs-you").getByRole("button")).toHaveCount(0);
    await expect(row(page, "needs-you").locator("form")).toHaveCount(0);
    // The blocks that may be hidden each have one.
    await expect(row(page, "today").getByRole("button", { name: "Hide Today" })).toBeVisible();
    await expect(block(page, "Needs you")).toBeVisible();
  });

  test("Client health is off until switched on; then it shows the department's clients and the board link, after a reload too", async ({ page, context }) => {
    await signInSuperadmin(page, context);
    await page.goto("/departments/dept-1");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(block(page, "Client health")).toHaveCount(0);

    await openCustomise(page);
    await expect(row(page, "client-health")).toContainText("Switched off");
    await press(row(page, "client-health").getByRole("button", { name: "Switch on Client health" }));

    const health = block(page, "Client health");
    await expect(health).toBeVisible();
    await expect(health.getByText("Unavailable")).toHaveCount(0);
    await expect(health.getByRole("link", { name: "Open the health board" })).toHaveAttribute("href", /^\/clients\/health/);
    // It sits in the Work band, after Requests.
    const work = main(page).locator(".ov-band", { has: page.getByRole("heading", { level: 2, name: "Work", exact: true }) });
    await expect(work.locator("section.ov-block").last()).toHaveAttribute("aria-label", "Client health");

    await page.reload();
    await expect(block(page, "Client health")).toBeVisible();

    await openCustomise(page);
    await expect(row(page, "client-health")).toContainText("Switched on");
    await press(row(page, "client-health").getByRole("button", { name: "Switch off Client health" }));
    await expect(block(page, "Client health")).toHaveCount(0);
  });

  test("on the company Overview, Client health shows the whole board's counts worst first, each client opening its page", async ({ page, context }) => {
    await signInSuperadmin(page, context);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), /);
    await expect(block(page, "Client health")).toHaveCount(0);

    await openCustomise(page);
    await press(row(page, "client-health").getByRole("button", { name: "Switch on Client health" }));

    const health = block(page, "Client health");
    await expect(health).toBeVisible();
    // The demo board: two off track, two at risk, two on track, one quiet (client-health-board.spec.ts).
    await expect(health.getByText("2 off track · 2 at risk · 2 on track · 1 quiet")).toBeVisible();
    // Up to five clients that need a person, worst first; on track and quiet ones are counted, never listed.
    await expect(health.getByRole("listitem").first().getByRole("link")).toHaveText("Northwind Traders");
    await expect(health.getByRole("link", { name: "Northwind Traders" })).toHaveAttribute("href", "/clients/cl-1");
    await expect(health.getByRole("link", { name: "Open the health board" })).toHaveAttribute("href", "/clients/health");
    await expect(health.getByText("Unavailable")).toHaveCount(0);
  });

  test("a classic user has no Customise control and no optional block", async ({ page, context }) => {
    await signInWebDev(page, context, { pilot: false });
    await page.goto("/departments/dept-1");
    await expect(page.getByRole("heading", { level: 1, name: "Web Dev", exact: true })).toBeVisible();
    await expect(page.locator("summary", { hasText: "Customise" })).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Client health", exact: true })).toHaveCount(0);
  });
});
