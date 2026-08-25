import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { loginAsPersona } from "./personas";

// GM-10 — the GM console suite (`docs/plans/2026-08-24-gm-console-PROGRESS.md`), over DEMO_MODE.
//
// ── WHY THE NEGATIVE TESTS MATTER MORE THAN THE POSITIVE ONE ──────────────────────────────────────
// This is the FIRST department console whose Home is not safe for every member: every other one
// shows that department's own projects, this one shows company-grain figures across the whole
// business. And `Departments` sidebar rows are deliberately UNGATED (they come from the org
// structure, and hiding a department to hide its console would lie about the org chart). So the only
// thing standing between a junior developer and the company's numbers is the in-page gate in
// `lib/gm.ts`.
//
// A refactor that drops that gate leaves every vitest green — `gm.test.ts` tests the predicate, not
// the page — and the leak renders perfectly. Only a real browser catches it. That is what the
// `member` tests below exist for; treat a failure there as a security regression, not a UI nit.
//
// Every assertion checks a DISTINCTION (this state must not look like that other state), never mere
// presence: "refused" must not look like "empty", and a GM tab under Web Dev must not look like a
// GM tab under GM.
//
// Self-contained logins (no dependency on the "chromium" project's stored session): this file drives
// two identities and a stale shared session would silently test the wrong one — the same reasoning
// the "social"/"personas"/"pm-unified" projects carry in playwright.config.ts.

const GM = "/departments/dept-5"; // GM, co-agency (lib/org.ts's AGENCY_DEPARTMENTS[4] — appended last)
const WEBDEV = "/departments/dept-1"; // Web Dev — the non-GM control

const GM_TABS = ["review", "decisions", "depts", "money", "people"] as const;

const REFUSAL = /limited to group executives/i;

async function login(page: Page, context: BrowserContext, persona: "superadmin" | "member") {
  await loginAsPersona(page, persona);
  // Fresh DEMO_MODE sessions default to `companies[0]` (co-holding, a HOLDING that seeds no
  // departments at all — so every `/departments/*` route 404s until this is set). Setting the tenant
  // cookie directly is this repo's established workaround; see social-console.spec.ts.
  await context.addCookies([{ name: "gaiada_tenant", value: "co-agency", url: page.url() }]);
}

test.describe("GM cockpit (GM-03)", () => {
  test("renders the three tiers, and the provenance line refuses to imply a seal state", async ({ page, context }) => {
    await login(page, context, "superadmin");
    await page.goto(GM);

    // The console spine — proves the `gm` toolkit resolved, not the Home-only generic fallback.
    await expect(page.getByRole("link", { name: "Command" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Oversight" })).toBeVisible();

    // Tier 1 + Tier 2.
    await expect(page.getByText("The business")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Departments" })).toBeVisible();

    // The provenance line. This estate distinguishes SEALED report periods from live-computed ones
    // and stamps unsealed exports; `reports/overview` carries NO seal flag, so the line must say so
    // rather than presenting headline figures as the record. A cockpit that quietly implied "sealed"
    // would put an unsealed number into a business review as fact.
    await expect(page.getByText(/carries no seal state/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /open the full report/i })).toBeVisible();
  });

  test("the period toggle actually changes the period, not just the highlighted button", async ({ page, context }) => {
    await login(page, context, "superadmin");

    await page.goto(GM);
    await expect(page.getByText(/this week/i)).toBeVisible();

    await page.goto(`${GM}?period=month`);
    await expect(page.getByText(/this month/i)).toBeVisible();
    // The distinction: the old label must be GONE, not merely joined by the new one.
    await expect(page.getByText(/this week/i)).toHaveCount(0);
  });

  test("an unrecognised period falls back to the week instead of reaching the backend", async ({ page, context }) => {
    await login(page, context, "superadmin");
    // `day` and `custom` are real ReportPeriodKinds the console deliberately does not offer.
    await page.goto(`${GM}?period=day`);
    await expect(page.getByText(/this week/i)).toBeVisible();
  });
});

test.describe("every GM tab renders under GM", () => {
  for (const tab of GM_TABS) {
    test(`${tab} renders without an error page`, async ({ page, context }) => {
      await login(page, context, "superadmin");
      const res = await page.goto(`${GM}/${tab}`);
      expect(res?.status()).toBeLessThan(400);
      // Not a 404 shell, and not Next's error boundary.
      await expect(page.getByText(/page not found/i)).toHaveCount(0);
      await expect(page.getByText(/application error/i)).toHaveCount(0);
      // The console spine is still there, so this is a TAB and not a bare page.
      await expect(page.getByRole("link", { name: "Oversight" })).toBeVisible();
    });
  }

  test("the money tab names its missing backend instead of rendering a zero", async ({ page, context }) => {
    await login(page, context, "superadmin");
    await page.goto(`${GM}/money`);
    // OQ-3: the money half must stay honestly absent. A `0` here would be read as "no revenue"
    // rather than "not built", and summing the SEO engagement ledger into a group figure would be
    // worse still.
    await expect(page.getByText(/backend pending/i)).toBeVisible();
    await expect(page.getByText(/SM-17/)).toBeVisible();
  });
});

test.describe("the gate (GM-02) — a plain member must never see company-grain figures", () => {
  test("the cockpit refuses, and the refusal does not look like an empty business", async ({ page, context }) => {
    await login(page, context, "member");
    await page.goto(GM);

    await expect(page.getByText(REFUSAL)).toBeVisible();
    // THE distinction. A refusal that rendered the cockpit's own chrome with no numbers in it would
    // read as "the company did nothing", which is worse than a locked door.
    await expect(page.getByText("The business")).toHaveCount(0);
  });

  for (const tab of GM_TABS) {
    test(`the ${tab} tab refuses a member`, async ({ page, context }) => {
      await login(page, context, "member");
      await page.goto(`${GM}/${tab}`);
      await expect(page.getByText(REFUSAL)).toBeVisible();
    });
  }

  test("the GM row STAYS in a member's sidebar — content is gated, the org chart is not", async ({ page, context }) => {
    await login(page, context, "member");
    await page.goto(GM);
    // Deliberate: hiding a department from the tree in order to hide its console would lie about the
    // org chart, and a UI-only gate that hides a page the server would serve reads as broken rather
    // than as forbidden. `nav.test.ts` pins the same rule at the unit level.
    await expect(page.locator(`a[href="${GM}"]`).first()).toBeVisible();
  });
});

test.describe("toolkit membership — a GM tab is not a generic route", () => {
  test("a GM tab under Web Dev refuses as not-configured, NOT as unauthorized", async ({ page, context }) => {
    await login(page, context, "superadmin");
    await page.goto(`${WEBDEV}/decisions`);

    // The `[deptId]` tab routes are generic — every department's console can address every tab path —
    // so each bespoke tab tests its own toolkit membership. Order is load-bearing: a Web Dev member
    // must be told the tab is not part of THAT console, never that they lack an executive
    // capability, which would imply the tab would otherwise be there.
    await expect(page.getByText(/isn.t configured for this department/i)).toBeVisible();
    await expect(page.getByText(REFUSAL)).toHaveCount(0);
    // And Web Dev's own console is unharmed.
    await expect(page.getByRole("heading", { name: "Web Dev" })).toBeVisible();
  });

  test("Web Dev's Home is still the department template, not the GM cockpit", async ({ page, context }) => {
    await login(page, context, "superadmin");
    await page.goto(WEBDEV);
    await expect(page.getByText("The business")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Command" })).toHaveCount(0);
  });
});
