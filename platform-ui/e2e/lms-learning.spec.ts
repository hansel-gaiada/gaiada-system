import { test, expect } from "@playwright/test";

// LMS L1c. Drives the four learning surfaces against the real rendered app under DEMO_MODE, because
// a green vitest run has never proved a Next.js route renders — a `server-only` import reaching a
// client component passes tsc and vitest and 500s in the browser.
//
// What is asserted is CONTENT, not status codes: every one of these pages has an empty state that
// renders happily on a 404, so "it loaded" would pass with the whole module dark. The fixtures in
// lib/demoLms.ts carry deliberately imperfect numbers (one overdue required path, coverage under
// 100%) so the warning paths are the ones under test.
// Runs in the `chromium` project, so it inherits auth.setup.ts's stored staff session — it does
// NOT sign in itself. That matters: the identity tier is what decides whether Compliance is
// reachable at all, and a hand-rolled login here would fork the one place that decision is made.
test.describe("Learning (LMS L1c)", () => {
  test.beforeEach(async ({ page, context }) => {
    await context.addCookies([
      // Absolute URL required by addCookies; built from the configured baseURL so an
      // E2E_PORT-shifted run (a sibling agent already on 3005) still sets the cookie.
      { name: "gaiada_tenant", value: "co-agency", url: new URL("/", test.info().project.use.baseURL ?? "http://localhost:3005").toString() },
    ]);
    await page.goto("/");
  });

  test("the module front door lists what is published", async ({ page }) => {
    const errors: Error[] = [];
    page.on("pageerror", (e) => errors.push(e));

    await page.goto("/learning");
    // Four published paths in the fixture — if the module read 404'd, soft() would show 0 and the
    // "nothing published yet" card instead.
    await expect(page.getByText("Nothing published yet")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Browse" })).toBeVisible();
    await expect(page.getByText(/module is switched off/i)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("the catalogue shows courses, paths and the level filter", async ({ page }) => {
    await page.goto("/learning/catalogue");
    await expect(page.getByRole("link", { name: "Using the ERP" })).toBeVisible();
    await expect(page.getByText("Everyone: the fundamentals")).toBeVisible();
    // The level axis is what makes this "all levels" — management sits alongside the hands-on work.
    await page.getByRole("link", { name: /Lead \/ management/ }).click();
    await expect(page).toHaveURL(/level=lead/);
    await expect(page.getByRole("link", { name: "Running a department" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Using the ERP" })).toHaveCount(0);
  });

  test("a course page renders its modules and activities in order", async ({ page }) => {
    await page.goto("/learning/catalogue");
    await page.getByRole("link", { name: "Using the ERP" }).click();
    await expect(page).toHaveURL(/\/learning\/courses\/demo-lms-c1/);
    await expect(page.getByText("1. Finding your way around")).toBeVisible();
    await expect(page.getByText("2. Doing your own admin")).toBeVisible();
    // An attempt cap and a pass mark are facts the learner needs BEFORE the first attempt.
    await expect(page.getByText(/pass at 0\.80/)).toBeVisible();
    await expect(page.getByText(/3 attempts/)).toBeVisible();
  });

  test("my learning warns about outstanding mandatory training", async ({ page }) => {
    await page.goto("/me/learning");
    // The single most consequential thing this surface can get wrong is telling somebody they have
    // nothing assigned. The fixture has one overdue required path; assert it is SAID, not merely
    // that the page loaded.
    await expect(page.getByText("Security awareness")).toBeVisible();
    await expect(page.getByText(/overdue/i).first()).toBeVisible();
    await expect(page.getByText("Everyone: the fundamentals")).toBeVisible();
  });

  test("compliance reports coverage below 100% and counts waivers apart", async ({ page }) => {
    await page.goto("/learning/compliance");
    await expect(page.getByText(/restricted to HR/i)).toHaveCount(0);
    await expect(page.getByText("Mandatory coverage")).toBeVisible();
    // 30 of 46 mandatory enrolments completed — the point is that it is NOT rendered as compliant.
    await expect(page.getByText("65%")).toBeVisible();
    // Two tables (required, then all paths) both carry the column, hence .first(). The point of
    // the assertion is that waivers get a column of their OWN rather than being folded into
    // "completed" — being excused is not the same as having passed.
    await expect(page.getByText("Waived").first()).toBeVisible();
    await expect(page.getByText("nobody is enrolled")).toHaveCount(0);
  });
});
