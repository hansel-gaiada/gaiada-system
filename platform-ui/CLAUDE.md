# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Scope: `platform-ui/` — the ERP Suite web surface. Standalone Next.js project (own
`package.json`, own deploy); the repo root is deliberately **not** a monorepo. Root
`../CLAUDE.md` carries program-wide rules (it was rewritten 2026-08-10 to hold only
non-rotting rules; its former status narrative is in `../docs/history/`); this file governs here.

## Stack + hard constraints

Next.js 15 App Router · React 19 · TypeScript · vitest + Playwright. **Runtime deps are
`next`, `react`, `react-dom`, `server-only` — nothing else.** No Tailwind, no component
library, **no chart library**, no date library, no state manager. Every chart in the reports
kit (`components/reports/charts/`) is hand-rolled SVG. Adding a dependency is a decision, not
a detail — the whole surface has stayed at four runtime deps through several large programs.

## Commands

`node_modules` may be absent (`tsc`/`vitest` are not global) — run `npm ci` first or every
script fails with `sh: 1: tsc: not found`.

```
npm run dev                    # :3005, needs the platform on :3004
DEMO_MODE=1 npm run dev        # browse every page with NO backend (lib/demoFixtures.ts)
npm run typecheck              # tsc --noEmit
npm test                       # vitest run (jsdom) — 98 test/spec files
npx vitest run src/lib/pm.test.ts            # one file
npx vitest run src/lib/pm.test.ts -t "name"  # one case
DEMO_MODE=1 npm run build      # THE gate — see below
npm run e2e                    # playwright; self-contained (starts next dev + DEMO_MODE=1)
npx playwright test --project=smoke --grep @smoke   # the CI build-gate smoke check
```

**`next build` is the real gate.** `tsc` + vitest have both passed while the build broke and
routes 500'd (a `server-only` import reaching a client component). CI runs `npm run build`
then the `smoke` Playwright project against the built app for exactly that reason.
`DEMO_MODE=1` so no backend is needed.

Playwright projects: `setup` (auth state) → `chromium` (authed flows) · `anon` (login/step-up/
sign-out, no stored session) · `smoke` (self-contained, does its own login).

Dev login accepts **any email** in demo mode; the email picks the identity tier
(`src/app/login/actions.ts`): contains `seo-staff` → `search_staff` (drives gated/disabled
rendering), contains `client` or ends `@northwind.example` → **external client** (portal-only nav,
redirected to `/portal`), contains `ic` or `gede@gaiada.com` → IC, anything else → manager. The
client test runs BEFORE the `ic` one because a real client address can contain "ic" (`erica@…`) and
the client tier is the more specific claim — ordering is the mechanism, and `lib/demoIdentity.test.ts` pins it (the resolver is pure and lives
there because `actions.ts` is `"use server"` and may export only async functions).

## Architecture

### One egress, server-side only
`src/lib/platform.ts` → `platformFetch()` is **the only** path to a backend, and it is
`server-only`. The browser never sees a token. Auth resolution: an OIDC session presents the
user's IdP access token; otherwise the dev path (`PLATFORM_SERVICE_TOKEN` + `x-user-id`).
Errors become `PlatformError(status, message, field?)` — `field` carries the backend's
field-level 400s.

- Binary/multipart uploads use `platformUpload()`, never `platformFetch` (which forces
  `content-type: application/json` whenever a body exists and would corrupt the boundary).
- A bodyless POST must not declare a JSON content-type — Fastify 400s on it. `platformFetch`
  already handles this; don't re-add the header.
- `src/app/api/*` route handlers exist **only** where the browser itself must hit a URL:
  polling (`meetings/[id]/status`), a large upload with progress (`meetings/[id]/audio` — streams
  the multipart body to the platform; Server Actions buffer + cap bodies, 1 MB by default, and give
  the browser no progress events), the bot admin console, an OAuth callback
  (`search/google/callback`), a file download (`search/change-proposals/[id]/export-file`).
  Pages and server actions call `platformFetch` directly — don't proxy through our own API.

### Module trio per domain — the naming is load-bearing
For a domain `X` you will find up to four files in `src/lib/`:

| File | Guard | Holds |
|---|---|---|
| `X.ts` | **none** (must stay client-safe) | types + pure, zero-I/O functions |
| `X-data.ts` | `server-only` | the `platformFetch` readers |
| `XActions.ts` | `"use server"` | writes |
| `demoX.ts` | `server-only` | stateful demo fixture store |

`lib/reports.ts` documents why: the `"use client"` chart kit imports `bucketSeries` /
`bucketGranularityFor` at interaction time, so adding `import "server-only"` there would break
every chart. Same split in `appraisals{,-data,Actions}.ts`, `checkins{,-data,Actions}.ts`.
Older domains (`pm.ts`, `hr.ts`, `entities.ts`, `admin.ts`, `searchMarketing.ts`) are
server-only readers with a `*Actions.ts` sibling. Every actions file follows one shape: a
`ctx()` resolving session → `me` → active tenant, an optional capability gate, then a
`{ ok, error?, field?, id? }` result. Follow it rather than inventing a new one.

### Session / tenant / prefs
- HMAC-signed cookie `gaiada_session`. **Pure crypto lives in `lib/session.ts`, cookie I/O in
  `lib/session-server.ts`** — load-bearing: `session.ts` must stay importable from plain vitest
  without pulling in `next/headers`.
- `middleware.ts` runs on the edge and does a **presence check only** (no `node:crypto`); every
  page re-verifies via `getSessionUserId()`. Public: `/login`, `/step-up`, `/auth`, **`/print`**
  (the renderer sidecar arrives with no cookies — see below).
- Active company = `gaiada_tenant` cookie validated against `me.companies`, falling back to the
  first (`lib/tenant.ts`). Nearly every helper takes `(userId, tenantId)`.
- `gaiada_prefs` cookie: `density` · `width` · `theme` (`auto | light | dark`).

### Authorization is mirrored, not owned
`lib/rbac.ts` is the UI capability model (`Role` → `Capability[]`, `can(me, cap, companyId?)`,
`isElevated`, `isClient`/`isStaff`/**`isClientOnly`**); `components/shell/nav.ts` gates nav off it. Use
`isClientOnly` for "external client" — `isClient && !isElevated` wrongly matches a manager who is
also a client contact, which stripped their whole staff surface. **Cerbos + RLS on the
backend remain the authority.** Capability families: `admin/company/org/people/pm/it/approvals/
knowledge`, `hr.*`, `search.*`, and the reporting program's `reports.*`, `checkin.*`,
`appraisal.*`. Read the inline comments — several capabilities are "the server narrows this"
(e.g. `reports.person.view` narrows to the caller's reporting line, `appraisal.score` to the
assigned manager). A capability means *may ask*, not *may see every row*.

### Cross-company lists use the envelope
`lib/envelope.ts`: any list spanning more than one company returns `{ items, companies[] }`
where excluded companies are **counted with a reason** (`no_access` | `not_served` |
`suspended` | `error`), never silently dropped. `normalizeEnvelope()` tolerates a bare array
from an ungraduated endpoint; `mergeLegs()` is for client-side per-company fan-out.
`lib/hr.ts` predates this with an identical local `HrEnvelope` — left alone on purpose.

### Department consoles
Two-level IA: a stable primary **group** strip (`Home · Work · <craft> · Connections`) with a
secondary sub-tab strip. `lib/deptToolkits.ts` is the registry — pure and client-safe, keyed by
department **name** slugified (`deptSlug`), so it survives whatever id the org structure
assigns; departments with no bespoke toolkit fall back to Home-only. Routes stay flat
(`/departments/[deptId]/<tab>`) so old deep links work. `[deptId]/layout.tsx` owns header +
`DeptTabs` + the persistent `MyWorkRail`; tab pages render only their body.
`lib/departments.ts` derives the workspace from **org structure + PM poly-assignee**
(`kind=department|division|person`, or a responsible person placed in the dept) — there is no
departments backend. `(app)/[...placeholder]` catches nav routes not yet furnished.

### Reporting / appraisals / check-ins (TR-* program)
Four grains — `/reports/{person,project,department,company}` — plus `/appraisals/*` and the My
Work check-in card. **`lib/reports.ts` is the canonical `ReportDocument` contract**: platform-
nest's `src/modules/reports/report-document.ts` mirrors *it*, not the reverse, so field names
change here first. One typed document feeds viewer, chart kit, table view and exporters.

Print/PDF goes through a sidecar: `/print/reports/[jobToken]` is a **public** route (middleware
allowlist) rendered by the `report-renderer` Playwright sidecar with **no cookies at all** — the
one-shot `jobToken` is what authorizes, in `lib/reports-print-data.ts::getPrintPayload`. Set
`PRINT_STUB=1` (dev/test only) to resolve from `lib/reports-print-stub.ts` fixtures while the
backend endpoint is unbuilt; tokens are `stub-{person,project,department,company}-{sealed,unsealed}`.

Chart kit conventions: `components/reports/charts/` (TrendLine, StackedBars, GroupedBars, Donut,
Burndown, CumulativeFlow, CalendarHeatmap, CohortBand, KpiTiles, DeltaChip), shared crosshair
math in `chartHover.ts`, `ChartDataFallback` for thin data, `ReportTableView` as the always-
available tabular equivalent.

### DEMO_MODE
`DEMO_MODE=1` makes `platformFetch` dispatch to `lib/demoFixtures.ts` before any network call.
It delegates to stateful sub-stores in order: `demoPm` → `demoMeetings` → `demoPipeline` →
`demoReports` → `demoCheckins` → `demoAppraisals`, then its own inline routes. Several demo
identities exist on purpose (`demo-hansel` elevated, `gede-ic` member, `seo-staff`, and
`demo-client` — an external client holding ONLY the `client` role, so the portal-only nav and the
`/portal` landing redirect are drivable; giving it any second role would silently make it staff) so
negative-permission rendering is drivable in a browser. Add a fixture whenever you add a
consumed endpoint — e2e and the build gate both run in demo mode.

### Naming an unbuilt backend
`components/BackendPending.tsx`, `systems/ConnectionState.tsx`, `systems/EmptyNote.tsx`,
`reports/ReportRangeError.tsx`, `reports/ReportAccessDenied.tsx`, `reports/print/PrintRefusal.tsx`.
A capability whose backend is missing must render its cost tier / missing endpoint / owning
ticket. Never a blank table, never a false success.

## Design system (enforced by `src/styles/tokens.test.ts`)

Plain CSS only. Tokens in `src/styles/tokens/{colors,fonts,typography,spacing}.css` imported
once by `globals.css`; each component folder owns a co-located `.css` imported by its owner
component. Primitives in `components/ui.tsx`: `Card`, `Button`, `KpiTile`, `HairlineTable`,
`StatusBadge`, `Toast`, `Eyebrow`, plus `statusColor`/`statusGraphic`/`humanizeStatus`.

The guard test fails the build on all of these, deliberately:
- **No colour literal anywhere in `src/components/**/*.css`** — hex or `rgb()/rgba()` — except
  `creative/creative.css` (overlays on user imagery) and the token layer itself. A `rgba()`
  inside a `var()` fallback chain is allowed.
- Zero border-radius and no `box-shadow` in `globals.css`; shadows are legal only through the
  `--elev-overlay` token on floating layers.
- Every status family exposes both `--status-X` (graphic) and `--status-X-fg` (text) tiers.
- The two dark blocks in `colors.css` (`html:not([data-theme="light"])` under
  `prefers-color-scheme` and pinned `html[data-theme="dark"]`) must declare **identical**
  values — CSS can't union a media query with an attribute selector, so drift would give
  OS-dark and pinned-dark users different colours.
- Brand strings (`SYROWATKA`, bronze `#6E5A43`) intact.

Also: hairline borders, opacity-only hovers, one easing curve (`--erp-ease`), the uppercase
0.30em-tracking `.type-eyebrow` signature. Fonts are self-hosted **variable** woff2 (Cormorant
Garamond display, Inter body, 400–700) split latin / latin-ext by `unicode-range` and preloaded
in `app/layout.tsx` — the old static .ttf/.woff pairs were deleted (1.66 MB → ~85 KB, and
weights 500/600 stopped being browser-synthesised). A11y: skip link, `:focus-visible` ring,
`prefers-reduced-motion` kill-switch, mobile nav toggle in `shell/Sidebar.tsx`.

## Traps that have burned real tickets

- **Frontend-first drift** is the recurring bug class here: the console reads fields the backend
  never sends (`limit` vs `maxKeywords`, bare-vs-wrapped envelope, a column missing from a LIST
  select). It renders a confident wrong answer, nothing throws, `tsc` can't see it, and demo
  fixtures hide it. Verify new reads against a live platform response.
- **Locale/timezone hydration divergence** — `toLocaleString`/`toLocaleDateString` depend on
  runtime ICU. Pin both locale and `timeZone` (see `charts/chartHover.ts::fmtDate`).
- vitest aliases `@` → `src` and `server-only` → an empty module (vitest has no `react-server`
  export condition). That's why a bad `server-only` import passes tests and fails the build.
- `next.config.ts` pins `outputFileTracingRoot: __dirname` because a parent folder has its own
  lockfile; removing it nests `.next/standalone/server.js` several dirs deep.
- Bring the backend up with **both** compose files (`docker-compose.vps.yml` +
  `docker-compose.local.yml`) — the VPS file alone unpublishes `platform:3004` and the host-run
  UI cannot reach it.
- Committed scratch files, not part of the app: `m2-tmp.mjs` (a Playwright mobile probe with a
  hardcoded `/private/tmp/...` path from someone else's machine), `scratch-probe.cjs`,
  `run-dev.ps1`, `setup-autostart.ps1`.

## Contract + status docs

- `../docs/FRONTEND-BFF-CONTRACT.md` — §-numbered, authoritative BFF contract. Update the
  relevant § when you add or change a consumed endpoint; stale "no UI consumer yet" rows have
  been a real defect.
- `../docs/blueprints/tracker-reporting-foundation.md` — the TR-* reporting/appraisal program
  (§6.1 is the `ReportDocument` spec transcribed into `lib/reports.ts`).
- `../docs/modules/MODULES.md` + `CHANGELOG.md` — module status/version. Bump `platform-ui` and
  append an entry on a notable change. Vocabulary: `PLANNED · IN PROGRESS · PROTOTYPED ·
  DEV-VERIFIED`; nothing is production.
- Design source `../design/erp-suite-dashboard-handoff/`; spec
  `../docs/superpowers/specs/2026-07-05-gaiada-erp-ui-design.md`.
- `README.md` here covers run steps only.
