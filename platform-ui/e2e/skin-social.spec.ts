import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { loginAsPlacedSocial } from "./personas";
import { tenantCookie } from "./appCookies";

// SCP-Kf (DW-D51, plan docs/plans/2026-10-15-social-content-pipeline.md §6, §8): the Social skin in a real browser, on a desktop and on a phone,
// and its axe sweep, light and dark.
//
// ── WHAT IT NEEDS ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Since SCP-Kg the skin is on for everyone in code (`SKINS_ON`), so this file runs on any server with no extra setting:
//
//     npx playwright test --project=social-skin
//
// ── WHO ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// `social@gaiada.com` is `u-social` (src/lib/demoFixtures.ts): a plain `member` of the agency, placed in Social Media (`dept-4`). It is the person the
// skin is drawn for. A page of another department (Web Dev, `dept-1`) is Standard: the skin follows the workspace.
//
// ── WHAT A GREEN RUN DOES NOT PROVE ───────────────────────────────────────────────────────────────────────────────────
// Same caveats as a11y-axe-workspaces.spec.ts: axe is a DOM-rule checker (about a third of what a manual audit finds), it scans the one state each
// test opens, and it says nothing of how a screen reader reads the page or whether a keyboard-only user can finish a task. The behaviour tests here cover
// focus (More returns it; the sheet returns it) as behaviour. `docs/a11y-manual-checklist.md` is the human pass.
//
// ── WHY ITS OWN PROJECT ───────────────────────────────────────────────────────────────────────────────────────────────
// The `social-skin` project: every test signs in itself and plants the tenant and prefs cookies, so NO stored session (a stale shared session would test
// the wrong person). Excluded from the default `chromium` project like the other workspace projects, and gated on sumopod, not in CI's smoke.
//
// ── THE JSON SUMMARY ──────────────────────────────────────────────────────────────────────────────────────────────────
// As a11y-axe-workspaces.spec.ts: each scan also writes its violations to `test-results/axe-social-skin/<test title>.json` (gitignored).


type Theme = "light" | "dark";
const OUT_DIR = "test-results/axe-social-skin";
const SOCIAL_HOME = "/departments/dept-4";
const WEB_DEV_HOME = "/departments/dept-1";
const TENANT = "co-agency";

// Copied from a11y-axe-workspaces.spec.ts (not imported: that file belongs to another session).
// A button is a plain control until React owns it; clicking earlier does nothing.
async function hydrated(loc: Locator) {
  await expect.poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")))).toBe(true);
}
async function press(loc: Locator) {
  await expect(loc).toBeVisible();
  await hydrated(loc);
  await loc.click();
}

/** The theme, the way lib/prefs.ts reads it (URL-encoded JSON). */
function prefsCookie(at: string, theme: Theme) {
  return { name: "gaiada_prefs", value: encodeURIComponent(JSON.stringify({ theme })), url: new URL("/", at).toString() };
}

async function signIn(page: Page, context: import("@playwright/test").BrowserContext, theme: Theme = "light", url = SOCIAL_HOME) {
  await loginAsPlacedSocial(page);
  await context.addCookies([tenantCookie(page.url(), TENANT), prefsCookie(page.url(), theme)]);
  await page.goto(url);
}

const frame = (page: Page) => page.locator(".erp-app");
const menu = (page: Page) => page.getByRole("navigation", { name: "Social Media menu" });
const bar = (page: Page) => page.getByRole("navigation", { name: "Bottom navigation" });
const sheet = (page: Page) => page.getByRole("dialog", { name: "More" });
/** The pinned entries' names, in order (each is a `.ws-pin` whose first span is its label). */
const pinNames = (page: Page) => menu(page).locator(".ws-pin").evaluateAll((els) => els.map((e) => e.querySelector(":scope > span")?.textContent?.trim()));

// ── Behaviour, desktop ────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("the Social skin on a desktop (1280x800)", () => {
  test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: "reduce" } });

  test("the frame and <html> wear the skin, and the menu is the pinned one, then More", async ({ page, context }) => {
    await signIn(page, context);
    await expect(frame(page)).toHaveAttribute("data-skin", "social");
    // <html> gets it from a client effect once the shell has hydrated.
    await expect(page.locator("html")).toHaveAttribute("data-skin", "social");
    await expect(menu(page)).toBeVisible();
    await expect.poll(() => pinNames(page)).toEqual(["Home", "Search", "Messages", "Notifications", "Tasks", "Create", "Calendar", "Reports", "Saved", "Profile", "AI Assistant", "More"]);
    await expect(menu(page).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    // The phone's parts are not drawn on a desktop.
    await expect(bar(page)).toBeHidden();
    await expect(page.locator(".erp-top__phone")).toBeHidden();
  });

  test("Search opens the command palette, and Escape closes it", async ({ page, context }) => {
    await signIn(page, context);
    await press(menu(page).getByRole("button", { name: "Search" }));
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole("combobox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  test("Create opens the New menu", async ({ page, context }) => {
    await signIn(page, context);
    await press(menu(page).getByRole("button", { name: "Create" }));
    const items = page.getByRole("menu").getByRole("menuitem");
    await expect(items.first()).toBeVisible();
    expect(await items.count()).toBeGreaterThan(1);
  });

  test("the top bar has no search field and no bell: the menu carries them", async ({ page, context }) => {
    await signIn(page, context);
    await expect(menu(page)).toBeVisible();
    const top = page.locator(".erp-top");
    await expect(top.getByRole("searchbox")).toBeHidden();
    await expect(top.getByRole("button", { name: /^Notifications/ })).toBeHidden();
    // The avatar menu moved into More; the access marks stay in the bar (an elevated person sees the chip, this one does not).
    await expect(top.locator(".erp-usermenu")).toBeHidden();
    // With nothing left to show, the bar is not drawn and the page starts at the top (visual review of 430: an empty 66px band).
    await expect(top).toBeHidden();
    expect((await page.locator("#main-content").boundingBox())!.y).toBeLessThan(10);
  });

  test("Find a page draws one focus ring, its box's, not a second one on the input inside it", async ({ page, context }) => {
    await signIn(page, context);
    await press(menu(page).getByRole("button", { name: /^More/ }));
    const find = page.getByRole("searchbox", { name: "Find a page" });
    await expect(find).toBeFocused();
    expect(await find.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
    expect(await page.locator(".ws-more__find").evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
  });

  test("More opens the panel with focus in Find a page; Escape closes it and focus returns to More", async ({ page, context }) => {
    await signIn(page, context);
    const more = menu(page).getByRole("button", { name: /^More/ });
    await press(more);
    await expect(sheet(page)).toBeVisible();
    const find = page.getByRole("searchbox", { name: "Find a page" });
    await expect(find).toBeFocused();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    // The menu is its icon rail while the panel is open.
    await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toBeHidden();
    await expect(more).toBeFocused();
    await expect(page.locator("html")).not.toHaveAttribute("data-sidebar", "collapsed");
  });

  test("Find a page filters the rows and the tabs as you type, and the account foot has Log out", async ({ page, context }) => {
    await signIn(page, context);
    await press(menu(page).getByRole("button", { name: /^More/ }));
    const panel = sheet(page);
    const rows = panel.locator("a[data-result]");
    const all = await rows.count();
    expect(all).toBeGreaterThan(5);
    await page.getByRole("searchbox", { name: "Find a page" }).fill("board");
    await expect.poll(() => rows.count()).toBeLessThan(all);
    expect(await rows.count()).toBeGreaterThan(0);
    await page.getByRole("searchbox", { name: "Find a page" }).fill("zzz-no-such-page");
    await expect(panel.getByText(/No pages match/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Log out" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Account settings" })).toBeVisible();
    await expect(panel.getByRole("button", { name: /^Switch workspace/ })).toBeVisible();
  });

  // SCP-Kg: the skin is on for Social Media, so these two take over, for the skin, what workspace-personas.spec.ts proves of the Standard menu
  // (that spec now runs the Social Media employee in the Standard look, their own choice).
  test("`/` lands on the Social Media home, and More's Switch workspace names it", async ({ page, context }) => {
    await loginAsPlacedSocial(page);
    await context.addCookies([tenantCookie(page.url(), TENANT)]);
    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`${SOCIAL_HOME}$`));
    await expect(frame(page)).toHaveAttribute("data-skin", "social");
    await press(menu(page).getByRole("button", { name: /^More/ }));
    await expect(sheet(page).getByRole("button", { name: /^Switch workspace/ })).toContainText("Social Media");
  });

  test("every link in the Social menu and the More panel opens: no 4xx, no 404 page, no error page", async ({ page, context }) => {
    test.setTimeout(240_000);
    await signIn(page, context);
    await press(menu(page).getByRole("button", { name: /^More/ }));
    await expect(sheet(page)).toBeVisible();
    // The pinned links, then every row and the account foot's links in More (the panel lists exactly the model's rows).
    const hrefs = await page.locator("nav[aria-label='Social Media menu'] a[href], .ws-more a[href]").evaluateAll((as) =>
      [...new Set(as.map((a) => a.getAttribute("href") ?? "").filter((h) => h.startsWith("/")))],
    );
    expect(hrefs.length).toBeGreaterThan(15);
    const failures: string[] = [];
    for (const href of hrefs) {
      try {
        const res = await page.goto(href);
        const status = res?.status() ?? 0;
        if (!res || status >= 400) failures.push(`${href}: status ${status || "none"}`);
        await page.waitForLoadState("networkidle");
        if ((await page.getByRole("heading", { name: /page not found/i }).count()) > 0) failures.push(`${href}: "Page not found" heading`);
        if ((await page.getByText(/something went wrong/i).count()) > 0) failures.push(`${href}: error boundary text`);
      } catch (e) {
        failures.push(`${href}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    expect(failures, `${hrefs.length} links walked`).toEqual([]);
  });

  // SCP-Q19 / PERMISSION §53.4: the Settings pin is for the four approvers only (the Social Media head, the GM, the owner, a platform admin).
  // Demo data: `social-head@` leads dept-4 (Social Media), `gm@` leads dept-5 (the GM unit); `social@` is a plain member.
  async function signInAs(page: Page, context: import("@playwright/test").BrowserContext, email: string) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    await context.addCookies([tenantCookie(page.url(), TENANT), prefsCookie(page.url(), "light")]);
    await page.goto(SOCIAL_HOME);
  }

  for (const [who, email] of [["the Social Media head", "social-head@gaiada.com"], ["the GM", "gm@gaiada.com"]] as const) {
    test(`${who} sees the Settings pin, and it opens`, async ({ page, context }) => {
      await signInAs(page, context, email);
      await expect(menu(page)).toBeVisible();
      await expect.poll(() => pinNames(page)).toContain("Settings");
      const link = menu(page).getByRole("link", { name: "Settings" });
      await expect(link).toHaveAttribute("href", `${SOCIAL_HOME}/settings`);
      const res = await page.goto(`${SOCIAL_HOME}/settings`);
      expect(res?.status() ?? 0).toBeLessThan(400);
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { name: /page not found/i })).toHaveCount(0);
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
      await expect(menu(page)).toBeVisible();
    });
  }

  test("a plain Social Media member does not see the Settings pin", async ({ page, context }) => {
    await signIn(page, context);
    await expect(menu(page)).toBeVisible();
    await expect.poll(async () => (await pinNames(page))[0]).toBe("Home");
    expect(await pinNames(page)).not.toContain("Settings");
    await expect(menu(page).getByRole("link", { name: "Settings" })).toHaveCount(0);
  });

  test("another department is Standard: no skin on the frame or <html>, and the Standard menu", async ({ page, context }) => {
    await signIn(page, context, "light", WEB_DEV_HOME);
    await expect(page.getByRole("navigation", { name: "Web Dev menu" })).toBeVisible();
    await expect(frame(page)).not.toHaveAttribute("data-skin", /.+/);
    await expect(page.locator("html")).not.toHaveAttribute("data-skin", /.+/);
    await expect(page.locator(".ws-pin")).toHaveCount(0);
    // Standard keeps the search field in the top bar.
    await expect(page.locator(".erp-top").getByRole("searchbox")).toBeVisible();
  });
});

// ── Behaviour, phone ──────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("the Social skin on a phone (390x844)", () => {
  test.use({ viewport: { width: 390, height: 844 }, contextOptions: { reducedMotion: "reduce" } });

  test("the bottom bar holds Home, Search, Create, Tasks and Profile, and the drawer is never offered", async ({ page, context }) => {
    await signIn(page, context);
    await expect(bar(page)).toBeVisible();
    const names = await bar(page).locator("a, button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    // Profile (SCP-1k) fills the fifth slot now that its page is built.
    expect(names).toEqual(["Home", "Search", "Create", "Tasks", "Profile"]);
    await expect(bar(page).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    // The bar sits on the bottom edge.
    const box = (await bar(page).boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(844);
    // No hamburger, and the sidebar is the off-canvas drawer, closed and hidden.
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeHidden();
    await expect(page.locator("#app-nav")).toBeHidden();
    await expect(page.locator("html")).not.toHaveAttribute("data-nav", "open");
  });

  test("Notifications, Messages and More are at the top, and the bar's Search and Create work", async ({ page, context }) => {
    await signIn(page, context);
    const top = page.locator(".erp-top__phone");
    await expect(top).toBeVisible();
    await expect(top.getByRole("link", { name: /^Notifications/ })).toBeVisible();
    await expect(top.getByRole("link", { name: "Messages" })).toHaveAttribute("href", /\/messages$/);
    await expect(top.getByRole("button", { name: "More" })).toBeVisible();
    const topBox = (await top.boundingBox())!;
    expect(topBox.y).toBeLessThan(80);
    // Top RIGHT, as the design draws them (visual review of 430: they sat at the left edge).
    expect(topBox.x + topBox.width).toBeGreaterThan(390 - 24);
    expect(topBox.x).toBeGreaterThan(390 / 2);
    await press(bar(page).getByRole("button", { name: "Search" }));
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.keyboard.press("Escape");
    await press(bar(page).getByRole("button", { name: "Create" }));
    await expect(page.getByRole("menu").getByRole("menuitem").first()).toBeVisible();
  });

  test("the top More opens a full-screen sheet with a Menu section; Escape returns focus to it", async ({ page, context }) => {
    await signIn(page, context);
    const more = page.locator(".erp-top__phone").getByRole("button", { name: "More" });
    await press(more);
    const panel = sheet(page);
    await expect(panel).toBeVisible();
    const box = (await panel.boundingBox())!;
    expect(Math.round(box.width)).toBe(390);
    expect(Math.round(box.height)).toBe(844);
    await expect(page.getByRole("searchbox", { name: "Find a page" })).toBeFocused();
    const menuGroup = panel.getByRole("group", { name: "Menu" });
    await expect(menuGroup).toBeVisible();
    for (const name of ["Calendar", "Reports", "Saved", "AI Assistant"]) await expect(menuGroup.getByRole("link", { name })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(more).toBeFocused();
  });

  test.describe("on a touch screen", () => {
    test.use({ hasTouch: true, isMobile: true });

    test("the sheet's theme options stay inside their outline at touch size", async ({ page, context }) => {
      await signIn(page, context);
      await press(page.locator(".erp-top__phone").getByRole("button", { name: "More" }));
      const panel = sheet(page);
      await expect(panel).toBeVisible();
      // Visual review of 430: the 44px touch targets spilled out of the control's fixed 36px outline.
      const group = (await panel.locator(".erp-theme").boundingBox())!;
      const opts = await panel.locator(".erp-theme__opt").all();
      expect(opts.length).toBeGreaterThan(1);
      for (const opt of opts) {
        const b = (await opt.boundingBox())!;
        expect(b.height).toBeGreaterThanOrEqual(44);
        expect(b.y).toBeGreaterThanOrEqual(group.y);
        expect(b.y + b.height).toBeLessThanOrEqual(group.y + group.height + 0.5);
      }
    });
  });

  test("nothing is hidden behind the bottom bar at the end of the page", async ({ page, context }) => {
    await signIn(page, context);
    await expect(bar(page)).toBeVisible();
    await page.locator("main").evaluate((el) => { el.scrollTo(0, el.scrollHeight); });
    const last = page.locator(".erp-main__inner > *").last();
    const lastBox = (await last.boundingBox())!;
    const barBox = (await bar(page).boundingBox())!;
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(barBox.y + 1);
  });
});

// ── The Home (SCP-1d): the design's feed ─────────────────────────────────────────────────────────────────────────────────

const HOME_SECTIONS = ["Client stories", "Your turn", "Waiting on others", "Your accounts this cycle", "Tasks given to you", "Reports due"];
const home = (page: Page) => page.getByTestId("social-home");
/** The Home streams in behind its own boundary: wait for it, so a scan or a count never sees the loading state. */
async function homeReady(page: Page) {
  await expect(home(page)).toBeVisible();
  for (const name of HOME_SECTIONS) await expect(home(page).getByRole("heading", { level: 2, name })).toBeVisible();
}

test.describe("the Social Home on a desktop (1280x800)", () => {
  test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: "reduce" } });

  test("lays out the six sections, and the officer's clients are circles that open the client's Profile", async ({ page, context }) => {
    await signIn(page, context);
    await homeReady(page);
    const stories = home(page).getByRole("list", { name: "Clients, with their schedule health" });
    const first = stories.getByRole("link").first();
    // The ring's meaning is written, not only coloured: the link's name carries the client and the state.
    await expect(first).toHaveAccessibleName(/\S+.*(On track|Tight|At risk|Late|Done|No cycle)/);
    await press(first);
    await expect(page).toHaveURL(/\/departments\/dept-4\/profile\/[^/?]+/);
  });

  test("Your turn: each card's main button is the server's next action, and the card opens the post drawer", async ({ page, context }) => {
    await signIn(page, context);
    await homeReady(page);
    const cards = home(page).getByRole("region", { name: "Your turn" }).getByRole("article");
    await expect(cards.first()).toBeVisible();
    // The seeded officer holds posts, and at least one next action is allowed: a solid button (or the link that opens its dialog).
    expect(await home(page).locator(".sh-card__act .lux-btn--solid").count()).toBeGreaterThan(0);
    // A refused one is a disabled button with its reason beside it, never colour alone.
    for (const off of await home(page).locator(".sh-card__act button[disabled]").all()) {
      await expect(off).toHaveAccessibleDescription(/\S/);
    }
    await press(cards.first().getByRole("heading", { level: 3 }).getByRole("link"));
    await expect(page.getByRole("dialog", { name: "Post" })).toBeVisible();
    await expect(page).toHaveURL(/\/departments\/dept-4\/posts\/[^/?]+/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Post" })).toBeHidden();
    await expect(page).toHaveURL(/\/departments\/dept-4\/?$/);
  });

  test("Your accounts this cycle and Reports due link to the Profile; Waiting on others links to Messages", async ({ page, context }) => {
    await signIn(page, context);
    await homeReady(page);
    const accounts = home(page).getByRole("region", { name: "Your accounts this cycle" });
    await expect(accounts.getByRole("link").first()).toHaveAttribute("href", /\/departments\/dept-4\/profile\/[^/?]+/);
    await expect(accounts.first()).toContainText(/ of \d+ posts/);
    const reports = home(page).getByRole("region", { name: "Reports due" });
    await expect(reports.getByRole("link").first()).toHaveAttribute("href", /\/profile\//);
    await expect(home(page).getByRole("region", { name: "Waiting on others" }).getByRole("link", { name: /Messages/ })).toHaveAttribute("href", "/departments/dept-4/messages");
  });

  test("a person who chose the Standard skin sees the Overview they always saw, with no feed", async ({ page, context }) => {
    await loginAsPlacedSocial(page);
    await context.addCookies([tenantCookie(page.url(), TENANT), { name: "gaiada_prefs", value: encodeURIComponent(JSON.stringify({ theme: "light", skin: "standard" })), url: new URL("/", page.url()).toString() }]);
    await page.goto(SOCIAL_HOME);
    await expect(frame(page)).not.toHaveAttribute("data-skin", /.+/);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(home(page)).toHaveCount(0);
  });
});

test.describe("the Social Home on a phone (390x844)", () => {
  test.use({ viewport: { width: 390, height: 844 }, contextOptions: { reducedMotion: "reduce" } });

  test("is one column: every section is there, nothing scrolls sideways, and the stories row is the only thing that does", async ({ page, context }) => {
    await signIn(page, context);
    await homeReady(page);
    await expect(bar(page)).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    // The side column sits under the feed, not beside it.
    const turn = (await home(page).getByRole("region", { name: "Your turn" }).boundingBox())!;
    const accounts = (await home(page).getByRole("region", { name: "Your accounts this cycle" }).boundingBox())!;
    expect(accounts.y).toBeGreaterThan(turn.y);
    expect(accounts.x).toBeLessThanOrEqual(turn.x + 1);
  });
});

// ── axe ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

function describeViolations(violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]): string {
  if (violations.length === 0) return "no violations";
  return violations
    .map((v) => {
      const targets = v.nodes.slice(0, 3).map((n) => `    - ${n.target.join(" ")}`).join("\n");
      return `[${v.impact ?? "n/a"}] ${v.id} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"}): ${v.help}\n${targets}\n    ${v.helpUrl}`;
    })
    .join("\n");
}

const safeName = (s: string) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

async function scan(page: Page, title: string) {
  await page.evaluate(() => document.fonts.ready);
  // The whole page, the same tags as a11y-axe-workspaces.spec.ts: NO `.exclude()` and NO `.disableRules()`.
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      `${OUT_DIR}/${safeName(title)}.json`,
      JSON.stringify(
        {
          title,
          url: page.url(),
          violations: results.violations.map((v) => ({
            id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, tags: v.tags.filter((t) => t.startsWith("wcag")),
            nodes: v.nodes.map((n) => ({ target: n.target, html: n.html.slice(0, 300), summary: n.failureSummary })),
          })),
        },
        null,
        2,
      ),
    );
  } catch {
    // The summary is a convenience; the assertion below is the test.
  }
  expect(results.violations, `axe violations on "${title}":\n${describeViolations(results.violations)}`).toEqual([]);
}

type Viewport = "desktop" | "phone";
interface Surface {
  name: string;
  /** Where the surface exists. */
  on: readonly Viewport[];
  /** Reaches the state to scan and waits for its positive landmark. */
  reach: (page: Page, viewport: Viewport) => Promise<void>;
}

const SURFACES: Surface[] = [
  {
    name: "Social Overview", on: ["desktop", "phone"],
    reach: async (page, viewport) => {
      // On a phone the menu is the closed drawer; the landmarks are the bottom bar and the top controls.
      if (viewport === "phone") {
        await expect(bar(page)).toBeVisible();
        await expect(page.locator(".erp-top__phone")).toBeVisible();
      } else {
        await expect(menu(page)).toBeVisible();
      }
      await expect(page.getByRole("main")).toBeVisible();
      // SCP-1d: the Home's feed streams in; scan it, not its loading state.
      await homeReady(page);
    },
  },
  {
    name: "More panel open", on: ["desktop"],
    reach: async (page) => {
      await press(menu(page).getByRole("button", { name: /^More/ }));
      await expect(sheet(page)).toBeVisible();
      await expect(page.getByRole("searchbox", { name: "Find a page" })).toBeFocused();
    },
  },
  {
    name: "Create menu open", on: ["desktop"],
    reach: async (page) => {
      await press(menu(page).getByRole("button", { name: "Create" }));
      await expect(page.getByRole("menu").getByRole("menuitem").first()).toBeVisible();
    },
  },
  {
    name: "phone sheet open", on: ["phone"],
    reach: async (page) => {
      await press(page.locator(".erp-top__phone").getByRole("button", { name: "More" }));
      await expect(sheet(page)).toBeVisible();
      await expect(sheet(page).getByRole("group", { name: "Menu" })).toBeVisible();
    },
  },
];

for (const viewport of ["desktop", "phone"] as const) {
  test.describe(`axe · ${viewport}`, () => {
    // Transitions would leave half-faded states (and so half-blended colours) under the scan.
    test.use({ contextOptions: { reducedMotion: "reduce" } });
    test.use({ viewport: viewport === "phone" ? { width: 390, height: 844 } : { width: 1280, height: 800 } });

    for (const surface of SURFACES) {
      if (!surface.on.includes(viewport)) continue;
      for (const theme of ["light", "dark"] as const) {
        const title = `${surface.name} · ${theme} · ${viewport}`;
        test(title, async ({ page, context }) => {
          await signIn(page, context, theme);
          await expect(frame(page)).toHaveAttribute("data-skin", "social");
          await surface.reach(page, viewport);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await scan(page, title);
        });
      }
    }
  });
}
