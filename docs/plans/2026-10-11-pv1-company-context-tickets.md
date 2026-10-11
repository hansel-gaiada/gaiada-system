# PV-1: company context: verticals, the agency pack, Group and Platform (tickets)

**Status: PLANNED.** Nothing here is built.

- **Parent plan:** `docs/plans/2026-10-10-three-perspectives.md` §2.6, §2.7, §5.3. PV-1 implements
  PV-D1 and the owner's rulings of 2026-10-11: PV-D11 and PV-D14 to PV-D20 (decision log).
- **Base:** `origin/main` at `44a752cb` (`v1.0.0-alpha.351` plus WebDesk docs), read 2026-10-11.
- **Paths:** `PN` = `platform-nest/`, `UI` = `platform-ui/src/`.

## What people will notice

- **Gaiada staff:** the same menu as today, except that the system consoles move out of it (below).
- **Viceroy staff (and any non-agency company):** a generic menu with Company dashboard,
  Departments, Organization, Finance, HR, IT, internal Projects, Reports, Knowledge and Learning. No
  Clients, Agency, Delivery Pipeline or service consoles (PV-D15).
- **Every company:** menu rows for modules that are switched off disappear (the page behind a deep
  link still says "module off").
- **Owners of the holding:** a **Group** area while the holding is the active company, with the
  group report (per-company cards plus Sum of companies), rollups and each company's report
  (PV-D11, PV-D19). A **Platform** area in every company, with full controls (PV-D18).
- **Everyone else:** the Systems rows (WA/TG bot, AI gateway, MCP hub, automation, observability)
  are gone from their menu. Today those rows show to all staff, while the server refuses them.

## Findings from reading the code (they shaped the tickets)

1. **No vertical exists.** `companies.type` is free text with default `general`
   (`PN/migrations/0001_core.sql:9`). Seeds use `holding`, `agency`, `resort`, `catering`, plus
   `restaurant`, `bar` and `spa` for venues (`PN/src/seed/agency.ts:35-40,115-124`). Nothing maps
   them to a business line. → **PV1-01.**
2. **`companies` has no row-level security.** It is a global table, and an earlier backfill
   (`root_company_id`, `202608201326_mon00a_root_anchor.sql:64`) worked in a migration. The
   vertical backfill is a plain UPDATE, but it still asserts its result. → **PV1-01.**
3. **`/api/me` returns `companies[]` as `{id, name, type}` only** (`PN/src/core/core.controller.ts:53-59`).
   No modules, no root and no vertical, so the menu can know none of them. → **PV1-01.**
4. **A company admin can change `type` and the module list today** (`PATCH /api/companies/:id`,
   `PN/src/admin/company-crud.controller.ts:85-140`, Cerbos `resource_company.yaml:22-25`). The
   vertical must not follow that path: only `platform_admin` sets it (PV-D16). Only
   `platform_admin` can create a company at all (`resource_company.yaml:15-17`), and creation sets
   `enabled_modules` to whatever the form sent, with no pack default (line 46). → **PV1-03.**
5. **The staff menu checks no module flags and no company type** (`UI/components/shell/nav.ts`).
   Clients, Deliverables, Timesheets, Invoices, Agency, Meetings, Delivery Pipeline and Monitoring
   show for every company. Of those, only Clients (`clients`), Invoices (`invoice`) and Agency
   (`agency`) have a module gate on their page layout; Monitoring is a module key with no layout
   gate. → **PV1-04.**
6. **Department toolkits and the default org tree are chosen by name and by a hard-coded id.**
   `UI/lib/deptToolkits.ts` picks by department name; `UI/lib/org.ts:82` is
   `company.type === "agency" || company.id === "co-agency"`, a PV-D13 violation. → **PV1-04.**
7. **The Systems pages are already refused server-side to non-admins.** `admin-systems.controller.ts`,
   `bot-admin.controller.ts` and `observability.controller.ts` all use `isElevated`
   (`PN/src/admin/elevated.ts`: `platform_admin` at global scope). That file says `owner` is
   deliberately NOT added, per D-8. PV-D18 reverses that for these surfaces. → **PV1-05.**
8. **Owners cannot read rollups or Company Reports today.** `core.rollup.read` is only in the
   `platform_admin` bundle (`resource_rollup.yaml:13-15,41-44`). The Company Report allows
   `platform_admin` or `company_admin` in tenant (`resource_report_document.yaml:67-76`), and it is
   single-company: `grain=company` with `scopeRef` forced to the route tenant
   (`PN/src/modules/reports/reports.controller.ts:131-137`). **No cross-company report exists.** →
   **PV1-06.**
9. **Nothing defines "owner of the root".** `owner` is a per-company role grant
   (`PN/src/seed/owner-grant.ts:96-98`). The principal carries `rootCompanies`
   (`PN/src/rbac/principal.ts:61-86`). PV-D20 defines a root owner as holding `owner` on a company
   whose id is its own root. Owner grants already need the two-person appointment (`owner` is in
   `ELEVATED_TIER`, `PN/src/admin/grant-write.service.ts:132`). → **PV1-05, PV1-06.**
10. **`nav.test.ts` pins the member group order, including `Systems`, and the Rollups and Company
    Report rows** (`UI/components/shell/nav.test.ts:14,26,135,138`). Those pins change on purpose in
    PV1-04.

## Waves

| Wave | Tickets | Why this order |
|---|---|---|
| 1 | PV1-01 (DB + `/me`), PV1-02 (pack registries) | disjoint files; everything else reads one of them |
| 2 | PV1-03 (company writes), PV1-04 (menu, org, toolkits), PV1-05 (Platform gate), PV1-06a (group reads + report API) | each needs PV1-01 or PV1-02; disjoint files (PV1-04 owns `nav.ts` for both new areas) |
| 3 | PV1-06b (Group pages) | needs PV1-04's Group section and PV1-06a's API |
| 4 | PV1-07 (QA, release, live check) | after the merged tree is green |

**Rules for every ticket:**

- Work in your own worktree from `origin/main`, never in the shared checkout.
- No company names or ids in code (PV-D13). Packs are keyed by **vertical**.
- Hiding a menu row is never the security boundary. Every page and BFF read keeps or gains a server
  gate.
- Update the matching `docs/FRONTEND-BFF-CONTRACT.md` row in the same change.
- Background the server gate (`gate-full.sh <id> both <patch>`) and poll for `### done`.
- Prove each new test bites (break the code, watch it fail) and say how in the hand-back.
- Status words: PLANNED → IN PROGRESS → PROTOTYPED → DEV-VERIFIED. Only PV1-07 can claim DEV-VERIFIED.
- The lead writes `MODULES.md` and `CHANGELOG.md`, and reviews every diff before merge.

---

### PV1-01: verticals in the database, and `/api/me` carries what the menu needs

**Owner:** senior-db (migration) with senior-be (`/me`). **Wave 1.**

**Owned paths:** a new migration `PN/migrations/<UTC-minute>_company_verticals.sql`;
`PN/src/core/core.controller.ts` (`me()` only); `UI/lib/platform.ts` (`Me` type);
`UI/lib/demoFixtures.ts` (`COMPANIES`, the `/api/me` route, one new demo identity);
`docs/FRONTEND-BFF-CONTRACT.md` §1.

**Change:**
- `company_verticals (id text PRIMARY KEY, label text NOT NULL)` seeded with `holding`, `agency`,
  `hospitality`, `catering`, `general` (PV-D14). A lookup table, not a CHECK: adding one later is an
  INSERT.
- `companies.vertical text NOT NULL DEFAULT 'general' REFERENCES company_verticals(id)`.
- Backfill from `type`: `agency`→`agency`; `resort`, `restaurant`, `bar`, `spa`→`hospitality`;
  `catering`→`catering`; `holding`→`holding`; anything else→`general`. `type` stays.
- In the same migration, a DO block that RAISES unless every non-deleted company's vertical equals
  the mapping above. That is the assertion; the NOT NULL alone does not prove the mapping.
- `/api/me` `companies[]` gains `vertical`, `enabledModules` (the effective set the module gate
  uses, `enabledModuleKeys` in `PN/src/modules/registry.ts:58`) and `rootCompanyId`. Additive only.
- Demo: give `co-holding`, `co-agency` and `co-resort` their vertical, modules and root (`co-holding`),
  and add a demo identity **demo-owner** holding `owner` on `co-holding` (and on the children, as the
  seed does), not `platform_admin`.

**Must not:** change `type` values; add the pack registry (PV1-02); touch company write paths (PV1-03).

**Tests:**
- A DB test: after migrate, each seeded `type` maps to its vertical, the FK refuses an unknown
  vertical, and `GET /api/me` returns `vertical`, `enabledModules` and `rootCompanyId` per company.
- Teeth: map `resort` to `general` in the backfill and the assertion must raise.

**Done when** the gate is green and BFF §1 lists the `companies[]` fields.

### PV1-02: the pack registry, mirrored in PN and UI

**Owner:** senior-be with senior-fe. **Wave 1.**

**Owned paths:** new `PN/src/core/packs.ts` and its test; new `UI/lib/packs.ts` and its test.

**Change:**
- One registry per side, keyed by vertical, declaring for each pack: `defaultModules`, the agency
  menu rows it turns on (by stable row key, for example `clients`, `deliverables`, `timesheets`,
  `invoices`, `agency`, `meetings`, `pipeline`, `monitoring`), the department toolkits it allows (by
  department slug), dashboard KPI keys, and vocabulary (`client`, `project`).
- **Only the agency pack has content** (PV-D3). Every other vertical resolves to the generic pack.
- A row-to-module map for rows that have a module key: `clients`→`clients`, `invoices`→`invoice`,
  `agency`→`agency`, `monitoring`→`monitoring`. Rows without one are hidden by vertical only.

**Tests:**
- PN: the registry's vertical keys plus the generic fallback cover exactly the `company_verticals`
  rows (read the PV1-01 migration's INSERT as text, as PV2-09's parity test does).
- UI: its registry equals PN's (read `PN/src/core/packs.ts` as text). Drift fails.
- Teeth: add a vertical to one side only and the parity test fails.

### PV1-03: company writes respect the vertical

**Owner:** senior-be. **Wave 2** (needs PV1-01, PV1-02).

**Owned paths:** `PN/src/admin/company-crud.controller.ts`; `UI/app/(app)/companies/actions.ts`;
the company create/edit form under `UI/app/(app)/companies/` (a vertical picker shown only to
`platform_admin`).

**Change:**
- `POST /api/companies` accepts `vertical` (default `general`). If the body sends no `modules`, the
  company starts with its pack's `defaultModules` (PV-D17). Existing companies are never touched.
- `PATCH /api/companies/:id`: changing `vertical` requires `platform_admin` at global scope, a 403
  otherwise (PV-D16). It never changes `enabled_modules`. The existing `type`/modules rules are
  unchanged.
- Fix the stale `group_executive` comment at line 33.

**Tests:** a DB test: create with a vertical and no modules gives the pack defaults; create with
modules keeps them; a `company_admin` PATCHing `vertical` gets 403 and the row is unchanged; a
`platform_admin` PATCH changes it and leaves modules alone. Teeth: drop the guard and the 403 case
fails.

### PV1-04: the staff menu, org tree and toolkits follow the pack

**Owner:** senior-fe. **Wave 2** (needs PV1-01, PV1-02).

**Owned paths:** `UI/components/shell/nav.ts` and `nav.test.ts`; `UI/lib/org.ts`;
`UI/lib/deptToolkits.ts` and its test.

**Change:**
- `navFor` reads the active company from `me.companies` (vertical, `enabledModules`, `rootCompanyId`).
- The agency rows show only when the active company's pack turns them on, and any row with a module
  key hides when that module is off (PV-D15, PV-D17).
- **Platform** section: the five Systems rows, shown when the person holds `platform_admin` at
  global scope OR is a root owner (`owner` on a company whose `id` equals its `rootCompanyId`),
  in every company (PV-D11, PV-D18, PV-D20). The old ungated Systems group goes.
- **Group** section: shown only to a root owner (or `platform_admin`) **while the active company is
  that root** (PV-D11). Rows: Group report (`/group`, PV1-06b), Rollups (`/rollups`, path kept),
  Company reports (`/group/reports`, PV1-06b). The Rollups and Company Report rows leave Business
  and Reports.
- `org.ts`: the default tree keys on `vertical === "agency"`; delete the hard-coded `co-agency`.
- `deptToolkits.ts`: `toolkitFor(vertical, departmentName)`. A bespoke toolkit only for a vertical
  whose pack allows that department slug; otherwise the generic toolkit.
- Update the deliberate `nav.test.ts` pins (findings 10) and add: an agency company shows the agency
  rows; a hospitality company shows none; a disabled `clients` module hides Clients; a member sees
  no Platform or Group; a root owner sees Platform in every company and Group only on the root.

**Must not:** move any page path. **Teeth:** remove the vertical check and the hospitality test fails.

### PV1-05: the Platform server gate (owners of the root get full controls)

**Owner:** senior-be. **Wave 2** (needs PV1-01's demo identity for e2e later; server side is
independent).

**Owned paths:** `PN/src/admin/elevated.ts`; the systems call sites in
`PN/src/admin/admin-systems.controller.ts`, `PN/src/admin/bot-admin.controller.ts`,
`PN/src/admin/observability.controller.ts`; the in-page control checks in
`UI/app/(app)/systems/*/page.tsx`; `docs/PERMISSION-CONTRACT.md` (a dated note).

**Change:**
- Add `isPlatformOperator(req)` = `platform_admin` at global scope, OR the `owner` role on a
  company in `req.principal.rootCompanies` (a root owner, PV-D20). Rewrite the file's D-8 comment
  to record PV-D18 and its consequence (decision log).
- Use it on the **system surfaces only**: the systems status/config/gateway/hub/github/automation
  routes, every bot-admin route, and observability; `isItOrElevated` becomes
  `isItOrPlatformOperator`. **Every other `isElevated` use is unchanged** (company listing, IAM,
  view-all-companies).
- The UI's in-page controls on the Systems pages use the same predicate.

**Tests:** a DB/HTTP test per surface family: a root owner gets 200 on a read and a write; an `owner`
of a non-root company gets 403; a member gets 403; `platform_admin` still 200. Teeth: drop the owner
arm and the root-owner cases fail; widen it to any owner and the non-root case fails.

### PV1-06a: group reads and the group report API

**Owner:** senior-be (Cerbos + endpoint). **Wave 2** (needs PV1-01).

**Owned paths:** `PN/cerbos/policies/resource_rollup.yaml`,
`PN/cerbos/policies/resource_report_document.yaml` (and their count/parity tests, which will move:
"a new Cerbos rule is several artifacts"); a new group-report route in
`PN/src/modules/reports/` (controller + service + test); `docs/FRONTEND-BFF-CONTRACT.md` (new row).

**Change:**
- Rollups: a root owner may read the rollups of their own root (PV-D19).
- Company Report: `read_company` for `owner` in tenant (the owner already holds `owner` on each
  owned company).
- `GET /api/:rootId/reports/group`: root owner or `platform_admin` only; 404 unless `:rootId` is a
  root. For each non-deleted company whose `root_company_id = :rootId`, reuse the company-grain
  report builder and return a card (name, vertical, its headline figures). Add **Sum of
  companies** only for additive figures (counts, headcount, money per currency); never average or
  add ratios; never mix currencies. A `consolidated` field stays null with a reason ("needs F9
  eliminations").

**Tests:** a DB test with a root and two children: the root owner gets three cards and correct sums;
a child-only owner gets 403; a member 403; `platform_admin` 200. Teeth: sum a ratio, or drop the
root-only check, and a case fails. Remember Cerbos policy changes need a restart on deploy.

### PV1-06b: the Group pages

**Owner:** senior-fe. **Wave 3** (needs PV1-04, PV1-06a).

**Owned paths:** new `UI/app/(app)/group/page.tsx` and `UI/app/(app)/group/reports/page.tsx`, with
the BFF client function and demo fixture for the group report.

**Change:** `/group` renders the group report (cards plus Sum of companies, and the "Consolidated
needs F9" note); `/group/reports` lists each company's Company Report link. Both refuse with an
explanation when the API says 403. One h1 per page.

**Tests:** unit tests for the sums rendering and the 403 state; e2e in PV1-07.

### PV1-07: QA gate, release, live check

**Owner:** qa with the lead. **Wave 4.**

- Merged-tree server gate (both suites, `next build`).
- e2e: demo-owner sees Group only on `co-holding` and Platform in every company; a member sees
  neither; `co-resort` shows the generic menu; a disabled module hides its row.
- Release (agreed with WebDesk), then live: `/api/me` carries `vertical` per company for a QA staff
  login (read-only), Viceroy's menu is generic, Systems rows are gone for a QA staff login, and the
  migration's `applied:` line is in the deploy log. An owner login cannot be driven headlessly; the
  owner checks Group and Platform themselves and says so.

---

## Not in PV-1 (and where each goes)

| Item | Why not now | Goes to |
|---|---|---|
| Hospitality, catering and holding packs with content | PV-D3: Gaiada first | PV-8 |
| The Consolidated group figure | Needs F9 eliminations | Finance |
| Other hard-coded names and ids (`reports-print-stub.ts:28`, `provision-client-portal-logins.ts:48`, `login/page.tsx:21-22`, the portal contract signature label) | Not on PV-1's paths | a PV-D13 cleanup ticket |
| Per-company dashboard KPIs by vertical | The pack declares the keys; the dashboards come with each pack | PV-7 / PV-8 |
