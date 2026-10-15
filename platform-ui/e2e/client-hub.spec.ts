import { test, expect, type Page } from "@playwright/test";
import { tenantCookie } from "./appCookies";

// ⚠ EVERY test here pins `gaiada_tenant` to `co-agency` before navigating, and it is load-bearing.
//
// The shared authed session's DEFAULT active company falls back to `me.companies[0]` (`lib/tenant.ts`)
// which is `co-holding` — and the demo fixtures are INCONSISTENT across that boundary: `CLIENTS` is a
// flat global array (every client is visible from every tenant) while `PROJECTS` is keyed BY tenant.
// So from `co-holding` a client page opens fine and shows zero projects, because the client's work
// lives under `co-agency`. The first run of this file caught exactly that, and it looked like a broken
// `?clientId=` facet rather than fixture geography.
//
// Same trap `a11y-axe.spec.ts` and `pm-unified-interface.spec.ts` each document for their own
// fixtures; same fix. (The underlying fixture inconsistency is real but out of this ticket's scope —
// making `CLIENTS` tenant-scoped would change the `/clients` list for every existing spec.)
async function openAsAgency(page: Page, path: string) {
  await page.goto("/");
  await page.context().addCookies([tenantCookie(page.url())]);
  await page.goto(path);
}

// The hub's own tab strip. The sidebar also has links called "Projects" and "People", so a bare
// `getByRole("link", { name: /^Projects/ })` is ambiguous (a strict-mode violation).
const hubTab = (page: Page, name: RegExp) =>
  page.getByRole("navigation", { name: "Client sections" }).getByRole("link", { name });

// CC-3 — drives the client hub in a real browser. The unit suite and the build gate both pass with a
// page that renders nothing useful (a `server-only` import, a bad shape, an empty list that should
// have rows), so the acceptance criterion for this ticket is "the ball lists actually appear".

test.describe("client hub", () => {
  test("@smoke the Overview tab shows both sides of the ball", async ({ page }) => {
    // cl-1 is the demo client the fixture gives a pending payment and an untriaged request, so
    // "waiting on us" is populated rather than an empty state that would pass vacuously.
    await openAsAgency(page, "/clients/cl-1");

    await expect(page.getByRole("heading", { name: "Northwind Traders" })).toBeVisible();

    // The two ball cards — the point of the screen.
    await expect(page.getByText("Waiting on us")).toBeVisible();
    await expect(page.getByText("Waiting on the client")).toBeVisible();

    // The specific item this whole redesign exists to surface: a client-recorded payment that no
    // other screen in the ERP mentions. If this assertion ever fails, the hub has stopped doing the
    // one thing it was built for, even if every other test still passes.
    await expect(page.getByRole("link", { name: /Confirm a client-recorded payment/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Triage a new change request/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Awaiting client signature/ })).toBeVisible();

    // An age, not a date — the arithmetic is the finding.
    await expect(page.getByText(/^11d$/)).toBeVisible();

    // The stale marker is a DESIGNED signal, so assert the styling actually lands rather than trusting
    // that the class name is present. Exactly one item is past the 7-day threshold (the 11d payment);
    // the 2d request and the client's own 4d item must not be marked — we do not call a client slow.
    await expect(page.locator(".ch-ball__item--stale")).toHaveCount(1);
    await expect(page.locator(".ch-ball__item--stale .ch-ball__since")).toHaveCSS("font-weight", "600");
  });

  // PV7-03 — the Health card, below the two ball lists. cl-1 is late on work 14+ days in the demo (off track), cl-3's reply-time
  // read "failed" (unknown, and the card says so rather than showing a state it cannot judge).
  test("PV7-03: the Health card shows the state, its reasons, per-project health, reply times and the markers", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1");
    const card = page.locator("section.lux-card", { has: page.locator(".ch-health-chip") });
    await expect(card).toBeVisible();
    await expect(card.locator(".ch-health-chip")).toHaveText("Off track");
    await expect(card.locator("[data-reason]").first()).toBeVisible();
    await expect(card.getByText(/late deliverables? and milestones?|late deliverable or milestone/).first()).toBeVisible();

    // It sits below the two lists and does not repeat their items.
    const order = await page.evaluate(() => {
      const top = (el: Element | null) => (el ? el.getBoundingClientRect().top : -1);
      const heading = (t: string) => Array.from(document.querySelectorAll("h3")).find((h) => h.textContent?.trim().startsWith(t)) ?? null;
      return { us: top(heading("Waiting on us")), health: top(heading("Health")), tiles: top(document.querySelector(".ch-tiles")) };
    });
    expect(order.us).toBeLessThan(order.health);
    expect(order.health).toBeLessThan(order.tiles);
    await expect(page.getByRole("link", { name: /Triage a new change request/ })).toHaveCount(1);

    // Per-project health with the PV-3 marker, and the reply times of both sides.
    const row = card.locator('tr[data-project="p-web-1"]');
    await expect(row.getByText("Client sees this")).toBeVisible();
    await expect(row.getByText(/\d+ done · \d+ upcoming ·/)).toBeVisible();
    await expect(card.locator('[data-part="turnaround"]').getByText("Client, all together")).toBeVisible();
    await expect(card.locator('[data-part="turnaround"]').getByText("Us, all together")).toBeVisible();
  });

  test("PV7-03: a failed reply-time read is 'Could not be loaded' and the state is Unknown, never On track", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-3");
    const card = page.locator("section.lux-card", { has: page.locator(".ch-health-chip") });
    await expect(card.locator(".ch-health-chip")).toHaveText("Unknown");
    await expect(card.getByText(/Reply times: Could not be loaded/)).toBeVisible();
    await expect(card.getByText("On track")).toHaveCount(0);
  });

  test("the hub's tabs are the portal's areas plus Internal (PV3-05)", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1");
    const tabs = page.getByRole("navigation", { name: "Client sections" }).getByRole("link");
    // Order matters: Overview · Reports · Projects · Business · Contracts & billing · People · Internal. The
    // Overview, Projects and Contracts & billing tabs carry count badges (their accessible name starts
    // with the label), and Internal says "Staff only".
    // PV7-04b: Reports sits right after Overview, mirroring the portal's Overview area (Overview + Reports).
    await expect(tabs).toHaveCount(7);
    await expect(tabs.nth(0)).toHaveText(/^Overview/);
    await expect(tabs.nth(1)).toHaveText("Reports");
    await expect(tabs.nth(2)).toHaveText(/^Projects/);
    await expect(tabs.nth(3)).toHaveText(/^Business/);
    await expect(tabs.nth(4)).toHaveText(/^Contracts & billing/);
    await expect(tabs.nth(5)).toHaveText(/^People/);
    await expect(tabs.nth(6)).toHaveText(/^InternalStaff only/);
    // PV3-08: the one new route. Its page and flows are pinned by client-billing.spec.ts.
    await expect(hubTab(page, /^Work/)).toHaveCount(0);
  });

  test("the Projects tab opens /work and groups tasks under this client's projects", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1");
    await hubTab(page, /^Projects/).click();
    await expect(page).toHaveURL(/\/clients\/cl-1\/work$/);
    await expect(hubTab(page, /^Projects/)).toHaveAttribute("aria-current", "page");

    // cl-1 owns "Client site redesign" in the demo fixture; cl-3 owns "Mobile app revamp". The
    // second assertion is the one that catches a broken facet — a filter that silently does nothing
    // renders every project here and still looks plausible.
    await expect(page.getByText("Client site redesign").first()).toBeVisible();
    await expect(page.getByText("Mobile app revamp")).toHaveCount(0);

    // The integrity card must NOT appear: both reads apply the same client predicate, so a task
    // outside this client's projects means the two filters disagree.
    await expect(page.getByText(/Tasks outside this client's projects/)).toHaveCount(0);
  });

  test("Projects holds the sections for the work, each filtered to this client (PV3-05)", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1/work");
    // The layout's PageHeader owns the page's one <h1>; the sections are <h2>.
    await expect(page.locator("h1")).toHaveCount(1);
    for (const name of ["Projects", "Deliverables", "Approvals", "Requests", "Meetings"]) {
      await expect(page.getByRole("heading", { name, level: 2, exact: true })).toBeVisible();
    }
    // Each assertion is scoped to its own section: the demo meeting shares the run's title, so an
    // unscoped lookup would match both.
    // Deliverables are read with ?clientId=: Northwind's are here, Cedar Group's (dl-3) are not.
    const deliverables = page.locator("#deliverables");
    await expect(deliverables.getByText("Homepage redesign")).toBeVisible();
    await expect(page.getByText("Q3 SEO audit report")).toHaveCount(0);
    // Approvals: this client's run, with its client-side gates (a pending scope sign-off).
    const approvals = page.locator("#approvals");
    await expect(approvals.getByRole("link", { name: "Northwind — site redesign kickoff" })).toBeVisible();
    await expect(approvals.getByText("Scope sign-off")).toBeVisible();
    await expect(page.getByText("Mobile app revamp — discovery")).toHaveCount(0);
    // Requests: the client's change requests with no project sit under "Not tied to a project".
    const requests = page.locator("#requests");
    await expect(requests.getByRole("heading", { name: "Not tied to a project" })).toBeVisible();
    await expect(requests.getByText("Add a wishlist to the product page")).toBeVisible();
    // Post reviews come from the overview's outstanding reviews.
    await expect(requests.getByText("Launch announcement")).toBeVisible();
  });

  test("meetings show on Projects and not on People (PV3-05)", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1/work");
    await expect(page.getByRole("heading", { name: /^Scheduled/, level: 3 })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Meetings/, level: 3 })).toBeVisible();

    await hubTab(page, /^People/).click();
    await expect(page).toHaveURL(/\/clients\/cl-1\/contacts$/);
    await expect(page.getByText("Client access")).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Scheduled/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /^Meetings/ })).toHaveCount(0);
  });

  test("the Internal tab carries a staff-only banner, and no other tab does (PV3-05)", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1");
    await hubTab(page, /^Internal/).click();
    await expect(page).toHaveURL(/\/clients\/cl-1\/notes$/);
    await expect(page.getByText(/Internal: never shown to the client/)).toBeVisible();
    await expect(hubTab(page, /^Internal/)).toHaveAttribute("aria-current", "page");
    // The staff-only style is a designed signal: assert it lands, not just that the class exists.
    await expect(page.locator(".ch-tab--internal")).toHaveCount(1);
    await expect(page.locator(".ch-tab--internal")).toHaveCSS("border-bottom-style", "solid");

    for (const path of ["/clients/cl-1", "/clients/cl-1/work", "/clients/cl-1/profile", "/clients/cl-1/contacts"]) {
      await page.goto(path);
      await expect(page.getByText(/Internal: never shown to the client/)).toHaveCount(0);
    }
  });

  // PV7-04b — the Reports tab (BFF §55.3). The demo store is per process and shared with the portal spec, so this publishes the
  // draft account summary (rep-3) and then withdraws that same one, leaving rep-1 and rep-2 (which the portal spec reads) alone.
  test("PV7-04b: the Reports tab publishes a draft after a confirm and withdraws it with a required reason", async ({ page }) => {
    const confirms: string[] = [];
    page.on("dialog", (d) => { confirms.push(d.message()); void d.accept(); });
    await openAsAgency(page, "/clients/cl-1");
    await hubTab(page, /^Reports$/).click();
    await expect(page).toHaveURL(/\/clients\/cl-1\/reports$/);
    await expect(hubTab(page, /^Reports$/)).toHaveAttribute("aria-current", "page");
    await expect(page.locator("h1")).toHaveCount(1);

    // Every status is listed; a published report says the client sees it, a draft does not.
    await expect(page.locator("#rep-1")).toContainText("Published");
    await expect(page.locator("#rep-1")).toContainText("Client sees this");
    await expect(page.locator("#rep-4")).toContainText("Withdrawn");
    await expect(page.locator("#rep-4")).toContainText("Reason (staff only): The ad spend figures were wrong");
    await expect(page.locator("#rep-4").getByRole("button")).toHaveCount(0);

    // A draft with no file is refused in words, not a code.
    const noFile = page.locator("#rep-7");
    await noFile.getByRole("button", { name: "Publish" }).click();
    await expect(noFile.getByRole("alert")).toContainText(/no file yet/i);
    await expect(noFile.getByRole("alert")).not.toContainText("report_has_no_file");

    // Publish the draft with a file.
    const draft = page.locator("#rep-3");
    await expect(draft).toContainText("Draft");
    await draft.getByRole("button", { name: "Publish" }).click();
    await expect(draft).toContainText("Published", { timeout: 15_000 });
    await expect(draft).toContainText("Client sees this");
    expect(confirms.some((m) => m.startsWith("Publish to the client?"))).toBe(true);

    // Withdraw it: the button waits for a reason.
    const withdraw = draft.getByRole("button", { name: "Withdraw" });
    await expect(withdraw).toBeDisabled();
    await draft.getByLabel(/Reason for withdrawing/).fill("Published by mistake in the test");
    await withdraw.click();
    await expect(draft).toContainText("Withdrawn", { timeout: 15_000 });
    await expect(draft).toContainText("Reason (staff only): Published by mistake in the test");
    await expect(draft.getByRole("button")).toHaveCount(0);
    expect(confirms.some((m) => m.startsWith("Withdraw this report"))).toBe(true);
  });

  // PV7-07 — the monthly account summary (BFF §56). The demo store is shared with the portal spec, so this publishes the summary and
  // then withdraws that same one, leaving the portal's Northwind reports as the portal spec reads them.
  test("PV7-07: drafts an account summary, edits its narrative, publishes it (the PDF is made then) and withdraws it", async ({ page }) => {
    const confirms: string[] = [];
    page.on("dialog", (d) => { confirms.push(d.message()); void d.accept(); });
    await openAsAgency(page, "/clients/cl-1/reports");
    await expect(page.locator("h1")).toHaveCount(1);

    // The control: a month picker that defaults to last month, and one button.
    const form = page.getByRole("form", { name: "Draft account summary" });
    await expect(form).toBeVisible();
    const month = form.getByLabel("Month");
    await expect(month).toHaveValue(/^\d{4}-\d{2}$/);
    await month.fill("2026-08");
    await form.getByRole("button", { name: "Draft account summary" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Draft made for August 2026" })).toBeVisible({ timeout: 15_000 });

    // The draft: its narrative editor and the frozen figures, no money anywhere, and no file yet (Publish makes it).
    const row = page.locator("li", { hasText: "Account summary, August 2026" });
    await expect(row).toContainText("Draft");
    await expect(row).toContainText("The PDF is made when you publish");
    await expect(row.getByRole("heading", { level: 3, name: "Projects" })).toBeVisible();
    await expect(row.getByRole("heading", { level: 3, name: "Completed in August 2026" })).toBeVisible();
    await expect(row).not.toContainText(/invoice|payment|conversion value|USD|IDR/i);

    // Edit the words and save: the source becomes "Written by staff".
    const narrative = row.getByLabel(/Narrative/);
    await narrative.fill("August in plain words: the design was approved and the audit delivered.");
    await expect(row.getByText("Unsaved changes. Save before you publish.")).toBeVisible();
    await row.getByRole("button", { name: "Save narrative" }).click();
    await expect(row.getByText("Saved.")).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText("Written by staff")).toBeVisible();

    // Publish: after the confirm the summary is published with a PDF and in front of the client.
    await row.getByRole("button", { name: "Publish" }).click();
    await expect(row).toContainText("Published", { timeout: 15_000 });
    await expect(row).toContainText("Client sees this");
    await expect(row.getByRole("link", { name: /PDF/ })).toBeVisible();
    expect(confirms.some((m) => m.startsWith("Publish to the client?"))).toBe(true);
    // Frozen: the editor is gone, the words stay.
    await expect(row.getByLabel(/Narrative/)).toHaveCount(0);
    await expect(row).toContainText("August in plain words");

    // Withdraw it again, so the portal's reports are as the portal spec expects.
    await row.getByLabel(/Reason for withdrawing/).fill("Removed after the summary test");
    await row.getByRole("button", { name: "Withdraw" }).click();
    await expect(row).toContainText("Withdrawn", { timeout: 15_000 });
  });

  test("a client with no outstanding items says so instead of rendering an empty box", async ({ page }) => {
    // cl-2 gets no ball items in the fixture — the empty state has to be a sentence, because a blank
    // card reads as a broken fetch.
    await openAsAgency(page, "/clients/cl-2");
    await expect(page.getByText("Nothing is waiting on us for this client.")).toBeVisible();
  });

  test("the Details tab still works after being moved under the hub", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1/details");
    await expect(page.getByText("Client access")).toBeVisible();
  });
});
