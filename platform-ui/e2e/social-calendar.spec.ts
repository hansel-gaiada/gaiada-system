import { test, expect, type Locator, type Page } from "@playwright/test";
import { tenantCookie } from "./appCookies";

// SCP-3e (plan docs/plans/2026-10-15-social-content-pipeline.md §6.2, §8 row 3e; BFF §63.10 "Date moves" and "GET calendar", §63.17): the Social Media calendar,
// `{D}/calendar`, in a real browser on the DEMO_MODE build with the Social skin (and once in the Standard look). NO route mocks: the demo store
// (src/lib/demoSocialPipeline.ts, module state in the Next server) keeps what the tests change.
//
//   1  the grid       Monday first, a legend, every client's posts; the phase, status and format in words; holiday and leave marks
//   2  an edit        drag a planned post to another day: it moves at once, with no confirm (the fixture's `edit`)
//   3  the keyboard   "Move to date…" moves a drafting post with no pointer
//   4  approved       dragging an approved post says the client will be asked again BEFORE anything is sent; Cancel leaves it, the confirm moves it to "With client"
//   5  locked         a post with the client, and a live post, cannot be dragged: the reason is in words
//   6  plan a post    the "+" on a day, for the client's officer: the post is made in that client's cycle and appears on the day
//   7  no "+"         a person who is neither officer nor approver is not offered it, and the page says why
//   8  Standard       the same page and the same moves in the Standard look
//
// ── WHY ITS OWN FILE, IN THE `social-walk` PROJECT ───────────────────────────────────────────────────────────────────────────────
// The moves change seeded posts of the demo store, so the file is serial and order-dependent (the move of test 4 is what test 5 reads next to), and runs against a
// FRESH server, as the pipeline walk does. Each test signs in itself, so NO stored session. Gated on sumopod with the other workspace projects, retries off.
//
// The demo seeds its posts by month (`SEEDS` in demoSocialPipeline.ts): this month holds the scheduled, approved, with-client, changes and live posts; the editable
// ones (planned, drafting, team copy changes) sit in NEXT month. The tests ask for the months by the clock in the display zone, so they hold in any month.

const TENANT = "co-agency";
const DEPT = "/departments/dept-4";
const OFFICER = "social@gaiada.com"; // u-social: the officer of Northwind Traders, placed in Social Media
const COPYWRITER = "copywriter@gaiada.com"; // neither officer nor approver
const NORTHWIND = "Northwind Traders";

const RUN = Date.now().toString(36);
const PLANNED_TITLE = `Calendar plan ${RUN}`;

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: "reduce" } });
test.describe.configure({ mode: "serial" });

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A button is a plain control until React owns it; clicking earlier does nothing (same helper as skin-social.spec.ts).
async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function press(loc: Locator) {
  await expect(loc).toBeVisible();
  await hydrated(loc);
  await loc.click();
}

/** Sign in through the real login page, then plant the tenant cookie (and the prefs cookie when one is asked for). */
async function signIn(page: Page, context: import("@playwright/test").BrowserContext, email: string, prefs?: Record<string, string>) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  const cookies = [tenantCookie(page.url(), TENANT)];
  if (prefs) cookies.push({ name: "gaiada_prefs", value: encodeURIComponent(JSON.stringify(prefs)), url: new URL("/", page.url()).toString() });
  await context.addCookies(cookies);
}

/** This month (`YYYY-MM`) in the display zone (Singapore unless NEXT_PUBLIC_DISPLAY_TZ says otherwise), shifted by `by` months. */
function monthOf(by = 0): string {
  const tz = process.env.NEXT_PUBLIC_DISPLAY_TZ || "Asia/Singapore";
  const now = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone: tz }).format(new Date()); // "2026-10"
  const t = Number(now.slice(0, 4)) * 12 + (Number(now.slice(5, 7)) - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
const THIS = monthOf(0);
const NEXT = monthOf(1);
const dayOf = (month: string, n: number) => `${month}-${String(n).padStart(2, "0")}`;

const open = async (page: Page, month: string) => {
  await page.goto(`${DEPT}/calendar${month === THIS ? "" : `?month=${month}`}`);
  await expect(page.getByRole("table")).toBeVisible();
};
const cell = (page: Page, day: string) => page.locator(`td[data-day="${day}"]`);
const chip = (page: Page, title: string) => page.getByRole("table").getByRole("link", { name: new RegExp(title) });
const moveButton = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(`^Move to date: .*${title}`) });
const status = (page: Page) => page.getByRole("status");
/** The day (`data-day`) of the cell a chip sits in. */
const dayOfChip = (loc: Locator) => loc.evaluate((el) => el.closest("td")?.getAttribute("data-day") ?? "");

// ── 1. the grid ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("the grid: Monday first, a legend, every client's posts with their phase, status and format in words, and the leave mark", async ({ page, context }) => {
  await signIn(page, context, OFFICER);
  await open(page, THIS);

  await expect(page.getByRole("columnheader").first()).toHaveText("Mon");
  await expect(page.getByRole("columnheader")).toHaveText(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  const legend = page.getByRole("list", { name: "Phase colours" });
  for (const word of ["Brief", "In production", "With client", "Client changes", "Client approved", "Posted", "Composer post", "Holiday", "Away"]) {
    await expect(legend).toContainText(word);
  }

  // All three clients' posts are on one grid, and a chip says its client, its time and (for a screen reader) its phase and status.
  const scarf = chip(page, "Five ways to style a scarf");
  await expect(scarf).toContainText(NORTHWIND);
  await expect(scarf).toContainText(/With client/);
  await expect(chip(page, "Autumn body scrub")).toContainText("Saltmarsh Day Spa");
  await expect(chip(page, "Harbour view suite")).toContainText("Harborlight Hotel");
  expect(await scarf.getAttribute("data-phase")).toBe("with_client");
  expect(await scarf.getAttribute("title")).toMatch(/Carousel/);

  // Colour is not the only signal: the leave mark is a word, and not a link.
  const away = cell(page, dayOf(THIS, 26));
  await expect(away).toContainText("Away:");
  await expect(away.getByText(/Komang Lestari/)).toBeVisible();
});

// ── 2. an edit: drag a planned post ──────────────────────────────────────────────────────────────────────────────────────────

test("dragging a planned post to another day moves it at once, with no confirm", async ({ page, context }) => {
  await signIn(page, context, OFFICER);
  await open(page, NEXT);

  const post = chip(page, "November kickoff");
  expect(await dayOfChip(post)).toBe(dayOf(NEXT, 4));
  await expect(post).toHaveAttribute("draggable", "true");
  await hydrated(post);
  await post.dragTo(cell(page, dayOf(NEXT, 9)));

  await expect(status(page)).toContainText(/Moved "November kickoff" to .* at \d\d:\d\d\./);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => dayOfChip(chip(page, "November kickoff"))).toBe(dayOf(NEXT, 9));
  await expect(status(page)).not.toContainText("asked to approve");
});

// ── 3. the keyboard path ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("Move to date… moves a drafting post with no pointer: the dialog, a new date, and the post is on that day", async ({ page, context }) => {
  await signIn(page, context, OFFICER);
  await open(page, NEXT);

  await press(moveButton(page, "Gift guide for the host"));
  const dialog = page.getByRole("dialog", { name: "Move to date" });
  await expect(dialog).toContainText("Gift guide for the host");
  await expect(dialog.getByLabel("New date")).toHaveValue(dayOf(NEXT, 6));
  // The same day is not a move.
  await press(dialog.getByRole("button", { name: "Move", exact: true }));
  await expect(dialog).toContainText("Choose a different day from the one it is on.");
  await dialog.getByLabel("New date").fill(dayOf(NEXT, 21));
  await press(dialog.getByRole("button", { name: "Move", exact: true }));

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(status(page)).toContainText(/Moved "Gift guide for the host" to /);
  await expect.poll(() => dayOfChip(chip(page, "Gift guide for the host"))).toBe(dayOf(NEXT, 21));
});

// ── 4. an approved post: the client will be asked again ──────────────────────────────────────────────────────────────────────

test("dragging an approved post says the client will be asked again BEFORE it moves; Cancel leaves it, the confirm moves it back to the client", async ({ page, context }) => {
  await signIn(page, context, OFFICER);
  await open(page, THIS);

  const post = chip(page, "Behind the scenes at the studio");
  expect(await dayOfChip(post)).toBe(dayOf(THIS, 23));
  await expect(post).toContainText(/Client approved/);
  await hydrated(post);

  // Drop it on the 14th: a dialog opens first, and nothing has moved.
  await post.dragTo(cell(page, dayOf(THIS, 14)));
  const dialog = page.getByRole("dialog", { name: "Move to date" });
  await expect(dialog).toContainText(/The client will be asked to approve .* again, on every network/);
  await expect(dialog.getByLabel("New date")).toHaveValue(dayOf(THIS, 14));
  expect(await dayOfChip(chip(page, "Behind the scenes at the studio"))).toBe(dayOf(THIS, 23));

  // Cancel: still on the 23rd, and no word of a move.
  await press(dialog.getByRole("button", { name: "Cancel" }));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await dayOfChip(chip(page, "Behind the scenes at the studio"))).toBe(dayOf(THIS, 23));
  await expect(status(page)).not.toContainText("Moved");

  // Again, and confirm: it moves, and it is With client.
  await chip(page, "Behind the scenes at the studio").dragTo(cell(page, dayOf(THIS, 14)));
  const again = page.getByRole("dialog", { name: "Move to date" });
  await press(again.getByRole("button", { name: "Move and ask the client again" }));
  await expect(status(page)).toContainText(/Moved "Behind the scenes at the studio" to .*The client will be asked to approve it again\./);
  await expect.poll(() => dayOfChip(chip(page, "Behind the scenes at the studio"))).toBe(dayOf(THIS, 14));
  await expect(chip(page, "Behind the scenes at the studio")).toContainText(/With client/);
});

// ── 5. locked ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("a post with the client and a live post cannot be dragged: the reason is in words", async ({ page, context }) => {
  await signIn(page, context, OFFICER);
  await open(page, THIS);

  const withClient = chip(page, "Five ways to style a scarf");
  await expect(withClient).toHaveAttribute("draggable", "false");
  await expect(withClient).toContainText(/date locked/);
  await withClient.dragTo(cell(page, dayOf(THIS, 12)));
  expect(await dayOfChip(chip(page, "Five ways to style a scarf"))).toBe(dayOf(THIS, 25));
  await expect(status(page)).not.toContainText("Moved");

  await press(moveButton(page, "Five ways to style a scarf"));
  const dialog = page.getByRole("dialog", { name: "The date is locked" });
  await expect(dialog).toContainText("The client is looking at it.");
  await expect(dialog.getByLabel("New date")).toHaveCount(0);
  await press(dialog.getByRole("button", { name: "Done" }));
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A live post: post_is_live, in words.
  const live = chip(page, "Sunday reset ritual");
  await expect(live).toHaveAttribute("draggable", "false");
  await press(moveButton(page, "Sunday reset ritual"));
  await expect(page.getByRole("dialog", { name: "The date is locked" })).toContainText("The post is live, so its date cannot change.");
  await press(page.getByRole("dialog").getByRole("button", { name: "Done" }));

  // The client's own change (Northwind's launch announcement is a design change the client asked for) stays as the client saw it, by the server's answer.
  const change = chip(page, "Launch day announcement");
  await expect(change).toHaveAttribute("draggable", "false");
  await press(moveButton(page, "Launch day announcement"));
  await expect(page.getByRole("dialog", { name: "The date is locked" })).toContainText(/the date stays as the client saw it/);
  await press(page.getByRole("dialog").getByRole("button", { name: "Done" }));
});

// ── 6. plan a post on a day ──────────────────────────────────────────────────────────────────────────────────────────────────

test("the + on a day plans a post for the client's officer: it is made in the client's cycle and appears on that day", async ({ page, context }) => {
  await signIn(page, context, OFFICER);
  await open(page, THIS);

  await press(cell(page, dayOf(THIS, 15)).getByRole("button", { name: /^Plan a post on / }));
  const dialog = page.getByRole("dialog", { name: /^Plan a post on / });
  // The officer is offered their own two clients (the hotel's and Northwind's, by name), and not the spa's, whose officer is a colleague.
  const options = dialog.getByLabel("Client").getByRole("option");
  await expect(options).toHaveText(["Harborlight Hotel (yours)", `${NORTHWIND} (yours)`]);
  await dialog.getByLabel("Client").selectOption({ label: `${NORTHWIND} (yours)` });
  await dialog.getByLabel("Title").fill(PLANNED_TITLE);
  await dialog.getByLabel("Format").selectOption("reel");
  await press(dialog.getByRole("button", { name: "Add to the plan" }));

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(status(page)).toContainText(`Planned "${PLANNED_TITLE}" for ${NORTHWIND}`);
  await expect(status(page).getByRole("link", { name: "Open it" })).toBeVisible();
  const made = chip(page, PLANNED_TITLE);
  await expect(made).toBeVisible();
  expect(await dayOfChip(made)).toBe(dayOf(THIS, 15));
  await expect(made).toContainText(/Brief, Planned/);
  // A planned post is an edit: it can be dragged.
  await expect(made).toHaveAttribute("draggable", "true");
});

// ── 7. who is offered the + ─────────────────────────────────────────────────────────────────────────────────────────────────

test("a person who is neither the client's officer nor an approver has no + and is told why, and still reads the grid", async ({ page, context }) => {
  await signIn(page, context, COPYWRITER);
  await open(page, THIS);
  await expect(chip(page, "Five ways to style a scarf")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Plan a post on / })).toHaveCount(0);
  await expect(page.getByText(/officer or one of the four Social Media approvers, so the days have no "\+" for you/)).toBeVisible();
});

// ── 8. the Standard look ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("the Standard look: the same grid, the same locks and the same move", async ({ page, context }) => {
  await signIn(page, context, OFFICER, { skin: "standard" });
  await open(page, NEXT);
  await expect(page.locator(".erp-app")).not.toHaveAttribute("data-skin", "social");
  await expect(page.getByRole("columnheader").first()).toHaveText("Mon");
  await expect(page.getByRole("list", { name: "Phase colours" })).toContainText("Client approved");

  // "Winter warmth menu" (the spa's, at Creative) is not the officer's to edit but is still on the grid with its words; Northwind's moved posts are where they were left.
  await expect(chip(page, "Winter warmth menu")).toHaveAttribute("draggable", "false");
  expect(await dayOfChip(chip(page, "Gift guide for the host"))).toBe(dayOf(NEXT, 21));

  const post = chip(page, "Gift guide for the host");
  await hydrated(post);
  await post.dragTo(cell(page, dayOf(NEXT, 17)));
  await expect(status(page)).toContainText(/Moved "Gift guide for the host" to /);
  await expect.poll(() => dayOfChip(chip(page, "Gift guide for the host"))).toBe(dayOf(NEXT, 17));
});
