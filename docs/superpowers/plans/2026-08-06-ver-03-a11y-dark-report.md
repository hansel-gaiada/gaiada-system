# VER-03 — assistant surface a11y + dark-theme-token audit

**Status:** DEV-VERIFIED (code-level). No screen reader was used — see "What is unverified" below.
**Scope:** `platform-ui/src/app/(app)/assistant/**`, `.../@drawer/(.)assistant/**`,
`platform-ui/src/components/assistant/**`, `platform-ui/src/components/shell/AssistantFab.tsx` +
`assistant-fab.css`, `platform-ui/src/components/shell/nav.ts` (read-only check).
**Out of scope, respected:** the `docs/ui-work-split.md` three-lane split (Lane A/B/C own the
*existing* surfaces listed there). The assistant surface postdates that document and isn't owned by
any lane, so it's this ticket's alone — nothing in Lane A/B/C's files was touched, and the one
shared file read (`src/styles/tokens/colors.css`) was read-only, not edited.

## Starting condition (measured, not assumed)

Before touching anything I read every file under `components/assistant/`, `lib/assistant*.ts`, both
`page.tsx`/`page.tsx` (drawer) routes, `AssistantFab.tsx`, and `nav.ts`, then cross-checked against
`src/styles/tokens/colors.css` and `platform-ui/CLAUDE.md`'s design-system section.

Two things changed the shape of this ticket from what the brief expected:

1. **Dark theme is NOT a platform-wide gap anymore.** `colors.css` already has a real 3-tier system
   with a complete, byte-identical `prefers-color-scheme`/`data-theme="dark"` pair (enforced by
   `src/styles/tokens.test.ts`). The "known gap: no dark theme" note in memory refers to the **PM
   console** (`pm.css`), not the app-wide token system. This must have landed between when that
   memory note was written and now.
2. **The assistant surface was already built almost entirely on semantic tokens.** Every `.css` file
   under `components/assistant/` and `components/shell/assistant-fab.css` uses `var(--erp-*)` /
   `var(--surface-*)` / `var(--status-*)` etc. exclusively — I found **zero raw hex/rgb literals** on
   this surface. `tokens.test.ts`'s guard (no color literal in component CSS) already covers it and
   was passing before I touched anything.

So this was not the "133 hardcoded colors → tokens" mechanical pass the ticket brief anticipated —
the code was written with the token system already in place. The real work was the a11y half, plus
a few concrete regressions/gaps I found by reading the actual streaming/focus code paths.

## What I fixed

### 1. Screen-reader spam on the streaming row (the ticket's own named risk, just not via `assertive`)

**File:** `platform-ui/src/components/assistant/Message.tsx`

The brief specifically warned about an over-eager `aria-live="assertive"` spamming every token.
Nothing here used `assertive` — but the bug exists anyway, via a subtler path:

- `ThreadView.tsx`'s `.asst-thread` container is `role="log"`, whose **implicit** `aria-live` value
  is `"polite"` (per the ARIA spec's live-region-role table). That is a deliberate, correct choice
  for a chat transcript — new messages SHOULD be announced.
- `useTypewriter` (`useAssistantStream.ts`) mutates the streaming row's text node every **16ms**
  (`REVEAL_TICK_MS`), 3 characters at a time, for the entire duration of a reply.
- A DOM mutation inside a live region is exactly what gets queued for announcement — not just
  additions of new content. So the currently-streaming row's own repeated text updates were fair
  game for a screen reader to read out incrementally, which is precisely the "spam every token"
  failure mode, just triggered by an implicit-polite role rather than an explicit assertive one.

**Fix:** `Message.tsx`'s outer `<article>` now sets `aria-live={streaming ? "off" : undefined}`.
`aria-live` is re-evaluated per subtree, so this takes **only the one row currently streaming in
this tab** out of the log's liveness for the duration of the stream — every other row (a new user
message, a new assistant placeholder, a reply finishing in a different thread's log) is still
announced normally by the ancestor `role="log"`.

**The judgement call, stated explicitly:** the finished reply's full text is never itself read aloud
automatically — before or after this fix. `StreamIndicator.tsx` (pre-existing, already correct) is
the ONE dedicated `role="status" aria-live="polite"` region that announces the coarse
thinking → responding → finished/stopped/error transitions. A screen-reader user is told "the
assistant finished responding" and can then read the reply like any other content, the same way a
sighted user would read it rather than have it read TO them. I considered making the row announce
its own final text once (flip `aria-live` back to `"polite"` on completion, which the code already
does naturally once `streaming` goes false), but did not add anything to force a second, immediate
full-text announcement on top of the "finished" status line — that would just relocate the "too much
at once" problem from token-granularity to whole-message-granularity, and duplicates
`StreamIndicator`'s job. This mirrors the design the code's own pre-existing comments already stated
intent for; I made the intent actually hold under mutation, I didn't invent a new intent.

**One acknowledged, minor, cosmetic residue (not a regression from this fix — it already existed):**
there's a brief window between a stream reaching `done` (which flips `aria-live` back on for that
row) and `AssistantWorkspace`'s subsequent `loadThread()` refetch resolving, during which the row
briefly shows its pre-fetch placeholder content. In principle a screen reader could announce that
placeholder and then announce the real content moments later. This existed before my change (it's a
timing property of the refetch-after-stream design, not of `aria-live`) and is small enough that
adding more state to suppress it would cost more complexity than it's worth — flagging it rather
than silently accepting it.

Test added: `Message.test.tsx` — asserts `aria-live="off"` while `streaming`, absent otherwise.

### 2. Heading order: h1 → h3 with no h2, on a brand-new user's first load

**File:** `platform-ui/src/components/assistant/ThreadView.tsx`

`CapabilityCards.tsx` renders its category titles as `<h3>` (used both in the empty-state and inside
`CapabilitiesPanel`). The page's own `<h1>Assistant</h1>` is in `page.tsx`. The only thing that
reliably puts an `<h2>` in between, on the actual DOM-order-flattened heading list a screen reader's
heading-navigation command produces, is `ThreadRail`'s `<h2>` group labels ("Pinned", "Today", …) —
and those **only exist once at least one thread exists** (`grouped.pinned`/`grouped.groups` are
empty otherwise; see `ThreadRail.tsx`'s `filterThreads`/`groupThreads`). So a genuinely new user, on
their very first visit to `/assistant` with zero threads, sees a page whose flattened heading order
is `h1 → h3` — a skipped level, on exactly the run that most needs to be legible (first-run
discoverability is the whole point of the empty-state capability cards per the blueprint).

**Fix:** the empty state's "Assistant" label — previously a plain `<p className="type-eyebrow">` —
is now an `<h2>` with the same classes/inline styling (visually unchanged; `margin: 0 0 8px` added
explicitly so the heading's own UA-stylesheet margin doesn't reintroduce a visual diff). This
guarantees `h1 → h2 → h3` regardless of the rail's state.

Test added: `ThreadView.test.tsx` — asserts the empty state exposes a real `level: 2` heading named
"Assistant", and that it's absent once real messages exist (the rail's own h2s take over at that
point, unexercised by this narrow test but covered by `ThreadRail`'s own existing behavior).

### 3. A weaker focus ring than the rest of the app, on one control

**File:** `platform-ui/src/components/assistant/assistant.css`

`.asst-brain-picker__select:focus-visible` was `{ outline: none; border-color: var(--erp-accent); }`
— it explicitly removed the global 2px focus ring (`globals.css`'s `:focus-visible { outline: 2px
solid var(--accent); outline-offset: 2px; }`) and substituted only a thin border-color swap. I
checked whether this is the app's established convention for `<select>` elements specifically (it IS
the convention for underline-style text inputs — see the "found but left" section below) and it is
**not**: `pm.css`'s `.pm-statussel__select:focus-visible` keeps a real `outline: 2px solid
var(--erp-accent); outline-offset: 1px;`. The brain picker was the one outlier.

**Fix:** restored the same `outline: 2px solid var(--erp-accent); outline-offset: 1px;` alongside the
existing border-color change, matching `pm-statussel__select` exactly.

Not independently unit-tested (a CSS-only, one-line change verified by direct comparison against the
sibling convention it now matches) — covered by the visual/keyboard pass note below instead.

### 4. The drawer had no actual keyboard focus trap

**File:** `platform-ui/src/components/assistant/AssistantDrawer.tsx`

The ticket's own bar: "the drawer (focus trap + Escape + focus restore on close)". Escape-to-close
and focus-restore-to-FAB-on-close were already there (and well-reasoned — see the file's existing
header comment on why focus-restore lives in an effect cleanup). What was missing is the actual
**trap**: nothing stopped Tab/Shift+Tab from walking off the panel's last/first focusable element
onto the app shell BEHIND the scrim. `aria-modal="true"` tells a screen reader's own browse-mode
navigation to treat the rest of the page as inert, but it does **nothing** for a sighted
keyboard-only user's physical Tab key — the sidebar, top bar, and underlying page are all still real,
focusable DOM sitting right next to the drawer in the tree (Next's intercepting-route drawers render
as an overlay, not a removal of what's underneath).

**Fix:** the drawer's existing `keydown` listener now also handles `Tab`: it re-queries the panel's
focusable descendants on every press (not cached — the panel's content is the live
`AssistantWorkspace` tree, whose focusable set changes constantly as threads rename, panels
open/close, the composer disables mid-send), and wraps `Shift+Tab` from the first element (or from
the panel's own initial post-open focus) to the last, and `Tab` from the last back to the first.

**Deliberately excluded from the trap:** the scrim `<button>` (the click-outside-to-close backdrop).
It sits outside the panel in the DOM and is now unreachable by Tab while the drawer is open. This is
the standard, defensible pattern (e.g. Radix's Dialog overlay is pointer-only, not a tab stop) — the
panel's own "Close ✕" button provides the identical keyboard-accessible close action with the same
accessible name ("Close assistant"), so nothing is lost, and a backdrop that IS a tab stop is itself
a mildly confusing target (a large invisible rectangle with no visible label at the point of focus).

**Found, not fixed — explicitly flagged instead:** `components/pm/TaskDrawer.tsx` is the sibling
component this file's own header says it mirrors, and it has the **identical** gap (no Tab trap) —
plus it never restores focus on close at all (this file's header already calls that difference out).
`/tasks` is Lane B territory per `ui-work-split.md`, not the assistant surface, so I did not touch
it. **This should be routed as a follow-up** — either to whoever owns the drawer pattern generally,
or cloned as its own small ticket, since it's the exact same fix, mechanically.

Tests added: `AssistantDrawer.test.tsx` — Tab from the last element wraps to the panel's own close
button (scoped past the scrim, which shares its accessible name); Shift+Tab from the panel's initial
focus wraps to the last element; a non-boundary Tab press is left alone (jsdom has no native
tab-order traversal to verify the "the browser does the rest" half against, so this only proves the
trap doesn't swallow keystrokes it has no business touching); Escape still closes; focus still
restores to the FAB on unmount.

## What I found and deliberately left alone (with reasoning)

- **Underline-style inputs strip the native focus outline app-wide, including on the assistant
  surface** (`.asst-composer__input`, `.asst-rail__search input`, `.asst-mem__propose-input`, the
  rename/edit inputs — all `outline: none` + a border-color swap on focus). I checked whether this
  was new: it is not — `org.css`'s `.org-name`, `data.css`'s `.dt__search input`, and `ui.css`'s
  `.lux-filters__field input/select` all do the identical thing. This is the established, systemic
  "hairline underline input" convention for the whole design system, not a defect introduced here.
  Whether a 0.5px border-color change clears WCAG 2.4.11's visible-focus bar as well as the global
  2px ring does is a legitimate open question — but it's a **shared, cross-lane token/pattern
  question** (it touches Lane A's `org.css`, Lane B's forms, and the shared `ui.css` primitives
  equally), not something to unilaterally change on one surface. Flagging for the ui-work-split
  Phase-0 owner rather than fixing in isolation, per this ticket's own constraint not to wander into
  shared patterns non-additively.
- **`--erp-accent` (bronze/lifted-bronze) used as small TEXT color** (chip labels, eyebrows) rather
  than only as a graphic/border color. `colors.css`'s own rules-for-authors distinguish a `-fg` text
  tier from a graphic tier for the *status* palette specifically, but the accent color has no such
  split, and it's used as text throughout the app already (`approvals.css`, `dashboard.css`,
  `data.css`, `departments.css`, `org.css`, all pre-existing). Same reasoning as above: a systemic,
  cross-lane token question, not something to fix in one surface without an owner decision on
  whether `--accent` needs its own `-fg` tier the way status colors already got one.
- **`CapabilityCards`' category `<h3>`s and `MemoryPanel`/`CapabilitiesPanel`/`RosterPanel`'s `<aside
  aria-label="…">` regions with no matching visible heading.** I checked this carefully: HTML5's
  outline algorithm treats `<aside>`/`<nav>` as their own sectioning root, so their internal `<h2>`s
  are not, strictly, "skipping" the page's `<h1>`. In practice, though, most screen readers'
  heading-navigation commands flatten ALL headings in DOM order regardless of sectioning boundaries,
  which is why I fixed the one place that's provably wrong under that flattened view (finding #2
  above). I did not add a redundant visible heading to each right-rail panel duplicating its
  `aria-label` (e.g. an `<h2>Memory</h2>` next to `aria-label="Assistant memory"` on the `<aside>`
  itself) — an `aria-label`'d landmark region is itself a well-supported, standard way to name a
  region without a visible heading, and duplicating it would be adding chrome the design doesn't
  call for, not fixing a defect.
- **`data-theme` dark-mode contrast on the assistant surface specifically** — I traced every color
  the assistant CSS uses back through `colors.css`'s dark block (`--surface-page`, `--surface-card`,
  `--ink-*`, `--status-*-fg`, `--erp-accent`, `--tint-active`, `--wash*`) and none of them are
  assistant-specific re-declarations; they're the same shared tier every other dark-mode-correct
  surface already reads. I did not find a single hardcoded light-only value anywhere on this
  surface. This is a strong code-level signal that dark mode renders correctly here, but see
  "unverified" below — I have not visually confirmed it in a real browser.
- **The nav entry** (`nav.ts`'s `{ label: "Assistant", href: "/assistant", icon: "assistant" }`) is
  fine as-is: it renders through the shared `NavLink.tsx`, a real `<Link>` with a visible text label,
  a matching `aria-label` (no mismatch — axe's `label-content-name-mismatch` only fires on a
  *differing* label, and this one is identical to the visible text, same as every other nav item),
  `aria-current="page"` when active, and the icon itself is `aria-hidden="true"` inside `Icon`
  (`icons.tsx`). No gap found; no change made.
- **`Composer.tsx`, `ThreadRail.tsx`, `BrainPicker.tsx`, `MemoryPanel.tsx`, `RosterPanel.tsx`,
  `CitationChips.tsx`, `PageContextChip.tsx`** — read closely, already correct: every icon-only
  button has an `aria-label`, every text input/textarea/select has a linked `<label>` (visually
  hidden via `.asst-sr-only` where a visible label isn't the design), destructive actions
  (delete-thread, delete-memory) require a second confirming click rather than firing immediately,
  and errors render via `role="alert"`. Nothing to fix.

## What is UNVERIFIED (no real screen reader or browser here)

Everything above is **code-level correct** — I read the actual ARIA semantics, the actual CSS token
resolution, and the actual event-handler logic, and backed the four fixes with unit tests that
exercise the real DOM output. I did **not**:
- Run this through an actual screen reader (NVDA/JAWS/VoiceOver) to confirm the `aria-live="off"`
  fix produces the experience I reasoned through — different screen readers have historically had
  inconsistent handling of live-region mutation timing, and "code-level correct per the ARIA spec"
  is not the same claim as "sounds right in NVDA."
- Visually load `/assistant` in a real browser in dark mode (pinned `data-theme="dark"` or OS-dark)
  to eye-check contrast on the actual rendered page — I traced the token resolution chain by hand
  instead. `DEMO_MODE=1 npm run dev` on port 3010 would be the way to do this; I did not start a dev
  server for this ticket since a code-level trace was sufficient to find and fix concrete defects,
  and the ticket's own gate is `tsc` + the test suite, not a live visual pass.
- Drive the drawer's focus trap with real Tab presses in a real browser — jsdom has no native
  browser tab-order traversal to test against (see the test file's own comment on this), so the
  non-boundary-press test only proves the trap doesn't intercept keystrokes it shouldn't; the actual
  "does Tab move through First → Second in order" half is a real-browser-only claim.

## Verification run

```
npx tsc --noEmit           # clean, zero errors
npm test                   # 113 files, 1180 passed (1171 baseline + 9 new — no regressions)
DEMO_MODE=1 npm run build  # succeeded — the project's own "real gate" per CLAUDE.md
```

## Files touched

- `platform-ui/src/components/assistant/Message.tsx` — `aria-live="off"` while streaming
- `platform-ui/src/components/assistant/ThreadView.tsx` — empty-state label promoted to `<h2>`
- `platform-ui/src/components/assistant/assistant.css` — restored the brain-picker's focus ring
- `platform-ui/src/components/assistant/AssistantDrawer.tsx` — added the Tab/Shift+Tab focus trap
- `platform-ui/src/components/assistant/Message.test.tsx` — new
- `platform-ui/src/components/assistant/ThreadView.test.tsx` — new
- `platform-ui/src/components/assistant/AssistantDrawer.test.tsx` — new

No files outside `components/assistant/` were edited. `src/styles/tokens/colors.css` and
`docs/ui-work-split.md` were read-only references.

## For the orchestrator / owner

- **Follow-up ticket (small, mechanical):** apply the identical Tab/Shift+Tab focus-trap fix to
  `components/pm/TaskDrawer.tsx` (Lane B / PM console territory — not touched here).
- **Owner decision needed, not urgent:** whether `--accent` needs a dedicated `-fg` text tier the
  way the status palette already has one, and whether the underline-input `outline: none` convention
  clears WCAG 2.4.11 as reliably as the app's default 2px ring. Both are systemic, cross-lane
  questions belonging to whoever owns the shared token layer (the ui-work-split Phase-0 owner), not
  something this ticket should decide unilaterally for one surface.
- No blockers. No contract/schema changes were needed or made.
