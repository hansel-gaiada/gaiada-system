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
export type DemoIdentityId =
  | "seo-staff" | "demo-client" | "dept-manager" | "gede-ic" | "demo-hansel" | "demo-viceroy-marketing"
  | "demo-two-company-client" | "demo-owner" | "demo-client-admin" | "demo-client-viewer" | "u-dev" | "u-webhead"
  | "u-seo" | "u-social" | "u-creative" | "u-hr" | "u-finance-staff" | "u-it" | "u-resort";

export function demoIdentityFor(email: string): DemoIdentityId {
  const lower = email.toLowerCase();
  // Most specific first. `search_staff` drives negative-permission rendering in the SEO console.
  if (lower === "seo-staff@gaiada.com" || lower.includes("seo-staff")) return "seo-staff";
  // DW-3a: an employee PLACED in a department (u-dev sits in Web Dev > Frontend in the demo org tree,
  // `lib/org.ts`), so the department workspace Overview can be driven as a real employee. The token is
  // "webdev", which has no "ic" and no "client"; it still goes up here, before both tests, so a future
  // spelling like "webdev-ic@" cannot fall to the IC tier.
  if (lower === "webdev@gaiada.com" || lower.includes("webdev")) return "u-dev";
  // DW-3h: the HEAD of Web Dev (`org_unit_lead` on dept-1), so the Overview's Me | Team switch can be driven. "webhead" holds
  // no "webdev", "ic" or "client", and goes before the generic tests like the identity above, for the same reason.
  if (lower === "webhead@gaiada.com" || lower.includes("webhead")) return "u-webhead";
  // PV1-01: an OWNER of the group (the IAM `owner` role on the holding and its companies), not a
  // platform admin: the identity that sees the Group and Platform areas by ownership (PV-D18, PV-D20).
  // "group-owner", not "owner": `owner@gaiada.com` is pinned below as an ordinary staff address.
  if (lower === "group-owner@gaiada.com" || lower.includes("group-owner")) return "demo-owner";
  // PV2-05: a client contact of TWO of our companies, the only identity that sees the company switch.
  // BEFORE the generic client test, which would otherwise take any address containing "client".
  if (lower === "two-companies@deity-labs.example" || lower.includes("two-companies")) return "demo-two-company-client";
  // WSK-49f: two more Northwind client contacts, one ADMIN and one VIEWER, so the website-access grant
  // screens can be driven as each. BEFORE the generic client test, which takes any @northwind.example.
  if (lower === "admin@northwind.example") return "demo-client-admin";
  if (lower === "viewer@northwind.example") return "demo-client-viewer";
  // External client BEFORE the "ic" test: "client" itself contains no "ic", but a real client
  // address easily can ("erica@…", "nicole@…"), and being an external client is the more specific
  // claim than the IC tier. Getting this order wrong hands a client the staff dashboard.
  if (lower.includes("client") || lower.endsWith("@northwind.example")) return "demo-client";
  // PV2-02: staff of Viceroy AND a client contact of the agency, for PV2-05/PV2-06. BEFORE the "ic" test:
  // "viceroy" contains "ic", which would otherwise demote this address to the IC tier.
  if (lower === "viceroy-marketing@gaiada.com" || lower.includes("viceroy-marketing")) return "demo-viceroy-marketing";
  // DW-9a: seven more logins for the department workspace persona e2e (e2e/workspace-personas.spec.ts), each ONE grant.
  // All sit AFTER the "client" test (a client address is the more specific claim, as above) and BEFORE the "ic" test,
  // because "ic" hides in many natural words ("office", "service", "viceroy", "clinic", "logic") and none of these may
  // fall to the IC tier by luck. None of the tokens contains "ic" or "client" (the tests pin each address).
  if (lower === "seo-specialist@gaiada.com" || lower.includes("seo-specialist")) return "u-seo";
  // "social" and "creative" are ordinary words, so these two match the exact address only: as substrings they would take a
  // future "social-manager@" from the manager test below.
  if (lower === "social@gaiada.com") return "u-social";
  if (lower === "creative@gaiada.com") return "u-creative";
  if (lower === "hr-staff@gaiada.com" || lower.includes("hr-staff")) return "u-hr";
  if (lower === "finance-staff@gaiada.com" || lower.includes("finance-staff")) return "u-finance-staff";
  if (lower === "it-admin@gaiada.com" || lower.includes("it-admin")) return "u-it";
  if (lower === "resort-staff@gaiada.com" || lower.includes("resort-staff")) return "u-resort";
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
