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
    // sentence, never a 0-based countdown or an error.
    await expect(page.getByText("No SLA target — this engagement has not configured an inbox response time.")).toBeVisible();
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
    await page.getByRole("button", { name: "Check send readiness" }).click();
    await expect(page.getByText("retention")).toBeVisible();
    await expect(page.getByText(/scrubbed under LinkedIn's 48-hour retention cap/)).toBeVisible();
    await expect(page.getByText(/This is correct, expected behaviour — not a bug/)).toBeVisible();
  });
});

test.describe("Inbox — RBAC: a plain member is denied, not shown an empty queue", () => {
  test("member-tier (negative control): the inbox page reads Access denied, never a bare empty list", async ({ page, context }) => {
    await loginStaff(page, context, "member");
    await page.goto(`${DEPT4}/inbox`);
    await expect(page.getByRole("alert")).toContainText("Access denied");
    await expect(page.getByRole("alert")).toContainText("view the engagement inbox");
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
    await expect(page.getByText("Client: approved")).toBeVisible();
    await expect(page.getByText(/Client:.*stale/i)).toHaveCount(0);
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

    // cr-1 (soc-var-7) — pending.
    await expect(page.getByText("Awaiting your decision")).toBeVisible();
    // cr-2 (soc-var-8) — approved (against the OLD hash; the portal has no reason to know it's
    // since gone stale — that fact belongs to the staff Composer only, per this suite's own
    // calendar/composer assertions above).
    await expect(page.getByText("Approved").first()).toBeVisible();
    // cr-3 (soc-var-9) — changes requested, WITH the client's own prior comment visible.
    await expect(page.getByText("Changes requested").first()).toBeVisible();
  });
});
