import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// PV2-08 — axe-core sweep of the client portal, as an EXTERNAL CLIENT, in DEMO_MODE, both themes.
//
// The file name ends `portal.spec.ts` on purpose: playwright.config.ts's `portal` project matches
// /portal\.spec\.ts/, so this runs with the portal suite (no staff session). Like `a11y-axe.spec.ts`
// it is not `@smoke` and does not gate a merge. Read that file's header before trusting a green run:
// axe covers roughly a third of what a manual audit finds, so green here means "no regression in the
// rules axe checks", never "accessible".
//
// Every page in the five areas (PV-D4) plus one project and one invoice detail. The theme follows the
// colour scheme, because a client's `gaiada_prefs` theme defaults to "auto". Any exclusion added below
// must name the rule id and why it is deferred rather than fixed.

async function signInAsClient(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dana@northwind.example");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/portal");
}

const PAGES = [
  "/portal",
  "/portal/projects",
  "/portal/projects/proj-nw-site",
  "/portal/approvals",
  "/portal/deliverables",
  "/portal/requests",
  // PV4-08: the list, an open thread (messages, attachment, reply box), a closed thread (a removed message, no box),
  // shared meeting notes, and an amendment (the banner).
  "/portal/conversation",
  "/portal/conversation/th-site",
  "/portal/conversation/th-brand",
  "/portal/meetings/min-kickoff",
  "/portal/contracts/ctr-amd-msa-1",
  "/portal/social-reviews",
  "/portal/timeline",
  "/portal/company",
  "/portal/contracts",
  "/portal/invoices",
  "/portal/invoices/inv-2026-014",
  "/portal/profile",
];

async function runAxe(page: Page) {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`portal axe — ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    test(`every portal page has no axe violations (${scheme})`, async ({ page }) => {
      test.setTimeout(180_000);
      await signInAsClient(page);
      const found: string[] = [];
      // Contrast axe could not decide (text over a translucent or layered background). Logged, not
      // failed: these need a human look, and a green run says nothing about them.
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
      if (undecided.length > 0) console.log(`\naxe could not decide contrast — portal ${scheme}:\n${undecided.join("\n")}`);
      if (found.length > 0) console.log(`\naxe violations — portal ${scheme}:\n${found.join("\n")}`);
      expect(found, found.join("\n")).toEqual([]);
    });
  });
}
