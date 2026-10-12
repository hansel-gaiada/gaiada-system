import { test, expect, type Page } from "@playwright/test";
import { tenantCookie } from "./appCookies";

// PV3-08 — drives the hub's Contracts & billing area in a real browser, on DEMO_MODE fixtures.
//
// ── WHY LUMEN STUDIO (cl-3) ─────────────────────────────────────────────────────────────────────
// The demo billing store (lib/demoBilling.ts) is one in-memory object shared by every spec running against
// the same server, and this file CHANGES it (it sends, countersigns and confirms). client-hub.spec.ts reads
// Northwind's (cl-1) items by name and another spec asserts Cedar Group's (cl-2) empty state, so each of
// those must stay untouched. cl-3 is seeded for this file alone: a draft with terms, a sent contract the
// client has already signed (so it waits on OUR countersignature), and two pending payments, one recorded
// by the demo staff identity (the maker-checker case) and one by the client.
//
// The tests are serial and ORDER-DEPENDENT for that reason (the first reads the seed, the later ones spend
// it). A retry therefore sees a spent store; run the file fresh to re-seed.
test.describe.configure({ mode: "serial" });

// `gaiada_tenant` pinned to `co-agency` first, as in client-hub.spec.ts: the demo clients are global but
// their work is keyed by tenant.
async function openAsAgency(page: Page, path: string) {
  await page.goto("/");
  await page.context().addCookies([tenantCookie(page.url())]);
  await page.goto(path);
}

const CLIENT = "/clients/cl-3/billing";
const row = (page: Page, text: string) => page.getByRole("listitem").filter({ hasText: text });
const group = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 3, name });

test.describe("client billing", () => {
  test.beforeEach(({ page }) => {
    // Every Send / Void / Confirm asks first; accept them all.
    page.on("dialog", (d) => void d.accept());
  });

  test("the tab sits between Business and People, with a badge, and the page keeps one h1", async ({ page }) => {
    await openAsAgency(page, CLIENT);
    const tabs = page.getByRole("navigation", { name: "Client sections" }).getByRole("link");
    await expect(tabs.nth(2)).toHaveText(/^Business/);
    await expect(tabs.nth(3)).toHaveText(/^Contracts & billing/);
    await expect(tabs.nth(3)).toHaveAttribute("aria-current", "page");
    await expect(tabs.nth(4)).toHaveText(/^People/);
    // Two pending payments plus one contract waiting for our countersignature.
    await expect(tabs.nth(3)).toHaveText("Contracts & billing3");
    // The layout owns the one <h1> (the client's name); the page's sections are <h2>.
    await expect(page.locator("h1")).toHaveCount(1);
    for (const name of ["Contracts", "Payments to confirm", "Invoices"]) {
      await expect(page.getByRole("heading", { name, level: 2, exact: true })).toBeVisible();
    }
    // The four groups, in order, and no row is hidden by a missing one.
    for (const name of [/^Draft ·/, /^Sent ·/, /^Signed ·/, /^Void ·/]) await expect(group(page, name)).toBeVisible();
  });

  test("a client with no contracts or payments says so in a sentence, and Invoices is a list that links out", async ({ page }) => {
    // cl-2 (Cedar Group) has no billing rows in the fixture.
    await openAsAgency(page, "/clients/cl-2/billing");
    await expect(page.getByText(/No contract has been drafted for this client yet/)).toBeVisible();
    await expect(page.getByText(/No payment is waiting for confirmation/)).toBeVisible();
    await expect(page.getByText(/No invoice has been raised for this client/)).toBeVisible();
    await openAsAgency(page, "/clients/cl-1/billing");
    // Northwind's one invoice is listed and links to its own page (nothing deeper: D7 is open).
    await expect(page.getByRole("link", { name: /01 Jun 2026 to 30 Jun 2026/ })).toHaveAttribute("href", "/invoices/inv-1");
  });

  test("a draft with nothing to send shows a DISABLED Send with its reason", async ({ page }) => {
    await openAsAgency(page, CLIENT);
    await page.getByText("New draft contract").click();
    await page.getByLabel("Title", { exact: true }).fill("Lumen no-terms draft");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();
    const r = row(page, "Lumen no-terms draft");
    await expect(r.getByRole("button", { name: "Send to client" })).toBeDisabled();
    await expect(r.getByText(/Write the terms or attach a PDF before sending/)).toBeVisible();
  });

  test("draft, send, countersign: a draft with terms is sent, and a contract the client signed is countersigned", async ({ page }) => {
    await openAsAgency(page, CLIENT);
    await expect(group(page, /^Draft · 2/)).toBeVisible(); // the seeded draft and the no-terms one above

    // Send the seeded draft: it moves from Draft to Sent.
    await row(page, "Onboarding agreement").getByRole("button", { name: "Send to client" }).click();
    await expect(group(page, /^Sent · 2/)).toBeVisible();
    await expect(group(page, /^Draft · 1/)).toBeVisible();

    // Countersign is offered ONLY on the row the backend flagged: the sent contract the client already signed.
    // The sent contract that was just issued shows no such button.
    const retainer = row(page, "Retainer agreement");
    await expect(retainer.getByText(/The client has signed\. Waiting for our countersignature/)).toBeVisible();
    await expect(retainer.getByText(/Client: Lena Lumen, Director/)).toBeVisible();
    await expect(row(page, "Onboarding agreement").getByRole("button", { name: "Countersign" })).toHaveCount(0);
    await retainer.getByRole("button", { name: "Countersign" }).click();
    await expect(retainer.getByText(/once\s+both parties have signed/)).toBeVisible();
    await retainer.getByLabel("Your full name").fill("Hansel Owner");
    await retainer.getByLabel("Your title").fill("Director");
    await retainer.getByRole("button", { name: "Countersign" }).last().click();
    // Both parties have now signed, so it is Signed.
    await expect(group(page, /^Signed · 1/)).toBeVisible();
    await expect(group(page, /^Sent · 1/)).toBeVisible();
  });

  test("payments: confirm one; the recorder's own payment is refused in words", async ({ page }) => {
    await openAsAgency(page, CLIENT);
    // Reject is disabled with its reason until one is typed; Confirm needs none.
    const mine = row(page, "Cash");
    await expect(mine.getByRole("button", { name: "Reject" })).toBeDisabled();
    await expect(mine.getByText(/Say why you are rejecting this payment/)).toBeVisible();

    // The demo staff identity recorded the cash payment, so confirming it is refused with the full message.
    await mine.getByRole("button", { name: "Confirm payment" }).click();
    await expect(mine.getByRole("alert")).toContainText("You recorded this payment");
    await expect(mine).toBeVisible();

    // The client's own payment can be confirmed, and leaves the list.
    const theirs = row(page, "LUM-1");
    await theirs.getByRole("button", { name: "Confirm payment" }).click();
    await expect(row(page, "LUM-1")).toHaveCount(0);
    await expect(row(page, "Cash")).toBeVisible();
  });
});
