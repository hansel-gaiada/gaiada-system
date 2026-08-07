# `/assistant` UX fixes — report (2026-08-07)

Three owner-reported UX defects on `platform-ui`'s `/assistant` surface. All three fixed, verified
against `platform-ui/CLAUDE.md`'s constraints (plain CSS, four runtime deps, no colour literals in
component CSS, `DEMO_MODE=1 npm run build` as the real gate).

## 1. Empty state dumped the raw tool catalogue

**Before:** a brand-new chat rendered `CapabilityCards` inline — every registered tool
(`activity.feed`, `workActivity.relink`, …) with developer-facing prose, as the first thing anyone
saw.

**After:**
- `src/components/assistant/EmptyStateSuggestions.tsx` (new) — four curated, human-readable action
  tiles ("Ask about your projects", "Draft a task", "Check what's waiting on you", "Catch up on
  time entries") plus a fifth "See everything I can do" tile. Clicking a suggestion hands its full
  prompt text up to the composer via a new `prefill` mechanism — it fills the box and focuses it,
  it never auto-sends on the user's behalf.
- `src/components/assistant/ThreadView.tsx` — the empty state now renders
  `EmptyStateSuggestions` instead of `CapabilityCards`. The `<h2>Assistant</h2>` heading is kept
  (still the view's own label), but the heading-order reasoning from VER-03 no longer applies since
  nothing under it renders an `<h3>` anymore.
- `src/components/assistant/CapabilityCards.tsx` / `CapabilitiesPanel.tsx` — the raw catalogue is
  **relocated, not deleted**: it now renders only inside the existing toolbar "Capabilities"
  button's right-rail panel. Removed the now-dead `variant="empty-state"` prop/CSS
  (`.asst-cap-cards--empty-state`) since there is exactly one caller left.
- `src/components/assistant/Composer.tsx` — new optional `prefill?: {text, seq}` prop; an effect
  keyed on `seq` (not `text` alone, so the same tile can be clicked twice) sets the value and moves
  focus + cursor to the end, deferred one frame past the `setValue` so the DOM value has actually
  committed before `setSelectionRange` reads it.
- `src/components/assistant/AssistantWorkspace.tsx` — owns `composerPrefill` state and
  `openCapabilitiesPanel()` (open, not toggle — the empty-state tile should never *close* an
  already-open panel), wired to both `ThreadView` and `Composer`.

Verified live (DEMO_MODE, `demo-hansel@gaiada.com`): the empty state shows only the five
human-readable tiles; clicking "See everything I can do" opens the same Capabilities panel the
toolbar button opens, showing the full `agency.pendingApprovals` / `clients.list` / … catalogue —
confirmed present, just relocated. Screenshots taken in both light and dark theme; tokens render
correctly in both (no literal colours were added — CSS uses `var(--erp-hairline)`,
`var(--erp-accent)`, `var(--tint-hover)`, etc., matching `tokens.test.ts`'s guard).

## 2. Every thread in the sidebar reads "New chat"

**Decision: FE-derived title from the first user message, not a backend-generated summary.**

- **Why:** a backend summary would read nicer, but it costs an LLM call per thread AND a
  `platform-nest` schema/endpoint change. The FE-derived title is a pure reshape of text the UI
  already has the instant the first message is sent — no backend change, no extra latency, no
  extra cost. This ticket is scoped to `platform-ui` only.
- **Rejected alternative:** backend-generated summary title (nicer copy, but out of scope for a
  frontend-only fix and a real recurring cost/latency line — noted here so the owner can revisit if
  they want the nicer copy later).
- **Degradation:** `deriveThreadTitle(rawText)` (`src/lib/assistant.ts`) collapses whitespace,
  returns `null` for empty/whitespace-only input (a stalled thread with no real first message stays
  untitled and falls back to the existing "New chat" via `threadTitle`), and truncates long text on
  a word boundary with an ellipsis (falls back to a hard character cut only for a single
  pathologically long "word", e.g. a pasted URL).
- **Rename always wins:** `AssistantWorkspace.handleSend` only calls the derive-and-rename path
  when `messages.length === 0 && activeThread && !activeThread.title` — once a title exists
  (derived or explicit via the pencil icon), this never fires again on that thread.
- Reuses the **existing** `handleRename` (optimistic update + `renameThreadAction` + toast-and-
  reconcile on failure) — no new mutation path.

Verified live: sending a first message on a fresh thread immediately titles the rail row from the
message text (truncated); using the pencil icon afterward overwrites it, and the derived title
never reappears.

## 3. Sidebar not collapsible

- `src/components/assistant/ThreadRail.tsx` — new `collapsed`/`onToggleCollapsed` props. The
  collapse toggle (`«`/`»`, `aria-label` "Collapse/Expand sessions sidebar", `aria-expanded`
  reflecting the EXPANDED state, `aria-controls="asst-rail-body"`) is **always rendered**, in both
  states — a control that only reappears once you've found some other way to expand things fails
  the "stays keyboard-reachable" bar outright. When collapsed, the search box + session list
  genuinely unmount (not just visually hidden) and are replaced by a compact "New chat" icon button,
  so Tab never lands on an invisible row.
- `src/components/assistant/assistant.css` — `.asst-workspace--rail-collapsed` narrows the grid's
  first column to 46px (compound selector with `.asst-workspace--with-memory` so it wins regardless
  of class order); a mobile media-query addition shrinks the collapsed row height too. All new rules
  use existing semantic tokens only (`var(--erp-hairline)`, `var(--erp-accent)`, `var(--ink-subtle)`,
  etc.) — no colour literals, verified by `tokens.test.ts` passing.
- **Persistence** follows the app's existing pattern exactly: `src/lib/prefs.ts`'s `Prefs` gained
  `assistantRailCollapsed: boolean` (validated on read, defaults `false`) in the SAME
  `gaiada_prefs` cookie density/width/theme already use — no new storage invented.
  `src/lib/prefsActions.ts` (new) has one small `"use server"` action,
  `setAssistantRailCollapsedAction`, called fire-and-forget from `AssistantWorkspace`'s toggle
  handler (the client's own state is already authoritative for the current session; the cookie
  write is only for the next page load). `src/app/(app)/assistant/page.tsx` reads
  `getPrefs().assistantRailCollapsed` and passes it as `initialRailCollapsed`.
  `src/app/(app)/account/actions.ts`'s `savePrefs` now reads the current cookie first so saving
  density/width/theme from the Account page never stomps the collapse flag back to its default —
  `Prefs` gaining a required field would otherwise silently reset it every time someone touched
  Account settings.
- Page variant only — the `@drawer` intercepted route never renders `ThreadRail` at all (pre-
  existing `.asst-workspace--drawer .asst-rail { display: none; }`), so the drawer route doesn't
  even pass the new prop.

Verified live: collapse persists across a full page reload (cookie round-trip confirmed via
Playwright); the toggle is reachable and activatable purely by keyboard (`.focus()` + `Enter`
re-expands); both themes render correctly.

## Tests added

- `src/lib/assistant.test.ts` — 5 cases for `deriveThreadTitle` (short text verbatim, whitespace
  collapse, null on empty input, word-boundary truncation + ellipsis, single-long-word hard cut).
- `src/components/assistant/ThreadRail.test.tsx` (new) — 3 cases: expanded state shows
  search/list/new-chat button with `aria-expanded="true"`; collapsed state hides them but keeps the
  toggle (`aria-expanded="false"`) and a compact new-chat button; clicking the toggle calls the
  handler.
- `src/components/assistant/EmptyStateSuggestions.test.tsx` (new) — 3 cases: tiles are
  human-readable (no `namespace.tool`-shaped text), a suggestion click calls `onPick` with the full
  prompt (never `onOpenCapabilities`), and the "see everything" tile calls `onOpenCapabilities`
  (never `onPick`).
- `src/components/assistant/Composer.test.tsx` — 3 new cases for `prefill`: fills without sending,
  Send after a prefill sends exactly that text, and a second prefill with a new `seq` overwrites
  the box even when the text is identical (guards the exact bug the `seq` field exists to prevent).

No test file existed for `lib/prefs.ts` before this change and none was added — extending it would
have meant inventing a `next/headers` mocking pattern this codebase doesn't otherwise use; the new
`assistantRailCollapsed` field is a two-line boolean-narrowing branch already exercised end-to-end
by the live Playwright verification below.

## Live verification (real browser, not just unit tests)

Ran the app in `DEMO_MODE=1` on port 3010 (`npx next dev -p 3010`) and drove it with headless
Playwright (Python, via the `webapp-testing` skill) as `demo-hansel@gaiada.com`, in both light and
dark `color_scheme` contexts:

1. Empty state shows no raw tool-catalogue text on first paint; suggestion click fills the composer
   without sending; "See everything I can do" opens the same `#asst-capabilities-panel` the toolbar
   button opens, and that panel does show the full catalogue (`agency.pendingApprovals`,
   `clients.list`, `projects.list`, `tasks.list`) — confirming relocation, not deletion.
2. Sending a first message on a fresh thread titles the rail row from the message text; the pencil
   icon's manual rename overwrites the derived title.
3. Collapsing the rail shrinks it to the icon strip; reloading the page (`page.reload()`) keeps it
   collapsed (cookie persisted server-side); focusing the toggle via `.focus()` and pressing `Enter`
   (no click) re-expands it, confirming keyboard reachability.

Screenshots captured for both themes (empty state, capabilities panel, collapsed rail, auto-titled
thread) — all render with correct tokens, no colour-literal regressions, no layout breakage.

**No real screen reader (NVDA/VoiceOver/JAWS) was run.** The a11y verification here is: `aria-
expanded`/`aria-label`/`aria-controls` present and correct on the collapse toggle, DOM-level
mount/unmount (not `display:none`) for the collapsed rail's hidden content, keyboard-only
activation confirmed via Playwright's `.focus()` + `Enter` (not a mouse click), and confirmation
that `role="log"` transcript region and its implicit `aria-live="polite"` were not touched by any
of this work (no new content was added near it — the empty state, suggestions, and rail collapse
are all outside that region). Recommend a real screen-reader pass before this ships to end users.

## Gates

```
$ npx tsc --noEmit
(clean, no output)

$ npm test
Test Files  125 passed (125)
     Tests  1340 passed (1340)
(was 1326 before this work; +14 new: 5 deriveThreadTitle, 3 ThreadRail, 3 EmptyStateSuggestions, 3 Composer prefill)

$ DEMO_MODE=1 npm run build
✓ Compiled successfully in 10.0s
✓ Generating static pages (81/81)
(exit 0, no errors/warnings; /assistant and /(.)assistant [drawer intercept] both present in the route manifest)
```

**PASS** on all three required gates. Live Playwright verification above is DEV-VERIFIED (real
browser, demo backend), not a real screen reader.

## Files touched

- `platform-ui/src/lib/assistant.ts` — `deriveThreadTitle`
- `platform-ui/src/lib/assistant.test.ts` — its tests
- `platform-ui/src/lib/prefs.ts` — `assistantRailCollapsed` field
- `platform-ui/src/lib/prefsActions.ts` (new) — `setAssistantRailCollapsedAction`
- `platform-ui/src/app/(app)/assistant/page.tsx` — reads/passes `initialRailCollapsed`
- `platform-ui/src/app/(app)/account/actions.ts` — preserves the flag on unrelated prefs saves
- `platform-ui/src/components/assistant/AssistantWorkspace.tsx` — wiring for all three fixes
- `platform-ui/src/components/assistant/ThreadRail.tsx` + `.test.tsx` (new test file) — collapse UI
- `platform-ui/src/components/assistant/ThreadView.tsx` — empty state swap
- `platform-ui/src/components/assistant/EmptyStateSuggestions.tsx` + `.test.tsx` (both new)
- `platform-ui/src/components/assistant/Composer.tsx` + `.test.tsx` — `prefill` prop
- `platform-ui/src/components/assistant/CapabilityCards.tsx` — dropped dead `variant` prop
- `platform-ui/src/components/assistant/CapabilitiesPanel.tsx` — updated call site
- `platform-ui/src/components/assistant/assistant.css` — suggestions + rail-collapse CSS, dead
  empty-state CSS removed

No overlap with the PM Phase 4 session's dirty files (`pm.ts`, `demoPm.ts`, `pmVocabulary*`,
`pmUrgency*`, `UrgencyChip*`, `styles/tokens/pm.css`, `globals.css`, `tokens.test.ts`,
`departments.test.ts`) — confirmed via `git status` before finishing.
