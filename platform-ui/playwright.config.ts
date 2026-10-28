import { defineConfig, devices } from "@playwright/test";

// E2E against the app running in DEMO_MODE (no backend needed — see
// src/lib/demoFixtures.ts). Assumes a production build exists (`next build`);
// the webServer just starts it with DEMO_MODE=1.
// `E2E_PORT` lets a session avoid clashing with a sibling agent's own dev server on the default
// port — the shared-checkout discipline several concurrent-session tickets in this program require.
const PORT = Number(process.env.E2E_PORT) || 3005;
// The WebDesk specs only pass against the stubbed BFF (playwright.webdesk.config.ts); this config has no
// stub, so no project here may ever pick them up.
const WEBDESK_STUB_SPECS = /(webdesk-content|webdesk-editorial|webdesk-assist|webdesk-dashboard|portal-website|portal-conversation)\.spec\.ts/;

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
      testIgnore: [/auth\.spec\.ts/, /smoke\.spec\.ts/, /portal\.spec\.ts/, /iam-personas-fixture\.spec\.ts/, /pm-unified-interface\.spec\.ts/, /social-console\.spec\.ts/, /gm-console\.spec\.ts/, /company-context\.spec\.ts/, /workspace-shell\.spec\.ts/, /me-performance\.spec\.ts/, /workspace-departments\.spec\.ts/, /workspace-functional\.spec\.ts/, /workspace-personas\.spec\.ts/, /a11y-axe-workspaces\.spec\.ts/, /skin-social\.spec\.ts/, /social-pipeline-walk\.spec\.ts/, /social-calendar\.spec\.ts/, /overview-personalise\.spec\.ts/, /dept-notices\.spec\.ts/, /dept-kpi-months\.spec\.ts/, /dept-calendar\.spec\.ts/, /requests-across\.spec\.ts/, /freelancer-bills\.spec\.ts/, /contract-billing\.spec\.ts/, /portal-social\.spec\.ts/, WEBDESK_STUB_SPECS],
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
      // SCP-2 (plan SCP-2g): the client's post approval page (`/portal/social`) end to end as the demo client contact: axe in both themes at desktop and 390 px,
      // the way in through the sign-in, the stories circle, Approve / Undo / double-tap, Ask for changes with a pin, Approve all, the Grid preview and Approved
      // tabs. Its OWN project with NO stored session, for the same reason as `portal` above: every test signs in as the client itself. Order-dependent: the
      // demo store is module state in the Next server and one test's decision is the next one's start, so it runs on ONE worker, in file order, with no retries
      // (a retry would run against a store the first attempt already changed), and against a fresh server. Runs on the test server, like the workspace projects.
      name: "portal-social",
      fullyParallel: false,
      workers: 1,
      retries: 0,
      use: { ...devices["Desktop Chrome"] },
      testMatch: /portal-social\.spec\.ts/,
    },
    {
      // PV1-07 — the staff menu follows the company (verticals, Group, Platform). Signs in per test as a
      // specific demo identity (the group owner, a member), so NO stored session, for the same reason as
      // the portal project.
      name: "company-context",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /company-context\.spec\.ts/,
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
      // Single-worker for this project. The suite touches ~8 routes across three identities, and
      // under `next dev` (which compiles each route on first hit) the default worker count produced a
      // first-compile storm that timed out 22 of 25 tests — while the same 25 passed at
      // `--workers=2`. Not shared state, and not a product defect: the trigger was the app growing
      // around the suite (`next build` 20s -> 72s over one day). `fullyParallel: false` rather than
      // an in-file `mode: "serial"`, which cascades skips onto every later test when one fails.
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"] },
      testMatch: /gm-console\.spec\.ts/,
    },
    {
      // DW-2g: the department workspace shell, per persona. Self-contained: each test signs in as one demo identity itself,
      // so NO stored session (a stale shared staff session would test the wrong persona, same reasoning as the projects above). Not in the smoke
      // project: that one selects by FILE (smoke.spec.ts) as well as by tag.
      name: "workspace-shell",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /(workspace-shell|me-performance)\.spec\.ts/, // PV7-06: My performance signs in as the placed Web Dev employee the same way
    },
    {
      // DW-6a/6b/6e: the department workspaces' Work menus against the registry, per agency department. Same
      // reasoning as `workspace-shell` above: it signs in as the superadmin itself, so
      // NO stored session.
      name: "workspace-departments",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /workspace-departments\.spec\.ts/,
    },
    {
      // DW-7a/7b/7c: HR, Finance and IT walked row by row, as the superadmin and as a plain member. Same reasoning as
      // `workspace-departments` above: it signs in itself, so NO stored session.
      name: "workspace-functional",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /workspace-functional\.spec\.ts/,
    },
    {
      // DW-9a: the twelve kinds of person the workspace shell must be right for (placed employees, a head, HR/Finance/IT staff,
      // the unplaced owner, a platform admin, a generic-pack user, a client). Same reasoning as `workspace-functional`: every
      // test signs in as its own demo identity and plants the tenant cookie itself, so NO stored session.
      name: "workspace-personas",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /workspace-personas\.spec\.ts/,
    },
    {
      // DW-9b: the axe sweep of the workspace shell's own surfaces, light and dark, desktop and phone. Same reasoning as
      // `workspace-personas`: every test signs in as its own demo identity and plants the tenant cookie, so NO stored
      // session. Not in CI's smoke; gated on sumopod with the other workspace projects.
      name: "workspace-a11y",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /a11y-axe-workspaces\.spec\.ts/,
    },
    {
      // SCP-Kf: the Social skin (DW-D51) in a real browser, desktop and phone, with its axe sweep. Same reasoning as `workspace-a11y`: every test signs in as
      // the placed Social Media employee itself and plants the tenant and theme cookies, so NO stored session. The skin is on in code since SCP-Kg, so the spec
      // needs no setting. Gated on sumopod with the other workspace projects.
      name: "social-skin",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /skin-social\.spec\.ts/,
    },
    {
      // SCP-1p: the content pipeline walked end to end by its five roles (Officer, Copywriter, HoD, Creative, GM), loops a, b and c, and the maker/checker
      // refusal, through the real login page on the DEMO_MODE production build with the Social skin. Every test signs in as its own demo identity and
      // plants the tenant cookie, so NO stored session. Serial and order-dependent: one post is carried from persona to persona through the demo store
      // (module state pinned to globalThis in the Next server), so run it against a fresh server. No retries: a retry would re-run against a store the
      // first attempt already changed. Runs on sumopod only, like the workspace projects.
      // SCP-3e: `social-calendar.spec.ts` rides here too (the calendar's date moves change seeded posts of the same store, file serial, fresh server).
      name: "social-walk",
      fullyParallel: false,
      retries: 0,
      use: { ...devices["Desktop Chrome"] },
      testMatch: /social-(pipeline-walk|calendar)\.spec\.ts/,
    },
    {
      // DW-10d: a person hides and switches on Overview blocks (DW-D34), as the placed Web Dev employee and the superadmin. Same
      // reasoning as `workspace-functional` above: it signs in itself and plants the pilot cookie, so NO stored session.
      name: "overview-personalise",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /overview-personalise\.spec\.ts/,
    },
    {
      // DW-10a-2: the department notice board (BFF section 57): a placed employee reads, the Web Dev head posts, edits and withdraws, a company
      // admin posts company-wide. Same reasoning as `overview-personalise`: every test signs in as its own demo identity and plants the tenant
      // and pilot cookies itself, so NO stored session. Serial: the head's test changes the demo store the other tests read.
      name: "dept-notices",
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"] },
      testMatch: /dept-notices\.spec\.ts/,
    },
    {
      // DW-10b-2: the department KPI page's By month view (BFF section 58): the head of Web Dev reads twelve months, opens a trend and plans the next two
      // months; a plain member reads the table and has no plan form. Same reasoning as `dept-notices`: every test signs in as its own demo identity and
      // plants the tenant cookie itself, so NO stored session. Serial: the head's test changes the demo store the member's test reads.
      name: "dept-kpi-months",
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"] },
      testMatch: /dept-kpi-months\.spec\.ts/,
    },
    {
      // DW-10c-3: the department calendar (BFF section 59): a placed employee opens it from the Overview row and reads the month's holiday, the
      // away colleagues with their leave types, the milestone and the events; a person of another department gets the no-access state. Same
      // reasoning as `dept-notices`: every test signs in as its own demo identity and plants the tenant and pilot cookies itself, so NO stored
      // session. Serial: the demo's event store is module state in the dev server.
      name: "dept-calendar",
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"] },
      testMatch: /dept-calendar\.spec\.ts/,
    },
    {
      // DW-10e-3: requests across group companies (BFF §60). A Viceroy member sends to the agency's Creatives and Web Dev, the agency's Creatives
      // reads it in Incoming, and a Viceroy colleague who did not send it does not see it. Same reasoning as `dept-notices`: every test signs in as its
      // own demo identity and plants the tenant cookie itself, so NO stored session (a stale shared staff session would test the wrong person, and
      // the whole point is who sees what). Serial: the tests share one request through the demo store.
      name: "requests-across",
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"] },
      testMatch: /requests-across\.spec\.ts/,
    },
    {
      // DW-10f-4b: freelancer rates and bills (BFF §61.7 to §61.9). Finance adds a rate, reads the preview with the DW-D47 no-withholding warning,
      // drafts one bill and discards it. The spec signs in itself as demo-hansel (the one demo identity with finance access) and plants the
      // tenant cookie, so NO stored session. Serial: the tests share the demo freelancer store (module state in the dev server), and the last one
      // withdraws the rate the second added. Runs on the test server only, with the other workspace projects.
      name: "freelancer-bills",
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"] },
      testMatch: /freelancer-bills\.spec\.ts/,
    },
    {
      // DW-10f-2b/3b: the contract-billing screens (BFF §61.9): the payment schedule's editor and presets, sending, adding a schedule to a signed
      // agreement (DW-D49), the invoice drafted from instalments, its fixed-fee line, Cancel draft, and the portal's Payment schedule. Same reasoning
      // as `requests-across`: every test signs in as its own demo identity (the superadmin on staff pages, Northwind's Dana in the portal) and plants
      // the tenant cookie itself, so NO stored session. Serial and order-dependent: the tests spend what the earlier ones made in the demo store
      // (Viceroy, cl-4, is this spec's own client), so run the file fresh to re-seed. Runs on sumopod only, like the workspace projects.
      name: "contract-billing",
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"] },
      testMatch: /contract-billing\.spec\.ts/,
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
    // Own output dir LOCALLY: the e2e dev server must never share `.next` with a developer's
    // running server. In CI there is no such server, and the smoke project starts `next start`
    // against the build the platform-ui job just produced — that build goes to the default `.next`,
    // so forcing `.next-e2e` there finds no production build at all. An explicit NEXT_DIST_DIR
    // still wins in both places.
    env: {
      DEMO_MODE: "1",
      ...(process.env.NEXT_DIST_DIR
        ? { NEXT_DIST_DIR: process.env.NEXT_DIST_DIR }
        : process.env.CI
          ? {}
          : { NEXT_DIST_DIR: ".next-e2e" }),
    },
  },
});
