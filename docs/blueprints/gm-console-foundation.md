# GM console — foundation blueprint

**Status:** `PLANNED` — design only, no code written. · **Scoped:** 2026-08-24
**Subject:** the **Office of the GM** — a department console for `d-gm`, the oversight department at
the root of the agency's org tree.

---

## 0 · The owner's question, answered first

> *"I think our whole business can be moved to be under GM? And reports also?"*

**No — and the reason matters more than the answer.** What is actually wrong today is not that
`Business` and `Reports` sit in the wrong sidebar group. It is that **GM has no console at all**, so
the only way Edward can read the business is to visit eleven `Business` rows and four `Reports` rows
one at a time and hold the synthesis in his head. Moving those rows under GM would relabel that
problem, not fix it.

Three concrete reasons a wholesale move is the wrong shape:

1. **`Business` is not GM-grain.** `/project-management`, `/timesheets`, `/deliverables`,
   `/meetings`, `/clients` are used by *every* staff principal — a junior developer needs Timesheets.
   File them under GM and either everyone gets a GM console (which makes "GM" meaningless as a
   department) or the staff lose the route they use daily.
2. **`Reports` already has the right axis, and it isn't ownership — it's GRAIN.** The reports module
   is `person | project | department | company` with a per-grain Cerbos matrix
   ([FRONTEND-BFF-CONTRACT §15](../FRONTEND-BFF-CONTRACT.md), §8 matrix). "My Report" is *self*-grain
   — that is `/me` territory. Only the **company grain** is exec-only. "Move Reports under GM" moves
   three grains that are not GM's in order to relocate the one that is.
3. **Moving routes breaks things that do not announce themselves.** Deep links, the command palette's
   tier-3 search, MCP tool hrefs, and the agentic-native bar (*every capability must work identically
   under a human, under n8n, and under an agent*). The 2026-07-23 dept-console IA redesign set the
   precedent deliberately: it **regrouped without changing a single path**.

**What to do instead — compose, don't relocate.** The GM console *reads across* the surfaces that
already exist and drills **into** them. Every existing route keeps its URL and its owner; the GM
console becomes the altitude above them. Concretely, only two nav changes are proposed (§7), and
neither moves a route.

---

## 1 · What GM is in this estate (audited 2026-08-24 against code)

| Fact | Where |
|---|---|
| `d-gm` is a real department node named **"GM"**, with **no divisions** | `platform-nest/src/seed/roster.ts` (`AGENCY_DEPTS`) |
| It is the **root** of the department spine — `DEPT_PARENT["d-gm"] = null`; Web Dev, SEO, Creatives, Social all parent to it | `roster.ts` (`DEPT_PARENT`) |
| **Edward**, `edward@gaiada.com`, `title: "General Manager"`, `level: "gm"`, `lead: true` — the only `gm`-level seat in the roster | `roster.ts` (`STAFF`) |
| GM is seeded with **oversight projects, not client delivery** — "which is what its people actually own" | `platform-nest/src/seed/departments.ts` |
| GM holds seats via the Phase-2 positions machinery; `is_lead` is display + backfill only, and the reconciler that turns `position_roles` into real grants (**P2-05**) is **not built** | `platform-nest/src/seed/positions.ts` |
| **GM has no toolkit.** `TOOLKITS = [WEB_DEV, CREATIVES, SEO, SOCIAL_MEDIA]`, so `toolkitFor("GM")` returns `genericToolkit` — a Home-only shell | `platform-ui/src/lib/deptToolkits.ts` |
| `deptSlug("GM") === "gm"` is already pinned by a test | `platform-ui/src/lib/deptToolkits.test.ts` |

**Reading of those facts:** GM is not a delivery department that happens to sit at the top. Its craft
*is* oversight. So its console's craft groups must be about **reading and deciding**, never about
producing — which is what separates this build from Web Dev's and makes the universal
Home · Project Management · Connections spine still correct (GM's own oversight projects are real work
and belong in the inherited PM group).

### Why a department console and not a top-level `/gm`

The toolkit registry keys on the department's **name slug**, not its id. So registering a `gm` toolkit
means **every company in the holding gets the same GM cockpit automatically**, scoped to its own
tenant — which is exactly the holding-OS vision in the root `CLAUDE.md`: shared-service departments
serving N companies. A bespoke top-level `/gm` route would duplicate the shell, skip the My-work rail,
and have to grow its own multi-company story later. Department console wins on all three.

---

## 2 · What a GM actually needs, daily

Synthesised from the operating-cadence literature (§9) and reduced to the questions Edward can only
answer today by opening five tabs:

| Cadence | The question | Where the answer lives today |
|---|---|---|
| **Daily, < 2 min** | *Is anything on fire that needs me?* | scattered: `/approvals`, ball-held, blocked tasks, monitoring |
| **Daily** | *Did the departments show up?* | `/checkins/compliance`, per-dept consoles |
| **Weekly** | *Are we on plan — inputs before outputs?* | `/reports/company` + four `/reports/department` visits |
| **Weekly** | *Which client work is slipping, and who is holding it?* | `/pipeline`, `/project-management`, per-dept `ball` tabs |
| **Monthly** | *Are we making money on this work?* | **nowhere** — see §5's money gap |
| **Monthly / cycle** | *Do we have the people, and are they being appraised?* | `/organization/positions`, `/appraisals/cycles` |

The two shapes that follow from that table:

- **A cockpit** (Home) that answers *"is anything on fire"* in one screen, ≤6 tiles, every tile a link.
- **A Business Review** (a tab) that answers the weekly question in a **fixed, boring, identical
  layout every week** — inputs, then outputs, then money, department by department. Amazon's WBR
  discipline: the layout never changes, so the *deltas* are what the eye finds. This is the opposite of
  an explorable BI tool, and deliberately so.

---

## 3 · Proposed toolkit

```
slug:    "gm"
label:   "GM"
mission: "Office of the GM — the whole business, one altitude up."
```

| Group | Tabs | Path | Notes |
|---|---|---|---|
| **Home** *(inherited)* | Home | `` | **Replaced**, not reused — see §4. The only toolkit whose Home diverges from the template. |
| **Project Management** *(inherited)* | Projects · Board · Ball · Timeline · Charts · Activity | unchanged | GM's own oversight projects. Zero new code. |
| **Command** | Business Review | `review` | The WBR. Fixed spine, period-selected, seal-state-marked. |
| | Decisions | `decisions` | The GM's own queue: approvals awaiting GM, dept-head assignment requests, escalations, ball-held-too-long. |
| **Oversight** | Departments | `depts` | One row per department — health, load, compliance, headcount. Drills into each dept console. |
| | Clients & Money | `money` | Client portfolio, engagements, cost-to-serve vs price. **Partly blocked — §5.** |
| | People | `people` | Headcount vs vacant seats, appraisal-cycle progress, check-in compliance, leave load. |
| **Connections** *(inherited)* | Connections | `connections` | Zero new code. |

Two craft groups rather than one follows the **SEO precedent** (three craft groups, ratified as D-10)
— five tabs crammed into one group would put a five-wide secondary strip under a two-wide primary,
which reads as a flat list with extra steps. `Command` is *"what needs me"*; `Oversight` is *"how are
we doing"*. That is a distinction a reader can predict.

Launchers: `Claude` (draft the narrative), `Shared Drive`, `Looker Studio`. No GitHub, no Figma — the
GM does not produce.

---

## 4 · Home: the cockpit

Three tiers, per the dashboard-design consensus in §9 (working memory holds 5–9 elements; past ~12
KPIs engagement collapses).

**Tier 1 — North stars (≤6 tiles, every tile a link, every tile a delta vs prior period).**
Candidates, in the order a GM scans them:

1. **Needs you** — count of decisions waiting on GM → `decisions`
2. **On-time delivery** — % of milestones met this period → `review`
3. **Blocked work** — blocked tasks + the projects they sit in → `depts`
4. **Check-in compliance** — % submitted, this week → `people`
5. **Active client engagements** — count + how many are slipping → `money`
6. **Utilisation** — logged vs expected hours → `review`

**Tier 2 — Departments strip.** One compact row per department: name, health ring, active/blocked,
compliance %, on-time %. This is the middle band the exec-dashboard literature prescribes: *company
health top, department summaries middle, drill-down bottom*.

**Tier 3 — Drill-down is the existing app.** Every number links to the page that already owns it. The
GM console must not become a second implementation of the department console; it is an index over it.

Plus two non-negotiables:

- **A freshness + provenance line.** Not decoration. This estate has *sealed* and *unsealed* report
  periods, and unsealed exports are stamped `AD HOC · UNSEALED` on the artifact for a reason. A GM
  cockpit that renders a live-computed number in the same visual weight as a sealed one is a
  correctness bug, not a polish gap. Every tile carries its period and its seal state.
- **A fail-closed 403 branch.** Copy `/rollups`'s existing pattern verbatim (*"This view is limited to
  group executives."*) — see §6.

---

## 5 · What is buildable today, and what is not

The recurring bug class in this program is **frontend-first drift**: a console reads fields the backend
never sends, renders a confident wrong answer, and nothing throws. So this section is the gate.

### Live today — the cockpit's spine already exists

| Read | Endpoint / lib | Gives the GM |
|---|---|---|
| **`GET /api/:t/reports/overview`** | §15a — `grain`, `periodKind`, `start`, `end` → `{scopes:[{scopeRef, scopeName, kpis:[]}]}` | **The single most valuable endpoint for this build.** `grain=department` returns *headline KPIs per department in one call* — that is the Tier-2 strip, already built, explicitly described as the "console landing". `grain=company` is Tier 1. |
| `GET /reports/document` `grain=company` | §15a + `CompanyCharts` | The whole Business Review body — viewer, chart kit, period selector (incl. custom range) and print route **all already exist** (TR-16/17/20 landed). |
| `GET /checkins/compliance` | §15b | Compliance grid per unit, with excusals. |
| `getRollups` | `lib/entities.ts` | Cross-company metrics for the multi-company case. |
| `listProjects` + `listPmTasks` + `listMilestones` + `listProjectStatuses` | `lib/pm.ts` | Health rings — the exact math the dept console Home already runs (`computeProjectHealth`, `computeDeptKpis`), status-registry-correct. |
| `listWorkActivity` | `lib/activity.ts` | The cross-source feed, `deptId`-scopable. |
| Appraisal cycles + list | §15c | Cycle progress for the People tab. |
| Positions + vacancies | §"IAM Phase 2 — positions", `VACANCIES` in `roster.ts` | Headcount vs **vacant seats** — the org chart already carries the 10 unfilled seats as data, not fiction. |

**Consequence: the Home cockpit, Departments, People, and most of the Business Review are buildable
now, with no new backend.** That is a genuinely good position, and it is mostly thanks to
`reports/overview`.

### Blocked — the money tier

| Want | Reality |
|---|---|
| Tenant-level MTD spend / margin | **No such endpoint.** Only `GET engagements/:id/ledger` exists (engagement-scoped). Listed PENDING in §14, owned by **SM-17 (tenant-scope remainder) / SM-22**. |
| Revenue / receivables | `/billing` is `company.manage`-gated; its read surface is **not audited in this doc** — treat as unverified until someone drives it. |
| Monitoring health tile | §20: **UI prototyped, backend NOT started — every row PENDING.** A GM tile here must render the `BackendPending` shell, never a zero. |

**Ruling:** ship the operational tiers first and let the money tier arrive last. Amazon's own rule —
*financial metrics at the end of the deck* — makes this sequencing principled rather than an excuse.
The `Clients & Money` tab ships with the client/engagement half real and the money half rendering
`BackendPending` naming SM-17/SM-22, per this repo's standing convention. **An empty list is a claim**
— it must not render `0` where it means *"not built"*.

---

## 6 · Authorization — the part that is genuinely new

**The GM console is the first department console whose Home is not safe to render for every member.**
Every existing dept Home shows *that department's own* projects. GM's Home shows the whole company.
Departments rows are ungated on purpose (they come from the org structure), so without a gate a junior
who clicks "GM" in the sidebar reads company-grain KPIs.

Design:

- **Cerbos is the authority.** The company-grain read is already exec-only in the §8 matrix, and
  `rollups.view` is already the UI mirror gating `/rollups` and `/reports/company`. **Reuse
  `rollups.view` for v1 rather than minting `gm.view`** — a new capability with the same meaning is a
  second source of truth, and `lib/rbac.ts` is a mirror, never the source.
- **Fail closed, and say so.** Every GM tab renders the `/rollups` 403 branch on refusal — a *page*
  that explains the limit, not a 404 and not an empty grid. The standing ruling applies: a UI-only
  gate that hides a page the server would serve reads as broken, not as forbidden.
- **Do NOT gate the sidebar row.** The row comes from the org structure; hiding a department from the
  tree to hide a console would lie about the org chart. Gate the *content*.
- **Open question for the owner (OQ-1):** should a **department head** (Azlan, Rai, Monic, Radit) see
  the GM console read-only — their own department's row plus the company north stars — or nothing?
  Real GM cockpits in role-based ERPs (NetSuite's executive / managerial / operational tiers) give
  managers a *narrowed* version rather than a locked door. Recommend: **narrowed**, department-grain
  only, which the §8 matrix can already express. Not assumed — it needs a ruling.

Related: this is squarely `role-bundles-overstate-reach` / `perm-mirror-cannot-express-attr-gates`
territory. The GM console's gate is **attribute-shaped** ("company grain, own tenant"), so a flat
permission mirror will over-grant it. Keep the decision in Cerbos.

---

## 7 · Nav changes (both recorded in `docs/sidebar-nav-map.md` in the same commit)

1. **GM stops being just another `Departments` row for its own holder.** For a principal with
   `rollups.view`, hoist **GM** to the top of the `Departments` group (or, if the owner prefers,
   pin it as its own single-row group above `Departments`). It is the root of the tree; sorting it
   among its own children is wrong.
2. **`Rollups` and `Company Report` gain a second door.** They keep their URLs and their sidebar rows
   — the GM console links to them. **No route moves.**

Everything else in `Business` and `Reports` stays exactly where it is.

---

## 8 · Sequencing

| # | Ticket shape | Depends on |
|---|---|---|
| **GM-01** | Register the `gm` toolkit — groups, tabs, launchers, mission. Route stubs for all five bespoke tabs so the toolkit cannot point at a 404 (the registry's own standing rule). | — |
| **GM-02** | The gate: `rollups.view` mirror + the fail-closed 403 branch, shared by every tab. Pin it with a test asserting a plain `member` gets the refusal page. | GM-01, OQ-1 |
| **GM-03** | Home cockpit — Tier 1 tiles + Tier 2 department strip, on `reports/overview` (`grain=company` + `grain=department`). Freshness + seal-state line. | GM-02 |
| **GM-04** | `Departments` tab — the full per-department grid, drilling into each dept console. | GM-03 |
| **GM-05** | `Business Review` tab — inputs → outputs → money spine over `reports/document` `grain=company`, reusing `ReportViewer` / `PeriodSelector` / `CompanyCharts` / `WarningsBanner` as-is. | GM-03 |
| **GM-06** | `Decisions` tab — approvals awaiting GM, dept-head assignment requests, ball-held-too-long, escalations. | GM-02 |
| **GM-07** | `People` tab — headcount vs vacancies, appraisal-cycle progress, compliance, leave load. | GM-02 |
| **GM-08** | `Clients & Money` tab — client/engagement half real; money half `BackendPending` naming SM-17/SM-22. | GM-02 |
| **GM-09** | Money tier lands for real. | **SM-17 / SM-22** |

GM-01→03 is the shippable slice: it turns "GM has no console" into "GM has a cockpit", and it is
almost entirely composition of reads that already work.

---

## 9 · Where the design came from

- **Tiered KPI hierarchy + cognitive limits** — 3–5 north stars, 8–12 supporting, everything else
  behind a click; working memory holds 5–9 elements, engagement collapses past ~12 KPIs:
  [Improvado — Dashboard Design](https://improvado.io/blog/dashboard-design-guide) ·
  [UXPin — Dashboard Design Principles](https://www.uxpin.com/studio/blog/dashboard-design-principles/) ·
  [ClearPoint — KPI Dashboard Best Practices](https://www.clearpointstrategy.com/blog/kpi-dashboard-best-practices)
- **Three-level drill-down (dashboard → dimension → transaction) and the company-top /
  departments-middle / drill-down-bottom layout** —
  [Domo — What should be on an executive dashboard](https://www.domo.com/learn/article/what-should-be-on-an-executive-dashboard) ·
  [Executive Dashboard Design Best Practices](https://appdeck.com/blog/executive-dashboard-design-best-practices) ·
  [EPC Group — Power BI enterprise design](https://www.epcgroup.net/power-bi-dashboard-design-best-practices-enterprise-2026)
- **Controllable input metrics before output metrics; identical layout every week; financials last;
  the deck is the operating rhythm** —
  [Commoncog — The Amazon Weekly Business Review](https://commoncog.com/the-amazon-weekly-business-review/) ·
  [Working Backwards — The Amazon Operating Cadence](https://workingbackwards.com/concepts/amazon-operating-cadence/) ·
  [Holistics — How Amazon measures itself](https://www.holistics.io/blog/how-amazon-measures/)
- **Role-based dashboard as a "home base" of KPIs + reminders + shortcuts, tiered
  executive/managerial/operational** —
  [NetSuite — ERP Dashboards](https://www.netsuite.com/portal/resource/articles/erp/erp-dashboard.shtml) ·
  [NetSuite for CEOs](https://www.netsuite.com/portal/solutions/ceo.shtml) ·
  [SuiteRep — Role-Based Dashboards](https://suiterep.com/netsuite-role-based-dashboards/)
- **Freshness transparency + threshold alerting as table stakes** —
  [Geckoboard — Executive/digital dashboard examples](https://www.geckoboard.com/dashboard-examples/executive/digital-dashboard/) ·
  [AgencyAnalytics — automated KPI dashboards](https://agencyanalytics.com/blog/automated-kpi-dashboard)

## 10 · Cross-references

- [`FRONTEND-BFF-CONTRACT.md` §15](../FRONTEND-BFF-CONTRACT.md) — reports / check-ins / appraisals
- [`FRONTEND-BFF-CONTRACT.md` §14](../FRONTEND-BFF-CONTRACT.md) — the SM-17/SM-22 money gap
- [`tracker-reporting-foundation.md`](./tracker-reporting-foundation.md) — the four-grain model
- [`2026-07-23-dept-console-ia-redesign.md`](../superpowers/plans/2026-07-23-dept-console-ia-redesign.md) — the two-level IA this toolkit obeys
- [`sidebar-nav-map.md`](../sidebar-nav-map.md) — must be updated with §7
- [`PERMISSION-CONTRACT.md`](../PERMISSION-CONTRACT.md) — where OQ-1's ruling lands

## 11 · Open questions for the owner

- **OQ-1** — do department heads get a narrowed GM console (recommend: yes, department-grain only), or none?
- **OQ-2** — is the Business Review's period **week** or **month** by default? Amazon's cadence is weekly; this estate's report periods seal on both.
- **OQ-3** — `Clients & Money`: does GM see **cost-to-serve** (which the SEO ledger already computes at standard rates) before real revenue exists, or does the whole tab wait for SM-17?
- **OQ-4** — nav: hoist GM inside `Departments`, or give it its own pinned single-row group?
