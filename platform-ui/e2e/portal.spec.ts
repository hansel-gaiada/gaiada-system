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
      ["/portal/requests", /Requests/],
      ["/portal/conversation", /Conversation/],
      ["/portal/approvals", /Approvals/],
      ["/portal/invoices", /Invoices/],
      ["/portal/contracts", /Contracts/],
      ["/portal/profile", /People/],
    ] as Array<[string, RegExp]>) {
      await page.goto(href);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
      // An error boundary's fallback also renders an h1, so the heading alone proves nothing.
      await expect(page.getByText(/something went wrong|application error/i)).toHaveCount(0);
    }
    // PV2-04 - each of the five AREA links, once. A primary link goes to the area's first sub-tab.
    for (const [area, heading] of [
      ["Overview", /./],
      ["Projects", /Projects/],
      ["Business", /Business/],
      ["Contracts & billing", /Contracts/],
      ["People", /People/],
    ] as Array<[string, RegExp]>) {
      await page
        .getByRole("navigation", { name: "Portal sections" })
        .getByRole("link", { name: new RegExp("^" + area.replace("&", "\\&")) })
        .click();
      await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
      await expect(page.getByText(/something went wrong|application error/i)).toHaveCount(0);
    }
    expect(pageErrors).toEqual([]);
  });

  test("a finished project sits under Past, and People shows the account manager and our side @portal", async ({ page }) => {
    await signInAsClient(page);
    await page.goto("/portal/projects");
    const past = page.locator("details", { hasText: "Past" });
    await past.locator("summary").click();
    await expect(past.getByText("Campaign — Q4 2025")).toBeVisible();

    await page.goto("/portal/profile");
    await expect(page.getByRole("heading", { name: /Your account manager/ })).toBeVisible();
    await expect(page.getByText("made@gaiada.example").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /On our side/ })).toBeVisible();
    await expect(page.getByText("Made Prabowo").first()).toBeVisible();
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

  // PV5-06/PV5-09 — the client signs WHAT THEY SAW. The page carries the agreement's hash in a hidden field; if the agreement
  // changed after the page was opened, the server refuses (409), writes nothing, and the page says so and reloads. Driven here
  // by making the hash on the page stale, which is exactly what an agreement edited under an open tab looks like.
  test("signing a stale agreement is refused with a reload notice, and nothing is signed @portal", async ({ page }) => {
    await signInAsClient(page);
    await page.goto("/portal/contracts/ctr-sow-brand");
    await expect(page.getByText(/Scope|Brand audit/i).first()).toBeVisible();
    await page.locator('input[name="contentSha256"]').evaluate((el) => { (el as HTMLInputElement).value = "stale-hash-from-an-older-version"; });
    await page.getByLabel(/your full name/i).fill("Dana Whitfield");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /sign this agreement/i }).click();

    // `.cp-form__error` (the form's own alert), not a bare role=alert: Next's route announcer is a role=alert too.
    await expect(page.locator(".cp-form__error")).toContainText(/changed since you opened it/i);
    await expect(page.locator(".cp-form__error")).toContainText(/reloaded/i);
    // Nothing was signed: the form is still offered and there is no confirmation.
    await expect(page.getByText(/signed — thank you/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /sign this agreement/i })).toBeVisible();
  });

  test("a signed agreement offers its sealed copy @portal", async ({ page }) => {
    await signInAsClient(page);
    await page.goto("/portal/contracts/ctr-msa-2026");
    await expect(page.getByRole("link", { name: /download your signed copy/i })).toHaveAttribute("href", /\/portal\/files\/file-ctr-msa-signed$/);
  });

  test("an issued invoice is laid out as the invoice of record, with How to pay and no Card @portal", async ({ page }) => {
    await signInAsClient(page);
    // inv-2026-021: taxed, issued, and its PDF is not rendered yet.
    await page.goto("/portal/invoices/inv-2026-021");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Invoice DEMO/2026/0021");
    await expect(page.getByRole("heading", { name: /invoice of record/i })).toBeVisible();
    await expect(page.getByText(/Being prepared/)).toBeVisible();
    await expect(page.getByText("PPN 11%")).toBeVisible();
    await expect(page.getByRole("heading", { name: /how to pay/i })).toBeVisible();
    await expect(page.getByLabel(/how you paid/i).locator("option")).toHaveText(["Bank transfer", "Cash", "Other"]);
    // inv-2026-014 has its PDF.
    await page.goto("/portal/invoices/inv-2026-014");
    await expect(page.getByRole("link", { name: /download invoice DEMO\/2026\/0014/i })).toBeVisible();
  });

  test("PV5-10: Pay online leaves for the hosted page and comes back to 'we're confirming your payment' @portal", async ({ page }) => {
    await signInAsClient(page);
    // In DEMO_MODE the "hosted page" is the invoice's own return URL, so the round trip stays inside the app.
    await page.goto("/portal/invoices/inv-2026-014");
    await expect(page.getByRole("heading", { name: /^pay online/i })).toBeVisible();
    await page.getByRole("button", { name: "Pay online", exact: true }).click();
    await page.waitForURL(/\/portal\/invoices\/inv-2026-014\?checkout=finished/);
    await expect(page.getByRole("status").filter({ hasText: /confirming your payment/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pay online", exact: true })).toHaveCount(0);
  });

  test("PV-D41: the simulated payment page says no real money moves, and Pay (simulated) goes back to the invoice @portal", async ({ page }) => {
    await signInAsClient(page);
    await page.goto("/portal/pay/simulated/ck-demo-sim");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Simulated payment");
    await expect(page.getByText("Simulated payment (review stage): no real money moves.")).toBeVisible();
    await page.getByRole("button", { name: "Pay (simulated)", exact: true }).click();
    await page.waitForURL(/\/portal\/invoices\/inv-2026-014\?checkout=finished/);
    await expect(page.getByRole("status").filter({ hasText: /confirming your payment/i })).toBeVisible();
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

  // UI-01 — the portal-side counterpart of the mailed-approval-deep-link bug MAIL-09 found: a
  // client clicking an emailed pipeline-approval link (`entityHref(..., { portal: true })` ->
  // `/portal/approvals/:runId`) with no session must land back on that exact run after signing in,
  // not on the generic `/portal` home.
  test("an unauthenticated portal deep link survives the login round trip @portal", async ({ page }) => {
    await page.goto("/portal/approvals/run-demo-1");
    await page.waitForURL("**/login**");
    expect(decodeURIComponent(page.url())).toContain("return=/portal/approvals/run-demo-1");

    await page.getByLabel("Email").fill("dana@northwind.example");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("**/portal/approvals/run-demo-1");
  });

  // MI-04 — the client submits a change request, sees the ratified viewer-can-submit ruling hold in
  // practice (this is `demo-client`, a `signer`, but nothing here checks that), and the existing
  // fixture rows (declined + a mini-run deep-link) render real content.
  test("a client submits a change request and sees it alongside the triage history @portal", async ({ page }) => {
    await signInAsClient(page);
    await page.goto("/portal/requests");

    // The seeded fixture rows: a declined one with its reason visible, and an in-progress one whose
    // deep-link lands on the SAME run the approvals suite already exercises (run-demo-1) — proving the
    // link is real, not a dead id invented for this page.
    await expect(page.getByText(/footer edit our team can make directly/i)).toBeVisible();
    const deliveryLink = page.getByRole("link", { name: /view delivery/i }).first();
    await expect(deliveryLink).toBeVisible();
    await deliveryLink.click();
    await expect(page).toHaveURL(/\/portal\/approvals\/run-demo-1$/);
    await page.goBack();

    // Submit a new one. `demo-client`'s profile is client-wide (`access.wideClientIds: [the client]`), so "Your
    // whole account" is offered — the project-SCOPED half of this rule (no such option, and a required
    // project) is pinned as a unit test instead (`lib/portal.test.ts`), per the task brief's "do not
    // invent a second client identity" constraint.
    await page.getByLabel(/what kind of request is this/i).selectOption("bug");
    await page.getByLabel(/in a few words/i).fill("The pricing page 404s on mobile Safari");
    await page.getByLabel(/which project is this for/i).selectOption({ label: "Your whole account" });
    await page.getByRole("button", { name: /send request/i }).click();

    await expect(page.getByText(/we've received your request/i)).toBeVisible();
    await expect(page.getByText("The pricing page 404s on mobile Safari")).toBeVisible();
  });

  // PV4-08 — Conversation, in DEMO_MODE (the demo store enforces the BFF's limits; messages are permanent, PV-D34).
  // The staff-reply-arrives flow needs a second party and runs against the stub BFF: e2e/portal-conversation.spec.ts.
  test("conversation: threads by project, General pinned, a reply that is permanent: no edit, no remove @portal", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsClient(page);
    await page.goto("/portal/conversation");
    await expect(page.getByRole("heading", { level: 3, name: "General" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Website relaunch" })).toBeVisible();
    // The Projects area has a Conversation sub-tab.
    await expect(page.getByRole("navigation", { name: /Projects pages/ }).getByRole("link", { name: "Conversation" })).toBeVisible();

    await page.getByRole("link", { name: /Homepage copy/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Homepage copy");
    const messages = page.getByRole("list", { name: /messages/i });
    await expect(messages.getByRole("listitem").first()).toBeVisible();
    // Counted, not assumed: a retry of this test runs against the same in-memory demo store.
    const before = await messages.getByRole("listitem").count();
    await expect(page.getByRole("link", { name: /headline-options\.pdf/ })).toHaveAttribute("href", /\/portal\/files\//);
    // The hint, verbatim, and the history is not a live region.
    await expect(page.getByText("Prices and terms change only through a signed contract or amendment.")).toBeVisible();
    await expect(page.locator('[role="log"]')).toHaveCount(0);

    await page.getByLabel("Your reply").fill("Here is the wording: https://example.com/copy <b>not bold</b>");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(messages.getByRole("listitem")).toHaveCount(before + 1);
    // Plain text: the markup shows as characters, the URL is a link.
    await expect(messages.getByText("<b>not bold</b>", { exact: false })).toBeVisible();
    await expect(messages.getByRole("link", { name: "https://example.com/copy" })).toBeVisible();
    // Focus returned to the box so the client can keep typing.
    await expect(page.getByLabel("Your reply")).toBeFocused();

    // PV-D34: the message just sent is permanent. The composer says so, and no message carries an edit or remove control.
    await expect(page.getByText("Messages can't be edited or removed once sent. Post a correction instead.")).toBeVisible();
    await expect(page.getByRole("button", { name: /edit|remove/i })).toHaveCount(0);
    await expect(messages.getByText("edited")).toHaveCount(0);
    await expect(messages.getByText("Message removed")).toHaveCount(0);

    // A correction is a new message.
    await page.getByLabel("Your reply").fill("Correction: the headline is Updated wording");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(messages.getByRole("listitem")).toHaveCount(before + 2);
    await expect(messages.getByText("Correction: the headline is Updated wording")).toBeVisible();
    // The original is still there, word for word.
    await expect(messages.getByText("<b>not bold</b>", { exact: false })).toBeVisible();
  });

  test("conversation: a closed thread has no composer, and the project page lists threads and meeting notes @portal", async ({ page }) => {
    await signInAsClient(page);
    await page.goto("/portal/conversation/th-brand");
    await expect(page.getByText("This conversation is closed")).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByText("Option two, please. Thank you.")).toBeVisible();
    await expect(page.getByText("Message removed")).toHaveCount(0);

    await page.goto("/portal/projects/proj-nw-site");
    await expect(page.getByRole("heading", { name: "Conversation" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Homepage copy/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Meeting notes" })).toBeVisible();
    await page.getByRole("link", { name: /Website relaunch kickoff/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Website relaunch kickoff");
    await expect(page.getByText(/Shared on .* by Made Prabowo/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Decisions" })).toBeVisible();
  });

  test("an amendment says what it amends and where it came from @portal", async ({ page }) => {
    await signInAsClient(page);
    await page.goto("/portal/contracts/ctr-amd-msa-1");
    await expect(page.getByText(/Amendment to/)).toBeVisible();
    await expect(page.getByRole("link", { name: "GDA-2026-004" })).toBeVisible();
    await expect(page.getByRole("link", { name: "From your request" })).toHaveAttribute("href", "/portal/requests");
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
  test("a staff member who is also a client of another company gets that company's portal @portal", async ({ page }) => {
    // PV2-05: demo-viceroy-marketing is staff of co-resort and a contact of co-agency. The portal must
    // resolve through `clientOf`, so it shows Gaia Digital Agency, never the staff teach-state and
    // never Viceroy (the company they are merely employed by).
    await page.goto("/login");
    await page.getByLabel("Email").fill("viceroy-marketing@gaiada.com");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("**/");

    await page.goto("/portal");
    await expect(page.getByRole("navigation", { name: /portal sections/i })).toBeVisible();
    await expect(page.getByText(/signed in as a staff member/i)).toHaveCount(0);
    await expect(page.locator(".cp-brand__mark")).toHaveText("Gaia Digital Agency");
    // One client company only, so no switch.
    await expect(page.getByLabel("Company")).toHaveCount(0);
  });

  test("a client of two of our companies switches between them, and the choice sticks @portal", async ({ page }) => {
    // PV2-05: demo-two-company-client is a contact of co-agency AND co-resort (PV-D10), the only identity
    // that sees the switch. The demo fixtures answer both companies alike, so this proves the switch, its
    // cookie and the resolver; per-company data isolation is proven by the BFF's database suite.
    await page.goto("/login");
    await page.getByLabel("Email").fill("two-companies@deity-labs.example");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("**/portal");

    const brand = page.locator(".cp-brand__mark");
    const sw = page.getByLabel("Company");
    await expect(sw).toBeVisible();
    await expect(sw.locator("option")).toHaveText(["Gaia Digital Agency", "Viceroy"]);
    // No cookie yet: the first company by name.
    await expect(brand).toHaveText("Gaia Digital Agency");

    await sw.selectOption({ label: "Viceroy" });
    await page.getByRole("button", { name: "Switch" }).click();
    await expect(brand).toHaveText("Viceroy");

    // The cookie carries the choice to every page, not only the one the form posted from.
    await page.goto("/portal/projects");
    await expect(brand).toHaveText("Viceroy");
    await expect(page.getByLabel("Company")).toHaveValue("co-resort");
  });

  test("someone who is both staff and client moves between the workspace and the portal @portal", async ({ page }) => {
    // PV2-06 at the identity level; UserMenu.test.tsx and PortalUserMenu.test.tsx pin the two halves.
    await page.goto("/login");
    await page.getByLabel("Email").fill("viceroy-marketing@gaiada.com");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL("**/");

    await page.locator(".erp-usermenu__trigger").click();
    await page.getByRole("menuitem", { name: "Client view" }).click();
    await page.waitForURL("**/portal");
    await expect(page.locator(".cp-brand__mark")).toHaveText("Gaia Digital Agency");

    await page.getByRole("button", { name: "Account menu" }).click();
    const back = page.getByRole("menuitem", { name: "Back to workspace" });
    await expect(back).toHaveAttribute("href", "/");
    await back.click();
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.locator(".cp-brand__mark")).toHaveCount(0);
  });

  test("a client who is not staff has no way into the workspace from the portal menu @portal", async ({ page }) => {
    await signInAsClient(page);
    await page.getByRole("button", { name: "Account menu" }).click();
    // In the viewport, not merely "visible": the menu once opened upward, off the top of the screen.
    await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeInViewport();
    await expect(page.getByRole("menuitem", { name: "Your profile" })).toBeInViewport();
    await expect(page.getByRole("menuitem", { name: "Back to workspace" })).toHaveCount(0);
  });
});
