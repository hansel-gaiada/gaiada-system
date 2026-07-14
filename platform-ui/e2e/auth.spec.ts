import { test, expect } from "@playwright/test";

// Anonymous flows — no stored session (see the "anon" project in the config).

test("protected route redirects to login", async ({ page }) => {
  await page.goto("/projects");
  await page.waitForURL("**/login**");
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});

test("step-up landing explains escalation and links to sign-in", async ({ page }) => {
  await page.goto("/step-up?return=/projects");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/stronger sign-in/i);
  await expect(page.getByText("/projects")).toBeVisible();
  await page.getByRole("link", { name: /continue to sign in/i }).click();
  await page.waitForURL("**/login**");
  expect(page.url()).toContain("return=");
});

test("login honours the return path", async ({ page }) => {
  await page.goto("/login?return=/projects");
  await page.getByLabel("Email").fill("hansel@gaiada.com");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/projects");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/projects/i);
});
