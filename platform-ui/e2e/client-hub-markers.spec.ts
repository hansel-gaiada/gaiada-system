import { test, expect, type Locator, type Page } from "@playwright/test";
import { tenantCookie } from "./appCookies";

// PV3-09 — every row of the staff client hub says who sees it, from the backend's `clientVisible` only. The demo
// fixtures compute the flag by the backend's rule (src/lib/demoClientVisible.test.ts pins that). This pins the
// ticket's three named examples: a draft contract reads Internal, a sent one reads Client sees this, a task reads
// Internal. `cl-1` is Northwind Traders, the demo client with data on every area.
//
// The tenant cookie is load-bearing for the same reason as in client-hub.spec.ts (the fixtures live under co-agency).
async function openAsAgency(page: Page, path: string) {
  await page.goto("/");
  await page.context().addCookies([tenantCookie(page.url())]);
  await page.goto(path);
}

const marker = (scope: Locator, kind: "client" | "internal") => scope.locator(`[data-visibility="${kind}"]`);

test.describe("client hub · who sees each row (PV3-09)", () => {
  test("Contracts & billing: a draft contract reads Internal and a sent one reads Client sees this", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1/billing");
    const draft = page.locator("li.bl-contract", { hasText: "Master services agreement 2026" });
    await expect(draft).toBeVisible();
    await expect(draft.getByText("Internal", { exact: true })).toBeVisible();
    await expect(draft.getByText("Client sees this", { exact: true })).toHaveCount(0);

    const sent = page.locator("li.bl-contract", { hasText: "Statement of Work: redesign" });
    await expect(sent.getByText("Client sees this", { exact: true })).toBeVisible();
    await expect(sent.getByText("Internal", { exact: true })).toHaveCount(0);
  });

  test("Projects: a task reads Internal; a project and its deliverable read Client sees this; meetings are Internal", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1/work");
    // Every task row is Internal (the portal lists no tasks): the marker sits in the same cell as the task link.
    const taskCell = page.locator("#projects span", { has: page.locator("a[href^='/tasks/']") }).first();
    await expect(taskCell).toBeVisible();
    await expect(marker(taskCell, "internal")).toBeVisible();

    await expect(marker(page.locator("#projects"), "client").first()).toBeVisible();
    await expect(marker(page.locator("#deliverables"), "client").first()).toBeVisible();
    await expect(marker(page.locator("#meetings"), "internal").first()).toBeVisible();
  });

  test("Overview: the drafted agreement is Internal, the client-recorded payment is Client sees this", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1");
    const draftItem = page.locator(".ch-ball__item", { hasText: "Send a drafted agreement" }).first();
    await expect(marker(draftItem, "internal")).toBeVisible();
    const payment = page.locator(".ch-ball__item", { hasText: "Confirm a client-recorded payment" }).first();
    await expect(marker(payment, "client")).toBeVisible();
  });

  test("People: contact rows carry the marker", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1/contacts");
    await expect(marker(page.locator("main"), "client").first()).toBeVisible();
  });

  test("Business says the client sees and edits this profile; Internal keeps its banner", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1/profile");
    await expect(page.getByText("The client sees and edits this profile.")).toBeVisible();
    await openAsAgency(page, "/clients/cl-1/notes");
    await expect(page.getByText(/Internal: never shown to the client/)).toBeVisible();
  });
});
