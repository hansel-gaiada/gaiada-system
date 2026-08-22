import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// A11Y-AUTO-01 — automated axe-core sweeps of the surfaces that recently gained hand-written a11y
// fixes (the two drawers' focus traps, the streaming `aria-live` containment on Message.tsx, the
// proposal card). `@axe-core/playwright` is a devDependency ONLY — see platform-ui/CLAUDE.md's
// four-runtime-dep rule; nothing here is imported by app code.
//
// ── WHAT THIS DOES NOT PROVE (read before trusting a green run) ────────────────────────────────
// axe-core is a static/DOM-rule checker. It catches missing accessible names, bad ARIA, role
// misuse, heading order, and colour contrast — industry estimates put its real-world coverage at
// roughly a THIRD of issues a manual audit would find. It cannot tell you:
//   - whether the streaming transcript actually announces once (not per token) to a real screen
//     reader — `aria-live="off"` on the live row is structurally correct per Message.test.tsx, but
//     "structurally correct" and "sounds right in NVDA" are different claims;
//   - whether focus lands somewhere USEFUL after an action, only whether the focused element has
//     an accessible name;
//   - reading order, verbosity, or whether a sighted-but-non-mouse user can actually complete a task.
// `docs/a11y-manual-checklist.md` is the scripted human pass for exactly those gaps. A green run
// of this file is evidence of "no regression in the ~30% axe covers", never "accessible".
//
// ── CI STATUS (deliberate) ──────────────────────────────────────────────────────────────────────
// This file runs in the default `chromium` project (authenticated via the shared `setup` session)
// and is NOT tagged `@smoke`. CI's build gate is `npx playwright test --project=smoke --grep
// @smoke` — this file does not run there and does not block a merge. See the a11y automation
// report for the reasoning (this suite is slower — several surfaces need a fresh SSE round trip —
// and less deterministic than the smoke check on a shared, often multi-agent-loaded box; treat it
// as an on-demand/CI-nightly audit, not a merge gate, until it has enough runs to trust the timing).
//
// ── THEMES ───────────────────────────────────────────────────────────────────────────────────────
// `colors.css` has a guarded 3-tier dark system (contrast differs by theme, and the two dark blocks
// must render identically) — every surface below runs once per theme via `pinTheme`, which writes
// the same `gaiada_prefs` cookie `lib/prefs.ts` already owns (no new mechanism).
//
// ── TRIAGE, NOT BLANKET SUPPRESSION ─────────────────────────────────────────────────────────────
// Any `.disableRules([...])` or `.exclude(...)` below carries a comment naming the rule id and why
// it is deferred rather than fixed. An unexplained disabled rule is how a11y debt goes invisible —
// see the report for the full list with owning surface.

type Theme = "light" | "dark";

async function pinTheme(page: Page, theme: Theme) {
  // Mirrors `smoke.spec.ts`'s own pattern (navigate once so `page.url()` has the right origin,
  // then add the cookie) — `gaiada_prefs` is read server-side in `app/layout.tsx` on every request,
  // so it just needs to exist before the navigation whose DOM we actually scan. Also pins
  // `gaiada_tenant` to `co-agency` (again mirroring `smoke.spec.ts`) — every demo fixture this file
  // exercises (`asst-thread-1`, project `p-web-1`, task `t-4`) lives under the agency tenant, and the
  // shared authed session's DEFAULT active company (falls back to `me.companies[0]`, per
  // `lib/tenant.ts`) is a DIFFERENT company. Without this, `/assistant`'s `listThreads(userId,
  // tenant)` silently returns zero items for the wrong tenant and `?thread=asst-thread-1` is ignored
  // as "not mine" — a real trap this file's own first run caught.
  await page.context().addCookies([
    {
      name: "gaiada_prefs",
      value: JSON.stringify({ density: "comfortable", width: "wide", theme, assistantRailCollapsed: false }),
      url: page.url(),
    },
    { name: "gaiada_tenant", value: "co-agency", url: page.url() },
  ]);
}

// A real hydration/timing gap `assistant-proposal-card.spec.ts` already documented in detail (its
// own header, section "Two real bugs surfaced while writing this spec") applies identically here:
// a scripted click/keypress can land on SSR-rendered markup before React attaches its handler and
// gets silently dropped. Reusing that spec's own `retryUntilVerified` helper rather than inventing
// a second timing workaround.
async function retryUntilVerified(act: () => Promise<void>, verify: () => Promise<unknown>, label: string, attempts = 8): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await act();
    } catch {
      // The interaction itself can throw — that IS the signal to retry, not a reason to give up.
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

async function clickNewChatVerified(page: Page) {
  const newChatBtn = page.getByRole("button", { name: "+ New chat" });
  const before = new URL(page.url()).searchParams.get("thread");
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

// ── DEFERRED, NOT FIXED HERE (triage, not blanket suppression) ─────────────────────────────────
// Every entry below is a PRE-EXISTING `color-contrast` (serious) finding on a surface this a11y
// program did not build, excluded by exact selector (never by disabling the rule wholesale) so any
// OTHER contrast regression on these same pages still fails the run. See the a11y automation report
// for the full writeup (measured ratios, root cause, suggested fix, owning surface).
const PRE_EXISTING_CONTRAST_EXCLUSIONS = [
  // `shell.css`: `.erp-side__tagline { opacity: 0.55 }` and `.erp-side__grouplabel { opacity: 0.4 }`
  // — raw CSS `opacity` on the sidebar tagline/nav-group labels, present on EVERY page (not specific
  // to the drawers/streaming/proposal-card surfaces this ticket covers). Measured as low as 3.21:1
  // in dark theme. Root cause: `opacity` composites against the page background a second time on
  // top of whatever ink token is already alpha-blended, which is exactly the "ad-hoc alpha instead
  // of a token" anti-pattern platform-ui/CLAUDE.md's own design-system rule 3 warns against. Fix
  // belongs in `shell.css` (replace `opacity` with a properly contrast-checked `--ink-*` tier) —
  // app-wide blast radius, so it needs its own ticket + visual review, not a silent change here.
  ".erp-side__tagline",
  ".erp-side__grouplabel",
  // `CompanyContext.tsx`'s `.erp-company` wrapper reuses the same `.type-eyebrow` class over the
  // same muted-on-chrome context — same root cause as the two selectors above.
  ".erp-company .type-eyebrow",
  // `TaskDetailView`/`TaskDrawer` section headers ("Tags", "Assignee", "Description", …) — a
  // NARROWER case of the same `.type-eyebrow` class, but here the failure is in the shared
  // `--ink-subtle` token itself, not an ad-hoc opacity: dark theme's `--ink-subtle: rgb(232 227 214
  // / 0.58)` measures 4.42:1 against the task-drawer surface — 0.08 short of the 4.5:1 the token's
  // own comment claims ("small caps labels"). A one-line alpha bump in the guarded dark-block pair
  // (`colors.css`) would likely fix EVERY `--ink-subtle` consumer app-wide at once, which is exactly
  // why it is deferred rather than nudged blind here — that blast radius needs its own visual pass,
  // not a number picked to make one axe run green.
  ".pm-sec__label.type-eyebrow",
  // PM tag chips (`Board.tsx` cards + the tag filter strip) render each tag's OWN user-chosen
  // swatch colour (`ColorSwatchPicker`) as both text and background — measured as low as 1.9:1 in
  // dark theme. This is a data-dependent palette problem (arbitrary per-tag colour vs. a fixed dark
  // background), not a token bug, and not a surface this program touched — a real fix needs either
  // a contrast-checked swatch palette or a text-shadow/outline treatment, which is a design
  // decision, not a one-line accessibility patch.
  ".pm-tag",
];

async function runAxe(page: Page) {
  let builder = new AxeBuilder({ page })
    // WCAG 2.0/2.1 A+AA is the bar the rest of the design-system guard tests (tokens.test.ts) are
    // already implicitly aiming at (4.5:1 text contrast etc.) — best-practice rules are excluded
    // because they flag style opinions (e.g. "region" landmarks on every div), not defects.
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  // One `.exclude()` CALL per selector, deliberately — `@axe-core/playwright` pushes each call's
  // argument as a single context entry, so passing the whole list as one array would be
  // (mis)interpreted as a single shadow-DOM/iframe descent chain (axe-core's `SerialSelector`
  // shape) instead of N independent exclusions.
  for (const selector of PRE_EXISTING_CONTRAST_EXCLUSIONS) builder = builder.exclude(selector);
  return builder.analyze();
}

function reportViolations(surface: string, results: Awaited<ReturnType<typeof runAxe>>) {
  if (results.violations.length > 0) {
    const lines = results.violations.map(
      (v) => `  [${v.impact}] ${v.id} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"}): ${v.help}\n` +
        v.nodes.slice(0, 3).map((n) => `      - ${n.target.join(" ")}`).join("\n"),
    );
    console.log(`\naxe violations — ${surface}:\n${lines.join("\n")}`);
  }
  return results.violations;
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`axe — ${theme} theme`, () => {
    test(`baseline dense page — project board (${theme})`, async ({ page }) => {
      await page.goto("/projects/p-web-1?view=board");
      await pinTheme(page, theme);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const results = await runAxe(page);
      const violations = reportViolations("project board (baseline)", results);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });

    test(`assistant — empty state (${theme})`, async ({ page }) => {
      await page.goto("/assistant");
      await pinTheme(page, theme);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Assistant");
      const results = await runAxe(page);
      const violations = reportViolations("assistant empty state", results);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });

    test(`assistant — active thread with history (${theme})`, async ({ page }) => {
      // asst-thread-1 is a seeded demo thread with a real user/assistant turn (demoAssistant.ts's
      // seedThreads/seedMessages) — an already-rendered transcript, not an empty composer.
      await page.goto("/assistant?thread=asst-thread-1");
      await pinTheme(page, theme);
      await page.reload();
      await expect(page.getByText("Draft a short client update for Northwind")).toBeVisible();
      const results = await runAxe(page);
      const violations = reportViolations("assistant active thread", results);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });

    test(`assistant — streaming state (${theme})`, async ({ page }) => {
      await page.goto("/assistant");
      await pinTheme(page, theme);
      await page.reload();
      await clickNewChatVerified(page);
      const composer = page.getByLabel("Message the assistant");
      await expect(composer).toBeEnabled({ timeout: 15_000 });
      // NOT STALL_TEST: `streamReducer` (lib/assistant.ts) only flips `status` to "streaming" on the
      // FIRST `token` event — STALL_TEST (by design, see demoAssistant.ts's own header) never emits
      // one, so `status` stays "idle" forever and `Message`'s `streaming` prop (hence `aria-live`)
      // never actually turns on. A real finding of this file's first run, not a pre-existing bug: the
      // demo hook proves the 120s-idle-timeout path, not a "frozen mid-stream" snapshot. A plain
      // message instead gets the real ~1.5s word-by-word demo reply (30ms/word, see
      // `demoAssistantStreamBody`), which is what actually exercises `aria-live="off"` on the live row
      // (`Message.test.tsx` pins the same attribute) — long enough a window to run axe against.
      await retryUntilVerified(
        () => composer.fill("Give me a project status update").then(() => composer.press("Enter")),
        () => expect(page.locator('.asst-msg--assistant[aria-live="off"]')).toBeVisible({ timeout: 6_000 }),
        "send a plain message",
      );
      const results = await runAxe(page);
      const violations = reportViolations("assistant streaming", results);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });

    test(`assistant — proposal card awaiting confirmation (${theme})`, async ({ page }) => {
      await page.goto("/assistant");
      await pinTheme(page, theme);
      await page.reload();
      await clickNewChatVerified(page);
      const toolsCheckbox = page.getByLabel("Use tools");
      await expect(toolsCheckbox).toBeEnabled({ timeout: 20_000 });
      await retryUntilVerified(
        () => toolsCheckbox.check({ timeout: 4_000 }),
        () => expect(toolsCheckbox).toBeChecked({ timeout: 4_000 }),
        "'Use tools' checkbox",
      );
      await page.getByLabel("Tool agent").selectOption("task-filer");
      const composer = page.getByLabel("Message the assistant");
      const card = page.locator(".asst-proposal");
      await retryUntilVerified(
        () => composer.fill("file a task for the redesign").then(() => composer.press("Enter")),
        () => expect(card).toHaveAttribute("data-state", "awaiting_confirmation", { timeout: 6_000 }),
        "send the tools-mode message",
      );
      const results = await runAxe(page);
      const violations = reportViolations("assistant proposal card", results);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });

    test(`assistant drawer, opened via the FAB (${theme})`, async ({ page }) => {
      await page.goto("/projects/p-web-1");
      await pinTheme(page, theme);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.locator("#asst-fab-trigger").click();
      const dialog = page.getByRole("dialog", { name: "Assistant" });
      await expect(dialog).toBeVisible();
      const results = await runAxe(page);
      const violations = reportViolations("assistant drawer", results);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });

    test(`PM task drawer, opened via a real client-side navigation (${theme})`, async ({ page }) => {
      // Direct page.goto("/tasks/t-4") renders the FULL page, not the drawer — `@drawer/(.)tasks`
      // only intercepts a client-side <Link> navigation from within the (app) shell (see
      // TaskDrawer.tsx's own header). Clicking a real board card is the same path a user takes.
      await page.goto("/projects/p-web-1?view=board");
      await pinTheme(page, theme);
      await page.reload();
      await page.locator(".pm-card", { hasText: "Wire homepage hero" }).click();
      const dialog = page.getByRole("dialog", { name: "Task detail" });
      await expect(dialog).toBeVisible();
      const results = await runAxe(page);
      const violations = reportViolations("PM task drawer", results);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });

    // ── Phase 5 additions (2026-08-22 department/portal/list sweep) ─────────────────────────────
    // The suite above only ever covered the drawers/streaming/proposal-card surfaces its own
    // ticket built. Phase 5's job is partly a broad RE-verification, so these three add the
    // archetypes Phase 5 actually touches: a bespoke department console (List/Dashboard mix, Web
    // Dev — the reference console), the client portal shell (its own separate interface, §2.6),
    // and a plain DataTable-backed List page. Same `chromium`-project shared staff session as
    // everything above — `/portal` does not redirect staff away (see `(portal)/portal/layout.tsx`'s
    // own header), so this exercises the portal's "not a contact" teach-state render, which is a
    // real surface a manager visiting their client's view will see.
    test(`department console — Web Dev home (${theme})`, async ({ page }) => {
      await page.goto("/departments/dept-1");
      await pinTheme(page, theme);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const results = await runAxe(page);
      const violations = reportViolations("department console — Web Dev home", results);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });

    test(`client portal — overview (${theme})`, async ({ page }) => {
      await page.goto("/portal");
      await pinTheme(page, theme);
      await page.reload();
      // The chrome (brand mark + tab strip) renders regardless of whether this identity is a
      // portal contact — asserting the tab strip, not a heading, keeps this robust either way.
      await expect(page.getByRole("navigation", { name: "Portal sections" })).toBeVisible();
      const results = await runAxe(page);
      const violations = reportViolations("client portal overview", results);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });

    test(`list page — projects DataTable (${theme})`, async ({ page }) => {
      await page.goto("/projects");
      await pinTheme(page, theme);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Projects");
      const results = await runAxe(page);
      const violations = reportViolations("list page — projects", results);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });
  });
}
