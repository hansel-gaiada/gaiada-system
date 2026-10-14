import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { loginAsPersona } from "./personas";
import { tenantCookie } from "./appCookies";

// DW-7a/7b/7c: what the HR, Finance and IT workspaces' sidebars actually draw under DEMO_MODE, walked row by row.
//
// Facts (same as workspace-departments.spec.ts, which DW-6 owns and this file does not touch): the demo company is
// `co-agency`; since DW-7d its org tree also holds HR (dept-6), Finance (dept-7) and IT (dept-8), so these three are
// departments with a department id and their Project Management row is offered. The superadmin (hansel@gaiada.com,
// platform_admin) holds every capability, so every capability-gated row and tab shows.
//
// The expected labels are copied from the registry (`lib/workspaces.ts`: HR, FINANCE, IT), in order, WITHOUT anything
// that carries a `ticket` (the shell does not draw those: Finance's "Revenue, AR and cash" analytics tab, and the Pulse
// tiles). Every list is matched as an ORDERED SUBSEQUENCE, never as equality, so a row or tab added later (DW-7e..7k)
// does not break this file, and nothing here asserts that a ticketed item is absent.

async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}

/** The pilot switch, written the way lib/prefs.ts reads it (see workspace-shell.spec.ts). */
function pilotCookie(at: string) {
  return { name: "gaiada_prefs", value: encodeURIComponent(JSON.stringify({ shell: "workspaces" })), url: new URL("/", at).toString() };
}

async function signIn(page: Page, context: BrowserContext, persona: "superadmin" | "member") {
  await loginAsPersona(page, persona);
  await context.addCookies([tenantCookie(page.url()), pilotCookie(page.url())]);
}

const menu = (page: Page, title: string) => page.getByRole("navigation", { name: `${title} menu`, exact: true });
// Exact: a substring match would let "Section" (the console's strip) match every "<row> sections".
const strip = (page: Page, rowLabel: string) => page.getByRole("navigation", { name: `${rowLabel} sections`, exact: true });
const workGroup = (nav: Locator) => nav.getByRole("group", { name: "Work", exact: true });
const performanceGroup = (nav: Locator) => nav.getByRole("group", { name: "Performance", exact: true });
const current = (nav: Locator) => nav.locator('[aria-current="page"]');

/** The console's own strips, which the pilot shell hides because its rows offer every tab (plan §2.6 rule 1). */
const consoleStrips = (page: Page) => [
  page.getByRole("navigation", { name: "Section", exact: true }), // HR, IT and IT's network (SectionTabs)
  page.getByRole("navigation", { name: "Finance sections", exact: true }), // FinanceTabs
];
async function expectNoConsoleStrip(page: Page, where: string) {
  for (const s of consoleStrips(page)) await expect(s, `${where}: the console's own strip must not double the shell's`).toHaveCount(0);
}

async function texts(links: Locator): Promise<string[]> {
  return (await links.allTextContents()).map((t) => t.trim());
}

/** True when `expected` appears in `actual` in this order (other items may sit between and around). */
function isSubsequence(expected: readonly string[], actual: readonly string[]): boolean {
  let i = 0;
  for (const a of actual) if (i < expected.length && a === expected[i]) i++;
  return i === expected.length;
}

/** Polls the links' texts until they hold `expected` as an ordered subsequence; the failure message shows both. */
async function expectSubsequence(links: Locator, expected: readonly string[]) {
  await expect
    .poll(async () => {
      const actual = await texts(links);
      return isSubsequence(expected, actual) ? "ok" : `expected ${JSON.stringify(expected)} in order within ${JSON.stringify(actual)}`;
    })
    .toBe("ok");
}

interface RowSpec {
  /** The sidebar row's label. */
  row: string;
  /** The tabs the registry draws today, in order. Omit for a single-tab row (a plain link, no strip). */
  tabs?: readonly string[];
  /** A tab to click into (not the first), and the URL it lands on. The row must stay current. */
  click?: { tab: string; url: RegExp };
}

interface WorkspaceSpec {
  path: string;
  title: string;
  rows: readonly RowSpec[];
}

// Project Management (PM_ROW): offered since DW-7d gave HR, Finance and IT a department id.
const PM: RowSpec = { row: "Project Management", tabs: ["Projects", "Board", "Ball", "Timeline", "Activity"], click: { tab: "Activity", url: /\/activity$/ } };
const TOOLS: RowSpec = { row: "Tools & connections" };

const WORKSPACES: readonly WorkspaceSpec[] = [
  {
    // HR in lib/workspaces.ts. Settings sits in Cases & compliance; Appraisal cycles is a gated tab of Talent (a route HR owns).
    path: "/hr",
    title: "HR",
    rows: [
      PM,
      { row: "People", tabs: ["Directory", "Onboarding", "Org structure"], click: { tab: "Onboarding", url: /\/hr\/onboarding$/ } },
      { row: "Time", tabs: ["Leave", "Attendance"], click: { tab: "Attendance", url: /\/hr\/attendance$/ } },
      { row: "Pay", tabs: ["Compensation", "Payroll"], click: { tab: "Payroll", url: /\/hr\/payroll$/ } },
      { row: "Talent", tabs: ["Recruitment", "Reviews", "Appraisal cycles"], click: { tab: "Reviews", url: /\/hr\/reviews$/ } },
      { row: "Cases & compliance", tabs: ["Cases", "Compliance", "Settings"], click: { tab: "Compliance", url: /\/hr\/compliance$/ } },
      TOOLS,
    ],
  },
  {
    // FINANCE. The money analytics tab is ticketed (DW-7b), so it is not listed; Financial statements is in Reports, below.
    path: "/finance",
    title: "Finance",
    rows: [
      PM,
      { row: "Ledger", tabs: ["Journals", "General ledger", "Chart of accounts"], click: { tab: "General ledger", url: /\/finance\/ledger$/ } },
      { row: "Receivables", tabs: ["Receivables", "Invoices"], click: { tab: "Invoices", url: /\/invoices$/ } },
      { row: "Payables" },
      { row: "Treasury & assets", tabs: ["Treasury", "Fixed assets"], click: { tab: "Fixed assets", url: /\/finance\/assets$/ } },
      { row: "Tax" },
      { row: "Close", tabs: ["Period close", "Consolidation", "Ownership", "Cutover", "Settings", "Billing profile"], click: { tab: "Consolidation", url: /\/finance\/consolidation$/ } },
      TOOLS,
    ],
  },
  {
    // IT. The network strip's pages are labelled fixtures in demo mode; only the routes are asserted.
    path: "/it",
    title: "IT",
    rows: [
      PM,
      { row: "Devices" },
      { row: "Network", tabs: ["Topology", "Traffic", "Threats", "Isolation", "Occupancy"], click: { tab: "Threats", url: /\/it\/network\/threats$/ } },
      { row: "IT accounts" },
      { row: "Workflows" },
      TOOLS,
    ],
  },
];

test.describe("HR, Finance and IT workspaces (superadmin, pilot shell)", () => {
  for (const ws of WORKSPACES) {
    test(`${ws.title}: the Work menu draws the registry's rows in order, each multi-tab row has its strip, and the console's own strip is gone`, async ({ page, context }) => {
      await signIn(page, context, "superadmin");
      await page.goto(ws.path);
      const nav = menu(page, ws.title);
      await expect(nav).toBeVisible();

      await expect(nav.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(current(nav)).toHaveCount(1);
      await expectNoConsoleStrip(page, `${ws.title} Overview`);

      await expectSubsequence(workGroup(nav).getByRole("link"), ws.rows.map((r) => r.row));
      await expectSubsequence(performanceGroup(nav).getByRole("link"), ["Reports", "Analytics", "Appraisals", "Learning"]);

      for (const r of ws.rows) {
        if (!r.tabs) continue;
        const rowLink = workGroup(nav).getByRole("link", { name: r.row, exact: true });
        await hydrated(rowLink);
        await rowLink.click();
        const tabStrip = strip(page, r.row);
        await expect(tabStrip, `${ws.title} › ${r.row}: the shell's tab strip`).toBeVisible();
        await expect(rowLink).toHaveAttribute("aria-current", "page");
        await expectSubsequence(tabStrip.getByRole("link"), r.tabs);
        // Landing on the row marks exactly one of its tabs current.
        await expect(current(tabStrip)).toHaveCount(1);
        await expectNoConsoleStrip(page, `${ws.title} › ${r.row}`);

        if (r.click) {
          const tab = tabStrip.getByRole("link", { name: r.click.tab, exact: true });
          await hydrated(tab);
          await tab.click();
          await expect(page).toHaveURL(r.click.url);
          // The row stays current on the tab's page, whether it is under the department or a route the workspace owns.
          await expect(menu(page, ws.title).getByRole("link", { name: r.row, exact: true })).toHaveAttribute("aria-current", "page");
          await expect(current(workGroup(menu(page, ws.title)))).toHaveCount(1);
          await expectNoConsoleStrip(page, `${ws.title} › ${r.row} › ${r.click.tab}`);
        }
      }
    });
  }

  test("Finance's Reports row holds the financial statements (the old Reports tab, DW-7b)", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/finance");
    const reports = performanceGroup(menu(page, "Finance")).getByRole("link", { name: "Reports", exact: true });
    await hydrated(reports);
    await reports.click();
    const tabStrip = strip(page, "Reports");
    await expect(tabStrip).toBeVisible();
    await expectSubsequence(tabStrip.getByRole("link"), ["Financial statements"]);

    const statements = tabStrip.getByRole("link", { name: "Financial statements", exact: true });
    await hydrated(statements);
    await statements.click();
    await expect(page).toHaveURL(/\/finance\/reports$/);
    await expect(statements).toHaveAttribute("aria-current", "page");
    await expect(performanceGroup(menu(page, "Finance")).getByRole("link", { name: "Reports", exact: true })).toHaveAttribute("aria-current", "page");
    await expectNoConsoleStrip(page, "Finance › Reports");
  });

  test("HR's Analytics row includes People analytics (the old Analytics tab, DW-7a)", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/hr");
    const analytics = performanceGroup(menu(page, "HR")).getByRole("link", { name: "Analytics", exact: true });
    await hydrated(analytics);
    await analytics.click();
    const tabStrip = strip(page, "Analytics");
    await expect(tabStrip).toBeVisible();
    await expectSubsequence(tabStrip.getByRole("link"), ["People analytics"]);

    const people = tabStrip.getByRole("link", { name: "People analytics", exact: true });
    await hydrated(people);
    await people.click();
    await expect(page).toHaveURL(/\/hr\/analytics$/);
    await expect(people).toHaveAttribute("aria-current", "page");
    await expectNoConsoleStrip(page, "HR › Analytics");
  });
});

// A plain member (gede@gaiada.com, `member` only) opens each console in the pilot. Only what DW-7a/7b/7c GATE is
// asserted absent, through the capability each gate mirrors (a member holds none of them): HR's Onboarding, Recruitment,
// Compliance and People analytics (`hr.view`, `hr.recruitment.view`), Pay (`hr.payroll.view`), Finance's Receivables,
// Consolidation (`finance.ar.view`, `finance.statement.view`), IT's accounts and workflows (`it.manage`). What a member's
// page can read (Leave, their cases, Reviews, Settings, the Directory, Devices) is not asserted either way.
// The console's own strip is asserted absent for them too: the shell counts the tabs it withholds from a member as covered
// (`withheld`), so one strip draws and never two.
test.describe("HR, Finance and IT workspaces (plain member, pilot shell)", () => {
  test("HR: no Pay row, and no Onboarding, Recruitment, Compliance or People analytics tab", async ({ page, context }) => {
    await signIn(page, context, "member");
    await page.goto("/hr");
    const nav = menu(page, "HR");
    await expect(nav).toBeVisible();
    await expectNoConsoleStrip(page, "HR (member) Overview");
    const work = workGroup(nav);
    await expectSubsequence(work.getByRole("link"), ["People", "Time", "Talent", "Cases & compliance"]);
    await expect(work.getByRole("link", { name: "Pay", exact: true })).toHaveCount(0);

    // People: Directory and Org structure, but not the checklist board.
    const people = work.getByRole("link", { name: "People", exact: true });
    await hydrated(people);
    await people.click();
    await expectSubsequence(strip(page, "People").getByRole("link"), ["Directory", "Org structure"]);
    await expect(strip(page, "People").getByRole("link", { name: "Onboarding", exact: true })).toHaveCount(0);
    await expectNoConsoleStrip(page, "HR (member) › People");

    // Talent keeps Reviews (hr_policy read is open to members); its only tab, so a plain link with no strip.
    const talent = work.getByRole("link", { name: "Talent", exact: true });
    await hydrated(talent);
    await talent.click();
    await expect(page).toHaveURL(/\/hr\/reviews$/);
    await expect(strip(page, "Talent")).toHaveCount(0);
    await expectNoConsoleStrip(page, "HR (member) › Talent");

    // Cases & compliance: Cases and Settings, but not Compliance (the expiring-documents read).
    const cases = work.getByRole("link", { name: "Cases & compliance", exact: true });
    await hydrated(cases);
    await cases.click();
    await expectSubsequence(strip(page, "Cases & compliance").getByRole("link"), ["Cases", "Settings"]);
    await expect(strip(page, "Cases & compliance").getByRole("link", { name: "Compliance", exact: true })).toHaveCount(0);
    await expectNoConsoleStrip(page, "HR (member) › Cases & compliance");

    // Nowhere in the sidebar or its strips is People analytics offered.
    await expect(page.getByRole("link", { name: "People analytics", exact: true })).toHaveCount(0);
  });

  test("Finance: no Receivables row, no Consolidation tab", async ({ page, context }) => {
    await signIn(page, context, "member");
    await page.goto("/finance");
    const nav = menu(page, "Finance");
    await expect(nav).toBeVisible();
    await expectNoConsoleStrip(page, "Finance (member) Overview");
    const work = workGroup(nav);
    // The ungated rows stay offered (no capability mirrors their reads).
    await expectSubsequence(work.getByRole("link"), ["Ledger", "Payables", "Treasury & assets", "Tax", "Close"]);
    await expect(work.getByRole("link", { name: "Receivables", exact: true })).toHaveCount(0);

    const close = work.getByRole("link", { name: "Close", exact: true });
    await hydrated(close);
    await close.click();
    await expectSubsequence(strip(page, "Close").getByRole("link"), ["Period close", "Ownership", "Settings"]);
    await expect(strip(page, "Close").getByRole("link", { name: "Consolidation", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Financial statements", exact: true })).toHaveCount(0);
    await expectNoConsoleStrip(page, "Finance (member) › Close");
  });

  test("IT: no IT accounts and no Workflows row", async ({ page, context }) => {
    await signIn(page, context, "member");
    await page.goto("/it");
    const nav = menu(page, "IT");
    await expect(nav).toBeVisible();
    await expectNoConsoleStrip(page, "IT (member) Overview");
    const work = workGroup(nav);
    await expectSubsequence(work.getByRole("link"), ["Devices", "Network"]);
    await expect(work.getByRole("link", { name: "IT accounts", exact: true })).toHaveCount(0);
    await expect(work.getByRole("link", { name: "Workflows", exact: true })).toHaveCount(0);
  });
});
