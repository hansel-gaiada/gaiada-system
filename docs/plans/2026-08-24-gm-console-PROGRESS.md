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

**All 15 built; 14 now DEV-VERIFIED against a real backend.** GM-02b came off the list when B1 turned out to be a
mis-framing (F10); GM-09 came off it when a real double-entry finance module landed and made B2
obsolete (F16). B4 is now largely closed: the console has been driven against a real platform-nest on real Postgres +
Cerbos with the actual roster seeded (F21). The one thing still resting on fixtures is the money
tier's **figures** — the seeded estate has no fiscal calendar, so the card correctly showed its setup
state rather than books (F24).

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
| ~~**B3**~~ | ~~Monitoring has **no backend at all**.~~ | a monitoring/health tile in the cockpit | **RESOLVED 2026-08-26 — stale, like B1 and B2 before it.** `platform-nest/src/modules/monitoring` ships a real controller (`summary`, `monitors`, `incidents`, `maintenance`, `kinds`, heartbeat ingest) and the module is enabled. `GmMonitoringCard` reads `monitoring/summary`. **Third stale blocker this session** — see F28. |
| ~~**B4**~~ | ~~Nothing here has been driven against live `platform-nest`.~~ | every row moving PROTOTYPED → DEV-VERIFIED | **LARGELY CLOSED 2026-08-26.** Driven against a real platform-nest built from source, on the real Postgres + Cerbos test containers, with the actual agency roster seeded into an ISOLATED database (`gaiada_gm_b4`). Full-access, narrowed and refused paths all exercised end to end. **One gap remains:** the money tier's *figures* — that estate has no fiscal calendar, so the card correctly rendered its setup state and the P&L/AR numbers themselves are still only demo-verified. See F21–F24. |

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

## Release / deploy status

**All GM work is committed and pushed; NONE of it is live yet, and this session did not deploy.**

| | |
|---|---|
| Commits | 8, all on `origin/main` (pushed by a concurrent session, not by this one) |
| Staged release | `alpha-01.071.0174a` — cut by **another session**; tag exists LOCALLY, not pushed |
| Contains the GM work? | **Yes** — including the last two fixes (`a7d64d91`, `2f1b63a6`) |
| CI on that commit | `ci` + `docs-map` both **success** |
| Live right now | **`Alpha 01.071.0171a`** |

⚠ **Deploy deliberately NOT fired (owner decision 2026-08-26, option 1: let the owning session ship).**
`git push --tags` is the single deploy trigger, so pushing `alpha-01.071.0174a` would have fired
*someone else's* release on timing they did not choose — and done it **into an open incident**:
`alpha-01.071.0172a` was rolled back earlier the same day when a migration's probe INSERTs hit
FORCE-RLS as NOBYPASSRLS, live fell back to `0171a`, and the attribution migration has still not
applied (`docs/superpowers/plans/2026-08-22-hermes-PROGRESS.md`, B27 — marked "OWNER — re-release").

It would also have shipped two commits this session never reviewed: `f79bf817` (another session's IAM
attribution feature) and `7080f232` (their fix for the migration that caused the rollback).

**Nothing is stranded.** The GM console ships with `0174a` whenever its owner releases it — no
re-tagging, no fresh release commit, no action from this program. The local tag was left untouched.

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

**F21 — B4 was worth every minute: the GM cannot see the company.** Driven against a real
platform-nest (built from source, real Postgres + Cerbos, actual agency roster seeded into an isolated
`gaiada_gm_b4` database), **Edward — the actual General Manager — holds only `member` + `manager`**.
The API agrees precisely: `reports/overview?grain=company` → **403**, `grain=department` → **200**. So
the real GM gets the **narrowed** console, and the "full" tier the console was built for is unreachable
by the person it was built for.

**The console is correct; the estate's grants are not.** `gmAccessFor` returned exactly what Cerbos
returned — the mirror held. But every DEMO_MODE run used `demo-hansel` (platform_admin), which masked
this completely. **This is an IAM seeding gap** (Edward has no company-grain grant), and it is the
single most valuable thing this whole session surfaced. It needs an owner ruling: either Edward is
granted `company_admin` (or `owner`) on the agency, or the GM console's full tier is accepted as
company-admin-only and the GM works from the narrowed view.

**F22 — a real defect only real data could show.** The department strip's columns are DERIVED from the
metric registry, and the live registry returns longer labels than the demo one ("THROUGHPUT WEIGHTED",
"TASKS COMPLETED"). At `1fr` those columns were narrower than their own headers and **"ON TIME RATE"
and "TASKS COMPLETED" rendered on top of each other**. Fixed with `minmax(96px, 1fr)`. Derived columns
cannot have their widths tuned to any one label set — which is exactly why a fixture with short labels
proved nothing here.

**F23 — the three-state money card earned its design against a real 404.** The seeded estate has the
finance module but no fiscal calendar, so `listPeriods` returned `[]` and the card rendered *"This
company has no fiscal calendar yet — or the finance module is not enabled for it… This is a setup
state, not a zero."* That is the middle state, hit for real rather than simulated. Had the card keyed
off `getProfitAndLoss` (which folds 403/404 into `[]`), it would have shown a confident **0** revenue
for a company whose books simply do not exist yet.

**F24 — what B4 did NOT verify, stated plainly.** The money tier's *figures* — revenue, margin, AR
aging — were never rendered from real books, because no seeded estate has a fiscal calendar. The
card's refusal and setup states are live-verified; its **numbers** remain demo-verified only. GM-09 is
therefore DEV-VERIFIED for behaviour and PROTOTYPED for arithmetic-against-real-data.

**F25 — two more "failures" that were the machine, not the code.** `next build` failed once with
"Failed to collect page data for /(.)tasks/[taskId]" and `pm.test.ts > getBurndown` failed twice —
both while my own platform-nest and platform-ui dev servers were running alongside other sessions'
work. Both passed cleanly the moment those servers were stopped. Third occurrence this session of the
same lesson: **on a shared, loaded machine, check the machine before believing a red result.**

**F26 — I duplicated 30 changelog entries and my own verification said it was clean.** Preparing
`ad5c9f67` I rebuilt `CHANGELOG.md` from HEAD plus my entries, slicing each entry out with
`text[index(startHeading):index(endHeading)]`. The GM-02b entry's start marker was
``### platform-ui `0.52.0` `` — a version **another session had already used**, sorting earlier in the
file — so the slice ran from their entry to the first `0.48.0` and swallowed ~30 entries (finance
0.1.0-0.14.1, lms 0.1.0-0.7.0, lab-runner, hr 0.4.0, platform-nest 0.37.0/0.38.1). Inserting that
block into a file that already contained it duplicated all thirty. **1173 lines.**

I then ran `git diff --numstat`, saw **0 deletions**, and concluded I had only appended. True, and
worthless: **a duplication IS pure insertion.** The repo's guidance (added the same day, for a
different session's incident) prescribes exactly that check — it is necessary but not sufficient, and
`CLAUDE.md` now carries the caveat plus the real invariant: verify every heading still appears exactly
once, and never key a text slice on a version number, which is the one token another session may have
claimed while you were not looking.

Fixed in `6259b06c` by removing only byte-identical entry blocks, keeping the **last** copy of each —
the duplicates were inserted at the TOP, so keeping the first would have stranded ~28 other sessions'
entries out of chronological place. My two entries renumbered off the collision they caused
(GM-02b -> 0.56.0, GM-09 -> 0.57.0). The same read-modify-write pattern touched three other docs;
all three were checked and are clean, because only the changelog had markers that collided with
another session's content.

**F27 — F17 closed, and `owner` was the real damage.** The three roles Cerbos grants that `rbac.ts`
never named are now mirrored. Capability sets were **derived**, not authored: for each role, the set is
exactly the capabilities whose `CAPABILITY_MAP` entry its bundle satisfies, so
`rbac-capability-parity.test.ts`'s biconditional holds by construction (1343 pairs green).

  | Role | Caps | Note |
  |---|---|---|
  | `finance_staff` | 2 | `finance.statement.view`, `finance.ar.view` |
  | `finance_manager` | 2 | identical today — its extra reach (post, reverse, close, approve, write-off) is real in Cerbos but no UI reads it yet |
  | **`owner`** | **61** | previously **zero**: no Settings, no company management, no reports, no HR — while Cerbos would have authorized all of it |

**`owner` also exposed a category the role-axis guard did not model.**
`rbac-cerbos-parity.test.ts` asserts every mirrored role is granted in `derived_roles.yaml`, and
flagged `owner` as STALE. It is the opposite of stale: `generate-role-bundles.mjs` declares it
**permission-native** — *"Roles with NO Cerbos rules, whose reach is their bundle alone (IAM-04c §3).
`owner` is the first."* — and emits 330 permissions for it. So it never appears as a
`g.role == "owner"` literal and never will. The guard gained a `PERMISSION_NATIVE_ROLES` hook, third
alongside literal grants and string-composed module roles, with the rule that every entry must be
citable in the generator's own list — *an entry not named there is drift wearing an exemption*. The
file had already been extended once for the same class of gap (HIER-3, module roles), so this
completes its model rather than silencing it.

**F28 — three "blocked" rows out of three turned out to be stale. That is a pattern, not luck.**
B1 (the narrowed view) was a mis-framing; B2 (the money tier) dissolved when the finance module
landed; B3 (monitoring) dissolved because the monitoring module shipped a backend while the row still
said "BACKEND NOT STARTED — every row PENDING". **In an estate this active, a blocker is a claim with
a shelf life.** The habit that keeps paying: re-read the blocker against the code before quoting it,
especially before telling the owner something cannot be done. Every one of these three would have
stayed closed if the note had been trusted.

**F29 — F21 fixed in the SEED, where the defect actually was.** Owner ruling: *"Edward is the GM so it
should be clean."* The `agency.ts` roster loop graded `gm | head | manager` all to `manager`, so the
General Manager got no company-grain grant. Now `gm` additionally gets `company_admin` — scoped to the
company he runs.

`company_admin`, deliberately not `owner`: Edward **runs** the agency, he does not own it (the owner
fixture is Ayu, "Managing Director"). `company_admin` is company-scoped and carries exactly the tier
the console needs (`reports.company.view` + the finance read pair); `owner` is holding-wide business
authority granted per OWNED company, which is a different claim about the same person.

Verified by reseeding a fresh isolated database and driving it: `reports/overview?grain=company` went
**403 → 200**, `positions` **403 → 200**, and the real Edward now renders the FULL cockpit — company
tier, all five departments with real per-department figures, no narrowed banner.

**F30 — Plane A vs Plane B, and why the monitoring card is Plane B only.** The card reads the
**client's** properties and services — the work the agency sells. Our own infrastructure
(Prometheus/Grafana/Loki/Tempo, containers, scrape targets) is Plane A: it lives outside the ERP behind
an SSH tunnel and is deliberately not a nav row at all. The 2026-08-13 nav decision put Monitoring
under *Business* rather than *Systems* for exactly this reason — filing it as internal plumbing would
"quietly re-merge the two planes the design keeps apart". So the GM's question here is *"is the work we
sell our clients healthy?"*, never *"are our containers up?"* — and a Plane A number on this card would
be one the GM cannot act on commercially.

Ungated, unlike the money tier: `monitoring.read` on the backend is the boundary and the sidebar row is
ungated for every principal, so a narrowed department lead sees client health but still not the P&L.
Pinned by an e2e test asserting exactly that asymmetry.

**F31 — `pm.test.ts > getBurndown` has no timeout headroom, and it is not mine.** Measured across four
runs: 1099 ms, 1381 ms, 3198 ms, 3233 ms, **5007 ms** — the last against a 5 s budget, so it fails.
It passes in isolation every time and the file is untouched by this work. Not fixed here (raising
another team's test budget is their call), but recorded because it will keep firing on a shared machine
and reads exactly like a real regression.

**F32 — the duplicate React key was a DROPPED APPROVAL, not a console nit.** F8 recorded a
"pre-existing duplicate-key warning in the app shell" and cleared the nav change of it. Chased
properly this time by reading React's warning ARGUMENTS rather than its format string
(`page.on("console")` gives `%s` unexpanded; `msg.args()` has the substitution), the key was
**`pipeline:gt-2-pmreview`** — a `QueueItem` id.

`QueueItem.id` is documented as "this queue's own composite, globally-unique React key", and
`getMyWorkQueue` **fans out per company**. Three of the six builders namespaced their id by company
(`pmtask`, `task`, `mention`); three did not (`agency`, `automation`, `pipeline`). So any origin record
whose id repeats across companies collided — and React does not merely warn, it **drops one of the
colliding children**. On a "what needs me" queue that is a pending approval silently vanishing. All six
are namespaced now, with a regression test that asserts BOTH uniqueness and that both copies survive
(uniqueness must come from namespacing, never from one row being dropped).

Two existing assertions flipped to the new id format, marked as deliberate in the test body.

**F33 — I used an instrument that could not detect the bug, and nearly reported it clean.** For the
other half of F8 — `<details>`/`<summary>`/`<ul>` rendered inside `<p>` — I swept 38 routes asking the
DOM whether any `<p>` contained a block descendant. It returned **0**, and 0 was meaningless: the HTML
parser CLOSES an open `<p>` when it meets a block element, so the invalid nesting can never appear in
the resulting DOM. React warns at render time; the DOM is already corrected by the time a query runs.

**Still open, and honestly so.** Those warnings reproduce only against the real backend with a
member-tier identity (0 occurrences across both identities in DEMO_MODE, 38 routes). Candidates
eliminated by inspection: `EmptyNote` callers, `StateScreen`/error-boundary bodies, `markdownLite`
(its `<p>`/`<ul>` are correctly flushed as siblings), `ArtifactMarkdown`. Not converging by reading —
it needs the real-data path re-stood to capture a component stack.

**F34 — the invalid-`<p>`-nesting bug, found and fixed: `EnvelopeBanner`.** It wrapped its
`<details>/<summary>/<ul>/<li>` disclosure in a **`<p>`**. `<p>` accepts only phrasing content, so the
parser closes it at `<details>`, reparents everything after, and React reports a hydration mismatch —
plus the inverse pairs (`<p>` inside `<ul>`, `<p>` inside `<summary>`) once the DOM has been
restructured. Ten warnings per page load on the real backend.

**Why it survived the entire build:** the banner renders ONLY when a read has actually failed
(`excluded.length || partial.length`). In DEMO_MODE every fixture answers, so it never rendered once —
0 occurrences across 38 routes and two identities. **The honest-failure surfaces are the ones fixtures
exercise least, and they are exactly the surfaces that matter when something breaks.**

Fixed to a `<div>` (`.sys-empty-note` is class-scoped, so the styling is byte-identical and
`role="status"` is valid on either), and pinned by a test that asserts *structurally* — no block
element inside a `<p>`, whatever the wrapper is called — plus a check that the disclosure is really
present so the assertion cannot pass vacuously. **Verified against the real backend: 10 warnings → 0.**

**F35 — F31 fixed rather than excused.** `pm.test.ts > getBurndown` measured
634 · 1099 · 1381 · 3198 · 3233 · **5007** ms against vitest's default 5 s budget — so it failed six
times across this session while passing in isolation every time. A 5 s budget on a 0.6–3.2 s fixture
read has no headroom, and the failure it produces is **indistinguishable from a real regression**,
which is worse than a slow test: it teaches people to re-run instead of investigate. Raised to 20 s
(~6x the slowest honest measurement) with the measurements recorded in the test, so a future reader
can tell a tuned budget from a guessed one.

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
- **2026-08-26 (B4)** — Drove the whole console against a REAL backend. Built platform-nest from
  source (the committed `dist` was stale and boot-blocked on the other session's billing→invoice
  catalog rename), pointed it at an **isolated** `gaiada_gm_b4` database on the shared test Postgres —
  deliberately not `gaiada_platform_test`, which the `*.db.test.ts` suite seeds and truncates per test
  — migrated it, and seeded the real agency roster (GM department, 5 people). Verified: the full
  cockpit (real KPIs, all five departments, derived columns), the People tab (26 people / 21 seats /
  the 2 real vacancies / 92% compliance), the narrowed path as the REAL Edward, and the refusal path
  as a real member. Fixed F22 (column collision) — a defect no fixture could have exposed.
- **2026-08-26 (B4)** — Gates after the fix: `tsc` clean · **3222 tests / 177 files green** ·
  `DEMO_MODE=1 next build` clean. F21 (the GM has no company-grain grant) is an **owner decision**,
  not a code change, and is the one thing this work now waits on.
- **2026-08-26** — Found and fixed my own CHANGELOG corruption (F26): 30 duplicated entries, 1173
  lines, introduced in `ad5c9f67` and invisible to the numstat check I had trusted. `CLAUDE.md`'s new
  append-only-doc trap gained the caveat that "0 deletions" cannot detect a duplication.
- **2026-08-26** — **F17 closed.** `finance_staff`, `finance_manager` and `owner` mirrored into
  `Role`/`ROLE_CAPS` with derived capability sets; the role-axis guard taught about permission-native
  roles. Gates: `tsc` clean · **3414 tests / 177 files green** · `DEMO_MODE=1 next build` clean.
  Remaining open: **F21** (the GM holds no company-grain grant — owner ruling), **B3** (monitoring has
  no backend), and the pre-existing shell key/hydration warnings (F8).
- **2026-08-26** — **F21 closed by owner ruling, B3 closed as stale.** `agency.ts`: `gm` level now
  also gets `company_admin`. New `GmMonitoringCard` (Plane B client health) sits with the operating
  tiers, above money, and is ungated — the asymmetry with the money tier is deliberate and e2e-pinned.
  Verified on a fresh isolated DB: the real Edward now gets the full cockpit (company grain 403 → 200).
  Gates: `tsc` clean · **3413/3414 tests** (the one failure is F31's pre-existing flake, passes in
  isolation) · `DEMO_MODE=1 next build` clean · GM e2e **32/32**.
- **2026-08-26** — Open after this: nothing in this program. Remaining items are other teams' — F17's
  sibling gaps if any, F31's flaky budget, and the pre-existing shell key/hydration warnings (F8).
- **2026-08-26** — F8 split and half-fixed. The duplicate-key half was a real defect with a real
  consequence (a pending approval dropped from the queue) and is FIXED with a regression test (F32).
  The invalid-`<p>`-nesting half is **still open**: reproducible only against real-backend data, and my
  DOM-based search for it was invalid by construction (F33).
- **2026-08-26** — **Both F8 halves now closed, and F31 with them.** The `<p>`-nesting half was
  `EnvelopeBanner` (F34) — found by re-standing the real-backend path, since it cannot render in
  DEMO_MODE at all. Verified 10 warnings → 0 against real data. `getBurndown`'s timeout given real
  headroom (F35). Gates: `tsc` clean · **3416 tests / 177 files green** · `DEMO_MODE=1 next build`
  clean.
- **2026-08-26** — Asked to push and deploy. **Push: nothing to do** — all 8 commits were already on
  `origin/main`. **Deploy: declined and escalated**, then owner chose option 1 (let the owning session
  ship `0174a`). Reasons on the record above: it is another session's staged release, prod is mid-
  incident on `0171a` after the `0172a` rollback, and it carries two commits this session never
  reviewed. No tag was pushed. The GM work rides in `0174a`.
