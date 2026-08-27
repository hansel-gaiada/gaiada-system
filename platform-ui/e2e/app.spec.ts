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

  // KPI strip — real numbers DERIVED from the seeded PM demo store, not the P1-06 all-zero
  // placeholders. These literals track `lib/demoPm.ts`, so re-derive them when it changes; that
  // is exactly what was missed here. Active was 2 and is now 3 because the P3-06 fixture added a
  // second dept-1-owned project whose `t-web2-b` is in_progress. Web Dev's three active tasks are
  // `t-4` (u-dev, in_progress), `t-web-b` (assigned to the dept-1-div-1 division) and `t-web2-b` —
  // all genuinely the department's own under the poly-assignee rule in `departments.ts::belongs`,
  // which counts a task assigned to the department, to a division under it, or to a person placed
  // in it. The KPI was right; the literal was stale.
  const kpi = (label: string) => page.locator(".dept-kpi", { hasText: label }).locator(".dept-kpi__value");
  await expect(kpi("Active")).toHaveText("3");
  // "Due soon" is `daysUntil(due) <= 7` with NO lower bound (departments.ts::isDueSoon), so it
  // counts overdue tasks as well as imminent ones. Every seeded due date is now in the past, so
  // this is every not-done task carrying a date — t-4, t-5 (blocked still counts; only `done` is
  // excluded), t-web-b and t-web2-b = 4. It is saturated and therefore stable: it cannot drift
  // further with the calendar, only when the fixture changes.
  await expect(kpi("Due soon")).toHaveText("4");
  await expect(kpi("Blocked")).toHaveText("1");
  // Progress is the MEAN of each owned project's progress (computeDeptKpis), so it moved when
  // P3-06 gave Web Dev a second owned project: it is now avg(p-web-1, p-web-2) = 47%, not the
  // single-project 43%. Same root cause as Active and Due soon above — one fixture addition,
  // three stale literals, and only the first was visible because the assertions run in order.
  await expect(kpi("Progress")).toHaveText("47%");

  // Project health rings. Web Dev owns TWO projects since the P3-06 fixture, not one — so the
  // unqualified /at risk/ lookup below became a strict-mode violation (both rings carry the badge)
  // rather than a genuine assertion failure. Scoped to the named project the assertion is actually
  // about, which is what it always meant; an unscoped getByText that happens to be unique is a
  // latent failure waiting for a second row.
  const ring = page.locator(".dept-ring-card", { hasText: "Client site redesign" });
  await expect(page.getByRole("link", { name: "Client site redesign" })).toBeVisible();
  await expect(ring.getByText(/at risk/i)).toBeVisible();
  await expect(ring.getByText(/overdue.*blocked|blocked.*overdue/i)).toBeVisible();

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
  // Scoped to the gate row: the workspace's open-gate <select> also lists "PRD sign-off (client)".
  await expect(page.locator(".pl-gate-row", { hasText: /prd sign-off \(client\)/i })).toBeVisible();
  await expect(page.getByText(/waiting on client/i).first()).toBeVisible(); // badge + scope summary both say it
});

test("pipeline workspace degrades cleanly with no client linked and decides its own internal gate", async ({ page }) => {
  await page.goto("/pipeline/run-demo-2");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/mobile app revamp/i);

  // KNOWN GAP teach-state: client_id is null on this demo run (mirrors the live dispatcher gap).
  await expect(page.getByText(/no client is linked to this run/i)).toBeVisible();
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
  // run-demo-2 carries no project and no source briefing, so it is NOT a Web Dev row here (it stays
  // on /pipeline). run-demo-1's project is the Web Dev "Client site redesign".
  await expect(page.getByRole("link", { name: "Mobile app revamp — discovery" })).toHaveCount(0);
  await page.getByRole("link", { name: "Northwind — site redesign kickoff", exact: true }).click();
  await page.waitForURL(/\/pipeline\/run-demo-1$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/northwind/i);
});

test("PRD Studio reads as one flow: create → record → convert → approve", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-1/prd");

  // The flow strip names the four beats in the order a person does them.
  const beats = page.getByRole("list", { name: /how a briefing becomes an approved prd/i }).getByRole("listitem");
  await expect(beats).toHaveCount(4);
  await expect(beats.nth(0)).toContainText(/create a briefing/i);
  await expect(beats.nth(3)).toContainText(/get it approved/i);

  // A briefing with no recording yet offers exactly the three ways to add one, and nothing else.
  const intake = page.getByRole("article", { name: "Northwind — checkout flow intake" });
  await expect(intake.getByText("No recording yet")).toBeVisible();
  await expect(intake.getByRole("button", { name: "Record here" })).toBeVisible();
  await expect(intake.getByRole("button", { name: "Desktop capture helper" })).toBeVisible();
  await expect(intake.getByRole("button", { name: "Upload a file" })).toBeVisible();
  await expect(intake.getByRole("button", { name: /convert to prd run/i })).toHaveCount(0);
  await intake.getByRole("button", { name: "Desktop capture helper" }).click();
  await expect(intake.getByText("mtg-northwind-intake")).toBeVisible();

  // A transcribed briefing has one primary action: convert.
  const scope = page.getByRole("article", { name: "Northwind — checkout flow scope call" });
  await expect(scope.getByText("Transcript ready")).toBeVisible();
  await expect(scope.getByRole("button", { name: /convert to prd run/i })).toBeVisible();

  // Web Dev only: the SEO department's transcribed call is not a Web Dev briefing.
  await expect(page.getByRole("article", { name: "Cedar Group — SEO scope call" })).toHaveCount(0);

  // The approvals list shows both beats per run, in plain words (run-demo-1: approved + signed).
  await expect(page.getByRole("heading", { name: /prd runs/i })).toBeVisible();
  await expect(page.getByText(/prd approved and signed — the build is unlocked/i)).toBeVisible();
});

test("PRD Studio: uploading a file streams through the BFF route and flips the briefing to transcribing", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-1/prd");
  const intake = page.getByRole("article", { name: "Northwind — checkout flow intake" });
  await intake.getByRole("button", { name: "Upload a file" }).click();
  const uploadBtn = intake.getByRole("button", { name: "Upload & transcribe" });
  await expect(uploadBtn).toBeDisabled(); // nothing chosen yet
  await intake.getByLabel(/audio or video file/i).setInputFiles({ name: "intake.m4a", mimeType: "audio/mp4", buffer: Buffer.alloc(64 * 1024, 1) });
  await expect(intake.getByText(/intake\.m4a · 1 MB/)).toBeVisible();
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/meetings/rec-demo-4/audio") && r.request().method() === "POST"),
    uploadBtn.click(),
  ]);
  expect(res.status()).toBe(202);
  await expect(intake.getByText("Transcribing")).toBeVisible();
  await expect(intake.getByRole("button", { name: "Upload a file" })).toHaveCount(0);
});

test("PRD Studio: a transcript can be supplied directly — no transcription service involved", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-1/prd");
  const intake = page.getByRole("article", { name: "Northwind — checkout flow intake" });
  await intake.getByRole("button", { name: "Upload a transcript" }).click();
  const save = intake.getByRole("button", { name: "Save transcript" });
  await expect(save).toBeDisabled();
  await intake.getByLabel(/transcript file/i).setInputFiles({
    name: "intake.srt", mimeType: "text/plain",
    buffer: Buffer.from("1\n00:00:01,000 --> 00:00:04,000\nCheckout must drop to two steps.\n\n2\n00:00:04,500 --> 00:00:07,000\nGuest checkout stays.\n"),
  });
  await expect(intake.getByLabel(/paste the transcript/i)).toHaveValue("Checkout must drop to two steps.\nGuest checkout stays.");
  await expect(intake.getByText(/2 lines · 54 characters/)).toBeVisible();
  await save.click();
  await expect(intake.getByText("Transcript ready")).toBeVisible();
  await expect(intake.getByRole("button", { name: /convert to prd run/i })).toBeVisible();
});

test("PRD Studio: when the AI pipeline is not connected, the run can be started by hand", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-1/prd");
  const card = page.getByRole("article", { name: "Northwind — payments follow-up" });
  await expect(card.getByText("Transcript ready")).toBeVisible();
  await card.getByRole("button", { name: /convert to prd run/i }).click();
  await expect(card.getByText(/ai pipeline .*isn.t connected on this platform/i)).toBeVisible();
  await card.getByRole("button", { name: "Start the run without the AI draft" }).click();
  await expect(card.getByText("In the pipeline")).toBeVisible();
  await expect(card.getByRole("link", { name: /open the run/i })).toHaveAttribute("href", /\/pipeline\/run-demo-/);
  // The run is now under approvals, telling the reader what happens next.
  const row = page.locator(".prd-run", { hasText: "Northwind — payments follow-up" });
  await expect(row.getByText(/no prd review yet/i)).toBeVisible();
  await expect(row.getByText(/from briefing: northwind — payments follow-up/i)).toBeVisible();
});

test("PRD Studio exists for Web Dev only — another department's /prd is not found", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-3/prd"); // SEO — its toolkit has no `prd` tab
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/page not found/i);
});

test("PRD Studio: creating a briefing puts it straight into the capture step", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-1/prd");
  await page.getByLabel(/what is this briefing about/i).fill("Playwright — kickoff briefing");
  await page.getByRole("combobox", { name: "Client" }).selectOption({ label: "Northwind Traders" });
  // Default: a Web Dev project is created WITH the briefing, named after it — no picking.
  await expect(page.getByText(/a web dev project “playwright — kickoff briefing” is created for northwind traders/i)).toBeVisible();
  await page.getByRole("radio", { name: "Audio + video" }).click();
  await page.getByRole("button", { name: "Create briefing" }).click();
  await expect(page.getByText(/briefing created with its project — add its recording below/i)).toBeVisible();
  const card = page.getByRole("article", { name: "Playwright — kickoff briefing" });
  await expect(card.getByText("No recording yet")).toBeVisible();
  await expect(card.getByText(/audio \+ video/i)).toBeVisible();
  // The new project shows on the card (it is now in the department's project list).
  await expect(card.getByText(/· Playwright — kickoff briefing/)).toBeVisible();
});

test("Repositories tab is the department's code inventory — repos from provisioned runs, problems first", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-1/repositories");
  await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible();
  // run-demo-1 (Web Dev project) has two provisioned sites in the demo store: one failed, one live.
  await expect(page.getByText("2 repos · 1 live · 1 failed")).toBeVisible();
  const rows = page.locator(".repo-table .lux-table__row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Failed"); // problems first
  await expect(rows.nth(0).getByText(/that name belongs to someone else's site/i)).toBeVisible();
  await expect(rows.nth(0).getByRole("link", { name: /start a new provision/i })).toHaveAttribute("href", "/pipeline/run-demo-1");
  await expect(rows.nth(1).getByRole("link", { name: "northwind-site-redesign-kickoff", exact: true })).toHaveAttribute("href", /github\.com\/Gaia-Digital-Agency\/northwind-site-redesign-kickoff/);
  await expect(rows.nth(1).getByText("Northwind Traders · Client site redesign")).toBeVisible();
  await expect(rows.nth(1).getByText("Live")).toBeVisible();
  await expect(rows.nth(1).getByRole("link", { name: /northwind-site-redesign-kickoff\.gaiada\.online/ })).toBeVisible();
  // GitHub line: the demo persona has an identity-only connection, and the App isn't installed.
  await expect(page.getByText(/github: hansel-gh · identity only/i)).toBeVisible();
  await expect(page.getByText(/commit and pr activity appears once the github app is connected/i)).toBeVisible();
});

test("Repositories tab: Create repository provisions a PRD run and the row appears as Provisioning", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-1/repositories");
  await page.getByRole("button", { name: "Create repository" }).click();
  // Switch to run mode — retried, because a click that lands before hydration is lost.
  const runRadio = page.getByRole("radio", { name: "For a PRD run" });
  await expect(async () => {
    await runRadio.click();
    await expect(page.getByRole("combobox", { name: /prd run/i })).toBeVisible({ timeout: 1_000 });
  }).toPass();
  const runSelect = page.getByRole("combobox", { name: /prd run/i });
  // Only runs without a repository are offered: run-demo-1 has a live site and is never listed.
  await expect(runSelect.locator("option", { hasText: "Northwind — site redesign kickoff" })).toHaveCount(0);
  // run-demo-3 is offered until something provisions it. The demo store lives as long as the dev
  // server, so an earlier run of this test may already have done so — then the create path is
  // skipped and the row it created is checked instead.
  const lumen = runSelect.locator("option", { hasText: "Lumen — portfolio discovery" });
  if ((await lumen.count()) > 0) {
    await runSelect.selectOption({ label: "Lumen — portfolio discovery · Lumen Studio" });
    await expect(page.getByRole("textbox", { name: /repository name/i })).toHaveValue("lumen-portfolio-discovery");
    await page.getByRole("combobox", { name: /framework/i }).selectOption("nextjs");
    await page.getByRole("button", { name: /^create repository$/i }).click();
    await expect(page.getByRole("status")).toContainText(/lumen-portfolio-discovery.*is being provisioned/i);
  }
  const row = page.locator(".repo-table .lux-table__row").filter({ hasText: "lumen-portfolio-discovery" });
  await expect(row).toContainText("Lumen Studio");
  await expect(row).toContainText(/Provisioning|Staging|Live/);
});

test("Repositories tab: a standalone repository is created by hand — no PRD run, no project", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-1/repositories");
  await page.getByRole("button", { name: "Create repository" }).click();
  await expect(page.getByRole("radio", { name: "Standalone" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("combobox", { name: /prd run/i })).toHaveCount(0);
  await page.getByRole("textbox", { name: /repository name/i }).fill("marketing-microsite");
  await page.getByRole("button", { name: /^create repository$/i }).click();
  await expect(page.getByRole("status")).toContainText(/marketing-microsite.*is being provisioned/i);
  const row = page.locator(".repo-table .lux-table__row").filter({ hasText: "marketing-microsite" });
  await expect(row).toContainText("Provisioning");
  await expect(row).toContainText(/not linked to a project · standalone/i);
  await expect(row).toContainText(/created by hand/i);
});

test("Projects tab: New project opens the project form with this department pre-selected", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-1/projects");
  await page.getByRole("link", { name: "New project" }).click();
  await page.waitForURL(/\/projects\/new\?departmentId=dept-1$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/new project/i);
  await expect(page.getByLabel(/owning department/i)).toHaveValue("dept-1");
});

test("Repositories tab: ?preview=sample shows the layout with sample rows behind a banner", async ({ page }) => {
  await switchToAgency(page);
  await page.goto("/departments/dept-1/repositories?preview=sample");
  await expect(page.getByRole("status")).toContainText(/sample data/i);
  await expect(page.locator(".repo-table .lux-table__row")).toHaveCount(5);
  await expect(page.getByText("5 repos · 2 live · 1 on staging · 1 provisioning · 1 failed")).toBeVisible();
  await expect(page.getByRole("button", { name: /check status now/i })).toHaveCount(0); // samples offer no real actions
  await page.getByRole("link", { name: /back to real data/i }).click();
  await page.waitForURL(/\/departments\/dept-1\/repositories$/);
  await expect(page.getByText("2 repos · 1 live · 1 failed")).toBeVisible();
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
