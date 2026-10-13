# PV-6: the client's Business area re-cut (tickets)

**Status: PROTOTYPED (2026-10-13).** PV6-01 to PV6-05 are built, reviewed and gated on sumopod with every tooth seen red, and CI is green on the merged tree (platform-nest and platform-ui `0.116.0`). PV6-06 (release and the live drive) is open.

- **Parent plan:** `docs/plans/2026-10-10-three-perspectives.md` §2.3 (the division test), §3.4, §8
  (PV-6 row), §9 (traps 1, 8, 9). The Client Centre itself: `docs/plans/2026-09-29-client-centre.md`.
- **Rulings in force:** PV-D30 (D6: every Business area shows Setup · Connections · Services & results;
  "departments" become **Business areas**; the placeholder pages go; the Business area is never a
  system of record for the client's own operations), PV-D4 (same areas on both sides, every URL kept),
  PV-D33 (a project-scoped contact does not see client-wide material), PV-D13 (no company names or ids
  in code), CC-D3/CC-D4/CC-D5/CC-D7 (unchanged).
- **Base:** `origin/main` at `0e313487`, read 2026-10-13 from a clean worktree.
- **Paths:** `PN` = `platform-nest/`, `UI` = `platform-ui/src/`.

## What people will notice

- **Clients and staff on Business:** the Client Centre's "departments" are now **Business areas**.
  Every area page has three parts: **Setup** (the profile fields), **Connections** (the tools and
  accounts), and **Services & results** (what we run for the client there, with its numbers).
- **The "Coming soon" pages are gone.** All 278 of them. Old links to them land on their area.
- **Results appear for the first time.** Where we run a service, its area shows the live numbers:
  social growth, search rankings and organic traffic, paid search clicks and conversions, site
  analytics, and site uptime. An area where we sell nothing shows Setup and Connections only.
- **A converted lead arrives with a filled profile.** The discovery answers a prospect gave (AD-3)
  fill the empty fields of the new client's Business profile. Staff can do the same for clients
  converted earlier.
- **The industry area's own settings work.** A hotel client's "Hotel Operations" area now shows and
  saves its own fields and connections (today it shows 0 of 0, finding 2).
- **Agents can read and update a client's Business profile and read its results.**

## Findings from reading the code (they shaped the tickets)

1. **"103 placeholder pages" undercounts.** 103 is the number of direct children of the 9
   departments. That is 84 leaf pages plus Marketing's 19 sub-sections, which are real sections with
   their own settings. The registry holds **201 department leaves and 77 industry-module leaves, 278
   "Coming soon" pages in all** (201 to 211 per client, by business type). PV-D30's intent is
   unchanged: every leaf page goes, and Marketing's 19 sub-sections stay as **sub-areas**. → **PV6-01.**
2. **The industry module's settings are never shown.** `settingsDef` reads only
   `sectionSettings[section.id]` (`PN/src/modules/clients/centre/sections.ts:49-51`,
   `UI/lib/clientCentre.ts:215-217`), and `sectionSettings` has no `ix` key. So
   `industryModules[bt].settings` (30 industry-only fields, 40 industry-only connections) is
   unreachable, and a custom connection on `ix` is refused with 400 `unknown section: ix`
   (`validation.ts:67,244`; also `scripts/cmc/build-import.mjs:83`). → **PV6-01.**
3. **"Area" already means something else in the UI.** Section cards say "{n} areas" for leaf pages
   (`HomeView.tsx:53`, `SectionOverviewView.tsx:46-65`). It must mean a Business area only. → **PV6-01.**
4. **"Department" is user-visible in seven places.** `HomeView.tsx:44,58-60`,
   `CompanySettingsView.tsx:98-100`; the save error `unknown department: X` (`validation.ts:227`,
   demo :287); the hub History tab prints raw change paths such as `departments.rs`
   (`UI/app/(app)/clients/[clientId]/notes/page.tsx:115-166`); and the wire fields
   `CentreProfile.departments` / `CentrePatch.departments`. The glossary forbids it
   (root `CLAUDE.md`, Reserved words). → **PV6-01.**
5. **A client's profile edit notifies staff with a dead-end link.** `portal-centre.controller.ts:157-163`
   sends `/client-centre/${clientId}` ("…updated their Client Centre profile"), which redirects to the
   hub's Overview, not to Business. `clientCentreActions.ts:68` revalidates `/portal/company/${clientId}`,
   a path that does not exist. → **PV6-01.**
6. **No Client Centre page reads service data today.** "Services & results" is new. The data exists and
   is keyed by `client_id`:

   | Service | Source (module wall) | Numbers already computed | Business area |
   |---|---|---|---|
   | Social media | `social_engagements`, `social_accounts`, `social_metrics_daily`, `social_kpi_targets` (`social`) | `buildSocialReportSnapshot` (`PN/src/modules/social/reports.ts:173-257`): followers, reach, engagements, link clicks, posts published, KPI vs target, unknown = null | Marketing › Social Media (`mk_social`) |
   | SEO | `search_properties`, `search_engagements`, `search_rank_snapshots`, `search_gsc_performance`, `search_ai_visibility`, `search_kpi_targets` (`search`) | top-10 count (3 copies: `search.controller.ts:2816-2887`, `search-reports.controller.ts:138`, rollup), GSC totals (`search-reports.controller.ts:133-235`) | Marketing › SEO, AEO & GEO (`se`) |
   | Paid search | `search_campaigns`, `search_campaign_metrics_daily` (`search`) | `search-reports.controller.ts:212-235` | Marketing › Paid Media & PPC (`mk_paid`) |
   | Site analytics | `search_ga4_metrics`; Umami through `search_properties.umami_site_id` (`search`) | `search.controller.ts:1015`; `search-analytics.controller.ts:74-108` | Marketing › Analytics & Reporting (`mk_analytics`) |
   | Website and uptime | `webdev_sites`, `webdesk_site_clients`, `monitors`, `monitor_incidents` (`webdev`, `monitoring`) | `monitoring.controller.ts:216-244` (uptime 24h/30d, certificate and domain expiry; `UPTIME_RATIO_SQL` at 105-109 is not exported) | Marketing › Web Design & Development (`mk_web`) |

   No portal route returns any of these numbers. → **PV6-02, PV6-03.**
7. **Two traps sit on those reads.**
   - The module wall: a read without `{modules: [...]}` returns zero rows with no error (plan trap 8;
     `PN/src/db/index.ts:152`). A disabled module is "not offered", a read that fails is "unavailable",
     and neither may look like "no results".
   - `simulated` rows: several search tables carry `simulated` (`0048:53-55`, `0061:152/184`,
     `0065:59`). A client must never see a simulated figure; `search.controller.ts:2853` already
     filters them.
   → **PV6-02.**
8. **The portal scope cannot answer "client-wide for this client".** `resolvePortalScope` flattens
   project scope across every client of the caller (the open "Before real clients use the portal"
   item). The per-client check that exists is inline SQL in `canEditCentre`
   (`portal-centre.controller.ts:39-51`). → **PV6-02** adds the predicate to `portal-visibility.ts`.
9. **Staff authority for results.** Staff `client` read reaches `company_admin, manager, member,
   viewer` (`resource_client.yaml:12-15`). The module kinds are narrower (`social_account`,
   `search_property`, `monitor`). The results payload carries **only figures the client itself sees**,
   so it is gated on `client` read, the same as the Business profile. Anything internal (budgets,
   costs, usage, audit detail, inbox) stays in the department screens. The hub Overview already
   reads social counts under `client` read (`clients.controller.ts:352-358`). → **PV6-02.**
10. **AD-3 and the profile share concepts but no keys.** The questionnaire
    (`PN/src/core/agency-discovery-questionnaire.ts`, 13 sections, 127 fields, answers in
    `agency_discovery_submissions.answers`) and the registry (149 fields) share only 4 ids, and one of
    those is a false friend: AD-3's `platform` is the preferred website platform, the registry's
    `platform` is the e-commerce platform (AD-3 `platform` → registry `cms`). About 25 more map by
    meaning (`current_url` → `website`, `differentiator` → `usps`, `brand_colours` → `color`, …).
    About half of AD-3 is project-brief data (visual sliders, sitemap, scope, governance), which
    already feeds the requirement document and does not belong in the profile. Lead conversion
    (`agency-lead-convert.service.ts:532-630`) copies no answer into the client. → **PV6-04.**
11. **Agents cannot see a client's Business at all.** The only `clients` tool is
    `clients.listClients` (`PN/src/modules/clients/index.ts:25-33`). → **PV6-05.**
12. **The Website sub-tab is already live.** WSK-49d (Website as the second Business tab, editors only)
    shipped in 1.0.0-alpha.356 and was proven live end to end by WSK-49e on 2026-10-12. Its open PV-6
    call, a read-only view for clients who are not editors, is answered by the website card in
    Services & results (PV6-03), which every client-wide contact sees.

## Waves

| Wave | Tickets | Why this order |
|---|---|---|
| 1 | PV6-01 (Business areas re-cut), PV6-02 (results backend), PV6-04 (AD-3 fill) | disjoint files apart from small, named overlaps; 04's UI button rebases on 01 |
| 2 | PV6-03 (results on both sides), PV6-05 (agent tools) | 03 needs 01's area page and 02's payload; 05 needs 02's route |
| 3 | PV6-06 (QA, release, live) | after the merged tree is green |

**Rules for every ticket:**

- Work in your own worktree from `origin/main`, never in the shared checkout.
- **Tests run on sumopod, never locally.** No local Docker. Background the server gate
  (`gate-full.sh <id> both <patch>`) and poll for `### done`. A local green does not count.
- No company names or ids in code (PV-D13). No real client data in the repo (CC-D7).
- Every portal query takes its predicate from `portal-scope.ts` and `portal-visibility.ts` (trap 1).
- A read of a module table declares the module (trap 8). A missing scope is zero rows, not an error.
- Authorization runs before validation, so denial tests test authorization.
- Update the matching `docs/FRONTEND-BFF-CONTRACT.md` rows (§25 Client Centre) in the same change.
- A ticket that touches any `platform-nest` test runs
  `UPDATE_INVENTORY=1 npx vitest run src/modules/capability-inventory.test.ts` before handing back.
- Prove each new test bites (break the code, watch it fail) and say how in the hand-back.
- Status words: PLANNED → IN PROGRESS → PROTOTYPED → DEV-VERIFIED. Only PV6-06 can claim DEV-VERIFIED.
- The lead writes `MODULES.md` and `CHANGELOG.md`, regenerates MAP and the capability inventory from
  a clean tree, and reviews every diff before merge.

---

### PV6-01: Business areas replace departments; the placeholder pages go

**Owner:** senior-fe (the backend half is mechanical and spelled out). **Wave 1.**

**Owned paths:** both registry copies (`PN/src/modules/clients/centre/registry.json`,
`UI/lib/clientCentreRegistry.json`) and a new `scripts/cmc/registry-v2.mjs`;
`PN/src/modules/clients/centre/{sections,store,validation}.ts` and their tests;
`PN/src/core/portal-centre.controller.ts` (the notification only); `scripts/cmc/build-import.mjs`;
`UI/lib/clientCentre.ts`, `clientCentreActions.ts`, `demoClientCentre.ts`;
`UI/components/client-centre/*`; the two entry pages
`UI/app/(portal)/portal/company/[[...section]]/page.tsx` and
`UI/app/(app)/clients/[clientId]/profile/[[...section]]/page.tsx`; the History labels in
`UI/app/(app)/clients/[clientId]/notes/page.tsx`; BFF §25.

**Registry v2** (one deterministic, idempotent transform from v1, committed as
`scripts/cmc/registry-v2.mjs`; it writes both copies, so the parity test stays byte-identical):
- `version: 2`.
- `departments` → `areas`. Each area is `{id, name, subAreas?: [{id, name}]}`. Only Marketing (`mk`)
  has sub-areas: its 19 sub-sections, ids unchanged (`se` included). **Every leaf page is dropped.**
- `industryModules[bt]` keeps `{id: "ix", name, settings}` and drops `pages`.
- `defaultOffDepartments` → `defaultOffAreas`.
- Field, connection and area ids are unchanged, so **no stored profile changes**.
- `scripts/cmc/extract-registry.cjs` gets a header line: it produced v1 from the CMC snapshot and is
  superseded; v2 is maintained by hand from here on.

**Wire and backend:**
- `CentreProfile.departments` → `areas`; `CentrePatch.departments` → `areas`. Error text
  `unknown business area: X`. Activity and `client.centre_updated` change paths become `areas.<id>`.
  UI and backend merge in **one push** (the field is required on both sides).
- The database column keeps its name `departments`; `store.ts` maps it. Renaming a live column buys
  nothing and turns a deploy rollback into an outage. Say so in a comment on the mapping.
- Finding 2: `settingsDef("ix", bt)` returns `industryModules[bt].settings`; `VALID_SECTION_IDS`
  includes `ix`; `usedBy` counts `ix`; `build-import.mjs` accepts `ix` custom connections.
- Finding 5: the portal edit notification links `/clients/${clientId}/profile` and says
  "…updated their business profile". Fix the revalidate path in `clientCentreActions.ts:68`.

**Area pages** (both sides render the same components):
- URL scheme (`parseSectionRoute` / `sectionHref`):

  | URL tail | View |
  |---|---|
  | `` | Home: the Business areas |
  | `/company` | Business details (unchanged) |
  | `/<areaId>` | the area's **Setup**: its fields |
  | `/<areaId>/connections` | the area's **Connections** |
  | `/<areaId>/results` | **Services & results** (added by PV6-03; until then the part is not linked) |
  | `/<areaId>/settings` (old) | redirects to `/<areaId>` |
  | `/<areaId>/<n>` (old leaf) | redirects to `/<areaId>` |

  Redirects use Next `redirect()` on both entry pages. No notification or e2e links a leaf URL, but
  bookmarks may.
- An area page has a header (name, icon, a stats line: fields filled, connections connected) and a
  part strip **Setup · Connections** (PV6-03 adds **Services & results**). The strip is real links
  with `aria-current`. Marketing's page also lists its 19 sub-areas as cards above the strip.
- Split today's `SectionSettingsView` into the Setup and Connections parts. Keep the no-credentials
  callout on Connections, "Shared · N", and autosave unchanged.
- Delete `LeafPageView.tsx` and `.cc-soon`. Section cards lose "Not set up yet" and "{n} areas".
- Copy: "Business areas" everywhere "Departments" was; the toggle reads "Choose which business areas
  this business uses. The first one is specific to your business type." The tree's `aria-label`
  becomes "Business areas". "Area" is never used for anything but a Business area or a sub-area.
- History (finding 4): `profile.<key>` shows the field label, `connections.<key>` the connection name,
  and both `departments.<id>` (old rows) and `areas.<id>` show "Business area <name> on/off".

**Tests:**
- Registry: v2 shape; no `pages` key anywhere; 9 areas; `mk` has 19 sub-areas; every
  `sectionSettings` key is an area or sub-area id; parity still byte-identical; the transform is
  idempotent (v2 → v2 is a no-op).
- `ix`: a hotel's `ix` Setup lists the 9 Hotel Operations fields; a PATCH of an `ix`-only field and an
  `ix` custom connection both save (today 400). The db test's totals for `other` stay 23/98; add one
  for `hotel`.
- Wire: `areas` round-trips; `departments` in a PATCH is a 400 naming the key.
- Routes: `/rs/settings` and `/mk/3` redirect to their area on both sides; `/rs/connections` renders.
- No user-visible "department" in `UI/components/client-centre` (a grep test, like the portal guard).
- Teeth: restore one leaf page in the registry and the shape test fails; drop `ix` from
  `VALID_SECTION_IDS` and the `ix` save fails.

### PV6-02: Services & results, the backend

**Owner:** senior-be. **Wave 1.**

**Owned paths:** new `PN/src/modules/clients/centre/results/` (one builder per service, the area map,
the composer); new `PN/src/modules/clients/centre/centre-results.controller.ts` (staff) and
`PN/src/core/portal-centre-results.controller.ts` (portal), each registered in its module;
`PN/src/core/portal-visibility.test.ts` (the guard's switched list); a small export from
monitoring (`UPTIME_RATIO_SQL` or a function) and from search (one top-10 helper); BFF §25.

**Contract:**
```ts
type Kpi = { key: string; label: string; value: number | null; unit: "count" | "percent" | "position" | "ratio";
             period: { from: string; to: string } | null; previous: number | null; target: number | null;
             asOf: string | null };
type ServiceCard = { service: "social" | "search" | "search_ads" | "analytics" | "website";
                     areaId: string;               // a v2 area or sub-area id, from the area map
                     title: string; status: "active" | "paused" | "setting_up" | "ended"; since: string | null;
                     items: { label: string; detail: string | null }[];   // accounts, domains, sites
                     kpis: Kpi[]; clientVisible: true };
type BusinessResults = { clientId: string; generatedAt: string; visible: boolean;
                         services: ServiceCard[]; unavailable: string[] };  // services whose read failed
```
- `GET /api/:t/clients/:clientId/centre/results`: `client` read (the same as the profile), under
  `ModuleEnabledGuard("clients")`.
- `GET /api/:t/portal/centre/:clientId/results`: `portal` read; `clientId` outside scope is 404; a
  contact who is in scope but **not client-wide for this client** gets 200 with `visible: false` and no
  services (PV-D33; PV6-Q1). The client-wide test is `scope.wideClientIds`, not inline SQL. (Finding 8's
  flaw was fixed on main by `4ea548d0`, the per-client portal scope, while PV6-02 was being built; the
  predicate PV6-02 first added duplicated it and was removed at the wave-1 merge.)

**Builders** (one file each; each declares only its own module; a module the company has not enabled
is skipped, which means "not offered"; a builder that throws is logged and listed in `unavailable`;
never a silent empty list):
- **social** (`mk_social`): one card per engagement with status; items = connected accounts (network,
  handle, status); KPIs over the last 30 days vs the 30 before, through `buildSocialReportSnapshot`:
  followers total, reach, engagements, link clicks, posts published, each with its KPI target.
- **search** (`se`): one card per engagement; items = property domains; KPIs: keywords in the top 10,
  organic clicks and impressions (GSC, 28 days vs previous), average position, AI citations; targets
  from `search_kpi_targets`. **Exclude `simulated` rows.** Reuse one top-10 helper; never a fourth copy.
- **search_ads** (`mk_paid`): only when the client has an active campaign; KPIs: clicks, conversions,
  conversion value (30 days vs previous). **No spend or budget figures** (PV6-Q2).
- **analytics** (`mk_analytics`): per property with GA4 or Umami bound; KPIs: sessions, engaged
  sessions, conversions (30 days vs previous). Umami only when its env is set; otherwise skip it, never
  report zero.
- **website** (`mk_web`): one card per site the client has (`webdev_sites`, `webdesk_site_clients`);
  items = domain and live state; KPIs: uptime over 30 days, open incidents, days to certificate expiry,
  days to domain expiry (from `monitors`). Reuse the exported uptime SQL; never a copy.

**Tests:**
- Each builder against seeded rows: correct numbers, `null` for unknown (never 0), `previous` and
  `target` filled where the data exists.
- A module not enabled → the service is absent and `unavailable` is empty. A forced builder error →
  that service is in `unavailable` and the others still return.
- `simulated` search rows change nothing. Paid search returns no money field (assert the key set).
- Portal: a client-wide contact sees the cards; a project-scoped contact of the same client gets
  `visible: false`; a contact of another client gets 404; staff and portal payloads for the same
  client are equal (a parity test, like PV3-07).
- Every builder's SQL runs under its module scope (the test runs with the scope removed and expects
  the guard to catch it).
- Teeth: drop the `simulated` filter; drop the client-wide check; drop the module scope. Each must
  turn a test red.

### PV6-03: Services & results on both sides

**Owner:** medior, reviewed by senior-uiux. **Wave 2** (needs PV6-01 and PV6-02).

**Owned paths:** `UI/components/client-centre/` (a new `ResultsView.tsx` and `ServiceCard.tsx`, the
part strip, `HomeView.tsx` counts); `UI/lib/clientCentre-data.ts` (two readers);
`UI/lib/demoClientCentre.ts` and `demoFixtures.ts` (results fixtures); the entry pages.

**Change:**
- The part strip gains **Services & results** at `/<areaId>/results` on every area. An area with no
  card says "We don't run a service in this area yet." Marketing's own results part rolls up its
  sub-areas' cards, grouped by sub-area.
- A card shows the service, status and "since"; its items; and each KPI with its period, the change
  against the previous period (up, down, flat, or "not enough data" when `previous` is null), and its
  target when set. `null` reads "Not measured yet", never 0.
- `unavailable` shows one notice: "Some results could not be loaded. Try again later." It never
  shows as an empty area.
- Portal, `visible: false`: the part reads "Results are shared with your organisation's main
  contacts." and shows nothing else.
- Staff: every card carries the "Client sees this" marker (PV3-09's component), from `clientVisible`.
- Home and the area header count the services running in each area.
- The **website** card links to the Website tab (`/portal/website`) for a client who is a website
  editor; for everyone else it is the read-only view (finding 12).
- Accessibility: the change direction is text, not colour alone; the strip is keyboard reachable;
  axe clean in light and dark.

**Tests:** component tests for each state (data, null KPI, no previous, target met and missed,
`unavailable`, `visible: false`, empty area); DEMO_MODE e2e plus axe on `/portal/company/mk_social/results`
and `/clients/<id>/profile/se/results`. Teeth: render a `null` KPI as 0 and a test fails.

### PV6-04: the discovery answers fill the Business profile (CC-D6)

**Owner:** medior. **Wave 1** (the UI button rebases on PV6-01 before merge).

**Owned paths:** new `PN/src/modules/clients/centre/discovery-map.ts` and its test;
`PN/src/core/agency-lead-convert.service.ts` (the conversion step only); two new staff routes in a new
`PN/src/modules/clients/centre/centre-discovery.controller.ts` (not in the existing controller or
`store.ts`, which PV6-01 edits); a new `UI/components/client-centre/DiscoveryFillButton.tsx` with a
one-line insertion in `CompanySettingsView.tsx`; BFF §25; a dated CC-D6 note in
`docs/plans/2026-09-29-client-centre.md`.

**Change:**
- `discovery-map.ts`: an explicit table, AD-3 field id → registry field key, plus a transform per
  entry (arrays join with ", "; scale sliders and project-brief fields are **not mapped**). It includes
  `platform` → `cms` (the false friend) and the ~29 matches in finding 10. Every row carries a
  one-line reason.
- On lead conversion: write the mapped answers of the lead's latest submission into the new client's
  profile, **only into empty keys**, through the same validation as a PATCH (the credential scanner
  runs on every value; a refused value is skipped and named in the activity). One activity row with
  `via: "discovery"` and the change list. No submission → no write.
- `fill-from-discovery` (staff, `client` update): the same fill for a client converted before PV-6,
  found through `agency_leads.converted_client_id`. It never overwrites a filled key. It returns
  `{filled: string[], skipped: {key, reason}[]}`. 404 when the client has no converted lead with
  answers.
- `GET /api/:t/clients/:clientId/centre/discovery` (staff, `client` read): the preview,
  `{available: boolean, fillable: string[]}`, computed by the same function as the fill.
- UI: staff see "Fill from discovery answers (N fields)" on Business details only when the preview says
  `available` and `fillable` is not empty. After it runs, a toast names how many fields were filled.

**Tests:**
- Parity: every map key exists in `ALL_QUESTIONNAIRE_FIELDS` and every target in the registry
  `fields`; `platform` maps to `cms`.
- Conversion fills empty keys and leaves a pre-filled key untouched; a secret-looking answer is
  skipped and named.
- The route is idempotent (a second run fills nothing); a `viewer` gets 403 before any validation.
- Teeth: map `platform` → `platform` and the parity test fails; remove the empty-key check and the
  overwrite test fails.

### PV6-05: agent tools for a client's Business (agentic-native bar)

**Owner:** junior, reviewed by senior-integrator. **Wave 2** (needs PV6-02).

**Owned paths:** `PN/src/modules/clients/index.ts` (`mcpTools`); the capability inventory, regenerated
by the lead.

**Change:** three tools over the existing routes, with the same authorization:

| Tool | Route | Impact |
|---|---|---|
| `clients.getBusinessProfile` | `GET /api/:t/clients/:clientId/centre` | read |
| `clients.updateBusinessProfile` | `PATCH /api/:t/clients/:clientId/centre` | low (key-by-key merge, audited, reversible; the credential scanner applies) |
| `clients.getBusinessResults` | `GET /api/:t/clients/:clientId/centre/results` | read |

**Tests:** each tool drives its real route; a principal without `client` update is refused by
`updateBusinessProfile` with a typed reason; a golden case per tool. Teeth: register the update tool
as `read` and the impact test fails.

### PV6-06: QA gate, release, live drive

**Owner:** qa, with the lead. **Wave 3.**

**Before release:**
- Merged-tree server gate on sumopod: both suites and `next build`.
- Portal and hub e2e plus axe on Home, an area's three parts, and Business details, light and dark.
- MAP and the capability inventory regenerated from a clean tree.

**Release:** the slot is agreed with the other sessions; cut it one verified step per command.
No migration and no Cerbos change are expected; if either appears in review, add the restart and
probe here.

**Live, as the owner's account and a seeded client contact** (owner ruling 2026-10-13: the ERP holds
mock data; log in once per run, stop on the first failed login):
- Business shows "Business areas"; no "Coming soon" page is reachable; an old leaf URL redirects.
- A hotel client's industry area saves a field.
- A client with a social or search engagement shows its cards with numbers; one without shows the
  empty line; a project-scoped contact sees the "main contacts" line.
- Fill from discovery on one converted test client; then remove what it filled (teardown list).

---

## Open for the owner (non-blocking)

| # | Question | Lead's default, used until ruled |
|---|---|---|
| PV6-Q1 | May a contact limited to some projects see Services & results? | No. Only client-wide contacts, as PV-D33 ruled for the client-wide thread |
| PV6-Q2 | May clients see ad spend and budgets in Services & results? | No money figures in this phase. Spend belongs with Contracts & billing and the client reports (PV-7) |
| PV6-Q3 | Three client areas share names with our own modules: Accounting, Human Resources, IT & Security. Rename them? | Keep. They name the client's own functions and appear only inside Business |

## Not in PV-6 (and where each goes)

| Item | Why not now | Goes to |
|---|---|---|
| Results on the client's Overview, the client grain, the agency client health board | Need the client grain in reports | PV-7 |
| Publishing the frozen social and search reports to the portal as reports | A publication step; today they reach a client only as a deliverable | PV-7 |
| Content, email, paid social, CRM and helpdesk results | We run no such service module yet | when the service exists |
| Syncing a connection's status with the integration vault and the services' OAuth | Connections stay manual text in this phase | later |
| Per-client project scope in `resolvePortalScope` | Pre-existing; PV6-02 adds a per-client predicate for its own read | "Before real clients use the portal" |
| Renaming the `departments` database column | No user value; a rename turns a rollback into an outage | never, unless the table is rebuilt |
