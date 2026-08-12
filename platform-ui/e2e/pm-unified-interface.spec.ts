import { test, expect, type Page, type BrowserContext } from "@playwright/test";

// Coverage for commit c89fed6 ("one project-management interface, on every surface that shows
// it") — deliberately deferred and flagged in that commit's own message: "e2e specs don't yet
// assert the new routes or the department Ball tab." This file closes that gap.
//
// Self-contained (own login, own pinned tenant cookie) rather than riding the shared
// `.auth/user.json` staff session — this file signs in as three different demo identities
// (elevated / member / search_staff) to drive the capability assertions, and DEMO_MODE's
// `/api/me` hands back ALL three seeded companies (co-holding/co-agency/co-resort) for EVERY
// identity regardless of that identity's actual roles. Without pinning `gaiada_tenant`, the
// active-tenant fallback (first company) can land a role-less identity on a company it holds no
// grant in at all — the exact footgun this suite must not reintroduce. Every login here pins
// `co-agency`, the one company `gede-ic`/`seo-staff` actually have a role in (`src/lib/demoFixtures.ts`).
test.use({ storageState: { cookies: [], origins: [] } });

async function loginAs(page: Page, context: BrowserContext, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await context.addCookies([{ name: "gaiada_tenant", value: "co-agency", url: page.url() }]);
}

const HANSEL = "hansel@gaiada.com"; // demo-hansel: elevated (platform_admin + group_executive)
const GEDE = "gede@gaiada.com"; // gede-ic: plain `member` -> holds pm.contribute, NOT pm.manage
const SEO_STAFF = "seo-staff@gaiada.com"; // seo-staff: search_staff -> holds neither pm.contribute nor pm.manage

test.describe("Ball is its own tab, everywhere, and is gone from Overview's Group-by", () => {
  // The negative half is the point of the whole rename (2026-08-09 owner decision moved Ball OUT
  // of the Board "Group by" swimlane into its own peer tab) — a rename-blind suite would pass
  // through Ball quietly staying a swimlane option just as easily as through it becoming a tab.
  test("/pm: Ball tab exists; Overview's Group by no longer lists Ball", async ({ page, context }) => {
    await loginAs(page, context, HANSEL);
    await page.goto("/pm");

    // Ball reachable as its own tab, not a swimlane.
    const ballTab = page.getByRole("link", { name: "Ball", exact: true });
    await expect(ballTab).toBeVisible();
    await ballTab.click();
    await page.waitForURL(/\/pm\?view=ball/);
    await expect(ballTab).toHaveAttribute("aria-current", "page");

    // Back on Overview (was Board — PM_TERMS.board is the source of truth for this label,
    // pmVocabulary.ts), the swimlane <select> must not offer Ball as a grouping.
    await page.goto("/pm?view=board");
    const swimlaneOptions = page.locator('select[name="swimlane"] option');
    await expect(swimlaneOptions).not.toHaveText([/ball/i]);
    const optionTexts = await swimlaneOptions.allTextContents();
    expect(optionTexts.some((t) => /ball/i.test(t))).toBe(false);
    expect(optionTexts).toEqual(["Status", "Responsible", "Priority"]);
  });

  test("/project-management: same Ball tab / Group-by contract as /pm", async ({ page, context }) => {
    await loginAs(page, context, HANSEL);
    await page.goto("/project-management");

    const ballTab = page.getByRole("link", { name: "Ball", exact: true });
    await expect(ballTab).toBeVisible();
    await ballTab.click();
    await page.waitForURL(/\/project-management\?view=ball/);

    await page.goto("/project-management?view=board");
    const optionTexts = await page.locator('select[name="swimlane"] option').allTextContents();
    expect(optionTexts.some((t) => /ball/i.test(t))).toBe(false);
  });

  test("department console (Web Dev, dept-1): Ball is its own sub-tab at .../ball", async ({ page, context }) => {
    await loginAs(page, context, HANSEL);
    await page.goto("/departments/dept-1/board");

    const ballTab = page.getByRole("link", { name: "Ball", exact: true });
    await expect(ballTab).toBeVisible();
    await expect(ballTab).toHaveAttribute("href", "/departments/dept-1/ball");
    await ballTab.click();
    await page.waitForURL(/\/departments\/dept-1\/ball$/);

    // The department Board tab's own Group-by (a DIFFERENT select than /pm's — dept boards also
    // have Division/grid options) must likewise not list Ball.
    await page.goto("/departments/dept-1/board");
    const optionTexts = await page.locator('select[name="swimlane"] option').allTextContents();
    expect(optionTexts.some((t) => /ball/i.test(t))).toBe(false);
  });

  test("single-project workspace (/projects/p-web-1): Ball is its own tab", async ({ page, context }) => {
    await loginAs(page, context, HANSEL);
    await page.goto("/projects/p-web-1");

    const ballTab = page.getByRole("link", { name: "Ball", exact: true });
    await expect(ballTab).toBeVisible();
    await ballTab.click();
    await page.waitForURL(/\/projects\/p-web-1\?view=ball/);

    await page.goto("/projects/p-web-1?view=board");
    const optionTexts = await page.locator('select[name="swimlane"] option').allTextContents();
    expect(optionTexts.some((t) => /ball/i.test(t))).toBe(false);
  });
});

test.describe("/project-management resolves with the full tab set, no scope switcher", () => {
  test("shows Overview/Ball/Timeline/Charts/Productivity/Projects/Tasks, and no PM scope switcher", async ({ page, context }) => {
    await loginAs(page, context, HANSEL);
    await page.goto("/project-management");

    await expect(page.getByRole("heading", { level: 1 })).toContainText("Project Management");

    // The renamed labels ARE the requirement here, so assert the literal visible text (source of
    // truth: PM_TERMS in src/lib/pmVocabulary.ts — a future rename there updates this UI in one
    // place, and this assertion is what proves it actually reached this surface).
    for (const label of ["Overview", "Ball", "Timeline", "Charts", "Productivity", "Projects", "Tasks"]) {
      await expect(page.getByRole("link", { name: label, exact: true })).toBeVisible();
    }

    // Fixed whole-company scope: unlike /pm, this surface has no department/project drill-down,
    // so the ScopeSwitcher (`aria-label="PM scope"`) must be absent.
    await expect(page.getByLabel("PM scope")).toHaveCount(0);
  });
});

test.describe("Deep links are preserved (explicitly NOT redirected)", () => {
  test("/pm, /projects, /tasks, and ?view= params all still resolve", async ({ page, context }) => {
    await loginAs(page, context, HANSEL);

    await page.goto("/pm");
    await expect(page).toHaveURL(/\/pm$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await page.goto("/projects");
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/projects/i);

    await page.goto("/tasks");
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/tasks/i);

    // ?view= values on every PM surface resolve to the matching tab, not a 404/redirect.
    await page.goto("/pm?view=gantt");
    await expect(page).toHaveURL(/\/pm\?view=gantt/);
    await expect(page.getByRole("link", { name: "Timeline", exact: true })).toHaveAttribute("aria-current", "page");

    await page.goto("/project-management?view=charts");
    await expect(page).toHaveURL(/\/project-management\?view=charts/);
    await expect(page.getByRole("link", { name: "Charts", exact: true })).toHaveAttribute("aria-current", "page");

    await page.goto("/projects/p-web-1?view=board");
    await expect(page).toHaveURL(/\/projects\/p-web-1\?view=board/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});

test.describe("Department console primary group reads 'Project Management', not 'Work'", () => {
  test("dept-1 (Web Dev) primary strip + sub-tabs", async ({ page, context }) => {
    await loginAs(page, context, HANSEL);
    await page.goto("/departments/dept-1");

    const primaryStrip = page.getByRole("navigation", { name: "Department sections" });
    // The literal label IS the requirement (2026-08-10 owner decision, PM_RENAMES in
    // pmVocabulary.ts: "Work" -> PM_TERMS.projectManagement) — assert it directly, and assert
    // "Work" is gone, not just that "Project Management" showed up somewhere else on the page.
    await expect(primaryStrip.getByRole("link", { name: "Project Management", exact: true })).toBeVisible();
    await expect(primaryStrip.getByRole("link", { name: "Work", exact: true })).toHaveCount(0);

    await primaryStrip.getByRole("link", { name: "Project Management", exact: true }).click();
    await page.waitForURL(/\/departments\/dept-1\/projects$/);

    const subStrip = page.getByRole("navigation", { name: /project management tools/i });
    for (const label of ["Projects", "Overview", "Ball", "Timeline", "Charts", "Activity"]) {
      await expect(subStrip.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
  });
});

test.describe("Ball tab capability behaviour: positive control beside the negative", () => {
  // The negative alone (seo-staff refused) is satisfiable by a broken render that refuses
  // everyone — the positive control (gede-ic, a plain `member`, allowed) is what actually proves
  // the gate is `pm.contribute`-shaped rather than just "always closed". Both read the SAME
  // /pm?view=ball page so any drift between the two identities is the only variable.
  test("member (gede-ic, holds pm.contribute) sees the Ball board with no refusal note", async ({ page, context }) => {
    await loginAs(page, context, GEDE);
    await page.goto("/pm?view=ball");

    await expect(page.getByText(/can't pass the ball here/i)).toHaveCount(0);
    // Positive evidence the board itself rendered (a real task's ball column), not just "no error".
    await expect(page.getByText("Wire homepage hero")).toBeVisible();
  });

  test("search_staff (seo-staff, holds neither pm.contribute nor pm.manage) is refused", async ({ page, context }) => {
    await loginAs(page, context, SEO_STAFF);
    await page.goto("/pm?view=ball");

    await expect(page.getByText(/can't pass the ball here/i)).toBeVisible();
    // The refusal is advisory, not a wall — the board is still visible underneath (view-only).
    await expect(page.getByText("Wire homepage hero")).toBeVisible();
  });
});

test.describe("Facet filter round-trip: apply, see the chip, Clear all removes it", () => {
  test("department Ball tab: filter by ball holder, see the chip, clear it", async ({ page, context }) => {
    await loginAs(page, context, HANSEL);
    await page.goto("/departments/dept-1/ball");

    // The picklist lives inside a closed <details> disclosure (FacetFilters.tsx) when no filter
    // is active yet — open it (click the <summary>) before the checkbox inside is interactable.
    await page.locator(".pm-facets__summary").click();

    // "Made Putra" (u-dev) holds the ball on several dept-1 tasks (src/lib/demoPm.ts MEMBERS).
    // Scope to the `ball` facet group specifically — "Responsible" is a separate group with the
    // same person as a possible option, so an unscoped name lookup is ambiguous.
    await page.locator('input[name="ball"][value="u-dev"]').check();
    // Scoped to the Filters form specifically — the department Ball page ALSO has its own "Ball
    // focus" form (Whole dept/Division/Just me) with its own same-labelled Apply button.
    await page.getByLabel("Filters").getByRole("button", { name: /^apply$/i }).click();
    await page.waitForURL(/[?&]ball=u-dev/);

    const chip = page.getByRole("link", { name: /remove filter ball: made putra/i });
    await expect(chip).toBeVisible();
    await expect(page.getByText("Ball: Made Putra")).toBeVisible();

    await page.getByRole("link", { name: "Clear all" }).click();
    await page.waitForURL((url) => !url.search.includes("ball=u-dev"));
    await expect(page.getByText("Ball: Made Putra")).toHaveCount(0);
    await expect(chip).toHaveCount(0);
  });
});
