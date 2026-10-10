import { defineConfig, devices } from "@playwright/test";

// WSK-44 — the Website workspace against a STUBBED WSK-59 BFF.
//
//   npx playwright test -c playwright.webdesk.config.ts
//
// A SEPARATE config (not another project in playwright.config.ts) because this run is shaped
// differently from the rest of the suite: the app runs with DEMO_MODE UNSET and `PLATFORM_URL` pointing
// at `e2e/webdesk-stub/server.mjs`, so the real `platformFetch`, the real session cookie and the real
// server components are exercised end to end — and `playwright.config.ts`'s webServer array would start
// both servers for every project in the main suite. The stub itself lives under `e2e/` only; nothing in
// `src/` imports it, so it cannot reach a shipped code path.
//
// `WD_E2E_START` lets the Linux gate run the BUILT app (`next start`, the artifact `next build`
// produced) instead of `next dev`: that is the point of the gate, since a `server-only` import reaching
// a client component passes tsc and vitest and 500s the page at runtime.
const APP_PORT = Number(process.env.WD_E2E_APP_PORT) || 3006;
const STUB_PORT = Number(process.env.WD_STUB_PORT) || 3991;
const DIST = process.env.NEXT_DIST_DIR || ".next-e2e-wd";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /webdesk-content\.spec\.ts/,
  // One worker, no file parallelism: the stub is ONE in-memory store and every test resets it first.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["line"]] : [["list"]],
  expect: { timeout: 15_000 },
  timeout: 90_000,
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: "retain-on-failure",
    navigationTimeout: 60_000,
  },
  projects: [{ name: "webdesk", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/webdesk-stub/server.mjs",
      url: `http://127.0.0.1:${STUB_PORT}/dev/user-by-email?email=probe`,
      env: { WD_STUB_PORT: String(STUB_PORT) },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: process.env.WD_E2E_START || `npx next dev -p ${APP_PORT}`,
      url: `http://localhost:${APP_PORT}/login`,
      env: {
        // NOT demo mode — see the header. The stub answers the shell's reads from the app's own fixtures.
        DEMO_MODE: "0",
        PLATFORM_URL: `http://127.0.0.1:${STUB_PORT}`,
        PLATFORM_SERVICE_TOKEN: "wd-e2e-service-token",
        SESSION_SECRET: "wd-e2e-session-secret",
        NEXT_DIST_DIR: DIST,
      },
      reuseExistingServer: !process.env.CI,
      // Server logs matter when a state fails only against the BUILT app (the gate runs `next start`).
      stdout: "pipe",
      stderr: "pipe",
      timeout: 240_000,
    },
  ],
});
