import { expect, type Page } from "@playwright/test";
import { test } from "./settledPage";
import AxeBuilder from "@axe-core/playwright";
import { tenantCookie } from "./appCookies";

// PV4-09 — axe-core sweep of the staff conversation screens, in DEMO_MODE, both themes: the hub's Conversation section
// (Projects tab), the thread page (messages with their markers, an Internal-styled draft card, the composer) and the
// meeting page's minutes editor. Same harness, tags and shell exclusions as a11y-axe-client-hub.spec.ts; read its header
// before trusting a green run: axe covers a fraction of what a manual audit finds.
//
// Runs in PV4-10's gate. The thread page is swept with the draft card on screen, so this file must not depend on the
// order in which client-conversation.spec.ts sends that draft: the sweep also passes once it has been sent.
type Theme = "light" | "dark";

async function pinTheme(page: Page, theme: Theme) {
  await page.context().addCookies([
    { name: "gaiada_prefs", value: JSON.stringify({ density: "comfortable", width: "wide", theme, assistantRailCollapsed: false }), url: page.url() },
    tenantCookie(page.url()),
  ]);
}

const PAGES = [
  "/clients/cl-1/work",
  "/clients/cl-1/work/conversation/cv-thread-1",
  "/meetings/rec-demo-1",
];

// Pre-existing shell contrast findings owned by shell.css, excluded by exact selector exactly as a11y-axe-client-hub.spec.ts does.
const SHELL_CONTRAST_EXCLUSIONS = [".erp-side__tagline", ".erp-side__grouplabel", ".erp-company .type-eyebrow"];

async function runAxe(page: Page) {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  for (const selector of SHELL_CONTRAST_EXCLUSIONS) builder = builder.exclude(selector);
  return builder.analyze();
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`staff conversation axe — ${scheme}`, () => {
    test(`hub section, thread page and minutes have no axe violations (${scheme})`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.goto("/");
      await pinTheme(page, scheme);
      const found: string[] = [];
      const undecided: string[] = [];
      for (const path of PAGES) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        const { violations, incomplete } = await runAxe(page);
        for (const v of violations) {
          found.push(`${path} [${v.impact}] ${v.id} (${v.nodes.length}): ${v.help}\n` + v.nodes.slice(0, 3).map((n) => `      - ${n.target.join(" ")}`).join("\n"));
        }
        for (const v of incomplete.filter((x) => x.id === "color-contrast")) {
          undecided.push(`${path} (${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
        }
      }
      if (undecided.length) console.log(`[axe ${scheme}] contrast axe could not decide (needs a human look):\n  ${undecided.join("\n  ")}`);
      expect(found, found.join("\n")).toEqual([]);
    });

    test(`the open Send confirm has no axe violations (${scheme})`, async ({ page }) => {
      await page.goto("/");
      await pinTheme(page, scheme);
      await page.goto("/clients/cl-1/work/conversation/cv-thread-1");
      const send = page.getByRole("button", { name: "Send", exact: true });
      // The draft may already have been sent by client-conversation.spec.ts in this run; the confirm is only sweepable while it is pending.
      test.skip(!(await send.count()), "the demo draft was already sent in this run");
      await send.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      const { violations } = await runAxe(page);
      expect(violations.map((v) => `${v.id}: ${v.help}`), JSON.stringify(violations.map((v) => v.nodes.map((n) => n.target)))).toEqual([]);
    });
  });
}
