import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./settledPage";
import type { Page } from "@playwright/test";

// SCP-2 (BFF §63.9, plan SCP-2g) — the client's post approval page, end to end, as the demo client contact (`dana@northwind.example` is `demo-client`, a
// contact of Northwind Traders), in DEMO_MODE on the production build. Its own project (`portal-social`) with NO stored session: every test signs in itself,
// because a stale staff session would test the staff shell and not the portal.
//
// ORDER-DEPENDENT (the project runs it on one worker, in file order). The demo store (lib/demoSocialPipeline.ts) is module state in the Next server, so a decision made by one test is what the next
// one finds. The file is written as one story and must be run against a FRESH server (`retries: 0`, like the other store-driven projects):
//   1. axe, light and dark, at desktop and at 390 px, over every state that has nothing to decide (read only): the page, the grid, the approved tab, a
//      post's own page, the story viewer and the Ask-for-changes dialog open;
//   2. the page and the way in (`?post=`, through the sign-in);
//   3. the stories circle;
//   4. Approve, Undo, Approve again; the double-tap shortcut;
//   5. Ask for changes (design, a note, a pin);
//   6. Approve all;
//   7. the Grid preview and Approved tabs, a post's own page, and the 404 for a post that is not theirs.
// Northwind's waiting posts in the demo are "Five ways to style a scarf" (a carousel), "Weekend market date moved" (a feed post), "Studio tour in 30
// seconds" (a reel) and "Last call for the market stall" (a story). A post is found by its title, never by an id.
//
// DETERMINISM: no sleeps. Every wait is on state (a role, a text, a URL, a focus, a count). A click on a client component waits for the page to hydrate
// first (React's own marker on the element), or it would be dropped.

async function signInAsClient(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dana@northwind.example");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/portal");
}

/** True once React has attached to the first element matching `selector`: a click before that is dropped. */
async function hydrated(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(
    (s) => { const el = document.querySelector(s); return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$")); },
    selector,
  );
}

const WAITING = ["Five ways to style a scarf", "Weekend market date moved", "Studio tour in 30 seconds", "Last call for the market stall"];
const card = (page: Page, title: string) => page.getByRole("article", { name: title });
const toast = (page: Page, text: string | RegExp) => page.getByRole("region", { name: "Notifications" }).getByRole("status").filter({ hasText: text });
const toApprove = (page: Page) => page.getByRole("list", { name: "Where your posts stand" }).getByRole("link", { name: /To approve/ });
async function openList(page: Page, path = "/portal/social"): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1, name: "Social posts" })).toBeVisible();
  await hydrated(page, "#ps-list-h"); // a host element of the page's client tree: always there, even when the list is empty
}
/** The id of a post's card (read from the page, so no spec depends on how the demo numbers its posts). */
async function postId(page: Page, title: string): Promise<string> {
  const id = await card(page, title).getAttribute("data-post-id");
  if (!id) throw new Error(`no card for ${title}`);
  return id;
}

async function runAxe(page: Page) {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
}
async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  const { violations } = await runAxe(page);
  const found = violations.map((v) => `${label} [${v.impact}] ${v.id} (${v.nodes.length}): ${v.help}\n${v.nodes.slice(0, 3).map((n) => `      - ${n.target.join(" ")}`).join("\n")}`);
  expect(found, found.join("\n")).toEqual([]);
}
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

// ── 1 · axe, in both themes and at both widths (read only: nothing here decides anything) ──────────────────────────────────────
for (const scheme of ["light", "dark"] as const) {
  for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["390 px", { width: 390, height: 844 }]] as const) {
    test.describe(`axe: the approval page, ${scheme}, ${name}`, () => {
      test.use({ colorScheme: scheme, viewport });

      test("the page, the grid, the approved tab and a post's own page have no violations", async ({ page }) => {
        test.setTimeout(180_000);
        await signInAsClient(page);
        await openList(page);
        await expect(card(page, WAITING[0])).toBeVisible();
        await expectNoAxeViolations(page, `/portal/social ${scheme} ${name}`);
        if (viewport.width < 500) expect(await noHorizontalScroll(page), "no horizontal scroll at 390 px").toBe(true);
        const id = await postId(page, WAITING[0]);

        await page.goto("/portal/social?tab=grid");
        await expect(page.getByRole("heading", { name: /^Grid preview/ })).toBeVisible();
        await expectNoAxeViolations(page, `grid ${scheme} ${name}`);
        if (viewport.width < 500) expect(await noHorizontalScroll(page), "no horizontal scroll at 390 px (grid)").toBe(true);

        await page.goto("/portal/social?tab=approved");
        await expect(page.getByRole("heading", { name: /^Approved/ })).toBeVisible();
        await expectNoAxeViolations(page, `approved ${scheme} ${name}`);

        await page.goto(`/portal/social/${id}`);
        await expect(page.getByRole("heading", { level: 1, name: "Review this post" })).toBeVisible();
        await expectNoAxeViolations(page, `post page ${scheme} ${name}`);
        if (viewport.width < 500) expect(await noHorizontalScroll(page), "no horizontal scroll at 390 px (post)").toBe(true);
      });

      test("the story viewer and the Ask-for-changes dialog, open, have no violations", async ({ page }) => {
        test.setTimeout(180_000);
        await signInAsClient(page);
        await openList(page);
        await page.getByRole("button", { name: /open the story "Last call for the market stall"/ }).click();
        const viewer = page.getByRole("dialog", { name: "Story: Last call for the market stall" });
        await expect(viewer).toBeVisible();
        await expectNoAxeViolations(page, `story viewer ${scheme} ${name}`);
        await viewer.getByRole("button", { name: "Close the story" }).click();
        await expect(viewer).toBeHidden();

        await card(page, WAITING[1]).getByRole("button", { name: /^Ask for changes to / }).click();
        const dialog = page.getByRole("dialog", { name: "Ask for changes" });
        await expect(dialog).toBeVisible();
        await expectNoAxeViolations(page, `change dialog ${scheme} ${name}`);
        if (viewport.width < 500) expect(await noHorizontalScroll(page), "no horizontal scroll at 390 px (dialog)").toBe(true);
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await expect(dialog).toBeHidden();
      });
    });
  }
}

// ── 2 · the page, and the way in ───────────────────────────────────────────────────────────────────────────────────────────────
test.describe("the approval page", () => {
  test("shows the counts, the filters, the stories circle, the tabs and a card per waiting post, each in the network's own look", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsClient(page);
    await openList(page);

    // the header: the count of what waits is the number of cards, and the other two counts are there
    const counts = page.getByRole("list", { name: "Where your posts stand" });
    await expect(counts).toContainText("To approve");
    await expect(counts).toContainText("Approved");
    await expect(counts).toContainText("Changes asked");
    await expect(page.getByRole("article")).toHaveCount(WAITING.length);
    await expect(toApprove(page)).toContainText(String(WAITING.length));
    // the month switcher (the client filter is for a contact of more than one client: the demo's overview lists one, so it is not here)
    const filters = page.getByRole("form", { name: "Choose the month and the client" });
    await expect(filters.getByLabel("Month")).toBeVisible();
    await expect(filters.getByLabel("Client")).toHaveCount(0);
    // the tabs are links, reachable by keyboard
    const tabs = page.getByRole("navigation", { name: "Post groups" });
    await expect(tabs.getByRole("link", { name: "To review" })).toHaveAttribute("aria-current", "page");
    await expect(tabs.getByRole("link", { name: "Grid preview" })).toHaveAttribute("href", /tab=grid/);
    await expect(tabs.getByRole("link", { name: "Approved" })).toHaveAttribute("href", /tab=approved/);

    // the stories circle: one ring for the waiting story
    await expect(page.getByRole("region", { name: "Stories" }).getByRole("button", { name: /open the story "Last call for the market stall", waiting for you/ })).toBeVisible();

    // each card looks like the network: handle, picture, caption with hashtags, date and placement; a reel and a story in a 9:16 frame
    const scarf = card(page, "Five ways to style a scarf");
    await expect(scarf.locator(".ps-handle")).toHaveText("@northwindtraders");
    await expect(scarf).toContainText("Carousel");
    await expect(scarf).toContainText("#northwind");
    await expect(scarf.locator(".ps-media--carousel")).toBeVisible();
    await expect(card(page, "Studio tour in 30 seconds").locator(".ps-media--reel")).toBeVisible();
    await expect(card(page, "Last call for the market stall").locator(".ps-media--story")).toBeVisible();
    await expect(card(page, "Weekend market date moved").locator(".ps-media--feed")).toBeVisible();
    // a team comment written for the client, with its pin on the picture (a pin is a button on the image)
    await expect(scarf).toContainText("Slide 2 shows the new moss colour");
    await expect(scarf.getByRole("button", { name: /^Pin 1:/ })).toBeAttached();
    // never a staff status, a check or the internal note
    await expect(page.getByText(/Internal:/)).toHaveCount(0);

    // the pictures come from the portal's file route and are lazy; the first one (on screen) really loads
    const first = card(page, WAITING[0]).locator("img.scp-pinbox__img").first();
    await expect(first).toHaveAttribute("loading", "lazy");
    await expect(first).toHaveAttribute("src", /\/api\/[^/]+\/portal\/files\/[^/]+-f1$/);
    await expect.poll(() => first.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  });

  test("the month filter narrows the list; another client lists nothing", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsClient(page);
    await page.goto("/portal/social?month=2026-01");
    await expect(page.getByRole("heading", { name: /^Waiting for you \(0\)/ })).toBeVisible();
    await expect(page.getByText(/Nothing is waiting for your approval/)).toBeVisible();
    await page.goto("/portal/social?clientId=cl-harbour");
    await expect(page.getByRole("heading", { name: /^Waiting for you \(0\)/ })).toBeVisible();
  });

  test("the way in: /portal/social?post=<id> opens the page scrolled to that post with its card focused", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsClient(page);
    await openList(page);
    const id = await postId(page, "Weekend market date moved");
    await page.goto(`/portal/social?post=${id}`);
    await expect(card(page, "Weekend market date moved")).toBeFocused();
    await expect(card(page, "Weekend market date moved")).toBeInViewport();
    // a link to a post that is not theirs is a plain note above their own list
    await page.goto("/portal/social?post=someone-elses-post");
    await expect(page.getByText(/That post is not available to you/)).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(WAITING.length);
  });

  test("the way in passes through the sign-in and comes back to the exact link, query included", async ({ page, context }) => {
    test.setTimeout(120_000);
    await signInAsClient(page);
    await openList(page);
    const id = await postId(page, "Weekend market date moved");
    await context.clearCookies(); // the visitor arrives from WhatsApp with no session
    await page.goto(`/portal/social?post=${id}`);
    await expect(page).toHaveURL(/\/login\?return=/);
    await page.getByLabel("Email").fill("dana@northwind.example");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((u) => u.pathname === "/portal/social" && u.searchParams.get("post") === id);
    await hydrated(page, "#ps-list-h"); // a host element of the page's client tree: always there, even when the list is empty
    await expect(card(page, "Weekend market date moved")).toBeFocused();
  });
});

// ── 3 · the stories circle ─────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("the stories circle", () => {
  test("a ring opens the story full-screen with the same controls; Escape closes it and gives focus back to the ring", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsClient(page);
    await openList(page);
    const ring = page.getByRole("button", { name: /open the story "Last call for the market stall"/ });
    await ring.focus();
    await ring.press("Enter");
    const viewer = page.getByRole("dialog", { name: "Story: Last call for the market stall" });
    await expect(viewer).toBeVisible();
    await expect(viewer).toBeFocused();
    await expect(viewer.getByRole("button", { name: /^Approve the story / })).toBeVisible();
    await expect(viewer.getByRole("button", { name: /^Ask for changes to the story / })).toBeVisible();
    await expect(viewer.locator(".ps-media--story")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(ring).toBeFocused();
  });
});

// ── 4 · Approve, Undo, Approve again; the double-tap shortcut ──────────────────────────────────────────────────────────────────
test.describe("deciding", () => {
  test("Approve, then Undo inside the window, then Approve again", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsClient(page);
    await openList(page);
    const title = "Weekend market date moved";
    await expect(card(page, title)).toBeVisible();

    await card(page, title).getByRole("button", { name: `Approve ${title}` }).click();
    await expect(toast(page, `Approved "${title}".`)).toBeVisible();
    await expect(card(page, title)).toHaveCount(0); // it moved tabs
    await expect(page.getByRole("article")).toHaveCount(WAITING.length - 1);
    await expect(toApprove(page)).toContainText(String(WAITING.length - 1));

    await toast(page, `Approved "${title}".`).getByRole("button", { name: "Undo" }).click();
    await expect(toast(page, "Undone. The post is back with you.")).toBeVisible();
    await expect(card(page, title)).toBeVisible(); // back in To review
    await expect(page.getByRole("article")).toHaveCount(WAITING.length);

    await card(page, title).getByRole("button", { name: `Approve ${title}` }).click();
    await expect(toast(page, `Approved "${title}".`)).toBeVisible();
    await expect(card(page, title)).toHaveCount(0);
  });

  test("double-tap on the picture is a shortcut for Approve, once, and Undo puts it back", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsClient(page);
    await openList(page);
    const title = "Studio tour in 30 seconds";
    // the visible button is the main control: it is there whether or not anyone knows the shortcut
    await expect(card(page, title).getByRole("button", { name: `Approve ${title}` })).toBeVisible();
    await card(page, title).locator(".ps-media").dblclick();
    await expect(toast(page, `Approved "${title}".`)).toBeVisible();
    await expect(page.getByRole("region", { name: "Notifications" }).getByText(`Approved "${title}".`)).toHaveCount(1); // one decision, not two
    await expect(card(page, title)).toHaveCount(0);
    await toast(page, `Approved "${title}".`).getByRole("button", { name: "Undo" }).click();
    await expect(card(page, title)).toBeVisible();
  });
});

// ── 5 · Ask for changes ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("asking for changes", () => {
  test("a design change needs a kind and a note; the pin is optional; the post leaves To review and says what was asked", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsClient(page);
    await openList(page);
    const title = "Studio tour in 30 seconds";
    const trigger = card(page, title).getByRole("button", { name: `Ask for changes to ${title}` });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Ask for changes" });
    await expect(dialog).toBeVisible();

    // nothing chosen: the kind is asked for, in words, and nothing is sent
    await dialog.getByRole("button", { name: "Send changes" }).click();
    await expect(dialog.getByText("Choose whether the change is to the text or to the design.")).toBeVisible();
    await dialog.getByRole("radio", { name: /The design/ }).check();
    await dialog.getByRole("button", { name: "Send changes" }).click();
    await expect(dialog.getByText("Write a note so we know what to change.")).toBeVisible();
    await expect(dialog.getByLabel(/What should we change\?/)).toBeFocused();

    await dialog.getByLabel(/What should we change\?/).fill("Make the product larger and move the logo to the top corner.");
    await dialog.getByRole("button", { name: "Place a pin" }).click();
    await dialog.locator(".scp-pinbox__place").click({ position: { x: 60, y: 90 } });
    await expect(dialog.getByRole("button", { name: "Move the pin" })).toBeVisible();
    await dialog.getByRole("button", { name: "Send changes" }).click();

    await expect(dialog).toBeHidden();
    await expect(toast(page, `Asked for changes to "${title}".`)).toBeVisible();
    await expect(card(page, title)).toHaveCount(0);
    await expect(page.getByRole("article")).toHaveCount(WAITING.length - 2); // the market post was approved above
  });
});

// ── 6 · Approve all ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("approve all", () => {
  test("asks first, approves exactly what waits, and offers one Undo for the batch", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsClient(page);
    await openList(page);
    const waiting = await page.getByRole("article").count();
    expect(waiting).toBe(2); // the scarf and the story
    await page.getByRole("button", { name: `Approve all ${waiting}` }).click();
    const confirm = page.getByRole("group", { name: "Confirm approving all" });
    await expect(confirm).toContainText(`Approve all ${waiting} posts shown here`);
    await expect(page.getByRole("article")).toHaveCount(waiting); // nothing was sent yet
    await confirm.getByRole("button", { name: `Yes, approve all ${waiting}` }).click();

    await expect(toast(page, `Approved ${waiting} posts.`)).toBeVisible();
    await expect(toast(page, `Approved ${waiting} posts.`).getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Waiting for you \(0\)/ })).toBeVisible();
    await expect(page.getByText(/Nothing is waiting for your approval/)).toBeVisible();
    await expect(toApprove(page)).toContainText("0");
  });
});

// ── 7 · the Grid preview and Approved tabs, a post's own page, and a post that is not theirs ───────────────────────────────────
test.describe("after the decisions", () => {
  test("Approved lists what was decided, with how; a decision recorded by our team says so and names no one", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsClient(page);
    await openList(page);
    const tabs = page.getByRole("navigation", { name: "Post groups" });
    const approved = tabs.getByRole("link", { name: "Approved" });
    await approved.focus();
    await approved.press("Enter"); // a link, reachable and operable by keyboard
    await expect(page).toHaveURL(/tab=approved/);
    await expect(page.getByRole("heading", { name: /^Approved/ })).toBeVisible();
    for (const title of ["Weekend market date moved", "Five ways to style a scarf", "Last call for the market stall"]) {
      await expect(card(page, title)).toContainText("Approved by Dana Whitfield");
    }
    const recorded = card(page, "Meet the packing team");
    await expect(recorded).toContainText("Recorded by our team on your behalf (via WhatsApp)");
    await expect(recorded).not.toContainText(/Komang|Dewi|Citra/);
    await expect(page.getByRole("button", { name: /^Approve / })).toHaveCount(0); // nothing is decided here
    await expect(page.getByRole("link", { name: /View the published post/ }).first()).toHaveAttribute("href", /^https:\/\//);
  });

  test("the Grid preview is three columns by date, with the planned posts marked, and opens a post's own page", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsClient(page);
    await page.goto("/portal/social?tab=grid");
    await expect(page.getByRole("heading", { name: /^Grid preview/ })).toBeVisible();
    const grid = page.locator("ul.ps-grid");
    await expect(grid).toBeVisible();
    expect(await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBe(3);
    // planned posts carry a word, a published one does not
    await expect(grid.getByRole("link", { name: /Weekend market date moved/ })).toContainText("Planned");
    await expect(grid.getByRole("link", { name: /Studio tour in 30 seconds/ })).toContainText("Changes asked");
    await expect(grid.getByRole("link", { name: /Harvest collection arrives/ })).not.toContainText(/Planned|To approve|Changes asked/);

    await grid.getByRole("link", { name: /Studio tour in 30 seconds/ }).click();
    await expect(page).toHaveURL(/\/portal\/social\/[^/?]+$/);
    await expect(page.getByRole("heading", { level: 1, name: "Review this post" })).toBeVisible();
    const post = page.getByRole("article", { name: "Studio tour in 30 seconds" });
    await expect(post).toContainText("Design changes asked by Dana Whitfield");
    await expect(post).toContainText("Make the product larger and move the logo to the top corner.");
    await expect(post).toContainText("You pinned the spot on the picture.");
    await expect(post.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "All social posts" })).toHaveAttribute("href", "/portal/social");
  });

  test("a post the contact cannot see is a 404 page", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsClient(page);
    const res = await page.goto("/portal/social/someone-elses-post");
    expect(res?.status()).toBe(404);
    await expect(page.getByText("Page not found")).toBeVisible();
  });

  test("the portal menu row says Social posts and opens this page; the older post reviews keep their URL", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsClient(page);
    await page.getByRole("navigation", { name: "Portal sections" }).getByRole("link", { name: /^Projects/ }).click();
    await page.getByRole("navigation", { name: "Projects pages" }).getByRole("link", { name: "Social posts" }).click();
    await expect(page).toHaveURL(/\/portal\/social$/);
    await expect(page.getByRole("heading", { level: 1, name: "Social posts" })).toBeVisible();
    await page.goto("/portal/social-reviews");
    await expect(page.getByRole("heading", { level: 1, name: "Post reviews" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Projects pages" }).getByRole("link", { name: "Social posts" })).toHaveAttribute("aria-current", "page");
  });
});
