import { test as setup, expect } from "@playwright/test";

const AUTH_FILE = ".auth/user.json";

// Logs in once (demo mode accepts any email) and persists the session cookie
// so the authed test project can reuse it.
setup("authenticate", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("hansel@gaiada.com");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.context().storageState({ path: AUTH_FILE });
});
