import { expect } from "@playwright/test";
import { test } from "./settledPage";
import { loginAsPersona } from "./personas";

// IAM-06b — reference example for the persona fixture, run in DEMO_MODE (this project's default —
// see playwright.config.ts). Demonstrates BOTH directions with the exact copy-paste shape the
// README shows: "as persona X this is visible" and "as persona Y it is not", using a capability
// (`admin.access` -> the workspace sidebar's "Admin" door and its "Settings" row, `lib/workspaces.ts` ADMIN_ROWS) that is unambiguously
// ALLOW for one persona and DENY for another under today's `rbac.ts` — no program-specific
// knowledge required to read this file.
test.describe("IAM-06b persona fixture — reference example", () => {
  test("ALLOW — superadmin sees the Admin door and its Settings row (admin.access)", async ({ page }) => {
    await loginAsPersona(page, "superadmin");
    await page.goto("/");
    const sidebar = page.locator("aside#app-nav");
    await expect(sidebar.getByRole("link", { name: "Admin", exact: true })).toBeVisible();
    await page.goto("/admin");
    await expect(page.getByRole("navigation", { name: "Admin menu" }).getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  });

  test("DENY — member does NOT see the Admin door or a Settings row (admin.access)", async ({ page }) => {
    await loginAsPersona(page, "member");
    await page.goto("/");
    const sidebar = page.locator("aside#app-nav");
    // The shell drew (the footer's Company door is open to everyone); only then is an absence worth asserting.
    await expect(sidebar.getByRole("link", { name: "Company", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  });

  test("a DEMO_MODE-unsupported persona fails loudly, not silently as the wrong identity", async ({ page }) => {
    // HIER-3: was `team_lead`, retired 2026-08-11. `hr_manager` is used instead — still a real
    // persona with no demo identity, so the property under test (fail LOUDLY rather than
    // silently sign in as the wrong identity) is unchanged.
    await expect(loginAsPersona(page, "hr_manager")).rejects.toThrow(/no identity for persona "hr_manager"/);
  });
});
