import { test, expect } from "@playwright/test";

// ASST-22 — the `@drawer` mount end to end, driven under DEMO_MODE (per `demoAssistant.ts`'s
// citation fixture, extended for this ticket with real demo ids: `p-web-1` -> "Client site
// redesign"). Covers the ticket's own DONE WHEN bullets: opens on any app page with a thread
// pinned to that page's context, promotion round-trips to `/assistant` with the SAME thread and
// its history, and focus moves into the drawer on open / back to the trigger on close.

test("FAB opens the drawer pinned to the current page's entity, sends a message, and promotes to the full page with the same thread + history", async ({ page }) => {
  await page.goto("/projects/p-web-1");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const fab = page.locator("#asst-fab-trigger");
  await expect(fab).toBeVisible();
  await fab.click();

  const dialog = page.getByRole("dialog", { name: "Assistant" });
  await expect(dialog).toBeVisible();
  // Focus moved INTO the drawer on open (the dialog container itself, per AssistantDrawer's own
  // "move focus into the panel" effect) — a keyboard user is not left behind on the page underneath.
  await expect(dialog).toBeFocused();

  // The page-context chip names the ACTUAL entity (resolved server-side through the same citation
  // endpoint the `@`-mention/citation chips use), not a generic placeholder.
  const chip = dialog.getByRole("button", { name: /Pinned: Client site redesign/ });
  await expect(chip).toBeVisible();

  const composer = dialog.getByLabel("Message the assistant");
  // The drawer auto-creates its page-pinned thread on mount (a real round trip) — the composer
  // stays disabled with a "Preparing…" placeholder until that finishes, exactly so a fast Enter
  // press can't silently no-op with no feedback (a real gap this test caught).
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill("What's the status?");
  await composer.press("Enter");

  // The FIRST message of a page-pinned thread carries the context preamble — sent AND displayed
  // identically (never hidden from the user who sent it). `.first()`: the demo reply echoes the
  // whole sent message back, so this exact text can legitimately appear a second time once the
  // reply starts streaming.
  await expect(dialog.getByText(/\[Context: Client site redesign \(erp:project:p-web-1\)\]/).first()).toBeVisible();
  // Demo-mode stream echoes the sent text back — proves the message actually reached the SAME
  // engine (useAssistantStream/streamReducer), not a second implementation. Waits for the LAST
  // line of the demo reply, not just the first ("You said:", visible from the very first token) —
  // promoting mid-stream would hard-navigate away and abort the in-flight generation (documented
  // in `AssistantWorkspace`'s own header), leaving the row permanently unfinished (`content: null`)
  // on reload. A real race this exact test caught on its first run.
  await expect(dialog.getByText(/Refreshing the page replays this exact transcript/)).toBeVisible({ timeout: 15_000 });

  const promote = dialog.getByRole("link", { name: /Open in full page/ });
  const href = await promote.getAttribute("href");
  expect(href).toMatch(/^\/assistant\?thread=/);
  const threadId = new URL(href!, "http://x").searchParams.get("thread");
  expect(threadId).toBeTruthy();

  // A hard navigation (the anchor is a plain `<a>`, not `next/link`) — the documented way to escape
  // an intercepting route. Lands on the untouched full page, same thread id.
  await promote.click();
  await page.waitForURL(new RegExp(`/assistant\\?thread=${threadId}`));
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Assistant");
  // The SAME thread's history survived the round trip — both turns are visible, loaded fresh from
  // the backend/demo store, never from anything the drawer component held in memory. `.first()`:
  // the demo reply echoes the ENTIRE sent message back, so the context preamble's exact text
  // legitimately appears twice (the user's own bubble, and quoted inside the assistant's) —
  // matching either occurrence is proof enough that the transcript round-tripped.
  await expect(page.getByText(/\[Context: Client site redesign \(erp:project:p-web-1\)\]/).first()).toBeVisible();
  await expect(page.getByText(/You said:/)).toBeVisible();
});

test("Escape closes the drawer and returns focus to the FAB trigger", async ({ page }) => {
  await page.goto("/tasks/t-4");
  const fab = page.locator("#asst-fab-trigger");
  await fab.click();
  await expect(page.getByRole("dialog", { name: "Assistant" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Assistant" })).toBeHidden();
  await expect(fab).toBeFocused();
});

test("the FAB is hidden on the /assistant page itself", async ({ page }) => {
  await page.goto("/assistant");
  await expect(page.locator("#asst-fab-trigger")).toHaveCount(0);
});

test("a page with no resolvable entity opens the drawer with no context pin", async ({ page }) => {
  await page.goto("/reports/company");
  const fab = page.locator("#asst-fab-trigger");
  await fab.click();
  const dialog = page.getByRole("dialog", { name: "Assistant" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Pinned:/ })).toHaveCount(0);
});
