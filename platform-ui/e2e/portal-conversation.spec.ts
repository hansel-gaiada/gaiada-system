import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";

// PV4-08 — the client portal's Conversation, as a VIEWER-capability contact, against the STUBBED client conversation BFF
// (e2e/webdesk-stub/portal.mjs: FRONTEND-BFF-CONTRACT §29a), run by playwright.webdesk.config.ts:
//
//   npx playwright test -c playwright.webdesk.config.ts portal-conversation
//
// The app runs NOT in demo mode: its real `platformFetch`, session cookie, server components and server actions talk to the
// stub. Identity: viewer@northwind.example (Vera Viewer: a client contact WITHOUT a signing or editor grant). A viewer opens
// threads and replies (PV-D24), so everything below is done as one.
//
// What the stub can and cannot express (see its header): a staff reply is injected with `/__stub/staff-reply`; edit and retract
// are not stubbed (the demo-mode spec e2e/portal.spec.ts covers them). The refresh after the staff reply is nudged with the
// `visibilitychange` event PortalLive already listens for (a tab coming back to the foreground): the live stream and the 30 s
// poll are PortalLive's own, and waiting 30 s in a spec would only test the clock.

const STUB = `http://127.0.0.1:${process.env.WD_STUB_PORT || 3991}`;
const stub = {
  post: async (cmd: string, body: unknown = {}) => (await (await fetch(`${STUB}/__stub/${cmd}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as unknown,
  state: async () => (await stub.post("conversation-state")) as { messages: Array<{ authorId: string; authorSide: string; body: string }>; unreadThreads: number },
};
const VERA = "viewer@northwind.example";

async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/portal");
}

test.beforeEach(async () => { await stub.post("reset"); });

test("a viewer opens a thread, replies, and a staff reply appears after the refresh @portal", async ({ page }) => {
  await loginAs(page, VERA);

  // The list: General pinned, the project's thread below it. The Projects area has the Conversation sub-tab.
  await page.goto("/portal/conversation");
  await expect(page.getByRole("heading", { level: 3, name: "General" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Website relaunch" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: /Projects pages/ }).getByRole("link", { name: "Conversation" })).toBeVisible();

  await page.getByRole("link", { name: /Homepage copy/ }).click();
  const messages = page.getByRole("list", { name: /messages/i });
  await expect(messages.getByRole("listitem")).toHaveCount(1);
  await expect(messages.getByText("Can we change the homepage headline before Friday?")).toBeVisible();

  // The viewer replies. The composer is there for a viewer: nothing reads the signing capability.
  await page.getByLabel("Your reply").fill("Thanks, the new headline is: Built for Bali.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(messages.getByRole("listitem")).toHaveCount(2);
  await expect(messages.getByText("Built for Bali")).toBeVisible();
  await expect(page.getByLabel("Your reply")).toBeFocused();
  const afterSend = await stub.state();
  expect(afterSend.messages.at(-1)).toMatchObject({ authorId: "wd-client-v", authorSide: "client" });

  // A staff member answers. Nothing on the page changes until the refresh.
  await stub.post("staff-reply", { body: "Got it. It will be live by Thursday." });
  await expect(messages.getByRole("listitem")).toHaveCount(2);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(messages.getByText("It will be live by Thursday.")).toBeVisible({ timeout: 20_000 });
  await expect(messages.getByRole("listitem")).toHaveCount(3);

  // Only the NEW message is announced, politely, in the status region; the list itself is not a live region.
  await expect(page.locator('[aria-live="polite"]').filter({ hasText: "New message from Made Prabowo" })).toHaveCount(1);
  await expect(page.locator('[role="log"]')).toHaveCount(0);
  await expect(messages).not.toHaveAttribute("aria-live", /.*/);
});

test("the Projects badge counts a thread with an unread staff message, and opening the thread clears it @portal", async ({ page }) => {
  await stub.post("staff-reply", { body: "Quick question about the footer." });
  await loginAs(page, VERA);
  await page.goto("/portal/conversation");
  const projectsTab = page.getByRole("navigation", { name: "Portal sections" }).getByRole("link", { name: /^Projects/ });
  await expect(projectsTab.getByLabel("1 waiting for you")).toBeVisible();
  await expect(page.getByText("1 new")).toBeVisible();

  await page.getByRole("link", { name: /Homepage copy/ }).click();
  await expect(page.getByText("Quick question about the footer.")).toBeVisible();
  expect((await stub.state()).unreadThreads).toBe(0);
  await page.goto("/portal/conversation");
  await expect(projectsTab.getByLabel(/waiting for you/)).toHaveCount(0);
});

test("a thread outside the caller's scope is a 404 @portal", async ({ page }) => {
  await loginAs(page, VERA);
  const res = await page.goto("/portal/conversation/5a1c0000-0000-4000-8000-00000000ffff");
  expect(res?.status()).toBe(404);
});

test("the thread page has no axe violations @portal", async ({ page }) => {
  await loginAs(page, VERA);
  await page.goto("/portal/conversation/5a1c0000-0000-4000-8000-0000000000a1");
  await expect(page.getByLabel("Your reply")).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});
