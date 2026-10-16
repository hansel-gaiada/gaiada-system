import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { loginAsPersona, loginAsPlacedWebDev, loginAsWebDevHead } from "./personas";
import { tenantCookie } from "./appCookies";

// DW-10a-2 (BFF section 57, DW-D32): the department notice board, end to end, under DEMO_MODE. Heads post, the department reads.
//
// Same setup as overview-personalise.spec.ts: every test signs in fresh and plants the `workspaces` pilot cookie itself, so there is NO stored
// session. Facts it relies on (src/lib/demoNotices.ts, src/lib/demoFixtures.ts):
//   - webdev@gaiada.com is u-dev, a plain member placed in Web Dev (dept-1): reads the unit's notices and the company-wide ones, posts nothing.
//   - webhead@gaiada.com is u-webhead (Ketut Arta), the head of Web Dev (`org_unit_lead` on dept-1): posts, edits and withdraws Web Dev's notices.
//   - hansel@gaiada.com is the company admin (platform_admin): posts company-wide, lands on the Office of the GM, whose Overview is the company's.
//   - The demo store seeds, for co-agency: Web Dev's pinned "Release freeze starts Friday 17:00" and plain "New code-review checklist", a past
//     "Quarter retro notes" for the Past view, and the company-wide "Office closed for Nyepi".
//   - The store is module state in the dev server, so the head's test posts under a unique title and leaves nothing behind (it withdraws it).

async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function press(loc: Locator) {
  await expect(loc).toBeVisible();
  await hydrated(loc);
  await loc.click();
}

/** The pilot switch, written the way lib/prefs.ts reads it. Next URL-encodes cookie values, so the value is encoded here. */
function pilotCookie(at: string) {
  return { name: "gaiada_prefs", value: encodeURIComponent(JSON.stringify({ shell: "workspaces" })), url: new URL("/", at).toString() };
}
async function plant(page: Page, context: BrowserContext) {
  await context.addCookies([tenantCookie(page.url()), pilotCookie(page.url())]);
}
const signInEmployee = async (page: Page, context: BrowserContext) => { await loginAsPlacedWebDev(page); await plant(page, context); };
const signInHead = async (page: Page, context: BrowserContext) => { await loginAsWebDevHead(page); await plant(page, context); };
const signInAdmin = async (page: Page, context: BrowserContext) => { await loginAsPersona(page, "superadmin"); await plant(page, context); };

// Next streams a hidden copy of each resolved chunk at the end of <body> before React moves it into place, so every locator is scoped to the page body.
const main = (page: Page) => page.locator("#main-content");
const block = (page: Page, name: string) => main(page).getByRole("region", { name, exact: true });
const noticeItem = (page: Page, text: string) => main(page).locator("li.nt-item", { hasText: text });
const postButton = (page: Page) => main(page).getByRole("button", { name: "Post a notice" });
const FREEZE = "Release freeze starts Friday 17:00";
const NYEPI = "Office closed for Nyepi";

test.describe("Department notices (DW-10a-2)", () => {
  test("a placed Web Dev employee sees the Notices block and tab with the demo notices, and no post form", async ({ page, context }) => {
    await signInEmployee(page, context);
    await page.goto("/departments/dept-1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Made$/);

    // The block: in the Now band, with the pinned notice first, and nothing to post with.
    const notices = block(page, "Notices");
    await expect(notices).toBeVisible();
    await expect(notices.getByText("Unavailable")).toHaveCount(0);
    await expect(notices.getByRole("listitem").first()).toContainText(FREEZE);
    await expect(notices.getByRole("listitem").first().getByText("Pinned")).toBeVisible();
    await expect(notices.getByRole("link", { name: NYEPI })).toBeVisible();
    await expect(notices.getByRole("link", { name: "Post a notice" })).toHaveCount(0);
    await expect(notices.getByRole("link", { name: "All notices" })).toHaveAttribute("href", "/departments/dept-1/notices");
    const now = main(page).locator(".ov-band", { has: page.getByRole("heading", { level: 2, name: "Now", exact: true }) });
    await expect(now.locator("section.ov-block").nth(0)).toHaveAttribute("aria-label", "Needs you");
    await expect(now.locator("section.ov-block").nth(1)).toHaveAttribute("aria-label", "Today");
    await expect(now.locator("section.ov-block").nth(2)).toHaveAttribute("aria-label", "Notices");

    // The tab: Notices follows Overview on the Overview row, and the board lists the unit's notices pinned first.
    const strip = page.getByRole("navigation", { name: "Overview sections" });
    await expect(strip.getByRole("link")).toHaveText(["Overview", "Notices"]);
    await press(strip.getByRole("link", { name: "Notices" }));
    await expect(page).toHaveURL(/\/departments\/dept-1\/notices$/);
    await expect(strip.getByRole("link", { name: "Notices" })).toHaveAttribute("aria-current", "page");

    const list = main(page).getByRole("list", { name: "Current notices" });
    await expect(list.getByRole("listitem").first()).toContainText(FREEZE);
    await expect(list.getByRole("listitem").first()).toContainText("Pinned");
    await expect(list.getByRole("listitem").first()).toContainText("Web Dev · by Ketut Arta");
    await expect(noticeItem(page, "New code-review checklist")).toBeVisible();
    await expect(noticeItem(page, NYEPI)).toContainText("Whole company");
    // The body is text with its line breaks kept.
    await expect(noticeItem(page, FREEZE).locator(".nt-body")).toContainText("Urgent fixes go through the head of Web Dev.");
    // A reader is offered neither the form nor Edit and Withdraw.
    await expect(postButton(page)).toHaveCount(0);
    await expect(main(page).getByRole("button", { name: /^(Edit|Withdraw) / })).toHaveCount(0);

    // Past notices are one link away, and are not in the current list.
    await expect(noticeItem(page, "Quarter retro notes")).toHaveCount(0);
    await press(main(page).getByRole("link", { name: "Past notices" }));
    await expect(page).toHaveURL(/\/departments\/dept-1\/notices\?state=past$/);
    await expect(noticeItem(page, "Quarter retro notes")).toContainText("ended");
    await expect(noticeItem(page, FREEZE)).toHaveCount(0);
  });

  test("a notice reaches a person by its link: the board scrolls to it", async ({ page, context }) => {
    await signInEmployee(page, context);
    await page.goto("/departments/dept-1");
    const link = block(page, "Notices").getByRole("link", { name: "New code-review checklist" });
    await expect(link).toHaveAttribute("href", /^\/departments\/dept-1\/notices#[0-9a-f-]+$/);
    await press(link);
    await expect(page).toHaveURL(/\/departments\/dept-1\/notices#[0-9a-f-]+$/);
    const id = new URL(page.url()).hash.slice(1);
    await expect(main(page).locator(`li[id="${id}"]`)).toContainText("New code-review checklist");
  });

  test("the Web Dev head posts a notice that appears on the tab and the Overview, edits it, and withdraws it", async ({ page, context }) => {
    await signInHead(page, context);
    const title = `E2E notice ${Date.now()}`;
    const edited = `${title} (edited)`;

    // Post.
    await page.goto("/departments/dept-1/notices");
    await expect(noticeItem(page, FREEZE)).toBeVisible();
    await press(postButton(page));
    const form = main(page).getByRole("form", { name: "Post a notice" });
    await form.getByLabel(/^Title/).fill(title);
    await form.getByLabel(/^Notice/).fill("First line\nSecond line");
    await press(form.getByRole("button", { name: "Post notice" }));
    const item = noticeItem(page, title);
    await expect(item).toBeVisible();
    await expect(item).toContainText("by Ketut Arta");
    await expect(item).not.toContainText("Pinned");
    expect(await item.locator(".nt-body").evaluate((el) => el.textContent)).toBe("First line\nSecond line");
    // The head may change what they posted, and the pinned notice that is theirs too.
    await expect(item.getByRole("button", { name: `Edit ${title}` })).toBeVisible();
    await expect(noticeItem(page, FREEZE).getByRole("button", { name: `Edit ${FREEZE}` })).toBeVisible();
    // The company-wide notice is the admin's: a head has no controls on it.
    await expect(noticeItem(page, NYEPI).getByRole("button")).toHaveCount(0);

    // The Overview shows it, newest first below the pinned one.
    await page.goto("/departments/dept-1");
    const overview = block(page, "Notices");
    await expect(overview.getByRole("link", { name: title })).toBeVisible();
    await expect(overview.getByRole("listitem")).toHaveCount(3);
    await expect(overview.getByRole("listitem").first()).toContainText(FREEZE);
    await expect(overview.getByRole("link", { name: "Post a notice" })).toBeVisible();

    // Edit.
    await page.goto("/departments/dept-1/notices");
    await press(noticeItem(page, title).getByRole("button", { name: `Edit ${title}` }));
    const editForm = main(page).getByRole("form", { name: "Edit this notice" });
    await expect(editForm.getByLabel(/^Title/)).toHaveValue(title);
    await editForm.getByLabel(/^Title/).fill(edited);
    await press(editForm.getByRole("button", { name: "Save changes" }));
    const after = noticeItem(page, edited);
    await expect(after).toBeVisible();
    await expect(after).toContainText("edited");

    // Withdraw asks first, and Keep it withdraws nothing.
    await press(after.getByRole("button", { name: `Withdraw ${edited}` }));
    await expect(after.getByText(/Withdraw this notice\?/)).toBeVisible();
    await press(after.getByRole("button", { name: "Keep it" }));
    await expect(after).toBeVisible();
    await press(after.getByRole("button", { name: `Withdraw ${edited}` }));
    await press(after.getByRole("button", { name: "Yes, withdraw it" }));
    await expect(noticeItem(page, edited)).toHaveCount(0);

    // Gone from the Overview too.
    await page.goto("/departments/dept-1");
    await expect(block(page, "Notices")).toBeVisible();
    await expect(block(page, "Notices").getByRole("link", { name: edited })).toHaveCount(0);
    await expect(block(page, "Notices").getByRole("link", { name: FREEZE })).toBeVisible();
  });

  test("a head is not offered the form on the company-wide board", async ({ page, context }) => {
    await signInHead(page, context);
    await page.goto("/notices");
    await expect(page.getByRole("heading", { level: 1, name: "Company notices" })).toBeVisible();
    await expect(noticeItem(page, NYEPI)).toContainText("Whole company");
    await expect(postButton(page)).toHaveCount(0);
    await expect(main(page).getByRole("button", { name: /^(Edit|Withdraw) / })).toHaveCount(0);
  });

  test("a company admin sees the company-wide notice on /notices and on the company Overview, and is offered the form", async ({ page, context }) => {
    await signInAdmin(page, context);
    await page.goto("/notices");
    await expect(page.getByRole("heading", { level: 1, name: "Company notices" })).toBeVisible();
    const nyepi = noticeItem(page, NYEPI);
    await expect(nyepi).toContainText("Whole company");
    await expect(nyepi).toContainText("by Clement Hansel");
    await expect(nyepi).toContainText("until");
    await expect(postButton(page)).toBeVisible();
    await expect(nyepi.getByRole("button", { name: `Edit ${NYEPI}` })).toBeVisible();
    // The company-wide board holds no unit's notice.
    await expect(noticeItem(page, FREEZE)).toHaveCount(0);

    // The company Overview: `/` sends the admin to the Office of the GM (a full reload, so wait for the target page before reading it).
    await page.goto("/");
    await page.waitForURL(/\/departments\/[^/?]+/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), /);
    const company = block(page, "Company notices");
    await expect(company).toBeVisible();
    await expect(company.getByText("Unavailable")).toHaveCount(0);
    await expect(company.getByRole("link", { name: NYEPI })).toBeVisible();
    await expect(company.getByRole("link", { name: "Post a notice" })).toBeVisible();
    // The Office of the GM has a node of its own, but its Overview never narrows the notices to it: no unit's block, no unit's notices.
    await expect(block(page, "Notices")).toHaveCount(0);
    await expect(company.getByRole("link", { name: FREEZE })).toHaveCount(0);
    await press(company.getByRole("link", { name: "All notices" }));
    await expect(page).toHaveURL(/\/notices$/);
  });

  test("the employee reads the company-wide notice on /notices and on the same board has no form", async ({ page, context }) => {
    await signInEmployee(page, context);
    await page.goto("/notices");
    await expect(noticeItem(page, NYEPI)).toBeVisible();
    await expect(postButton(page)).toHaveCount(0);
  });
});
