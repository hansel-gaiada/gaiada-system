import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { loginAsHrStaff, loginAsPersona, loginAsPlacedWebDev, loginAsResortStaff, loginAsWebDevHead } from "./personas";
import { tenantCookie } from "./appCookies";

// DW-9b-1: an axe-core sweep of the department workspace shell (the only layout, DW-D38), so the layout change
// leaves no accessibility regression behind (plan §12.1, "axe (9b)").
//
// ── WHAT IT COVERS ────────────────────────────────────────────────────────────────────────────────────────────────────
// The shell's own surfaces, not every page: the Overview as an employee, as a head in Team mode and as the company Overview;
// a row with its tab strip; the open workspace switcher, command palette, assistant drawer and avatar menu; the phone drawer;
// a generic-pack workspace (Viceroy) and the HR workspace. Every surface runs in light and dark, on desktop and on a phone
// (390x844). The phone drawer runs on the phone only. One test per surface x theme x viewport, so the matrix reads in a line
// reporter. Tags: WCAG 2.0 and 2.1, A and AA. The whole page is scanned: NO `.exclude()` and NO `.disableRules()`; a deferral is
// decided after the report, and when it is made it is named here with its reason.
//
// ── WHAT A GREEN RUN DOES NOT PROVE (read before trusting it) ─────────────────────────────────────────────────────────
// axe-core is a DOM-rule checker: missing names, bad ARIA, roles, heading order, colour contrast. Industry estimates put its
// real coverage at about a third of what a manual audit finds. It cannot tell whether focus lands somewhere useful after the
// switcher, palette or drawer opens and closes (the focus traps and their return targets are covered by workspace-shell.spec.ts
// as behaviour, not as accessibility), whether the reading order and the announcements are sane in a real screen reader, or
// whether a keyboard-only or switch user can finish a task. It scans one state per test: a state this file does not open
// (the bell pop-over, the "+ New" menu, a row's own pages) is not scanned. `docs/a11y-manual-checklist.md` is the human pass.
// A green run is evidence of "no regression in what axe covers", never "accessible".
//
// ── WHY ITS OWN PROJECT, AND NOT IN CI ────────────────────────────────────────────────────────────────────────────────
// It is the `workspace-a11y` project: every test signs in as its own demo identity and plants the tenant cookie and its theme
// itself, so NO stored session (a stale shared session would scan the wrong person). CI runs only the smoke project; the
// workspace projects are gated on sumopod (a Linux box, `next build` then `next start`), the same as workspace-personas.
// It is excluded from the default `chromium` project for the same reason.
//
// ── THEMES ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The theme is the `gaiada_prefs` cookie, written the way lib/prefs.ts reads it: URL-encoded JSON.
//
// ── THE JSON SUMMARY ──────────────────────────────────────────────────────────────────────────────────────────────────
// Each scan also writes its violations to `test-results/axe-workspaces/<test title>.json` (gitignored) so a report can group
// them by rule without parsing the reporter.

type Theme = "light" | "dark";
type Viewport = "desktop" | "phone";
const OUT_DIR = "test-results/axe-workspaces";

// Copied from workspace-shell.spec.ts (not imported: that file belongs to another session).
// A button is a plain control until React owns it; clicking earlier does nothing.
async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function press(loc: Locator) {
  await expect(loc).toBeVisible();
  await hydrated(loc);
  await loc.click();
}

/** The theme, the way lib/prefs.ts reads it. */
function prefsCookie(at: string, theme: Theme) {
  return { name: "gaiada_prefs", value: encodeURIComponent(JSON.stringify({ theme })), url: new URL("/", at).toString() };
}

const menu = (page: Page, title: string) => page.getByRole("navigation", { name: `${title} menu` });
const switcher = (page: Page) => page.getByRole("button", { name: /\. Switch workspace$/ });

interface Ctx { page: Page; viewport: Viewport }

interface Surface {
  name: string;
  login: (page: Page) => Promise<void>;
  tenant: string;
  url: string;
  /** Phone only (the surface does not exist on desktop). */
  phoneOnly?: boolean;
  /** Reaches the state to scan and waits for its positive landmark. */
  reach: (c: Ctx) => Promise<void>;
}

/** The landmark of a plain page: the workspace's menu (hydration is waited for by the scan helper). */
const onPage = (title: string) => async ({ page, viewport }: Ctx) => {
  // On a phone the closed drawer is hidden from the accessibility tree, so the landmark is the button that opens it.
  if (viewport === "phone") await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  else await expect(menu(page, title)).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
};

/** On a phone the sidebar is an off-canvas drawer; a phone user opens it with the menu button first. */
async function openDrawer(page: Page, title: string) {
  await press(page.getByRole("button", { name: "Open navigation" }));
  await expect(menu(page, title)).toBeInViewport();
}

const SURFACES: Surface[] = [
  { name: "employee Overview", login: loginAsPlacedWebDev, tenant: "co-agency", url: "/departments/dept-1", reach: onPage("Web Dev") },
  { name: "head Team Overview", login: loginAsWebDevHead, tenant: "co-agency", url: "/departments/dept-1?view=team", reach: onPage("Web Dev") },
  { name: "company Overview", login: (p) => loginAsPersona(p, "superadmin"), tenant: "co-agency", url: "/departments/dept-5", reach: onPage("Office of the GM") },
  {
    name: "row tab strip", login: (p) => loginAsPersona(p, "superadmin"), tenant: "co-agency", url: "/departments/dept-5/projects",
    reach: async ({ page }) => {
      await expect(page.getByRole("navigation", { name: "Project Management sections" })).toBeVisible();
    },
  },
  {
    name: "workspace switcher open", login: loginAsPlacedWebDev, tenant: "co-agency", url: "/departments/dept-1",
    reach: async ({ page, viewport }) => {
      // On a phone the switcher lives in the drawer, so a phone user opens the drawer first.
      if (viewport === "phone") await openDrawer(page, "Web Dev");
      await press(switcher(page));
      await expect(page.getByRole("list", { name: "Departments" })).toBeVisible();
    },
  },
  {
    name: "command palette open", login: loginAsPlacedWebDev, tenant: "co-agency", url: "/departments/dept-1",
    reach: async ({ page, viewport }) => {
      // The search field is hidden below 760px; the top bar shows a "Find anything" button instead.
      const trigger = viewport === "phone" ? page.getByRole("link", { name: "Find anything" }) : page.getByRole("searchbox", { name: "Search" });
      await press(trigger);
      await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox")).toBeVisible();
    },
  },
  {
    name: "assistant drawer open", login: loginAsPlacedWebDev, tenant: "co-agency", url: "/departments/dept-1",
    reach: async ({ page, viewport }) => {
      if (viewport === "phone") await openDrawer(page, "Web Dev");
      const row = menu(page, "Web Dev").getByRole("link", { name: "AI Assistant" });
      await press(row);
      await expect(page.getByRole("dialog", { name: "Assistant" })).toBeVisible();
    },
  },
  {
    name: "avatar menu open", login: loginAsPlacedWebDev, tenant: "co-agency", url: "/departments/dept-1",
    reach: async ({ page }) => {
      await press(page.locator(".erp-top .erp-usermenu__trigger"));
      await expect(page.getByRole("menu", { name: "Account menu" })).toBeVisible();
    },
  },
  {
    name: "phone drawer open", login: loginAsPlacedWebDev, tenant: "co-agency", url: "/departments/dept-1", phoneOnly: true,
    reach: async ({ page }) => {
      await openDrawer(page, "Web Dev");
      await expect(menu(page, "Web Dev").getByRole("link", { name: "AI Assistant" })).toBeVisible();
    },
  },
  { name: "generic workspace (Viceroy)", login: loginAsResortStaff, tenant: "co-resort", url: "/departments/hosp-dept-1", reach: onPage("Front Office") },
  { name: "HR workspace", login: loginAsHrStaff, tenant: "co-agency", url: "/hr", reach: onPage("HR") },
];

// ── The scan ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function describeViolations(violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]): string {
  if (violations.length === 0) return "no violations";
  return violations
    .map((v) => {
      const targets = v.nodes.slice(0, 3).map((n) => `    - ${n.target.join(" ")}`).join("\n");
      return `[${v.impact ?? "n/a"}] ${v.id} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"}): ${v.help}\n${targets}\n    ${v.helpUrl}`;
    })
    .join("\n");
}

const safeName = (s: string) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

async function scan(page: Page, title: string) {
  await page.evaluate(() => document.fonts.ready);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      `${OUT_DIR}/${safeName(title)}.json`,
      JSON.stringify(
        {
          title,
          url: page.url(),
          violations: results.violations.map((v) => ({
            id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, tags: v.tags.filter((t) => t.startsWith("wcag")),
            nodes: v.nodes.map((n) => ({ target: n.target, html: n.html.slice(0, 300), summary: n.failureSummary })),
          })),
        },
        null,
        2,
      ),
    );
  } catch {
    // The summary is a convenience; the assertion below is the test.
  }
  expect(results.violations, `axe violations on "${title}":\n${describeViolations(results.violations)}`).toEqual([]);
}

for (const viewport of ["desktop", "phone"] as const) {
  test.describe(viewport, () => {
    // Transitions would leave half-faded states (and so half-blended colours) under the scan.
    test.use({ contextOptions: { reducedMotion: "reduce" } });
    if (viewport === "phone") test.use({ viewport: { width: 390, height: 844 } });

    for (const surface of SURFACES) {
      if (surface.phoneOnly && viewport === "desktop") continue;
      for (const theme of ["light", "dark"] as const) {
        const title = `${surface.name} · ${theme} · ${viewport}`;
        test(title, async ({ page, context }) => {
          await surface.login(page);
          await context.addCookies([tenantCookie(page.url(), surface.tenant), prefsCookie(page.url(), theme)]);
          await page.goto(surface.url);
          await surface.reach({ page, viewport });
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await scan(page, title);
        });
      }
    }
  });
}
