import AxeBuilder from "@axe-core/playwright";
import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { tenantCookie } from "./appCookies";

// M5-W2e — the writers' room UI, against the STUBBED review BFF (e2e/webdesk-stub/editorial.mjs, run by playwright.webdesk.config.ts,
// no real service). The headline drive: open an item that is in review -> see its state and the actions `allowed` gives -> request
// changes with a note -> see the new state. Around it: a viewer (no actions, with the reason), an `allowed` that did not arrive, a
// typed refusal in words, the board (counts withheld), the people page (publisher tier is the BFF's answer) and the list's review state.
// The app runs NOT in demo mode, so the real `platformFetch`, server components and server actions are under test.

const STUB = `http://127.0.0.1:${process.env.WD_STUB_PORT || 3991}`;
const DEPT = "/departments/dept-1";
const SITE = `${DEPT}/website/content/gaiada/site-gaiada-com`;
const IN_REVIEW = `${SITE}/service/service.local-seo?locale=en`; // seeded: in review, submitted v1, one open comment on the H1
const APPROVED = `${SITE}/service/service.web-design?locale=en`; // seeded: approved v1
const WRITERS = `${DEPT}/website/writers`;
const LOCAL_SEO = "itm-service-local-seo-en";

type ReviewSnap = Record<string, { state: string; submittedVersion: number | null; approvedVersion: number | null; events: { kind: string; note: string | null; actorSub: string }[]; comments: { id: string; body: string; anchor: string | null; resolved: boolean }[] }>;
const stub = {
  post: async (cmd: string, body: unknown = {}) => {
    const r = await fetch(`${STUB}/__stub/${cmd}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as unknown;
  },
  reset: () => stub.post("reset"),
  config: (c: Record<string, unknown>) => stub.post("config", c),
  review: async () => ((await (await fetch(`${STUB}/__stub/state`, { method: "POST" })).json()) as { review: ReviewSnap }).review,
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
  await hydrated(page.getByTestId("editorial-panel"));
}
const panel = (page: Page) => page.getByTestId("editorial-panel");
const ACTIONS = ["act-submit", "act-withdraw", "act-request-changes", "act-seo-signoff", "act-approve", "act-assign"];
async function shownActions(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const id of ACTIONS) if ((await page.getByTestId(id).count()) > 0) out.push(id);
  return out.sort();
}

test.beforeEach(async ({ page, context }) => {
  await stub.reset();
  await loginAs(page, context, "hansel@gaiada.com");
});

// ── the headline drive ──────────────────────────────────────────────────────────────────────────────

test("an item in review: its state, who has it, and the actions `allowed` gives; request changes moves it to 'Changes requested'", async ({ page }) => {
  await openEditor(page, IN_REVIEW);

  // the state, in words, and the facts
  await expect(page.getByTestId("review-state")).toContainText("In review");
  await expect(page.getByTestId("review-state")).toHaveAttribute("data-state", "in_review");
  await expect(page.getByTestId("review-sentence")).toContainText("waiting for a reviewer");
  await expect(page.getByTestId("review-submitted")).toContainText("v1");
  await expect(page.getByTestId("review-approved")).toHaveText("not approved");

  // exactly the actions `allowed` and the state give: no "Submit" while it is in review
  expect(await shownActions(page)).toEqual(["act-approve", "act-assign", "act-request-changes", "act-seo-signoff", "act-withdraw"]);
  await expect(page.getByTestId("act-approve")).toHaveText("Approve v1");

  // its open comment, anchored to a field
  await expect(page.getByTestId("comment")).toHaveCount(1);
  await expect(page.getByTestId("comment")).toContainText("Can the H1 name the city?");
  await expect(page.getByTestId("comment-anchor")).toContainText("About: h1");

  // request changes needs a note
  await page.getByTestId("act-request-changes").click();
  await expect(page.getByTestId("rc-send")).toBeDisabled();
  await page.getByTestId("rc-note").fill("Name the city in the H1 and add the hotel angle.");
  await expect(page.getByTestId("rc-send")).toBeEnabled();
  await page.getByTestId("rc-send").click();

  // the new state, in words, and the buttons it now allows
  await expect(page.getByTestId("review-done")).toContainText("Changes requested");
  await expect(page.getByTestId("review-state")).toContainText("Changes requested");
  await expect(page.getByTestId("review-state")).toHaveAttribute("data-state", "changes_requested");
  await expect(page.getByTestId("act-submit")).toHaveText("Send for review again");
  expect(await shownActions(page)).toEqual(["act-assign", "act-submit"]);
  await expect(page.getByTestId("review-log")).toContainText("requested changes");

  // and it really reached the (stub) BFF, with the note
  const snap = (await stub.review())[LOCAL_SEO];
  expect(snap.state).toBe("changes_requested");
  expect(snap.events.at(-1)).toMatchObject({ kind: "review.changes_requested", note: "Name the city in the H1 and add the hotel angle." });

  // it survives a reload: the state is read from the BFF, not remembered by the page
  await openEditor(page, IN_REVIEW);
  await expect(page.getByTestId("review-state")).toHaveAttribute("data-state", "changes_requested");
});

test("approving the item moves it to Approved, and a comment can be added and resolved", async ({ page }) => {
  await openEditor(page, IN_REVIEW);
  await page.getByTestId("comment-body").fill("Looks right to me.");
  await page.getByTestId("comment-add").click();
  await expect(page.getByTestId("review-done")).toContainText("Comment added.");
  await expect(page.getByTestId("comment")).toHaveCount(2);

  await page.getByTestId("comment-resolve").first().click();
  await expect(page.getByTestId("review-done")).toContainText("Comment resolved.");
  await expect(page.locator('[data-testid="comment"][data-resolved="true"]')).toHaveCount(1);

  await page.getByTestId("act-approve").click();
  await expect(page.getByTestId("review-state")).toHaveAttribute("data-state", "approved");
  await expect(page.getByTestId("review-approved")).toContainText("v1");
  expect(await shownActions(page)).toEqual(["act-assign"]);
  expect((await stub.review())[LOCAL_SEO]).toMatchObject({ state: "approved", approvedVersion: 1 });
});

// ── allowed drives the buttons, not a role ──────────────────────────────────────────────────────────

test("a read-only member sees the state and the comments, no actions, and is told why", async ({ page, context }) => {
  await loginAs(page, context, "gede@gaiada.com"); // plain member: the stub's `allowed` is read-only
  await openEditor(page, IN_REVIEW);
  await expect(page.getByTestId("review-state")).toHaveAttribute("data-state", "in_review");
  await expect(page.getByTestId("comment")).toHaveCount(1);
  expect(await shownActions(page)).toEqual([]);
  await expect(page.getByTestId("comment-form")).toHaveCount(0);
  await expect(page.getByTestId("review-why")).toContainText("no review action available to you");
});

test("when `allowed` does not arrive the panel offers nothing and says the permission check did not answer", async ({ page }) => {
  await stub.config({ reviewAllowedAbsent: true });
  await openEditor(page, IN_REVIEW);
  await expect(page.getByTestId("review-state")).toHaveAttribute("data-state", "in_review");
  expect(await shownActions(page)).toEqual([]);
  await expect(page.getByTestId("comment-form")).toHaveCount(0);
  await expect(page.getByTestId("review-why")).toContainText("permission check for this item did not answer");
});

test("a typed refusal is shown in plain words, with no slug and no status code, and nothing moves", async ({ page }) => {
  await openEditor(page, IN_REVIEW);
  await stub.config({ reviewRefuse: "review-not-enabled" }); // the next command is refused (one-shot), changing nothing
  await page.getByTestId("act-approve").click();
  const refusal = page.getByTestId("review-refusal");
  await expect(refusal).toContainText("Review is not turned on for this collection");
  await expect(refusal).toContainText("Nothing was changed");
  await expect(refusal).not.toContainText("review-not-enabled");
  await expect(refusal).not.toContainText("409");
  await expect(page.getByTestId("review-state")).toHaveAttribute("data-state", "in_review");
  expect((await stub.review())[LOCAL_SEO].state).toBe("in_review");
});

test("review switched off for the collection: the panel offers nothing and says why", async ({ page }) => {
  await stub.config({ reviewOff: true });
  await openEditor(page, IN_REVIEW);
  expect(await shownActions(page)).toEqual([]);
  await expect(page.getByTestId("review-why")).toContainText("Review is not turned on for this collection");
  await expect(page.getByTestId("comment-form")).toHaveCount(0);
});

test("a version that moved on is a plain-words refusal, and the panel re-reads", async ({ page }) => {
  await openEditor(page, `${SITE}/service/service.seo?locale=en`); // seeded: changes requested, head v3
  await expect(page.getByTestId("review-state")).toHaveAttribute("data-state", "changes_requested");
  // somebody saves v4 meanwhile, so this page's v3 is no longer the head
  await stub.post("concurrent-save", { itemId: "itm-service-seo-en", fields: { h1: "Theirs, saved meanwhile" }, by: "dept-manager" });
  await page.getByTestId("act-submit").click();
  const refusal = page.getByTestId("review-refusal");
  await expect(refusal).toContainText("no longer the one in review");
  await expect(refusal).not.toContainText("review-version-mismatch");
  await expect(refusal).not.toContainText("409");
  await expect(page.getByTestId("review-state")).toHaveAttribute("data-state", "changes_requested"); // nothing moved
  expect((await stub.review())["itm-service-seo-en"].state).toBe("changes_requested");
});

// ── the list, the board, the people page ────────────────────────────────────────────────────────────

test("the item list shows each item's review state and filters by it", async ({ page }) => {
  await page.goto(`${SITE}/service`);
  const table = page.getByTestId("items-table");
  await expect(table.locator("tr", { hasText: "service.local-seo" }).getByTestId("row-review-state")).toHaveAttribute("data-state", "in_review");
  await expect(table.locator("tr", { hasText: "service.web-design" }).getByTestId("row-review-state")).toHaveAttribute("data-state", "approved");
  await page.getByTestId("filter-review").selectOption("in_review");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/review=in_review/);
  await expect(page.getByTestId("items-table")).toContainText("service.local-seo");
  await expect(page.getByTestId("items-table")).not.toContainText("service.web-design");
  // the server filtered the whole collection: no "this page only" caveat, and the filter survives paging links
  await expect(page.getByTestId("review-filter-note")).toHaveCount(0);
  await expect(page.getByTestId("filter-review")).toHaveValue("in_review");
});

test("the Writers' room tab opens the board, grouped by state with the site's counts; withheld counts are said in words", async ({ page }) => {
  await page.goto(DEPT);
  await page.getByRole("navigation", { name: "Department sections" }).getByRole("link", { name: "Website" }).click();
  await page.goto(WRITERS);
  await expect(page).toHaveURL(/\/website\/writers\/gaiada\/site-gaiada-com$/); // one site: straight in
  await expect(page.getByTestId("writers-board")).toBeVisible();
  await expect(page.getByTestId("col-in_review").getByTestId("board-card")).toHaveCount(1);
  await expect(page.getByTestId("col-approved").getByTestId("board-card")).toHaveCount(1);
  await expect(page.getByTestId("col-changes_requested").getByTestId("board-card")).toHaveCount(1);
  await expect(page.getByTestId("count-in_review")).toHaveText("In review: 1");
  await page.getByTestId("col-in_review").getByRole("link", { name: /Local SEO/ }).click();
  await expect(page.getByTestId("review-state")).toHaveAttribute("data-state", "in_review");

  await stub.config({ reviewCountsWithheld: true });
  await page.goto(`${WRITERS}/gaiada/site-gaiada-com`);
  await expect(page.getByTestId("counts-withheld")).toContainText("Counts are hidden for your access");
  await expect(page.getByTestId("board-counts")).toHaveCount(0);
  await expect(page.getByTestId("col-count-in_review")).toHaveText("1"); // what is on screen, never "0 of N"
});

test("the people page: a publisher sees who holds roles; a read-only member gets the plain 'you can't manage writers here'", async ({ page, context }) => {
  await page.goto(`${WRITERS}/people`);
  await expect(page).toHaveURL(/\/website\/writers\/people\/gaiada\/site-gaiada-com$/);
  await expect(page.getByTestId("grants-table")).toContainText("Writer");
  await expect(page.getByTestId("grant-form")).toBeVisible();

  await loginAs(page, context, "gede@gaiada.com");
  await page.goto(`${WRITERS}/people/gaiada/site-gaiada-com`);
  await expect(page.getByTestId("people-forbidden")).toContainText("You can't manage writers here");
  await expect(page.getByTestId("grants-manager")).toHaveCount(0);
  await expect(page.getByTestId("grant-form")).toHaveCount(0);
});

test("a11y: the editor with its review panel and the board have no serious axe violations", async ({ page }) => {
  await openEditor(page, IN_REVIEW);
  const editor = await new AxeBuilder({ page }).include('[data-testid="editorial-panel"]').analyze();
  expect(editor.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  await page.goto(`${WRITERS}/gaiada/site-gaiada-com`);
  await expect(page.getByTestId("writers-board")).toBeVisible();
  const board = await new AxeBuilder({ page }).include('[data-testid="writers-board"]').analyze();
  expect(board.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});
