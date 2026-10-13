import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { loginAsPersona } from "./personas";
import { tenantCookie } from "./appCookies";

// DW-6a/6b/6e: what the department workspaces' sidebars actually draw, per agency department, under DEMO_MODE.
//
// Facts (same as workspace-shell.spec.ts, which DW-3 owns and this file does not touch): the demo company is
// `co-agency` with Web Dev (dept-1), Creatives (dept-2), SEO (dept-3), Social Media (dept-4) and GM (dept-5).
// The superadmin (hansel@gaiada.com, platform_admin) holds every capability, so every capability-gated tab shows.
//
// The expected labels below are copied from the registry (`lib/workspaces.ts`) and the toolkits it draws them from
// (`lib/deptToolkits.ts`), in order, WITHOUT anything that carries a `ticket` (the shell does not draw those).
//
// Every list is matched as an ORDERED SUBSEQUENCE, never as equality: DW-4 and DW-5 add rows and tabs (Requests ›
// Sent, Campaigns, analytics tabs), and this spec must not break when they land. For the same reason nothing here
// asserts that a ticketed item is absent: when its ticket lands it appears.

async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}

/** The pilot switch, written the way lib/prefs.ts reads it (see workspace-shell.spec.ts). */
function pilotCookie(at: string) {
  return { name: "gaiada_prefs", value: encodeURIComponent(JSON.stringify({ shell: "workspaces" })), url: new URL("/", at).toString() };
}

async function signInSuperadmin(page: Page, context: BrowserContext) {
  await loginAsPersona(page, "superadmin");
  await context.addCookies([tenantCookie(page.url()), pilotCookie(page.url())]);
}

const menu = (page: Page, title: string) => page.getByRole("navigation", { name: `${title} menu` });
const strip = (page: Page, rowLabel: string) => page.getByRole("navigation", { name: `${rowLabel} sections` });
const workGroup = (nav: Locator) => nav.getByRole("group", { name: "Work" });
const current = (nav: Locator) => nav.locator('[aria-current="page"]');

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
  /** The tabs the registry draws today, in order (lib/workspaces.ts + lib/deptToolkits.ts). Omit for a single-tab row. */
  tabs?: readonly string[];
  /** A tab to click into (not the first), and the URL it lands on. The row must stay current. */
  click?: { tab: string; url: RegExp };
}

interface DeptSpec {
  id: string;
  title: string;
  /** The Work group's rows, in order (the workspace's own sections, then Tools & connections). */
  rows: readonly RowSpec[];
}

// Project Management (PM_ROW): Projects, then the toolkit's Board tab, which PM_TERMS.board labels "Overview"
// (lib/pmVocabulary.ts), Ball, Timeline, Activity. Charts moved to Analytics.
const PM: RowSpec = { row: "Project Management", tabs: ["Projects", "Overview", "Ball", "Timeline", "Activity"], click: { tab: "Activity", url: /\/activity$/ } };
const TOOLS: RowSpec = { row: "Tools & connections" };

const DEPARTMENTS: readonly DeptSpec[] = [
  {
    // WEB_DEV in lib/workspaces.ts. Campaigns and Clients are ticketed (DW-5b, DW-6d); Requests › Sent is DW-5c.
    id: "dept-1",
    title: "Web Dev",
    rows: [
      PM,
      { row: "Build", tabs: ["PRD Studio", "Pipeline", "Repositories", "Deliverables"], click: { tab: "Deliverables", url: /\/departments\/dept-1\/deliverables$/ } },
      { row: "Run", tabs: ["Portfolio", "Monitoring"], click: { tab: "Monitoring", url: /\/monitoring$/ } },
      { row: "Website", tabs: ["Content", "Media", "Leads", "Writers' room", "Visitors"], click: { tab: "Media", url: /\/departments\/dept-1\/website\/media$/ } },
      { row: "Requests" },
      TOOLS,
    ],
  },
  {
    // CREATIVES. Requests is ticketed (DW-5d), so it is not listed.
    id: "dept-2",
    title: "Creatives",
    rows: [PM, { row: "Studio", tabs: ["Image Studio", "Asset Library"], click: { tab: "Asset Library", url: /\/departments\/dept-2\/assets$/ } }, TOOLS],
  },
  {
    // SEO. "Reports" is shown as "Client reports" (DW-6b); the Campaigns row's Shared tab is ticketed (DW-5b).
    id: "dept-3",
    title: "SEO",
    rows: [
      PM,
      { row: "Accounts", tabs: ["Engagements", "Cost Ledger", "Client reports"], click: { tab: "Cost Ledger", url: /\/departments\/dept-3\/ledger$/ } },
      { row: "Optimize", tabs: ["Site Audit", "Keywords", "Rankings", "Content Briefs", "AI Visibility"], click: { tab: "Keywords", url: /\/departments\/dept-3\/keywords$/ } },
      { row: "Campaigns", tabs: ["Planner", "Ads Studio", "Search Terms", "Pacing"], click: { tab: "Pacing", url: /\/departments\/dept-3\/pacing$/ } },
      TOOLS,
    ],
  },
  {
    // SOCIAL_MEDIA. Publish › Analytics moved to the Analytics row; Campaigns is ticketed (DW-5b).
    id: "dept-4",
    title: "Social Media",
    rows: [PM, { row: "Publish", tabs: ["Calendar", "Composer", "Inbox"], click: { tab: "Composer", url: /\/departments\/dept-4\/composer$/ } }, TOOLS],
  },
  {
    // OFFICE_OF_THE_GM. Campaigns is one tab (All campaigns), Clients & sales has two (Clients, Leads).
    id: "dept-5",
    title: "Office of the GM",
    rows: [
      PM,
      { row: "Command", tabs: ["Business Review", "Decisions"], click: { tab: "Decisions", url: /\/departments\/dept-5\/decisions$/ } },
      { row: "Oversight", tabs: ["Departments", "Clients & Money", "People"], click: { tab: "People", url: /\/departments\/dept-5\/people$/ } },
      { row: "Campaigns" },
      { row: "Clients & sales", tabs: ["Clients", "Leads"] },
      TOOLS,
    ],
  },
];

test.describe("department workspaces (superadmin, pilot shell)", () => {
  for (const dept of DEPARTMENTS) {
    test(`${dept.title}: the Work menu draws the registry's rows in order, and each multi-tab row has its strip`, async ({ page, context }) => {
      await signInSuperadmin(page, context);
      await page.goto(`/departments/${dept.id}`);
      const nav = menu(page, dept.title);
      await expect(nav).toBeVisible();

      // The skeleton every workspace shares.
      await expect(nav.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(nav.getByRole("link", { name: "AI Assistant" })).toBeVisible();
      await expect(current(nav)).toHaveCount(1);

      await expectSubsequence(workGroup(nav).getByRole("link"), dept.rows.map((r) => r.row));
      await expectSubsequence(nav.getByRole("group", { name: "Performance" }).getByRole("link"), ["Reports", "Analytics", "Appraisals", "Learning"]);

      for (const r of dept.rows) {
        if (!r.tabs) continue;
        const rowLink = workGroup(nav).getByRole("link", { name: r.row, exact: true });
        await hydrated(rowLink);
        await rowLink.click();
        const tabStrip = strip(page, r.row);
        await expect(tabStrip, `${dept.title} › ${r.row}: the shell's tab strip`).toBeVisible();
        await expect(rowLink).toHaveAttribute("aria-current", "page");
        await expectSubsequence(tabStrip.getByRole("link"), r.tabs);
        // Landing on the row marks exactly one of its tabs current (not necessarily the first: a ticket may add one before it).
        await expect(current(tabStrip)).toHaveCount(1);

        if (r.click) {
          const tab = tabStrip.getByRole("link", { name: r.click.tab, exact: true });
          await hydrated(tab);
          await tab.click();
          await expect(page).toHaveURL(r.click.url);
          // The row stays current on the tab's page, whether it is under the department or a route the workspace owns.
          await expect(menu(page, dept.title).getByRole("link", { name: r.row, exact: true })).toHaveAttribute("aria-current", "page");
          await expect(current(menu(page, dept.title).getByRole("group", { name: "Work" }))).toHaveCount(1);
        }
      }
    });
  }

  test("SEO's Accounts row shows Client reports, and its page says Client reports (DW-6b)", async ({ page, context }) => {
    await signInSuperadmin(page, context);
    await page.goto("/departments/dept-3");
    await workGroup(menu(page, "SEO")).getByRole("link", { name: "Accounts", exact: true }).click();
    const tabStrip = strip(page, "Accounts");
    await expectSubsequence(tabStrip.getByRole("link"), ["Engagements", "Cost Ledger", "Client reports"]);
    // The old label is gone from the row: no tab of it is called plain "Reports".
    await expect(tabStrip.getByRole("link", { name: "Reports", exact: true })).toHaveCount(0);

    await tabStrip.getByRole("link", { name: "Client reports", exact: true }).click();
    await expect(page).toHaveURL(/\/departments\/dept-3\/reports$/);
    await expect(page.getByRole("heading", { name: /^Client reports$/ })).toBeVisible();
    await expect(tabStrip.getByRole("link", { name: "Client reports", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(menu(page, "SEO").getByRole("link", { name: "Accounts", exact: true })).toHaveAttribute("aria-current", "page");
  });

  // lib/areas.ts: a route in a workspace's `ownedRoutes` (Web Dev: /pipeline, /monitoring) is that workspace's area, so
  // the sidebar is Web Dev's even for a person whose home is the GM office. Which row is current comes from the href
  // of the row's tab (Pipeline is in Build, Monitoring in Run).
  for (const [path, row] of [["/pipeline", "Build"], ["/monitoring", "Run"]] as const) {
    test(`${path} keeps the Web Dev sidebar with ${row} current (an owned route)`, async ({ page, context }) => {
      await signInSuperadmin(page, context);
      await page.goto(path);
      const nav = menu(page, "Web Dev");
      await expect(nav).toBeVisible();
      await expect(workGroup(nav).getByRole("link", { name: row, exact: true })).toHaveAttribute("aria-current", "page");
      await expect(current(nav)).toHaveCount(1);
    });
  }
});

// DW-6c: the pilot's Tools & connections page. Under DEMO_MODE the connection reads may be unavailable, so the
// Connections blocks are asserted by heading, never by their state. The tool pins live in the gaiada_prefs cookie.
test.describe("Tools & connections (superadmin, DW-6c)", () => {
  const WEB_DEV_CONNECTIONS = "/departments/dept-1/connections";
  const toolsCard = (page: Page) => page.locator("section.lux-card").filter({ has: page.getByRole("heading", { name: "Tools", exact: true }) });
  const connectionsCard = (page: Page) => page.locator("section.lux-card").filter({ has: page.getByRole("heading", { name: "Connections", exact: true }) });

  test("Web Dev: the sidebar row opens a Tools section in registry order and a Connections section with its blocks", async ({ page, context }) => {
    await signInSuperadmin(page, context);
    await page.goto("/departments/dept-1");
    await workGroup(menu(page, "Web Dev")).getByRole("link", { name: "Tools & connections", exact: true }).click();
    await expect(page).toHaveURL(/\/departments\/dept-1\/connections$/);

    const tools = toolsCard(page);
    await expect(tools).toBeVisible();
    await expectSubsequence(tools.locator("li[data-tool] .dept-tools-row__label"), ["Claude Code", "Claude", "Claude Design", "GitHub", "Figma", "VS Code"]);

    const connections = connectionsCard(page);
    await expect(connections).toBeVisible();
    await expectSubsequence(connections.getByRole("heading", { level: 4 }), ["GitHub", "Google Drive", "Claude seats"]);
  });

  test("a pin can be removed and put back, each choice survives a reload, and the Overview's Today follows it", async ({ page, context }) => {
    await signInSuperadmin(page, context);
    await page.goto(WEB_DEV_CONNECTIONS);
    const tools = toolsCard(page);

    const unpin = tools.getByRole("button", { name: "Pin Figma to the Overview" });
    await expect(unpin).toHaveAttribute("aria-pressed", "true");
    await hydrated(unpin);
    await unpin.click();
    await expect(tools.getByRole("button", { name: "Pin Figma to the Overview" })).toHaveAttribute("aria-pressed", "false");

    await page.reload();
    await expect(toolsCard(page).getByRole("button", { name: "Pin Figma to the Overview" })).toHaveAttribute("aria-pressed", "false");
    // The other five stay pinned.
    await expect(toolsCard(page).locator('button[aria-pressed="true"]')).toHaveCount(5);

    // The Overview's Today block follows the pins: Figma is gone from it, GitHub is still there.
    await page.goto("/departments/dept-1");
    const today = page.getByRole("region", { name: "Today", exact: true });
    await expect(today.getByRole("link", { name: /^GitHub/ })).toBeVisible();
    await expect(today.getByRole("link", { name: /^Figma/ })).toHaveCount(0);

    await page.goto(WEB_DEV_CONNECTIONS);
    const pin = toolsCard(page).getByRole("button", { name: "Pin Figma to the Overview" });
    await hydrated(pin);
    await pin.click();
    await expect(toolsCard(page).getByRole("button", { name: "Pin Figma to the Overview" })).toHaveAttribute("aria-pressed", "true");

    await page.reload();
    await expect(toolsCard(page).getByRole("button", { name: "Pin Figma to the Overview" })).toHaveAttribute("aria-pressed", "true");
    await expect(toolsCard(page).locator('button[aria-pressed="true"]')).toHaveCount(6);

    // And Figma is back on the Overview.
    await page.goto("/departments/dept-1");
    await expect(page.getByRole("region", { name: "Today", exact: true }).getByRole("link", { name: /^Figma/ })).toBeVisible();
  });

  test("without the pilot cookie the same URL is the classic page: no Tools section", async ({ page, context }) => {
    await loginAsPersona(page, "superadmin");
    await context.addCookies([tenantCookie(page.url())]);
    await page.goto(WEB_DEV_CONNECTIONS);
    await expect(page.getByRole("heading", { name: "My connections" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tools", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /to the Overview$/ })).toHaveCount(0);
  });
});

// 6e, the generic workspace (any department with no bespoke workspace): the demo data gives no such department in
// the browser. Only the agency company has an org tree in demo mode (lib/org.ts `defaultStructure` seeds departments
// for vertical "agency" only, so the hospitality company Viceroy has none, and the fixtures may not grow). The
// skeleton is therefore proved by a jsdom render test: src/components/shell/WorkspaceSidebar.generic.test.tsx.
