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

// SEQUENCING NOTE — this file runs single-worker, set as `fullyParallel: false` on the `gm` project
// in playwright.config.ts rather than as `mode: "serial"` here.
//
// NOT for shared state — every test here is independent (each signs in fresh, and the GM console is
// read-only). The cause is dev-server COMPILE CONTENTION: `npm run e2e` runs `next dev`, which
// compiles each route on first hit, and this suite touches ~8 distinct routes across two identities.
// At the default 8 workers that first-compile storm pushed navigations past the config's timeouts and
// 22 of 25 tests failed — while the same 25 passed at `--workers=2`.
//
// MEASURED, and the trigger was the app growing around this suite, not a change to it: these tests
// passed 8-worker parallel on 2026-08-24, and failed on 2026-08-25 after the finance workspace and
// LMS player landed (`next build` went 20s -> 72s over the same window). A suite whose green depends
// on the worker count is not evidence — the same conclusion e2e/social-console.spec.ts reached for
// its own (different) race. Trades wall clock for a result that means something.
//
// ⚠ `mode: "serial"` was the FIRST fix and was wrong: it makes every later test in the group SKIP
// when one fails, so a single stale assertion reported "1 failed, 21 did not run" and hid whatever
// else was broken. `fullyParallel: false` gives the identical single-worker sequencing with
// independent pass/fail per test, which is what this suite actually needs.
const GM = "/departments/dept-5"; // GM, co-agency (lib/org.ts's AGENCY_DEPARTMENTS[4] — appended last)
const WEBDEV = "/departments/dept-1"; // Web Dev — the non-GM control

const GM_TABS = ["review", "decisions", "depts", "money", "people"] as const;

// Matches the CONSOLE-WIDE denial specifically, by its distinctive opening clause.
//
// It used to be /limited to group executives/i, which was too loose the moment GM-02b landed: the
// narrowed-view banner and the company-only refusal BOTH contain that phrase for good reason (it is
// the true boundary in all three cases), so the loose pattern reported a narrowed lead as denied.
// Three states need three distinguishable strings, and the test must key on the one it means.
const REFUSAL = /the GM console reads company-grain figures/i;

async function login(page: Page, context: BrowserContext, persona: "superadmin" | "member" | "manager") {
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

  test("the money tab renders real figures, and no longer claims a missing backend", async ({ page, context }) => {
    await login(page, context, "superadmin");
    await page.goto(`${GM}/money`);
    // ⚠ THIS EXPECTATION IS INVERTED FROM ITS ORIGINAL, DELIBERATELY. It used to assert a
    // `BackendPending` banner naming SM-17/SM-22, because no tenant-level money endpoint existed and
    // OQ-3 forbade faking one from the SEO engagement ledger. A real finance module landed
    // (2026-08-26), so the honest state changed and the assertion changed with it. The RULE it was
    // protecting is unchanged and still asserted below: never a fabricated zero.
    await expect(page.getByText("Revenue")).toBeVisible();
    await expect(page.getByText(/SM-17/)).toHaveCount(0);
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

test.describe("the narrowed department-lead view (GM-02b)", () => {
  // A `manager` holds `reports.department.view` but NOT `reports.company.view`. The server narrows
  // department grain to the led subtree, which is why the UI never needs to identify a lead — and why
  // this tier gets the console at all instead of the refusal a member gets.

  test("gets the console, WITHOUT the company tier, and is told so", async ({ page, context }) => {
    await login(page, context, "manager");
    await page.goto(GM);

    // In: the console renders and the department tier is there.
    await expect(page.getByRole("heading", { name: "Departments" })).toBeVisible();
    await expect(page.getByText(REFUSAL)).toHaveCount(0);

    // THE distinction. The company card must be ABSENT — not empty, not zeroed, not a refusal note
    // sitting where numbers go. A department-scoped figure under a company heading is the single
    // misreading this console exists to prevent.
    await expect(page.getByText("The business")).toHaveCount(0);
    // And the absence is stated rather than left for the reader to notice.
    await expect(page.getByText(/scoped to the departments you lead/i)).toBeVisible();
  });

  test("can still switch period — the toggle moves when the company card is gone", async ({ page, context }) => {
    await login(page, context, "manager");
    // The toggle normally rides the company card. If it did not move, a narrowed reader would have no
    // route to a month view except hand-editing the URL.
    await page.goto(GM);
    await expect(page.getByRole("link", { name: "Month" })).toBeVisible();
    await page.getByRole("link", { name: "Month" }).click();
    await expect(page.getByText(/this month/i)).toBeVisible();
  });

  test("the Business Review refuses with the COMPANY-ONLY wording, not the console-wide one", async ({ page, context }) => {
    await login(page, context, "manager");
    await page.goto(`${GM}/review`);
    // The wording matters: "limited to group executives" alone would imply they should not be in the
    // console at all, when in fact every other tab is theirs.
    await expect(page.getByText(/reports on the company as a whole/i)).toBeVisible();
    await expect(page.getByText(/the rest of the GM console is scoped to the departments you lead/i)).toBeVisible();
  });

  for (const tab of ["decisions", "depts", "money", "people"] as const) {
    test(`the ${tab} tab is available to a narrowed lead`, async ({ page, context }) => {
      await login(page, context, "manager");
      await page.goto(`${GM}/${tab}`);
      await expect(page.getByText(REFUSAL)).toHaveCount(0);
      await expect(page.getByText(/page not found/i)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Oversight" })).toBeVisible();
    });
  }
});

test.describe("the money tier (GM-09)", () => {
  // Unblocked 2026-08-26: a real double-entry finance module landed, so revenue and margin now come
  // from the ledger's own P&L totals. The blocked-era `BackendPending` banner is gone.

  test("the cockpit answers 'are we making money?' from the books", async ({ page, context }) => {
    await login(page, context, "superadmin");
    await page.goto(GM);
    await expect(page.getByText("Revenue")).toBeVisible();
    await expect(page.getByText("Net margin")).toBeVisible();
    await expect(page.getByText("Overdue receivables")).toBeVisible();
    // The old blocked-state banner must be GONE — leaving it would tell a GM the figures beside it
    // are unavailable while they are being rendered.
    await expect(page.getByText(/SM-17/)).toHaveCount(0);
  });

  test("money sits BELOW the operating tiers, not above them", async ({ page, context }) => {
    await login(page, context, "superadmin");
    await page.goto(GM);
    // Amazon's cadence rule, and the reason the card is ordered where it is: inputs and outputs
    // first, financials last. Asserted on the CARD HEADINGS rather than on raw page text — the first
    // attempt searched `main`'s innerText for "Departments" and matched the breadcrumb
    // ("Home / Organization / Departments / GM"), which sits above everything and made the assertion
    // meaningless. Headings are the thing being ordered, so they are the thing to assert on.
    const headings = await page.locator("h2, h3").allTextContents();
    const at = (t: string) => headings.findIndex((h) => h.trim() === t);
    expect(at("The business"), "the business card must render").toBeGreaterThanOrEqual(0);
    expect(at("Money"), "the money card must render").toBeGreaterThanOrEqual(0);
    expect(at("Departments"), "the departments card must render").toBeGreaterThanOrEqual(0);
    expect(at("The business")).toBeLessThan(at("Money"));
    expect(at("Departments")).toBeLessThan(at("Money"));
  });

  test("the money tab shows the full view, month-to-date", async ({ page, context }) => {
    await login(page, context, "superadmin");
    await page.goto(`${GM}/money`);
    await expect(page.getByText("Revenue")).toBeVisible();
    await expect(page.getByText("Client portfolio")).toBeVisible();
  });

  test("a narrowed department lead sees NO money — finance is a separate boundary", async ({ page, context }) => {
    // THE negative that matters. `manager` holds `reports.department.view` (so the console opens)
    // but NOT `finance.statement.read` — the finance holders are company_admin, finance_manager,
    // finance_staff, owner and platform_admin. Folding money into the console's access state would
    // have handed every department lead the company's P&L.
    await login(page, context, "manager");
    await page.goto(GM);
    await expect(page.getByRole("heading", { name: "Departments" })).toBeVisible();
    await expect(page.getByText("Net margin")).toHaveCount(0);
    await expect(page.getByText("Overdue receivables")).toHaveCount(0);
  });

  test("and is told why on the tab, where they actually asked", async ({ page, context }) => {
    await login(page, context, "manager");
    await page.goto(`${GM}/money`);
    // Silence is right on the home screen and wrong here: this is the tab you open TO ask about
    // money, so the refusal is stated rather than rendered as an absence.
    await expect(page.getByText(/limited to finance and administrator roles/i)).toBeVisible();
    // The rest of the tab still works for them.
    await expect(page.getByText("Client portfolio")).toBeVisible();
  });
});

test.describe("client monitoring (B3)", () => {
  // Plane B — the CLIENT's properties and services, the work the agency sells. Our own
  // infrastructure (Prometheus/Grafana/Loki/Tempo) is Plane A, lives outside the ERP behind an SSH
  // tunnel, and is deliberately absent from this console. B3 sat "blocked: monitoring has no backend"
  // all build; the module shipped one, which is the third stale blocker this program found this week.

  test("the cockpit carries client health, above the money tier", async ({ page, context }) => {
    await login(page, context, "superadmin");
    await page.goto(GM);
    await expect(page.getByRole("heading", { name: "Client monitoring" })).toBeVisible();
    await expect(page.getByText("Needs attention")).toBeVisible();
    await expect(page.getByText("Open incidents")).toBeVisible();

    // Cadence order: operating signals before financial outcomes. Asserted on headings so a
    // refactor cannot quietly reorder it — the same assertion style that caught the money card
    // shipping in the wrong place.
    const headings = await page.locator("h2, h3").allTextContents();
    const at = (t: string) => headings.findIndex((h) => h.trim() === t);
    expect(at("Client monitoring")).toBeGreaterThanOrEqual(0);
    expect(at("Client monitoring")).toBeLessThan(at("Money"));
    expect(at("Departments")).toBeLessThan(at("Client monitoring"));
  });

  test("a narrowed department lead sees it too — monitoring is not company-grain", async ({ page, context }) => {
    // Deliberate asymmetry with the money tier: `monitoring.read` on the backend is the boundary and
    // the sidebar row is ungated for every principal, so gating it here would hide a surface the
    // server serves. Client health is not a company-grain financial figure.
    await login(page, context, "manager");
    await page.goto(GM);
    await expect(page.getByRole("heading", { name: "Client monitoring" })).toBeVisible();
    // …while money still stays out of their view.
    await expect(page.getByText("Net margin")).toHaveCount(0);
  });
});
