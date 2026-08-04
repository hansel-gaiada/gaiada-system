import { test, expect, type Page } from "@playwright/test";

// CP-17 — the client portal end to end, as an EXTERNAL CLIENT, in DEMO_MODE.
//
// This suite exists because the portal's two riskiest properties are invisible to `tsc`, to vitest and to
// `next build`:
//   1. The SHELL SWAP. `(portal)` must replace the staff layout, not nest inside it. A route-group mistake
//      renders a client the staff sidebar — which typechecks, builds, and is wrong in exactly the way the
//      owner's 2026-08-04 decision was about.
//   2. THE WRITE FLOWS. Signing an agreement and recording a payment go through `useActionState`, which
//      means a client component, a server action and a revalidate. Every unit test in this repo would pass
//      with those three mis-wired.
//
// It runs in its own project (`portal`) with a CLIENT session rather than the staff `.auth/user.json`:
// the demo login maps an address containing "client" (or ending `@northwind.example`) to an identity
// holding ONLY the `client` role, which is what `isClientOnly` keys off.
async function signInAsClient(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dana@northwind.example");
  await page.getByRole("button", { name: /sign in/i }).click();
  // A client-only identity is redirected off the staff dashboard to /portal by `(app)/page.tsx`.
  await page.waitForURL("**/portal");
}

test.describe("client portal", () => {
  test("a client lands on their own portal, with the portal shell and NOT the staff shell @portal", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    await signInAsClient(page);

    // The portal's own chrome.
    await expect(page.getByText("Client Portal")).toBeVisible();
    await expect(page.getByRole("navigation", { name: /portal sections/i })).toBeVisible();

    // The staff shell must be absent. These are the surfaces a client must never be handed: the
    // departments rail, the approvals inbox, the global search, the company switcher.
    await expect(page.getByRole("link", { name: /^Departments$/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Timesheets$/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Knowledge$/ })).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });

  test("every portal tab renders without an error boundary @portal", async ({ page }) => {
    // Seven first-hit navigations. Under `next dev` each route is COMPILED on first request, so this one
    // test legitimately needs several times the default 30s budget — it was the only failure on the first
    // run, at ~5s per uncompiled route. Raised rather than split into seven tests: the value here is that
    // one session walks the whole tab strip, which is what a client actually does.
    test.setTimeout(150_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));
    await signInAsClient(page);

    for (const [href, heading] of [
      ["/portal/projects", /Projects/],
      ["/portal/timeline", /Timeline/],
      ["/portal/deliverables", /Deliverables/],
      ["/portal/approvals", /Approvals/],
      ["/portal/invoices", /Invoices/],
      ["/portal/contracts", /Agreements/],
      ["/portal/profile", /Profile/],
    ] as Array<[string, RegExp]>) {
      await page.goto(href);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
      // An error boundary's fallback also renders an h1, so the heading alone proves nothing.
      await expect(page.getByText(/something went wrong|application error/i)).toHaveCount(0);
    }
    expect(pageErrors).toEqual([]);
  });

  test("the dashboard leads with what needs the client @portal", async ({ page }) => {
    await signInAsClient(page);
    // The fixture ships a pending gate and two unsigned contracts, so this must never be the empty state.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/needs? you/i);
    await expect(page.getByRole("link", { name: /review & sign/i }).first()).toBeVisible();
  });

  test("a client reads an agreement and signs it @portal", async ({ page }) => {
    await signInAsClient(page);
    await page.goto("/portal/contracts");
    await page.getByRole("link", { name: /read & sign/i }).first().click();

    // The terms must be on the page BEFORE the signature block — a sign button on a page that does not
    // show what is being signed is not a signature at all.
    await expect(page.getByText(/## Scope|Scope/i).first()).toBeVisible();

    await page.getByLabel(/your full name/i).fill("Dana Whitfield");
    // The attestation is required server-side too; submitting without it is covered by the unit tests.
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /sign this agreement/i }).click();

    await expect(page.getByText(/signed — thank you/i)).toBeVisible();
  });

  test("a client records a payment and is told it is NOT yet settled @portal", async ({ page }) => {
    await signInAsClient(page);
    await page.goto("/portal/invoices");
    await page.getByRole("link", { name: /\d{2} \w{3} \d{4}/ }).first().click();

    await expect(page.getByRole("heading", { name: /tell us you've paid/i })).toBeVisible();
    // The amount is pre-filled with the outstanding balance; a partial payment is typed over it.
    await page.getByLabel(/amount you paid/i).fill("1000000");
    await page.getByLabel(/date of transfer/i).fill(new Date().toISOString().slice(0, 10));
    await page.getByRole("button", { name: /record this payment/i }).click();

    // The wording is the assertion: a client who believes the portal has SETTLED their invoice will not
    // answer the reminder that follows.
    await expect(page.getByText(/finance team will confirm/i)).toBeVisible();
  });

  test("a staff member sees the teach-state, not a client dashboard @portal", async ({ page }) => {
    // The counterpart to the isolation tests in the BFF suite: the demo fixture refuses a non-client
    // caller exactly as the real scope resolver does, so this proves the UI handles that 403 as an
    // explanation rather than as a crash or an empty dashboard.
    await page.goto("/login");
    await page.getByLabel("Email").fill("hansel@gaiada.com");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("**/");

    await page.goto("/portal");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/what your clients see/i);
    await expect(page.getByText(/signed in as a staff member/i)).toBeVisible();
  });
});
