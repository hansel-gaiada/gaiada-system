import { test, expect, type Page, type BrowserContext } from "@playwright/test";

// MI-05 — Web Dev console Requests tab (Build group), over the demo fixture
// (src/lib/demoWebdevChangeRequests.ts). Self-contained logins (no shared storageState) so this one
// file drives BOTH tiers the RBAC AC requires — a manager-tier positive control and a member-tier
// negative control — without depending on the "chromium" project's stored session, same pattern as
// e2e/smoke.spec.ts.
//
// The 409 "already triaged" outcome is deliberately NOT driven end-to-end here: once a CR leaves
// `new`, ChangeRequestsPanel stops rendering Decline/Convert for it at all (`canDispose` reads
// `row.status === "new"`), so a genuine 409 only happens under an actual concurrent race (two
// submits landing before either side's UI has refreshed) — not reproducible by reloading and
// clicking again through a real browser. That banner (and the 501 control_plane banner) are unit-
// tested against a mocked `triage` action instead (ChangeRequestsPanel.test.tsx), which is the right
// layer for a race outcome; this file proves the two REAL round trips (decline, and both convert
// routes) against the live (demo) API.

async function loginAs(page: Page, context: BrowserContext, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/");
  // Web Dev (dept-1) lives under co-agency. `/api/me` (DEMO_MODE) returns the FULL company list for
  // every identity regardless of role scope (demoFixtures.ts's `/api/me` handler — a pre-existing
  // fixture gap unrelated to this ticket, reported rather than fixed here since it's shared,
  // widely-depended-on dispatch code), so a fresh (no-cookie) session's default-tenant fallback
  // (`companies[0]`) always lands on co-holding — even for a company-scoped identity like `gede-ic`,
  // for whom the switcher itself does not even render (`accessibleCompanies` narrows correctly to
  // just co-agency, so `canSwitchCompany` is false for exactly one option). Setting the cookie
  // directly is the established workaround for exactly this (smoke.spec.ts / a11y-axe.spec.ts).
  await context.addCookies([{ name: "gaiada_tenant", value: "co-agency", url: page.url() }]);
}

const REQUESTS_URL = "/departments/dept-1/requests";

test("manager-tier (positive control): sees the triage queue and can decline + convert both routes", async ({ page, context }) => {
  await loginAs(page, context, "hansel@gaiada.com"); // demo-hansel — platform_admin/group_executive, manager-tier
  await page.goto(REQUESTS_URL);
  await expect(page.getByText("Triage queue")).toBeVisible();

  // A `new` row is present and clickable — opens the drawer.
  await page.getByRole("button", { name: "Checkout button unresponsive on Safari" }).click();
  await expect(page.getByText("Kind:")).toBeVisible();

  // Positive control: the triage actions render for this tier.
  await expect(page.getByRole("button", { name: "Convert" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Decline" })).toBeVisible();

  // Decline round-trip against the live (demo) API — requires a reason first.
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText(/needs a reason/i)).toBeVisible();
  await page.getByLabel(/Decline reason/i).fill("Not aligned with this quarter's roadmap.");
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Declined.")).toBeVisible();

  // Reload for a clean render before the next selection — the decline just re-sorted the queue
  // (the declined row drops out of the `new` group), and clicking mid-reflow is flaky.
  await page.reload();

  // Convert round-trip #1 — route=mini_run (§2.3's default for `feature`).
  await page.getByRole("button", { name: "Add a wishlist to the product page" }).click();
  await expect(page.getByText("Route (suggested: Mini pipeline run)")).toBeVisible();
  await page.getByRole("button", { name: "Convert" }).click();
  await expect(page.getByText(/Converted/)).toBeVisible();

  await page.reload();

  // Convert round-trip #2 — route=pm_task (§2.3's default for `content`; needs a project, which this
  // internally-logged CR has, unlike the portal-raised client-wide rows above).
  await page.getByRole("button", { name: "Refresh the About page copy" }).click();
  await expect(page.getByText("Route (suggested: PM task)")).toBeVisible();
  await page.getByRole("button", { name: "Convert" }).click();
  await expect(page.getByText(/Converted/)).toBeVisible();
});

test("member-tier (negative control): reads the queue but the triage actions do not render", async ({ page, context }) => {
  await loginAs(page, context, "gede@gaiada.com"); // demo-hansel's IC sibling — plain `member`, no pm.manage
  await page.goto(REQUESTS_URL);
  await expect(page.getByText("Triage queue")).toBeVisible();

  await page.getByRole("button", { name: "Add a wishlist to the product page" }).click();
  // Positive proof the drawer actually opened (not a broken render satisfying the negative
  // vacuously) — the read-only detail line is present.
  await expect(page.getByText("Kind:")).toBeVisible();

  await expect(page.getByRole("button", { name: "Convert" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Decline" })).toHaveCount(0);
});

// The empty-queue TeachState itself is unit-tested (ChangeRequestsPanel.test.tsx — "shows the
// teach-state when the queue is empty"), since the demo fixture always seeds a non-empty queue for
// this tenant and an e2e test asserting against it would be vacuous.
