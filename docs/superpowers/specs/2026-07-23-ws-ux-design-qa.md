# WS-UX Design QA — Daily-Work Surfaces (WSUX-11)

**Date:** 2026-07-23 · **Reviewer:** senior-uiux · **Status:** REVIEW-ONLY (no code touched)
**Reviewed against:** `docs/superpowers/specs/2026-07-20-daily-work-ux-spec.md` (UX-2, binding) +
`docs/superpowers/specs/2026-07-22-dept-console-design.md` (P1-02, DESIGN COMPLETE) +
`docs/superpowers/plans/2026-07-23-ws-ux-plan.md` (v2 reconciliation).
**Method:** full source read of every file listed below, plus a live click-through on a throwaway
`DEMO_MODE=1` copy of `platform-ui` on port 3097 (own scratch copy, own port; `:3005` and the FE
agent's in-progress edits were not touched). 15 screenshots captured, one CSS bug confirmed via
computed-style query, one gap confirmed by reproducing it live.

---

## Verdict per surface

| Surface | Verdict |
|---|---|
| **Home** (Command Center + Queue/Agenda) | **Matches the vision, with one real bug.** Structure, both variants, ScopePill/Envelope, filter chips, states — all faithful to UX-2 §1. The urgency-dot colour mapping is inverted (Major-1 below). |
| **Approvals inbox** | **Matches the vision**, with one intentional-looking simplification worth confirming with the owner (no side-by-side "Recently decided" section — folded into a Pending/Decided toggle instead, Minor-1). |
| **Notifications** | **Matches the vision** and is actually the *best* example of the risk-colour rule in the whole set (critical=rust, warning=bronze, info=none) — ahead of where the plan's ticket table suggests it is. |
| **Department console** (Home/Board/Connections/rail) | **Matches the vision extremely well** — this is the strongest-built surface in the set. Console IA, KpiStrip, HealthRingCard, ActivityFeed, MyWorkRail, ServicedBlock, the WSUX-7 focus/swimlane graft on Board, all render and behave per spec live. |
| **Scope pill / envelope primitive** | **Matches the vision** structurally (single reachable company → static label, no banner when fully included, `[why?]` disclosure) but has an ARIA misuse worth fixing (Major-2). |
| **Cross-surface coherence** | **Mostly one system.** Same tokens, spacing, hairline/no-radius language, same `needs-me-queue`/`dept-rail` row anatomy reused across Home/Approvals/console rail. Two real cracks: the dot-colour inversion (Major-1) and Notifications' independently-invented row layout (Minor-3). |

---

## Findings

### CRITICAL — none.
Nothing found that breaks data integrity, security, or blocks core navigation once the
company-scope nuance below is understood.

### MAJOR

**Major-1 — Risk-colour rule is inverted on the Home queue dot (violates the binding "one
colour, one meaning" rule this exact ticket is chartered to check).**
`platform-ui/src/components/dashboard/dashboard.css`:
```css
.needs-me-queue__dot--now   { background: var(--erp-accent, #6E5A43); }  /* calm bronze */
.needs-me-queue__dot--today { background: #B5622F; }                     /* alarm rust  */
.needs-me-queue__dot--soon  { background: rgba(26, 25, 22, 0.28); }       /* grey        */
```
`urgencyBand()` (`lib/queueUrgency.ts`) maps **pending approvals/gates AND already-overdue
tasks** to band `"now"` (→ calm bronze dot), and maps **merely due-today, not-yet-late tasks**
to band `"today"` (→ the system's one alarm colour, rust `#B5622F`). Confirmed live via
`getComputedStyle`: `--now` renders `rgb(110,90,67)` (bronze), and the only band actually visible
in the manager-tier demo queue (all overdue + all-pending-approval rows) is bronze — i.e. the
genuinely late/needs-a-decision items are the *calm*-coloured ones. This is backwards under
`2026-07-22-dept-console-design.md` §6 ("Colour is signal, never decoration... one risk colour is
the only colour that means 'look at this'") and under the department console's own conventions
built in this same workstream (HealthRingCard's ring goes rust only when `atRisk`; MyWorkRail's
"Waiting on me" rows get the rust left-accent-bar specifically because they need you). The Home
queue is the one surface in the set that gets this rule backwards — it hands the alarm colour to
the least urgent visible tier and the calm colour to the two most urgent ones.
**Fix (follow-up ticket):** swap so overdue tasks (and arguably pending approvals/gates) render
the rust dot and "due today, on track" renders bronze or neutral — pick one coherent reading and
apply it; either way, "not yet late" must not outrank "late" for alarm colour. One-file CSS fix,
no logic change (`computeUrgency`/`urgencyBand` tier ordering is correct; only the dot's colour
map needs new anchor). Add a small colour-mapping unit assertion alongside the existing
`urgencyBand` tests so this can't silently invert again.
**Severity:** Major, not Critical — purely a visual-honesty bug (this exact ticket's stated remit
is "risk-colour discipline (#B5622F only-signal rule) app-wide"), not a data or access bug.
**Recommend before go-live:** yes — it is small, cheap, and directly contradicts the design
system's headline rule on the app's most-viewed page.

**Major-2 — `ScopePill`'s menu uses `role="menu"`/`role="menuitem"` without menu keyboard
behaviour.**
`platform-ui/src/components/scope/ScopePill.tsx` (lines 35–53): the scope dropdown is a native
`<details>/<summary>` disclosure containing plain `<Link>`s, given `role="menu"` and
`role="menuitem"`. ARIA's menu role is a promise to assistive-tech users that arrow-key
navigation, Home/End, and Escape-to-close all work as a native OS menu would; none of that is
wired here (it's just Tab-through links inside a disclosure). This is a common but real
anti-pattern — a screen reader will announce "menu" and set an expectation the widget doesn't
meet. `ScopePill` is reused verbatim by Home, Approvals, and `ServicedBlock` (§4 of the spec:
"one control reused by My Work, Approvals, Tasks, Calendar, Serviced block"), so this is one fix
that cascades to every surface at once.
**Fix (follow-up ticket):** drop the `menu`/`menuitem` roles — a plain `<nav aria-label="Scope">`
with a list of links (or `role="listbox"`/`option"` if a fully custom widget is wanted later) is
both simpler and correct. Low effort, one component.
**Recommend before go-live:** yes, cheap and improves every scope-gated surface at once; not a
blocker if deferred, since the control is still fully keyboard-operable (just mis-announced).

### MINOR

**Minor-1 — Approvals' "Recently decided" is a status toggle, not the side-by-side section the
spec mocked up.** `app/(app)/approvals/page.tsx` + `components/approvals/ApprovalsList.tsx`:
the spec's §2.2 mockup shows a live pending list *and* a "Recently decided" section on the same
screen; the build instead gives Pending/Decided as a single-list toggle (no `DecidedHistory`
component exists — `lib/approvals.ts`/`approvalsShared.ts` cover it, but the dedicated component
named in §2.1/§2.5 was never split out). Functionally reasonable (DRYer, reuses the same
origin-filter + row renderer) and probably *better* information density, but it is a real
divergence from the binding mockup and removes the "glance at both at once" capability the
mockup implied. **Not a defect** — flag to the owner as a design choice to ratify, not a bug to
fix blind.

**Minor-2 — Active/current state conveyed by colour + font-weight only, no `aria-current`.**
Recurring across `FilterChips`, `OriginFilterBar`, the Approvals status/sort `<a>` toggles, and
`ScopePill`'s active menu item — all mark "this one is selected" with
`filter-chip--active`/`is-active`/`scope-pill__item--active` classes (colour + bold) but never set
`aria-current="true"` (or `page`/`location` as appropriate) on the active link. Screen-reader users
get the same list of Links with no indication which one reflects the current view. Same
family of fix as Major-2, same set of components — worth doing together.

**Minor-3 — Notifications reinvents its own row layout instead of reusing `needs-me-queue__row` /
`dept-rail__item`.** `app/(app)/notifications/page.tsx` builds its list with inline `style={}`
objects (not the shared CSS classes the rest of the reviewed surfaces use) — different padding
rhythm, different placement of title vs. meta vs. actions vs. timestamp than
`NeedsMeQueue`/`ApprovalRow`/`MyWorkRail` all share. The severity-colour discipline here is
actually *correct* (see verdict table) and the page functions well; it just doesn't visually read
as the same list-row component family as everything else in the set. Low-cost, no logic risk to
fix — extract the row markup to reuse `needs-me-queue__row`'s classes or promote a shared
`ListRow` primitive.

**Minor-4 — Token reach-around in `departments.css`.** `.dept-rail__due--soon { color:
var(--brand-color-primary); }` is the one line in this file that doesn't go through the
file's own `--dept-positive`/`--erp-accent` alias (everything else in `departments.css`
consistently uses the console-scoped aliases). Same computed colour either way (`--brand-color-
primary` *is* the bronze primitive) — cosmetic-only inconsistency in which token name the file
reaches for, not a rendering bug.

**Minor-5 (systemic, pre-existing, flag only) — caption/meta text contrast.** The ~55%-opacity
ink-on-cream captions used pervasively (`.needs-me-queue__meta`, `.dept-rail__item-meta`,
timestamps, `--erp-ink-50`) compute to roughly 3:1 against the cream surface — under WCAG AA's
4.5:1 floor for small text. This is inherited from the existing design system (`ui.css`/
`colors.css`), not introduced by WS-UX, and appears identically on pages this ticket didn't touch
— so it's out of WSUX-11's scope to fix, but worth a standalone design-system contrast-audit
ticket since the daily-work surfaces are now the most-viewed pages in the app.

### GAPS in the DEMO_MODE walkthrough itself (not bugs in the built UI — bugs in the fixture/test
harness sitting on top of it)

**Gap-1 — DEMO_MODE cannot show the IC-tier "Queue + Agenda" Home variant at all.**
`lib/demoFixtures.ts` hardcodes the single demo identity (`demo-hansel`) with
`platform_admin`/`manager` roles regardless of what email is typed at `/login`; `getMe()` in
DEMO_MODE always returns this one identity. Since `isManagerTier` is role-keyed, **every DEMO_MODE
session is manager-tier** — there is no way to browse the built `QueueAgendaHome`/`TodayAgenda`
IC-tier variant in DEMO_MODE today. I confirmed this live (screenshot `home_manager.png` always
renders Command Center regardless of login email). This directly contradicts WSUX-10's own
acceptance bar ("Done when: DEMO_MODE shows both app-Home variants...") — that ticket's stated
"done" condition is not actually met yet.
**Recommend before go-live:** yes for the *owner walkthrough* (the owner should see both Home
variants, not just one) — cheap fix: a second demo identity keyed off a distinct login email
(e.g. `member@gaiada.com` → a member-only role fixture), gated the same way `demo-hansel` is.
Not a fix to the reviewed components themselves — `QueueAgendaHome`/`TodayAgenda` are correctly
built and unit-tested (`TodayAgenda.test.ts`); this is purely a demo-fixture gap.

**Gap-2 — the department console lives under the *served/agency* company, not the holding
company** — `/departments/dept-1` 404s until you switch the top-bar company selector from
"D & A Syrowatka" to "Gaia Digital Agency" first. This is **correct, expected behaviour** (Web
Dev/SEO/etc. departments belong to the agency company's org tree, not the holding co's), not a
bug — but it is a genuine first-click surprise for anyone testing from a cold link, and the
walkthrough below calls the switch out explicitly so the owner doesn't hit the same 404 I did on
the first pass.

---

## What's genuinely excellent (say so plainly, don't bury it under findings)

- The department console Home (`app/(app)/departments/[deptId]/page.tsx` +
  `components/departments/{KpiStrip,HealthRingCard,ActivityFeed,MyWorkRail,LauncherRow,
  TeachState}.tsx`) is a faithful, polished build of `2026-07-22-dept-console-design.md` — KPI
  strip with the one hairline progress bar, health ring going rust only when `atRisk`, activity
  feed grouped by day with source chips, the sticky rail with its "waiting on me" rust
  accent-bar, and the TeachState empty pattern all render and behave exactly as designed, live.
- `lib/queue.ts`'s single shared `getMyWorkQueue` + `projectQueueForCompany` genuinely is one
  data spine reused by both Home and the console rail (R-1) — verified by reading both call
  sites; no second merge implementation exists.
- The Board tab's WSUX-7 focus (Whole dept / Division / Just me) + swimlane (Status/Division/
  Person) graft works live, server-authoritative, no client JS, exactly as the reconciled plan
  describes it.
- `ScopePill`/`EnvelopeBanner` are a real shared primitive (not reinvented per surface) and the
  "single company → static label, no dropdown" / "fully included → no banner" states both work
  as specified.
- Every empty/partial/error state I could reach in DEMO_MODE rendered calm, on-brand copy — no
  raw error dumps, no dead ends.

---

## Owner walkthrough — click-through order at `:3005`

Prereq: log in (any dev/demo identity works). All routes below were verified live on a throwaway
`DEMO_MODE=1` copy; the real `:3005` will show the same structure/states with the FE agent's live
edits layered in, so exact copy may have moved slightly.

1. **Home (Command Center).** Land on `/`. Point out: the greeting + scope pill, the four filter
   chips (Overdue/Due today/Approvals/Mentions) doubling as the old KPI tiles, the demoted
   throughput sparkline top-right, and the single ranked "Needs you" list underneath mixing
   approvals/gates/tasks/mentions with inline Approve/Deny. Click a chip (e.g. "Overdue") to show
   it filtering the same list in place via a URL param — no page flash.
2. **Scope pill.** Open the scope dropdown top-right of Home — show "All companies (3)" vs.
   narrowing to one company; note the pill degrades to a plain static label on any page where the
   viewer only has one reachable company (not visible for this identity, but call it out).
3. **Approvals (`/approvals`).** Same queue concept, wider surface: origin chips
   (All/Agency/Pipeline/HR/Automation/Agent), Pending/Decided + Urgency/Oldest toggles, inline
   note field before Approve/Deny. This is the "everything waiting on you, one inbox" promise.
4. **Notifications (`/notifications`).** Show the severity tabs (Critical/Warning/Info) and that
   only genuinely critical rows get the rust colour — this page is the cleanest example of the
   colour-discipline rule in the whole app.
5. **Switch company to "Gaia Digital Agency"** (top-left company selector) — call out that
   departments live under the company that owns them, not the holding company.
6. **Department console Home (`/departments/dept-1`, "Web Dev").** This is the headline new
   surface: KPI strip, the one health ring (bronze at rest, rust + "AT RISK" badge + reason text
   when a project has an overdue/blocked task), the day-grouped activity feed, "Build tools"
   launcher row, and the persistent right-hand rail ("My work today" / "Waiting on me") that
   stays on screen across every tab.
7. **Board tab.** Show the Focus selector (Whole dept / a named division / Just me) and Group-by
   (Status/Division/Person) — pick "Just me" to show the board narrow to only the viewer's own
   cards, then "Person" to show the same tasks re-grouped into per-person swimlanes.
8. **Connections tab.** Show "My connections" (GitHub pending / Google Drive unconfigured /
   Claude seat linked) and the Team status grid below it — this is the F1/C1 foundation the
   Phase-2 real integrations will ride on.
9. **(If reachable) a served-company department.** Show the "Serviced" block at the bottom of a
   department Home that actually serves other companies — the scope pill scoped to "served
   companies," and, if any company is permission-excluded, the "N you can't view" banner rather
   than a silent drop. (Not present in the demo fixtures I had — flag as a fixture gap if the
   owner wants to see it, per WSUX-10 follow-up.)

---

## Fix-ticket triage

**Worth fixing before go-live** (both are cheap, both directly touch the two rules this exact QA
ticket was chartered to enforce):
- Major-1 (queue dot colour inversion) — one CSS file, add a colour-mapping test.
- Major-2 (ScopePill ARIA menu misuse) — one component, cascades everywhere ScopePill is used.
- Gap-1 (DEMO_MODE can't show the IC-tier Home) — needed so the owner walkthrough actually covers
  both Home variants as WSUX-10 promises; add a second demo identity.

**Fine to defer / after go-live:**
- Minor-1 (Approvals decided-history layout) — confirm with owner first; may not be a bug at all.
- Minor-2 (aria-current) — bundle with Major-2's ScopePill fix since it's the same component
  family and same root cause (state-by-colour-only).
- Minor-3 (Notifications row markup reuse) — cosmetic, no functional risk.
- Minor-4 (stray token name) — cosmetic, zero visual difference.
- Minor-5 (systemic caption contrast) — real, but pre-existing and app-wide; needs its own
  design-system ticket, not a WS-UX patch.
- Gap-2 (agency-vs-holding company for departments) — not a bug; just make sure the owner
  walkthrough script (above) calls out the company switch so it isn't a surprise.

**Q13 (urgency-weight retuning):** not retuned this pass — the owner should see the live queue
order first (per the walkthrough above) before any weight changes are requested; `lib/
queueUrgency.ts`'s `TIER_WEIGHT` table remains the one-file knob if retuning is wanted after the
walkthrough.
