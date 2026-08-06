import { test, expect } from "@playwright/test";

// ASST-23/T4 — FE-verification gap #1 (2026-08-06): the propose -> confirm -> executed flow was
// previously driven in a real browser only once, by a THROWAWAY Playwright script that was deleted
// after the run and never committed (see docs/superpowers/plans/2026-08-06-t4-proposal-card-report.md
// §9). That means there was no regression guard for it at all — a future change could silently break
// the composer's tools-mode affordance, the `confirm_required` SSE decode, the confirm action's real
// HTTP round trip, or the terminal card render, and nothing would fail. This file is that guard,
// committed to the suite.
//
// Runs in the `chromium` project (needs the stored owner session — `demo-hansel`, per
// `lib/demoIdentity.ts`'s mapping of the setup project's `hansel@gaiada.com` login — because the
// assistant is owner-only end to end and the seeded demo tenant/thread data assumes that identity).
// `anon`/`smoke`/`portal` all authenticate as someone else or not at all, so this can't run there.
//
// Card states are asserted primarily via `data-state` (ProposalCard's own `data-state={state}`,
// `lib/assistant.ts::ProposalCardState`) rather than label text alone — the state machine's real
// output, not a string that could drift independently of it. Each test starts its own "+ New chat"
// thread (never reuses a seeded one) so parallel workers sharing the same demo-mode server process
// never collide on state.
//
// Two real bugs surfaced while writing this spec, both worth recording since a future change could
// reintroduce either one silently:
//   1. `AssistantWorkspace.tsx`'s `loadThread` had no staleness guard — a slow `GET thread` for the
//      thread you just navigated AWAY from could resolve AFTER a newer switch and silently
//      overwrite the new thread's empty message list with the old one's. Fixed there via
//      `activeThreadIdRef` (a synchronously-updated mirror of `activeThreadId`, checked at resolve
//      time before any state mutation) — not a test-timing workaround.
//   2. A scripted interaction (a click on "+ New chat", or on the "Use tools" checkbox) can land on
//      the SSR-rendered element BEFORE React finishes hydrating and attaches its handler — the
//      interaction is then silently dropped (no thrown error from the app's side; Playwright itself
//      surfaces it, differently for each element: "+ New chat" just never produces any visible
//      effect, while a checkbox's own `.check()` throws "Clicking the checkbox did not change its
//      state" because Playwright can directly observe the DOM property not moving) so a single
//      fixed-delay interaction is not reliable here. `retryUntilVerified` below performs the
//      interaction, then checks a caller-supplied condition that can ONLY become true once the
//      interaction actually took effect, retrying the interaction itself (not just re-waiting) if it
//      didn't — the standard mitigation for a real hydration race, not evidence of an app bug (SSR +
//      client hydration inherently has this window, and it is measurably worse on this shared,
//      currently multi-agent-loaded box than it would be on a quiet one).
async function retryUntilVerified(act: () => Promise<void>, verify: () => Promise<unknown>, label: string, attempts = 8): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await act();
    } catch {
      // The interaction itself can throw (e.g. `.check()`'s own "did not change state" error) —
      // that IS the signal to retry, not a reason to give up.
    }
    try {
      await verify();
      return;
    } catch {
      // Verification didn't observe the effect within its own timeout — retry the interaction.
    }
  }
  throw new Error(`${label}: interaction never took effect after ${attempts} attempts`);
}

async function clickNewChatVerified(page: import("@playwright/test").Page) {
  const newChatBtn = page.getByRole("button", { name: "+ New chat" });
  const before = new URL(page.url()).searchParams.get("thread");
  // An earlier version of this verification checked "the conversation log is empty" instead, which
  // is AMBIGUOUS: `ThreadView` renders that exact same empty placeholder while `loadingThread` is
  // still true for the OLD (non-empty) thread's own initial fetch — so it could pass during a
  // transient loading flicker even when the click never took effect, only for the old thread's real
  // messages to render moments later. The URL's `?thread=` param is written synchronously inside
  // `handleNew` (`setUrlThreadParam`) and is a fresh, distinct string every time, so "it changed to
  // something new" cannot be satisfied by a loading flicker of the thread that was already active.
  await retryUntilVerified(
    () => newChatBtn.click(),
    () => page.waitForFunction(
      (prevId) => {
        const cur = new URL(window.location.href).searchParams.get("thread");
        return cur !== null && cur !== prevId;
      },
      before,
      { timeout: 4_000 },
    ),
    "'+ New chat'",
  );
}

async function startToolsTurn(page: import("@playwright/test").Page, message: string) {
  await page.goto("/assistant");
  await clickNewChatVerified(page);

  const toolsCheckbox = page.getByLabel("Use tools");
  // The composer self-fetches `toolAgents` on mount (a real round trip) and keeps the checkbox
  // disabled until that resolves — give it real headroom, same as the drawer spec's composer wait.
  await expect(toolsCheckbox).toBeEnabled({ timeout: 20_000 });
  await retryUntilVerified(
    () => toolsCheckbox.check({ timeout: 4_000 }),
    () => expect(toolsCheckbox).toBeChecked({ timeout: 4_000 }),
    "'Use tools' checkbox",
  );
  await page.getByLabel("Tool agent").selectOption("task-filer");

  const composer = page.getByLabel("Message the assistant");
  await composer.fill(message);
  await composer.press("Enter");
}

test.describe("proposal card — propose, confirm, and the real terminal states", () => {
  test("propose -> confirm -> executed: the composer affordance, SSE confirm_required decode, and confirm action, end to end", async ({ page }) => {
    await startToolsTurn(page, "file a task for the redesign");

    const card = page.locator(".asst-proposal");
    await expect(card).toHaveAttribute("data-state", "awaiting_confirmation", { timeout: 15_000 });
    await expect(card).toContainText("Awaiting your confirmation");
    // The redacted-args preview renders key names, never the real value.
    await expect(card).toContainText(/\[redacted:/);

    const confirmBtn = card.getByRole("button", { name: "Confirm write: pm.createTask — send for approval" });
    const dismissBtn = card.getByRole("button", { name: "Dismiss write: pm.createTask — do not send it" });
    await expect(confirmBtn).toBeVisible();
    await expect(dismissBtn).toBeVisible();

    await confirmBtn.click();

    await expect(card).toHaveAttribute("data-state", "executed", { timeout: 10_000 });
    await expect(card).toContainText("Approved and executed");
    // Terminal: no Confirm/Dismiss buttons remain (not merely disabled — see ProposalCard's header
    // on why a disabled button here would be a lie), and the approvals link is real.
    await expect(confirmBtn).toHaveCount(0);
    const approvalsLink = card.getByRole("link", { name: "View in Approvals →" });
    await expect(approvalsLink).toBeVisible();
    await expect(approvalsLink).toHaveAttribute("href", /^\/approvals\//);
  });

  test("confirm is keyboard-operable with an accessible name, and Dismiss is reachable the same way", async ({ page }) => {
    await startToolsTurn(page, "file a task for onboarding docs");

    const card = page.locator(".asst-proposal");
    await expect(card).toHaveAttribute("data-state", "awaiting_confirmation", { timeout: 15_000 });

    // Keyboard-only: focus the Dismiss button by its accessible name and activate with Enter — no
    // mouse click anywhere in this test. A real focus ring is the shared `lux-btn` global
    // `:focus-visible` style (ProposalCard invents no new focus style), so proving the button can be
    // reached and activated by keyboard is the meaningful, portable assertion here.
    const dismissBtn = card.getByRole("button", { name: "Dismiss write: pm.createTask — do not send it" });
    await dismissBtn.focus();
    await expect(dismissBtn).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(card).toHaveAttribute("data-state", "dismissed", { timeout: 10_000 });
    await expect(card).toContainText("Dismissed");
    await expect(card.getByRole("button")).toHaveCount(0);
  });

  // ── FE-verification gap #2 (2026-08-06): these three states were previously reachable ONLY via
  // `ProposalCard.test.tsx`'s constructed-props cases — the DEMO_MODE fixture always resolved
  // confirm straight to `executed`. `lib/demoAssistant.ts` now derives the outcome from a keyword in
  // the drafting message (mirroring the plain-chat `ERROR_TEST`/`STALL_TEST` convention), so each of
  // these is now driven through the SAME real click path as the `executed` case above, not asserted
  // against constructed props. ──────────────────────────────────────────────────────────────────────
  test("REJECT_TEST -> confirm renders the 'rejected' terminal card, with no Confirm/Dismiss left", async ({ page }) => {
    await startToolsTurn(page, "file a task REJECT_TEST for the redesign");
    const card = page.locator(".asst-proposal");
    await expect(card).toHaveAttribute("data-state", "awaiting_confirmation", { timeout: 15_000 });
    await card.getByRole("button", { name: /^Confirm write:/ }).click();
    await expect(card).toHaveAttribute("data-state", "rejected", { timeout: 10_000 });
    await expect(card).toContainText("Rejected");
    await expect(card.getByRole("button")).toHaveCount(0);
  });

  test("CANCEL_TEST -> confirm renders the 'cancelled' terminal card", async ({ page }) => {
    await startToolsTurn(page, "file a task CANCEL_TEST for the redesign");
    const card = page.locator(".asst-proposal");
    await expect(card).toHaveAttribute("data-state", "awaiting_confirmation", { timeout: 15_000 });
    await card.getByRole("button", { name: /^Confirm write:/ }).click();
    await expect(card).toHaveAttribute("data-state", "cancelled", { timeout: 10_000 });
    await expect(card).toContainText("Cancelled");
    await expect(card.getByRole("button")).toHaveCount(0);
  });

  test("FAIL_TEST -> confirm renders 'execution_failed' with the failure reason visible on the card", async ({ page }) => {
    await startToolsTurn(page, "file a task FAIL_TEST for the redesign");
    const card = page.locator(".asst-proposal");
    await expect(card).toHaveAttribute("data-state", "awaiting_confirmation", { timeout: 15_000 });
    await card.getByRole("button", { name: /^Confirm write:/ }).click();
    await expect(card).toHaveAttribute("data-state", "execution_failed", { timeout: 10_000 });
    await expect(card).toContainText("Approved — execution failed");
    // `role="alert"` — the one error surface ProposalCard renders for this state (its own §7's
    // "execution_failed" paragraph), never the generic red error banner Message.tsx suppresses for
    // proposal-shaped terminal frames.
    await expect(card.getByRole("alert")).toBeVisible();
    await expect(card.getByRole("button")).toHaveCount(0);
  });
});
