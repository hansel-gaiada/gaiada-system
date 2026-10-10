import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";

// WSK-44 — the Website workspace, against the STUBBED WSK-59 BFF (e2e/webdesk-stub/, run by
// playwright.webdesk.config.ts). Every row of write-plane design §10's states table is reached here;
// the `STATE` tag in each title names the row. Fixtures are the real gaiada.com compositions.
//
//   loading · editorial unavailable · stale · not enabled / forbidden · read-only · dirty/saving/saved vN ·
//   conflict · invalid · pending approval · rejected/failed · published vN · rebuilding / live on staging /
//   rebuild unverified · unpublished-staging-stale
//
// The app runs NOT in demo mode: its real `platformFetch` talks to the stub (PLATFORM_URL), so the real
// server components, server actions and session cookie are what is under test.

const STUB = `http://127.0.0.1:${process.env.WD_STUB_PORT || 3991}`;
const DEPT = "/departments/dept-1";
const SITE = `${DEPT}/website/content/gaiada/site-gaiada-com`;
const SERVICE_SEO = `${SITE}/service/service.seo?locale=en`;
const NAV_EN = `${SITE}/navigation/navigation?locale=en`;
const NAV_ID = `${SITE}/navigation/navigation?locale=id`;
const P = (p: string) => `[data-pointer="/blocks/0/props/${p}"]`;

const stub = {
  post: async (cmd: string, body: unknown = {}) => {
    const r = await fetch(`${STUB}/__stub/${cmd}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as unknown;
  },
  reset: () => stub.post("reset"),
  config: (c: Record<string, unknown>) => stub.post("config", c),
  state: async () => (await (await fetch(`${STUB}/__stub/state`, { method: "POST" })).json()) as {
    items: { itemId: string; slug: string; locale: string; headVersion: number; publishedVersion: number | null; publishState: string; deletedAt: string | null; versions: { n: number; createdBy: string; note: string | null; props?: Record<string, any>; seo: Record<string, unknown> }[] }[];
    approvals: { id: string; status: string; workflowId: string; toolArgs: { items: { itemId: string; version: number }[] } }[];
    build: { state: string } | null;
    stagingStale: boolean;
  },
  item: async (id: string) => (await stub.state()).items.find((i) => i.itemId === id)!,
};

async function loginAs(page: Page, context: BrowserContext, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/");
  // Web Dev (dept-1) lives under co-agency — the cookie is the established workaround (webdev-change-requests.spec.ts).
  await context.addCookies([{ name: "gaiada_tenant", value: "co-agency", url: page.url() }]);
}

const main = (page: Page) => page.locator(".dept-shell__main");

// The gate runs the BUILT app: its server HTML is interactive-looking well before React has hydrated, so a click
// that lands in that gap is silently lost (measured: the twin-create button). React tags a hydrated DOM node with a
// `__reactProps$…` key, so "ready" means that tag is present — no test hook in shipped code.
async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
/** Open an EDITOR url and wait until it is interactive. */
async function open(page: Page, url: string) {
  await page.goto(url);
  await hydrated(page.getByTestId("item-editor"));
}

test.beforeEach(async ({ page, context }) => {
  await stub.reset();
  await loginAs(page, context, "hansel@gaiada.com");
});

// ── navigation / structure ─────────────────────────────────────────────────────────────────────────

test("the Website group sits in the Web Dev strip; one site redirects straight into it", async ({ page }) => {
  await page.goto(DEPT);
  const strip = page.getByRole("navigation", { name: "Department sections" });
  await expect(strip.getByRole("link", { name: "Website" })).toBeVisible();
  await strip.getByRole("link", { name: "Website" }).click();
  await expect(page).toHaveURL(/\/website\/content\/gaiada\/site-gaiada-com$/);
  await expect(page.getByTestId("collections")).toBeVisible();
  // grouped by composition.ui.group, with PENDING CHANGES surfaced
  await expect(page.getByRole("heading", { name: "Pages" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Globals" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Service pages" })).toBeVisible();
  await expect(page.locator("tr", { hasText: "Service pages" }).locator(".wc-chip--warn")).toBeVisible();
});

test("STATE loading: a skeleton shows while the content API is slow, then the page replaces it", async ({ page }) => {
  await page.goto(DEPT);
  await stub.config({ delayMs: 2500 });
  await page.getByRole("navigation", { name: "Department sections" }).getByRole("link", { name: "Website" }).click();
  await expect(page.getByTestId("wd-skeleton")).toBeVisible();
  await expect(page.getByTestId("collections")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("wd-skeleton")).toHaveCount(0);
});

test("a singleton collection opens its editor directly", async ({ page }) => {
  await page.goto(SITE);
  await page.getByRole("link", { name: "Navigation" }).click();
  await expect(page).toHaveURL(/\/navigation\/navigation\?locale=en$/);
  await expect(page.getByTestId("item-editor")).toBeVisible();
});

test("the item list filters by pending changes and links into the editor", async ({ page }) => {
  await page.goto(`${SITE}/service`);
  await expect(page.getByTestId("items-table")).toContainText("service.seo");
  await page.goto(`${SITE}/service?state=pending`);
  await expect(page.getByTestId("items-table")).toContainText("service.seo");
  await expect(page.getByTestId("items-table")).not.toContainText("service.web-design");
  await page.getByRole("link", { name: "SEO Agency Bali | Gaia Digital Agency" }).first().click();
  await expect(page.getByTestId("item-editor")).toBeVisible();
});

// ── the refusal states: never a list, never a form ─────────────────────────────────────────────────

test("STATE editorial unavailable: a full-page notice on EVERY page, and no list or form on any of them", async ({ page }) => {
  await stub.config({ unavailable: true });
  for (const url of [`${DEPT}/website/content`, SITE, `${SITE}/service`, SERVICE_SEO, `${SITE}/service/service.seo/history?locale=en`]) {
    await page.goto(url);
    await expect(page.getByTestId("wd-editorial-unavailable"), url).toBeVisible();
    await expect(page.getByTestId("wd-editorial-unavailable")).toContainText("Editing is unavailable");
    await expect(page.getByTestId("wd-editorial-unavailable")).toContainText("Nothing has been lost");
    const m = main(page);
    await expect(m.locator("table"), url).toHaveCount(0);
    await expect(m.locator("form"), url).toHaveCount(0);
    await expect(m.locator("input, textarea, select"), url).toHaveCount(0);
    await expect(m.getByTestId("item-editor"), url).toHaveCount(0);
    await expect(m.getByTestId("collections"), url).toHaveCount(0);
    await expect(m.getByTestId("sites-list"), url).toHaveCount(0);
  }
});

test("STATE editorial unavailable recovers: Try again after the API returns shows the editor", async ({ page }) => {
  await stub.config({ unavailable: true });
  await page.goto(SERVICE_SEO); // there is no editor to wait for: that is the point
  await expect(page.getByTestId("wd-editorial-unavailable")).toBeVisible();
  await stub.config({ unavailable: false });
  await page.getByRole("link", { name: "Try again" }).click();
  await expect(page.getByTestId("item-editor")).toBeVisible();
});

test("a 2xx body that breaks the contract is a loud drift notice, never an empty list", async ({ page }) => {
  await stub.config({ drift: "sites" });
  await page.goto(`${DEPT}/website/content`);
  await expect(page.getByTestId("wd-contract-drift")).toBeVisible();
  await expect(page.getByTestId("wd-contract-drift")).toContainText("defaultLocale");
  await expect(main(page).locator("table, input")).toHaveCount(0);
});

test("STATE not enabled: the module switched off is its own state, not an empty site", async ({ page }) => {
  await stub.config({ moduleDisabled: true });
  await page.goto(`${DEPT}/website/content`);
  await expect(main(page)).toContainText("Module switched off");
  await expect(main(page)).toContainText("Nothing has been deleted");
  await expect(main(page).locator("table")).toHaveCount(0);
});

test("STATE forbidden: a Cerbos 403 is a refusal, not 'nothing here'", async ({ page }) => {
  await stub.config({ forbidden: true });
  await page.goto(SITE);
  await expect(main(page)).toContainText("You don't have access");
  await expect(main(page).locator("table")).toHaveCount(0);
  await expect(main(page)).not.toContainText("no collections");
});

// ── the editor: dirty / saving / saved, invalid, read-only ────────────────────────────────────────

test("STATE dirty -> saving -> saved vN: the real composition renders and a save writes v4", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await expect(page.getByTestId("editor-title")).toHaveText("SEO Agency in Bali for Hotels");
  await expect(page.getByTestId("save-status")).toHaveText("No changes");
  await expect(page.getByTestId("save")).toBeDisabled();

  // composition-driven controls: text, select, boolean, markdown, nested group, text list, read-only column
  await expect(page.locator(P("template"))).toHaveValue("service");
  await expect(page.locator(P("publish_ready"))).not.toBeChecked();
  await expect(page.locator(P("plan/action"))).toHaveValue("SHOW");
  await expect(page.locator(P("body"))).toContainText("SEO Agency in Bali");
  await expect(page.locator(P("source_path"))).not.toBeEditable(); // ui.readOnly
  await expect(page.locator(P("schema")).locator("li")).toHaveCount(4);
  await expect(page.locator(P("schema_notes"))).toHaveCSS("font-family", /mono/i);

  const h1 = page.locator(P("h1"));
  await h1.fill("SEO Agency in Bali — Edited");
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  await expect(page.getByTestId("save")).toBeEnabled();
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved v4");
  await expect(page.getByTestId("item-head")).toHaveText("v4");
  const it = await stub.item("itm-service-seo-en");
  expect(it.headVersion).toBe(4);
  expect(it.versions.at(-1)?.props?.h1).toBe("SEO Agency in Bali — Edited");
  expect(it.publishedVersion).toBe(2); // saving never changes what is live
});

test("markdown fields have a source tab and a structural preview", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.getByTestId("markdown-preview").getByRole("heading", { name: "SEO Agency in Bali" })).toBeVisible();
  await expect(page.getByTestId("markdown-preview").locator("li")).toHaveCount(3);
  await page.getByRole("tab", { name: "Write" }).click();
  await expect(page.locator(P("body"))).toBeVisible();
});

test("STATE invalid (422): errors are located inline by JSON pointer and the edits are kept", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.locator(P("phase")).selectOption(""); // a required select, now absent
  await page.locator(P("h1")).fill("Kept after the failed save");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-error")).toContainText("1 problem to fix");
  const phase = page.locator(P("phase"));
  await expect(phase).toHaveAttribute("aria-invalid", "true");
  await expect(phase.locator("xpath=ancestor::div[contains(@class,'wc-field')][1]")).toContainText("phase is required");
  await expect(page.locator(P("h1"))).toHaveValue("Kept after the failed save");

  // a NESTED pointer: /blocks/0/props/plan/why
  await stub.config({ forceIssues: [{ path: "/blocks/0/props/plan/why", message: "why must explain the decision" }] });
  await page.locator(P("phase")).selectOption("L");
  await page.getByTestId("save").click();
  const group = page.locator(`fieldset${P("plan")}`);
  await expect(group.locator(P("plan/why")).locator("xpath=ancestor::div[contains(@class,'wc-field')][1]")).toContainText("why must explain the decision");
  await expect(group.locator("legend")).toContainText("1 problem");

  await page.getByTestId("save").click(); // forceIssues was one-shot: now it saves
  await expect(page.getByTestId("save-status")).toHaveText("Saved v4");
});

test("STATE read-only (no `update`): a 403 on save turns the form read-only, keeps the edit and says why", async ({ page, context }) => {
  await loginAs(page, context, "gede@gaiada.com"); // plain member: the stub grants read, refuses every write
  await open(page, SERVICE_SEO);
  await expect(page.getByTestId("item-editor")).toBeVisible();
  await page.locator(P("h1")).fill("A member's edit");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("readonly-banner")).toContainText("You can read this item but not change it");
  await expect(page.getByTestId("save-error")).toContainText("Your edits are still here");
  await expect(page.locator(P("h1"))).not.toBeEditable();
  await expect(page.locator(P("h1"))).toHaveValue("A member's edit");
  await expect(page.getByTestId("save")).toBeDisabled();
  await expect(page.getByTestId("request-publish")).toBeDisabled();
  const it = await stub.item("itm-service-seo-en");
  expect(it.headVersion).toBe(3); // nothing was saved
});

test("STATE read-only (deleted item): opens read-only from the start, with the reason", async ({ page }) => {
  await open(page, `${SITE}/service/service.old-draft?locale=en`);
  await expect(page.getByTestId("readonly-banner")).toContainText("deleted");
  await expect(page.locator(P("h1"))).not.toBeEditable();
  await expect(page.getByTestId("save")).toBeDisabled();
});

// ── conflict / stale ───────────────────────────────────────────────────────────────────────────────

test("STATE conflict (409): a dialog names the newer version, the local edit is KEPT; Save mine on top wins", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.locator(P("h1")).fill("Mine, typed before the conflict");
  await stub.post("concurrent-save", { itemId: "itm-service-seo-en", fields: { h1: "Theirs, saved meanwhile" }, by: "dept-manager" });
  await page.getByTestId("save").click();

  const dlg = page.getByTestId("conflict-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("v4");
  await expect(dlg).toContainText("after the v3 you started from");
  await expect(dlg).toContainText("have not been lost");

  // Keep editing: nothing was thrown away
  await dlg.getByRole("button", { name: "Keep editing" }).click();
  await expect(dlg).not.toBeVisible();
  await expect(page.locator(P("h1"))).toHaveValue("Mine, typed before the conflict");
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");

  // Save again -> conflict again -> Save mine on top re-saves against the NEW baseVersion
  await page.getByTestId("save").click();
  await expect(dlg).toBeVisible();
  await dlg.getByTestId("save-mine").click();
  await expect(dlg).not.toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveText("Saved v5");
  const it = await stub.item("itm-service-seo-en");
  expect(it.headVersion).toBe(5);
  expect(it.versions.at(-1)?.props?.h1).toBe("Mine, typed before the conflict");
  expect(it.versions.find((v) => v.n === 4)?.props?.h1).toBe("Theirs, saved meanwhile"); // theirs stays in history
});

test("STATE conflict: Load theirs replaces the form with the newer version", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.locator(P("h1")).fill("Mine");
  await stub.post("concurrent-save", { itemId: "itm-service-seo-en", fields: { h1: "Theirs, saved meanwhile" } });
  await page.getByTestId("save").click();
  await page.getByTestId("load-theirs").click();
  await expect(page.locator(P("h1"))).toHaveValue("Theirs, saved meanwhile");
  await expect(page.getByTestId("editor-banner")).toContainText("Loaded v4");
  await expect(page.getByTestId("save-status")).toHaveText("No changes");
});

test("STATE stale: a failed refresh shows a banner, disables Save and Publish, and keeps the draft", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.locator(P("h1")).fill("Edited while the API is down");
  await expect(page.getByTestId("request-publish")).toBeDisabled(); // dirty
  await stub.config({ unavailable: true });
  await page.getByTestId("refresh-now").click();
  const banner = page.getByTestId("stale-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Couldn't refresh");
  await expect(banner).toContainText("showing what loaded at");
  await expect(page.getByTestId("save")).toBeDisabled();
  await expect(page.getByTestId("request-publish")).toBeDisabled();
  await expect(page.locator(P("h1"))).toHaveValue("Edited while the API is down");
  // the page did NOT become a full-page notice, and kept the old data only as "loaded at"
  await expect(page.getByTestId("wd-editorial-unavailable")).toHaveCount(0);

  await stub.config({ unavailable: false });
  await banner.getByRole("button", { name: "Try again" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("save")).toBeEnabled();
  await expect(page.locator(P("h1"))).toHaveValue("Edited while the API is down");
});

test("a write that hits an unavailable API keeps the edits and goes stale instead of losing them", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.locator(P("h1")).fill("Typed, then the API died");
  await stub.config({ unavailable: true });
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-error")).toContainText("Your edits are kept here and nothing was saved");
  await expect(page.getByTestId("stale-banner")).toBeVisible();
  await expect(page.locator(P("h1"))).toHaveValue("Typed, then the API died");
});

// ── publish: pending approval -> rejected | failed | published -> rebuild ──────────────────────────

test("STATE pending approval -> Withdraw; the pending request survives a reload", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await expect(page.getByTestId("publish-state")).toHaveText("Live · v2");
  await page.getByTestId("request-publish").click();
  const awaiting = page.getByTestId("awaiting-approval");
  await expect(awaiting).toContainText("Awaiting approval #ap-0001");
  await expect(awaiting).toContainText("Publish of v3 was requested");
  await expect(page.getByTestId("request-publish")).toBeDisabled();

  await page.reload();
  await expect(page.getByTestId("awaiting-approval")).toContainText("Awaiting approval #ap-0001");

  await page.getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByTestId("awaiting-approval")).toHaveCount(0);
  await expect(page.getByTestId("publish-message")).toContainText("withdrawn");
  expect((await stub.state()).approvals).toHaveLength(0);
});

test("STATE rejected: the outcome is explained and Request again files a new request", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.getByTestId("request-publish").click();
  await expect(page.getByTestId("awaiting-approval")).toBeVisible();
  await stub.post("decide", { id: "ap-0001-publish", outcome: "reject", by: "dept-manager" });
  const rej = page.getByTestId("request-rejected");
  await expect(rej).toContainText("Rejected");
  await expect(rej).toContainText("Dewi Manager");
  await expect(rej).toContainText("Nothing was published");
  expect((await stub.item("itm-service-seo-en")).publishedVersion).toBe(2);
  await rej.getByRole("button", { name: "Request again" }).click();
  await expect(page.getByTestId("awaiting-approval")).toContainText("#ap-0002");
});

test("STATE failed: an approved request whose execution failed says why, in plain words", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.getByTestId("request-publish").click();
  await expect(page.getByTestId("awaiting-approval")).toBeVisible(); // the request must exist before it is decided
  await stub.post("decide", { id: "ap-0001-publish", outcome: "fail", by: "dept-manager" });
  const failed = page.getByTestId("request-failed");
  await expect(failed).toContainText("Approved, but it failed");
  await expect(failed).toContainText("Someone saved a newer version after this request was filed");
  await expect(failed.getByRole("button", { name: "Request again" })).toBeVisible();
});

test("STATE published vN -> rebuilding -> live on staging (confirmed only by the build status)", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.getByTestId("request-publish").click();
  await expect(page.getByTestId("awaiting-approval")).toBeVisible();
  await stub.post("decide", { id: "ap-0001-publish", outcome: "approve", by: "dept-manager" });

  const published = page.getByTestId("published");
  await expect(published).toContainText("Published v3");
  await expect(published).toContainText("approved by Dewi Manager");
  await expect(page.getByTestId("publish-state")).toHaveText("Live · v3");
  await expect(page.getByTestId("rebuilding")).toBeVisible();
  await expect(page.getByTestId("live-on-staging")).toHaveCount(0); // not live just because it published

  await stub.post("build", { state: "live" });
  const live = page.getByTestId("live-on-staging");
  await expect(live).toBeVisible();
  await expect(live.getByRole("link", { name: "View on staging" })).toHaveAttribute("href", "https://24-pyevq.gaiada.com/services/seo/");
  await expect(page.getByTestId("rebuilding")).toHaveCount(0);
});

test("STATE rebuild unverified: a rebuild that never confirms is never shown as live", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.getByTestId("request-publish").click();
  await expect(page.getByTestId("awaiting-approval")).toBeVisible();
  await stub.post("decide", { id: "ap-0001-publish", outcome: "approve" });
  await expect(page.getByTestId("rebuilding")).toBeVisible();
  await stub.post("build", { state: "unverified" });
  await expect(page.getByTestId("rebuild-unverified")).toBeVisible();
  await expect(page.getByTestId("rebuild-unverified")).toContainText("treat staging as not updated");
  await expect(page.getByTestId("live-on-staging")).toHaveCount(0);
});

test("when the build-status route is not served the page says so and never claims 'live'", async ({ page }) => {
  await stub.config({ buildStatusServed: false });
  await open(page, SERVICE_SEO);
  await page.getByTestId("request-publish").click();
  await expect(page.getByTestId("awaiting-approval")).toBeVisible();
  await stub.post("decide", { id: "ap-0001-publish", outcome: "approve" });
  await expect(page.getByTestId("published")).toContainText("Published v3");
  await expect(page.getByTestId("build-unavailable")).toContainText("isn't available");
  await expect(page.getByTestId("live-on-staging")).toHaveCount(0);
});

test("STATE unpublished, staging stale: unpublish needs no approval, warns, and offers Request rebuild", async ({ page }) => {
  await open(page, `${SITE}/service/service.web-design?locale=en`);
  await expect(page.getByTestId("publish-state")).toHaveText("Live · v1");
  await page.getByTestId("unpublish").click();
  await page.getByTestId("confirm-unpublish").click();
  await expect(page.getByTestId("publish-message")).toContainText("Unpublished from WebDesk");
  await expect(page.getByTestId("publish-state")).toHaveText("Unpublished");
  const stale = page.getByTestId("staging-stale");
  await expect(stale).toContainText("the staging site drops it at the next rebuild");
  await stale.getByTestId("request-rebuild").click();
  await expect(page.getByTestId("awaiting-approval")).toContainText("A rebuild of the staging site was requested");
  await stub.post("decide", { id: "ap-0001-rebuild", outcome: "approve" });
  await expect(page.getByTestId("rebuilding")).toBeVisible();
  await expect(page.getByTestId("staging-stale")).toHaveCount(0);
});

// ── lists: add · remove · reorder, by drag AND keyboard ───────────────────────────────────────────

const rowTitles = (page: Page) => page.locator(`fieldset${P("primary")} > ol > li > .wc-list__bar .wc-list__title`).allTextContents();

test("list field: KEYBOARD-ONLY reorder (grab, arrows, drop, Escape cancels), add and remove", async ({ page }) => {
  await open(page, NAV_EN);
  expect(await rowTitles(page)).toEqual(["/services/", "/work/", "/about/"]);

  // anchored names: a nested `children` list has its own handles ("Reorder /services/seo/, …")
  const handle = (name: RegExp) => page.getByRole("button", { name });
  const SERVICES = /^Reorder \/services\/, position/;
  await handle(SERVICES).focus();
  await page.keyboard.press("Space"); // grab
  await expect(handle(SERVICES)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space"); // drop
  expect(await rowTitles(page)).toEqual(["/work/", "/about/", "/services/"]);
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  await expect(handle(SERVICES)).toBeFocused(); // focus follows the moved row

  // Escape restores the order the grab started from
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  expect(await rowTitles(page)).toEqual(["/work/", "/about/", "/services/"]);

  // Alt+Arrow moves without grabbing
  await handle(/^Reorder \/about\/, position/).focus();
  await page.keyboard.press("Alt+ArrowUp");
  expect(await rowTitles(page)).toEqual(["/about/", "/work/", "/services/"]);

  // remove (keyboard: Tab to the button, Enter) and add
  await page.getByRole("button", { name: "Remove /work/", exact: true }).focus();
  await page.keyboard.press("Enter");
  expect(await rowTitles(page)).toEqual(["/about/", "/services/"]);
  await page.getByRole("button", { name: "Add item" }).first().focus();
  await page.keyboard.press("Enter");
  expect((await rowTitles(page)).length).toBe(3);

  // fix up the new row (url + label are required) and save: the stub stores the keyboard-made order
  const newRow = page.locator(`fieldset${P("primary")} > ol > li`).nth(2);
  await newRow.locator(`[data-pointer$="/label"]`).fill("Contact");
  await newRow.locator(`[data-pointer$="/url"]`).fill("/contact/");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved v2");
  const it = await stub.item("itm-nav-en");
  expect(it.versions.at(-1)?.props?.primary.map((r: { url: string }) => r.url)).toEqual(["/about/", "/services/", "/contact/"]);
});

test("list field: reorder by DRAG", async ({ page }) => {
  // HTML5 drag needs source and target on screen at once (a real user auto-scrolls; a synthetic mouse does not).
  await page.setViewportSize({ width: 1280, height: 2600 });
  await open(page, NAV_EN);
  const src = page.getByRole("button", { name: /^Reorder \/about\/, position/ });
  const target = page.locator(`fieldset${P("primary")} > ol > li`).first();
  await src.dragTo(target);
  expect(await rowTitles(page)).toEqual(["/about/", "/services/", "/work/"]);
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
});

// ── locale-neutral members ─────────────────────────────────────────────────────────────────────────

test("locale-neutral members are READ-ONLY on the id tab (and editable on en); a save writes the default value through", async ({ page }) => {
  await open(page, NAV_EN);
  await expect(page.locator(P("primary/0/url"))).toBeEditable();
  await expect(page.locator(P("primary/0/children/0"))).toBeEditable();

  await open(page, NAV_ID);
  await expect(page.getByTestId("item-editor")).toBeVisible();
  // localized members stay editable…
  await expect(page.locator(P("primary/0/label"))).toHaveValue("Layanan");
  await expect(page.locator(P("primary/0/label"))).toBeEditable();
  await expect(page.locator(P("cta/label"))).toBeEditable();
  // …neutral ones are locked, and SHOW the default-locale value, not id's stale copy
  await expect(page.locator(P("primary/0/url"))).not.toBeEditable();
  await expect(page.locator(P("primary/0/children/0"))).not.toBeEditable();
  await expect(page.locator(P("primary/0/children/0"))).toHaveValue("/services/seo/");
  await expect(page.locator(P("cta/url"))).not.toBeEditable();
  await expect(page.locator(`fieldset${P("primary")}`)).toContainText("Shared across locales");
  // identity-bearing rows can't be added/removed outside the default locale
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add item" })).toHaveCount(0);

  await page.locator(P("primary/0/label")).fill("Layanan Kami");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved v2");
  const it = await stub.item("itm-nav-id");
  const row0 = it.versions.at(-1)?.props?.primary[0];
  expect(row0.label).toBe("Layanan Kami");
  expect(row0.children).toEqual(["/services/seo/", "/services/branding/"]); // written through from en
});

test("locale tabs show twin status and create a missing twin from the saved version", async ({ page }) => {
  await open(page, `${SITE}/service/service.local-seo?locale=en`);
  await expect(page.getByTestId("create-locale-id")).toContainText("not created");
  await page.getByTestId("create-locale-id").click();
  await expect(page).toHaveURL(/service\.local-seo\?locale=id$/);
  await expect(page.getByTestId("item-editor")).toBeVisible();
  await expect(page.locator(P("h1"))).toHaveValue("Local SEO Bali");
  await expect(page.getByTestId("locale-en")).toBeVisible(); // the twin link back
});

test("read-only (ui.readOnly) members stay locked inside lists, while their siblings are editable", async ({ page }) => {
  await open(page, `${SITE}/token-registry/token-registry?locale=en`);
  await expect(page.getByText("This collection is locale-neutral")).toBeVisible();
  await expect(page.locator(P("tokens/0/occurrences"))).not.toBeEditable();
  await expect(page.locator(P("tokens/0/pages/0"))).not.toBeEditable();
  await expect(page.locator(P("tokens/0/value"))).toBeEditable();
  await page.locator(P("tokens/0/value")).fill("2026-10-20");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved v2");
});

// ── create, history ────────────────────────────────────────────────────────────────────────────────

test("create: a new item is filled in on the same form, then created as a draft", async ({ page }) => {
  await page.goto(`${SITE}/service`);
  await page.getByTestId("new-item").click();
  await expect(page).toHaveURL(/service\/~new\?locale=en$/);
  await page.locator("#wc-slug").fill("Bad Slug");
  await page.getByTestId("save").click();
  await expect(page.locator("#wc-slug")).toHaveAttribute("aria-invalid", "true");

  await page.locator("#wc-slug").fill("service.new-thing");
  await page.locator(P("url")).fill("/services/new-thing/");
  await expect(page.locator(P("source_path"))).not.toBeEditable(); // ui.readOnly: carried by the importer, stays ""
  await page.locator(P("template")).selectOption("service");
  await page.locator(P("section")).fill("service");
  await page.locator(P("language")).fill("en-GB");
  await page.locator(P("phase")).selectOption("L");
  await page.locator(P("visibility")).selectOption("shown");
  await page.locator(P("plan/action")).selectOption("SHOW");
  await page.locator(P("body")).fill("# New thing\n");
  await page.getByTestId("save").click();
  await expect(page).toHaveURL(/service\/service\.new-thing\?locale=en$/);
  await expect(page.getByTestId("item-state")).toHaveText("Draft");
});

test("history: versions with head/live chips, diff against live, and Restore as draft", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.getByRole("link", { name: "Version history" }).click();
  const table = page.getByTestId("versions-table");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("tr", { hasText: "v3" }).locator(".wc-chip", { hasText: "head" })).toBeVisible();
  await expect(table.locator("tr", { hasText: "v2" }).locator(".wc-chip--ok", { hasText: "live" })).toBeVisible();
  await expect(table).toContainText("add hotel angle");

  await table.locator("tr", { hasText: "v3" }).getByRole("link", { name: "Diff against live" }).click();
  const diff = page.getByTestId("diff");
  await expect(diff).toContainText("H1");
  await expect(diff).toContainText("SEO Agency in Bali for Hotels");

  await hydrated(page.getByTestId("restore-1"));
  await page.getByTestId("restore-1").click();
  await page.getByTestId("confirm-restore-1").click();
  await expect(page).toHaveURL(/service\.seo\?locale=en$/);
  await expect(page.getByTestId("item-head")).toHaveText("v4");
  await expect(page.locator(P("h1"))).toHaveValue("SEO Agency Bali");
  expect((await stub.item("itm-service-seo-en")).publishedVersion).toBe(2); // restore never touches live
});

// ── the approvals renderer ────────────────────────────────────────────────────────────────────────

test("approvals detail: origin `webdesk` shows the publish summary, and Approve executes it", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.getByTestId("request-publish").click();
  await expect(page.getByTestId("awaiting-approval")).toBeVisible();
  await page.getByRole("link", { name: "Open approval" }).click();

  await expect(page).toHaveURL(/\/approvals\/ap-0001-publish$/);
  const summary = page.getByTestId("webdesk-summary");
  await expect(summary).toContainText("Publish to WebDesk");
  await expect(summary).toContainText("gaiada / site-gaiada-com");
  await expect(summary).toContainText("1 item");
  await expect(summary).toContainText("staging site, after publishing");
  const row = page.getByTestId("summary-items").locator("tbody tr");
  await expect(row).toContainText("service");
  await expect(row).toContainText("service.seo");
  await expect(row).toContainText("v3"); // requested
  await expect(row).toContainText("v2"); // live now
  await expect(row.getByRole("link", { name: "Diff against live" })).toHaveAttribute("href", /history\?locale=en&compare=3$/);
  await expect(page.getByTestId("summary-lint")).toContainText("1 unresolved token");
  await expect(page.getByTestId("summary-lint")).toContainText("1 × [CLIENT");

  await page.getByRole("button", { name: "Approve" }).click();
  await expect.poll(async () => (await stub.item("itm-service-seo-en")).publishedVersion).toBe(3);
});

test("approvals detail: a webdesk approval with arguments in the wrong format is flagged, not summarised", async ({ page }) => {
  await stub.post("config", {});
  // file a request, then corrupt it in the stub's store via the decide-less path: use an unknown workflow shape
  await open(page, SERVICE_SEO);
  await page.getByTestId("request-publish").click();
  await expect(page.getByTestId("awaiting-approval")).toBeVisible();
  await stub.post("corrupt-args", { id: "ap-0001-publish" });
  await page.goto("/approvals/ap-0001-publish");
  await expect(page.getByTestId("webdesk-summary-unrecognised")).toContainText("Unrecognised request");
  await expect(page.getByTestId("summary-items")).toHaveCount(0);
});
