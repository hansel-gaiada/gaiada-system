import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { loginAsPersona, loginAsPlacedWebDev, loginAsWebDevHead, type PersonaKey } from "./personas";
import { tenantCookie } from "./appCookies";

// DW-2g: the department workspace shell (DW-2a..2f), end to end, per persona, under DEMO_MODE.
//
// The shell is a per-person pilot switch (`gaiada_prefs.shell`, lib/shellLayout.ts), so every test signs in
// fresh, plants the `workspaces` pilot cookie, and then checks what THAT persona really gets. Nothing here
// assumes a department the demo data does not give. The facts every expectation below derives from:
//
//   - The demo company is `co-agency` (Gaia Digital Agency, vertical "agency"). With no backend its org tree
//     is the seeded default (lib/org.ts): Web Dev (dept-1), Creatives (dept-2), SEO (dept-3), Social Media
//     (dept-4), GM (dept-5), and since DW-7d HR (dept-6), Finance (dept-7) and IT (dept-8). The only people
//     placed in it are u-dev, u-pm and u-gm. Only ONE demo login is
//     any of those: `webdev@gaiada.com` is u-dev (DW-3a), placed in Web Dev > Frontend. The personas below
//     have no placement.
//   - Home is therefore decided by GM access (lib/workspaceAccess.ts):
//       superadmin (hansel@gaiada.com, platform_admin)  -> reports.company.view      -> Office of the GM, own
//       manager    (manager@gaiada.com, manager)        -> reports.department.view  -> Office of the GM, own (narrowed)
//       member     (gede@gaiada.com, member)            -> none                     -> no workspace of their own: Company
//       search_staff (seo-staff@gaiada.com)             -> none                     -> no workspace of their own: Company
//   - Admin needs `admin.access`: platform_admin only. The Company area (first row "Departments") is open to all.
//     An Admin page is a 404 for anyone not allowed to use it (DW-D20, lib/adminAccess.ts).
//   - The tree holds HR, Finance and IT (DW-7d), so those workspaces have a department id and follow the
//     other departments in the switcher, in tree order.
//   - client_contact (dana@northwind.example) is client-only and belongs in /portal, never the staff shell.

// A button is a plain control until React owns it; clicking earlier does nothing (same helper as the
// assistant-drawer spec, which saw this flake on a loaded box).
async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function press(loc: Locator) {
  await expect(loc).toBeVisible();
  await hydrated(loc);
  await loc.click();
}

/** The pilot switch, written the way lib/prefs.ts reads it: JSON in `gaiada_prefs` (missing fields fall back to
 *  the defaults). Next URL-encodes cookie values on write and decodes on read, so the value is encoded here. */
function pilotCookie(at: string, shell: "workspaces" | "classic" = "workspaces") {
  return { name: "gaiada_prefs", value: encodeURIComponent(JSON.stringify({ shell })), url: new URL("/", at).toString() };
}

async function signIn(page: Page, context: BrowserContext, persona: PersonaKey, opts: { pilot?: boolean } = {}) {
  await loginAsPersona(page, persona);
  await context.addCookies([tenantCookie(page.url()), ...(opts.pilot === false ? [] : [pilotCookie(page.url())])]);
}

// The workspace sidebar. `aside#app-nav` is the one place a CSS id is used: the classic and the workspace
// sidebar share that landmark id, and the footer links have no landmark of their own.
const sidebar = (page: Page) => page.locator("aside#app-nav");
const menu = (page: Page, title: string) => page.getByRole("navigation", { name: `${title} menu` });
const switcher = (page: Page) => page.getByRole("button", { name: /\. Switch workspace$/ });
const current = (nav: Locator) => nav.locator('[aria-current="page"]');

/** Opens the workspace switcher and returns its panel's two lists (null when the list is not drawn). */
async function openSwitcher(page: Page) {
  await press(switcher(page));
  return { mine: page.getByRole("list", { name: "Your workspaces" }), others: page.getByRole("list", { name: "Departments" }) };
}

/** The placed Web Dev employee (DW-3a): u-dev, a plain member seated in Web Dev, signed in on the pilot or not. */
async function signInWebDev(page: Page, context: BrowserContext, opts: { pilot?: boolean } = {}) {
  await loginAsPlacedWebDev(page);
  await context.addCookies([tenantCookie(page.url()), ...(opts.pilot === false ? [] : [pilotCookie(page.url())])]);
}

/** The head of Web Dev (DW-3h): u-webhead, `org_unit_lead` on dept-1, signed in on the pilot or not. */
async function signInWebDevHead(page: Page, context: BrowserContext, opts: { pilot?: boolean } = {}) {
  await loginAsWebDevHead(page);
  await context.addCookies([tenantCookie(page.url()), ...(opts.pilot === false ? [] : [pilotCookie(page.url())])]);
}

const DEPARTMENTS = ["Web Dev", "Creatives", "SEO", "Social Media"];

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// superadmin: Office of the GM is home and own. Admin shows. The reference persona for most checks.
// ──────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("superadmin (hansel@gaiada.com)", () => {
  test("home is the Office of the GM; the switcher lists their workspace first, then the departments", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/");
    // The layout answers `/` with a real redirect (DW-3a2); wait for the Overview before opening the switcher.
    await expect(page).toHaveURL(/\/departments\/dept-5$/);

    await expect(menu(page, "Office of the GM")).toBeVisible();
    await expect(page.getByRole("button", { name: "Office of the GM, Gaia Digital Agency. Switch workspace" })).toBeVisible();

    const { mine, others } = await openSwitcher(page);
    await expect(mine.getByRole("link")).toHaveText([/^Office of the GM\s*Home$/]);
    // Departments in the org tree's order. The GM is already above, so it is not listed twice.
    const names = (await others.getByRole("link").allTextContents()).map((t) => t.replace(/\s*Home$/, ""));
    expect(names.slice(0, DEPARTMENTS.length)).toEqual(DEPARTMENTS);
    expect(names).not.toContain("Office of the GM");

    // "Your workspaces" sits above "Departments". The label is found by its class: since DW-3 `/` lands on the
    // Office of the GM's page, whose cockpit has a "Departments" card of its own.
    const y = async (l: Locator) => (await l.boundingBox())!.y;
    expect(await y(page.getByText("Your workspaces"))).toBeLessThan(await y(page.locator(".ws-switch__label", { hasText: /^Departments$/ })));

    // Choosing a department goes to its Overview and closes the panel.
    await others.getByRole("link", { name: "SEO" }).click();
    await expect(page).toHaveURL(/\/departments\/dept-3$/);
    await expect(others).toHaveCount(0);
  });

  test("the Work, Performance and You groups draw, and exactly the row holding the page is current", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/departments/dept-5");
    const nav = menu(page, "Office of the GM");

    for (const group of ["Work", "Performance", "You"]) await expect(nav.getByRole("group", { name: group })).toBeVisible();
    await expect(nav.getByRole("group", { name: "Performance" }).getByRole("link")).toHaveText(["Reports", "Analytics", "Appraisals", "Learning"]);
    await expect(nav.getByRole("group", { name: "You" }).getByRole("link")).toHaveText(["Inbox", "Calendar", "Approvals", "Me"]);
    const work = nav.getByRole("group", { name: "Work" });
    for (const row of ["Project Management", "Command", "Oversight", "Tools & connections"]) {
      await expect(work.getByRole("link", { name: row, exact: true })).toBeVisible();
    }
    await expect(nav.getByRole("link", { name: "AI Assistant" })).toBeVisible();

    // The Overview page: Overview is the one current row.
    await expect(nav.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(current(nav)).toHaveCount(1);

    // A personal page keeps this workspace's sidebar and marks its own row current instead.
    await page.goto("/me/inbox");
    await expect(menu(page, "Office of the GM")).toBeVisible();
    await expect(nav.getByRole("group", { name: "You" }).getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
    await expect(current(nav)).toHaveCount(1);
  });

  test("a multi-tab row shows the shell's tab strip, and the console's own strips are not doubled", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/departments/dept-5/projects");

    const strip = page.getByRole("navigation", { name: "Project Management sections" });
    await expect(strip).toBeVisible();
    await expect(strip.getByRole("link")).toHaveCount(5); // Projects, Board, Ball, Timeline, Activity
    await expect(strip.getByRole("link").first()).toHaveText("Projects");
    await expect(strip.getByRole("link").first()).toHaveAttribute("aria-current", "page");
    await expect(menu(page, "Office of the GM").getByRole("link", { name: "Project Management", exact: true })).toHaveAttribute("aria-current", "page");

    // The console's own two-level strip (DeptTabs) and the generic one (SectionTabs) hide where the shell covers them.
    await expect(page.getByRole("navigation", { name: "Department sections" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: /tools$/ })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Section", exact: true })).toHaveCount(0);

    // Moving to another tab of the row keeps the strip and moves the current tab.
    await strip.getByRole("link", { name: "Activity" }).click();
    await expect(page).toHaveURL(/\/departments\/dept-5\/activity$/);
    await expect(strip.getByRole("link", { name: "Activity" })).toHaveAttribute("aria-current", "page");

    // A single-tab row (Overview) has no strip at all.
    await page.goto("/departments/dept-5");
    await expect(menu(page, "Office of the GM")).toBeVisible();
    await expect(page.getByRole("navigation", { name: /sections$/ })).toHaveCount(0);
  });

  test("visiting another department says so, and Back returns home", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/departments/dept-1");

    await expect(page.getByRole("button", { name: "Web Dev, Gaia Digital Agency. Switch workspace" })).toBeVisible();
    await expect(sidebar(page).getByText("Visiting Web Dev")).toBeVisible();
    // The sidebar is Web Dev's now.
    const nav = menu(page, "Web Dev");
    await expect(nav.getByRole("link", { name: "Build", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Run", exact: true })).toBeVisible();

    const back = sidebar(page).getByRole("link", { name: "Back to Office of the GM" });
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(/\/departments\/dept-5$/);
    await expect(menu(page, "Office of the GM")).toBeVisible();
    await expect(sidebar(page).getByText(/^Visiting /)).toHaveCount(0);
    await expect(sidebar(page).getByRole("link", { name: /^Back to / })).toHaveCount(0);
  });

  test("the footer's Company link opens the Company area; Admin appears for a platform admin", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/departments/dept-5");

    await sidebar(page).getByRole("link", { name: "Company", exact: true }).click();
    await expect(page).toHaveURL(/\/departments$/);
    const company = menu(page, "Company");
    await expect(company).toBeVisible();
    for (const row of ["Departments", "Organization", "Projects", "Knowledge", "AI Agents", "The Office"]) {
      await expect(company.getByRole("link", { name: row, exact: true })).toBeVisible();
    }
    await expect(company.getByRole("link", { name: "Departments", exact: true })).toHaveAttribute("aria-current", "page");
    // Company belongs to no department, so the way back to the home workspace is offered.
    await expect(sidebar(page).getByRole("link", { name: "Back to Office of the GM" })).toBeVisible();

    await sidebar(page).getByRole("link", { name: "Admin", exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(menu(page, "Admin").getByRole("link", { name: "Settings", exact: true })).toBeVisible();

    // DW-D20: allowed, so no 404 for Settings or for Platform.
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/users & roles/i);
    await page.goto("/systems/hub");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/mcp hub/i);
  });

  test("the top bar: search opens the command palette and finds a page; the bell has its pop-over", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/departments/dept-5");

    const search = page.getByRole("searchbox", { name: "Search" });
    await expect(search).toBeVisible();
    await hydrated(search);
    await search.click();
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await palette.getByRole("combobox").fill("appraisals");
    await expect(palette.getByRole("option", { name: /Appraisals/ }).first()).toBeVisible();

    // Escape closes it, hands focus back to the field, and that focus does not open it again.
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await expect(search).toBeFocused();
    await page.waitForTimeout(300);
    await expect(palette).toBeHidden();

    // The bell: a pop-over with the inbox link; Escape closes it and focus returns to the bell.
    const bell = page.getByRole("button", { name: /^Notifications/ });
    await press(bell);
    const pop = page.getByRole("region", { name: "Notifications" });
    await expect(pop).toBeVisible();
    await expect(pop.getByRole("link", { name: "Open inbox" })).toHaveAttribute("href", "/me/inbox");
    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
    await expect(bell).toBeFocused();
  });

  test("the avatar menu holds Theme and the way back to the classic layout, which brings the classic sidebar back", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/departments/dept-5");

    await press(page.getByRole("button", { name: "Clement Hansel" }));
    const account = page.getByRole("menu", { name: "Account menu" });
    await expect(account).toBeVisible();
    await expect(account.getByRole("group", { name: "Theme" })).toBeVisible();
    await expect(account.getByRole("menuitem", { name: "Account settings" })).toBeVisible();
    await expect(account.getByRole("menuitem", { name: "Sign out" })).toBeVisible();

    // The Theme control works from here: pinning dark sets the attribute on <html> at once.
    await account.getByRole("radio", { name: /dark/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await account.getByRole("menuitem", { name: "Back to the classic layout" }).click();
    // Classic sidebar back: its pinned Dashboard row and the floating assistant button; no workspace switcher.
    await expect(page.getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open assistant" })).toBeVisible();
    await expect(switcher(page)).toHaveCount(0);
  });

  test("the AI Assistant row opens the drawer over the page with the page's context; Escape closes it and focus returns to the row", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    // A page with a resolvable entity, so the context the row carries is visible in the drawer.
    await page.goto("/projects/p-web-1");

    const row = menu(page, "Office of the GM").getByRole("link", { name: "AI Assistant" });
    // The page context rides in the link (`ctx=`), the same href the classic floating button builds.
    await expect(row).toHaveAttribute("href", /^\/assistant\?ctx=/);
    await hydrated(row);
    await row.click();
    const dialog = page.getByRole("dialog", { name: "Assistant" });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/assistant/);
    await expect(dialog.getByRole("button", { name: /Pinned: Client site redesign/ })).toBeVisible();
    // The workspace shell has no floating button; the row is the trigger.
    await expect(page.getByRole("link", { name: "Open assistant" })).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(row).toBeFocused();
  });

  test('"+ New" lists the workspace\'s own create action first, where it has one', async ({ page, context }) => {
    await signIn(page, context, "superadmin");

    // [department id, the workspace's own create action (lib/workspaces.ts `creates`)]
    const owns: [string, string][] = [
      ["dept-1", "New briefing"],
      ["dept-2", "Upload to library"],
      ["dept-3", "New content brief"],
      ["dept-4", "Compose a post"],
    ];
    for (const [dept, label] of owns) {
      await page.goto(`/departments/${dept}`);
      await press(sidebar(page).getByRole("button", { name: "New" }));
      const items = page.getByRole("menu").getByRole("menuitem");
      await expect(items.first()).toHaveText(label);
      // The general items follow, without a duplicate of the lead one.
      await expect(items.filter({ hasText: "Project" }).first()).toBeVisible();
      await expect(items.filter({ hasText: label })).toHaveCount(1);
    }

    // The Office of the GM has no create action of its own: the list is the general one, unchanged.
    await page.goto("/departments/dept-5");
    await press(sidebar(page).getByRole("button", { name: "New" }));
    await expect(page.getByRole("menu").getByRole("menuitem").first()).toHaveText("Project");
  });

  test("`/` is a real redirect to the home workspace's Overview, not a streamed 200 (DW-3a2)", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    // page.request shares the context's cookies (session, tenant, pilot) and is told NOT to follow redirects.
    const res = await page.request.get("/", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"] ?? "").toMatch(/\/departments\/dept-5$/);
    // A client cannot steer the layout with its own pathname header.
    const spoofed = await page.request.get("/projects", { maxRedirects: 0, headers: { "x-gaiada-pathname": "/" } });
    expect(spoofed.status()).toBe(200);
  });

  test("`/` is a plain 200 for a classic user, even one whose home is a workspace (DW-3a2)", async ({ page, context }) => {
    await signIn(page, context, "superadmin", { pilot: false });
    const res = await page.request.get("/", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
  });

  test("classic is untouched without the pilot cookie: classic sidebar, floating assistant button, and a way into the new layout", async ({ page, context }) => {
    await signIn(page, context, "superadmin", { pilot: false });
    await page.goto("/");

    await expect(page.getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
    const fab = page.getByRole("link", { name: "Open assistant" });
    await expect(fab).toBeVisible();
    await expect(switcher(page)).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible(); // the classic top bar's own form (a text input, not the new bar's searchbox)

    // The switch is reachable from the classic avatar menu and lands in the new shell.
    await press(page.getByRole("button", { name: "Clement Hansel" }));
    await page.getByRole("menuitem", { name: "Try the new layout" }).click();
    await expect(switcher(page)).toBeVisible();
    await expect(page.getByRole("link", { name: "Open assistant" })).toHaveCount(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// manager: the narrowed GM view still makes the Office of the GM their own workspace; no Admin.
// ──────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("manager (manager@gaiada.com)", () => {
  test("home is the Office of the GM through narrowed GM access; no Admin", async ({ page, context }) => {
    await signIn(page, context, "manager");
    await page.goto("/");
    await expect(page).toHaveURL(/\/departments\/dept-5$/);

    await expect(menu(page, "Office of the GM")).toBeVisible();
    const { mine } = await openSwitcher(page);
    await expect(mine.getByRole("link")).toHaveText([/^Office of the GM\s*Home$/]);
    await page.keyboard.press("Escape");

    await expect(sidebar(page).getByRole("link", { name: "Company", exact: true })).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// member: no placement, no GM access, so no workspace of their own. Home is the Company area.
// ──────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("member (gede@gaiada.com)", () => {
  test("`/` is a plain 200 for a member whose home is Company (DW-3a2)", async ({ page, context }) => {
    await signIn(page, context, "member");
    const res = await page.request.get("/", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
  });

  test("with no workspace of their own the switcher lists only departments, home is Company, and Admin is absent", async ({ page, context }) => {
    await signIn(page, context, "member");
    await page.goto("/");

    await expect(menu(page, "Company")).toBeVisible();
    await expect(page.getByRole("button", { name: "Company, Gaia Digital Agency. Switch workspace" })).toBeVisible();
    // At home there is no "Back to" and no "Visiting".
    await expect(sidebar(page).getByRole("link", { name: /^Back to / })).toHaveCount(0);
    await expect(sidebar(page).getByText(/^Visiting /)).toHaveCount(0);

    const { mine, others } = await openSwitcher(page);
    await expect(mine).toHaveCount(0);
    const names = (await others.getByRole("link").allTextContents()).map((t) => t.replace(/\s*Home$/, ""));
    expect(names.slice(0, 5)).toEqual(["Office of the GM", ...DEPARTMENTS]);
    await page.keyboard.press("Escape");

    await expect(sidebar(page).getByRole("link", { name: "Company", exact: true })).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
    // DW-D20: an Admin-area page is reachable only by those allowed to use it. A member who types the URL gets
    // the 404 page, for Settings and for a Platform page alike.
    for (const url of ["/admin", "/systems/hub"]) {
      await page.goto(url);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(/page not found/i);
    }
  });

  test("visiting a department says so and Back returns to Company; its own create action leads + New", async ({ page, context }) => {
    await signIn(page, context, "member");
    await page.goto("/departments/dept-3");

    await expect(sidebar(page).getByText("Visiting SEO")).toBeVisible();
    await expect(menu(page, "SEO")).toBeVisible();
    await press(sidebar(page).getByRole("button", { name: "New" }));
    await expect(page.getByRole("menu").getByRole("menuitem").first()).toHaveText("New content brief");
    await page.keyboard.press("Escape");

    const back = sidebar(page).getByRole("link", { name: "Back to Company" });
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(/\/departments$/);
    await expect(menu(page, "Company")).toBeVisible();
    await expect(sidebar(page).getByText(/^Visiting /)).toHaveCount(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// search_staff: same shape as member (placed nowhere), a different role. SEO is a department to visit.
// ──────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("search_staff (seo-staff@gaiada.com)", () => {
  test("home is Company; visiting SEO shows the visit; Admin is absent", async ({ page, context }) => {
    await signIn(page, context, "search_staff");
    await page.goto("/");
    await expect(menu(page, "Company")).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);

    await page.goto("/departments/dept-3");
    await expect(sidebar(page).getByText("Visiting SEO")).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: "Back to Company" })).toBeVisible();
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// DW-3a/3b/3c: the Overview's frame and its Now band. A placed employee (webdev@gaiada.com = u-dev, Web Dev >
// Frontend) lands on their department's Overview from `/`. Needs you, Today, Your numbers, My activity, Pulse, the Work band (Projects, Campaigns, Requests) and the Growth band (Learning, Appraisal) are built; every other
// block is still planned, so under them is today's page body (nothing is removed, plan §2.6 rule 1); never an invented
// number.
// ──────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("the Overview's frame: a placed Web Dev employee (webdev@gaiada.com)", () => {
  const greeting = /^Good (morning|afternoon|evening), Made$/;

  test("from / they land on the Web Dev Overview: greeting, workspace line, period selector, honest empty state", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/");

    await expect(page).toHaveURL(/\/departments\/dept-1$/);
    await expect(menu(page, "Web Dev")).toBeVisible();
    // Home, not a visit: no "Visiting" and no way "back".
    await expect(sidebar(page).getByText(/^Visiting /)).toHaveCount(0);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(greeting);
    // Right after a load, React's streaming holder `div#S:0[hidden]` can still hold a copy of the page next to the
    // revealed one for a moment (seen on sumopod, in the retry of a diagnostic run, for about 170 ms). It is not
    // visible, so the claim is that exactly ONE copy is visible.
    await expect(page.getByText(/^Web Dev · Gaia Digital Agency · (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day \d{1,2} [A-Z][a-z]+$/).locator("visible=true")).toHaveCount(1);

    const period = page.getByRole("group", { name: "Period" });
    await expect(period.getByRole("button")).toHaveText(["Today", "Week", "Month", "Quarter", "Semester", "Year"]);
    await expect(period.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    // A period the backend cannot report yet (if any: DW-4a is turning them on) carries its reason.
    for (const b of await period.locator('button[aria-disabled="true"]').all()) {
      await expect(b).toHaveAccessibleDescription(/^Available when /);
    }

    // The workspace's built quick actions, made concrete.
    const actions = page.getByRole("navigation", { name: "Quick actions" });
    await expect(actions.getByRole("link", { name: "New briefing" })).toHaveAttribute("href", "/departments/dept-1/prd");

    // Only the Now, You, Department (Pulse) and Work bands are built, so what today's department Home shows that no block does
    // stays below them, under its own label, and the "being built" line is not needed.
    await expect(page.getByRole("heading", { level: 2, name: "Now", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "You", exact: true })).toBeVisible();
    await expect(page.locator("#main-content").getByRole("heading", { level: 2, name: "Web Dev", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "More from Web Dev" })).toBeVisible();
    // DW-3z: what stays under it is what no block covers (the KPI strip), no longer Project health: that is the Projects block now.
    await expect(page.locator("#main-content .ov-legacy .dept-kpi-strip")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Project health" })).toHaveCount(0);
    await expect(page.getByText(/Overview is being built/)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: "Work", exact: true })).toBeVisible();
    await expect(page.locator("#main-content").getByRole("heading", { level: 2, name: "Growth", exact: true })).toBeVisible();
  });

  // DW-3c: what `/` showed before it redirected (the queue, the check-in) is on the Overview, so a pilot user
  // loses nothing when `/` sends them here.
  test("the Now band has Needs you and Today: the queue (or its honest empty line), the check-in and the tools", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/");
    await expect(page).toHaveURL(/\/departments\/dept-1$/);

    const needs = page.getByRole("region", { name: "Needs you", exact: true });
    await expect(needs).toBeVisible();
    await expect(needs.getByRole("heading", { level: 3 })).toHaveText(/^Needs you( · \d+)?$/);
    // Never "Unavailable" with the demo backend, and never a bare 0: either rows or the empty line.
    await expect(needs.getByText("Unavailable")).toHaveCount(0);
    const rows = needs.locator(".needs-me-queue__row");
    if ((await rows.count()) === 0) {
      await expect(needs.getByText(/Nothing needs you right now|Nothing found in the sources that could be read/)).toBeVisible();
    } else {
      await expect(needs.getByRole("heading", { level: 3 })).toHaveText(/^Needs you · \d+$/);
      // A decidable item keeps today's inline decide: Approve always comes with Deny. Never clicked here.
      for (const row of await rows.all()) {
        if ((await row.getByRole("button", { name: "Approve" }).count()) > 0) {
          await expect(row.getByRole("button", { name: "Deny" })).toBeVisible();
        }
      }
    }
    // The queue is capped at six rows until "Show all" opens the rest in place.
    expect(await rows.count()).toBeLessThanOrEqual(6);

    const today = page.getByRole("region", { name: "Today", exact: true });
    await expect(today).toBeVisible();
    await expect(today.getByText("Check-in unavailable")).toHaveCount(0);
    // The check-in is the card (a form to submit) or its one-line states: submitted, excused, not expected.
    await expect(today.locator(".checkin-card__form, .checkin-line").first()).toBeVisible();
    await expect(today.getByRole("heading", { level: 4, name: "Due today" })).toBeVisible();
    // Web Dev's tools, as the department Home's row draws them (icon links named by the tool).
    await expect(today.getByRole("heading", { level: 4, name: "Tools" })).toBeVisible();
    await expect(today.getByRole("link", { name: /^GitHub/ })).toBeVisible();
    await expect(today.getByRole("link", { name: /^Claude Code/ })).toBeVisible();
  });

  // DW-3d: the You band's Your numbers. The demo backend's person document carries tasks completed and the
  // on-time rate but not hours logged or check-in compliance, so those two tiles are honestly "No data" here; the
  // test accepts a figure or "No data" for every tile and never a bare 0 for a ratio.
  test("the You band has Your numbers: four tiles, and a quiet note when the period starts before the records", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/departments/dept-1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(greeting);

    const numbers = page.getByRole("region", { name: "Your numbers", exact: true });
    await expect(numbers).toBeVisible();
    await expect(numbers.getByRole("heading", { level: 3, name: "Your numbers" })).toBeVisible();
    await expect(numbers.getByText("Unavailable")).toHaveCount(0);
    const tiles = numbers.getByRole("listitem");
    await expect(tiles).toHaveCount(4);
    const figure = /^(No data|\d[\d,.]*( h|%| of \d[\d,.]*)?)$/;
    for (const [i, label] of ["Tasks done", "On time", "Hours logged", "Check-ins"].entries()) {
      await expect(tiles.nth(i).locator(".ov-nums__label")).toHaveText(label);
      await expect(tiles.nth(i).locator(".ov-nums__value")).toHaveText(figure);
    }
    // A month starts after the records do: no partial-history note, and the report link carries the period.
    await expect(numbers.getByText(/cover only part of this period/)).toHaveCount(0);
    await expect(numbers.getByRole("link", { name: "Open my report" })).toHaveAttribute("href", /^\/reports\/person\?periodKind=month&start=\d{4}-\d{2}-\d{2}$/);

    // The year re-renders the block. The demo records begin on 1 May 2026, so a year that starts before it says
    // the numbers are partial, and one that does not says nothing.
    await press(page.getByRole("group", { name: "Period" }).getByRole("button", { name: "Year" }));
    await expect(page).toHaveURL(/\/departments\/dept-1\?period=year$/);
    await expect(page.getByRole("group", { name: "Period" }).getByRole("button", { name: "Year" })).toHaveAttribute("aria-pressed", "true");
    await expect(numbers.getByRole("link", { name: "Open my report" })).toHaveAttribute("href", /periodKind=year&start=/);
    const note = numbers.getByText(/cover only part of this period: records begin on 1 May 2026/);
    if (new Date().getUTCFullYear() <= 2026) await expect(note).toBeVisible();
    else await expect(note).toHaveCount(0);
    await expect(numbers.getByRole("listitem")).toHaveCount(4);
    await expect(numbers.getByText("Unavailable")).toHaveCount(0);

    // DW-3d2: the semester's previous period (Jan - Jun) starts before the demo records do, so in the second half
    // of 2026 the block says the comparison is partial. The demo carries the DW-4m flags.
    await press(page.getByRole("group", { name: "Period" }).getByRole("button", { name: "Semester" }));
    await expect(page).toHaveURL(/\/departments\/dept-1\?period=semester$/);
    await expect(page.getByRole("group", { name: "Period" }).getByRole("button", { name: "Semester" })).toHaveAttribute("aria-pressed", "true");
    const compared = page.locator("#main-content").getByText("Compared with a period that starts before records began on 1 May 2026.");
    const nowUtc = new Date();
    if (nowUtc.getUTCFullYear() === 2026 && nowUtc.getUTCMonth() >= 6) await expect(compared).toBeVisible();
    // Scoped to the block: the Work band's Requests says Unavailable in the demo (DW-3f), and that is its own honest state.
    await expect(numbers.getByText("Unavailable")).toHaveCount(0);
  });

  // DW-3j: the You band's My activity. Either the 16-week map with Today so far (the demo backend has the series),
  // or the honest "isn't available here yet" line; never "Unavailable", and never a score. Looked up inside the page
  // (`#main-content`): while it streams, React briefly holds a hidden copy of it outside.
  test("the You band has My activity: the 16-week map and today so far, or the not-available line, and no score", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/departments/dept-1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(greeting);

    const main = page.locator("#main-content");
    const activity = main.getByRole("region", { name: "My activity", exact: true });
    await expect(activity).toBeVisible();
    await expect(activity.getByRole("heading", { level: 3, name: "My activity" })).toBeVisible();
    await expect(activity.getByText("Unavailable")).toHaveCount(0);
    if (await activity.getByText("Activity isn't available here yet").count()) {
      await expect(activity.getByRole("link", { name: "Open my activity" })).toHaveCount(0);
    } else {
      await expect(activity.getByText("Counts project-management work for now")).toBeVisible();
      await expect(activity.getByRole("img", { name: /^Activity calendar, / })).toBeVisible();
      await expect(activity.getByRole("heading", { level: 4, name: "Today so far" })).toBeVisible();
      await expect(activity.getByRole("link", { name: "Open my activity" })).toHaveAttribute("href", "/pm?view=productivity");
      // At most 16 full weeks and this week so far (119 days), each with a count on a date, never a score. The demo
      // backend's clock stands at 16 July 2026 and its series starts at the request's `from`, so under DEMO_MODE the
      // map holds a few weeks, not 16 (the 16-week window itself is pinned in lib/overviewActivity.test.ts).
      const cells = activity.locator(".prod-heatmap__cell[data-level]");
      expect(await cells.count()).toBeGreaterThanOrEqual(1);
      expect(await cells.count()).toBeLessThanOrEqual(17 * 7);
      await expect(cells.first()).toHaveAttribute("title", /^\d+ things? on \d{2} [A-Z][a-z]{2} \d{4}$/);
    }
    await expect(activity.getByText(/score|rating/i)).toHaveCount(0);
  });

  // DW-3e: the Department band's Pulse. Web Dev's three built tiles, each a count or, in words, why there is none
  // ("Unavailable" for a failed read, "No access" for a refused one); never an empty tile. Which of the three the
  // demo backend answers is not asserted. Looked up inside the page (`#main-content`).
  test("the Department band has Pulse: Web Dev's three tiles, each a count, Unavailable or No access", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/departments/dept-1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(greeting);

    const main = page.locator("#main-content");
    const pulse = main.getByRole("region", { name: "Pulse", exact: true });
    await expect(pulse).toBeVisible();
    // The block itself may be the boundary's "Unavailable" only if every tile failed; then it has no tiles.
    const tiles = pulse.getByRole("listitem");
    if (await tiles.count()) {
      await expect(tiles).toHaveCount(3);
      await expect(tiles.locator(".ov-nums__label")).toHaveText(["Requests waiting", "Sites with a problem", "Runs waiting approval"]);
      for (const value of await tiles.locator(".ov-nums__value").all()) await expect(value).toHaveText(/^(\d+|Unavailable|No access)$/);
    } else {
      await expect(pulse.getByText("Unavailable")).toBeVisible();
    }
    // A planned tile is never drawn.
    await expect(pulse.getByText("Deliverables due")).toHaveCount(0);
  });

  // DW-3f: the Work band. With the DEMO_MODE backend the three blocks are in these honest states, each asserted exactly:
  //  - Projects: Web Dev's open projects (the demo serves `GET projects?departmentId=`), "Client site redesign" first
  //    because it has a blocked task (at risk), each with its health and next due date (all the demo dates are past, so
  //    "No upcoming due date" is as honest as a date);
  //  - Campaigns: the demo's two campaigns, which carry no part for the department ("Our part: No part");
  //  - Requests: the demo has no `requests/summary`, so the read fails and the block says Unavailable, never 0.
  // Looked up inside the page (`#main-content`), because React's streaming leaves a hidden copy of it outside.
  test("the Work band has Projects, Campaigns and Requests, each in its honest demo state", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/departments/dept-1");
    await expect(page).toHaveURL(/\/departments\/dept-1$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(greeting);

    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { level: 2, name: "Work", exact: true })).toBeVisible();

    const projects = main.getByRole("region", { name: "Projects", exact: true });
    await expect(projects).toBeVisible();
    await expect(projects.getByText("Unavailable")).toHaveCount(0);
    const items = projects.getByRole("listitem");
    // The demo store is shared by every test in a run, so a project another test created in Web Dev may sit beside
    // the two seeded ones; the block shows at most four, with the blocked one first.
    await expect.poll(async () => await items.count()).toBeGreaterThanOrEqual(2);
    expect(await items.count()).toBeLessThanOrEqual(4);
    await expect(items.nth(0)).toContainText("Client site redesign");
    await expect(items.nth(0)).toContainText(/At risk · .*blocked/);
    for (const item of await items.all()) {
      await expect(item).toContainText(/(At risk · .+|On track|No tasks yet)/);
      await expect(item).toContainText(/(Next due \d{2} [A-Z][a-z]{2} \d{4}|No upcoming due date)/);
    }
    await expect(items.nth(0).getByRole("link", { name: "Client site redesign" })).toHaveAttribute("href", "/projects/p-web-1");
    await expect(projects.getByRole("link", { name: "All projects" })).toHaveAttribute("href", "/departments/dept-1/projects");

    const campaigns = main.getByRole("region", { name: "Campaigns", exact: true });
    await expect(campaigns).toBeVisible();
    await expect(campaigns.getByRole("listitem")).toHaveCount(2);
    await expect(campaigns.getByRole("link", { name: "Q3 lead-gen push" })).toBeVisible();
    await expect(campaigns.getByRole("link", { name: "Brand awareness — social" })).toBeVisible();
    await expect(campaigns.getByText("Our part: No part")).toHaveCount(2);
    await expect(campaigns.getByText("Unavailable")).toHaveCount(0);
    await expect(campaigns.getByRole("link", { name: "Shared campaigns" })).toHaveAttribute("href", "/departments/dept-1/campaigns");

    const requests = main.getByRole("region", { name: "Requests", exact: true });
    await expect(requests).toBeVisible();
    await expect(requests.getByText("Unavailable")).toBeVisible();
    await expect(requests.getByRole("listitem")).toHaveCount(0);
    await expect(requests.getByText(/^\d+$/)).toHaveCount(0);
  });

  // DW-3g: the Growth band, for the signed-in person (Made Putra, u-dev). The DEMO_MODE build gives each block this state:
  //  - Learning: `lms/me` is the demo's one fixture for everyone: 2 outstanding (one in progress), 1 overdue, and the next
  //    due is "Security awareness" on 18 Aug 2026, which the backend flags overdue;
  //  - Appraisal: u-dev's H1 pack is DISPUTED, so it is the current pack, with no next step for the subject, and no pack is
  //    finalized, so there is no last result.
  test("the Growth band has Learning and Appraisal, each in its honest demo state", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/");
    await expect(page).toHaveURL(/\/departments\/dept-1$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(greeting);

    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { level: 2, name: "Growth", exact: true })).toBeVisible();

    const learning = main.getByRole("region", { name: "Learning", exact: true });
    await expect(learning).toBeVisible();
    await expect(learning.getByText("2 outstanding, 1 in progress")).toBeVisible();
    await expect(learning.getByText("1 overdue")).toBeVisible();
    await expect(learning.getByText("Next due: Security awareness, 18 Aug 2026 (overdue)")).toBeVisible();
    await expect(learning.getByText("Unavailable")).toHaveCount(0);
    await expect(learning.getByRole("link", { name: "My learning" })).toHaveAttribute("href", "/me/learning");

    const appraisal = main.getByRole("region", { name: "Appraisal", exact: true });
    await expect(appraisal).toBeVisible();
    await expect(appraisal.getByText("2026 H1 Performance Review: Disputed")).toBeVisible();
    await expect(appraisal.getByText(/My next step/)).toHaveCount(0);
    await expect(appraisal.getByText(/Last result/)).toHaveCount(0);
    await expect(appraisal.getByText(/No appraisal yet|Unavailable|No access/)).toHaveCount(0);
    await expect(appraisal.getByRole("link", { name: "My appraisals" })).toHaveAttribute("href", "/appraisals/mine");
  });

  test("the department's own header is not doubled on the Overview, and stays on its other pages", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/departments/dept-1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(greeting);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1, name: "Web Dev", exact: true })).toHaveCount(0);

    // Another page of the same department keeps the console's header exactly as it was.
    await page.goto("/departments/dept-1/board");
    await expect(page.getByRole("heading", { level: 1, name: "Web Dev", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Period" })).toHaveCount(0);
  });

  test("choosing Week puts period=week in the URL, and a disabled period changes nothing", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/departments/dept-1");
    const period = page.getByRole("group", { name: "Period" });

    await press(period.getByRole("button", { name: "Week" }));
    await expect(page).toHaveURL(/\/departments\/dept-1\?period=week$/);
    await expect(period.getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
    await expect(period.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "false");

    // A disabled option, if there is one, is not selectable. Playwright will not click an aria-disabled button,
    // so the click is dispatched; the page must ignore it.
    for (const b of await period.locator('button[aria-disabled="true"]').all()) {
      await hydrated(b);
      await b.dispatchEvent("click");
    }
    await expect(page).toHaveURL(/\/departments\/dept-1\?period=week$/);
    await expect(period.getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");

    // A forged period in the URL reads as Month.
    await page.goto("/departments/dept-1?period=bogus");
    await expect(page.getByRole("group", { name: "Period" }).getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
  });

  test("another department's Overview is its own: visiting SEO shows SEO, with its own line", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/departments/dept-3");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(greeting);
    // Scoped to the page: while the page streams, React briefly holds a hidden copy outside #main-content.
    await expect(page.locator("#main-content").getByText(/^SEO · Gaia Digital Agency · /)).toBeVisible();
    await expect(sidebar(page).getByText("Visiting SEO")).toBeVisible();
  });

  // DW-3z (plan §3.8): the Overview stands on its own where a block covers a section of today's Home. Project health is the Projects
  // block, which links All projects; Recent activity is Project Management > Activity; Build tools are the Today tools and
  // Tools & connections. The KPI strip, the Team roster and the serviced companies have no block, so they stay.
  test("under More from Web Dev: Project health, Recent activity and Build tools are gone, what no block covers stays, and each removed one is a click away (DW-3z)", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/departments/dept-1");
    const main = page.locator("#main-content");
    const legacy = main.locator(".ov-legacy");
    await expect(main.getByRole("heading", { level: 2, name: "More from Web Dev" })).toBeVisible();
    await expect(legacy.locator(".dept-kpi-strip")).toBeVisible();
    await expect(legacy.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
    for (const name of ["Project health", "Recent activity", "Build tools"]) {
      await expect(main.getByRole("heading", { name, exact: true }), name).toHaveCount(0);
    }
    // The Overview's own blocks carry what replaced them.
    const projects = main.getByRole("region", { name: "Projects", exact: true });
    await expect(projects.getByRole("link", { name: "All projects" })).toHaveAttribute("href", "/departments/dept-1/projects");
    await expect(main.getByRole("region", { name: "Today", exact: true })).toBeVisible();

    // One click from the Overview: the Project Management row's Activity tab, and the Tools & connections row.
    const work = menu(page, "Web Dev").getByRole("group", { name: "Work" });
    const pm = work.getByRole("link", { name: "Project Management", exact: true });
    await hydrated(pm);
    await pm.click();
    const tab = page.getByRole("navigation", { name: "Project Management sections" }).getByRole("link", { name: "Activity", exact: true });
    await hydrated(tab);
    await tab.click();
    await expect(page).toHaveURL(/\/departments\/dept-1\/activity$/);
    await page.goto("/departments/dept-1");
    const tools = work.getByRole("link", { name: "Tools & connections", exact: true });
    await hydrated(tools);
    await tools.click();
    await expect(page).toHaveURL(/\/departments\/dept-1\/connections$/);
    await expect(page.locator("#main-content").getByRole("heading", { name: "Tools", exact: true })).toBeVisible();
  });

  test("a classic user's / and department page are unchanged", async ({ page, context }) => {
    await signInWebDev(page, context, { pilot: false });
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Period" })).toHaveCount(0);

    await page.goto("/departments/dept-1");
    await expect(page.getByRole("heading", { level: 1, name: "Web Dev", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Project health" })).toBeVisible();
    // DW-3z removes nothing from a classic page: every card of today's Home is still there.
    for (const name of ["Recent activity", "Build tools", "Team"]) await expect(page.getByRole("heading", { name, exact: true }).first(), name).toBeVisible();
    await expect(page.locator(".ov-legacy")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Period" })).toHaveCount(0);
    await expect(page.getByText(/Overview is being built/)).toHaveCount(0);
    // None of the Overview's Work band (DW-3f) reaches a classic user.
    await expect(page.getByRole("heading", { level: 2, name: "Work", exact: true })).toHaveCount(0);
    for (const name of ["Projects", "Campaigns", "Requests"]) await expect(page.getByRole("region", { name, exact: true })).toHaveCount(0);
    // Nor the Growth band (DW-3g).
    await expect(page.getByRole("heading", { level: 2, name: "Growth", exact: true })).toHaveCount(0);
    for (const name of ["Learning", "Appraisal"]) await expect(page.getByRole("region", { name, exact: true })).toHaveCount(0);
  });
});

// DW-3h: the head's Me | Team switch (plan §3.4). Under DEMO_MODE the head of Web Dev is `webhead@gaiada.com` (u-webhead:
// `member` plus `org_unit_lead` on dept-1; a led unit makes its department their home). The DEMO_MODE build gives each Team
// block this state:
//  - Team numbers: the department document carries on-time, blocked share and capacity (fixtures), the check-in grid is the led
//    roster (u-dev, u-pm), so each tile is a figure or "No data" (a month starting today has no past working day), never a bare 0;
//  - Team needs you: the demo has no `requests/summary`, so "Waiting on Web Dev" says Unavailable, and the blocked tasks of the
//    open Web Dev projects are real ("Client site redesign" has one);
//  - Team learning: `lms compliance?unit=dept-1` is 2 people, 4 required assignments, 3 complete: 75%, 1 overdue;
//  - Team appraisals: the head's list is u-dev's pack (disputed) plus whatever the shared demo store holds for the roster.
// The demo store is shared by every test in a run, so a count another spec could move is matched by shape, not by number.
test.describe("the Overview's Me | Team switch: a head of department (webhead@gaiada.com)", () => {
  const greeting = /^Good (morning|afternoon|evening), Ketut$/;
  const figure = /^(No data|\d[\d,.]*( h|%)?( of \d[\d,.]*( h)?)?)$/;

  test("a head sees the switch, defaulting to Me; the Me blocks are the ones everyone has", async ({ page, context }) => {
    await signInWebDevHead(page, context);
    await page.goto("/");
    await expect(page).toHaveURL(/\/departments\/dept-1$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(greeting);

    const main = page.locator("#main-content");
    const view = page.getByRole("navigation", { name: "View" });
    await expect(view.getByRole("link")).toHaveText(["Me", "Team"]);
    await expect(view.getByRole("link", { name: "Me" })).toHaveAttribute("aria-current", "true");
    await expect(view.getByRole("link", { name: "Team" })).not.toHaveAttribute("aria-current", "true");
    await expect(view.getByRole("link", { name: "Team" })).toHaveAttribute("href", "?period=month&view=team");

    await expect(main.getByRole("region", { name: "Your numbers", exact: true })).toBeVisible();
    await expect(main.getByRole("region", { name: "Needs you", exact: true })).toBeVisible();
    await expect(main.getByRole("region", { name: "Learning", exact: true })).toBeVisible();
    await expect(main.getByRole("region", { name: "Appraisal", exact: true })).toBeVisible();
    for (const name of ["Team numbers", "Team needs you", "Team learning", "Team appraisals"]) {
      await expect(main.getByRole("region", { name, exact: true })).toHaveCount(0);
    }
    await expect(main.getByRole("heading", { level: 2, name: "You", exact: true })).toBeVisible();
  });

  test("Team shows the four Team blocks in their honest demo state, and Me brings the person's own back", async ({ page, context }) => {
    await signInWebDevHead(page, context);
    await page.goto("/departments/dept-1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(greeting);
    const main = page.locator("#main-content");
    const view = page.getByRole("navigation", { name: "View" });

    await press(view.getByRole("link", { name: "Team" }));
    await expect(page).toHaveURL(/\/departments\/dept-1\?period=month&view=team$/);
    await expect(view.getByRole("link", { name: "Team" })).toHaveAttribute("aria-current", "true");
    await expect(main.getByRole("heading", { level: 2, name: "You and your team" })).toBeVisible();

    // Team numbers: four tiles, each a figure or "No data".
    const numbers = main.getByRole("region", { name: "Team numbers", exact: true });
    await expect(numbers).toBeVisible();
    await expect(numbers.getByText("Unavailable")).toHaveCount(0);
    await expect(numbers.getByText("No access")).toHaveCount(0);
    const tiles = numbers.getByRole("listitem");
    await expect(tiles).toHaveCount(4);
    for (const [i, label] of ["Check-ins sent", "On time", "Blocked share", "Hours vs capacity"].entries()) {
      await expect(tiles.nth(i).locator(".ov-nums__label")).toHaveText(label);
      await expect(tiles.nth(i).locator(".ov-nums__value")).toHaveText(figure);
    }
    // The department document's own figures are there (not "No data"): on time is a percentage of tasks, hours a pair of hours.
    await expect(tiles.nth(1).locator(".ov-nums__value")).toHaveText(/^\d+%$/);
    await expect(tiles.nth(1).locator(".ov-nums__detail")).toHaveText(/^[\d,]+ of [\d,]+ tasks$/);
    await expect(tiles.nth(3).locator(".ov-nums__value")).toHaveText(/^\d[\d,.]* h of \d[\d,.]* h$/);
    await expect(numbers.getByRole("link", { name: "Open the team report" })).toHaveAttribute("href", /^\/reports\/team\?unit=dept-1&periodKind=month&start=\d{4}-\d{2}-\d{2}/);

    // Team needs you: requests (no summary in the demo) and the blocked tasks of the open projects.
    const needs = main.getByRole("region", { name: "Team needs you", exact: true });
    await expect(needs).toBeVisible();
    await expect(needs.locator("[data-part=requests]")).toContainText("Waiting on Web Dev");
    await expect(needs.locator("[data-part=requests]")).toContainText(/(Unavailable|No access|No request is waiting|\d+ requests? waiting)/);
    await expect(needs.locator("[data-part=blockers]")).toContainText(/\d+ blocked tasks?/);
    await expect(needs.locator("[data-part=blockers]").getByRole("link", { name: "Client site redesign" })).toHaveAttribute("href", "/projects/p-web-1");

    // Team learning and Team appraisals.
    const learning = main.getByRole("region", { name: "Team learning", exact: true });
    await expect(learning).toBeVisible();
    await expect(learning.getByText("75% complete")).toBeVisible();
    await expect(learning.getByText("3 of 4 required assignments, 2 people")).toBeVisible();
    await expect(learning.getByText("1 overdue")).toBeVisible();
    await expect(learning.getByRole("link", { name: "Team progress" })).toHaveAttribute("href", "/learning/compliance?unit=dept-1");
    const appraisals = main.getByRole("region", { name: "Team appraisals", exact: true });
    await expect(appraisals).toBeVisible();
    await expect(appraisals.locator("[data-part=finalized]")).toHaveText(/^\d+ of \d+ finalized$/);
    await expect(appraisals.getByText(/disputed/)).toBeVisible();
    await expect(appraisals.getByText(/^Across \d+ cycles?, the people you lead and score$/)).toBeVisible();
    await expect(appraisals.getByRole("link", { name: "Team appraisals" })).toHaveAttribute("href", "/appraisals");

    // The person's own blocks are not drawn in Team mode.
    for (const name of ["Your numbers", "Needs you", "Learning", "Appraisal"]) await expect(main.getByRole("region", { name, exact: true })).toHaveCount(0);

    // Me brings them back.
    await press(view.getByRole("link", { name: "Me" }));
    await expect(page).toHaveURL(/\/departments\/dept-1\?period=month$/);
    await expect(main.getByRole("region", { name: "Your numbers", exact: true })).toBeVisible();
    await expect(main.getByRole("region", { name: "Team numbers", exact: true })).toHaveCount(0);
  });

  test("the period selector keeps the view, and the switch keeps the period", async ({ page, context }) => {
    await signInWebDevHead(page, context);
    await page.goto("/departments/dept-1?period=week&view=team");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(greeting);
    const view = page.getByRole("navigation", { name: "View" });
    await expect(view.getByRole("link", { name: "Team" })).toHaveAttribute("aria-current", "true");
    await expect(view.getByRole("link", { name: "Me" })).toHaveAttribute("href", "?period=week");
    await expect(page.locator("#main-content").getByRole("region", { name: "Team numbers", exact: true })).toBeVisible();

    await press(page.getByRole("group", { name: "Period" }).getByRole("button", { name: "Month" }));
    await expect(page).toHaveURL(/\/departments\/dept-1\?period=month&view=team$/);
    await expect(page.locator("#main-content").getByRole("region", { name: "Team numbers", exact: true })).toBeVisible();
  });

  test("a head of Web Dev visiting SEO has no switch there, and ?view=team changes nothing", async ({ page, context }) => {
    await signInWebDevHead(page, context);
    await page.goto("/departments/dept-3?view=team");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(greeting);
    const main = page.locator("#main-content");
    await expect(main.getByText(/^SEO · Gaia Digital Agency · /)).toBeVisible();
    await expect(page.getByRole("navigation", { name: "View" })).toHaveCount(0);
    await expect(main.getByRole("region", { name: "Your numbers", exact: true })).toBeVisible();
    await expect(main.getByRole("region", { name: "Team numbers", exact: true })).toHaveCount(0);
  });

  test("a head on the classic layout sees none of it", async ({ page, context }) => {
    await signInWebDevHead(page, context, { pilot: false });
    await page.goto("/departments/dept-1?view=team");
    await expect(page.getByRole("heading", { level: 1, name: "Web Dev", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "View" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Period" })).toHaveCount(0);
    for (const name of ["Team numbers", "Team needs you", "Team learning", "Team appraisals"]) {
      await expect(page.getByRole("region", { name, exact: true })).toHaveCount(0);
    }
  });
});

// DW-3h: a person who does not head the department gets no switch, and `?view=team` is Me for them: nothing about a team is
// read or drawn. Made Putra (u-dev) is placed in Web Dev with a plain `member` grant.
test.describe("the Overview's Me | Team switch: someone who does not head the department (webdev@gaiada.com)", () => {
  const greeting = /^Good (morning|afternoon|evening), Made$/;

  test("no switch, and ?view=team changes nothing", async ({ page, context }) => {
    await signInWebDev(page, context);
    for (const url of ["/departments/dept-1", "/departments/dept-1?view=team", "/departments/dept-1?period=week&view=team"]) {
      await page.goto(url);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(greeting);
      const main = page.locator("#main-content");
      await expect(main.getByRole("region", { name: "Your numbers", exact: true })).toBeVisible();
      await expect(main.getByRole("region", { name: "Needs you", exact: true })).toBeVisible();
      await expect(main.getByRole("region", { name: "Learning", exact: true })).toBeVisible();
      await expect(main.getByRole("region", { name: "Appraisal", exact: true })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "View" })).toHaveCount(0);
      for (const name of ["Team numbers", "Team needs you", "Team learning", "Team appraisals"]) {
        await expect(main.getByRole("region", { name, exact: true })).toHaveCount(0);
      }
      await expect(main.getByRole("heading", { level: 2, name: "You and your team" })).toHaveCount(0);
    }
  });

  test("a classic user sees none of it", async ({ page, context }) => {
    await signInWebDev(page, context, { pilot: false });
    await page.goto("/departments/dept-1?view=team");
    await expect(page.getByRole("heading", { level: 1, name: "Web Dev", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "View" })).toHaveCount(0);
    for (const name of ["Team numbers", "Team needs you", "Team learning", "Team appraisals"]) {
      await expect(page.getByRole("region", { name, exact: true })).toHaveCount(0);
    }
  });
});

// DW-3k: the department's condition on its Overview (plan §5.5). The numbers are DW-4e-2's demo `dept-kpis` fixture
// (lib/demoDeptKpis.ts): Web Dev is AT RISK (Projects on time 17 of 21 = 81% against 85%), with one KPI on track, one with no
// reader and one with no target. Who reads it there: the head of Web Dev (u-webhead), staff placed in Web Dev (u-dev); anyone else
// is refused, so a visitor sees nothing at all.
test.describe("the Overview's department condition (DW-3k)", () => {
  const SENTENCE = /^Web Dev: at risk · Projects on time \d+% against 85%$/;

  test("the head of Web Dev sees the banner and a tile per KPI, first in the Department band above Pulse, in Me and in Team", async ({ page, context }) => {
    await signInWebDevHead(page, context);
    await page.goto("/");
    await expect(page).toHaveURL(/\/departments\/dept-1$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Ketut$/);
    const main = page.locator("#main-content");

    const condition = main.getByRole("region", { name: "Department condition", exact: true });
    await expect(condition).toBeVisible();
    await expect(condition).toHaveAttribute("data-state", "banner");
    await expect(condition).toHaveAttribute("data-condition", "at_risk");
    await expect(condition.getByText(SENTENCE)).toBeVisible();
    await expect(condition.locator(".dk-banner").getByText("At risk", { exact: true })).toBeVisible();
    await expect(condition.getByRole("link", { name: "Open the department KPIs" })).toHaveAttribute("href", /^\/appraisals\/department\?unit=dept-1&periodKind=month&start=\d{4}-\d{2}-\d{2}$/);

    // One tile per KPI in the catalogue's order, each with its own condition; the two with nothing to rate say why and never read as on track.
    const tiles = condition.locator("[data-kpi]");
    await expect(tiles).toHaveCount(4);
    expect(await tiles.evaluateAll((els) => els.map((e) => [e.getAttribute("data-kpi"), e.getAttribute("data-condition")]))).toEqual([
      ["projects-on-time", "at_risk"], ["requests-within-sla", "unavailable"], ["client-site-uptime", "unavailable"], ["reopened-work-rate", "on_track"],
    ]);
    const onTime = tiles.filter({ hasText: "Projects on time" });
    await expect(onTime.getByText("At risk", { exact: true })).toBeVisible();
    await expect(onTime.getByText("17 of 21")).toBeVisible();
    await expect(onTime.getByText("Target 85% (tolerance 5 pts)")).toBeVisible();
    await expect(tiles.filter({ hasText: "Requests answered within the SLA" }).getByText("No target yet")).toBeVisible();
    await expect(tiles.filter({ hasText: "Client site uptime" }).getByText("Not measured yet")).toBeVisible();

    // First block of the Department band, above Pulse.
    const band = main.locator('section.ov-band[aria-labelledby="ov-band-department"]');
    await expect(band.locator("section[aria-label]").nth(0)).toHaveAttribute("aria-label", "Department condition");
    await expect(band.locator("section[aria-label]").nth(1)).toHaveAttribute("aria-label", "Pulse");

    // Team mode keeps it: always on top for the head.
    await page.goto("/departments/dept-1?period=month&view=team");
    await expect(page).toHaveURL(/view=team$/);
    await expect(main.getByRole("region", { name: "Team numbers", exact: true })).toBeVisible();
    const inTeam = main.getByRole("region", { name: "Department condition", exact: true });
    await expect(inTeam).toHaveAttribute("data-state", "banner");
    await expect(inTeam.getByText(SENTENCE)).toBeVisible();
    await expect(inTeam.locator("[data-kpi]")).toHaveCount(4);
  });

  test("staff of Web Dev see a quiet strip: the one line, no tiles, no link", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/departments/dept-1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Made$/);
    const main = page.locator("#main-content");
    const strip = main.getByRole("region", { name: "Department condition", exact: true });
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute("data-state", "strip");
    await expect(strip.getByText(SENTENCE)).toBeVisible();
    await expect(strip.locator("[data-kpi]")).toHaveCount(0);
    await expect(strip.getByRole("list")).toHaveCount(0);
    await expect(strip.getByRole("link")).toHaveCount(0);
    await expect(main.getByRole("list", { name: "Department KPIs" })).toHaveCount(0);
    // And no ranking: the company's departments-by-condition block is not theirs.
    await expect(main.getByRole("region", { name: "Departments by condition", exact: true })).toHaveCount(0);
  });

  test("a visitor from another department sees no condition block, and no No-access box, on someone else's department", async ({ page, context }) => {
    await signInWebDev(page, context);
    await page.goto("/departments/dept-3");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Made$/);
    const main = page.locator("#main-content");
    await expect(main.getByText(/^SEO · Gaia Digital Agency · /)).toBeVisible();
    await expect(main.getByRole("region", { name: "Your numbers", exact: true })).toBeVisible();
    await expect(main.getByRole("region", { name: "Department condition", exact: true })).toHaveCount(0);
    await expect(main.getByRole("list", { name: "Department KPIs" })).toHaveCount(0);
    await expect(main.getByText("Department condition")).toHaveCount(0);
    // SEO has no other block in the Department band, so the band is not drawn over nothing.
    await expect(main.getByRole("heading", { level: 2, name: "SEO", exact: true })).toHaveCount(0);
  });

  test("the head of Web Dev visiting SEO sees no condition there: heading one department does not read another's", async ({ page, context }) => {
    await signInWebDevHead(page, context);
    await page.goto("/departments/dept-3");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Ketut$/);
    const main = page.locator("#main-content");
    await expect(main.getByText(/^SEO · Gaia Digital Agency · /)).toBeVisible();
    await expect(main.getByRole("region", { name: "Your numbers", exact: true })).toBeVisible();
    await expect(main.getByRole("region", { name: "Department condition", exact: true })).toHaveCount(0);
    await expect(main.getByRole("list", { name: "Department KPIs" })).toHaveCount(0);
  });

  test("a classic user sees none of it", async ({ page, context }) => {
    await signInWebDevHead(page, context, { pilot: false });
    await page.goto("/departments/dept-1");
    await expect(page.getByRole("heading", { level: 1, name: "Web Dev", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Department condition", exact: true })).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Department KPIs" })).toHaveCount(0);
  });
});

test.describe("the Overview's frame: the functional workspaces keep their page body", () => {
  test("/hr, /finance and /it show the Overview header with today's body under it", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    for (const [path, label] of [["/hr", "HR"], ["/finance", "Finance"], ["/it", "IT"]]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }), path).toHaveText(/^Good (morning|afternoon|evening), Clement$/);
      await expect(page.getByRole("heading", { name: `More from ${label}` }), path).toBeVisible();
      // DW-7d: HR, Finance and IT are org nodes, so the Work blocks (DW-3f) have a department to read for.
      await expect(page.getByRole("heading", { level: 2, name: "Work", exact: true }), path).toBeVisible();
      await expect(page.getByRole("group", { name: "Period" }), path).toBeVisible();
      await expect(page.getByText(/Overview is being built/), path).toHaveCount(0);
    }
  });

  // DW-3z (plan §3.8): HR's area cards and Finance's aging, configuration and period cards are rows and tabs of their workspaces, so
  // they leave the Overview's page; the counts, the integrity verdicts, the close gate and all of IT's page have no block yet, so they stay.
  // A classic user keeps every card.
  const section = (page: Page) => page.locator("#main-content .ov-legacy");
  // A card title with a "?" hint carries the hint's button inside its heading, so the name starts with the title but is not equal to it.
  const heading = (loc: Locator | Page, name: string) => loc.getByRole("heading", { name: new RegExp(`^${name.replace(/[?]/g, "\\$&")}(?!\\w)`) });

  test("/hr under the Overview: the area cards and the directory card are gone, the counts stay, and a classic user keeps every card (DW-3z)", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/hr");
    await expect(page.getByRole("heading", { name: "More from HR" })).toBeVisible();
    await expect(section(page).getByText("Leave pending")).toBeVisible();
    await expect(section(page).getByText("Open cases")).toBeVisible();
    for (const name of ["Leave", "Attendance", "Onboarding", "Cases", "People directory"]) {
      await expect(heading(page.locator("#main-content"), name), name).toHaveCount(0);
    }
    // Where they went: the workspace's own rows.
    const work = menu(page, "HR").getByRole("group", { name: "Work" });
    for (const row of ["People", "Time", "Cases & compliance"]) await expect(work.getByRole("link", { name: row, exact: true }), row).toBeVisible();

    await context.addCookies([pilotCookie(page.url(), "classic")]);
    await page.goto("/hr");
    await expect(page.locator(".ov-legacy")).toHaveCount(0);
    for (const name of ["Leave", "Attendance", "Onboarding", "Cases", "People directory"]) await expect(heading(page, name).first(), name).toBeVisible();
  });

  test("/finance under the Overview: the aging, configuration and period cards are gone, the totals, integrity and close gate stay, and a classic user keeps every card (DW-3z)", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/finance");
    await expect(page.getByRole("heading", { name: "More from Finance" })).toBeVisible();
    for (const name of ["Integrity", "Can this period close?"]) await expect(heading(section(page), name), name).toBeVisible();
    await expect(section(page).getByText("Total assets")).toBeVisible();
    for (const name of ["Receivables aging", "Payables aging", "Configuration", "Fiscal periods"]) {
      await expect(heading(page.locator("#main-content"), name), name).toHaveCount(0);
    }

    await context.addCookies([pilotCookie(page.url(), "classic")]);
    await page.goto("/finance");
    await expect(page.locator(".ov-legacy")).toHaveCount(0);
    for (const name of ["Integrity", "Can this period close?", "Receivables aging", "Payables aging", "Configuration", "Fiscal periods"]) {
      await expect(heading(page, name).first(), name).toBeVisible();
    }
  });

  test("/it under the Overview: nothing on the page is covered by a block, so all of it stays (DW-3z)", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/it");
    await expect(page.getByRole("heading", { name: "More from IT" })).toBeVisible();
    await expect(heading(section(page), "Recent device events")).toBeVisible();
    await expect(section(page).getByText("Open alerts")).toBeVisible();
  });
});

test.describe("the Overview's frame: someone whose home is the Company area", () => {
  test("a member with no workspace of their own stays on / and gets the company-level frame: Today and Campaigns, no money, no company figures", async ({ page, context }) => {
    await signIn(page, context, "member");
    await page.goto("/");

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Gede$/);
    const main = page.locator("#main-content");
    await expect(main.getByText(/^Company · Gaia Digital Agency · /)).toBeVisible();
    await expect(page.getByRole("group", { name: "Period" }).getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    await expect(main.getByText(/The Company Overview is being built/)).toHaveCount(0);
    await expect(main.getByRole("region", { name: "Today", exact: true })).toBeVisible();
    await expect(main.getByRole("region", { name: "Needs you", exact: true })).toHaveCount(0);

    // DW-3i: the campaigns across departments need only the Agency page's own gate, so the member has them (the demo has two)...
    const campaigns = main.getByRole("region", { name: "Campaigns", exact: true });
    await expect(campaigns).toBeVisible();
    await expect(campaigns.getByRole("link", { name: "Q3 lead-gen push" })).toBeVisible();
    await expect(campaigns.getByRole("link", { name: "Brand awareness — social" })).toBeVisible();
    // ...and every block behind the cockpit's gates is not placed at all: not "No access", not drawn.
    for (const name of ["Needs you: decisions", "Company", "Departments by condition", "Learning compliance", "Appraisal cycle"]) {
      await expect(main.getByRole("region", { name, exact: true }), name).toHaveCount(0);
    }
    await expect(main.getByText(/No access/)).toHaveCount(0);
    // No money anywhere on the page.
    await expect(main.getByText(/\bIDR\b/)).toHaveCount(0);
    await expect(main.getByText(/Revenue|Overdue receivables/)).toHaveCount(0);
    await expect(main.locator(".ov-band__label")).toHaveText(["Now", "Work"]);
    await expect(menu(page, "Company")).toBeVisible();
  });

  test("a platform admin's home is the Office of the GM: / goes there, and the page is the company Overview with the cockpit under it (DW-3i)", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/");
    await expect(page).toHaveURL(/\/departments\/dept-5$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Clement$/);
    const main = page.locator("#main-content");
    await expect(main.getByText(/^Office of the GM · Gaia Digital Agency · /)).toBeVisible();
    await expect(page.getByRole("group", { name: "Period" })).toBeVisible();
    await expect(main.getByText(/Overview is being built/)).toHaveCount(0);

    // The spec's band order (plan §3.5), then today's cockpit under it: nothing is removed.
    await expect(main.locator(".ov-band__label")).toHaveText(["Now", "Office of the GM", "Work", "Growth", "More from Office of the GM"]);
    // DW-3z (plan §3.8): the cockpit's business, departments and money cards are the Company and Departments-by-condition blocks now, so
    // what is left under it is what no block shows: the client monitoring summary.
    for (const name of ["The business", "Departments", "Money"]) await expect(main.getByRole("heading", { name, exact: true }), name).toHaveCount(0);
    await expect(main.locator(".ov-legacy").getByRole("heading", { name: "Client monitoring", exact: true })).toBeVisible();
    await expect(main.getByText(/Headline figures only; this read carries no seal state/)).toHaveCount(0);

    // Needs you: decisions, in whatever honest state the demo queue gives (never a bare 0).
    const decisions = main.getByRole("region", { name: "Needs you: decisions", exact: true });
    await expect(decisions).toBeVisible();
    await expect(decisions).toContainText(/awaiting a decision|Nothing is waiting on a decision|Nothing found in the sources|Unavailable/);
    await expect(main.getByRole("region", { name: "Today", exact: true })).toBeVisible();

    // Company: the ledger's own P&L total from the demo books, then the report figures in a state the demo gives.
    const company = main.getByRole("region", { name: "Company", exact: true });
    await expect(company).toBeVisible();
    await expect(company.locator('[data-tile="revenue"]')).toHaveAttribute("data-state", "ok");
    await expect(company.locator('[data-tile="revenue"]')).toContainText("331.0M IDR");
    // DW-D22: the net margin rate. The demo books give 199.0M net over 331.0M revenue, so 60%.
    await expect(company.locator('[data-tile="margin"]')).toHaveAttribute("data-state", "ok");
    await expect(company.locator('[data-tile="margin"]')).toContainText("Net margin");
    await expect(company.locator('[data-tile="margin"]')).toContainText("60%");
    await expect(company.locator('[data-tile="overdue"]')).toHaveAttribute("data-state", /^(ok|no-data)$/);
    await expect(company.locator('[data-tile="milestones"]')).toHaveAttribute("data-state", /^(ok|no-data)$/);
    await expect(company.locator('[data-tile="utilization"]')).toHaveAttribute("data-state", /^(ok|no-data)$/);
    await expect(company.getByRole("link", { name: "Company report" })).toBeVisible();
    await expect(company.getByRole("link", { name: "Finance" })).toHaveAttribute("href", "/finance/reports");

    // Departments by condition, read from DW-4e-2's demo `dept-kpis/overview` (lib/demoDeptKpis.ts, the §40 shape the server
    // sends): worst first. Pinned to "ok" on purpose: a shape this block's normalizer could not read would quietly say
    // "Unavailable", and a test that accepted that would hide the mismatch. Creatives is the demo's off-track department and
    // Social Media its one with no condition.
    const departments = main.getByRole("region", { name: "Departments by condition", exact: true });
    await expect(departments).toHaveAttribute("data-state", "ok");
    const deptRows = departments.getByRole("listitem");
    await expect(deptRows.first()).toHaveAttribute("data-condition", "off_track");
    await expect(deptRows.first()).toContainText("Creatives");
    await expect(deptRows.last()).toHaveAttribute("data-condition", "unavailable");

    // Campaigns across departments: the demo's two campaigns, undated, so by name; no department part yet.
    const campaigns = main.getByRole("region", { name: "Campaigns", exact: true });
    await expect(campaigns).toBeVisible();
    await expect(campaigns.getByRole("listitem")).toHaveCount(2);
    await expect(campaigns.getByRole("link", { name: "Q3 lead-gen push" })).toHaveAttribute("href", "/agency/cam-1");
    await expect(campaigns.getByText("No department part yet")).toHaveCount(2);

    // Growth: the demo's company-wide compliance grid (2 mandatory paths, 30 of 46 complete) and the appraisal list, counted by stage.
    const learning = main.getByRole("region", { name: "Learning compliance", exact: true });
    await expect(learning).toBeVisible();
    await expect(learning.getByText("65% of mandatory training complete")).toBeVisible();
    await expect(learning.getByText("30 of 46 assigned, across 2 mandatory paths")).toBeVisible();
    await expect(learning.getByText("Lowest: Security awareness, 48%")).toBeVisible();
    await expect(learning.getByRole("link", { name: "Learning compliance" })).toHaveAttribute("href", "/learning/compliance");
    const appraisal = main.getByRole("region", { name: "Appraisal cycle", exact: true });
    await expect(appraisal).toBeVisible();
    await expect(appraisal.getByText(/^\d+ of \d+ finalized$/)).toBeVisible();
    await expect(appraisal.getByText(/^Across \d+ cycles?$/)).toBeVisible();
    await expect(appraisal.getByText(/Unavailable|No access/)).toHaveCount(0);
  });

  test("a manager's home is the Office of the GM through narrowed access: the decisions and nothing of the company's money or figures", async ({ page, context }) => {
    await signIn(page, context, "manager");
    await page.goto("/");
    await expect(page).toHaveURL(/\/departments\/dept-5$/);
    const main = page.locator("#main-content");
    await expect(main.locator(".ov-band__label")).toHaveText(["Now", "Work", "More from Office of the GM"]);
    await expect(main.getByRole("region", { name: "Needs you: decisions", exact: true })).toBeVisible();
    await expect(main.getByRole("region", { name: "Today", exact: true })).toBeVisible();
    for (const name of ["Company", "Departments by condition", "Learning compliance", "Appraisal cycle"]) {
      await expect(main.getByRole("region", { name, exact: true }), name).toHaveCount(0);
    }
    await expect(main.getByText(/\bIDR\b/)).toHaveCount(0);
    // Today's narrowed cockpit is under it, with its own notice. No company block is placed for a department lead, so the cockpit's
    // Departments strip stays (DW-3z): only a section a block shows to this person goes.
    await expect(main.getByText(/Scoped to the departments you lead/)).toBeVisible();
    await expect(main.locator(".ov-legacy").getByRole("heading", { name: "Departments", exact: true })).toBeVisible();
    await expect(main.locator(".ov-legacy").getByRole("heading", { name: "Client monitoring", exact: true })).toBeVisible();
  });

  test("a classic user sees none of it: the Office of the GM's page is the cockpit alone", async ({ page, context }) => {
    await signIn(page, context, "superadmin", { pilot: false });
    await page.goto("/departments/dept-5");
    const main = page.locator("#main-content");
    await expect(main.getByText("The business", { exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Period" })).toHaveCount(0);
    await expect(main.locator(".ov-band__label")).toHaveCount(0);
    for (const name of ["Needs you: decisions", "Company", "Departments by condition", "Campaigns", "Learning compliance", "Appraisal cycle"]) {
      await expect(main.getByRole("region", { name, exact: true }), name).toHaveCount(0);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// client_contact: never in the staff shell, pilot cookie or not.
// ──────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("client_contact (dana@northwind.example)", () => {
  test("lands on /portal and is bounced from staff pages, even with the pilot cookie set", async ({ page, context }) => {
    await loginAsPersona(page, "client_contact");
    await expect(page).toHaveURL(/\/portal/);
    await context.addCookies([tenantCookie(page.url()), pilotCookie(page.url())]);

    for (const path of ["/", "/projects", "/departments/dept-1"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/portal/);
      await expect(switcher(page)).toHaveCount(0);
      await expect(page.getByRole("searchbox", { name: "Search" })).toHaveCount(0);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// A phone: the sidebar becomes the off-canvas drawer, with the same rows.
// ──────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("phone viewport", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the menu button opens the drawer with the same rows, and Escape closes it", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/departments/dept-5");

    const nav = menu(page, "Office of the GM");
    await expect(nav).not.toBeInViewport(); // off-canvas until opened
    await press(page.getByRole("button", { name: "Open navigation" }));
    await expect(nav).toBeInViewport();
    await expect(nav.getByRole("link", { name: "Overview", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "AI Assistant" })).toBeVisible();
    await expect(nav.getByRole("group", { name: "Work" })).toBeVisible();
    await expect(nav.getByRole("group", { name: "Performance" }).getByRole("link")).toHaveText(["Reports", "Analytics", "Appraisals", "Learning"]);
    await expect(nav.getByRole("group", { name: "You" }).getByRole("link")).toHaveText(["Inbox", "Calendar", "Approvals", "Me"]);

    await page.keyboard.press("Escape");
    await expect(nav).not.toBeInViewport();
  });
});
