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

// UI-01 — the actual bug MAIL-09 found live: an emailed approval deep link, clicked with no
// session, must not dead-end on "/" after sign-in. This walks the REAL round trip (middleware's
// redirect-to-login, not a hand-built `/login?return=` URL) for both of `entityHref()`'s staff
// shapes (`/approvals/:id`, `/pipeline/:id`).
test("an unauthenticated deep link to an approval survives the login round trip", async ({ page }) => {
  await page.goto("/approvals/aa-1");
  await page.waitForURL("**/login**");
  expect(decodeURIComponent(page.url())).toContain("return=/approvals/aa-1");

  await page.getByLabel("Email").fill("hansel@gaiada.com");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/approvals/aa-1");
  await expect(page.getByRole("heading", { level: 1 })).not.toContainText(/^$/);
});

test("an unauthenticated deep link to a pipeline run survives the login round trip", async ({ page }) => {
  await page.goto("/pipeline/run-demo-1");
  await page.waitForURL("**/login**");
  expect(decodeURIComponent(page.url())).toContain("return=/pipeline/run-demo-1");

  await page.getByLabel("Email").fill("hansel@gaiada.com");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/pipeline/run-demo-1");
});

test("no return target: unauthenticated root request still lands on / after login, unchanged", async ({ page }) => {
  await page.goto("/");
  await page.waitForURL("**/login**");
  // No path was requested beyond "/", so the default-landing behaviour must be exactly as before:
  // no `return=` param at all (sanitizeReturnTo("/") intentionally omits it — see middleware.ts).
  expect(page.url()).not.toContain("return=");

  await page.getByLabel("Email").fill("hansel@gaiada.com");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => url.pathname === "/");
});

// Open-redirect probes against the actual running app, one hop past the unit tests: these hit
// `/login?return=<probe>` directly (the same entry point the middleware and /step-up both funnel
// into) and require every one to land on the safe default instead of leaving the origin.
test("open-redirect probes at /login all refuse and fall back to the default landing", async ({ page }) => {
  const probes = [
    "https://evil.test/",
    "//evil.test",
    "///evil.test",
    "/\\evil.test",
    "/%2F%2Fevil.test",
    "/%252F%252Fevil.test",
    "javascript:alert(1)",
  ];

  for (const probe of probes) {
    await page.goto(`/login?return=${encodeURIComponent(probe)}`);
    await page.getByLabel("Email").fill("hansel@gaiada.com");
    await page.getByRole("button", { name: /sign in/i }).click();
    // Must land on this origin's default ("/") — never navigate off-origin. If sanitizeReturnTo
    // ever regressed to accepting one of these, this would hang waiting for a nonexistent host
    // (evil.test) rather than silently pass, so a timeout here is itself a meaningful failure.
    await page.waitForURL((url) => url.hostname === "localhost" && url.pathname === "/");
    // Sign back out (clear the session cookie) so the next probe starts unauthenticated.
    await page.context().clearCookies();
  }
});
