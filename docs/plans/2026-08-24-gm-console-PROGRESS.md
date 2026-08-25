# GM console — PROGRESS

**THE tracking document for the GM console build.** Design lives in
[`../blueprints/gm-console-foundation.md`](../blueprints/gm-console-foundation.md); this file tracks
what has actually moved.

**Working rule (binding): update the status column in the SAME change that moves the work.** A stale
row here misleads real tickets — that has happened twice elsewhere in this program. Every finished
task also gets a line in the session log at the bottom.

**Status vocabulary (binding):** `PLANNED` · `IN PROGRESS` · `PROTOTYPED` · `DEV-VERIFIED` ·
`BLOCKED`. Never "built", "done", "complete", or "production-ready". **DEV-VERIFIED means you drove
it and observed the result** — a green unit suite is not that. Everything here that says PROTOTYPED
was driven in a browser against a `DEMO_MODE=1` build, **never against live platform-nest**, which
is the gap between PROTOTYPED and DEV-VERIFIED for every row below.

**Session opened:** 2026-08-24. **Owner decisions folded in:** OQ-1..OQ-4 (see §Decisions).

---

## Roll-up

| Track | Items | PLANNED | IN PROGRESS | PROTOTYPED | BLOCKED |
|---|---|---|---|---|---|
| Console foundation (GM-01..04) | 4 | 0 | 0 | **4** | 0 |
| Remaining tabs (GM-05..08) | 4 | 0 | 0 | **4** | 0 |
| Deferred / gated (GM-02b, GM-09) | 2 | 0 | 0 | 0 | **2** |
| Verification (GM-10) | 1 | 0 | 0 | **1** | 0 |
| Docs (D1..D4) | 4 | 0 | 0 | **4** | 0 |
| **Total** | **15** | **0** | **0** | **13** | **2** |

**Every non-blocked task is PROTOTYPED.** The two remaining rows are blocked on things outside this
program (B1, B2). The single gap between PROTOTYPED and DEV-VERIFIED for all thirteen is B4 — none of
it has been driven against live `platform-nest`.

---

## Decisions taken this session

| # | Question | Ruling |
|---|---|---|
| **OQ-0** | *"Can the whole business move under GM? And reports?"* | **No — compose, don't relocate.** `Business` is not GM-grain (a junior needs Timesheets); `Reports` is organised by GRAIN not ownership, and only the company grain is GM's; moving routes breaks deep links, the palette's tier-3 search, MCP hrefs and the agentic-native bar. Foundation doc §0. |
| **OQ-1** | Narrowed view for department heads? | **Yes in principle — BLOCKED in practice.** See GM-02b. |
| **OQ-2** | Business Review default period | **Week.** `GM_DEFAULT_PERIOD` in `lib/gm.ts`, with a Week/Month toggle. |
| **OQ-3** | Cost-to-serve before real revenue? | **No.** One department's provider spend must never be summed into a group figure. The money half waits for SM-17/SM-22. |
| **OQ-4** | GM's own nav group? | **No** — hoisted to the top of `Departments`. Ordering only; no route moved. |
| **OQ-5** *(new, forced by code)* | Which capability gates the console? | **`reports.company.view`**, not `rollups.view`. See Finding F1. |

---

## Open blockers

| # | Blocker | Stops | Status |
|---|---|---|---|
| **B1** | The UI cannot identify a department LEAD. `Me` (`lib/platform.ts`) carries `userId/name/email/title/assurance/companies/roles` and nothing about positions or unit leadership; `positions.is_lead` is display-and-backfill only server-side, and the P2-05 reconciler that would turn `position_roles` into real grants is **not built**. | **GM-02b** (OQ-1's narrowed dept-head console) | **BLOCKED** — needs a lead/position signal on `/api/me`, or a positions read the console may trust. Guessing would ship a company-grain leak, so a dept head currently gets the same refusal a member does, pinned by a test that says so deliberately. |
| **B2** | **No tenant-level spend/margin endpoint exists.** Only `GET engagements/:id/ledger` (engagement-scoped, search-marketing only). BFF contract §14 lists it PENDING under **SM-17 (tenant-scope remainder) / SM-22**. | **GM-09**, and the money half of GM-08 | **BLOCKED** — external to this program. |
| **B3** | Monitoring has **no backend at all** (BFF contract §20: "UI PROTOTYPED, BACKEND NOT STARTED — every row PENDING"). | a monitoring/health tile anywhere in the cockpit | **BLOCKED** — deliberately not attempted; a tile here must render `BackendPending`, never a zero. |
| **B4** | Nothing here has been driven against live `platform-nest`. The local 16-container stack is OFF by owner decision. | **every** row moving PROTOTYPED → DEV-VERIFIED | **OPEN** — needs a run against the server or against test containers from source. |

---

## Tasks

### Console foundation

| # | Task | Status | Notes |
|---|---|---|---|
| **GM-01** | Register the `gm` toolkit — `Home · Project Management · Command · Oversight · Connections` — plus route stubs for all five bespoke tabs so the toolkit cannot point at a 404. | **PROTOTYPED** | `lib/deptToolkits.ts`. Two craft groups (SEO's D-10 precedent). No producer launchers. Also added a GM department to `lib/org.ts`'s seeded agency structure — **appended**, because the `dept-N` ids are positional. |
| **GM-02** | The gate: capability mirror + a fail-closed refusal page shared by every tab, pinned by a test asserting a plain `member` is refused. | **PROTOTYPED** | `lib/gm.ts` + `GmAccessDenied` + `gmTab.tsx`'s two-check guard (toolkit membership FIRST, then capability). Company-scoped. |
| **GM-03** | Home cockpit — Tier 1 company KPIs + Tier 2 department strip on `reports/overview`, with the freshness/seal-state line. | **PROTOTYPED** | `GmCockpit.tsx`. Renders whatever the metric registry returns, capped at `GM_TIER1_LIMIT`; hardcodes no metric keys. Reuses `KpiTiles` as-is. |
| **GM-04** | `Departments` tab — the same read with the column cap lifted, drilling into each department's report. | **PROTOTYPED** | `depts/page.tsx` + `GmDeptStrip.tsx`. Columns derived from the union across scopes; a missing metric renders "—", never `0`. |

### Remaining tabs — this session's work

| # | Task | Status | Reads it needs | Notes |
|---|---|---|---|---|
| **GM-07** | **People** tab — headcount against seats, appraisal-cycle progress, check-in compliance. | **PROTOTYPED** | `listPositions` (`lib/iam.ts`, live) · `getAppraisalCycles` (`lib/appraisals-data.ts`, live) · **`GET /checkins/compliance` needs a new reader** — `checkins-data.ts` only has `getCheckinCardData` today. | Cheapest of the four: every endpoint exists. Vacancies are real data (`currentHolders` vs the seat), never invented employees. |
| **GM-06** | **Decisions** tab — what is waiting on the GM, oldest first. | **PROTOTYPED** | `getMyWorkQueue` + `projectQueueForCompany` (`lib/queue.ts`, live — already used by the console layout). | **Must not become a second approvals implementation.** `/approvals` owns the surface and the layout's rail already projects the same spine. This tab widens the projection and adds wait-age ranking. |
| **GM-05** | **Business Review** tab — the recurring review over `reports/document` at `grain=company`. | **PROTOTYPED** | `getReportDocument` (live) + `ReportPageClient` / `CompanyCharts` / `WarningsBanner` / `PeriodSelector`. | Reuse those components **as-is**. Do not reimplement the viewer; `/reports/company` already renders this document and the tab must agree with it. |
| **GM-08** | **Clients & Money** tab — client portfolio half real; money half stays `BackendPending`. | **PROTOTYPED** | `listClients` (`lib/entities.ts`, live). Money: **none — B2.** | The banner must name SM-17/SM-22. Never render `0` for the money half. |

### Deferred / externally gated

| # | Task | Status | Notes |
|---|---|---|---|
| **GM-02b** | OQ-1's narrowed department-head console (own department's row + company north stars). | **BLOCKED — B1** | When it lands, `gm.test.ts`'s "refuses a department manager" expectation changes **deliberately**; it is not an accident to be quietly fixed. |
| **GM-09** | The money tier for real. | **BLOCKED — B2 (SM-17 / SM-22)** | Amazon's "financials last" rule makes this sequencing principled rather than an excuse. |

### Verification

| # | Task | Status | Notes |
|---|---|---|---|
| **GM-10** | A Playwright spec covering the GM console: cockpit renders, period toggle switches, a `member` is refused on Home AND on a tab, a GM tab under a non-GM department refuses, and the GM row stays in a member's sidebar. | **PROTOTYPED** | `e2e/gm-console.spec.ts`, **18 tests, all passing**, under its own `gm` Playwright project (two identities in one file — a stale shared staff session would turn every negative control green vacuously). Covers all five tabs × both identities, the toolkit-membership refusal, the period toggle, and the `BackendPending` money banner. |

### Docs

| # | Task | Status | Notes |
|---|---|---|---|
| **D1** | Foundation blueprint. | **PROTOTYPED** | `blueprints/gm-console-foundation.md`. |
| **D2** | `sidebar-nav-map.md` change-log entry for the GM hoist. | **PROTOTYPED** | Repo rule: a nav move with no entry there is treated as an accident, not a decision. |
| **D3** | `modules/CHANGELOG.md` entry + `MODULES.md` version bump. | **PROTOTYPED** | platform-ui `0.46.0` → `0.47.0`. |
| **D4** | Note the GM console as a consumer in `FRONTEND-BFF-CONTRACT.md` §15a, and record the new `checkins/compliance` consumer from GM-07. | **PROTOTYPED** | Both rows annotated. The `reports/overview` row now states it carries **no seal flag and no `generatedAt`**; the `checkins/compliance` row now states its three consumer traps (no-403 self-fallback, the `unit` echo, and `complianceRate: null ≠ 0%`). |

---

## Findings

**F1 — `rollups.view` is held by NO role bundle except `platform_admin`'s wholesale `ALL`.**
The design doc's first draft said reuse it for the GM gate, because it already gates `/rollups` and,
in `nav.ts`, the Company Report row. Measured against `ROLE_CAPS`, that would have refused
`company_admin` — the tenant's own administrator, who holds the entire `EXEC_ONLY_REPORTS` tier —
while the backend served the same figures at `/reports/company`. That is exactly the failure the
standing ruling warns about: a UI-only gate hiding a page the server would serve reads as broken, not
as forbidden. The gate is `reports.company.view`, the capability naming the actual §8 boundary, and it
is company-scoped so a `company_admin` cannot read another tenant's cockpit by editing the URL.
**Corollary worth carrying:** `nav.ts` gating the Company Report row on `rollups.view` means only a
superadmin sees that row today. Not fixed here — out of scope — but it is probably a bug.

**F2 — the cockpit hardcodes no metric keys, on purpose.** The design sketched six named north stars
("on-time delivery", "blocked work", …). Implementing that literally would have hardcoded keys
against a registry this console does not own — the frontend-first drift class that keeps producing
confident wrong answers here. `reports/overview` IS the backend's curated headline set per grain, so
the cockpit renders what it returns, capped for cognitive load, and says when there is more behind
the cap.

**F3 — a failed read and an empty one are different facts.** Every tier resolves to a tagged result
(`ok` / `forbidden` / `range` / `unavailable`) rather than degrading to `[]`. An empty list is a
CLAIM — "this business did nothing this week" — and collapsing a 403 or a dead endpoint into it is
how a console starts lying quietly.

**F4 — the demo estate had no GM department**, so the console was not drivable at all until one was
added to `lib/org.ts`. Appended rather than inserted: the ids are positional, and prepending would
have moved Web Dev off `dept-1` and SEO off `dept-3` — the latter is hard-wired into the demo login
mapping.

---

**F5 — a calendar-week compliance figure is structurally useless on a Monday.** MEASURED, not
theorised: the People tab's first render returned an EMPTY grid — "nobody was expected to check in
during this period" — because the calendar week had barely started. Technically true and completely
useless to a GM asking "is the team showing up?". The compliance read now uses a **trailing** window
(7 days for the week toggle, 30 for the month), so every day in it has elapsed. This is the one place
in the console where the toggle does not select a calendar period, which is why `GmProvenance` grew an
explicit `label` — calling a trailing 7 days "This week" would misstate which days were counted.

**F6 — `listPositions` swallows its own errors, so `scope: null` is the ONLY failure signal.** It
catches and returns `{positions: [], scope: null}`, which means a refused read reaches a consumer
looking exactly like a company with no seats. The People tab keys its failure branch on
`scope === null` rather than wrapping the call, because an empty seat list would otherwise be a claim
the console is not entitled to make. Same bug class as F3, different door.

**F7 — the demo estate had no `positions` fixture at all**, so the seats card rendered its failed-read
branch (correct behaviour, useless surface). Added, including a `retired` seat — the only way a
consumer's "a retired seat is not a vacancy" rule gets exercised, and getting that wrong makes every
reorg read as a hiring gap. The three zero-holder rows stand for the owner's real unfilled seats and
must never be given holders: a fake holder here becomes a fake headcount in every consumer.

**F8 — a pre-existing duplicate-React-key warning lives in the app shell, NOT in this work.** Two
`Encountered two children with the same key` warnings fire on `/timesheets` and on **Web Dev's**
console home — pages this session never touched. Chased far enough to exonerate the nav change:
`navFor` was tested for duplicate hrefs within a group and duplicate group labels, and has neither.
React dedupes the warning per collision site, which is why it appeared attributed to whichever page
loaded first. **Left unfixed — out of scope**, recorded so the next person does not re-chase it from
the GM console.

**F9 — modelling `/checkins/compliance` in DEMO_MODE was a deliberate contract change.**
`demoCheckins.test.ts` asserted that path returned `null` ("deliberately unmodeled"). GM-07 models it,
so that assertion was replaced by a block that tests the new behaviour rather than deleted — including
that a future-only window returns an EMPTY grid, never a roster of people at 0%, which would read as a
company-wide compliance failure.

## Session log

- **2026-08-24** — Researched GM day-to-day needs + industry dashboard practice; wrote the foundation
  blueprint (D1). Answered the owner's "move the whole business under GM?" as **no, compose** (OQ-0).
- **2026-08-24** — GM-01..04 → PROTOTYPED. Toolkit, gate, cockpit, Departments tab, five routes, the
  nav hoist, and a GM department in the demo org structure. 2795 tests / 172 files green, `tsc`
  clean, `DEMO_MODE=1 next build` green. Driven in a browser: cockpit both periods, all five tabs,
  both themes, plus the member-refusal and wrong-department paths. One real defect found by driving
  it and fixed (`83%Open` — a right-aligned metric colliding with the trailing link column).
- **2026-08-24** — F1 found while writing the gate test; gate changed from `rollups.view` to
  `reports.company.view` before it ever shipped. D2 + D3 recorded.
- **2026-08-24** — Wrote this PROGRESS file, then executed the remaining tabs. **GM-05..08 →
  PROTOTYPED.** Business Review renders the company document through the SAME `ReportPageClient` +
  `CompanyCharts` stack as `/reports/company` (verified in a browser: Weekly selected by default per
  OQ-2, comparison period, the "trailing days have no data yet — never faked as zero" banner, and the
  point-in-time / distinct-over-range class markers all present). Decisions widens the existing
  `getMyWorkQueue` projection with wait-age bands and surfaces BOTH envelope incompleteness signals
  (`included: false` and `partialSources`). People reads seats + compliance + cycles. Clients & Money
  ships the portfolio half real and the money half honestly absent.
- **2026-08-24** — New BFF reader + types: `getCheckinCompliance`, `CheckinCompliance`,
  `CheckinComplianceRow`, and the pure `rollUpCompliance` (4 tests, incl. the regression that sums
  numerators instead of averaging rates). New DEMO_MODE fixtures for `/checkins/compliance` and
  `/positions`. F5–F9 found while driving it.
- **2026-08-24** — **GM-10 → PROTOTYPED.** `e2e/gm-console.spec.ts`, 18 tests, own `gm` Playwright
  project, all passing. D4 recorded in the BFF contract.
- **2026-08-24** — Gates at close: **2961 tests / 172 of 173 files green**, `tsc` clean,
  `DEMO_MODE=1 next build` clean, 18/18 GM e2e green. The one red file
  (`rbac-capability-parity.test.ts`, 29 failures, all `hr.policy.*` / `hr.recruitment.*`) belongs to a
  **concurrent session's** in-flight HR work — this session never touched `rbac.ts` or that test.
