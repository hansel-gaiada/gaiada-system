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
| GM-02b (narrowed dept-lead view) | 1 | 0 | 0 | **1** | 0 |
| GM-09 (money tier) | 1 | 0 | 0 | **1** | 0 |
| Verification (GM-10) | 1 | 0 | 0 | **1** | 0 |
| Docs (D1..D4) | 4 | 0 | 0 | **4** | 0 |
| **Total** | **15** | **0** | **0** | **15** | **0** |

**All 15 PROTOTYPED. Nothing is blocked.** GM-02b came off the list when B1 turned out to be a
mis-framing (F10); GM-09 came off it when a real double-entry finance module landed and made B2
obsolete (F16). The single remaining gap for every row is **B4** — none of it has been driven against
live `platform-nest`, which is the whole distance between PROTOTYPED and DEV-VERIFIED.

---

## Decisions taken this session

| # | Question | Ruling |
|---|---|---|
| **OQ-0** | *"Can the whole business move under GM? And reports?"* | **No — compose, don't relocate.** `Business` is not GM-grain (a junior needs Timesheets); `Reports` is organised by GRAIN not ownership, and only the company grain is GM's; moving routes breaks deep links, the palette's tier-3 search, MCP hrefs and the agentic-native bar. Foundation doc §0. |
| **OQ-1** | Narrowed view for department heads? | **Yes — RULED AND BUILT 2026-08-25.** Department-grain only, server-narrowed. The `gmAccessFor` three-state gate. (This row read "blocked in practice" until B1 turned out to be a mis-framing — F10.) |
| **OQ-2** | Business Review default period | **Week.** `GM_DEFAULT_PERIOD` in `lib/gm.ts`, with a Week/Month toggle. |
| **OQ-3** | Cost-to-serve before real revenue? | **No.** One department's provider spend must never be summed into a group figure. The money half waits for SM-17/SM-22. |
| **OQ-4** | GM's own nav group? | **No** — hoisted to the top of `Departments`. Ordering only; no route moved. |
| **OQ-5** *(new, forced by code)* | Which capability gates the console? | **`reports.company.view`**, not `rollups.view`. See Finding F1. |

---

## Open blockers

| # | Blocker | Stops | Status |
|---|---|---|---|
| ~~**B1**~~ | ~~The UI cannot identify a department LEAD.~~ `Me` (`lib/platform.ts`) carries `userId/name/email/title/assurance/companies/roles` and nothing about positions or unit leadership; `positions.is_lead` is display-and-backfill only server-side, and the P2-05 reconciler that would turn `position_roles` into real grants is **not built**. | ~~GM-02b~~ | **RESOLVED 2026-08-25 — the blocker was mis-framed.** The UI never needed to identify a lead: `reports.department.view`'s own declaration says the **SERVER narrows to the led unit subtree**. Asking for department grain and letting Cerbos decide is the standing rule; identifying the lead in the browser would have been the second opinion that rule forbids. See F10. |
| ~~**B2**~~ | ~~**No tenant-level spend/margin endpoint exists.**~~ Only `GET engagements/:id/ledger` (engagement-scoped, search-marketing only). BFF contract §14 lists it PENDING under **SM-17 (tenant-scope remainder) / SM-22**. | ~~GM-09~~ | **RESOLVED 2026-08-26 — overtaken by events, not by a workaround.** A real double-entry finance module landed (`platform-nest/src/modules/finance`, Cerbos-authorized, `finance_profit_and_loss()` in Postgres). Revenue and margin now come from the BOOKS at company grain. The SEO engagement ledger — the thing OQ-3 forbade summing — is still the wrong source and is still not used. See F16. |
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
| **GM-02b** | OQ-1's narrowed department-head console. | **PROTOTYPED** | Three access states in `lib/gm.ts` (`gmAccessFor` -> `full` / `narrowed` / `none`). A narrowed lead gets the console with **no company tier at all** — not zeroed, not a refusal note where numbers go — plus a banner stating the absence, and the period toggle relocated onto the Departments card (it normally rides the company card). The Business Review declares itself `companyGrainOnly` and refuses a narrowed lead with its own wording, distinct from the console-wide denial. `gm.test.ts`'s "refuses a department manager" expectation **flipped deliberately** and says so in the test body. |
| **GM-09** | The money tier for real. | **PROTOTYPED** | `GmMoneyCard` — revenue, net margin, overdue receivables — on the cockpit (compact, last) and the Clients & Money tab (full, with the worst 90+ payers). Reads `finance/profit-and-loss` + `finance/ar/aging`, gated by `listPeriods` so *forbidden* / *no fiscal calendar* / *real books* render as three different things. Arithmetic is pure and tested (`lib/gmMoney.ts`, 13 tests). New `finance.statement.view` + `finance.ar.view` capability mirrors, accepted by the 1151-pair parity guard. |

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

**F10 — B1 was a mis-framing, and the capability declarations said so all along.** GM-02b was parked
as "blocked: the UI cannot identify a department lead". True, and irrelevant.
`reports.department.view`'s comment in `CAPABILITIES` reads *"department-grain (Cerbos
`read_department`) — **SERVER narrows to the led unit subtree**"*. The console asks for department
grain and Cerbos decides which units come back; the browser never needs to know who leads what.
Determining it client-side would have been the "second opinion" the mirror rule explicitly forbids —
so the blocker was created by reaching for the wrong mechanism, not by a missing one. **Lesson worth
keeping: when a UI blocker is "we cannot determine X about the principal", check whether the server
already determines X and narrows for you.**

**F11 — GM-09 is a DATA gap, not an endpoint gap, so it needs a ruling rather than code.** The only
money data in the estate is per-engagement search-marketing cost-to-serve. Two honest options, both
requiring an owner call:

1. **Wait for SM-17/SM-22** to define real tenant-scoped spend. The money tab keeps its
   `BackendPending` banner. (Current state.)
2. **Ship a search-marketing-only figure, labelled as exactly that** — "SEO provider spend (standard
   rates)", never "group cost". Useful, honest, and still not the group's money.

What must NOT happen is option 2 rendered under a company-level heading, which is what OQ-3 ruled out.
Writing the endpoint without picking between these would just move the ambiguity into the backend.

**F12 — the DEMO_MODE reports fixture denied department grain to every non-superadmin**, hardcoding
`elevated = userId === "demo-hansel"`. That contradicts §8, where a unit lead reads department grain and
the server narrows. Fixed, *including the narrowing*: `demoReports.ts` now carries a `LED_UNITS` map, so
the manager identity sees exactly one department where the GM sees five. A fixture that answered
all-or-nothing would have let the narrowed console look correct while never exercising the one behaviour
it is built on.

**F13 — a test regex matched the feature's own copy.** `REFUSAL = /limited to group executives/i`
reported a narrowed lead as denied, because the narrowed banner and the company-only refusal both
contain that phrase — correctly, since it is the true boundary in all three cases. Three states need
three distinguishable strings, and an assertion must key on the one it means. Tightened to the denial's
distinctive opening clause.

**F14 — the GM e2e suite became worker-count-dependent because the app grew around it, not because
the suite changed.** All 25 tests passed 8-worker parallel on 2026-08-24. On 2026-08-25, after the
finance workspace and the LMS learner player landed from concurrent sessions, 22 of 25 failed at the
default worker count — and the same 25 passed at `--workers=2`. `next build` went from ~20s to ~72s
over the same window, which is the tell: `npm run e2e` runs `next dev`, routes compile on first hit,
and this suite touches ~8 routes across two identities, so 8 workers produce a first-compile storm that
pushes navigations past the config's timeouts. **Nothing about the GM console regressed.** Pinned with
file-scope `test.describe.configure({ mode: "serial" })` and the reasoning written into the file —
a suite whose green depends on the worker count is not evidence, the same conclusion
`e2e/social-console.spec.ts` reached for its own (different) race. Verified stable across two
consecutive default-worker runs after the change.

**F15 — version drift, caught only by re-checking.** This session's GM-02b changelog entry was written
as `0.50.0` against a tree whose `MODULES.md` said `0.48.0`. By the time it was re-checked, HEAD had
moved four commits and `MODULES.md` said **`0.51.0`** — so committing the entry as written would have
*downgraded* the module version table. Renumbered to `0.52.0`, the first genuinely free number above
HEAD. **Also noted in passing, and not this program's to fix:** HEAD's changelog carries **two
different entries both numbered `0.51.0`** (the cap table, and the network security console), each from
a different concurrent session. In a shared checkout, a version number claimed in a working tree is not
a version number reserved — re-read `MODULES.md` immediately before committing, never at the moment the
entry is drafted.

**F16 — GM-09 was correctly blocked, and then the ground moved.** For the whole build the only money
data in the estate was `GET engagements/:id/ledger`: one department's search-marketing provider spend.
OQ-3 forbade summing it into a company figure, so the money tier waited behind a `BackendPending`
banner. **Waiting turned out to be the right call for a reason nobody predicted** — a real
double-entry finance module landed (`finance_profit_and_loss()` in Postgres, Cerbos-authorized
statements, AR/AP aging), and revenue and margin became available from the books at exactly the grain
the cockpit needed. Had the engagement-ledger shortcut been shipped, the console would now carry a
figure that disagrees with the general ledger, and the fix would be a migration away from a number
people had started quoting.

**Generalisable, and the reason this is written down:** when the honest answer is "the data to answer
this does not exist", a `BackendPending` banner is not a stalling tactic — it is a position that stays
correct while the estate changes around it. The failure mode is not waiting too long; it is
manufacturing a number to avoid an empty space.

**F17 — the capability mirror was short, and the shortfall is estate-wide.**
`finance.statement.read` is held by `company_admin`, `finance_manager`, `finance_staff`, `owner` and
`platform_admin`. Only the first and last **exist in `rbac.ts`'s `Role` union** — `finance_staff`,
`finance_manager` and `owner` have no member at all, so those principals resolve to ZERO capabilities
in the UI. That is the same defect class as the Gap 1/2/3 comments already in that file, it affects the
whole `/finance` console rather than the GM tier, and widening the union changes what every capability
check in the app returns for three roles. **Reported, not fixed inside a GM ticket.** The GM money card
degrades to its honest refusal state for them rather than to a wrong number, so the shortfall is
visible rather than dangerous.

**F18 — DEMO_MODE modelled no finance authz whatever.** `financeDemo` did not even take a `userId`:
every identity, including a plain member, was served the company's books. Not a harmless fixture
shortcut — DEMO_MODE exists so negative-permission rendering can be driven in a browser, and a surface
whose refusal path is unreachable is a surface whose refusal path nobody has ever seen. Fixed with a
`FINANCE_READERS` set mirroring the real holders, returning **403** (not empty fixtures), because
`lib/finance.ts` deliberately distinguishes a refusal from absent data and empty fixtures would have
destroyed the one distinction that file exists to preserve. Third fixture-fidelity gap this session
after F12 and F7 — worth treating as a pattern rather than three coincidences.

**F19 — the e2e ordering assertion caught a real mistake in my own implementation.** The money card
first shipped BETWEEN the two operating tiers instead of after them, contradicting the cadence rule
the console is built on. The first version of that assertion searched page text for "Departments" and
matched the breadcrumb, which would have passed regardless; rewritten to assert on card HEADINGS, it
failed and named the real defect. **An assertion that cannot fail is worse than no assertion**, because
it converts an unchecked thing into a thing that looks checked.

**F20 — `mode: "serial"` was the wrong fix for F14, and hid failures.** It makes every later test in a
group SKIP when one fails, so a single stale assertion reported "1 failed, 21 did not run". Replaced
with `fullyParallel: false` on the `gm` project: identical single-worker sequencing, independent
pass/fail per test. Separately, several "failing" runs during this work were **my own orphaned headless
browsers** (23 of them) saturating the machine — the suite passed in 20s once they were cleared.
A slow, shared machine produces failures that look exactly like defects; check the machine before
believing the report.

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
- **2026-08-25** — **GM-02b -> PROTOTYPED**, off the blocked list. B1 re-examined and found to be a
  mis-framing (F10). `lib/gm.ts` gains `gmAccessFor` (three states); the cockpit drops the company tier
  for a narrowed lead and relocates the period toggle; the Business Review declares itself
  `companyGrainOnly`. New manager-tier demo identity (`manager@gaiada.com` -> `dept-manager`, one
  `manager` grant and nothing else) plus a `manager` entry in `e2e/personas.ts` — an authorization tier
  that cannot be driven is a tier nobody verifies. `demoReports.ts` gains lead narrowing (F12).
- **2026-08-25** — e2e grew from 18 to **25 tests**, all passing: the narrowed lead gets the console,
  has NO company card, is told why, can still switch period, is refused the Business Review with the
  company-only wording, and reaches the other four tabs. Verified in a browser — the manager sees one
  department (SEO), the GM sees five.
- **2026-08-25** — Gates at close: **3146 tests / 175 files ALL green**, `tsc` clean,
  `DEMO_MODE=1 next build` clean, 25/25 GM e2e green. (Yesterday's `hr.*` parity failures were the
  concurrent session's and are resolved on their side.)
- **2026-08-25** — **GM-09 is the only open row, and should stay open until the owner rules** (F11).
- **2026-08-25 (recheck)** — Re-verified everything against the moved tree rather than trusting the
  earlier run. HEAD had advanced four commits (finance workspace, LMS player, two releases). Results:
  `tsc` clean · **3147 tests / 175 files green** · `DEMO_MODE=1 next build` clean · GM e2e **25/25**
  after F14's serial fix, stable over two consecutive runs. Two real problems found and fixed that the
  stale verification had hidden: F14 (worker-count-dependent e2e) and F15 (version drift that would
  have downgraded `MODULES.md`). One stale doc row corrected too — the OQ-1 decision line still read
  "BLOCKED in practice" after GM-02b shipped.
- **2026-08-25 (recheck)** — Confirmed **GM-01..08 + GM-10 are committed** (`e3624652 feat(gm)`, 24
  files) and **all 15 GM-02b files are still uncommitted**. `gmAccessFor` is absent from HEAD, which is
  the cheap proof.
- **2026-08-26** — **GM-09 -> PROTOTYPED. The tracker has no blocked rows left.** B2 dissolved when the
  finance module landed (F16). Built `lib/gmMoney.ts` (pure, 13 tests), `GmMoneyCard` (three distinct
  states behind the `listPeriods` gate read), the cockpit money tier and the real money tab. Added
  `finance.statement.view` + `finance.ar.view` capability mirrors — accepted by the 1151-pair parity
  guard — and gave DEMO_MODE's finance store real authz (F18).
- **2026-08-26** — Owner rulings folded in: money answers **"are we making money?"** first (revenue,
  net margin, overdue AR); **compose and link out** to `/finance`, never a second finance console;
  **active company only**; and **add the capability mirror** rather than leaning on server refusal.
- **2026-08-26** — Gates: `tsc` clean · **3209 tests / 177 files green** · `DEMO_MODE=1 next build`
  clean · GM e2e **30 tests**. F17 (three finance roles missing from the UI `Role` union) is left as a
  reported estate-wide gap, deliberately not widened inside this ticket.
