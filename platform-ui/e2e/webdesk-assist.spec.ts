import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { tenantCookie } from "./appCookies";

// M5-W6 — the editor's AI assist drawer, against the STUBBED assist BFF (e2e/webdesk-stub/assist.mjs, run by playwright.webdesk.config.ts,
// no real service and no AI). The headline drive: open an item -> Assist -> meta description -> Apply -> the field changed and the editor
// says "Unsaved changes" -> NO save request reached the BFF (the stub counts every other write). Around it: a read-only member is not
// offered the drawer, a typed refusal is said in words, and the translated draft is labelled and Copy-only from the English item.
// The app runs NOT in demo mode, so the real `platformFetch`, server components and server actions are under test.

const STUB = `http://127.0.0.1:${process.env.WD_STUB_PORT || 3991}`;
const SITE = "/departments/dept-1/website/content/gaiada/site-gaiada-com";
const ITEM = `${SITE}/service/service.local-seo?locale=en`; // seeded: EN, v1, SEO title "Local SEO Bali", no SEO description
const ITEM_ID = "itm-service-local-seo-en";
const META = "We help hotels and villas in Bali rank for local searches and win more direct bookings without paying any agent commission.";

type StubState = {
  items: { itemId: string; headVersion: number; versions: { n: number; seo?: Record<string, unknown> }[] }[];
  assist: { calls: { itemId: string; kind: string; version: number | null }[]; writes: string[] };
};
const stub = {
  post: async (cmd: string, body: unknown = {}) => {
    const r = await fetch(`${STUB}/__stub/${cmd}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as unknown;
  },
  reset: () => stub.post("reset"),
  config: (c: Record<string, unknown>) => stub.post("config", c),
  state: async () => (await stub.post("state")) as StubState,
};

async function loginAs(page: Page, context: BrowserContext, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/");
  await context.addCookies([tenantCookie(page.url())]);
}

// The gate runs the BUILT app: server HTML is interactive-looking before React has hydrated, and a click in that gap is lost. A
// hydrated DOM node carries a `__reactProps$…` key, so "ready" means that key exists (no test hook in shipped code).
async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function openEditor(page: Page, url: string) {
  await page.goto(url);
  await hydrated(page.getByTestId("item-editor"));
}
async function openAssist(page: Page) {
  const toggle = page.getByTestId("assist-toggle");
  await hydrated(toggle);
  await toggle.click();
  await expect(page.getByTestId("assist-panel")).toBeVisible();
}

test.beforeEach(async ({ page, context }) => {
  await stub.reset();
  await loginAs(page, context, "hansel@gaiada.com");
});

test("Assist -> meta description -> Apply: the field changes, the editor says 'Unsaved changes', and nothing is saved", async ({ page }) => {
  await openEditor(page, ITEM);
  const desc = page.locator("#wc-seo-desc");
  await expect(desc).toHaveValue("");
  await expect(page.getByTestId("save-status")).toHaveText("No changes");

  await openAssist(page);
  await page.getByTestId("assist-run-meta_description").click();

  // the suggestion is shown, and NOT applied by itself
  await expect(page.getByTestId("suggestion-text")).toHaveText(META);
  await expect(desc).toHaveValue("");
  await expect(page.getByTestId("save-status")).toHaveText("No changes");

  // Apply: the field changes, as an unsaved edit
  await page.getByTestId("apply-s1").click();
  await expect(desc).toHaveValue(META);
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  await expect(page.getByTestId("applied-s1")).toContainText("Not saved yet");
  await expect(page.getByTestId("save")).toBeEnabled(); // the normal Save is what saves it

  // the BFF saw exactly one assist call and NO other write: nothing was saved, published or requested
  const st = await stub.state();
  expect(st.assist.calls).toEqual([{ itemId: ITEM_ID, kind: "meta_description", version: null }]);
  expect(st.assist.writes).toEqual([]);
  const item = st.items.find((i) => i.itemId === ITEM_ID)!;
  expect(item.versions).toHaveLength(1);
  expect(item.versions[0].seo?.description).toBeUndefined();
});

test("the normal Save then keeps it, and only then does the BFF see a write", async ({ page }) => {
  await openEditor(page, ITEM);
  await openAssist(page);
  await page.getByTestId("assist-run-meta_description").click();
  await page.getByTestId("apply-s1").click();
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  expect((await stub.state()).assist.writes).toEqual([]);

  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-status")).toContainText("Saved v2");
  const st = await stub.state();
  expect(st.assist.writes).toEqual([`PUT /items/${ITEM_ID}`]); // the one write is the user's own Save
  const item = st.items.find((i) => i.itemId === ITEM_ID)!;
  expect(item.versions.at(-1)?.seo?.description).toBe(META);
});

test("a member without update rights is not offered the drawer", async ({ page, context }) => {
  await loginAs(page, context, "gede@gaiada.com"); // the stub's read-only member: `allowed.update` is false
  await openEditor(page, ITEM);
  await expect(page.getByTestId("save-status")).toBeVisible();
  await expect(page.getByTestId("assist-drawer")).toHaveCount(0);
});

test("a typed refusal is said in words, and nothing changes", async ({ page }) => {
  await stub.config({ assistRefuse: "budget" });
  await openEditor(page, ITEM);
  await openAssist(page);
  await page.getByTestId("assist-run-meta_description").click();
  await expect(page.getByTestId("assist-error")).toContainText("You have used today's AI suggestions");
  await expect(page.getByTestId("assist-error")).toContainText("resets at 00:00 UTC (in about 2 hours)");
  await expect(page.getByTestId("assist-results")).toHaveCount(0);
  await expect(page.getByTestId("save-status")).toHaveText("No changes");

  // the next call is served (the refusal was one-shot), and an unavailable service is the agreed sentence
  await stub.config({ assistRefuse: "unavailable" });
  await page.getByTestId("assist-run-faq").click();
  await expect(page.getByTestId("assist-error")).toContainText("The writing assistant is not available right now");
});

test("the translated first draft is labelled 'First draft — needs a human' and is Copy-only from the English item", async ({ page }) => {
  await openEditor(page, ITEM);
  await openAssist(page);
  await page.getByTestId("assist-run-translate_draft").click();
  await expect(page.getByTestId("assist-notice")).toHaveText("First draft — needs a human");
  await expect(page.getByTestId("first-draft-s1")).toHaveText("First draft — needs a human");
  await expect(page.getByTestId("suggestion-text")).toHaveText("SEO Lokal Bali");
  await expect(page.getByTestId("apply-s1")).toHaveCount(0);
  await expect(page.getByTestId("apply-why-s1")).toContainText("separate item");
  await expect(page.getByTestId("copy-s1")).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveText("No changes");
});
