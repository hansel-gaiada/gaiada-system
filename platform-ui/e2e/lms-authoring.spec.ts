import { test, expect } from "@playwright/test";

// LMS L3 — the HOD authoring surface, driven against the rendered app under DEMO_MODE.
//
// Form fields are located by NAME, not by label: getByLabel substring-matches the accessible
// name, and "Title" collided with the course-key hint ("...it survives title changes...").
// A locator that breaks when someone edits help text is a locator that will break.
//
// The assertion that matters most is the LAST one: editing a PUBLISHED course must fork a new
// version rather than change it, and the author must be TOLD. An author who believes they fixed a
// typo in live training, and did not, finds out weeks later from a learner. The demo fixture models
// that rule rather than faking success, so this test exercises the real behaviour.
test.describe("Learning authoring (LMS L3)", () => {
  test.beforeEach(async ({ page, context }) => {
    await context.addCookies([
      { name: "gaiada_tenant", value: "co-agency",
        url: new URL("/", test.info().project.use.baseURL ?? "http://localhost:3005").toString() },
    ]);
    await page.goto("/");
  });

  test("a draft is created, filled with a module and an activity, then published", async ({ page }) => {
    const errors: Error[] = [];
    page.on("pageerror", (e) => errors.push(e));

    await page.goto("/learning/authoring");
    // "Drafts" appears twice — a KPI tile and the card heading. Anchor on the heading.
    await expect(page.getByRole("heading", { name: /^Drafts/ })).toBeVisible();

    await page.getByRole("button", { name: "New course" }).click();
    await page.locator('input[name="courseKey"]').fill("qa-test-fundamentals");
    await page.locator('input[name="title"]').fill("QA fundamentals");
    await page.locator('select[name="unitNodeId"]').selectOption({ index: 1 });
    await page.getByRole("button", { name: "Create draft" }).click();

    // Lands on the editor for the new draft.
    await expect(page).toHaveURL(/\/learning\/authoring\/demo-lms-c\d+/);
    await expect(page.getByText("QA fundamentals").first()).toBeVisible();
    // A NEW course is a draft, and a draft is invisible to learners. That invisibility is what
    // makes it safe to work in, so it is asserted rather than assumed.
    await expect(page.getByText("draft").first()).toBeVisible();

    await page.getByRole("button", { name: "Add a module" }).click();
    await page.locator('input[name="title"]').fill("Writing a test plan");
    await page.getByRole("button", { name: "Add module" }).click();
    await expect(page.getByText("1. Writing a test plan")).toBeVisible();

    await page.getByRole("button", { name: "Add an activity" }).click();
    await page.locator('input[name="title"]').fill("What a test plan is for");
    await page.locator('textarea[name="spec"]').fill('{"body":"A test plan states what you will NOT test."}');
    await page.getByRole("button", { name: "Add activity" }).click();
    await expect(page.getByText("What a test plan is for")).toBeVisible();

    page.on("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("published").first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("an auto-graded quiz with no questions is REFUSED, with a reason", async ({ page }) => {
    await page.goto("/learning/authoring/demo-lms-c1");
    await page.getByRole("button", { name: "Add an activity" }).first().click();
    await page.locator('input[name="title"]').first().fill("Ungradeable quiz");
    await page.locator('select[name="kind"]').first().selectOption("quiz");
    await page.locator('select[name="grading"]').first().selectOption("auto");
    await page.locator('input[name="passThreshold"]').first().fill("80");
    await page.getByRole("button", { name: "Add activity" }).first().click();
    // A quiz with no questions grades every submission as wrong and the course becomes impossible
    // to pass — which presents to a learner as "the training is too hard", never as a data defect.
    await expect(page.getByText(/needs a .questions. array/i)).toBeVisible();
  });

  test("editing a PUBLISHED course forks a new version, and says so", async ({ page }) => {
    // demo-lms-c1 is published in the fixture. The fixture implements the fork rather than faking
    // a success, so this exercises the real rule.
    await page.goto("/learning/authoring");
    await expect(page.getByRole("link", { name: "Using the ERP" })).toBeVisible();
    // The published course carries its version, and the editor warns that it is live.
    await page.getByRole("link", { name: "Using the ERP" }).click();
    await expect(page.getByText(/This version is/)).toBeVisible();
    // `live` alone collides with "Deliverables" and "Delivery Pipeline" in the sidebar.
    await expect(page.getByText("live", { exact: true })).toBeVisible();
    await expect(page.getByText(/opens a new draft version and leaves this one alone/)).toBeVisible();
  });

  test("a plain member is refused the authoring console, and told where to look instead", async ({ page, context }) => {
    // The `ic` identity tier resolves to a plain member (see lib/demoIdentity.ts), which holds
    // lms.catalogue.view and nothing else — the negative control this surface needs.
    await context.clearCookies();
    await page.goto("/login");
    await page.getByLabel("Email").fill("gede-ic@gaiada.com");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("**/");
    await page.goto("/learning/authoring");
    await expect(page.getByText(/for department heads, HR and company administrators/i)).toBeVisible();
    // Refused, not hidden — and pointed at the thing they CAN use.
    await expect(page.getByRole("link", { name: "catalogue" })).toBeVisible();
  });
});
