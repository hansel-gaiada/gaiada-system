# platform-ui — polish & hardening work split

**For:** 2–3 mid-level frontend devs working in parallel.
**Scope:** harden what already exists. **No new surfaces** — HR/Creative/SMM build-out and
backend-stub wiring are explicitly out of scope here.
**Written:** 2026-07-30, against `platform-ui` `0.6.5` PROTOTYPED.

---

## 1. Where the UI actually is

Measured, not estimated:

| | Count |
|---|---|
| `.ts`/`.tsx` files | 441 |
| Routes with a `page.tsx` | 100 |
| Test files / cases | 67 / 645 |
| CSS files (component-scoped + tokens) | 18 files, ~1815 lines |
| Design tokens defined | 87 custom properties, 3-tier |

**CI is green on all 8 jobs.** That is the bar — see §6. Do not merge anything that reds it.

### The four gaps, sized

| Gap | Measured state | Real cost |
|---|---|---|
| **Dark theme** | **Zero** `prefers-color-scheme` or `data-theme` anywhere | 133 hardcoded colors in CSS + 71 inline `style={{}}` colors in TSX must become tokens first |
| **Loading / error states** | 100 routes, but only **1** `loading.tsx` and **1** `error.tsx` (both root-level) | Per-route states are effectively absent |
| **Responsive** | 13 `@media` blocks total, across 9 of 18 CSS files | Thin for 100 routes; most surfaces untested below tablet |
| **A11y** | Foundation exists (75 files use `aria-`, 48 `role=`, skip link + reduced-motion present) | Gaps: `focus-visible` in only 5 files; ~101 `<input>` without an `id`/`aria-label`; ~176 `<button>` without `aria-label`/`title` |

> The 176-button figure is an **upper bound** — most of those buttons have visible text
> content and are already accessible. Triage before you touch anything; the real target is
> icon-only controls.

**DataTable is not a problem.** 9 files use the shared `DataTable`, only 2 use a raw `<table>`.
Adoption is already good — leave it alone unless one of those 2 is in your lane.

### The good news

`src/styles/tokens/colors.css` is a proper 3-tier system (primitives → editable brand →
semantic aliases), and components are supposed to read only the semantic tier. **Dark mode is
therefore mostly a palette-override job, not a rewrite** — but only once the 204 hardcoded
color sites stop bypassing the tier system. That ordering is the whole reason for Phase 0.

---

## 2. Phase 0 — foundation (BLOCKING, one owner, do this first)

Nobody starts a lane until this is merged. It is small and deliberately owned by one person,
because every lane depends on the contract it establishes.

**Owner:** the most senior of the three (or the lead).

1. **Decide the dark palette.** This is a *design decision*, not a mechanical inversion. The
   system is "luxury minimalist" — warm linen `#F4F1EA`, matte near-black `#1A1916`, bronze
   accent. A naive invert will look cheap. Propose a dark tier-1 primitive set + tier-3
   semantic remap and get it approved before writing it.
2. **Implement the theme switch** in `src/styles/tokens/colors.css`: a `[data-theme="dark"]`
   block overriding tier 2/3 only, plus `@media (prefers-color-scheme: dark)` as the default
   signal. Never override tier 1 primitives.
3. **Theme toggle + persistence**, and **kill the SSR flash** — this is a Next.js App Router
   app, so set `data-theme` from a blocking inline script in the document head before paint.
   Getting this wrong produces a white flash on every navigation and will be very visible.
4. **Add the missing shared tokens**: `--focus-ring`, and responsive breakpoint variables
   (there is currently no breakpoint scale — everyone will invent their own without it).
5. **Ship shared `<LoadingState>` and `<ErrorState>` components** in `src/components/` so the
   three lanes produce identical loading/error UI instead of three dialects.
6. **Write down the token contract** at the top of `colors.css`: *components read semantic
   aliases only; no raw hex below this file.*

**Definition of done:** toggle works, no flash on hard reload or navigation, both themes
readable, `npm run typecheck && npm test && npm run build` green, smoke e2e green.

---

## 3. The three lanes

Split is **by surface ownership, not by concern.** Each dev does all four gaps within their
own routes and CSS files. This is deliberate: dark theme touches every CSS file and a11y
touches every TSX file, so a concern-based split would put all three devs in the same files
every day. Surface ownership means near-zero collisions.

### Lane A — App frame, identity & admin
**Owns CSS:** `shell.css` (22 colors), `dashboard.css` (14), `ui.css` (10), `org.css` (10),
`globals.css` (5), `feedback.css` (3), `approvals.css` (2), `data.css` (2), `services.css` (2),
`forms.css` (1) — **~71 hardcoded colors, the heaviest CSS load**
**Owns routes:** `/` (My Work), `/approvals`, `/notifications`, `/search`, `/account`,
`/people`, `/companies`, `/organization`, `/admin`, `/rollups`, `/calendar` — ~24 pages

Highest-visibility lane: the shell is on screen for every route, so dark-theme and focus-ring
regressions here are felt everywhere. Best suited to whoever did Phase 0.

### Lane B — Delivery & work management
**Owns CSS:** `pm.css` (25 colors), `pipeline.css` (6), `scope.css` (1) — **~32**
**Owns routes:** `/projects`, `/tasks`, `/pipeline`, `/deliverables`, `/timesheets`,
`/meetings`, `/clients`, `/agency`, `/billing`, `/portal`, `/hr`, `/agents` — ~35 pages

Densest *interaction* lane — board drag/drop, Gantt, task detail. Two specifics:
- **The PM console is the known dark-theme gap** and `pm.css` is the single biggest CSS file
  (369 lines). Budget for it.
- `/portal` is **client-facing**. Treat its a11y and responsive work as higher priority than
  internal surfaces, and be conservative — it is also a live pipeline surface (`deduped`
  responses, gate decisions) that backend work is actively touching.

### Lane C — Departments, systems & IT
**Owns CSS:** `it.css` (12 colors), `systems.css` (9), `creative.css` (5), `departments.css` (3),
`bot-extras.css` (1) — **~30**
**Owns routes:** `/departments/*` (30 pages), `/systems/*`, `/it`, `/knowledge` — ~39 pages

Largest *page count* but the lightest per page: the 24 department sub-routes (keywords,
rankings, audit, planner, pacing, ledger, briefs, search-terms, ads, ai-visibility…) are highly
repetitive in shape. **Do one page properly, agree the pattern, then apply it across the rest.**
Do not hand-craft 24 variations.

**Balance note:** Lane A is heaviest on CSS, Lane C on page count, Lane B on interaction
complexity. If a lane runs long, move `/hr` (7 pages) or `/admin` (7 pages) — both are
self-contained and cheap to reassign.

---

## 4. Definition of done (every ticket, all lanes)

A surface is done when:

1. **No raw hex/rgb** remains in that surface's CSS or inline `style={{}}` — semantic tokens only.
2. **Both themes verified** — light and dark, by eye, on the real page.
3. **`loading.tsx` and `error.tsx`** exist for the route (use the Phase 0 shared components).
4. **Responsive at 360 / 768 / 1280** — no horizontal body scroll; wide content (tables,
   Gantt, charts) scrolls inside its own `overflow-x: auto` container.
5. **Keyboard-only pass** — every control reachable and operable, visible `:focus-visible` ring,
   no keyboard trap.
6. **Icon-only controls have `aria-label`**; every `<input>` has a linked `<label>` or `aria-label`.
7. **Green:** `npm run typecheck && npm test && npm run build`, plus the Playwright smoke suite.

---

## 5. Staying out of each other's way

Branch protection is deliberately **not** enabled — `main` is open, so the discipline is social.
Given three people pushing to a trunk that is currently green:

- **Branch per lane:** `ui/lane-a-*`, `ui/lane-b-*`, `ui/lane-c-*`. Open a PR even though
  nothing forces you to — it is how the other two see what is changing.
- **Never edit outside your lane's file list.** Need a change in `colors.css` or a shared
  component after Phase 0? Raise it with the Phase 0 owner; do not edit it yourself. Shared
  files are exactly where three people collide.
- **Pull `main` before starting each ticket.** Backend work is landing on the same trunk daily.
- **`src/lib/*` is shared.** `pm.ts`, `pipeline.ts`, `searchMarketing.ts` etc. are consumed
  across lanes — treat edits there as cross-lane and announce them.
- **Rebuild after backend changes.** `platform-nest` and `mcp-hub` run compiled `dist/` images
  in the local stack with no source bind-mount; a stale image looks exactly like a UI bug.

---

## 6. Verifying locally

The full stack runs in Docker (~20 containers). The UI runs on the host against it.

```bash
# Backend-free — fastest loop for pure polish work, uses lib/demoFixtures.ts
cd platform-ui && DEMO_MODE=1 npm run dev

# Against the live local backend (platform on :3004)
cd platform-ui && npm run dev

# The gate, before every push
npm run typecheck && npm test && npm run build
npx playwright test --project=smoke --grep @smoke   # needs SESSION_SECRET set
```

If `platform-nest` tests are ever needed locally, note `platform-nest/.env` must define
`REDIS_URL` (not just `REDIS_URL_TEST`) or three `search-notifications` tests fail — that is an
env-name gap, not a real failure.

---

## 7. Deliberately out of scope

Say so and file it rather than quietly absorbing it:

- New surfaces — HR `WSD-5` (`/hr/leave`, `/hr/attendance`, `/hr/onboarding`), Creative DAM
  (`CR-02/12/16/20`), the SMM console (`social-media` is `0.0.0 PLANNED`).
- Wiring `BackendPending` / `PendingCapability` stubs (`/billing`, `/clients`, search
  capabilities) — those unblock when their endpoints land, and are owned by backend.
- Dept-console parity for SEO/SMM/Creative/Video against the Web Dev reference template.
- `DataTable` migration — adoption is already good; not worth the churn.
