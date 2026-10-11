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

  test("the hub's tabs are the portal's areas plus Internal (PV3-05)", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1");
    const tabs = page.getByRole("navigation", { name: "Client sections" }).getByRole("link");
    // Order matters: Overview · Projects · Business · People · Internal. The Overview and Projects tabs
    // carry count badges (their accessible name starts with the label), and Internal says "Staff only".
    await expect(tabs).toHaveCount(5);
    await expect(tabs.nth(0)).toHaveText(/^Overview/);
    await expect(tabs.nth(1)).toHaveText(/^Projects/);
    await expect(tabs.nth(2)).toHaveText(/^Business/);
    await expect(tabs.nth(3)).toHaveText(/^People/);
    await expect(tabs.nth(4)).toHaveText(/^InternalStaff only/);
    // Contracts & billing is NOT here yet (PV3-08 adds it with its page).
    await expect(hubTab(page, /Contracts/)).toHaveCount(0);
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
