import { test, expect, type Page } from "@playwright/test";

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
  await page.context().addCookies([{ name: "gaiada_tenant", value: "co-agency", url: page.url() }]);
  await page.goto(path);
}

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

  test("tabs navigate and the Work tab groups tasks under this client's projects", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1");
    await page.getByRole("link", { name: /^Work/ }).click();
    await expect(page).toHaveURL(/\/clients\/cl-1\/work$/);

    // cl-1 owns "Client site redesign" in the demo fixture; cl-3 owns "Mobile app revamp". The
    // second assertion is the one that catches a broken facet — a filter that silently does nothing
    // renders every project here and still looks plausible.
    await expect(page.getByText("Client site redesign")).toBeVisible();
    await expect(page.getByText("Mobile app revamp")).toHaveCount(0);

    // The integrity card must NOT appear: both reads apply the same client predicate, so a task
    // outside this client's projects means the two filters disagree.
    await expect(page.getByText(/Tasks outside this client's projects/)).toHaveCount(0);
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
