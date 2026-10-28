import type { Locator, Page } from "@playwright/test";
// `test` waits out React's hidden streaming copy after each goto (settledPage.ts), so a CSS locator like `td[data-day]` never sees the page twice.
import { test, expect } from "./settledPage";
import { tenantCookie } from "./appCookies";

// SCP-3a / SCP-3b (plan docs/plans/2026-10-15-social-content-pipeline.md §4.3, §8 rows 3a and 3b; BFF §63.10): "Schedule in Meta", Unschedule, Reschedule and
// "Mark live" on the post page, walked as the client's officer through the real login page. NO route mocks: the DEMO_MODE store
// (src/lib/demoSocialPipeline.ts, run by src/lib/demoSocialPipelineRun.ts, pinned to globalThis in the Next server) keeps the posts between requests.
// Runs in the `social-walk` project (serial, a fresh server), beside social-pipeline-walk.spec.ts.
//
// The two seeded posts it uses, and why these:
//   "Harbour view suite"            (soc-post-h-2, Harborlight Hotel, a reel, approved)   Reschedule, record the approval again, Schedule, Unschedule
//   "Autumn collection teaser"      (soc-post-n-5, Northwind Traders, a feed post, scheduled by hand)   Mark live
// Neither is a post the calendar spec (social-calendar.spec.ts) moves ("Behind the scenes at the studio", "Five ways to style a scarf", "November kickoff",
// "Gift guide for the host") or the walk's own (it makes its own posts).
//
// ── WHY THE APPROVED POST IS RESCHEDULED FIRST ────────────────────────────────────────────────────────────────────────────────
// A seeded post's date is a day of this month, so on some days of the month it is already more than five minutes past and "Schedule in Meta" is
// refused with `approved_time_passed` (the real rule, kept by the demo). The spec must pass on any day, so it asks the client again at a date
// 20 days ahead (Reschedule, which is SCP-Q13's own path), records the client's approval of that date, and schedules at it.
//
// ── FINDING ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The failed-publish banner ("The publisher could not publish this post") cannot be driven here: the DEMO_MODE store seeds no variant with a failed
// status, and the publisher's failure comes only from a dispatch the demo never makes. It is covered by PostPage.test.tsx; this spec only proves that a
// scheduled seeded post does not show it. No seed data was invented for it.

const TENANT = "co-agency";
const OFFICER = "social@gaiada.com"; // u-social: the officer of Northwind Traders and Harborlight Hotel

const APPROVED_POST = { url: "/departments/dept-4/posts/soc-post-h-2", title: "Harbour view suite" };
const SCHEDULED_POST = { url: "/departments/dept-4/posts/soc-post-n-5", title: "Autumn collection teaser" };
const LIVE_LINK = "https://example.com/northwind/p/autumn-teaser-e2e";

test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: "reduce" } });
test.describe.configure({ mode: "serial" });

// ── helpers (the same as social-pipeline-walk.spec.ts) ───────────────────────────────────────────────────────────────────────────

async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function press(loc: Locator) {
  await expect(loc).toBeVisible();
  await hydrated(loc);
  await loc.click();
}

async function signIn(page: Page, context: import("@playwright/test").BrowserContext, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await context.addCookies([tenantCookie(page.url(), TENANT)]);
}

const seen = (page: Page, css: string) => page.locator(css).filter({ visible: true }).first();
const chip = (page: Page) => seen(page, ".scp-post__chips .scp-chip");
const bar = (page: Page) => page.getByRole("region", { name: "Actions" });
const live = (page: Page, name: string) => bar(page).locator("button:not([disabled])").filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
const dialogOf = (page: Page, name: string) => page.getByRole("dialog", { name });

async function open(page: Page, post: { url: string; title: string }) {
  await page.goto(post.url);
  await expect(bar(page)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: post.title })).toBeVisible();
}

/** The dialog's own button (the bar's button of the same name sits behind the modal, so it is looked up inside the dialog). */
async function confirm(page: Page, name: string) {
  const dlg = dialogOf(page, name);
  await press(dlg.getByRole("button", { name, exact: true }));
  await expect(dlg).toBeHidden();
}

test.describe("SCP-3a/3b: schedule by hand, unschedule, reschedule and mark live on the post page", () => {
  test("1 Reschedule with a changed placement asks the client again", async ({ page, context }) => {
    await signIn(page, context, OFFICER);
    await open(page, APPROVED_POST);
    await expect(chip(page)).toHaveText("Client approved");
    // The reel is placed on Instagram alone. "Schedule in Meta" is not asserted here: whether it is live or disabled (`approved_time_passed`) depends on the day.
    await expect(live(page, "Reschedule")).toBeVisible();

    await press(live(page, "Reschedule"));
    const dlg = dialogOf(page, "Reschedule");
    await expect(dlg).toContainText("The client will be asked to approve the new date, time and networks again before it can be scheduled.");
    const networks = dlg.getByRole("group", { name: "Networks" });
    await expect(networks.getByRole("checkbox", { name: "Instagram" })).toBeChecked();
    await expect(networks.getByRole("checkbox", { name: "Facebook" })).not.toBeChecked();
    await networks.getByRole("checkbox", { name: "Facebook" }).check();
    const at = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    await dlg.getByLabel("New date and time").fill(`${at}T10:00`);
    await confirm(page, "Reschedule");

    await expect(chip(page)).toHaveText("With the client");
    // Back with the client: the officer cannot schedule it until the client has approved the new date and networks.
    await expect(live(page, "Schedule in Meta")).toHaveCount(0);
    await expect(live(page, "Record client approval")).toBeVisible();
  });

  test("2 The client's approval of the new date is recorded, then Schedule in Meta names it and marks the post Scheduled", async ({ page, context }) => {
    await signIn(page, context, OFFICER);
    await open(page, APPROVED_POST);
    await expect(chip(page)).toHaveText("With the client");

    await press(live(page, "Record client approval"));
    const rec = dialogOf(page, "Record client approval");
    await rec.getByLabel("How did the client tell you?").selectOption("whatsapp");
    await rec.getByLabel("Note").fill("E2E: approved the new date on a call.");
    await confirm(page, "Record client approval");
    await expect(chip(page)).toHaveText("Client approved");

    await press(live(page, "Schedule in Meta"));
    const dlg = dialogOf(page, "Schedule in Meta");
    // The dialog names the approved date, time and networks, and says a different one is Reschedule.
    await expect(dlg).toContainText("It is scheduled at the date, time and networks the client approved:");
    // The date and time the client approved (10:00, as rescheduled in test 1), in the post page's own words ("17 Nov, 10:00").
    await expect(dlg.locator("strong")).toHaveText(/^\d{1,2} [A-Z][a-z]{2}, 10:00$/);
    await expect(dlg).toContainText("on Instagram, Facebook.");
    await expect(dlg).toContainText("You schedule it yourself in Meta. Marking it scheduled here changes nothing there.");
    await expect(dlg).toContainText("A different date or placement is Reschedule, which asks the client again.");
    await confirm(page, "Schedule in Meta");

    await expect(chip(page)).toHaveText("Scheduled");
    // A scheduled-by-hand post: Unschedule and Reschedule are the officer's, "Mark live" is the next step.
    await expect(live(page, "Mark live")).toBeVisible();
    await expect(live(page, "Unschedule")).toBeVisible();
    await expect(live(page, "Schedule in Meta")).toHaveCount(0);
  });

  test("3 Unschedule goes back to Client approved, and the client's approval stands", async ({ page, context }) => {
    await signIn(page, context, OFFICER);
    await open(page, APPROVED_POST);
    await expect(chip(page)).toHaveText("Scheduled");

    await press(live(page, "Unschedule"));
    const dlg = dialogOf(page, "Unschedule");
    await expect(dlg).toContainText("It goes back to Client approved, and the client's approval stands.");
    await confirm(page, "Unschedule");

    await expect(chip(page)).toHaveText("Client approved");
    // The approval stands: it can be scheduled again straight away, with no new approval asked.
    await expect(live(page, "Schedule in Meta")).toBeVisible();
    await expect(live(page, "Record client approval")).toHaveCount(0);
  });

  test("4 Mark live with the post's link: the post is Live and shows the link", async ({ page, context }) => {
    await signIn(page, context, OFFICER);
    await open(page, SCHEDULED_POST);
    await expect(chip(page)).toHaveText("Scheduled");
    // A scheduled post with no failed publish does not show the failed-publish banner (see the FINDING above).
    await expect(page.getByText("The publisher could not publish this post.")).toHaveCount(0);

    await press(live(page, "Mark live"));
    const dlg = dialogOf(page, "Mark live");
    // A link is required: an empty one is refused in words and the post stays Scheduled.
    await dlg.getByRole("button", { name: "Mark live", exact: true }).click();
    await expect(dlg).toBeVisible();
    await expect(chip(page)).toHaveText("Scheduled");
    await dlg.getByLabel("The link to the post").fill(LIVE_LINK);
    await confirm(page, "Mark live");

    await expect(chip(page)).toHaveText("Live");
    await expect(page.getByText(/^Live since /).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: LIVE_LINK }).filter({ visible: true }).first()).toHaveAttribute("href", LIVE_LINK);
    // Live is the end of the line: nothing of the schedule is offered any more.
    for (const name of ["Mark live", "Unschedule", "Reschedule", "Schedule in Meta"]) await expect(live(page, name)).toHaveCount(0);
  });
});
