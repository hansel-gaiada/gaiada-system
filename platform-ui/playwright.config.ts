import { defineConfig, devices } from "@playwright/test";

// E2E against the app running in DEMO_MODE (no backend needed — see
// src/lib/demoFixtures.ts). Assumes a production build exists (`next build`);
// the webServer just starts it with DEMO_MODE=1.
// `E2E_PORT` lets a session avoid clashing with a sibling agent's own dev server on the default
// port — the shared-checkout discipline several concurrent-session tickets in this program require.
const PORT = Number(process.env.E2E_PORT) || 3005;

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
      testIgnore: [/auth\.spec\.ts/, /smoke\.spec\.ts/, /portal\.spec\.ts/, /iam-personas-fixture\.spec\.ts/, /pm-unified-interface\.spec\.ts/, /social-console\.spec\.ts/, /gm-console\.spec\.ts/],
    },
    {
      // CP-17 client portal. Its OWN project with NO stored session, because every test here signs in as
      // an external client (or, in one case, as staff) and the shared `.auth/user.json` is a staff
      // session — reusing it would make `isClientOnly` false and silently test the staff shell instead
      // of the portal, which is the one thing this suite exists to check.
      name: "portal",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /portal\.spec\.ts/,
    },
    {
      // Anonymous flows (login, step-up, sign-out) — no stored session.
      name: "anon",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /auth\.spec\.ts/,
    },
    {
      // IAM-06b — persona fixture specs. Self-contained (each test signs in fresh via
      // `loginAsPersona`), no dependency on the "setup" project's stored staff session — a spec
      // here may sign in as a client or as staff in the same file, and a stale stored session
      // would silently test the wrong shell (same reasoning as the "portal" project above).
      name: "personas",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /iam-personas-fixture\.spec\.ts/,
    },
    {
      // Unified PM interface coverage (commit c89fed6) — self-contained, no dependency on the
      // "setup" project: each test signs in as a different demo identity (elevated/member/
      // search_staff) itself, mirroring the "personas" project's reasoning above (a stale shared
      // staff session would silently test the wrong identity for the capability assertions here).
      name: "pm-unified",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /pm-unified-interface\.spec\.ts/,
    },
    {
      // SMM-25 — the Social Media (dept-4) console suite. Self-contained (each test signs in as
      // one of three identities itself — platform_admin/manager-tier, plain member, or the demo
      // client-portal contact), no dependency on the "chromium" project's stored staff session,
      // same reasoning as the "portal"/"personas"/"pm-unified" projects above: a stale shared
      // staff session would silently test the wrong identity for the RBAC negative controls this
      // suite exists to prove.
      name: "social",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /social-console\.spec\.ts/,
    },
    {
      // GM-10 — the GM console suite. Self-contained (each test signs in as either the
      // platform_admin demo identity or a plain member), no dependency on the "chromium" project's
      // stored staff session — same reasoning as the "portal"/"personas"/"pm-unified"/"social"
      // projects above, and it matters more here than anywhere else: the negative controls in that
      // file are the only browser-level proof that a plain member cannot read company-grain figures
      // through the GM console, and a stale staff session would turn them all green vacuously.
      name: "gm",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /gm-console\.spec\.ts/,
    },
    {
      // P3-12 CI build-gate smoke check. Self-contained (does its own login),
      // no dependency on the "setup" project, so `--grep @smoke` runs just
      // this one test without pulling in the rest of the suite.
      name: "smoke",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /smoke\.spec\.ts/,
    },
  ],
  webServer: {
    // `next dev` avoids the `output: standalone` conflict with `next start`
    // and needs no prior build — `npm run e2e` is fully self-contained.
    // In CI (P3-12), the platform-ui job already ran `npm run build` as its
    // gate step, so the smoke project starts the real built app instead —
    // that's the whole point of the smoke check (catch runtime/500s `next
    // build` + `tsc` + vitest all miss, e.g. a `server-only` import that
    // reaches a client component).
    command: process.env.CI ? `npx next start -p ${PORT}` : `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { DEMO_MODE: "1" },
  },
});
