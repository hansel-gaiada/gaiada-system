import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { loginAsPersona, type PersonaKey } from "./personas";
import { tenantCookie } from "./appCookies";

// DW-2g: the department workspace shell (DW-2a..2f), end to end, per persona, under DEMO_MODE.
//
// The shell is a per-person pilot switch (`gaiada_prefs.shell`, lib/shellLayout.ts), so every test signs in
// fresh, plants the `workspaces` pilot cookie, and then checks what THAT persona really gets. Nothing here
// assumes a department the demo data does not give. The facts every expectation below derives from:
//
//   - The demo company is `co-agency` (Gaia Digital Agency, vertical "agency"). With no backend its org tree
//     is the seeded default (lib/org.ts): Web Dev (dept-1), Creatives (dept-2), SEO (dept-3), Social Media
//     (dept-4) and GM (dept-5). The only people placed in it are u-dev, u-pm and u-gm, and NO demo login is
//     any of those, so nobody has a department placement.
//   - Home is therefore decided by GM access (lib/workspaceAccess.ts):
//       superadmin (hansel@gaiada.com, platform_admin)  -> reports.company.view      -> Office of the GM, own
//       manager    (manager@gaiada.com, manager)        -> reports.department.view  -> Office of the GM, own (narrowed)
//       member     (gede@gaiada.com, member)            -> none                     -> no workspace of their own: Company
//       search_staff (seo-staff@gaiada.com)             -> none                     -> no workspace of their own: Company
//   - Admin needs `admin.access`: platform_admin only. The Company area (first row "Departments") is open to all.
//   - The tree has no HR, IT or Finance node, so the registry appends those three workspaces after the
//     departments in the switcher.
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

const DEPARTMENTS = ["Web Dev", "Creatives", "SEO", "Social Media"];

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// superadmin: Office of the GM is home and own. Admin shows. The reference persona for most checks.
// ──────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("superadmin (hansel@gaiada.com)", () => {
  test("home is the Office of the GM; the switcher lists their workspace first, then the departments", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/");

    await expect(menu(page, "Office of the GM")).toBeVisible();
    await expect(page.getByRole("button", { name: "Office of the GM, Gaia Digital Agency. Switch workspace" })).toBeVisible();

    const { mine, others } = await openSwitcher(page);
    await expect(mine.getByRole("link")).toHaveText(["Office of the GM Home"]);
    // Departments in the org tree's order. The GM is already above, so it is not listed twice.
    const names = (await others.getByRole("link").allTextContents()).map((t) => t.replace(/\s*Home$/, ""));
    expect(names.slice(0, DEPARTMENTS.length)).toEqual(DEPARTMENTS);
    expect(names).not.toContain("Office of the GM");

    // "Your workspaces" sits above "Departments".
    const y = async (l: Locator) => (await l.boundingBox())!.y;
    expect(await y(page.getByText("Your workspaces"))).toBeLessThan(await y(page.getByText("Departments", { exact: true })));

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
    await expect(pop.getByRole("link", { name: "Open inbox" })).toHaveAttribute("href", "/notifications");
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

  test("the AI Assistant row opens the drawer over the page; Escape closes it and focus returns to the row", async ({ page, context }) => {
    await signIn(page, context, "superadmin");
    await page.goto("/departments/dept-5");

    const row = menu(page, "Office of the GM").getByRole("link", { name: "AI Assistant" });
    await hydrated(row);
    await row.click();
    const dialog = page.getByRole("dialog", { name: "Assistant" });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/assistant\?.*from=/);
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

  test("classic is untouched without the pilot cookie: classic sidebar, floating assistant button, and a way into the new layout", async ({ page, context }) => {
    await signIn(page, context, "superadmin", { pilot: false });
    await page.goto("/");

    await expect(page.getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
    const fab = page.getByRole("link", { name: "Open assistant" });
    await expect(fab).toBeVisible();
    await expect(switcher(page)).toHaveCount(0);
    await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible(); // classic top bar's own form

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

    await expect(menu(page, "Office of the GM")).toBeVisible();
    const { mine } = await openSwitcher(page);
    await expect(mine.getByRole("link")).toHaveText(["Office of the GM Home"]);
    await page.keyboard.press("Escape");

    await expect(sidebar(page).getByRole("link", { name: "Company", exact: true })).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// member: no placement, no GM access, so no workspace of their own. Home is the Company area.
// ──────────────────────────────────────────────────────────────────────────────────────────────────
test.describe("member (gede@gaiada.com)", () => {
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
    await page.goto("/admin");
    await expect(menu(page, "Admin")).toHaveCount(0); // the page is refused; the shell offers no Admin area
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
