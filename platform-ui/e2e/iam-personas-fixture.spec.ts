import { test, expect } from "@playwright/test";
import { loginAsPersona } from "./personas";

// IAM-06b — reference example for the persona fixture, run in DEMO_MODE (this project's default —
// see playwright.config.ts). Demonstrates BOTH directions with the exact copy-paste shape the
// README shows: "as persona X this is visible" and "as persona Y it is not", using a capability
// (`admin.access` -> the "Settings" nav item, `components/shell/nav.ts`) that is unambiguously
// ALLOW for one persona and DENY for another under today's `rbac.ts` — no program-specific
// knowledge required to read this file.
test.describe("IAM-06b persona fixture — reference example", () => {
  test("ALLOW — superadmin sees the Settings nav item (admin.access)", async ({ page }) => {
    await loginAsPersona(page, "superadmin");
    await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  });

  test("DENY — member does NOT see the Settings nav item (admin.access)", async ({ page }) => {
    await loginAsPersona(page, "member");
    await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  });

  test("a DEMO_MODE-unsupported persona fails loudly, not silently as the wrong identity", async ({ page }) => {
    await expect(loginAsPersona(page, "team_lead")).rejects.toThrow(/no identity for persona "team_lead"/);
  });
});
