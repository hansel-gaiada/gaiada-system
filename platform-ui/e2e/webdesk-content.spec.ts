import AxeBuilder from "@axe-core/playwright";
import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import zlib from "node:zlib";

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
    approvals: { id: string; status: string; workflowId: string; toolArgs: { items: { itemId: string; version: number }[]; envId?: string; scope?: string; siteId?: string; tenantSlug?: string } }[];
    build: { state: string } | null;
    stagingStale: boolean;
    // WSK-43c: the media library, and what the fake WebDesk upload endpoint received
    media: { assetId: string; mime: string; sizeBytes: number; title: string | null; alt: Record<string, string>; tags: string[]; originalFilename: string | null; width: number | null; height: number | null; createdBy: string | null; deletedAt: string | null; bucket: string }[];
    uploadLog: { token: string; contentType: string; filename: string | null; size: number; origin: string | null }[];
    mediaLog: { op: string; bucket?: string; assetId?: string; keys?: string[]; by: string }[];
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
  const link = page.getByRole("navigation", { name: "Department sections" }).getByRole("link", { name: "Website" });
  await hydrated(link); // a click before hydration is a full page load, not the soft navigation under test
  await stub.config({ delayMs: 2000 });
  await link.click();
  await expect(page.getByTestId("wd-skeleton")).toBeVisible();
  // three sequential BFF calls at 2 s each, on a shared and sometimes loaded host: generous on purpose
  await expect(page.getByTestId("collections")).toBeVisible({ timeout: 90_000 });
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

test("markdown fields have a visual editor, a source tab and a structural preview", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await expect(page.getByRole("tab", { name: "Visual" })).toHaveAttribute("aria-selected", "true"); // WSK-45: a text that round-trips opens visually
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.getByTestId("markdown-preview").getByRole("heading", { name: "SEO Agency in Bali" })).toBeVisible();
  await expect(page.getByTestId("markdown-preview").locator("li")).toHaveCount(3);
  await page.getByRole("tab", { name: "Source" }).click();
  await expect(page.locator(P("body"))).toBeVisible();
});

// WSK-45 — the visual editor in a real browser. The obligation (owner ruling WSK-D49): a body nobody changed is saved
// byte-identical; a body that was changed differs from the original by exactly that change.
const SEO_ID = "itm-service-seo-en";
const headBody = async () => {
  const it = await stub.item(SEO_ID);
  const v = it.versions.at(-1)!;
  return { n: it.headVersion, props: (v.props ?? {}) as Record<string, any> };
};

test("WSK-45 visual editor: bold on one word through the toolbar saves exactly that markdown change and nothing else", async ({ page }) => {
  const before = await headBody();
  expect(typeof before.props.body).toBe("string");
  await open(page, SERVICE_SEO);
  await expect(page.getByRole("tab", { name: "Visual" })).toHaveAttribute("aria-selected", "true");
  const surface = page.locator(P("body"));
  await expect(surface).toHaveAttribute("contenteditable", "true");
  await hydrated(page.getByTestId("item-editor"));
  // select the word "villas" with a real DOM selection, then press the Bold toolbar button
  await surface.evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n.textContent ?? "").indexOf("villas");
      if (at >= 0) {
        const r = document.createRange();
        r.setStart(n, at);
        r.setEnd(n, at + "villas".length);
        const s = window.getSelection()!;
        s.removeAllRanges();
        s.addRange(r);
        return;
      }
    }
    throw new Error("word not found");
  });
  const bold = page.getByRole("button", { name: "Bold" });
  await expect(bold).toBeEnabled();
  await bold.click();
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-status")).toHaveText(`Saved v${before.n + 1}`);
  const after = await headBody();
  expect(after.n).toBe(before.n + 1);
  // the stored body is the original with exactly one change: villas -> **villas**
  expect(after.props.body).toBe((before.props.body as string).replace("villas", "**villas**"));
  expect(after.props.body).toContain("[CLIENT: confirm results claim]"); // the placeholder is untouched
  // and no other field moved
  const { body: _a, ...restAfter } = after.props;
  const { body: _b, ...restBefore } = before.props;
  expect(restAfter).toEqual(restBefore);
});

test("WSK-45 visual editor: an unchanged markdown body is saved byte-identical when another field is edited", async ({ page }) => {
  const before = await headBody();
  await open(page, SERVICE_SEO);
  await expect(page.getByRole("tab", { name: "Visual" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(P("body"))).toHaveAttribute("contenteditable", "true");
  // touch the editor without changing the document (focus, caret keys), move through the tabs and back
  await page.locator(P("body")).click();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("tab", { name: "Source" }).click();
  await page.getByRole("tab", { name: "Visual" }).click();
  await expect(page.locator(P("body"))).toHaveAttribute("contenteditable", "true");
  await expect(page.getByTestId("save")).toBeDisabled(); // nothing is dirty yet: the editor has not changed the value
  await page.locator(P("h1")).fill("SEO Agency in Bali — second edit");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-status")).toHaveText(`Saved v${before.n + 1}`);
  const after = await headBody();
  expect(after.props.h1).toBe("SEO Agency in Bali — second edit");
  expect(after.props.body).toBe(before.props.body); // the very same bytes
});

test("WSK-45 visual editor: typing then deleting a character leaves the field clean (the original bytes come back)", async ({ page }) => {
  await open(page, SERVICE_SEO);
  const surface = page.locator(P("body"));
  await expect(surface).toHaveAttribute("contenteditable", "true");
  await surface.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("End");
  await page.keyboard.type("x");
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("save-status")).toHaveText("No changes");
  await expect(page.getByTestId("save")).toBeDisabled();
});

test("WSK-45 visual editor: no axe violation (WCAG 2 A/AA) inside the markdown field, toolbar and link bar open", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await expect(page.locator(P("body"))).toHaveAttribute("contenteditable", "true");
  await page.getByRole("button", { name: "Link" }).click();
  await expect(page.getByLabel("Link address")).toBeVisible();
  const r = await new AxeBuilder({ page }).include(".wc-md").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  // a keyboard user can reach and operate the toolbar
  await page.getByRole("button", { name: "Bold" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Italic" })).toBeFocused();
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

test("STATE write outcome unknown (502 webdesk_ambiguous), the write did NOT land: 'couldn't confirm', edits kept, Reload recovers", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.locator(P("h1")).fill("Typed, outcome unknown");
  await stub.config({ ambiguous: "drop" });
  await page.getByTestId("save").click();
  const banner = page.getByTestId("unconfirmed-banner");
  await expect(banner).toContainText("We couldn't confirm the save. Reload to see what happened.");
  await expect(banner).toHaveAttribute("role", "alert");
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes"); // never "Saved vN"
  await expect(page.getByTestId("save-error")).toHaveCount(0);                  // never a confident failure
  await expect(page.getByTestId("save")).toBeDisabled();
  await expect(page.getByTestId("request-publish")).toBeDisabled();
  await expect(page.locator(P("h1"))).toHaveValue("Typed, outcome unknown");
  expect((await stub.item("itm-service-seo-en")).headVersion).toBe(3);

  await stub.config({ ambiguous: null });
  await page.getByTestId("unconfirmed-reload").click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("save")).toBeEnabled();
  await expect(page.locator(P("h1"))).toHaveValue("Typed, outcome unknown");
});

test("STATE write outcome unknown, the write DID land: Reload shows the head moved instead of a false failure", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.locator(P("h1")).fill("Landed after all");
  await stub.config({ ambiguous: "land" });
  await page.getByTestId("save").click();
  await expect(page.getByTestId("unconfirmed-banner")).toContainText("We couldn't confirm the save");
  expect((await stub.item("itm-service-seo-en")).headVersion).toBe(4);
  await stub.config({ ambiguous: null });
  await page.getByTestId("unconfirmed-reload").click();
  await expect(page.getByTestId("unconfirmed-banner")).toHaveCount(0);
  await expect(page.getByTestId("behind-head")).toContainText("v4 was saved since you opened this");
  await expect(page.locator(P("h1"))).toHaveValue("Landed after all");
});

test("STATE lint unavailable: the placeholders card says it couldn't check, never 'No unresolved placeholders'", async ({ page }) => {
  await stub.config({ lintUnavailable: true });
  await open(page, SERVICE_SEO);
  const card = page.getByTestId("lint-card");
  await expect(page.getByTestId("lint-unavailable")).toHaveText("Couldn't check for placeholders. This is not a statement that there are none.");
  await expect(card).not.toContainText("No unresolved placeholders");
  await stub.config({ lintUnavailable: false });
  await page.getByTestId("refresh-now").click();
  await expect(page.getByTestId("lint-unavailable")).toHaveCount(0);
});

test("STATE staging rebuild not set up (503 webdesk_not_configured): plain words, no raw slug, no approval filed", async ({ page }) => {
  await open(page, `${SITE}/service/service.web-design?locale=en`);
  await page.getByTestId("unpublish").click();
  await page.getByTestId("confirm-unpublish").click();
  await expect(page.getByTestId("staging-stale")).toBeVisible();
  await stub.config({ rebuildNotConfigured: true });
  await page.getByTestId("request-rebuild").click();
  const msg = page.getByTestId("publish-message");
  await expect(msg).toHaveText("Staging rebuild isn't set up for this site.");
  await expect(msg).not.toContainText("webdesk_not_configured");
  await expect(page.getByTestId("awaiting-approval")).toHaveCount(0);
  await expect(page.getByTestId("stale-banner")).toHaveCount(0); // not an outage
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
  // the real BFF keeps the row and marks it `cancelled` (not `rejected`)
  expect((await stub.state()).approvals.map((a) => a.status)).toEqual(["cancelled"]);
  // and a withdrawn request is no longer "pending after reload"
  await page.reload();
  await expect(page.getByTestId("awaiting-approval")).toHaveCount(0);
});

test("a requester WITHOUT approval-read (webdev_staff): the request still shows after a reload, and the poll still learns it was decided", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.getByTestId("request-publish").click();
  await expect(page.getByTestId("awaiting-approval")).toContainText("#ap-0001");
  await stub.config({ approvalReadForbidden: true }); // the generic approvals list AND detail now 403 for this caller
  await page.reload();
  await expect(page.getByTestId("awaiting-approval")).toContainText("Awaiting approval #ap-0001"); // from …/publish-requests
  await stub.post("decide", { id: "ap-0001-publish", outcome: "reject", by: "dept-manager" });
  await expect(page.getByTestId("request-rejected")).toContainText("Rejected"); // the poll fell back to the own-requests route
});

test("STATE withdrawn elsewhere: a request cancelled in another tab reads Withdrawn, not Rejected", async ({ page }) => {
  await open(page, SERVICE_SEO);
  await page.getByTestId("request-publish").click();
  await expect(page.getByTestId("awaiting-approval")).toBeVisible();
  const r = await fetch(`${STUB}/api/co-agency/modules/webdev/content/sites/gaiada/site-gaiada-com/publish-requests/ap-0001-publish/withdraw`, { method: "POST", headers: { "x-user-id": "demo-hansel" } });
  expect(await r.json()).toEqual({ approvalId: "ap-0001-publish", status: "cancelled" });
  const w = page.getByTestId("request-withdrawn");
  await expect(w).toContainText("Withdrawn");
  await expect(w).toContainText("Nothing was published");
  await expect(page.getByTestId("request-rejected")).toHaveCount(0);
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
  await hydrated(page.getByTestId("item-editor")); // typing into a not-yet-hydrated controlled input is lost
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
  await page.getByRole("tab", { name: "Source" }).click(); // the plain textarea: fill() sets the Markdown itself
  await page.locator(P("body")).fill("# New thing\n");
  await page.getByTestId("save").click();
  await expect(page).toHaveURL(/service\/service\.new-thing\?locale=en$/);
  await expect(page.getByTestId("item-state")).toHaveText("Draft");
});

test("history: versions with head/live chips, diff against live, and Restore as draft", async ({ page }) => {
  await open(page, SERVICE_SEO);
  const historyLink = page.getByRole("link", { name: "Version history" });
  await hydrated(historyLink); // a click that lands mid-hydration is lost (the editor stays; seen under load on the built app)
  await historyLink.click();
  await expect(page).toHaveURL(/\/history\?/);
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

// ── API keys: "Request an API key" (filing) and the approver's once-only reveal ────────────────────

const PROD_ENV = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const STG_ENV = "2b3c4d5e-6f70-4b8c-9d0e-1f2a3b4c5d6e";

test("API keys: a publisher requests a read key -> 'Request filed'; asking again -> 'Already requested'; write is its own request; nothing is minted", async ({ page }) => {
  await page.goto(SITE);
  const panel = page.getByTestId("request-key");
  const submit = panel.getByTestId("request-key-submit");
  await hydrated(submit);
  await expect(panel.getByTestId("request-key-hint")).toHaveText("Write keys can change content through the API. Most sites only need read.");
  await expect(panel.getByLabel("Scope")).toHaveValue("read");
  await expect(submit).toBeDisabled(); // two environments, no default: a choice is required
  await panel.getByLabel("Environment").selectOption({ label: "production" });

  await submit.click();
  const msg = panel.getByTestId("request-key-message");
  await expect(msg).toContainText("Request filed. Someone else must approve it before the key is created.");
  await expect(msg.getByRole("link", { name: "View the request" })).toHaveAttribute("href", "/approvals/ap-0001-key");
  let approvals = (await stub.state()).approvals;
  expect(approvals.map((a) => [a.id, a.workflowId, a.status])).toEqual([["ap-0001-key", "key.mint", "pending"]]);
  expect(approvals[0].toolArgs).toMatchObject({ envId: PROD_ENV, scope: "read", siteId: "site-gaiada-com", tenantSlug: "gaiada" });

  // the same environment and scope again is the SAME request, not a second one
  await submit.click();
  await expect(msg).toContainText("Already requested: a request for this environment and scope is waiting for approval.");
  await expect(msg.getByRole("link", { name: "View the request" })).toHaveAttribute("href", "/approvals/ap-0001-key");
  expect((await stub.state()).approvals).toHaveLength(1);

  // write is a different request
  await panel.getByLabel("Scope").selectOption("write");
  await submit.click();
  await expect(msg).toContainText("Request filed.");
  await expect(msg.getByRole("link", { name: "View the request" })).toHaveAttribute("href", "/approvals/ap-0002-key");
  approvals = (await stub.state()).approvals;
  expect(approvals).toHaveLength(2);
  expect(JSON.stringify(approvals)).not.toContain("wdk_"); // nothing was minted at filing
});

test("API keys: a user who cannot promote (plain member) sees no control at all", async ({ page, context }) => {
  await loginAs(page, context, "gede@gaiada.com");
  await page.goto(SITE);
  await expect(page.getByTestId("collections")).toBeVisible();
  await expect(page.getByTestId("request-key")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "API keys" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /API key/ })).toHaveCount(0);
});

test("API keys: the requester cannot approve their own request", async ({ page }) => {
  await stub.post("request-key", { envId: PROD_ENV, scope: "read", by: "demo-hansel" }); // filed by the logged-in user
  await page.goto("/approvals/ap-0001-key");
  await expect(page.getByTestId("key-own-request")).toContainText("someone else has to approve it");
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
});

test("STATE key.mint approved: labelled an API-key request (not a publish), and the key is shown ONCE, in exactly one response, never again", async ({ page, context }) => {
  await stub.post("request-key", { envId: PROD_ENV, scope: "read", by: "dept-manager" }); // filed by someone else (maker != checker)

  // Record EVERY response body from here on.
  const reads: Promise<{ url: string; method: string; action: boolean; body: string }>[] = [];
  page.on("response", (r) => {
    reads.push(r.text().then(
      (body) => ({ url: r.url(), method: r.request().method(), action: !!r.request().headers()["next-action"], body }),
      () => ({ url: r.url(), method: r.request().method(), action: false, body: "" }),
    ));
  });

  await page.goto("/approvals/ap-0001-key");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Mint a production read API key for gaiada");
  await expect(page.getByText("API key request").first()).toBeVisible();
  await expect(page.getByText("Website publish")).toHaveCount(0);
  await expect(page.getByTestId("webdesk-summary")).toHaveCount(0); // not the publish summary
  await expect(page.getByTestId("key-summary-env")).toHaveText("production");
  await expect(page.getByTestId("key-summary-scope")).toHaveText("read");

  const approve = page.getByRole("button", { name: "Approve" });
  await hydrated(approve);
  await approve.click();

  const panel = page.getByTestId("key-once");
  await expect(panel).toBeVisible();
  const key = await panel.getByTestId("key-once-value").inputValue();
  expect(key).toMatch(/^wdk_read_[0-9a-f]{48}$/);
  await expect(panel.getByTestId("key-once-value")).toHaveJSProperty("readOnly", true);
  await expect(panel.getByTestId("key-once-env")).toHaveText("production");
  await expect(panel.getByTestId("key-once-scope")).toHaveText("read");
  await expect(page.getByTestId("key-once-warning")).toHaveText("Copy this key now. It won't be shown again: WebDesk keeps only a fingerprint of it.");
  await expect(panel.getByRole("button", { name: "Copy" })).toBeVisible();

  // The revalidation that follows re-rendered the page from the decided row; the panel (client state) is still there,
  // and the row is decided (no second Approve).
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  const row = (await stub.state()).approvals.find((a) => a.id === "ap-0001-key")!;
  expect([row.status, (row as unknown as { executionStatus: string }).executionStatus]).toEqual(["approved", "executed"]);
  expect(JSON.stringify(await stub.state())).not.toContain(key); // not in the stub's store either

  // Client-side navigation away and back (the router cache), then a reload, then a fresh visit from elsewhere.
  await page.getByRole("link", { name: "Approvals", exact: true }).first().click();
  await expect(page).toHaveURL(/\/approvals$/);
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Mint a production read API key");
  await expect(page.getByTestId("key-once")).toHaveCount(0);
  expect(await page.content()).not.toContain(key);

  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Mint a production read API key");
  await expect(page.getByTestId("key-once")).toHaveCount(0);
  expect(await page.content()).not.toContain(key);

  await page.goto(SITE);
  await expect(page.getByTestId("collections")).toBeVisible();
  await page.goto("/approvals/ap-0001-key");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Mint a production read API key");
  await expect(page.getByTestId("key-once")).toHaveCount(0);
  expect(await page.content()).not.toContain(key);

  // Custody: no storage, cookie or URL ever held it.
  expect(page.url()).not.toContain(key);
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, h: history.state }));
  expect(stored).not.toContain(key);
  expect(JSON.stringify(await context.cookies())).not.toContain(key);

  // THE claim: across every response the browser received, the key occurs in exactly ONE — the server action's.
  const all = await Promise.all(reads);
  expect(all.length).toBeGreaterThan(5); // the recorder was actually recording (pages, RSC payloads, the action)
  const carriers = all.filter((x) => x.body.includes(key));
  expect(carriers.map((c) => `${c.method} action=${c.action}`)).toEqual(["POST action=true"]);
});

test("STATE key.mint approved but the mint FAILED: the typed error in plain words, and no key field", async ({ page }) => {
  await stub.config({ keyMintFails: true });
  await stub.post("request-key", { envId: STG_ENV, scope: "write", by: "dept-manager" });
  await page.goto("/approvals/ap-0001-key");
  const approve = page.getByRole("button", { name: "Approve" });
  await hydrated(approve);
  await approve.click();
  await expect(page.getByTestId("key-failed")).toContainText("The key wasn't created. WebDesk couldn't be reached. Nothing was sent.");
  await expect(page.getByTestId("key-once")).toHaveCount(0);
  await expect(page.getByLabel("API key")).toHaveCount(0);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WSK-43c — the media library: the Media tab and the picker for media fields
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const MEDIA = `${DEPT}/website/media/gaiada/site-gaiada-com`;
const BANNER = `${SITE}/banner/banner.home?locale=en`;
const SITE_ORIGIN = `http://localhost:${process.env.WD_E2E_APP_PORT || 3006}`;

/** A real, decodable PNG of w x h (so the thumbnail genuinely renders, and the fake WebDesk reads w/h from its header). */
function makePng(w: number, h: number, extra = ""): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x7a)]);
  const idat = zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)), Buffer.from(extra, "latin1")]);
}
const pngFile = (name = "hero.png", w = 16, h = 9, extra = "") => ({ name, mimeType: "image/png", buffer: makePng(w, h, extra) });

async function openMedia(page: Page, url = MEDIA) {
  await page.goto(url);
  await hydrated(page.getByTestId("media-library"));
}
const upload = (page: Page, ...files: { name: string; mimeType: string; buffer: Buffer }[]) => page.getByTestId("media-file-input").setInputFiles(files);
const axe = async (page: Page, include: string) =>
  (await new AxeBuilder({ page }).include(include).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations;
const seedMedia = async (o: Record<string, unknown>) => ((await stub.post("seed-media", o)) as { assetId: string }).assetId;

test("the Website group has a Media tab next to Content; a library with nothing in it says it is empty", async ({ page }) => {
  await page.goto(DEPT);
  await page.getByRole("navigation", { name: "Department sections" }).getByRole("link", { name: "Website" }).click();
  // the group's own tab strip ("Website tools"): Content and Media
  const tabs = page.getByRole("navigation", { name: "Website tools" });
  await expect(tabs.getByRole("link", { name: "Content" })).toBeVisible();
  await tabs.getByRole("link", { name: "Media" }).click();
  await expect(page).toHaveURL(/\/website\/media\/gaiada\/site-gaiada-com$/); // one site: straight in, as Content does
  await expect(page.getByTestId("media-empty")).toContainText("library is empty");
  await expect(page.getByTestId("media-upload")).toBeEnabled();
});

test("STATE media unavailable / forbidden: a notice with no grid and no 'empty' claim, on the Media tab", async ({ page }) => {
  await stub.config({ unavailable: true });
  await page.goto(MEDIA);
  await expect(page.getByTestId("wd-editorial-unavailable")).toContainText("Editing is unavailable");
  await expect(page.getByTestId("media-library")).toHaveCount(0);
  await expect(page.getByTestId("media-empty")).toHaveCount(0);
  await stub.config({ unavailable: false, forbidden: true });
  await page.goto(MEDIA);
  await expect(main(page)).toContainText("You don't have access");
  await expect(page.getByTestId("media-grid")).toHaveCount(0);
});

test("upload one image, see it in the grid, set its alt text, pick it into an item's media field, save: the stub receives exactly the expected media value", async ({ page }) => {
  await openMedia(page);
  const file = pngFile("hero.png", 16, 9);
  await upload(page, file);

  // the grid shows it, its row says it uploaded, and the new asset is selected with its detail open
  const tile = page.getByTestId("media-tile").first();
  await expect(tile).toBeVisible();
  await expect(page.getByTestId("media-uploads")).toContainText("Uploaded");
  await expect(tile).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("media-detail-title")).toHaveText("hero.png");
  // a thumbnail genuinely rendered (the fake WebDesk served the bytes)
  await expect.poll(() => tile.locator("img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(16);

  // what the FAKE WEBDESK received: the raw file, its own Content-Type and filename, from the ERP's origin, on a token minted for it
  const s1 = await stub.state();
  expect(s1.uploadLog).toEqual([{ token: "redacted", contentType: "image/png", filename: "hero.png", size: file.buffer.length, origin: SITE_ORIGIN }]);
  expect(s1.mediaLog.filter((m) => m.op === "uploadToken")).toEqual([{ op: "uploadToken", bucket: "media", by: "demo-hansel" }]);
  expect(s1.media).toHaveLength(1);
  expect(s1.media[0]).toMatchObject({ mime: "image/png", width: 16, height: 9, originalFilename: "hero.png", createdBy: "demo-hansel" });
  const assetId = s1.media[0].assetId;
  await expect(page.getByTestId("media-uploader")).toHaveText(/\S/);

  // alt text, per locale (the tenant's locales: en and id), a title and tags
  await page.getByTestId("media-alt-en").fill("A tiny test image");
  await page.getByTestId("media-alt-id").fill("Gambar uji kecil");
  await page.getByLabel("Title").fill("Hero banner");
  await page.getByLabel("Tags").fill("Hero, Test");
  await page.getByTestId("media-save").click();
  await expect(page.getByTestId("media-notice")).toHaveText("Saved Hero banner.");
  await expect(page.getByTestId("media-save")).toBeDisabled();
  const s2 = await stub.state();
  expect(s2.media[0]).toMatchObject({ title: "Hero banner", alt: { en: "A tiny test image", id: "Gambar uji kecil" }, tags: ["hero", "test"] });
  expect(s2.mediaLog.filter((m) => m.op === "update")).toEqual([{ op: "update", assetId, keys: ["title", "alt", "tags"], by: "demo-hansel" }]);
  await expect(page.getByTestId("media-url")).toHaveValue(`/v1/t/gaiada/media/${assetId}`);

  // pick it into the banner's media fields (the editor is in English)
  await open(page, BANNER);
  await page.getByRole("button", { name: /Choose from library: Hero image/ }).click();
  const dlg = page.getByTestId("media-picker");
  await expect(dlg).toBeVisible();
  await dlg.getByTestId("media-tile").first().click();
  await expect(dlg.getByTestId("media-detail-title")).toHaveText("Hero banner");
  await dlg.getByTestId("media-use").click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator(P("hero/url"))).toHaveValue(`/v1/t/gaiada/media/${assetId}`);
  await expect(page.locator(P("hero/alt"))).toHaveValue("A tiny test image");

  // and APPEND to the multiple field, then save the item
  await page.getByRole("button", { name: /Add from library: Gallery/ }).click();
  await page.getByTestId("media-picker").getByTestId("media-tile").first().click();
  await page.getByTestId("media-use").click();
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved v2");

  const banner = await stub.item("itm-banner-en");
  const picked = { url: `/v1/t/gaiada/media/${assetId}`, alt: "A tiny test image", width: 16, height: 9, mime: "image/png" };
  expect(banner.versions.at(-1)!.props).toEqual({ title: "Home banner", hero: picked, gallery: [picked] });

  // the Media tab now says where it is used
  await openMedia(page);
  await page.getByTestId("media-tile").first().click();
  await expect(page.getByTestId("media-usage-list")).toContainText("banner / banner.home (en)");
  await expect(page.getByTestId("media-usage-list").getByRole("link")).toHaveAttribute("href", `${SITE}/banner/banner.home?locale=en`);
});

test("picking in the Indonesian editor writes the Indonesian alt", async ({ page }) => {
  const id = await seedMedia({ title: "Villa", alt: { en: "A villa", id: "Sebuah vila" }, width: 800, height: 600, mime: "image/png", originalFilename: "villa.png" });
  await open(page, BANNER);
  await page.getByTestId("create-locale-id").click();
  await expect(page).toHaveURL(/locale=id/);
  await hydrated(page.getByTestId("item-editor"));
  await page.getByRole("button", { name: /Choose from library: Hero image/ }).click();
  await page.getByTestId("media-picker").getByTestId("media-tile").first().click();
  await page.getByTestId("media-use").click();
  await expect(page.locator(P("hero/alt"))).toHaveValue("Sebuah vila");
  await expect(page.locator(P("hero/url"))).toHaveValue(`/v1/t/gaiada/media/${id}`);
});

test("uploading from inside the picker selects the new asset, ready to use", async ({ page }) => {
  await open(page, BANNER);
  await page.getByRole("button", { name: /Choose from library: Hero image/ }).click();
  const dlg = page.getByTestId("media-picker");
  await expect(dlg.getByTestId("media-empty")).toBeVisible();
  await dlg.getByTestId("media-file-input").setInputFiles(pngFile("inline.png", 8, 8));
  await expect(dlg.getByTestId("media-tile").first()).toHaveAttribute("aria-selected", "true");
  await dlg.getByTestId("media-use").click();
  const id = (await stub.state()).media[0].assetId;
  await expect(page.locator(P("hero/url"))).toHaveValue(`/v1/t/gaiada/media/${id}`);
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved v2");
  expect((await stub.item("itm-banner-en")).versions.at(-1)!.props!.hero).toEqual({ url: `/v1/t/gaiada/media/${id}`, width: 8, height: 8, mime: "image/png" });
});

test("manual URL entry still works beside the picker", async ({ page }) => {
  await open(page, BANNER);
  await page.locator(P("hero/url")).fill("https://cdn.example/manual.png");
  await page.locator(P("hero/alt")).fill("typed by hand");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved v2");
  expect((await stub.item("itm-banner-en")).versions.at(-1)!.props!.hero).toEqual({ url: "https://cdn.example/manual.png", alt: "typed by hand" });
});

// ── the upload refusals, in plain words ─────────────────────────────────────────────────────────────

test("STATE uploads not enabled (the ERP's origin is not on WebDesk's upload allow-list): the specific copy, nothing added, and a retry mints a fresh token", async ({ page }) => {
  await stub.config({ uploadCors: false });
  await openMedia(page);
  await upload(page, pngFile("blocked.png"));
  const row = page.getByTestId("media-upload-failed");
  await expect(row).toContainText("Uploads aren't enabled for this site yet.");
  await expect(row).toContainText("WEBDESK_UPLOAD_CORS_ORIGINS");
  await expect(page.getByTestId("media-tile")).toHaveCount(0);
  expect((await stub.state()).media).toHaveLength(0);
  await stub.config({ uploadCors: true });
  await page.getByRole("button", { name: "Retry blocked.png" }).click();
  await expect(page.getByTestId("media-tile")).toHaveCount(1);
  const s = await stub.state();
  expect(s.mediaLog.filter((m) => m.op === "uploadToken")).toHaveLength(2); // a FRESH token for the retry
  expect(s.media).toHaveLength(1);
});

test("STATE uploads not enabled (WebDesk's public URL is not configured on the platform): the same words, with the operator's fix", async ({ page }) => {
  await stub.config({ publicUrlNotConfigured: true });
  await openMedia(page);
  await upload(page, pngFile());
  await expect(page.getByTestId("media-upload-failed")).toContainText("Uploads aren't enabled for this site yet.");
  await expect(page.getByTestId("media-upload-failed")).toContainText("WEBDESK_PUBLIC_BASE_URL");
  expect((await stub.state()).uploadLog).toHaveLength(0); // nothing was sent
});

test("STATE refusals: too large and type not allowed are caught before any bytes leave; an infected file is refused by WebDesk's scan; a retry mints a fresh token", async ({ page }) => {
  await stub.config({ mediaMaxBytes: 100 }); // a flat 64x64 PNG deflates to ~150 bytes
  await openMedia(page);
  await upload(page, pngFile("big.png", 64, 64), { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  const rows = page.getByTestId("media-upload-failed");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("too large");
  await expect(rows.nth(0)).toContainText("The limit is 100 B.");
  await expect(rows.nth(1)).toContainText("That file type isn't allowed.");
  expect((await stub.state()).uploadLog).toHaveLength(0);

  await stub.config({ mediaMaxBytes: 1024 * 1024 });
  await upload(page, pngFile("virus.png", 8, 8, "EICAR-STANDARD-ANTIVIRUS-TEST-FILE"));
  const infected = page.locator('[data-testid="media-upload-failed"][data-kind="infected"]');
  await expect(infected).toContainText("virus scan refused this file");
  await expect(infected).toContainText("not added to the library");
  expect((await stub.state()).media).toHaveLength(0);
  await page.getByRole("button", { name: "Retry virus.png" }).click();
  await expect.poll(async () => (await stub.state()).uploadLog.length).toBe(2); // the retry reached WebDesk with a new token
  await expect(infected).toHaveCount(1);
  const tokens = (await stub.state()).mediaLog.filter((m) => m.op === "uploadToken");
  expect(tokens.length).toBe(4); // big.png, notes.txt, virus.png, and the retry: one token per attempt
});

test("STATE refusal: WebDesk's scanner being down is not the file's fault, and says to try again", async ({ page }) => {
  await stub.config({ scanUnavailable: true });
  await openMedia(page);
  await upload(page, pngFile());
  await expect(page.getByTestId("media-upload-failed")).toContainText("couldn't scan this file right now");
});

test("STATE read-only: a viewer browses the library, Upload is refused with a reason once tried, and Save and Delete say why they don't work", async ({ page, context }) => {
  const id = await seedMedia({ title: "Villa", mime: "image/png", originalFilename: "villa.png" });
  await loginAs(page, context, "gede@gaiada.com");
  await openMedia(page);
  await expect(page.getByTestId("media-tile")).toHaveCount(1);
  await upload(page, pngFile());
  await expect(page.getByTestId("media-upload-failed")).toContainText("You can't upload to this library.");
  await expect(page.getByTestId("media-upload")).toBeDisabled();
  await expect(page.getByTestId("media-upload-why")).toContainText("You can browse the library but not add to it");
  await page.getByTestId("media-tile").first().click();
  await page.getByLabel("Title").fill("A viewer's edit");
  await page.getByTestId("media-save").click();
  await expect(page.getByTestId("media-readonly")).toContainText("You can browse the library but not edit assets");
  await expect(page.getByLabel("Title")).not.toBeEditable();
  await expect(page.getByLabel("Title")).toHaveValue("A viewer's edit"); // kept
  await page.getByTestId("media-delete").click();
  await page.getByTestId("media-delete-confirm").click();
  await expect(page.getByTestId("media-delete-failed")).toContainText("needs a Web Dev publisher");
  expect((await stub.state()).media.find((m) => m.assetId === id)).toMatchObject({ title: "Villa", deletedAt: null });
});

test("STATE stale: a failed refresh keeps the grid and says so; Try again recovers", async ({ page }) => {
  await seedMedia({ title: "Villa", mime: "image/png", originalFilename: "villa.png" });
  await openMedia(page);
  await expect(page.getByTestId("media-tile")).toHaveCount(1);
  await stub.config({ unavailable: true });
  await page.getByTestId("media-q").fill("vil");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("media-stale")).toContainText("Couldn't update the list");
  await expect(page.getByTestId("media-tile")).toHaveCount(1);
  await stub.config({ unavailable: false });
  await page.getByTestId("media-stale-retry").click();
  await expect(page.getByTestId("media-stale")).toHaveCount(0);
});

test("filters (search, tag, type) and cursor paging", async ({ page }) => {
  for (let i = 1; i <= 50; i++) {
    await seedMedia({ title: `Photo ${String(i).padStart(2, "0")}`, tags: i % 2 ? ["odd"] : ["even"], mime: "image/png", originalFilename: `p${i}.png`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() });
  }
  await seedMedia({ title: "Brochure", mime: "application/pdf", originalFilename: "brochure.pdf", tags: ["print"] });
  await openMedia(page);
  await expect(page.getByTestId("media-tile")).toHaveCount(48);
  await page.getByTestId("media-more").click();
  await expect(page.getByTestId("media-tile")).toHaveCount(51);
  await expect(page.getByTestId("media-more")).toHaveCount(0);
  await page.getByTestId("media-type").selectOption("application/pdf");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("media-tile")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear" }).click();
  await page.getByTestId("media-tag").fill("even");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("media-tile")).toHaveCount(25);
  await page.getByTestId("media-q").fill("no such thing");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("media-empty")).toContainText("No media matches these filters.");
});

// ── delete ────────────────────────────────────────────────────────────────────────────────────────

test("delete: an unused asset is deleted after a confirm; one that content uses is refused with the items that use it (never just 'failed')", async ({ page }) => {
  const used = await seedMedia({ title: "Used", mime: "image/png", originalFilename: "used.png" });
  const spare = await seedMedia({ title: "Spare", mime: "image/png", originalFilename: "spare.png", createdAt: new Date(Date.now() - 60_000).toISOString() });
  await stub.post("concurrent-save", { itemId: "itm-banner-en", fields: { hero: { url: `/v1/t/gaiada/media/${used}` } } });
  await openMedia(page);

  await page.locator(`[data-asset-id="${used}"]`).click();
  await page.getByTestId("media-delete").click();
  await expect(page.getByTestId("media-delete-dialog")).toContainText("Delete this file?");
  await page.getByTestId("media-delete-confirm").click();
  await expect(page.getByTestId("media-in-use")).toContainText("is used by 1 item");
  await expect(page.getByTestId("media-in-use-list")).toContainText("banner / banner.home (en)");
  await expect(page.getByTestId("media-in-use-list").getByRole("link")).toHaveAttribute("href", `${SITE}/banner/banner.home?locale=en`);
  await expect(page.getByTestId("media-delete-failed")).toHaveCount(0);
  await page.getByTestId("media-delete-close").click();
  await expect(page.getByTestId("media-tile")).toHaveCount(2); // still there

  await page.locator(`[data-asset-id="${spare}"]`).click();
  await page.getByTestId("media-delete").click();
  await page.getByTestId("media-delete-confirm").click();
  await expect(page.getByTestId("media-tile")).toHaveCount(1);
  await expect(page.getByTestId("media-notice")).toContainText("Deleted. WebDesk keeps the stored file until");
  const s = await stub.state();
  expect(s.media.find((m) => m.assetId === spare)!.deletedAt).not.toBeNull();
  expect(s.media.find((m) => m.assetId === used)!.deletedAt).toBeNull();
});

test("an unconfirmed save (502 webdesk_ambiguous) is not 'saved' and not 'failed': Retry re-sends the same change", async ({ page }) => {
  await seedMedia({ title: "Villa", mime: "image/png", originalFilename: "villa.png" });
  await openMedia(page);
  await page.getByTestId("media-tile").first().click();
  await page.getByLabel("Title").fill("Renamed");
  await stub.config({ ambiguousMediaWrite: "land" });
  await page.getByTestId("media-save").click();
  await expect(page.getByTestId("media-save-problem")).toContainText("couldn't confirm the save");
  await stub.config({ ambiguousMediaWrite: null });
  await page.getByTestId("media-save-retry").click();
  await expect(page.getByTestId("media-notice")).toHaveText("Saved Renamed.");
});

// ── keyboard and accessibility ─────────────────────────────────────────────────────────────────────

test("keyboard: the grid is one tab stop with arrow-key movement, Enter selects, and the picker dialog traps focus and gives it back", async ({ page }) => {
  for (let i = 1; i <= 4; i++) await seedMedia({ title: `Photo ${i}`, mime: "image/png", originalFilename: `p${i}.png`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() });
  await openMedia(page);
  const tiles = page.getByTestId("media-tile");
  await expect(tiles).toHaveCount(4);
  await tiles.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(tiles.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(tiles.nth(3)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tiles.first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tiles.first()).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("media-detail")).toBeVisible();

  // the picker: focus stays inside, Escape closes, focus returns to the button that opened it
  await open(page, BANNER);
  const opener = page.getByRole("button", { name: /Choose from library: Hero image/ });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dlg = page.getByTestId("media-picker");
  await expect(dlg.getByTestId("media-tile")).toHaveCount(4);
  // modal: Tab cycles through the dialog (and the browser's own chrome, where activeElement reads as <body>), and never lands on
  // anything of the page behind it
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => { const el = document.activeElement; return el === document.body || !!el?.closest("dialog"); })).toBe(true);
  }
  await expect(dlg).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("the upload control works without drag and drop, and progress is announced politely (never assertive, never role=log)", async ({ page }) => {
  await openMedia(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload files" }).click();
  await (await chooser).setFiles([pngFile("kbd.png")]);
  await expect(page.getByTestId("media-tile")).toHaveCount(1);
  const status = page.getByTestId("media-upload-status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveText("kbd.png uploaded.");
  // scoped to the library: the shell's own assistant drawer is a role=log of its own
  await expect(page.getByTestId("media-library").locator('[aria-live="assertive"], [role="log"]')).toHaveCount(0);
});

test("axe: the Media tab (with an asset selected and an upload row) has no violations", async ({ page }) => {
  await seedMedia({ title: "Villa", alt: { en: "A villa" }, tags: ["hero"], mime: "image/png", originalFilename: "villa.png", width: 800, height: 600 });
  await openMedia(page);
  await upload(page, pngFile("axe.png"));
  await expect(page.getByTestId("media-tile")).toHaveCount(2);
  await expect(page.getByTestId("media-usage")).toContainText("Not used by any item");
  expect(await axe(page, '[data-testid="media-library"]')).toEqual([]);
  // and with a refusal on screen
  await stub.config({ uploadCors: false });
  await upload(page, pngFile("axe2.png"));
  await expect(page.getByTestId("media-upload-failed")).toBeVisible();
  expect(await axe(page, '[data-testid="media-library"]')).toEqual([]);
});

test("axe: the picker dialog has no violations (empty, then with an asset selected)", async ({ page }) => {
  await open(page, BANNER);
  await page.getByRole("button", { name: /Choose from library: Hero image/ }).click();
  const dlg = page.getByTestId("media-picker");
  await expect(dlg.getByTestId("media-empty")).toBeVisible();
  expect(await axe(page, '[data-testid="media-picker"]')).toEqual([]);
  await dlg.getByTestId("media-file-input").setInputFiles(pngFile("axe.png"));
  await expect(dlg.getByTestId("media-tile")).toHaveCount(1);
  await expect(dlg.getByTestId("media-use")).toBeVisible();
  expect(await axe(page, '[data-testid="media-picker"]')).toEqual([]);
});
