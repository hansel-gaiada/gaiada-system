import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  loginAsFinanceStaff, loginAsGroupOwner, loginAsHrStaff, loginAsItAdmin, loginAsPersona, loginAsPlacedCreative,
  loginAsPlacedSeo, loginAsPlacedSocial, loginAsPlacedWebDev, loginAsResortStaff, loginAsWebDevHead,
} from "./personas";
import { tenantCookie } from "./appCookies";

// DW-9a: the department workspace shell proved right for TWELVE kinds of person, end to end, under DEMO_MODE (plan §12.1).
//
// The shell is a per-person pilot switch (`gaiada_prefs.shell`, lib/shellLayout.ts), so every test signs in fresh, plants the
// tenant cookie and the `workspaces` pilot cookie, and then checks what THAT person really gets. Each persona has one
// `describe`, built by `personaSuite` from one row of the table below, with five tests:
//   1. `/` lands on the home the plan's table names, and the switcher button names it;
//   2. the Work, Performance and You groups draw exactly the rows pinned in the row;
//   3. the footer shows Company, and Admin exactly where the gates allow it;
//   4. EVERY link of the workspace sidebar opens: a status under 400, no "Page not found" heading, no error-boundary text,
//      and the shell around it. Failures are collected and reported together, not one per run;
//   5. three Admin-area URLs answer as lib/adminAccess.ts says: a 404 where `adminRouteAllowed` refuses, the page where it allows.
// The client-only user is the twelfth describe, at the end, and checks the redirect to /portal.
//
// The expected rows are PINNED here, one line of "why" each, derived from lib/workspaces.ts (the registry; rows with a `ticket`
// are never drawn) and the gates in lib/workspaceAccess.ts. They are not copied from the app at run time, so a registry change
// that moves a row for a persona fails here until someone decides it should.
//
// Facts the rows rest on (src/lib/demoFixtures.ts, src/lib/org.ts, src/lib/demoIdentity.ts):
//   - The demo agency is `co-agency` (vertical "agency", pack "agency"); Viceroy is `co-resort` (vertical "hospitality", which
//     resolves to the GENERIC pack: no Clients, Campaigns, Requests or Meetings rows). `/api/me` gives every identity all three
//     companies; the tenant cookie picks the active one.
//   - The agency tree: Web Dev dept-1, Creatives dept-2, SEO dept-3, Social Media dept-4, GM dept-5, HR dept-6, Finance dept-7,
//     IT dept-8. Viceroy's tree (hospitality seed): Front Office hosp-dept-1, HR, Finance, IT.
//   - Every demo login holds ONE grant, so a persona's boundary is the boundary of that one role.
//   - The demo approvals inbox (`GET /api/approvals`) lists every pending item as decidable for everyone, so the `decider` gate
//     passes on its pending-count arm for ALL staff: the Approvals row is there for every persona below, and it may carry a
//     count. That is a demo-data fact, not a role fact; the role arm is covered by the unit tests of `gateAllows`.

// ── Helpers copied from workspace-shell.spec.ts (not imported: that file belongs to another session) ──────────────────

// A button is a plain control until React owns it; clicking earlier does nothing.
async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function press(loc: Locator) {
  await expect(loc).toBeVisible();
  await hydrated(loc);
  await loc.click();
}

/** The pilot switch, written the way lib/prefs.ts reads it: JSON in `gaiada_prefs`, URL-encoded. */
function pilotCookie(at: string, shell: "workspaces" | "classic" = "workspaces") {
  return { name: "gaiada_prefs", value: encodeURIComponent(JSON.stringify({ shell, shellChosen: true })), url: new URL("/", at).toString() };
}

const sidebar = (page: Page) => page.locator("aside#app-nav");
const menu = (page: Page, title: string) => page.getByRole("navigation", { name: `${title} menu` });
const switcher = (page: Page) => page.getByRole("button", { name: /\. Switch workspace$/ });

// ── The persona table ─────────────────────────────────────────────────────────────────────────────────────────────────

interface AdminUrl {
  url: string;
  /** What `adminRouteAllowed` (lib/adminAccess.ts) says for this person on the active company. */
  allowed: boolean;
  /** The row of the table and why. */
  why: string;
  /** The heading the page shows when it is allowed. */
  h1?: RegExp;
}

interface Persona {
  name: string;
  login: (page: Page) => Promise<void>;
  tenant: string;
  /** `/` ends here. */
  home: RegExp;
  /** The workspace menu's own title (the nav's accessible name is "<title> menu"). */
  menuTitle: string;
  /** The switcher button's accessible name. */
  switcherName: string;
  work: string[];
  performance: string[];
  you: string[];
  /** The footer's Admin link is shown. */
  admin: boolean;
  /** The Admin area's rows, when `admin`. */
  adminRows?: string[];
  adminUrls: AdminUrl[];
}

// Every persona's Performance group: My performance, Reports, Analytics, Appraisals and Learning are ungated ROWS (their tabs
// carry the gates), so the row list is the same for everyone.
const PERFORMANCE = ["My performance", "Reports", "Analytics", "Appraisals", "Learning"];
// Every persona's You group: DW-8a My tasks; the Approvals row passes the `decider` gate on the demo inbox's pending items.
const YOU = ["My tasks", "Inbox", "Calendar", "Approvals", "Me"];

const ADMIN_URLS = {
  // lib/adminAccess.ts SETTINGS row `/admin/users`: USERS = tenantRoles(["company_admin", "manager", "owner"]): platform_admin,
  // one of those roles in the tenant, or a role the UI cannot model.
  users: (allowed: boolean, why: string): AdminUrl => ({ url: "/admin/users", allowed, why: `USERS row (company_admin, manager, owner, platform_admin): ${why}`, h1: /users & roles/i }),
  // Platform row `/systems/automation`: `operator || anyScopeIt`: the platform operator, or any it/it_admin/it_manager grant.
  automation: (allowed: boolean, why: string): AdminUrl => ({ url: "/systems/automation", allowed, why: `automation row (platform operator or an IT role): ${why}`, h1: /^automation$/i }),
  // Group row `/group`: GROUP = isElevated || isRootOwner: platform_admin, or the owner of a root company.
  group: (allowed: boolean, why: string): AdminUrl => ({ url: "/group", allowed, why: `GROUP row (platform_admin or a root owner): ${why}`, h1: /group report/i }),
};

/** A person with a plain `member` grant, who is neither a manager, an owner, an IT role nor elevated: all three pages 404. */
const MEMBER_ADMIN_URLS = [
  ADMIN_URLS.users(false, "a member is none of them"),
  ADMIN_URLS.automation(false, "a member is neither the operator nor IT"),
  ADMIN_URLS.group(false, "a member is neither elevated nor an owner"),
];

const GM_WORK = [
  "Project Management", // the shared PM row
  "Command", // Business review, Decisions, Revenue plan: the rows are ungated, their tabs gate their own content (lib/gm.ts)
  "Oversight", // Departments, Money, People
  "Requests", // Sent only: the GM has no inbox of requests
  "Campaigns", // agency pack row: all campaigns
  "Clients & sales", // agency clients row
  "Tools & connections",
];

const PERSONAS: Persona[] = [
  {
    name: "Web Dev employee (webdev@gaiada.com, u-dev: member, placed in Web Dev > Frontend)",
    login: loginAsPlacedWebDev, tenant: "co-agency",
    home: /\/departments\/dept-1$/, menuTitle: "Web Dev", switcherName: "Web Dev, Gaia Digital Agency. Switch workspace",
    work: [
      "Project Management",
      "Build", // PRD, Pipeline, Repositories, Deliverables
      "Run", // Sites, Monitoring
      "Website", // Content, Media, Leads, Writers
      "Requests", // Incoming and Sent: Web Dev is the department others ask
      "Campaigns", // agency pack: the shared campaigns Web Dev has a part in
      "Clients", // agency clients row
      "Tools & connections",
    ],
    performance: PERFORMANCE, you: YOU,
    admin: false, // no `admin.access`: only platform_admin holds it (lib/rbac.ts ROLE_CAPS)
    adminUrls: MEMBER_ADMIN_URLS,
  },
  {
    name: "SEO employee (seo-specialist@gaiada.com, u-seo: member, placed in SEO > On-page > SEO Specialist)",
    login: loginAsPlacedSeo, tenant: "co-agency",
    home: /\/departments\/dept-3$/, menuTitle: "SEO", switcherName: "SEO, Gaia Digital Agency. Switch workspace",
    work: [
      "Project Management",
      "Accounts", // Engagements, Ledger, Reports
      "Optimize", // Audit, Keywords, Rankings, Briefs, AI visibility
      "Requests", // Sent only: SEO asks, it is not asked
      "Campaigns", // Campaigns, Planner, Ads, Search terms, Pacing
      "Clients",
      "Tools & connections",
    ],
    performance: PERFORMANCE, you: YOU,
    admin: false,
    adminUrls: MEMBER_ADMIN_URLS,
  },
  {
    name: "Social Media employee (social@gaiada.com, u-social: member, placed in Social Media)",
    login: loginAsPlacedSocial, tenant: "co-agency",
    home: /\/departments\/dept-4$/, menuTitle: "Social Media", switcherName: "Social Media, Gaia Digital Agency. Switch workspace",
    work: [
      "Project Management",
      "Publish", // Calendar, Composer, Inbox
      "Requests", // Sent only
      "Campaigns", // Shared and Social campaigns
      "Clients",
      "Tools & connections",
    ],
    performance: PERFORMANCE, you: YOU,
    admin: false,
    adminUrls: MEMBER_ADMIN_URLS,
  },
  {
    name: "Creatives employee (creative@gaiada.com, u-creative: member, placed in Creatives > Design)",
    login: loginAsPlacedCreative, tenant: "co-agency",
    home: /\/departments\/dept-2$/, menuTitle: "Creatives", switcherName: "Creatives, Gaia Digital Agency. Switch workspace",
    work: [
      "Project Management",
      "Requests", // Incoming, Delivered and Sent: Creatives is the department others ask for assets
      "Studio", // Image Studio and Assets
      "Campaigns",
      "Clients",
      "Tools & connections",
    ],
    performance: PERFORMANCE, you: YOU,
    admin: false,
    adminUrls: MEMBER_ADMIN_URLS,
  },
  {
    name: "Web Dev head (webhead@gaiada.com, u-webhead: member + org_unit_lead on dept-1)",
    login: loginAsWebDevHead, tenant: "co-agency",
    // Heads see the same ROWS as the employee; what the lead grant adds is TABS (Team report, Team activity, Team appraisals,
    // Team progress) and the Overview's Me | Team switch, which workspace-shell.spec.ts drives.
    home: /\/departments\/dept-1$/, menuTitle: "Web Dev", switcherName: "Web Dev, Gaia Digital Agency. Switch workspace",
    work: ["Project Management", "Build", "Run", "Website", "Requests", "Campaigns", "Clients", "Tools & connections"],
    performance: PERFORMANCE, you: YOU,
    admin: false, // `org_unit_lead` is unit-scoped and does not hold admin.access
    adminUrls: [
      // `org_unit_lead` has no company-scope grant to match, and `member` is modelled, so nothing opens them.
      ADMIN_URLS.users(false, "member plus org_unit_lead, neither is in the set"),
      ADMIN_URLS.automation(false, "not the operator, no IT role"),
      ADMIN_URLS.group(false, "not elevated, not an owner"),
    ],
  },
  {
    name: "HR staff (hr-staff@gaiada.com, u-hr: hr_staff on the agency, unplaced)",
    login: loginAsHrStaff, tenant: "co-agency",
    // Home comes from the functional role (workspaceAccess.ts rule 3): HR's console root, not /departments/dept-6.
    home: /\/hr$/, menuTitle: "HR", switcherName: "HR, Gaia Digital Agency. Switch workspace",
    work: [
      "Project Management",
      "People", // Directory, Onboarding, Organization
      "Time", // Leave, Attendance
      "Talent", // Recruitment, Reviews
      "Cases & compliance",
      "Tools & connections",
    ],
    performance: PERFORMANCE, you: YOU,
    admin: false, // hr_staff does not hold admin.access
    adminUrls: [
      ADMIN_URLS.users(false, "hr_staff is a modelled role outside the set"),
      ADMIN_URLS.automation(false, "hr_staff is not an IT role"),
      ADMIN_URLS.group(false, "hr_staff is not elevated or an owner"),
    ],
  },
  {
    name: "Finance staff (finance-staff@gaiada.com, u-finance-staff: finance_staff on the agency, unplaced)",
    login: loginAsFinanceStaff, tenant: "co-agency",
    home: /\/finance$/, menuTitle: "Finance", switcherName: "Finance, Gaia Digital Agency. Switch workspace",
    work: [
      "Project Management",
      "Ledger", // Journals, Ledger, Accounts
      "Receivables",
      "Payables",
      "Treasury & assets",
      "Tax",
      "Close", // Close, Consolidation, Ownership, Cutover, Settings
      "Tools & connections",
    ],
    performance: PERFORMANCE, you: YOU,
    admin: false,
    adminUrls: [
      ADMIN_URLS.users(false, "finance_staff is a modelled role outside the set"),
      ADMIN_URLS.automation(false, "finance_staff is not an IT role"),
      ADMIN_URLS.group(false, "finance_staff is not elevated or an owner"),
    ],
  },
  {
    name: "IT staff (it-admin@gaiada.com, u-it: it_admin on the agency, unplaced)",
    login: loginAsItAdmin, tenant: "co-agency",
    home: /\/it$/, menuTitle: "IT", switcherName: "IT, Gaia Digital Agency. Switch workspace",
    work: [
      "Project Management",
      "Devices",
      "Network", // Topology, Network, Threats, Rules, Presence
      "IT accounts",
      "Workflows",
      "Tools & connections",
    ],
    performance: PERFORMANCE, you: YOU,
    // `it_admin` does not hold admin.access, and is not the platform operator, so the footer has no Admin link. Yet the one
    // Platform page IT reads, Automation (the workflows), is open to them by URL: the table's own exception.
    admin: false,
    adminUrls: [
      ADMIN_URLS.users(false, "it_admin is a modelled role outside the set"),
      ADMIN_URLS.automation(true, "anyScopeIt: it_admin is an IT role, so IT reads the workflows"),
      ADMIN_URLS.group(false, "it_admin is not elevated or an owner"),
    ],
  },
  {
    name: "unplaced group owner (group-owner@gaiada.com, demo-owner: owner on every company)",
    login: loginAsGroupOwner, tenant: "co-agency",
    // No placement and no led unit: home is the Office of the GM, through full GM access (owner holds reports.company.view).
    home: /\/departments\/dept-5$/, menuTitle: "Office of the GM", switcherName: "Office of the GM, Gaia Digital Agency. Switch workspace",
    work: GM_WORK, performance: PERFORMANCE, you: YOU,
    // The owner of the OPERATOR root holds admin.access (owner is in ROLE_CAPS) and is the platform operator (PV-D18, PV-D20, PV-D31):
    // Settings and Platform in this company. Group needs the ACTIVE company to be the root, tested below on co-holding.
    admin: true, adminRows: ["Settings", "Platform"],
    adminUrls: [
      ADMIN_URLS.users(true, "owner is in USERS_READ"),
      ADMIN_URLS.automation(true, "the owner of the operator root is the platform operator"),
      ADMIN_URLS.group(true, "isRootOwner: owner of a root company"),
    ],
  },
  {
    name: "platform_admin (hansel@gaiada.com, demo-hansel)",
    login: (page) => loginAsPersona(page, "superadmin"), tenant: "co-agency",
    home: /\/departments\/dept-5$/, menuTitle: "Office of the GM", switcherName: "Office of the GM, Gaia Digital Agency. Switch workspace",
    work: GM_WORK, performance: PERFORMANCE, you: YOU,
    admin: true, adminRows: ["Settings", "Platform"], // Group is the root company's, so not in the agency
    adminUrls: [
      ADMIN_URLS.users(true, "isElevated: platform_admin"),
      ADMIN_URLS.automation(true, "platform_admin is the platform operator"),
      ADMIN_URLS.group(true, "isElevated: platform_admin"),
    ],
  },
  {
    name: "generic-pack user (resort-staff@gaiada.com, u-resort: member of Viceroy, placed in Front Office)",
    login: loginAsResortStaff, tenant: "co-resort",
    // "Front Office" slugs to no registry workspace, so the generic workspace draws under the department's own name.
    home: /\/departments\/hosp-dept-1$/, menuTitle: "Front Office", switcherName: "Front Office, Viceroy. Switch workspace",
    work: [
      "Project Management", // the generic workspace: Project Management only,
      "Tools & connections", // and the shared Tools row. No Requests, Campaigns or Clients: those are the agency pack's.
    ],
    performance: PERFORMANCE,
    // Calendar and Me are rows of every workspace; the agency-only Meetings and Timesheet are TABS inside them, so the row list is the same.
    you: YOU,
    admin: false,
    adminUrls: MEMBER_ADMIN_URLS,
  },
];

// ── The shared checks ─────────────────────────────────────────────────────────────────────────────────────────────────

async function signIn(page: Page, context: BrowserContext, p: Persona) {
  await p.login(page);
  await context.addCookies([tenantCookie(page.url(), p.tenant), pilotCookie(page.url())]);
}

/** The visible labels of a group's links, with the Approvals row's pending count (DW-8m) taken off. */
async function groupLabels(nav: Locator, group: string): Promise<string[]> {
  const texts = await readLinks(nav.getByRole("group", { name: group }));
  return texts.map((t) => t.replace(/^(Approvals)\s*\d+$/, "$1"));
}

/** The trimmed labels of every link in a menu. */
async function groupLinks(nav: Locator): Promise<string[]> {
  return readLinks(nav);
}

/** The trimmed link texts under a locator. A read that lands mid-navigation (a page that redirects while it streams reloads the
 *  document) answers [] instead of throwing, so the `expect.poll` around it tries again. */
async function readLinks(within: Locator): Promise<string[]> {
  try {
    return (await within.getByRole("link").allTextContents()).map((t) => t.trim());
  } catch {
    return [];
  }
}

const NOT_FOUND = /page not found/i;

/** Waits until the page has stopped moving: loaded, and the same URL for three reads in a row. A page that redirects while it
 *  streams (`/admin` -> `/admin/users`, a meta refresh under loading.tsx) is a full reload, and reading the DOM mid-reload sees no
 *  shell or throws; the walk must judge the page it lands on, not the one it left. */
async function settle(page: Page) {
  let last = "";
  let same = 0;
  for (let i = 0; i < 80 && same < 3; i++) {
    let now = "";
    try {
      now = (await page.evaluate(() => (document.readyState === "complete" ? location.pathname + location.search : ""))) as string;
    } catch {
      now = ""; // the document is being replaced
    }
    same = now !== "" && now === last ? same + 1 : 0;
    last = now;
    await page.waitForTimeout(250);
  }
}

function personaSuite(p: Persona) {
  test.describe(p.name, () => {
    test("`/` lands on the home, and the switcher names it", async ({ page, context }) => {
      await signIn(page, context, p);
      await page.goto("/");
      await expect(page).toHaveURL(p.home);
      await expect(menu(page, p.menuTitle)).toBeVisible();
      await expect(page.getByRole("button", { name: p.switcherName })).toBeVisible();
    });

    test("the Work, Performance and You groups draw exactly the pinned rows", async ({ page, context }) => {
      await signIn(page, context, p);
      await page.goto("/");
      await expect(page).toHaveURL(p.home);
      const nav = menu(page, p.menuTitle);
      for (const group of ["Work", "Performance", "You"]) await expect(nav.getByRole("group", { name: group })).toBeVisible();
      // Work, Performance and You: the lists themselves (a poll, so a slow hydration does not fail a correct page).
      await expect.poll(() => groupLabels(nav, "Work")).toEqual(p.work);
      expect(await groupLabels(nav, "Performance")).toEqual(p.performance);
      expect(await groupLabels(nav, "You")).toEqual(p.you);
    });

    test("the footer shows Company, and Admin exactly where the gates allow it", async ({ page, context }) => {
      await signIn(page, context, p);
      await page.goto("/");
      await expect(page).toHaveURL(p.home);
      // Company belongs to everyone staff-side: the positive thing, first.
      await expect(sidebar(page).getByRole("link", { name: "Company", exact: true })).toBeVisible();
      const admin = sidebar(page).getByRole("link", { name: "Admin", exact: true });
      if (p.admin) {
        await expect(admin).toBeVisible();
        await admin.click();
        await expect(page).toHaveURL(/\/admin$/);
        const nav = menu(page, "Admin");
        await expect(nav).toBeVisible();
        // The pinned rows are there (a poll: `/admin` can redirect while it streams, and a read mid-reload throws). The menu's
        // links also include each row's tabs, so this is a containment check; Group is then absent: it needs the root company active.
        await expect.poll(() => groupLinks(nav)).toEqual(expect.arrayContaining(p.adminRows ?? []));
        expect(await groupLinks(nav)).not.toContain("Group");
      } else {
        // The footer is there (Company), so an absent Admin is the gate and not a sidebar that never drew.
        await expect(admin).toHaveCount(0);
      }
    });

    test("every link in the workspace sidebar opens: no 4xx, no 404 page, no error page", async ({ page, context }) => {
      test.setTimeout(240_000);
      await signIn(page, context, p);
      await page.goto("/");
      await expect(page).toHaveURL(p.home);
      await expect(menu(page, p.menuTitle)).toBeVisible();
      await expect.poll(() => groupLabels(menu(page, p.menuTitle), "Work")).toEqual(p.work);

      const hrefs = await sidebar(page).locator("a[href]").evaluateAll((as) =>
        [...new Set(as.map((a) => a.getAttribute("href") ?? "").filter((h) => h.startsWith("/")))],
      );
      // The sidebar has the rows of three groups, two top rows and the footer: never an empty or one-link walk.
      expect(hrefs.length).toBeGreaterThanOrEqual(p.work.length + p.performance.length + p.you.length);

      const failures: string[] = [];
      for (const href of hrefs) {
        let status = 0;
        try {
          const res = await page.goto(href);
          status = res?.status() ?? 0;
          if (!res || status >= 400) failures.push(`${href}: status ${status || "none"}`);
          await settle(page);
          // A 404 or an error screen is drawn inside a 200 when the page streams, so the page's own text is checked too.
          if ((await page.getByRole("heading", { name: NOT_FOUND }).count()) > 0) failures.push(`${href}: "Page not found" heading`);
          if ((await page.getByText(/something went wrong/i).count()) > 0) failures.push(`${href}: error boundary text ("Something went wrong")`);
          // The shell around it is the positive proof that the app rendered a page at all.
          if ((await sidebar(page).count()) === 0) failures.push(`${href}: no workspace sidebar (landed on ${new URL(page.url()).pathname})`);
        } catch (e) {
          failures.push(`${href}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
      expect(failures, `${hrefs.length} links walked`).toEqual([]);
    });

    test("three Admin-area URLs answer as lib/adminAccess.ts says: 404 where refused, the page where allowed", async ({ page, context }) => {
      await signIn(page, context, p);
      for (const a of p.adminUrls) {
        await page.goto(a.url);
        const h1 = page.getByRole("heading", { level: 1 });
        if (a.allowed) {
          // The positive first: the page's own heading, then no 404 on it.
          await expect(h1.first(), `${a.url} (${a.why})`).toContainText(a.h1 ?? /./);
          expect(await page.getByRole("heading", { name: NOT_FOUND }).count(), `${a.url} must not be a 404 (${a.why})`).toBe(0);
        } else {
          await expect(h1.first(), `${a.url} must be a 404 (${a.why})`).toContainText(NOT_FOUND);
        }
      }
    });
  });
}

for (const p of PERSONAS) personaSuite(p);

// ── Extra checks that belong to one persona ──────────────────────────────────────────────────────────────────────────

test.describe("unplaced group owner: the root company adds Group", () => {
  test("on the root company the Admin area lists Settings, Group and Platform, and the Group pages open", async ({ page, context }) => {
    await loginAsGroupOwner(page);
    await context.addCookies([tenantCookie(page.url(), "co-holding"), pilotCookie(page.url())]);
    await page.goto("/admin");
    const nav = menu(page, "Admin");
    await expect(nav).toBeVisible();
    await expect.poll(() => groupLinks(nav)).toEqual(expect.arrayContaining(["Settings", "Group", "Platform"]));
    for (const url of ["/group", "/rollups", "/group/reports"]) {
      const res = await page.goto(url);
      expect(res?.status(), url).toBeLessThan(400);
      await expect(page.getByRole("heading", { level: 1 }).first()).not.toContainText(NOT_FOUND);
      await expect(sidebar(page)).toBeVisible();
    }
  });
});

test.describe("generic-pack user: the generic workspace", () => {
  test("its menu is the department's own name with Project Management as the only department row", async ({ page, context }) => {
    const p = PERSONAS.find((x) => x.tenant === "co-resort")!;
    await signIn(page, context, p);
    await page.goto("/");
    await expect(page).toHaveURL(/\/departments\/hosp-dept-1$/);
    // The menu's label is the department's own name, not "Department" or a registry name.
    const nav = menu(page, "Front Office");
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("group", { name: "Work" }).getByRole("link", { name: "Project Management", exact: true })).toBeVisible();
    await expect.poll(() => groupLabels(nav, "Work")).toEqual(["Project Management", "Tools & connections"]);
    // The agency pack's rows are not here: the positive (Project Management) was checked above.
    for (const row of ["Requests", "Campaigns", "Clients", "Build", "Optimize", "Publish"]) {
      await expect(nav.getByRole("link", { name: row, exact: true })).toHaveCount(0);
    }
    // The company's other departments are in the switcher, HR, Finance and IT as live has them (DW-7d).
    await press(switcher(page));
    const others = page.getByRole("list", { name: "Departments" });
    await expect(others.getByRole("link", { name: /^HR/ })).toBeVisible();
    await expect(others.getByRole("link", { name: /^Finance/ })).toBeVisible();
    await expect(others.getByRole("link", { name: /^IT/ })).toBeVisible();
  });
});

// ── The client ──────────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("client-only user (client@northwind.example, demo-client)", () => {
  test("`/`, a department and an Admin URL all end in /portal, even with the pilot cookie", async ({ page, context }) => {
    await loginAsPersona(page, "client_contact");
    await expect(page).toHaveURL(/\/portal/);
    await context.addCookies([tenantCookie(page.url()), pilotCookie(page.url())]);
    for (const path of ["/", "/departments/dept-1", "/admin/users"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/portal/);
      // The portal has drawn (the positive, first); then the staff shell is absent: neither the switcher nor the search box.
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expect(switcher(page)).toHaveCount(0);
      await expect(page.getByRole("searchbox", { name: "Search" })).toHaveCount(0);
    }
  });
});
