import type { Page } from "@playwright/test";

// IAM-06b — Playwright fixtures for "sign in as any persona". Companion to
// `platform-nest/src/seed/personas.ts` (IAM-06a) — the email convention below MUST match that
// file's `persona.<key>@iam-personas.test` exactly, or a real-backend run silently logs in as
// nobody (dev-login 404s and the test fails somewhere confusing downstream instead of here).
//
// Covers BOTH runtimes:
//  - Real backend (DEMO_MODE unset): every persona works uniformly, once `npm run seed:personas`
//    has been run against that backend — dev-login resolves purely by email.
//  - DEMO_MODE=1 (the default for `npm run e2e` — see playwright.config.ts): NOT all personas are
//    representable. `src/lib/demoIdentity.ts` only resolves 4 coarse tiers. See
//    `DEMO_MODE_EMAIL` below for exactly which 4, and `isDemoModeSupported` to check before
//    writing a demo-mode spec against a persona that isn't one of them.
export type PersonaKey =
  // HIER-3 (2026-08-11): `team_lead` retired — role, derived role, policies and every
  // writer are gone (migration 0103). `org_unit_lead` is its replacement, but it is NOT
  // added here: no demo identity maps to it, so listing it would only widen the
  // "unsupported persona" set this file exists to make loud.
  | "superadmin" | "company_admin" | "manager" | "member" | "viewer"
  | "hr_staff" | "hr_manager" | "it_admin" | "search_staff" | "search_manager"
  | "agency_approver" | "group_executive" | "client_contact";

const EMAIL_DOMAIN = "iam-personas.test";

/** The real-backend login address for a persona — MUST match `seed/personas.ts`'s convention. */
export const personaEmail = (key: PersonaKey): string => `persona.${key}@${EMAIL_DOMAIN}`;

// Which personas DEMO_MODE can stand in for TODAY, and the existing demo email that resolves to
// the CORRECT role (not an approximation dressed up as one). Do not "fix" DEMO_MODE's gap by
// editing `src/lib/demoIdentity.ts` from here — that file, and the identities `demoFixtures.ts`
// wires for it, belong to the wider UI program and are out of scope for this ticket. If DEMO_MODE
// grows persona-aware routing later, this table gets wider; the direction of the dependency never
// reverses.
const DEMO_MODE_EMAIL: Partial<Record<PersonaKey, string>> = {
  superadmin: "hansel@gaiada.com", // -> demo-hansel: platform_admin (+ group_executive)
  group_executive: "hansel@gaiada.com", // demo-hansel ALSO carries group_executive — same identity
  member: "gede@gaiada.com", // -> gede-ic: plain `member`, an exact role match
  search_staff: "seo-staff@gaiada.com", // -> seo-staff: exact `search_staff` match
  client_contact: "client@northwind.example", // contains "client" -> demo-client, exact `client` match
};

// The personas with NO demo-mode equivalent today — company_admin, manager, viewer,
// hr_staff, hr_manager, it_admin, search_manager, agency_approver. Listed explicitly (not derived)
// so this file is honest even if someone adds a key to PersonaKey without updating DEMO_MODE_EMAIL.
export function isDemoModeSupported(key: PersonaKey): boolean {
  return key in DEMO_MODE_EMAIL;
}

function demoUnsupportedMessage(key: PersonaKey): string {
  return (
    `DEMO_MODE has no identity for persona "${key}". src/lib/demoIdentity.ts only resolves 4 ` +
    `coarse tiers today (superadmin/group_executive via demo-hansel, member via gede-ic, ` +
    `search_staff via seo-staff, client_contact via demo-client) — company_admin, manager, ` +
    `viewer, hr_staff, hr_manager, it_admin, search_manager and agency_approver have ` +
    `NO demo equivalent. Run this spec against a real backend instead: unset DEMO_MODE, start ` +
    `platform-nest, run \`npm run seed:personas\` there once, then \`PLATFORM_URL=... npm run e2e\`. ` +
    `See platform-nest/README-PERSONAS.md.`
  );
}

/**
 * Signs in as `key` and waits for the post-login redirect (staff land on "/", the client_contact
 * persona lands on "/portal" — both satisfy the generic "left /login" wait below). Throws loudly,
 * BEFORE touching the page, if DEMO_MODE is active and this persona has no demo identity — never
 * silently substitutes a different persona (that is exactly the failure mode that would let a
 * DENY assertion pass for the wrong reason, which is the class of bug this whole program exists to
 * catch, not reintroduce).
 */
export async function loginAsPersona(
  page: Page,
  key: PersonaKey,
  opts: { demoMode?: boolean } = {},
): Promise<void> {
  // Defaults to `true` — matching this project's own `webServer.env.DEMO_MODE` in
  // playwright.config.ts, which is what `npm run e2e` actually starts. This is a DELIBERATE
  // default, not an env-var read: `process.env.DEMO_MODE` in the Playwright test-runner's own
  // process is NOT the flag that controls the app — that env var is set only on the spawned
  // `next dev`/`next start` child process (see config), so reading it here would silently take
  // the wrong branch on every standard `npm run e2e` invocation. Pass `{ demoMode: false }`
  // explicitly when pointing this suite at a real backend (unset DEMO_MODE in the config's
  // webServer, or run against a separately-started server with `PLATFORM_URL` set).
  const demoMode = opts.demoMode ?? true;
  if (demoMode && !isDemoModeSupported(key)) throw new Error(demoUnsupportedMessage(key));
  const email = demoMode ? DEMO_MODE_EMAIL[key]! : personaEmail(key);

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}
