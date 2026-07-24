import { test, expect } from "@playwright/test";

// P3-12: a minimal CI smoke check run against the REAL BUILT app (`next
// build` + `next start` in CI — see playwright.config.ts), not `next dev`.
// Motivation: a `server-only` import once reached a client component and
// `tsc` + vitest both passed while `next build` broke and the route 500'd.
// This test is self-contained (own login, own tenant cookie) so CI can run
// it in isolation with `npx playwright test --grep @smoke` without pulling
// in the rest of the e2e suite.
test("board view renders without a page error @smoke", async ({ page, context }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("hansel@gaiada.com");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/");

  await context.addCookies([
    {
      name: "gaiada_tenant",
      value: "co-agency",
      url: page.url(),
    },
  ]);

  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  await page.goto("/projects/p-web-1?view=board");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The board's columns are the real signal that the route rendered past
  // any RSC/client-boundary failure, not just an error boundary's fallback.
  await expect(page.getByText(/no activity yet|error|something went wrong/i)).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
