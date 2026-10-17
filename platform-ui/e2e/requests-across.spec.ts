import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { DEMO_DEPT_EMAILS } from "./personas";
import { tenantCookie } from "./appCookies";

// DW-10e-3 (BFF §60, DW-D35, DW-D39 to DW-D41): requests across group companies, end to end under DEMO_MODE (src/lib/demoRequests.ts).
//
// A member of Viceroy (a hospitality company, NOT agency-pack) asks the agency's Creatives for assets through the route the owner ruled
// (DW-D39), sees the request in My requests naming the agency and its department, and follows an engineering request's PRICE STATE in words.
// The agency's Creatives then sees it in Incoming naming Viceroy, its department and the client the work is billed to, and has no Cancel on it.
// A Viceroy member who is neither the sender nor a manager or administrator does not see it (DW-D40).
//
// Same setup as workspace-personas.spec.ts: every test signs in as its own demo identity and plants the tenant cookie itself (`/api/me` gives
// every demo identity all three companies, and a fresh session lands on the first, the holding), so NO stored session. Facts it rests on:
//   - resort-staff@gaiada.com is u-resort (Ni Luh Sekar), a plain `member` of Viceroy (`co-resort`), placed in Front Office. THE SENDER.
//   - viceroy-marketing@gaiada.com is demo-viceroy-marketing (Made Sari), another plain `member` of Viceroy. NOT the sender.
//   - creative@gaiada.com is u-creative (Putu Rani), a `member` of the agency (`co-agency`), placed in Creatives (`dept-2`).
//   - The demo routes (DW-D39): Viceroy and the holding each have two, to the agency's Creatives (assets) and Web Dev (engineering).
//   - The demo store seeds, for Viceroy: u-resort's "DEMO Booking page: a new rooms section", an engineering request whose price agreement is
//     waiting for Viceroy's signature, and Made Sari's "DEMO Poolside signage".
//   - The store is module state in the dev server, so each run sends under a unique title and the assertions name that title.
test.describe.configure({ mode: "serial" });

async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function press(loc: Locator) {
  await expect(loc).toBeVisible();
  await hydrated(loc);
  await loc.click();
}

async function signIn(page: Page, context: BrowserContext, email: string, tenant: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await context.addCookies([tenantCookie(page.url(), tenant)]);
}
const asSender = (page: Page, context: BrowserContext) => signIn(page, context, DEMO_DEPT_EMAILS.resort, "co-resort");
const asColleague = (page: Page, context: BrowserContext) => signIn(page, context, "viceroy-marketing@gaiada.com", "co-resort");
const asCreatives = (page: Page, context: BrowserContext) => signIn(page, context, DEMO_DEPT_EMAILS.creative, "co-agency");

// Next streams a hidden copy of each resolved chunk at the end of <body> before React moves it into place, so every locator is scoped to the page.
const main = (page: Page) => page.locator("#main-content");
const STAMP = String(Date.now());
const ASSETS_TITLE = `DEMO e2e banners ${STAMP}`;
const ENGINEERING_TITLE = `DEMO e2e booking tweak ${STAMP}`;
const SEEDED_ENGINEERING = "DEMO Booking page: a new rooms section";
const COLLEAGUES_SEEDED = "DEMO Poolside signage";

/** A number with a currency, either side: the sender's pages must never hold one (DW-D41). */
const CURRENCY = /(?:rp\.?|idr|usd|eur|\$|€|£)\s?\d|\d[\d.,]*\s?(?:rp|idr|usd|eur|rupiah|\$|€|£)/i;

test.describe("Requests across group companies (DW-10e-3)", () => {
  test("a Viceroy member asks the agency's Creatives for assets, and sees it in My requests naming the agency and its department", async ({ page, context }) => {
    await asSender(page, context);
    await page.goto("/requests/new");
    // The chooser lists the routes the company HAS, "To <unit> · <company>", whatever its pack. Viceroy has no Creatives of its own to ask.
    const toCreatives = main(page).getByRole("link", { name: "To Creatives · Gaia Digital Agency", exact: true });
    await expect(toCreatives).toBeVisible();
    await expect(main(page).getByRole("link", { name: "To Web Dev · Gaia Digital Agency", exact: true })).toBeVisible();
    await expect(main(page).getByRole("link", { name: "Ask Creatives for assets", exact: true })).toHaveCount(0);
    await toCreatives.click();

    // The form for the route: where it goes, that it is client work, and no campaign picker.
    await expect(page).toHaveURL(/\/requests\/new\?route=/);
    const form = main(page).getByRole("form", { name: "New request" });
    await expect(form).toBeVisible();
    await expect(form.getByText("Creatives · Gaia Digital Agency", { exact: true })).toBeVisible();
    await expect(form.getByText(/This is client work: Gaia Digital Agency bills Viceroy for it as a client/)).toBeVisible();
    await expect(form.getByLabel(/^Campaign/)).toHaveCount(0);

    await form.locator('input[name="title"]').fill(ASSETS_TITLE);
    await form.locator('select[name="d-format-0"]').selectOption("image");
    await press(form.getByRole("button", { name: "Send request", exact: true }));

    // Success opens the sender's own page: the receiving company and department, and no amount.
    await expect(page).toHaveURL(/\/requests\/outbound\/[^/]+$/);
    await expect(main(page).getByRole("heading", { level: 1, name: ASSETS_TITLE, exact: true })).toBeVisible();
    await expect(main(page).getByText("Creatives · Gaia Digital Agency", { exact: true })).toBeVisible();
    // DW-10e-5: the row is labelled "Sent to", so its value does not say "To" again.
    await expect(main(page).getByText("To Creatives · Gaia Digital Agency", { exact: true })).toHaveCount(0);
    await expect(main(page).getByText("Nothing has been delivered yet.")).toBeVisible();
    expect((await main(page).textContent()) ?? "").not.toMatch(CURRENCY);

    // My requests: in scope own for a member, the row names the company and the department and opens the sender's page.
    await page.goto("/requests");
    const row = main(page).getByRole("link", { name: ASSETS_TITLE, exact: true });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("href", /^\/requests\/outbound\//);
    await expect(main(page).getByText("To Creatives · Gaia Digital Agency", { exact: true }).first()).toBeVisible();
    await expect(main(page).getByRole("heading", { name: /^Requests you sent/ })).toBeVisible();
    await expect(main(page).getByText(/Only the requests you sent to other companies are shown/)).toBeVisible();
  });

  test("an engineering request through the Web Dev route reads its price state in words, never an amount", async ({ page, context }) => {
    await asSender(page, context);
    await page.goto("/requests/new");
    await main(page).getByRole("link", { name: "To Web Dev · Gaia Digital Agency", exact: true }).click();
    const form = main(page).getByRole("form", { name: "New request" });
    await expect(form).toBeVisible();
    await form.locator('input[name="title"]').fill(ENGINEERING_TITLE);
    await form.locator('select[name="engKind"]').selectOption("content");
    await press(form.getByRole("button", { name: "Send request", exact: true }));

    await expect(page).toHaveURL(/\/requests\/outbound\/[^/]+$/);
    await expect(main(page).getByRole("heading", { level: 1, name: ENGINEERING_TITLE, exact: true })).toBeVisible();
    const price = main(page).locator("section", { has: page.getByRole("heading", { name: "Price", exact: true }) });
    await expect(price.getByText("Not assessed yet", { exact: true })).toBeVisible();

    // The seeded one is waiting for Viceroy's signature: from My requests, in words.
    await page.goto("/requests");
    await main(page).getByRole("link", { name: SEEDED_ENGINEERING, exact: true }).click();
    await expect(page).toHaveURL(/\/requests\/outbound\/wr-across-2$/);
    const seeded = main(page).locator("section", { has: page.getByRole("heading", { name: "Price", exact: true }) });
    await expect(seeded.getByText("Waiting for Viceroy's signature in Gaia Digital Agency's client portal", { exact: true })).toBeVisible();
    expect((await main(page).textContent()) ?? "").not.toMatch(CURRENCY);
    // A live price agreement holds the request: no Cancel is offered (the server would answer 409 price_agreement_open).
    await expect(main(page).getByRole("button", { name: "Cancel request", exact: true })).toHaveCount(0);
  });

  test("the sender can cancel their own open asset request", async ({ page, context }) => {
    await asSender(page, context);
    await page.goto("/requests");
    await main(page).getByRole("link", { name: ASSETS_TITLE, exact: true }).click();
    await expect(page).toHaveURL(/\/requests\/outbound\/[^/]+$/);
    await press(main(page).getByRole("button", { name: "Cancel request", exact: true }));
    await press(main(page).getByRole("button", { name: "Yes, cancel it", exact: true }));
    // Cancelled: the page re-reads and Cancel is gone.
    await expect(main(page).getByRole("button", { name: "Cancel request", exact: true })).toHaveCount(0);
    await expect(main(page).getByText("Cancelled", { exact: true }).first()).toBeVisible();
  });

  test("the agency's Creatives sees a request from Viceroy in Incoming, naming Viceroy, its department and the client, with no Cancel", async ({ page, context }) => {
    // Send a fresh one first (the previous test cancelled the first).
    await asSender(page, context);
    const title = `DEMO e2e incoming ${STAMP}`;
    await page.goto("/requests/new");
    await main(page).getByRole("link", { name: "To Creatives · Gaia Digital Agency", exact: true }).click();
    const form = main(page).getByRole("form", { name: "New request" });
    await expect(form).toBeVisible();
    await form.locator('input[name="title"]').fill(title);
    await form.locator('select[name="d-format-0"]').selectOption("image");
    await press(form.getByRole("button", { name: "Send request", exact: true }));
    await expect(page).toHaveURL(/\/requests\/outbound\/[^/]+$/);

    await context.clearCookies();
    await asCreatives(page, context);
    await page.goto("/departments/dept-2/requests");
    const incoming = main(page).getByRole("link", { name: title, exact: true });
    await expect(incoming).toBeVisible();
    // The row names the company and its department under From, and the client the work is billed to.
    await expect(main(page).getByText("Viceroy · Front Office", { exact: true }).first()).toBeVisible();
    await expect(main(page).getByText("Billed to Viceroy", { exact: true }).first()).toBeVisible();

    await incoming.click();
    await expect(page).toHaveURL(/\/requests\/(?!outbound)[^/]+$/);
    await expect(main(page).getByText("Viceroy · Front Office to Creatives", { exact: true })).toBeVisible();
    await expect(main(page).getByText("Requesting company", { exact: true })).toBeVisible();
    await expect(main(page).getByText("Billed to client", { exact: true })).toBeVisible();
    // The receiving side declines; it does not cancel (409 requester_side_only).
    await expect(main(page).getByRole("button", { name: "Cancel request", exact: true })).toHaveCount(0);
  });

  test("a Viceroy member who did not send it, and is neither a manager nor an administrator, does not see it", async ({ page, context }) => {
    await asColleague(page, context);
    await page.goto("/requests");
    // Positive first: their own request is there, in scope own, so an empty result below cannot be a page that failed to load.
    await expect(main(page).getByRole("link", { name: COLLEAGUES_SEEDED, exact: true })).toBeVisible();
    await expect(main(page).getByRole("heading", { name: /^Requests you sent/ })).toBeVisible();
    await expect(main(page).getByRole("link", { name: ASSETS_TITLE, exact: true })).toHaveCount(0);
    await expect(main(page).getByRole("link", { name: SEEDED_ENGINEERING, exact: true })).toHaveCount(0);
    // And by id, another person's request is absent, never an oracle.
    await page.goto("/requests/outbound/wr-across-1");
    await expect(page.getByRole("heading", { name: /page not found/i })).toBeVisible();
    await expect(main(page).getByText("DEMO Reception banners for the spring offer")).toHaveCount(0);
  });
});
