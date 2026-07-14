import { defineConfig, devices } from "@playwright/test";

// E2E against the app running in DEMO_MODE (no backend needed — see
// src/lib/demoFixtures.ts). Assumes a production build exists (`next build`);
// the webServer just starts it with DEMO_MODE=1.
const PORT = 3005;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : [["list"]],
  // Dev-mode compiles routes on first hit, so give assertions some headroom.
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: ".auth/user.json" },
      dependencies: ["setup"],
      testIgnore: /auth\.spec\.ts/,
    },
    {
      // Anonymous flows (login, step-up, sign-out) — no stored session.
      name: "anon",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /auth\.spec\.ts/,
    },
  ],
  webServer: {
    // `next dev` avoids the `output: standalone` conflict with `next start`
    // and needs no prior build — `npm run e2e` is fully self-contained.
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { DEMO_MODE: "1" },
  },
});
