import { test, expect, type Page } from "@playwright/test";

function sidebar(page: Page) {
  return page.locator(".erp-side");
}

test("My Work dashboard loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("sidebar navigates the business modules", async ({ page }) => {
  await page.goto("/");
  // Nav groups collapse; Business holds these four and starts closed on the dashboard.
  // 2026-08-10 (commit c89fed6): Business's separate "Projects"/"Tasks" rows collapsed into one
  // "Project Management" entry (PM_TERMS.projectManagement) pointing at /project-management,
  // which carries Projects/Tasks as tabs instead — see e2e/pm-unified-interface.spec.ts for
  // coverage of that surface's own tab set/deep-links. Updated here so this pre-existing test
  // matches the shipped nav rather than asserting sidebar rows that no longer exist.
  await sidebar(page).getByRole("button", { name: "Business" }).click();
  // Scoped to #nav-business: Workspace's OWN row (`/pm`) carries the identical "Project
  // Management" label (PM_TERMS.projectManagement, same string everywhere on purpose) and
  // Workspace is pinned open, so an unscoped lookup is ambiguous between the two rows.
  const business = page.locator("#nav-business");
  for (const [label, heading] of [
    ["Project Management", /project management/i],
    ["Deliverables", /deliverables/i],
    ["Agency", /agency|campaign/i],
  ] as const) {
    await business.getByRole("link", { name: label, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
  }
  // Workspace is pinned: its daily rows stay open away from the dashboard too.
  await expect(sidebar(page).getByRole("link", { name: "Calendar", exact: true })).toBeVisible();
});

test("global search returns cross-entity results", async ({ page }) => {
  await page.goto("/");
  // "gaia" matches companies, which are searched across every tenant the
  // user can access (independent of the active company).
  await page.getByLabel("Search").fill("gaia");
  await page.getByLabel("Search").press("Enter");
  await page.waitForURL("**/search?q=gaia");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/results for/i);
  await expect(page.getByRole("link", { name: /Gaia Digital Agency/i }).first()).toBeVisible();
});

test("notifications surface shows items and unread badge", async ({ page }) => {
  await page.goto("/");
  // Scoped to the top bar: a demo task is titled "Push notifications spike".
  const bell = page.locator(".erp-top").getByRole("link", { name: /notifications/i });
  await expect(bell).toBeVisible();
  await bell.click();
  await page.waitForURL("**/notifications");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/notifications/i);
  await expect(page.getByText(/approval requested/i)).toBeVisible();
});

test("admin audit lists activity and filters", async ({ page }) => {
  await page.goto("/admin/audit");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/audit/i);
  await expect(page.getByRole("form", { name: /audit filters/i })).toBeVisible();
  // At least one activity row is rendered.
  await expect(page.locator(".lux-table__row").first()).toBeVisible();
});

test("account page + density preference", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /clement hansel/i }).click();
  const acct = page.getByRole("menuitem", { name: /account settings/i });
  await expect(acct).toBeVisible();
  await acct.click();
  await page.waitForURL("**/account");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/your profile/i);

  await page.locator('select[name="density"]').selectOption("compact");
  await page.getByRole("button", { name: /^save$/i }).click();
  await expect(page.locator(".erp-app")).toHaveAttribute("data-density", "compact");

  // Reset back to comfortable so other runs start clean.
  await page.locator('select[name="density"]').selectOption("comfortable");
  await page.getByRole("button", { name: /^save$/i }).click();
});

test("people directory opens an employee 360", async ({ page }) => {
  // The directory lives in the HR console (/people redirects there), not the sidebar.
  await page.goto("/people");
  await page.waitForURL("**/hr/people");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/hr/i);
  // Open a colleague from the directory.
  await page.getByRole("link", { name: "Made Putra" }).click();
  await page.waitForURL(/\/people\/u-dev/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/made putra/i);
  await expect(page.getByText(/open tasks/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Assigned tasks", exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: /projects owned/i })).toBeVisible();
});

test("company org builder shows agency departments and editor", async ({ page }) => {
  await page.goto("/companies/co-agency/org");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/org structure/i);
  // Seeded agency departments appear in the preview chart.
  for (const dept of ["Web Dev", "Creatives", "SEO", "Social Media"]) {
    await expect(page.getByText(dept, { exact: true }).first()).toBeVisible();
  }
  // Elevated viewer gets the editor (Save button present).
  await expect(page.getByRole("button", { name: /save structure/i })).toBeVisible();
});

test("account links to own employee page", async ({ page }) => {
  await page.goto("/account");
  await page.getByRole("link", { name: /my employee page/i }).click();
  await page.waitForURL(/\/people\/demo-hansel/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/clement hansel/i);
  await expect(page.getByText("You", { exact: true })).toBeVisible();
});

async function switchToAgency(page: Page) {
  await page.goto("/");
  // The switcher auto-submits a server action (no URL change, so waitForURL/
  // networkidle are both unreliable signals here — Next dev's HMR socket
  // keeps the connection non-idle). Wait for the action's own POST instead.
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    page.getByLabel("Active company").selectOption({ label: "Gaia Digital Agency" }),
  ]);
}

test("department Home shows live KPIs, a project health ring, activity feed, and the rail", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-1");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/web dev/i);

  // KPI strip — real numbers from the seeded PM demo store (Active=2, Due
  // soon=3, Blocked=1 across the department's own tasks; Progress=43% from
  // the one owned project), not the P1-06 all-zero placeholders.
  const kpi = (label: string) => page.locator(".dept-kpi", { hasText: label }).locator(".dept-kpi__value");
  await expect(kpi("Active")).toHaveText("2");
  await expect(kpi("Due soon")).toHaveText("3");
  await expect(kpi("Blocked")).toHaveText("1");
  await expect(kpi("Progress")).toHaveText("43%");

  // Project health ring for the one owned project, flagged at risk.
  await expect(page.getByRole("link", { name: "Client site redesign" })).toBeVisible();
  await expect(page.getByText(/at risk/i)).toBeVisible();
  await expect(page.getByText(/overdue.*blocked|blocked.*overdue/i)).toBeVisible();

  // Activity feed — real F2 rows for this department, not the empty teach-state.
  await expect(page.getByText("Task: Wire homepage hero")).toBeVisible();
  await expect(page.getByText(/no activity yet/i)).toHaveCount(0);

  // The persistent rail (rendered once in the layout) shows real "waiting on
  // me" data: pending agency approvals + WS4 automation approvals.
  await expect(page.getByText(/waiting on me/i)).toBeVisible();
  await expect(page.getByText("Landing page copy brief")).toBeVisible();
});

test("department Activity tab filters by project and person", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-1/activity");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/web dev/i);
  await expect(page.getByRole("form", { name: /activity filters/i })).toBeVisible();
  await expect(page.getByText("Task: Wire homepage hero")).toBeVisible();

  // Filtering to a person with no activity in this department empties the feed.
  await page.locator('select[name="personId"]').selectOption({ label: "Dewi Santoso" });
  await page.getByRole("button", { name: /^apply$/i }).click();
  await page.waitForURL(/personId=u-pm/);
  await expect(page.getByText(/no activity matches these filters/i)).toBeVisible();

  // Resetting clears the filter and the feed shows rows again.
  await page.getByRole("link", { name: /reset/i }).click();
  await page.waitForURL(/\/departments\/dept-1\/activity$/);
  await expect(page.getByText("Task: Wire homepage hero")).toBeVisible();
});

test("pipeline list links a run into its workspace (client-linked, pending client gate)", async ({ page }) => {
  await page.goto("/pipeline");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/delivery pipeline/i);
  await page.getByRole("link", { name: "Northwind — site redesign kickoff" }).click();
  await page.waitForURL(/\/pipeline\/run-demo-1$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/northwind/i);

  // Plain-language blockage — the scope sign-off is the pending (client) beat.
  await expect(page.getByText(/waiting on the client: scope sign-off/i)).toBeVisible();

  // Links: the source meeting resolves to a real /meetings/[id] link; the client is named (not a
  // dead link — staff can't open the client's own portal from here, so it's informational).
  await expect(page.getByRole("link", { name: "Northwind — site redesign kickoff" })).toHaveAttribute("href", "/meetings/rec-demo-1");
  await expect(page.getByText(/tracked in their project portal/i)).toBeVisible();

  // All three tracks render with their done stages, confidence, and rendered markdown artifacts.
  await expect(page.getByText(/prd extract.*done.*90%/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: /site redesign PRD/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /scope agreement/i })).toBeVisible();

  // Gate history: the decided prd_sign + the pending scope_signoff both show, correctly labeled.
  await expect(page.getByText(/prd sign-off \(client\)/i)).toBeVisible();
  await expect(page.getByText(/waiting on client/i)).toBeVisible();
});

test("pipeline workspace degrades cleanly with no client linked and decides its own internal gate", async ({ page }) => {
  await page.goto("/pipeline/run-demo-2");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/mobile app revamp/i);

  // KNOWN GAP teach-state: client_id is null on this demo run (mirrors the live dispatcher gap).
  await expect(page.getByText(/no client is linked to this run yet/i)).toBeVisible();
  await expect(page.getByText(/no source meeting linked/i)).toBeVisible();

  // Both un-drafted stages (scope + report) degrade to the empty note, not a blank/broken panel.
  await expect(page.getByText(/no artifact for this stage yet/i)).toHaveCount(2);

  // The pending PM review is an INTERNAL gate — the workspace itself can decide it (elevated user).
  await expect(page.getByText(/waiting on internal review: pm review/i)).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/in progress — no gate is currently open/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
});

test("PRD Studio run rows deep-link into the pipeline workspace", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-1/prd");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/web dev/i);
  await expect(page.getByRole("heading", { name: /prd runs/i })).toBeVisible();
  await page.getByRole("link", { name: "Mobile app revamp — discovery" }).click();
  await page.waitForURL(/\/pipeline\/run-demo-2$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/mobile app revamp/i);
});

test("a meeting recording links to its ingested pipeline run", async ({ page }) => {
  await page.goto("/meetings/rec-demo-1");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/northwind/i);
  await page.getByRole("link", { name: /open run workspace/i }).click();
  await page.waitForURL(/\/pipeline\/run-demo-1$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/northwind/i);
});

test("the sidebar collapses to a labelled icon rail and stays collapsed", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Dashboard" })).toContainText("Dashboard");

  await page.getByRole("button", { name: "Close sidebar" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
  await expect(page.getByRole("link", { name: "Dashboard" }).locator("span")).toBeHidden();

  await page.getByRole("link", { name: "Approvals" }).first().hover();
  await expect(page.locator(".erp-railtip")).toHaveText("Approvals");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-sidebar", "collapsed");
});

test("rail categories open a flyout by click, hover and keyboard", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Close sidebar" }).click();

  const flyout = page.locator(".erp-railmenu");
  const category = (name: string) => sidebar(page).getByRole("button", { name, exact: true });

  await category("Business").click();
  await expect(flyout).toContainText("Delivery Pipeline");

  // Escape closes and hands focus back; hover then opens a different category,
  // and only one panel is ever open.
  await page.keyboard.press("Escape");
  await expect(category("Business")).toBeFocused();
  await category("Systems").hover();
  await expect(flyout).toHaveCount(1);
  await expect(flyout).toContainText("MCP Hub");

  // Hover must not steal focus, so the keyboard walk starts from the category itself.
  await category("Systems").focus();
  await page.keyboard.press("ArrowDown");
  await expect(flyout.getByRole("link", { name: "WA/TG Bot" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(flyout.getByRole("link", { name: "AI Gateway" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForURL("**/systems/gateway");
  await expect(flyout).toHaveCount(0);
});

test("sign out returns to login", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /clement hansel/i }).click();
  const signOut = page.getByRole("menuitem", { name: /sign out/i });
  await expect(signOut).toBeVisible();
  await signOut.click();
  await page.waitForURL("**/login", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});

test("the mobile drawer keeps labels even when the desktop rail is collapsed", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Close sidebar" }).click();
  await page.setViewportSize({ width: 420, height: 820 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(sidebar(page).getByRole("button", { name: "Business" })).toBeVisible();
  await sidebar(page).getByRole("button", { name: "Business" }).click();
  // c89fed6 collapsed Business's "Projects" row into "Project Management" — see the note on
  // "sidebar navigates the business modules" above. Scoped to #nav-business: Workspace's own
  // pinned-open row (/pm) carries the identical label.
  await expect(page.locator("#nav-business").getByRole("link", { name: "Project Management", exact: true })).toBeVisible();
  await expect(page.locator(".erp-railmenu")).toHaveCount(0);
});
