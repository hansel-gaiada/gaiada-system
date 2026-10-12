import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { tenantCookie } from "./appCookies";

// PV5-09 — axe-core sweep of the STAFF contracts-and-billing screens, in DEMO_MODE, both themes:
//   - the issued invoice (`inv-issued-1`: the invoice of record, the issuer as frozen, tax and totals, Void),
//   - a legacy invoice (`inv-1`: sent before invoices were issued through the ledger),
//   - the billing profile (the bank block is its own section, masked by default),
//   - accounting settings (which now links to the billing profile),
//   - the client's Contracts & billing page (tier, content fingerprint, Mark certified disabled with its reason).
//
// Modelled on `a11y-axe-client-hub.spec.ts`. Runs in the default `chromium` project on the shared staff session and, like
// every axe spec here, is not `@smoke` and does not gate a merge; CI does not run Playwright at all. Read
// `a11y-axe.spec.ts`'s header before trusting a green run: axe covers roughly a third of what a manual audit finds.
//
// The labels on these pages use the ink tokens and never `opacity` (the go-live contrast item). Any exclusion below must
// name the rule id and why it is deferred rather than fixed.

type Theme = "light" | "dark";

const PAGES = [
  "/invoices/inv-issued-1",
  "/invoices/inv-1",
  "/finance/settings/billing-profile",
  "/finance/settings",
  "/clients/cl-1/billing",
];

async function pinTheme(page: Page, theme: Theme) {
  await page.context().addCookies([
    {
      name: "gaiada_prefs",
      value: JSON.stringify({ density: "comfortable", width: "wide", theme, assistantRailCollapsed: false }),
      url: page.url(),
    },
    tenantCookie(page.url()),
  ]);
}

// PRE-EXISTING `color-contrast` findings in the staff SHELL (sidebar), present on every staff page and owned by
// `shell.css`, excluded by exact selector exactly as `a11y-axe-client-hub.spec.ts` does. The pages' own content is NOT
// excluded, so a contrast regression in it still fails the run.
const SHELL_CONTRAST_EXCLUSIONS = [".erp-side__tagline", ".erp-side__grouplabel", ".erp-company .type-eyebrow"];

async function runAxe(page: Page) {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  for (const selector of SHELL_CONTRAST_EXCLUSIONS) builder = builder.exclude(selector);
  return builder.analyze();
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`billing screens axe — ${scheme}`, () => {
    test(`every changed staff billing page has no axe violations (${scheme})`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.goto("/");
      await pinTheme(page, scheme);
      const found: string[] = [];
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
      if (undecided.length > 0) console.log(`\naxe could not decide contrast — billing screens ${scheme}:\n${undecided.join("\n")}`);
      if (found.length > 0) console.log(`\naxe violations — billing screens ${scheme}:\n${found.join("\n")}`);
      expect(found, found.join("\n")).toEqual([]);
    });
  });
}

// The behaviour the sweep above only looks at.
test.describe("billing screens: what they say", () => {
  test("the issued invoice shows the invoice of record, masks the bank account, and Void asks first", async ({ page }) => {
    await page.goto("/");
    await page.context().addCookies([tenantCookie(page.url())]);
    await page.goto("/invoices/inv-issued-1");
    await expect(page.getByText("DEMO/2026/0001").first()).toBeVisible();
    await expect(page.getByText(/Being prepared/)).toBeVisible();
    // The issuer block is the one frozen at issue; its account number is masked until asked for.
    await expect(page.getByText("•••• 0000")).toBeVisible();
    await expect(page.getByText("0000000000", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Show account number" }).click();
    await expect(page.getByText("0000000000", { exact: true })).toBeVisible();
    // Void is a confirm step, not a click-through.
    await page.getByRole("button", { name: /Void this invoice/ }).click();
    await expect(page.getByRole("button", { name: "Confirm void" })).toBeDisabled();
  });

  test("the billing profile keeps the bank account in its own section and saves it with its own button", async ({ page }) => {
    await page.goto("/");
    await page.context().addCookies([tenantCookie(page.url())]);
    await page.goto("/finance/settings/billing-profile");
    await expect(page.getByRole("heading", { name: "Clients pay into this account" })).toBeVisible();
    await expect(page.getByText("•••• 0000")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save bank account" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save billing profile" })).toBeVisible();
  });

  test("a draft contract shows Mark certified disabled, with the reason", async ({ page }) => {
    await page.goto("/");
    await page.context().addCookies([tenantCookie(page.url())]);
    await page.goto("/clients/cl-1/billing");
    const draft = page.getByRole("listitem").filter({ hasText: "Master services agreement 2026" });
    await expect(draft.getByRole("button", { name: "Mark certified" })).toBeDisabled();
    await expect(draft.getByText(/Certified signing isn't set up yet/)).toBeVisible();
  });
});
