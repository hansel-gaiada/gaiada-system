# A11Y-AUTO-01 — automated axe-core auditing + the manual checklist automation can't replace

**Status:** DEV-VERIFIED (all 15 automated checks green, both themes; code-level fixes unit- and
build-verified). **No real screen reader was used — see the dedicated section below.**
**Scope:** `platform-ui/e2e/a11y-axe.spec.ts` (new), `platform-ui/package.json` (devDependency +
convenience script), `platform-ui/src/components/assistant/assistant.css`,
`platform-ui/src/components/pm/{ProgressBar,Contributors,Dependencies}.tsx`,
`docs/a11y-manual-checklist.md` (new).
**Out of scope, respected:** did not touch `AssistantWorkspace.tsx` or `lib/assistant.ts` (a
sibling session is changing thread titles there), and none of the PM Phase-4 in-flight files
(`pm.ts`, `demoPm.ts`, `pmVocabulary*`, `pmUrgency*`, `UrgencyChip*`, `styles/tokens/pm.css`,
`globals.css`, `tokens.test.ts`, `departments.test.ts`). Nothing committed or pushed — four
sessions share this checkout.

## Why this ticket exists

Recent work fixed six real a11y defects across two drawers and the proposal card (`aria-live`
containment on the streaming row, two focus traps, a focus ring, a heading-order fix). All of it
is code-correct and unit-tested. None of it has ever been driven by a real screen reader, and
nothing prevented a regression from creeping back in silently. This ticket adds the automated half
that CAN be regression-tested, and writes down, explicitly, the human half that can't.

## What I built

### (a) `@axe-core/playwright`, devDependency only

Added at `^4.12.1`. Runtime deps in `package.json` are unchanged — still exactly `next`, `react`,
`react-dom`, `server-only`. Nothing in `e2e/a11y-axe.spec.ts` is imported by app code, so it cannot
leak into the runtime bundle.

### (b) `e2e/a11y-axe.spec.ts` — 15 checks, 7 surfaces × light/dark, all green

| Surface | Why it's here |
|---|---|
| `/assistant` — empty state | the default landing state of the whole surface |
| `/assistant` — active thread with real history (`asst-thread-1` seeded fixture) | a rendered transcript, not an empty composer |
| `/assistant` — genuinely mid-stream | the actual `aria-live="off"` DOM shape this program's own fix targets |
| `/assistant` — proposal card, `awaiting_confirmation` | the D14 write-confirmation UI, newest and least-audited surface |
| Assistant drawer (opened via the FAB, a real click) | one of the two recently-fixed focus traps |
| PM task drawer (opened via a real client-side navigation) | the other recently-fixed focus trap |
| Project board (`/projects/p-web-1?view=board`) | one dense, ordinary page as a baseline — not a surface this program built |

Each runs once per theme via a `pinTheme()` helper that writes the same `gaiada_prefs` cookie
`lib/prefs.ts` already owns (no new mechanism) — `colors.css`'s guarded 3-tier dark system means
contrast genuinely differs by theme, so auditing only one theme would have missed real findings
(and did, in earlier draft runs of this exact suite — see below).

Two real fixtures/task IDs from the existing demo store are reused (`asst-thread-1`, project
`p-web-1`, task `t-4`) rather than inventing new ones — same discipline `smoke.spec.ts` and
`assistant-drawer.spec.ts` already follow.

**How to run it:** `npm run e2e:a11y` (added — `playwright test e2e/a11y-axe.spec.ts
--project=chromium --workers=1`), or directly via `E2E_PORT=3010 npx playwright test
e2e/a11y-axe.spec.ts --project=chromium`. Needs the `setup` project's stored session, which
Playwright resolves automatically as a dependency.

### (c) Two real bugs the first draft of the suite itself caught

Writing the test found genuine gaps before it found any *product* defects — worth recording since
either could silently reappear:

1. **Wrong active company.** The shared authed session's default active company (`me.companies[0]`
   fallback in `lib/tenant.ts`) is a DIFFERENT company than the one every seeded assistant/PM
   fixture lives under (`co-agency`, "Gaia Digital Agency"). Without pinning `gaiada_tenant`
   explicitly (the same workaround `smoke.spec.ts` already needed), `/assistant?thread=asst-thread-1`
   silently rendered an EMPTY rail — `page.tsx`'s own logic ignores a `?thread=` id that isn't in
   the caller's own thread list, treating "wrong tenant" identically to "thread doesn't exist."
   The page never errored; it just quietly showed the wrong thing. A reminder that "the page
   rendered with no exception" and "the page rendered the right data" are different claims, even
   inside a test written specifically to check the page.
2. **`STALL_TEST` doesn't produce a "mid-stream" DOM.** `demoAssistantStreamBody`'s `STALL_TEST`
   hook (by design, per its own header comment) never emits a `token` SSE event — it exists
   specifically to exercise the client's 120-second idle-timeout path. `streamReducer`
   (`lib/assistant.ts`) only flips `status` from `"idle"` to `"streaming"` on the FIRST `token`
   event, so with zero tokens ever arriving, `status` never leaves `"idle"`, `Message`'s `streaming`
   prop is always `false`, and `aria-live="off"` never actually turns on. The first draft of the
   "streaming state" test used `STALL_TEST` and timed out waiting for a DOM shape that was never
   going to appear. Fixed by sending a plain message instead — the demo store's real ~1.5s
   word-by-word reply (30ms/word) gives a wide-enough, real mid-stream window to scan.

### (d) What axe actually found, and what I did about each finding

**Fixed — cheap, unambiguous, ours:**

- `ProgressBar.tsx`: `role="progressbar"` had no accessible name at all (`aria-progressbar-name`,
  serious) — every PM progress bar, board cards and the detail meta strip alike, since they all
  share this one component. Added `aria-label={"Progress: " + v + "%"}`.
- `Contributors.tsx` / `Dependencies.tsx`: the "Add a contributor…" / "Add a blocker…" `<select>`s
  had no label at all (`select-name`, critical). Added `aria-label` to each, matching the visible
  placeholder option text.
- Six spots in `assistant.css` used `--ink-faint` — the token's OWN comment reserves that tier for
  "decorative only" (~3.3:1 in light theme; axe measured 2.82–2.87:1 in practice on these
  elements) — on text that is genuinely informational, not decoration:
  - `.asst-msg__usage` (a message's token/cost line — its sibling `.asst-msg__badge` right above it
    already correctly used `--ink-subtle`, so this was a plain inconsistency)
  - `.asst-code-lang` (fenced-code-block language tag)
  - `.asst-stream-status` (the `role="status" aria-live="polite"` line — this text IS the
    announcement content for the entire streaming surface; leaving its own visible copy at 2.87:1
    would have been a real irony)
  - `.asst-proposal__arg dt` (the redacted-args preview's field-name labels — a reviewer needs to
    read these before confirming a write; its sibling `dd` already used `--ink-subtle`)
  - `.asst-proposal__hint` (the confirm-window expiry deadline — a real deadline, not decoration)
  - `.asst-composer__mode-hint` (explains what a tools-mode turn may do, including the "may draft a
    write" warning)

  All six promoted to `--ink-subtle` (the token's own comment: ">=4.5:1, small caps labels" tier).
  Verified by re-running the suite — every one of these surfaces is now green in both themes.

**Deferred — recorded with rule id + reason, not silently suppressed** (excluded by exact CSS
selector in `PRE_EXISTING_CONTRAST_EXCLUSIONS` inside the spec file, never by disabling the rule
wholesale — any OTHER contrast regression on these same pages still fails the run):

| Selector(s) | Rule | Measured | Why deferred |
|---|---|---|---|
| `.erp-side__tagline`, `.erp-side__grouplabel` | `color-contrast` | as low as 3.21:1 (dark) | `shell.css` uses raw CSS `opacity` (0.55 / 0.4) on the sidebar tagline and nav-group labels — present on EVERY page, not a surface this program built. Root cause is exactly the "ad-hoc alpha instead of a token" anti-pattern `platform-ui/CLAUDE.md`'s own design-system rule 3 warns against. A real fix (swap `opacity` for a contrast-checked `--ink-*` tier) has app-wide blast radius and needs its own visual review pass, not a change made in passing here. |
| `.erp-company .type-eyebrow` | `color-contrast` | same family | Same root cause as the row above (`CompanyContext.tsx` reuses `.type-eyebrow` in the same muted-on-chrome context). |
| `.pm-sec__label.type-eyebrow` | `color-contrast` | 4.42:1 (dark) | Task-drawer section headers ("Tags", "Assignee", …). Different root cause than the two above: the shared `--ink-subtle` token itself is 0.08 short of the 4.5:1 its own comment claims, in dark theme, against this surface's background. A one-line alpha bump in the guarded `colors.css` dark-block pair would likely fix EVERY `--ink-subtle` consumer app-wide at once — exactly why it needs its own reviewed ticket rather than a number picked blind to make one axe run green. |
| `.pm-tag` | `color-contrast` | as low as 1.9:1 (dark) | PM tag chips (`Board.tsx` cards + the tag filter strip) render each tag's OWN user-chosen swatch colour (`ColorSwatchPicker`) as both text and background. Data-dependent, not a token bug — a real fix needs either a contrast-checked swatch palette or a text-shadow/outline treatment, a design decision outside this ticket. |

**Flagged, NOT verified, NOT fixed (scope discipline, stated so it isn't mistaken for "checked and
fine"):** `--ink-faint` is used on more real-information text elsewhere in `assistant.css` — the
Memory and Capabilities panels' hint/empty-state text, the thread rail's "No sessions yet…" empty
state, and the message meta line (`.asst-msg__meta`, e.g. "stopped"/error-kind text). None of this
program's 7 tested surfaces render those panels open, so axe never actually measured them — I am
naming the pattern, not claiming a result I don't have. Worth its own pass; likely the same fix.

## CI recommendation (asked to state explicitly, not silently pick)

**Recommendation: keep this suite OUT of the `smoke` project — on-demand / CI-nightly, not a merge
gate.** Reasoning:

- CI's actual build gate is `npx playwright test --project=smoke --grep @smoke` — one
  self-contained, fast, deterministic test. `a11y-axe.spec.ts` runs in the default `chromium`
  project and is not tagged `@smoke`, so as things stand it **does not** gate a merge at all today.
- Several of these checks need a real SSE round trip (the streaming and proposal-card tests send a
  message and wait for the demo backend to actually stream a reply) — meaningfully slower and more
  timing-sensitive than the smoke check's single login+navigate. Running the full 15-check suite
  serially (`--workers=1`, needed — see below) took **~60–90 seconds** in this environment.
- This box is explicitly shared across concurrent agent sessions (per the program's own operating
  notes). A CPU-contended dev server measurably affected this suite while building it — an earlier
  parallel run (`fullyParallel: true`, several workers) produced spurious interaction-timeout
  failures that had nothing to do with accessibility and everything to do with contention; the same
  suite run serially against the same code was clean. A merge gate that can fail for reasons
  unrelated to the change being reviewed is worse than no gate.
- The suite is genuinely valuable as a **regression check for what axe covers** and should be run
  regularly (a nightly CI job, or on-demand before a UI-touching release) — just not as a blocking
  merge condition until it has enough real runs on the actual CI runner (not this shared dev box)
  to trust its timing.

If a future session wants to promote a SUBSET into the smoke gate, the two cheapest, most
deterministic candidates are the baseline board scan and the empty-state scan (no SSE round trip,
sub-5-second each in every run here) — the streaming/proposal-card checks should stay out.

## What is UNVERIFIED — no real screen reader was run

Every fix in this ticket is **code-level correct**, backed by axe's actual rule engine running
against the actual rendered DOM (not a static read of the source), and confirmed to hold across
both themes by re-running the suite after each fix. That is real evidence for what axe checks —
missing accessible names, ARIA misuse, colour contrast, heading order — genuinely about a third of
what a full accessibility audit covers, per the header comment `a11y-axe.spec.ts` states explicitly
so nobody mistakes a green run for "accessible."

**No NVDA, JAWS, or VoiceOver session was run against any surface in this program, this ticket
included.** `docs/a11y-manual-checklist.md` is the scripted ~15-minute human pass for exactly the
things this can't check — streaming announcement cadence, post-action focus destination, whether a
state change is announced at all, and whether the collapsed thread rail is reachable/announced —
and its own results table is blank, stated as blank, on purpose. Two of its five checks (focus
after Confirm/Dismiss, and whether the proposal card's terminal state is announced) describe a
LIKELY gap inferred from reading `ProposalCard.tsx` (the Confirm/Dismiss buttons unmount with
nothing explicitly moving focus, and no `aria-live` wraps the state label) — not a confirmed defect,
because nobody has listened yet.

## Verification run

```
npx tsc --noEmit                                    # clean, zero errors
npm test                                             # 125 files, 1344 passed (1340 baseline — no regression)
DEMO_MODE=1 npm run build                            # succeeded — the project's own real gate
npx playwright test --project=smoke --grep @smoke    # still passes, unaffected
npm run e2e:a11y                                     # 15 passed (both themes, all 7 surfaces)
```

Real output from the final `npm run e2e:a11y` run (serial, `--workers=1`):

```
Running 15 tests using 1 worker
  ok  1 …setup… authenticate
  ok  2 axe — light theme › baseline dense page — project board (light)
  ok  3 axe — light theme › assistant — empty state (light)
  ok  4 axe — light theme › assistant — active thread with history (light)
  ok  5 axe — light theme › assistant — streaming state (light)
  ok  6 axe — light theme › assistant — proposal card awaiting confirmation (light)
  ok  7 axe — light theme › assistant drawer, opened via the FAB (light)
  ok  8 axe — light theme › PM task drawer, opened via a real client-side navigation (light)
  ok  9 axe — dark theme › baseline dense page — project board (dark)
  ok 10 axe — dark theme › assistant — empty state (dark)
  ok 11 axe — dark theme › assistant — active thread with history (dark)
  ok 12 axe — dark theme › assistant — streaming state (dark)
  ok 13 axe — dark theme › assistant — proposal card awaiting confirmation (dark)
  ok 14 axe — dark theme › assistant drawer, opened via the FAB (dark)
  ok 15 axe — dark theme › PM task drawer, opened via a real client-side navigation (dark)

15 passed (1.0m)
```

## Files touched

- `platform-ui/package.json`, `package-lock.json` — `@axe-core/playwright` devDependency,
  `e2e:a11y` npm script.
- `platform-ui/e2e/a11y-axe.spec.ts` — new, 15 checks.
- `platform-ui/src/components/assistant/assistant.css` — 6 `--ink-faint` → `--ink-subtle` fixes.
- `platform-ui/src/components/pm/ProgressBar.tsx` — `aria-label` on the progressbar.
- `platform-ui/src/components/pm/Contributors.tsx` — `aria-label` on the contributor select.
- `platform-ui/src/components/pm/Dependencies.tsx` — `aria-label` on the blocker select.
- `docs/a11y-manual-checklist.md` — new.
- `docs/modules/MODULES.md`, `docs/modules/CHANGELOG.md` — version bump (`platform-ui` 0.19.0 →
  0.19.1) + writeup, per the project's status-language/versioning convention.

Not touched: `AssistantWorkspace.tsx`, `lib/assistant.ts` (sibling session's territory), any PM
Phase-4 in-flight file. Nothing committed or pushed.

## For the orchestrator / owner

- **No blockers.** No contract/schema changes were needed or made — this was a devDependency +
  test-authoring + small, cheap component-level a11y fixes, squarely inside FE scope.
- **Follow-up ticket (design-system, cross-cutting, needs a visual pass, NOT decided here):** the
  three deferred `color-contrast` findings in the table above — sidebar tagline/nav-group `opacity`,
  the `--ink-subtle` dark-theme shortfall, and PM tag-chip swatch colours.
- **Follow-up (small, mechanical, same pattern already proven safe 6 times in this ticket):** sweep
  the remaining `--ink-faint`-on-real-text spots named above (Memory/Capabilities panel hints, rail
  empty state, message meta line) — likely the identical one-line fix, just not yet measured by
  axe because this ticket's 7 surfaces never opened those panels.
- **Owner decision needed, not urgent:** whether to promote the two cheapest checks (baseline board,
  empty state) into the `smoke` gate once this suite has enough clean runs on real CI hardware to
  trust the timing — my recommendation is not yet, see the CI section above.
- **The most valuable next step is not code:** run `docs/a11y-manual-checklist.md` for real, with an
  actual screen reader, and fill in its results table. Two of its five checks describe a likely gap
  (post-Confirm/Dismiss focus, and the proposal card's unannounced state change) that no amount of
  further axe tooling will ever surface — someone has to listen.
