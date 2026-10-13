import { test, expect, type Page } from "@playwright/test";
import { tenantCookie } from "./appCookies";

// PV4-09 — the staff conversation in the client hub, driven in a real browser over the DEMO fixtures
// (src/lib/demoConversation.ts, the stubbed BFF: no backend, no database). It runs in PV4-10's gate, not in CI.
//
// ⚠ Like client-hub.spec.ts, every test pins `gaiada_tenant` to `co-agency`: the demo client `cl-1` (Northwind
// Traders) and its project live under that company, and the shared session defaults to another one.
//
// The demo store is shared by every test in the run, and one test here MUTATES it (sending Atlas's draft, sharing
// the kickoff minutes). Each mutating flow therefore asserts the state it needs first and runs once; nothing else in
// this file depends on that draft still being pending.
//
// WHAT THE STUB CANNOT EXPRESS: it has no second user, so "the client replies while the page is open" (the 20 s
// poll picking up a new client message) is covered by the unit tests (ThreadView.test.tsx with fake timers), not here.
// It also does not exercise the 409 refusals, which the platform's own HTTP suite covers (conversation.controller.test.ts).
// Messages are permanent (PV-D34): there is no edit or remove control to drive.
async function openAsAgency(page: Page, path: string) {
  await page.goto("/");
  await page.context().addCookies([tenantCookie(page.url())]);
  await page.goto(path);
}

const THREAD = "/clients/cl-1/work/conversation/cv-thread-1";

test.describe("client hub conversation", () => {
  test("the Projects tab has a Conversation section listing threads, awaiting our reply first", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1/work");
    const section = page.locator("#conversation");
    await expect(section.getByRole("heading", { name: "Conversation", level: 2, exact: true })).toBeVisible();
    const items = section.getByRole("list", { name: "Conversations" }).getByRole("listitem");
    await expect(items.first()).toContainText("Homepage hero copy");
    await expect(items.first()).toContainText("Client sees this");
    // "Start a conversation" is offered, on a project or in General
    await expect(section.getByRole("heading", { name: /Start a conversation with Northwind Traders/ })).toBeVisible();
    await expect(section.getByLabel("About")).toBeVisible();
  });

  test("open a thread, send an agent's draft after the confirm, and see it as a message with the sender's name", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1/work");
    await page.locator("#conversation").getByRole("link", { name: "Homepage hero copy" }).click();
    await expect(page).toHaveURL(/\/work\/conversation\/cv-thread-1$/);
    // the Projects tab stays lit under /work/conversation/
    await expect(page.getByRole("navigation", { name: "Client sections" }).getByRole("link", { name: /^Projects/ })).toHaveAttribute("aria-current", "page");

    // messages oldest first, each marked from the backend field
    const messages = page.getByRole("list", { name: /Messages, oldest first/ }).getByRole("listitem");
    await expect(messages.first()).toContainText("Dana Whitfield");
    await expect(messages.first()).toContainText("Client sees this");
    await expect(page.getByRole("link", { name: "hero-v2-brief.pdf" })).toHaveAttribute("href", "/api/files/cv-file-1");

    // the draft is a distinct Internal card, not a message
    const card = page.getByRole("article", { name: /Draft by Atlas, not sent/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Drafted by Atlas. Not sent");
    await expect(card).toContainText("Internal");

    // Send asks first, and names the client
    await card.getByRole("button", { name: "Send" }).click();
    const dialog = page.getByRole("dialog", { name: /Send this reply to Northwind Traders\?/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Send to Northwind Traders" }).click();

    // the draft card is gone; the message is authored by the person who sent it, with the agent credited to staff
    await expect(card).toHaveCount(0);
    const sent = page.locator('[data-side="staff"]').filter({ hasText: "the new hero image is in" });
    await expect(sent).toBeVisible();
    await expect(sent).toContainText("Clement Hansel");
    await expect(sent).toContainText("Drafted by Atlas (shown to staff only)");
    await expect(sent).toBeFocused();
  });

  test("a reply is sent as plain text: markup stays literal", async ({ page }) => {
    await openAsAgency(page, "/clients/cl-1/work/conversation/cv-thread-2");
    const box = page.getByLabel("Reply to the client");
    await expect(page.getByText("Prices and terms change only through a signed contract or amendment.")).toBeVisible();
    await box.fill('<img src=x onerror="document.title=\'pwned\'"> thanks');
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.getByText('<img src=x onerror="document.title=\'pwned\'"> thanks')).toBeVisible();
    expect(await page.title()).not.toBe("pwned");
    await expect(page.locator(".cv-msg__body img")).toHaveCount(0);
    await expect(box).toBeFocused();
  });

  test("Overview shows the awaiting-reply count, and one Waiting on us item per such thread", async ({ page }) => {
    // Whether Atlas's draft was already sent by the test above (which answers the thread) is not this test's business:
    // the tile and the list are both read from the same backend count, so they must agree whatever it is.
    await openAsAgency(page, "/clients/cl-1");
    const tile = page.locator(".lux-kpi").filter({ hasText: "Awaiting our reply" });
    await expect(tile).toBeVisible();
    const value = Number((await tile.locator(".lux-kpi__value").innerText()).trim());
    const items = await page.getByRole("link", { name: /A client message is waiting for our reply/ }).count();
    expect(items).toBe(value);
  });
});

test.describe("meeting minutes", () => {
  test("write a draft, share it with the client after the confirm, then it is frozen", async ({ page }) => {
    await openAsAgency(page, "/meetings/rec-demo-1");
    const editor = page.getByLabel("Minutes", { exact: true });
    await editor.fill("Decisions: ship the homepage on Friday.");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText(/The client can't see it yet/)).toBeVisible();

    await page.getByRole("button", { name: "Share with client" }).click();
    const dialog = page.getByRole("dialog", { name: /Share these minutes with Northwind Traders\?/ });
    await expect(dialog).toContainText("can't be edited or taken back");
    await dialog.getByRole("button", { name: "Share with Northwind Traders" }).click();

    await expect(page.getByText(/Shared on .* by Clement Hansel/)).toBeVisible();
    await expect(editor).toHaveAttribute("readonly", "");
    await expect(page.getByRole("button", { name: "Share with client" })).toHaveCount(0);
  });

  test("a meeting with no client has no Share control", async ({ page }) => {
    await openAsAgency(page, "/meetings/rec-demo-4");
    await expect(page.getByLabel("Minutes", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Share with client" })).toHaveCount(0);
  });
});
