// Which demo identity a dev-login email resolves to (DEMO_MODE only).
//
// Extracted from `app/login/actions.ts` so it can be tested: that file is `"use server"` and may
// therefore export only async functions, so a pure helper cannot live there. Kept free of both
// `server-only` and `next/headers` for the same reason `lib/session.ts` is — so plain vitest can
// import it.
//
// ORDER IS THE MECHANISM, not a style choice, which is why it is asserted rather than described:
// the tests below the obvious ones are the ones that matter (a client address containing "ic", a
// staff address containing "client").
export type DemoIdentityId = "seo-staff" | "demo-client" | "dept-manager" | "gede-ic" | "demo-hansel";

export function demoIdentityFor(email: string): DemoIdentityId {
  const lower = email.toLowerCase();
  // Most specific first. `search_staff` drives negative-permission rendering in the SEO console.
  if (lower === "seo-staff@gaiada.com" || lower.includes("seo-staff")) return "seo-staff";
  // External client BEFORE the "ic" test: "client" itself contains no "ic", but a real client
  // address easily can ("erica@…", "nicole@…"), and being an external client is the more specific
  // claim than the IC tier. Getting this order wrong hands a client the staff dashboard.
  if (lower.includes("client") || lower.endsWith("@northwind.example")) return "demo-client";
  // GM-02b needs a MANAGER-tier identity: the GM console's narrowed department-lead view is gated on
  // `reports.department.view`, which `manager` holds and `member`/`viewer` do not — so neither
  // `demo-hansel` (platform_admin, full access) nor `gede-ic` (member, refused) can exercise it, and
  // an authorization tier that cannot be driven is an authorization tier nobody verifies.
  //
  // Placed BEFORE the "ic" test for the same reason the client test is: precedence must not depend on
  // luck. "manager" happens to contain no "ic" today, but a future rename of this token must not
  // silently demote a manager address to the IC tier.
  if (lower === "manager@gaiada.com" || lower.includes("manager")) return "dept-manager";
  if (lower === "gede@gaiada.com" || lower.includes("ic")) return "gede-ic";
  return "demo-hansel";
}
