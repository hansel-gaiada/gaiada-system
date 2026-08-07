# platform-ui — manual screen-reader pass (NVDA / VoiceOver)

**Purpose:** the 5 things `@axe-core/playwright` (see `platform-ui/e2e/a11y-axe.spec.ts`) cannot
check, because they are about *behavior over time* and *where attention goes*, not static DOM
shape. Axe passing on a page proves roughly a third of what "accessible" means — missing names,
bad ARIA, contrast, heading order. It says nothing about whether a live region actually announces
sensibly, or whether focus lands somewhere a keyboard/screen-reader user can act on next. This
checklist is the other two thirds, scripted tightly enough that a human can run it in about
**15 minutes** without needing to invent test steps on the spot.

**As of 2026-08-07, this checklist has never been run against a real screen reader.** The 6
defects the recent assistant/drawer/proposal-card work fixed (`aria-live` containment, the two
focus traps, focus-ring visibility, heading order) are all *code-correct* and unit-tested
(`Message.test.tsx`, `AssistantDrawer.test.tsx`, `TaskDrawer.test.tsx`), but "the attribute is
right" and "NVDA says something sensible" are different claims until someone actually listens.
Whoever runs this for the first time: fill in the results table at the bottom and commit it —
that turns this from a template into evidence.

## Setup (once, ~2 minutes)

1. Screen reader: **NVDA** (free, Windows) or **VoiceOver** (built into macOS, `Cmd+F5`). Use
   Chrome with NVDA, Safari with VoiceOver — the other browser/reader pairings have known quirks
   unrelated to this app.
2. Start the app in demo mode so no backend is needed: `DEMO_MODE=1 npm run dev` (or
   `DEMO_MODE=1 PORT=3010 npm run dev` if `3005` is taken by another session — see
   `platform-ui/CLAUDE.md`).
3. Log in at `/login` with any email containing neither `client` nor `ic` (e.g.
   `hansel@gaiada.com`) — demo mode accepts any email and this one resolves to the elevated
   `demo-hansel` identity the seeded assistant fixtures assume.
4. **Switch the active company to "Gaia Digital Agency"** (the switcher near the top of the left
   sidebar). The seeded assistant thread, project `p-web-1`, and task `t-4` this checklist uses all
   live under that company — the account's *default* active company is a different one, and every
   check below will show up empty against it.
5. Turn your screen reader on now, and leave it on for the rest of this pass — don't peek at the
   screen to "check" something instead of listening; that's the whole point.

## Check 1 — does the streaming reply announce ONCE, not per token? (~3 min)

**Why this matters:** `Message.tsx` sets `aria-live="off"` on the row that is actively streaming,
specifically so a screen reader does NOT read the reply as it grows character-by-character
(`useTypewriter` repaints it every 16ms). `StreamIndicator.tsx` is the one intended announcement —
a `role="status" aria-live="polite"` line that says "Assistant is thinking…" then "Assistant is
responding…". This check is the only way to know whether that design actually holds in practice.

**Steps:**
1. Go to `/assistant`. Click **"+ New chat"**.
2. Type `Tell me about the redesign project` and press **Enter**.
3. Do nothing else — just listen — for the ~2 seconds the reply streams in.

**Expected:** you hear **one or two short status announcements** ("Assistant is thinking…",
then "Assistant is responding…", then a "finished" cue once it completes) — not a rapid chatter of
partial words or fragments repeating as the text grows. The growing message bubble itself should be
silent while it's the one streaming.

**If it fails:** you'll hear the screen reader stumbling through fragments of the reply
repeatedly as it's appended — that means the `aria-live="off"` containment on the live row isn't
holding (a real regression, not a design choice to accept).

## Check 2 — where does focus land after Confirm / Dismiss on the proposal card? (~3 min)

**Why this matters:** `ProposalCard.tsx` removes its Confirm/Dismiss buttons the instant the card
goes terminal (`actionable` becomes false) and does not explicitly move focus anywhere. Nothing in
the code proves where the browser puts focus next — this has to be observed, not assumed. **Known
gap, not yet fixed:** record what you actually hear/see; don't mark this "pass" just because
nothing crashes.

**Steps:**
1. On `/assistant`, click **"+ New chat"**. Check **"Use tools"**, leave the tool agent as
   `task-filer`.
2. Type `file a task for the launch` and press **Enter**.
3. Wait for the proposal card ("Awaiting your confirmation…"). **Tab** to the button named
   "Confirm write: pm.createTask — send for approval" and activate it (**Enter** or **Space**).
4. The instant it resolves ("Approved and executed"), press **Tab** once and ask your screen
   reader what currently has focus (NVDA: `Insert+Tab`; VoiceOver: `VO+F3`).

**Expected result — there isn't one yet; record what actually happens.** The likely outcome (from
reading the code) is that focus silently falls back to `<body>`/the document, so your next Tab
press restarts from the TOP of the page rather than continuing near the card. Confirm or refute
that, and note it precisely (which element, if any, reports focus).

## Check 3 — is the proposal card's state change announced at all? (~3 min)

**Why this matters:** no `aria-live` region wraps the card's state label (`.asst-proposal__state`)
or the card itself — only the terminal `execution_failed` error paragraph is `role="alert"`. A
sighted user sees "Awaiting your confirmation" replaced by "Approved and executed" instantly; a
screen reader user gets no equivalent unless something incidentally reads it.

**Steps:** continue directly from Check 2 — right after activating Confirm, **without pressing any
other key**, just listen for 3–4 seconds.

**Expected result — also unverified; record what you hear.** Most likely: silence (nothing
announces the state change on its own). If your screen reader DOES say something automatically,
note exactly what and from which region — that would mean some ancestor's implicit live-ness is
picking it up incidentally, which would be worth understanding rather than relying on by accident.

## Check 4 — is the collapsed thread rail reachable and correctly announced? (~4 min)

**Why this matters:** `ThreadRail.tsx` collapses by **removing** the search box and session list
from the DOM entirely (not just hiding them with CSS) — only the collapse-toggle and a "+" icon
button remain reachable. That's a deliberate design, but a toggle whose current state a screen
reader can't tell you is a real usability failure, not a passing one just because nothing throws.

**Steps:**
1. On the full `/assistant` page (not the drawer), **Tab** to the button at the top-left of the
   session rail (before "+ New chat"). Listen to its announced name.
2. Activate it (**Enter**/**Space**). Listen again.
3. Tab forward once, then Shift+Tab back, then activate the toggle a second time to restore it.

**Expected:**
- Before collapsing: announced as **"Collapse sessions sidebar"**, and reported as **expanded**
  (NVDA: "expanded button"; VoiceOver: similar).
- After activating: the SAME button now announces **"Expand sessions sidebar"** and reports as
  **collapsed** — the name must actually update, not freeze on whatever it said first.
- Tabbing forward from the collapsed toggle lands directly on a **"New chat"** icon button — the
  search box and the list of existing sessions are skipped entirely (they're gone from the tab
  order, by design), not silently unreachable-but-still-there.
- Activating the toggle again restores the full rail (search box + grouped session list) and
  focus/tab order returns to normal.

## Check 5 (quick pass) — do the two drawers announce themselves by name on open? (~2 min)

**Why this matters:** the automated suite already proves both drawers trap Tab and return focus
to their trigger on close (`assistant-drawer.spec.ts`'s Escape test, `TaskDrawer.test.tsx`). What it
can't prove is whether a screen reader actually SAYS the dialog's name the moment focus lands
there — `role="dialog" aria-modal="true" aria-label="…"` is structurally present either way.

**Steps:**
1. From any page (e.g. `/projects/p-web-1`), activate the floating assistant button (bottom-right).
   Listen to what's announced the instant it opens.
2. Press **Escape**. Listen to what's announced now (should be back on the trigger button).
3. Repeat by opening a task from a board: go to `/projects/p-web-1?view=board`, click the "Wire
   homepage hero" card. Listen on open, then close with the **Close ✕** button or Escape.

**Expected:** on open, you hear something naming **"Assistant"** (drawer 1) or **"Task detail"**
(drawer 2) as a dialog — not silence, and not a generic "group" or "region". On close, focus —
and the announcement — returns to whatever you activated the drawer from.

---

## Results (fill in on the actual run — don't leave this template blank)

| Check | Date | Screen reader / browser / OS | Result | Notes |
|---|---|---|---|---|
| 1 — streaming announces once | | | | |
| 2 — focus after Confirm/Dismiss | | | | |
| 3 — state-change announced | | | | |
| 4 — collapsed rail reachable/announced | | | | |
| 5 — drawers announced by name | | | | |

**No real screen reader has been run against this checklist as of the date this file was
written.** Every "Expected" above is derived from reading the code, not from listening. Treat it
as a prediction to falsify, not a result already obtained.
