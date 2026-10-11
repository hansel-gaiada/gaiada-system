import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";

// WSK-49d — the client portal's Website area, as an EXTERNAL CLIENT EDITOR, against the STUBBED client website BFF
// (e2e/webdesk-stub/portal.mjs: FRONTEND-BFF-CONTRACT §16j), run by playwright.webdesk.config.ts.
//
//   npx playwright test -c playwright.webdesk.config.ts portal-website
//
// The app runs NOT in demo mode: its real `platformFetch`, session cookie, server components and server actions talk to the stub.
// Identities (stub): editor1@northwind.example = Dana (client editor), editor2@northwind.example = Ewan (a colleague, also an editor),
// viewer@northwind.example = a client contact WITHOUT the grant, hansel@gaiada.com = Gaiada staff.
//
// Fixtures: `service` (h1, body, plan.why are the client's, the rest is Gaiada's; required fields only Gaiada can fill, so a client CAN'T
// create there) and `banner` (the whole collection is the client's: create works). `service.web-design` is live at v1.

const STUB = `http://127.0.0.1:${process.env.WD_STUB_PORT || 3991}`;
const SITE = "/portal/website/gaiada/site-gaiada-com";
const WEB_DESIGN = `${SITE}/service/service.web-design?locale=en`;
const P = (p: string) => `[data-pointer="/blocks/0/props/${p}"]`;

const stub = {
  post: async (cmd: string, body: unknown = {}) => (await (await fetch(`${STUB}/__stub/${cmd}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as unknown,
  reset: () => stub.post("reset"),
  config: (c: Record<string, unknown>) => stub.post("config", c),
  state: async () => (await (await fetch(`${STUB}/__stub/state`, { method: "POST" })).json()) as {
    items: { itemId: string; slug: string; locale: string; headVersion: number; publishedVersion: number | null; publishState: string; versions: { n: number; createdBy: string; props?: Record<string, unknown>; seo: Record<string, unknown> }[] }[];
    approvals: { id: string; status: string; workflowId: string; requestedBy: string; toolArgs: { items: { itemId: string; version: number }[]; clientId?: string } }[];
  },
  item: async (slug: string) => (await stub.state()).items.find((i) => i.slug === slug)!,
};

async function loginAs(page: Page, email: string, landing: string | RegExp = "**/portal") {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(landing);
}
const DANA = "editor1@northwind.example";
const EWAN = "editor2@northwind.example";

// The server HTML of a page can look interactive well before React hydrates; a click in that gap is lost. React tags a hydrated node.
async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function openEditor(page: Page, url: string) {
  await page.goto(url);
  await hydrated(page.getByTestId("item-editor"));
}
async function newClient(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, email);
  return { context, page };
}
const axeViolations = async (page: Page, include = "main") =>
  (await new AxeBuilder({ page }).include(include).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);

test.beforeEach(async () => { await stub.reset(); });

// ── access ─────────────────────────────────────────────────────────────────────────────────────────

test("a client editor sees the Website tab in the Business area, and the Website page lists ONLY their linked site", async ({ page }) => {
  await loginAs(page, DANA);
  await page.goto("/portal/company");
  const sub = page.getByRole("navigation", { name: "Business pages" });
  await expect(sub.getByRole("link", { name: "Website" })).toBeVisible();
  await sub.getByRole("link", { name: "Website" }).click();
  await expect(page).toHaveURL(/\/portal\/website$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Website");
  await expect(page.getByTestId("sites").getByRole("link")).toHaveCount(1);
  await expect(page.getByTestId("site-site-gaiada-com")).toContainText("gaiada.com");
  // the portal shell, not the staff one
  await expect(page.getByRole("link", { name: /^Departments$/ })).toHaveCount(0);
});

test("a client contact WITHOUT the grant has no Website tab, and the URL says so plainly (never an empty list)", async ({ page }) => {
  await loginAs(page, "viewer@northwind.example");
  await page.goto("/portal/company");
  await expect(page.getByRole("navigation", { name: "Business pages" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Website" })).toHaveCount(0);
  for (const url of ["/portal/website", `${SITE}`, `${SITE}/service`, WEB_DESIGN, `${SITE}/~media`]) {
    await page.goto(url);
    await expect(page.getByTestId("no-website-access")).toHaveText("You don't have website editing access. Ask your company's admin.");
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByTestId("item-editor")).toHaveCount(0);
  }
});

test("Gaiada staff viewing the portal get the same plain page, and no tab", async ({ page, context }) => {
  await loginAs(page, "hansel@gaiada.com", "**/");
  await page.goto("/portal/website");
  await expect(page.getByTestId("no-website-access")).toHaveText("You don't have website editing access. Ask your company's admin.");
  await expect(page.getByRole("link", { name: "Website", exact: true })).toHaveCount(0);
  void context;
});

// ── sites -> collections -> items ──────────────────────────────────────────────────────────────────

test("collections say who edits them; the item list shows each item's state; no deleted item and no delete / unpublish / schedule control", async ({ page }) => {
  await loginAs(page, DANA);
  await page.goto("/portal/website");
  await page.getByTestId("site-site-gaiada-com").click();
  await expect(page).toHaveURL(new RegExp(`${SITE}$`));
  const cols = page.getByTestId("collections");
  await expect(cols.getByTestId("collection-service").getByTestId("editable-chip")).toHaveText("You can edit some fields");
  await expect(cols.getByTestId("collection-banner").getByTestId("editable-chip")).toHaveText("You can edit this");
  await expect(cols.getByTestId("collection-navigation").getByTestId("editable-chip")).toHaveText("Managed by Gaiada");

  await cols.getByRole("link", { name: "Service pages" }).click();
  const table = page.getByTestId("items-table");
  const row = (slug: string, locale = "en") => table.locator(`[data-testid="item-row-${slug}"][data-locale="${locale}"]`);
  await expect(row("service.seo")).toContainText("Live, with changes not published");
  await expect(row("service.seo", "id")).toContainText("Draft, not live yet");
  await expect(row("service.web-design")).toContainText("Live");
  await expect(row("service.local-seo")).toContainText("Draft, not live yet");
  // the deleted draft never appears
  await expect(table.getByTestId("item-row-service.old-draft")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /delete|unpublish|schedule/i })).toHaveCount(0);
  await expect(page.getByText(/unpublish|schedule/i)).toHaveCount(0);
  // a hand-typed ?state=deleted is dropped, not forwarded (the BFF would 400 it)
  await page.goto(`${SITE}/service?state=deleted`);
  await expect(page.getByTestId("items-table")).toBeVisible();
  await expect(page.getByTestId("item-row-service.old-draft")).toHaveCount(0);
});

test("create is offered only where the collection allows it, and otherwise says why", async ({ page }) => {
  await loginAs(page, DANA);
  await page.goto(`${SITE}/service`);
  await expect(page.getByTestId("new-item")).toHaveCount(0);
  await expect(page.getByTestId("create-blocked")).toContainText("This collection has required fields only Gaiada can fill");
  await page.goto(`${SITE}/service/~new`);
  await expect(page.getByTestId("create-blocked")).toContainText("This collection has required fields only Gaiada can fill");
  await expect(page.getByTestId("item-editor")).toHaveCount(0);
  await page.goto(`${SITE}/banner`);
  await expect(page.getByTestId("new-item")).toBeVisible();
});

// ── the editor in client mode ─────────────────────────────────────────────────────────────────────

test("the editor: a protected field and seo are read-only and say why; the client's own fields edit; save sends only what the BFF expects", async ({ page }) => {
  await loginAs(page, DANA);
  await openEditor(page, WEB_DESIGN);
  // protected: read-only, announced as read-only, with the reason attached
  const url = page.locator(P("url"));
  await expect(url).toHaveAttribute("aria-readonly", "true");
  await expect(url).not.toBeEditable();
  await expect(page.locator(P("template"))).toBeDisabled();
  await expect(page.getByText("Managed by Gaiada.").first()).toBeVisible();
  const seo = page.locator('[data-pointer="/seo/title"]');
  await expect(seo).toHaveAttribute("aria-readonly", "true");
  await expect(seo).not.toBeEditable();
  // no staff-only controls
  await expect(page.getByTestId("staff-publish-bar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /delete|unpublish|schedule|rebuild/i })).toHaveCount(0);
  await expect(page.getByText(/WebDesk|vocabulary/)).toHaveCount(0);
  // the client's field
  await page.locator(P("h1")).fill("Web Design in Bali");
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved v2");
  const it = await stub.item("service.web-design");
  expect(it.headVersion).toBe(2);
  expect(it.versions[1].createdBy).toBe("wd-client-a");
  expect(it.versions[1].props?.h1).toBe("Web Design in Bali");
  expect(it.versions[1].props?.template).toBe(it.versions[0].props?.template); // protected: unchanged
  expect(it.versions[1].seo).toEqual(it.versions[0].seo);
});

test("self-publish ONE item (D58): Publish now asks once, publishes that item, and says what is true", async ({ page }) => {
  await loginAs(page, DANA);
  await openEditor(page, WEB_DESIGN);
  // nothing new yet: Publish now is off, with the reason
  await expect(page.getByTestId("publish-now")).toBeDisabled();
  await expect(page.getByTestId("publish-block-reason")).toHaveText("There is nothing new to publish.");
  await page.locator(P("h1")).fill("Web Design in Bali");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved v2");
  await expect(page.getByTestId("publish-now")).toBeEnabled();
  await page.getByTestId("publish-now").click();
  await expect(page.getByTestId("publish-now-ask")).toContainText("Publish v2 of this page now?");
  expect((await stub.item("service.web-design")).publishedVersion).toBe(1); // asking published nothing
  await page.getByTestId("publish-now-confirm").click();
  await expect(page.getByTestId("published")).toContainText("Published. Your site updates in a few minutes.");
  expect((await stub.item("service.web-design")).publishedVersion).toBe(2);
  // the panel now reads live at v2
  await expect(page.getByTestId("publish-state")).toHaveText("Live · v2");
  await expect(page.getByTestId("publish-now")).toBeDisabled();
});

test("STATE 409 version-conflict: the owner's words, a Reload button, and the unsaved text stays to copy; Reload shows the latest", async ({ page }) => {
  await loginAs(page, DANA);
  await openEditor(page, WEB_DESIGN);
  // Gaiada staff saves a newer version after Dana opened the page
  const it = await stub.item("service.web-design");
  await stub.post("concurrent-save", { itemId: it.itemId, fields: { h1: "Staff headline" }, by: "dept-manager" });
  await page.locator(P("h1")).fill("My unsaved headline");
  await page.getByTestId("save").click();
  const box = page.getByTestId("client-conflict");
  await expect(box).toContainText("This page changed since you opened it. Reload to see the latest, then make your change again.");
  await expect(page.locator(P("h1"))).toHaveValue("My unsaved headline"); // kept, visible to copy
  await expect(page.getByTestId("save")).toBeDisabled();
  expect((await stub.item("service.web-design")).headVersion).toBe(2); // nothing of Dana's was written
  await page.getByTestId("client-conflict-reload").click();
  await expect(box).toHaveCount(0);
  await expect(page.locator(P("h1"))).toHaveValue("Staff headline");
  await expect(page.getByTestId("editor-banner")).toContainText("Reloaded the latest version (v2)");
});

test("STATE stale: the service is down after load: the page says so in plain words and keeps the edits", async ({ page }) => {
  await loginAs(page, DANA);
  await openEditor(page, WEB_DESIGN);
  await page.locator(P("h1")).fill("Kept through the outage");
  await stub.config({ unavailable: true });
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-error")).toContainText("Couldn't reach the website service.");
  await expect(page.getByTestId("stale-banner")).toContainText("the website service answers again");
  await expect(page.getByTestId("stale-banner")).not.toContainText("WebDesk");
  await expect(page.locator(P("h1"))).toHaveValue("Kept through the outage");
  await expect(page.getByTestId("save")).toBeDisabled();
  await stub.config({ unavailable: false });
});

test("STATE editorial unavailable on load is a full-page notice, never an empty list or form", async ({ page }) => {
  await loginAs(page, DANA);
  await stub.config({ unavailable: true });
  await page.goto(`${SITE}/service`);
  await expect(page.getByTestId("website-unavailable")).toContainText("Editing is unavailable right now");
  await expect(page.getByTestId("website-unavailable")).toContainText("Nothing has been lost.");
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.goto(WEB_DESIGN);
  await expect(page.getByTestId("website-unavailable")).toBeVisible();
  await expect(page.getByTestId("item-editor")).toHaveCount(0);
  await stub.config({ unavailable: false });
});

test("STATE 422 publish-not-client-editable: a draft that carries Gaiada-only changes is refused in the owner's words", async ({ page }) => {
  await loginAs(page, DANA);
  // Gaiada changes a PROTECTED field of a live page after the last publish
  const it = await stub.item("service.web-design");
  await stub.post("concurrent-save", { itemId: it.itemId, fields: { template: "landing" }, by: "dept-manager" });
  await page.goto(`${SITE}/service`);
  const row = page.getByTestId("item-row-service.web-design");
  await row.getByRole("checkbox").check();
  await page.getByTestId("request-publish").click();
  await expect(page.getByTestId("items-notice")).toContainText("This draft includes changes only Gaiada can publish. Gaiada will publish it, or you can restore the live version and edit again.");
  await expect(page.getByTestId("items-notice")).toContainText("Template");
  expect((await stub.state()).approvals.filter((a) => a.workflowId === "content.publish")).toHaveLength(0); // nothing was filed
});

test("Preview reuses the staff behaviour, including 'this site doesn't have a preview page yet'", async ({ page }) => {
  await loginAs(page, DANA);
  await stub.config({ previewMissing: true });
  await openEditor(page, WEB_DESIGN);
  await page.getByTestId("preview").click();
  await expect(page.getByTestId("preview-notice")).toContainText("This site doesn't have a preview page yet.");
  await stub.config({ previewMissing: false });
  const popup = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
  await page.getByTestId("preview").click();
  await expect(page.getByTestId("preview-ready")).toContainText("Link valid until");
  void popup;
});

// ── create ─────────────────────────────────────────────────────────────────────────────────────────

test("create a page where it is allowed: the server opens the new page", async ({ page }) => {
  await loginAs(page, DANA);
  await page.goto(`${SITE}/banner/~new?locale=en`);
  await hydrated(page.getByTestId("item-editor"));
  await page.locator("#wc-slug").fill("banner.spring");
  await page.locator(P("title")).fill("Spring banner");
  await page.getByTestId("save").click();
  await expect(page).toHaveURL(/\/banner\/banner\.spring\?locale=en$/);
  await hydrated(page.getByTestId("item-editor"));
  await expect(page.locator(P("title"))).toHaveValue("Spring banner");
  const it = await stub.item("banner.spring");
  expect(it.versions[0].createdBy).toBe("wd-client-a");
});

// ── a batch needs a second person (D58) ───────────────────────────────────────────────────────────

test("files a 2-item request, sees Approve ABSENT on it, withdraws on demand; a second client editor approves the batch", async ({ page, browser }) => {
  await loginAs(page, DANA);
  await page.goto(`${SITE}/banner`);
  await hydrated(page.getByTestId("items-table"));
  await expect(page.getByTestId("request-publish")).toBeDisabled();
  await page.getByRole("checkbox", { name: /Select Home banner \(en\)/ }).check();
  await page.getByRole("checkbox", { name: /Select Autumn banner \(en\)/ }).check();
  await expect(page.getByTestId("request-publish")).toHaveText("Request publish (2)");
  await page.getByTestId("request-publish").click();
  await expect(page.getByTestId("items-notice")).toContainText("Request filed for 2 pages. Another person from your company needs to approve it before anything goes live.");
  // both rows now say so, and nothing is live
  await expect(page.getByTestId("item-row-banner.home")).toContainText("Waiting for approval");
  expect((await stub.state()).items.filter((i) => i.slug.startsWith("banner.")).every((i) => i.publishedVersion === null)).toBe(true);

  // the requests list: Dana's own request has Withdraw and NO Approve
  await page.goto("/portal/website");
  const mine = page.locator('[data-testid^="request-ap-"][data-mine]');
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText("Filed by You");
  await expect(mine).toContainText("Home banner");
  await expect(mine).toContainText("latest draft v1");
  await expect(mine.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  await expect(mine.getByTestId("needs-colleague")).toHaveText("Waiting for another person from your company to approve.");
  await expect(mine.getByRole("button", { name: /^Withdraw/ })).toBeVisible();

  // Ewan (a second client editor) sees Dana's request, with Approve and without Withdraw, and approves it
  const ewan = await newClient(browser, EWAN);
  await ewan.page.goto("/portal/website");
  const theirs = ewan.page.locator('[data-testid^="request-ap-"]');
  await expect(theirs).toHaveCount(1);
  await expect(theirs).toContainText("Filed by Dana Editor");
  await expect(theirs.getByRole("button", { name: /^Withdraw/ })).toHaveCount(0);
  const approveId = (await stub.state()).approvals.find((a) => a.workflowId === "content.publish")!.id;
  await hydrated(theirs.getByTestId(`approve-${approveId}`));
  await theirs.getByTestId(`approve-${approveId}`).click(); // asks once: nothing is published by the first press
  await expect(theirs.getByTestId(`approve-${approveId}-ask`)).toContainText("Approve and publish 2 pages now?");
  expect((await stub.state()).items.filter((i) => i.slug.startsWith("banner.")).every((i) => i.publishedVersion === null)).toBe(true);
  await theirs.getByTestId(`approve-${approveId}-confirm`).click();
  await expect(theirs.getByTestId("request-notice")).toHaveText("Published. Your site updates in a few minutes.");
  const after = await stub.state();
  expect(after.items.filter((i) => i.slug === "banner.home" || i.slug === "banner.autumn").map((i) => i.publishedVersion)).toEqual([1, 1]);
  expect(after.approvals.find((a) => a.workflowId === "content.publish")?.status).toBe("approved");
  await ewan.context.close();

  // Dana's list now reads the decided request honestly
  await page.reload();
  await expect(page.getByTestId("request-state").first()).toHaveText("Approved and sent");
});

test("a self-approved batch is refused by the SERVER, in the owner's words (the page never offered it)", async ({ page }) => {
  await loginAs(page, DANA);
  await page.goto(`${SITE}/banner`);
  await hydrated(page.getByTestId("items-table"));
  await page.getByRole("checkbox", { name: /Select Home banner/ }).check();
  await page.getByRole("checkbox", { name: /Select Autumn banner/ }).check();
  await page.getByTestId("request-publish").click();
  await expect(page.getByTestId("items-notice")).toContainText("Request filed for 2 pages");
  const id = (await stub.state()).approvals.find((a) => a.workflowId === "content.publish")!.id;
  // The browser has no way to approve it (only a colleague's page offers the button), so drive the stub as Dana directly: the wall the page relies on is the server's.
  const res = await fetch(`${STUB}/api/co-agency/portal/clients/0c1e57a1-5a0e-4c11-8d10-000000000c01/website/publish-requests/${id}/approve`, { method: "POST", headers: { "x-user-id": "wd-client-a" } });
  expect(res.status).toBe(403);
  expect((await stub.state()).approvals.find((a) => a.id === id)?.status).toBe("pending");
});

test("Withdraw cancels the viewer's own request and says nothing was published", async ({ page }) => {
  await loginAs(page, DANA);
  await page.goto(`${SITE}/banner`);
  await hydrated(page.getByTestId("items-table"));
  await page.getByRole("checkbox", { name: /Select Home banner/ }).check();
  await page.getByTestId("request-publish").click();
  await expect(page.getByTestId("items-notice")).toContainText("Request filed for 1 page");
  await page.goto("/portal/website");
  const mine = page.locator('[data-testid^="request-ap-"][data-mine]');
  await hydrated(mine.getByRole("button", { name: /^Withdraw/ }));
  await mine.getByRole("button", { name: /^Withdraw/ }).click();
  await expect(mine.getByTestId("request-notice")).toHaveText("Request withdrawn. Nothing was published.");
  expect((await stub.state()).approvals.find((a) => a.workflowId === "content.publish")?.status).toBe("cancelled");
});

// ── history ────────────────────────────────────────────────────────────────────────────────────────

test("history lists versions with authors and restores one as a draft", async ({ page }) => {
  await loginAs(page, DANA);
  await openEditor(page, WEB_DESIGN);
  await page.locator(P("h1")).fill("Second headline");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved v2");
  await page.goto(`${SITE}/service/service.web-design/history?locale=en`);
  const table = page.getByTestId("versions-table");
  await expect(table).toContainText("Dana Editor (you)");
  await expect(table).not.toContainText("Hash");
  await page.getByTestId("restore-1").click();
  await page.getByTestId("confirm-restore-1").click();
  await expect(page).toHaveURL(/\/service\/service\.web-design\?locale=en$/);
  const it = await stub.item("service.web-design");
  expect(it.headVersion).toBe(3);
  expect(it.versions[2].props?.h1).toBe(it.versions[0].props?.h1);
});

// ── media ──────────────────────────────────────────────────────────────────────────────────────────

test("media: browse, edit details, upload; NO delete and no 'where it's used'", async ({ page }) => {
  await stub.post("seed-media", { title: "Logo", alt: { en: "Logo" }, mime: "image/png", originalFilename: "logo.png" });
  await loginAs(page, DANA);
  await page.goto(`${SITE}/~media`);
  await hydrated(page.getByTestId("media-upload"));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Images and files");
  await page.getByTestId("media-tile").first().click();
  await expect(page.getByTestId("media-detail")).toBeVisible();
  await expect(page.getByTestId("media-delete")).toHaveCount(0);
  await expect(page.getByTestId("media-usage")).toHaveCount(0);
  await expect(page.getByText(/delete/i)).toHaveCount(0);
  await page.getByLabel("Title").fill("Company logo");
  await page.getByTestId("media-save").click();
  await expect(page.getByTestId("media-detail-title")).toHaveText("Company logo");
  // an upload goes browser -> WebDesk (the stub's public route)
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await page.getByTestId("media-file-input").setInputFiles([{ name: "new.png", mimeType: "image/png", buffer: png }]);
  await expect(page.getByTestId("media-tile")).toHaveCount(2);
});

// ── accessibility ──────────────────────────────────────────────────────────────────────────────────

test("axe: the Website page, the collections, the list and the editor have no violations (WCAG 2.1 A/AA)", async ({ page }) => {
  await loginAs(page, DANA);
  // a pending request, so the requests list is on the page too
  await page.goto(`${SITE}/banner`);
  await hydrated(page.getByTestId("items-table"));
  await page.getByRole("checkbox", { name: /Select Home banner/ }).check();
  await page.getByTestId("request-publish").click();
  await expect(page.getByTestId("items-notice")).toContainText("Request filed");
  const seen: Record<string, string[]> = {};
  for (const [name, url, ready] of [
    ["Website", "/portal/website", "sites"], ["Collections", SITE, "collections"], ["Items", `${SITE}/banner`, "items-table"],
    ["History", `${SITE}/service/service.web-design/history?locale=en`, "versions-table"],
  ] as const) {
    await page.goto(url);
    await expect(page.getByTestId(ready)).toBeVisible();
    seen[name] = await axeViolations(page);
  }
  await openEditor(page, WEB_DESIGN);
  seen.Editor = await axeViolations(page);
  // with the conflict banner and the read-only fields on screen
  const it = await stub.item("service.web-design");
  await stub.post("concurrent-save", { itemId: it.itemId, fields: { h1: "Staff headline" }, by: "dept-manager" });
  await page.locator(P("h1")).fill("Mine");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("client-conflict")).toBeVisible();
  seen["Editor with conflict"] = await axeViolations(page);
  expect(seen).toEqual({ Website: [], Collections: [], Items: [], History: [], Editor: [], "Editor with conflict": [] });
});

test("keyboard: the confirm step is reachable and returns focus; every control in the list has an accessible name", async ({ page }) => {
  await loginAs(page, DANA);
  await openEditor(page, WEB_DESIGN);
  await page.locator(P("h1")).fill("Keyboard headline");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved v2");
  const ask = page.getByTestId("publish-now");
  await ask.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("publish-now-confirm")).toBeFocused(); // focus moves to the question
  await page.keyboard.press("Escape");
  await page.getByTestId("publish-now-cancel").click();
  await expect(ask).toBeFocused(); // and returns
  // every button and field on the editor has an accessible name
  const unnamed = await page.locator("main button, main input, main select, main textarea").evaluateAll((els) =>
    els.filter((e) => {
      const el = e as HTMLInputElement;
      if (el.type === "hidden") return false;
      const label = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (el.labels && el.labels.length > 0) || (el.textContent ?? "").trim() || el.getAttribute("title");
      return !label;
    }).map((e) => e.outerHTML.slice(0, 120)));
  expect(unnamed).toEqual([]);
});
