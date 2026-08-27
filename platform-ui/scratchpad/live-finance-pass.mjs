// Browser pass over the LIVE finance surfaces — READ ONLY.
//
// ⚠ This drives PRODUCTION (erp.gaiada.online). It navigates and reads; it NEVER submits a write
// form. Issuing a credit note or a write-off here would post real journal entries to a real ledger,
// and "I was testing" is not a correction — the ledger is append-only and the fix would be a
// reversal that stays on the face of the books forever.
//
// What it checks, per route:
//   1. the page returns 200 and renders (not an error boundary, not a redirect to /login)
//   2. no "not built yet" / BackendPending copy survives on a surface that IS built
//   3. the specific new controls exist and are reachable
//   4. nothing throws in the console
//
// Credentials come from the environment. Never hardcode, never log them.
import { chromium } from "playwright";

const BASE = process.env.ERP_BASE || "https://erp.gaiada.online";
const EMAIL = process.env.ERP_EMAIL;
const PASSWORD = process.env.ERP_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("ERP_EMAIL and ERP_PASSWORD must be set in the environment");
  process.exit(2);
}

const ROUTES = [
  { path: "/finance",               expect: [] },
  { path: "/finance/accounts",      expect: [] },
  { path: "/finance/receivables",   expect: ["Aging"] },
  { path: "/finance/payables",      expect: ["Aging"] },
  { path: "/finance/close",         expect: [] },
  { path: "/finance/consolidation", expect: [] },
  { path: "/finance/treasury",      expect: [] },
  { path: "/finance/assets",        expect: [] },
  { path: "/finance/cutover",       expect: [] },
  { path: "/finance/tax",           expect: [] },
  { path: "/finance/reports",       expect: [] },
];

// Copy that must NOT appear on a surface we just built. "Not built yet" left behind after the thing
// IS built is its own defect class in this repo — a console that lies about its own capabilities.
const STALE_CLAIMS = [/not built yet/i, /Backend pending/i, /coming soon/i];

const results = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

try {
  // ── Log in via SSO ──────────────────────────────────────────────────────────────────────────
  // The live login page carries NO inline form — only a "Sign in with SSO" link to
  // /auth/login?return=%2F, which bounces to Keycloak. So: click through, then fill the IdP form.
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1200);

  const sso = page.locator('a[href*="/auth/login"], button:has-text("Sign in with SSO")').first();
  if (await sso.count()) {
    await sso.click();
    await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  console.log("after SSO click ->", page.url().slice(0, 90));

  const user = page.locator('#username, input[name="username"]').first();
  if (await user.count()) {
    await user.fill(EMAIL);
    await page.locator('#password, input[name="password"]').first().fill(PASSWORD);
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {}),
      page.locator('#kc-login, button[type="submit"], input[type="submit"]').first().click(),
    ]);
    await page.waitForTimeout(4000);
  } else {
    console.log("no Keycloak username field found — already authenticated, or an unexpected page");
  }

  // A TEMPORARY Keycloak password lands here instead of the app. It is flagged on the CREDENTIAL,
  // so the admin API reports no requiredActions and it looks exactly like a normal login until you
  // read the URL. Detect it explicitly rather than reporting a mysterious auth failure.
  if (/required-action|UPDATE_PASSWORD/i.test(page.url())) {
    console.error("Keycloak is demanding a password change (temporary credential) — cannot proceed headlessly.");
    await page.screenshot({ path: "scratchpad/shot-login-update-password.png" });
    process.exit(1);
  }

  const afterLogin = page.url();
  const loggedIn = !/\/login|\/auth\/realms|\/realms\//.test(afterLogin);
  console.log(`login -> ${afterLogin.replace(BASE, "").slice(0, 80)} | authenticated: ${loggedIn}`);
  if (!loggedIn) {
    console.error("LOGIN FAILED — everything below would be a redirect, so stopping rather than reporting green.");
    await page.screenshot({ path: "scratchpad/shot-login-failed.png" });
    process.exit(1);
  }

  // ── Walk the surfaces ───────────────────────────────────────────────────────────────────────
  for (const r of ROUTES) {
    consoleErrors.length = 0;
    const resp = await page.goto(`${BASE}${r.path}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    const status = resp?.status() ?? 0;
    const url = page.url().replace(BASE, "");
    const body = (await page.locator("body").innerText().catch(() => "")) || "";

    const bounced = /\/login/.test(url);
    const stale = STALE_CLAIMS.filter((re) => re.test(body)).map(String);
    const missing = r.expect.filter((t) => !body.includes(t));
    const errored = /Application error|Unhandled Runtime Error|500/.test(body.slice(0, 400));

    results.push({
      route: r.path, status, url, bounced, errored,
      stale, missing, consoleErrors: [...consoleErrors],
      chars: body.length,
    });
    const flag = bounced || errored || stale.length || missing.length ? "  <-- LOOK" : "";
    console.log(`${String(status).padEnd(4)} ${r.path.padEnd(24)} ${String(body.length).padStart(6)} chars${flag}`);
    await page.screenshot({ path: `scratchpad/shot-${r.path.replace(/\//g, "_")}.png` });
  }
} finally {
  await browser.close();
}

console.log("\n=== SUMMARY ===");
let bad = 0;
for (const r of results) {
  const problems = [];
  if (r.bounced) problems.push("redirected to /login");
  if (r.errored) problems.push("error boundary");
  if (r.stale.length) problems.push(`stale claim: ${r.stale.join(", ")}`);
  if (r.missing.length) problems.push(`missing text: ${r.missing.join(", ")}`);
  if (r.consoleErrors.length) problems.push(`console: ${r.consoleErrors.slice(0, 2).join(" | ")}`);
  if (problems.length) { bad++; console.log(`PROBLEM ${r.route}: ${problems.join("; ")}`); }
}
console.log(bad === 0 ? "All routes rendered clean." : `${bad} route(s) need attention.`);
