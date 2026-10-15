import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { tenantCookie } from "./appCookies";

// PV3-09 — axe-core sweep of the STAFF client hub, in DEMO_MODE, both themes: every area of the hub for the
// demo client that has data in each (Northwind Traders, `cl-1`), including the visibility markers
// ("Client sees this" / "Internal") and the Business area note.
//
// Modelled on `a11y-axe-portal.spec.ts` (the portal's sweep) and `a11y-axe.spec.ts` (the staff shell's).
// Unlike the portal spec this runs in the default `chromium` project: the hub is a STAFF surface, so it uses the
// shared staff session (`.auth/user.json`). Like both of them it is not `@smoke` and does not gate a merge. Read
// `a11y-axe.spec.ts`'s header before trusting a green run: axe covers roughly a third of what a manual audit
// finds, so green here means "no regression in the rules axe checks", never "accessible".
//
// The marker's contrast is the thing this sweep most needs to catch: its text is `--ink-strong` on a 10-16%
// tint of the ok / warning family, and the Internal tab's earlier failure (the -fg tier on its amber tint) is the
// reason. Any exclusion below must name the rule id and why it is deferred rather than fixed.

type Theme = "light" | "dark";

async function pinTheme(page: Page, theme: Theme) {
  // The demo fixtures this sweep reads (`cl-1`'s projects, deliverables, contracts, payments) live under the
  // `co-agency` tenant; the shared session's default company is a different one (see `client-hub.spec.ts`).
  await page.context().addCookies([
    {
      name: "gaiada_prefs",
      value: JSON.stringify({ density: "comfortable", width: "wide", theme, assistantRailCollapsed: false }),
      url: page.url(),
    },
    tenantCookie(page.url()),
  ]);
}

// Every area of the hub, plus a Business sub-page (the area note sits above the whole shell).
const PAGES = [
  "/clients/cl-1",
  "/clients/cl-1/work",
  "/clients/cl-1/profile",
  "/clients/cl-1/profile/company",
  // PV6-03: Services & results, with the "Client sees this" marker on every card.
  "/clients/cl-1/profile/se/results",
  "/clients/cl-1/profile/mk/results",
  "/clients/cl-1/billing",
  // PV7-04b: Reports (published with the marker, a draft with Publish, a withdrawn one with its reason).
  "/clients/cl-1/reports",
  "/clients/cl-1/contacts",
  "/clients/cl-1/notes",
];

// PRE-EXISTING `color-contrast` findings in the staff SHELL (sidebar), present on every staff page and owned by
// `shell.css`, excluded by exact selector exactly as `a11y-axe.spec.ts` does (see its comments for the measured
// ratios and root cause: raw `opacity` on the sidebar tagline and group labels). Not a hub surface; the hub's own
// content is NOT excluded, so any contrast regression in it still fails the run.
const SHELL_CONTRAST_EXCLUSIONS = [".erp-side__tagline", ".erp-side__grouplabel", ".erp-company .type-eyebrow"];

async function runAxe(page: Page) {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  // One `.exclude()` call per selector (see `a11y-axe.spec.ts`: an array would read as one shadow-DOM chain).
  for (const selector of SHELL_CONTRAST_EXCLUSIONS) builder = builder.exclude(selector);
  return builder.analyze();
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`client hub axe — ${scheme}`, () => {
    test(`every hub page has no axe violations (${scheme})`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.goto("/");
      await pinTheme(page, scheme);
      const found: string[] = [];
      // Contrast axe could not decide (text over a translucent or layered background). Logged, not failed: these
      // need a human look, and a green run says nothing about them.
      const undecided: string[] = [];
      for (const path of PAGES) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        const { violations, incomplete } = await runAxe(page);
        for (const v of violations) {
          found.push(
            `${path} [${v.impact}] ${v.id} (${v.nodes.length}): ${v.help}\n` +
              v.nodes.slice(0, 3).map((n) => `      - ${n.target.join(" ")}`).join("\n"),
          );
        }
        for (const v of incomplete.filter((x) => x.id === "color-contrast")) {
          undecided.push(`${path} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
        }
      }
      if (undecided.length > 0) console.log(`\naxe could not decide contrast — client hub ${scheme}:\n${undecided.join("\n")}`);
      if (found.length > 0) console.log(`\naxe violations — client hub ${scheme}:\n${found.join("\n")}`);
      expect(found, found.join("\n")).toEqual([]);
    });
  });
}
