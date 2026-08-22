import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { loginAsPersona } from "./personas";

// SMM-25 — the Social Media (dept-4) console suite, over DEMO_MODE (src/lib/demoSocial.ts).
//
// SCOPE, stated plainly (see docs/plans/smm-tracker.md's SMM-25 row for the full reasoning): this
// is the DEMO_MODE half of the original ticket only. The live-network-publish half is DEFERRED,
// not done — every platform app credential in the estate is empty and app reviews are deferred to
// staging (D-23), so there is no live dev stack to drive a real publish against, for anyone, today.
// Nothing in this file simulates a live publish or presents demo coverage as live verification.
//
// Self-contained logins throughout (no dependency on the "chromium" project's stored session) —
// same reasoning as e2e/webdev-change-requests.spec.ts: this file drives THREE identities
// (platform_admin/manager-tier, plain member, and the demo client-portal contact) in one place, and
// a stale shared session would silently test the wrong identity for the RBAC assertions below. Runs
// under its own "social" project (playwright.config.ts) for the identical reason.
//
// THE POINT OF THIS FILE: the honest-absence states this module spent its whole build establishing
// (docs/plans/smm-tracker.md's own recurring-defect-class list) have never been driven in a real
// browser before. A careless future change can turn any one of them into a spinner, an empty div,
// or a bare "0" and every existing in-process vitest would stay green — only a real render catches
// that. Every `expect` below asserts a DISTINCTION (this state must not look like that OTHER
// state), never mere presence, per the ticket's own instruction.

const DEPT4 = "/departments/dept-4"; // Social Media, co-agency (lib/org.ts's AGENCY_DEPARTMENTS[3])

async function loginStaff(page: Page, context: BrowserContext, persona: "superadmin" | "member") {
  await loginAsPersona(page, persona);
  // Fresh (no-cookie) DEMO_MODE sessions default-fallback to `companies[0]` regardless of role
  // scope (demoFixtures.ts's own `/api/me` gap, named in webdev-change-requests.spec.ts) — setting
  // the tenant cookie directly is this repo's established workaround (smoke.spec.ts / a11y-axe.spec.ts).
  await context.addCookies([{ name: "gaiada_tenant", value: "co-agency", url: page.url() }]);
}

test.describe("Composer — quota strip: three states, never a fabricated zero", () => {
  test("known, unknown (never zero), and not-modeled render as three visibly different facts", async ({ page, context }) => {
    await loginStaff(page, context, "superadmin");

    // soc-var-1 (soc-post-1) — soc-acc-ig-2, NO live counter synced. Must say "Unknown", never "0
    // used" — the exact QUOTA_UNKNOWN_RULE this ticket's own table names.
    await page.goto(`${DEPT4}/composer/soc-post-1`);
    await expect(page.getByText("Unknown — registry not synced (never zero)")).toBeVisible();
    await expect(page.getByText(/^0 used/)).toHaveCount(0);

    // soc-var-3/soc-var-4 (soc-post-3) — soc-acc-ig-1 (8/25, healthy) and soc-acc-ig-3 (25/25, AT
    // cap). Both are the SAME "known" status — a real number, even when that number is the max —
    // never confused with "unknown".
    await page.goto(`${DEPT4}/composer/soc-post-3`);
    await expect(page.getByText("8/25 posts used (24h)")).toBeVisible();
    await expect(page.getByText("25/25 posts used (24h)")).toBeVisible();

    // soc-var-5 (soc-post-4) — soc-acc-fb-1, Facebook has NO live-counter model at all. A DIFFERENT
    // fact from "unsynced": this network can never answer, not just "hasn't answered yet".
    await page.goto(`${DEPT4}/composer/soc-post-4`);
    await expect(page.getByText("Not tracked — no live quota probe is modeled for this network")).toBeVisible();
  });
});

test.describe("Composer — best-time-to-post chip: four states, never a bare time and never blank", () => {
  test("not_yet_computed, insufficient_evidence, suggested, and unsupported are four different sentences", async ({ page, context }) => {
    await loginStaff(page, context, "superadmin");

    // soc-var-1 → soc-acc-ig-2 has no BEST_TIME_SEED row at all — the honest default every real
    // deployment is in today (D-23: no account connected anywhere).
    await page.goto(`${DEPT4}/composer/soc-post-1`);
    await expect(page.getByText("Best-time-to-post hasn't been computed yet for this account.")).toBeVisible();

    // soc-var-5 → soc-acc-fb-1 — 'insufficient_evidence' MUST quote the real threshold and count,
    // never a bare "not enough data".
    await page.goto(`${DEPT4}/composer/soc-post-4`);
    await expect(page.getByText("Not enough data yet: 2 of 5 measured posts needed before a best time can be suggested.")).toBeVisible();

    // soc-var-3 → soc-acc-ig-1 — 'suggested', the only state that ever names an hour, and always
    // labelled UTC explicitly.
    await page.goto(`${DEPT4}/composer/soc-post-3`);
    await expect(page.getByText(/Best time to post: around .*UTC.*based on 3 of 5 measured posts/)).toBeVisible();

    // soc-var-11 (soc-post-10, this suite's own fixture addition) → soc-acc-tiktok-1 — 'unsupported'
    // is a MORE PERMANENT fact than "no data yet" and must read as a different sentence, not a
    // synonym for insufficient_evidence.
    await page.goto(`${DEPT4}/composer/soc-post-10`);
    await expect(page.getByText("This network can't report per-post engagement, so a best-time suggestion isn't possible here.")).toBeVisible();
  });
});

test.describe("Composer — client sign-off: five distinct steady states + the live request/withdraw loop", () => {
  // Serial, deliberately: both tests below read/mutate the SAME shared-globalThis demo row
  // (soc-var-10's client review) — under the default fully-parallel config they raced (one test
  // asserting "not_requested" while the other was mid-flight turning it "pending"), a real
  // test-isolation bug in THIS suite, not a product defect. Sequencing is the honest fix; giving
  // the live-loop test its own separate "not_requested" fixture would need a second seed row this
  // suite has no other use for.
  test.describe.configure({ mode: "serial" });

  test("pending, stale, changes_requested (with the client's own comment), and not_requested read as five different facts", async ({ page, context }) => {
    await loginStaff(page, context, "superadmin");

    // soc-var-7 — pending.
    await page.goto(`${DEPT4}/composer/soc-post-6`);
    await expect(page.getByText("Waiting on the client — they haven't decided yet.")).toBeVisible();

    // soc-var-8 — client_review_stale: approved an OLDER hash than the variant carries today. Must
    // NOT render as a silent pass — this is the ticket's own named "approved-then-edited" honesty case.
    await page.goto(`${DEPT4}/composer/soc-post-7`);
    await expect(page.getByText(/approval no longer matches what's here now/)).toBeVisible();
    await expect(page.getByText("The client approved this exact content", { exact: false })).toHaveCount(0);

    // soc-var-9 — changes_requested, WITH the client's own comment text rendered (not just the token).
    await page.goto(`${DEPT4}/composer/soc-post-8`);
    await expect(page.getByText(/The client asked for changes/)).toBeVisible();
    await expect(page.getByText("Please swap the second photo for the new packaging shot before we go out with this.")).toBeVisible();

    // soc-var-10 — not_requested: the honest "nobody has asked" state, offering "Ask client to review".
    await page.goto(`${DEPT4}/composer/soc-post-9`);
    await expect(page.getByText("This engagement requires the client's sign-off before this can publish, and nobody has asked the client yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask client to review" })).toBeVisible();
  });

  test("live loop: not_requested → pending → withdrawn → pending again, same row reused", async ({ page, context }) => {
    await loginStaff(page, context, "superadmin");
    await page.goto(`${DEPT4}/composer/soc-post-9`);

    await page.getByRole("button", { name: "Ask client to review" }).click();
    await expect(page.getByText("Waiting on the client — they haven't decided yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Withdraw request" })).toBeVisible();

    await page.getByRole("button", { name: "Withdraw request" }).click();
    await expect(page.getByText("The request for the client's sign-off was withdrawn, and nobody has asked again since.")).toBeVisible();

    // "Ask again" re-uses the SAME idempotent row (0105's UNIQUE(variant_id) mirror) — proven by the
    // state coming right back to pending, not erroring as a duplicate.
    await page.getByRole("button", { name: "Ask again" }).click();
    await expect(page.getByText("Waiting on the client — they haven't decided yet.")).toBeVisible();
  });
});

test.describe("Inbox — AI-triage chip: four states that must not collapse into each other", () => {
  test("unclassified, unavailable, classified (neutral IS an answer), and purged are visibly and textually distinct", async ({ page, context }) => {
    await loginStaff(page, context, "superadmin");
    await page.goto(`${DEPT4}/inbox`);
    await page.getByRole("tab", { name: "All" }).click();

    // soc-thread-1 — unclassified ("nobody has looked yet"): italic, dashed, muted.
    const unclassified = page.getByText("Not yet triaged");
    await expect(unclassified).toBeVisible();
    await expect(unclassified).toHaveCSS("font-style", "italic");

    // soc-thread-5 — unavailable ("we tried and failed"): same dashed border family, but NOT
    // italic and a SOLID caution colour — the ticket's own "must look like a non-answer, but a
    // DIFFERENT non-answer" requirement, asserted as an actual style difference, not just a
    // different string.
    const unavailable = page.getByText("⚠ Triage unavailable");
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toHaveCSS("font-style", "normal");

    // soc-thread-2 — classified, sentiment "neutral" IS a real answer, not the absence of one.
    await expect(page.getByText("Question · Normal urgency")).toBeVisible();

    // soc-thread-6 — purged: a COMPLIANCE fact, never styled as an error/critical outcome, and
    // never silently vanishing (the row and its chip both still render).
    const purged = page.getByText("Classification purged");
    await expect(purged).toBeVisible();
    await expect(page.getByText("Retention compliance — not a failure.")).toBeVisible();
    const purgedColor = await purged.evaluate((el) => getComputedStyle(el).color);
    // status-caution-fg (#9a6700 → rgb(154, 103, 0)), never status-critical-fg (#b3261e).
    expect(purgedColor).not.toBe("rgb(179, 38, 30)");

    // The purged thread's OWN row still names the compliance fact plainly rather than looking like
    // missing data — excerpt reads "(content purged)", author reads "Unknown", neither blank.
    await expect(page.getByText("(content purged)")).toBeVisible();

    // soc-thread-4 — a thread with genuinely no SLA target ("none") reads as its own honest
    // sentence, never a 0-based countdown or an error. Scoped to soc-thread-4's OWN row (its
    // excerpt is unique) — soc-thread-9 ALSO has no SLA target, so the bare text is not unique on
    // this page; that is two threads legitimately sharing one honest state, not a locator bug to
    // paper over with `.first()`.
    const thread4Row = page.locator(".lux-table__row", { hasText: "Loved the new arrivals, ordering more!" });
    await expect(thread4Row.getByText("No SLA target — this engagement has not configured an inbox response time.")).toBeVisible();
  });
});

test.describe("Inbox — reply gate: edit-invalidates-draft loop and the source_content_purged refusal", () => {
  test("a draft can be edited and saved, and an approved reply on purged source content refuses honestly, not as a system failure", async ({ page, context }) => {
    await loginStaff(page, context, "superadmin");

    // soc-thread-2 — a draft reply exists (soc-msg-3). Edit it and save; the draft round-trips.
    await page.goto(`${DEPT4}/inbox?thread=soc-thread-2`);
    const textarea = page.locator("textarea");
    await expect(textarea).toHaveValue(/autumn jacket runs/);
    await textarea.fill("Hi Sam! We carry XS through XL — want me to check a specific size?");
    await page.getByRole("button", { name: "Save edit" }).click();
    await expect(textarea).toHaveValue(/carry XS through XL/);

    // soc-thread-6 — the approved reply (soc-msg-10) answers a comment whose source content was
    // purged under LinkedIn's 48h cap. send-preconditions must refuse `source_content_purged`
    // honestly (fail-closed-on-unknown, D-22's doctrine) — never presented as a system error.
    await page.goto(`${DEPT4}/inbox?thread=soc-thread-6`);
    // TWO "Check send readiness" buttons render for this one message (soc-msg-10, the sole
    // approved-but-unsent reply on this thread) — one in the per-message row of the "Messages"
    // list, one in the "Draft reply" panel's own controls. Both point at the identical message id,
    // so this is one fact rendered twice in two places, not two variants disagreeing — scoped to
    // the message-list row specifically (unambiguous about WHICH affordance is being driven) rather
    // than a blind `.first()`.
    await page.locator("li", { hasText: "Navy is back in stock as of this week!" })
      .getByRole("button", { name: "Check send readiness" }).click();
    // Exact match: a bare substring "retention" also matches the (unrelated, already-visible)
    // purged-triage-chip disclaimer text ("Retention compliance — not a failure.") rendered twice
    // on this page (once in the queue row, once in the detail panel, for this same thread) —
    // exact:true targets only the `<code>{stage}</code>` badge, which is the actual fact this
    // assertion is about.
    await expect(page.getByText("retention", { exact: true })).toBeVisible();
    await expect(page.getByText(/scrubbed under LinkedIn's 48-hour retention cap/)).toBeVisible();
    await expect(page.getByText(/This is correct, expected behaviour — not a bug/)).toBeVisible();
  });
});

test.describe("Inbox — RBAC: a plain member is denied, not shown an empty queue", () => {
  test("member-tier (negative control): the inbox page reads Access denied, never a bare empty list", async ({ page, context }) => {
    await loginStaff(page, context, "member");
    await page.goto(`${DEPT4}/inbox`);
    // `getByRole("alert")` alone can pick up a second, unrelated dev-only overlay role in this
    // environment (Next's own dev toolbar) — scoped to OUR AccessDenied component's own text so
    // this asserts the product's denial, not just "some alert exists somewhere on the page".
    const denied = page.getByRole("alert").filter({ hasText: "view the engagement inbox" });
    await expect(denied).toContainText("Access denied");
    // Never the empty-queue sentence — a denial must never read as "nothing to show".
    await expect(page.getByText("Nothing in this queue right now.")).toHaveCount(0);
  });

  test("member-tier (negative control): the Composer renders read-only — no author affordance", async ({ page, context }) => {
    await loginStaff(page, context, "member");
    await page.goto(`${DEPT4}/composer`);
    // `social.manage` gates NewPostForm — a plain `member` holds no social.* capability at all
    // (lib/rbac.ts's ROLE_CAPS has no "member" entry naming any `social.*` token).
    await expect(page.getByPlaceholder("Autumn launch teaser")).toHaveCount(0);
  });
});

test.describe("Calendar — drag-to-reschedule: the discarded-approval warning must fire BEFORE the drop commits", () => {
  test("names the count of approved variants, and cancelling leaves the schedule untouched", async ({ page, context }) => {
    await loginStaff(page, context, "superadmin");
    await page.goto(`${DEPT4}/calendar?month=2026-08`);

    // soc-post-3 (Aug 27) carries TWO approved variants (soc-var-3, soc-var-4).
    const chip = page.getByRole("link", { name: /Weekly promo carousel/ });
    await expect(chip).toBeVisible();

    const targetDay = page.locator("span", { hasText: /^20$/ }).locator("xpath=..");

    let dialogMessage = "";
    page.once("dialog", async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.dismiss(); // CANCEL — the drop must not commit.
    });
    await chip.dragTo(targetDay);

    expect(dialogMessage).toContain("2 approved variants");
    expect(dialogMessage).toContain("discard 2 existing approvals");
    expect(dialogMessage).toContain("drops back to draft");

    // Cancelled — the post is still on its original day, still showing "approved" twice.
    await expect(page.getByRole("link", { name: /Weekly promo carousel/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("link", { name: /Weekly promo carousel/ })).toBeVisible();
  });

  test("client-review chip on the calendar always shows the RAW status, never a derived 'stale'", async ({ page, context }) => {
    await loginStaff(page, context, "superadmin");
    await page.goto(`${DEPT4}/calendar?month=2026-08&engagementId=soc-eng-2`);
    // soc-var-8's chip must read "Client: approved" — the raw status. The Composer is the only
    // surface with the live hash needed to know it's actually stale (VariantCard, tested above);
    // the calendar roll-up carries no argsSha256 to compare against, and must not fabricate one.
    // soc-post-7's own TITLE literally contains the word "stale" ("Approved, then edited — now
    // stale") — a bare page-wide `/Client:.*stale/i` regex matches across that unrelated text
    // node and the chip's, which is not what "no chip reads stale" means. Scoped to the review
    // chip elements themselves (the ones the raw-status assertion above also targets).
    const reviewChips = page.locator("a", { hasText: "Approved, then edited" }).getByText(/^Client:/);
    await expect(reviewChips).toHaveText("Client: approved");
    await expect(reviewChips).not.toHaveText(/stale/i);
  });
});

test.describe("Analytics — an omitted KPI must never render as zero", () => {
  test("a genuinely un-reported metric renders an em dash; an omitted account never appears as a zeroed row", async ({ page, context }) => {
    await loginStaff(page, context, "superadmin");
    await page.goto(`${DEPT4}/analytics?engagementId=soc-eng-1`);

    // soc-acc-ig-1's earliest day (2026-08-14) reported followers+impressions and NOTHING else —
    // reach/engagements/link-clicks/video-views must all read "—", never "0".
    const row = page.locator(".lux-table__row", { hasText: "Aug 14, 2026" });
    await expect(row).toBeVisible();
    const cells = await row.locator("span").allTextContents();
    // [date, followers, impressions, reach, engagements, linkClicks, videoViews]
    expect(cells[3]).toBe("—");
    expect(cells[4]).toBe("—");
    expect(cells[5]).toBe("—");
    expect(cells[6]).toBe("—");
    expect(cells[1]).not.toBe("—"); // followers WAS reported that day — proves this isn't a blanket dash.
    expect(cells[3]).not.toBe("0");

    // soc-acc-ig-2 has ZERO daily-metrics rows seeded — "never pulled" must mean the account is
    // simply ABSENT from the per-account tables, never a zeroed section rendered in its place.
    await expect(page.getByText("northwind.behindthescenes")).toHaveCount(0);

    // The one published-post metrics row (soc-var-6) omits `saves` — must read "—", never "0",
    // alongside impressions/likes/comments/shares which WERE reported.
    const postRow = page.locator(".lux-table__row", { hasText: "instagram" });
    await expect(postRow).toBeVisible();
    const postCells = await postRow.locator("span").allTextContents();
    // [network, published, impressions, likes, comments, shares, saves, lastPulled]
    expect(postCells[6]).toBe("—");
    expect(postCells[2]).not.toBe("—");
  });
});

test.describe("Negative control — the AGPL source-offer footer is Social-Media-specific, not console-wide", () => {
  test("present on Social Media, absent on Web Dev", async ({ page, context }) => {
    await loginStaff(page, context, "superadmin");

    await page.goto(`${DEPT4}/calendar`);
    await expect(page.getByRole("note", { name: "Open-source notice" })).toBeVisible();
    await expect(page.getByText("Postiz", { exact: false })).toBeVisible();

    await page.goto("/departments/dept-1/projects");
    await expect(page.getByRole("note", { name: "Open-source notice" })).toHaveCount(0);
  });
});

test.describe("Portal — client review surface, the four labels a client actually sees", () => {
  test("the portal lists reviews with distinct, honest labels per status", async ({ page }) => {
    await loginAsPersona(page, "client_contact");
    await page.goto("/portal/social-reviews");

    // Pending reviews each get their OWN Card (section.lux-card), headed by the post's own title —
    // scoped to that specific card so a SECOND, unrelated pending review left behind by an earlier
    // test's live request/withdraw loop (soc-var-10 — a different post, different title) can never
    // be mistaken for cr-1. cr-1 (soc-var-7, soc-post-6) — pending.
    const pendingCard = page.locator("section.lux-card", {
      has: page.getByRole("heading", { name: "Client sign-off needed: Autumn drop" }),
    });
    await expect(pendingCard.getByText("Awaiting your decision")).toBeVisible();

    // Decided reviews (cr-2, cr-3) are NOT their own cards — they're rows inside the single
    // "Past reviews" card, one Link (post title) + one status span per row, per this page's own
    // source (app/(portal)/portal/social-reviews/page.tsx). Scoped to the row via its own title
    // Link so cr-2's "Approved" can never be confused with cr-3's "Changes requested" two rows down.
    const pastReviews = page.locator("section.lux-card", { has: page.getByRole("heading", { name: "Past reviews" }) });
    const cr2Row = pastReviews.locator("div", { has: page.getByRole("link", { name: "Approved, then edited — now stale" }) }).last();
    const cr3Row = pastReviews.locator("div", { has: page.getByRole("link", { name: "Client asked for changes — carousel copy" }) }).last();
    // cr-2 (soc-var-8, soc-post-7) — approved (against the OLD hash; the portal has no reason to
    // know it's since gone stale — that fact belongs to the staff Composer only, per this suite's
    // own calendar/composer assertions above).
    await expect(cr2Row).toHaveText(/Approved/);
    // cr-3 (soc-var-9, soc-post-8) — changes requested.
    await expect(cr3Row).toHaveText(/Changes requested/);

    // The client's OWN comment is a detail-page fact, not shown on this list (§16h's contract) —
    // followed to cr-3's own review page to prove it's actually there, not just claimed by title.
    await cr3Row.getByRole("link", { name: "Client asked for changes — carousel copy" }).click();
    await expect(page.getByText("Please swap the second photo for the new packaging shot before we go out with this.")).toBeVisible();
  });
});
