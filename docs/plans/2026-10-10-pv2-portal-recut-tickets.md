# PV-2: client portal re-cut (tickets)

**Status: PLANNED.** Nothing here is built.

- **Parent plan:** `docs/plans/2026-10-10-three-perspectives.md`. PV-2 implements PV-D4 (five
  areas), the groundwork for PV-D10 (a client of two companies), the brand rule from PV-D13, and the
  view switch that PV-D2 needs.
- **Base:** `origin/main` at `9fff3ce3` (`v1.0.0-alpha.343`), read 2026-10-10.
- **Paths:** `PN` = `platform-nest/`, `UI` = `platform-ui/src/`.

## What a client will notice

- **The tab bar.** It drops from 11 tabs to five areas: **Overview · Projects · Business ·
  Contracts & billing · People**. A second row of tabs appears inside an area that has more than one
  page.
- **Badges.** Pending approvals are badged on Projects; unsigned contracts and overdue invoices on
  Contracts & billing.
- **Projects.** They split into **Active** and **Past**, and each shows its project lead.
- **People.** It shows the client's own people, their account manager, and anyone on our side who
  holds access.
- **The header.** It names the company serving them (for example "Gaia Digital Agency"), not
  "Syrowatka".
- **Nothing they already have breaks.** Every link already sent to them still opens the same page.

## Findings from reading the code (they shaped the tickets)

1. **Live bug: a "completed" project shows as active.**
   - The staff project form offers `active, on_hold, completed, archived`
     (`UI/components/forms/ProjectForm.tsx:10`).
   - The portal and the staff client overview treat only `done, complete, archived, cancelled` as
     finished (`PN/src/core/portal-workspace.controller.ts:85-86,281`;
     `PN/src/modules/clients/clients.controller.ts:294-295`).
   - So a project staff mark *completed* is counted, sorted and coloured as active on both sides.
     `UI/lib/portal.ts:459` (`statusTone`) misses it too.
   → **PV2-01.**
2. **The portal cannot tell which companies a person is a client of.**
   - `/api/me` returns `companies` as memberships and client contacts combined
     (`PN/src/core/core.controller.ts:52-58`), with nothing marking which is which.
   - The portal then picks the first company (`UI/lib/tenant.ts:8-13`). A Viceroy employee who is a
     contact of Gaiada (the PV-D2 case) can land on Viceroy, where they are not a client, and see the
     "you are staff" page.
   → **PV2-02, PV2-05.**
3. **Every portal page and action looks up the company on its own.** That is 18 places: all 16
   portal pages, the portal layout, and `UI/lib/portalActions.ts:37` each call `getActiveTenant`. If pages and
   actions ever disagree, a signature or payment is sent to the wrong company and comes back 404.
   → **PV2-05** puts them behind one resolver and adds a test that no portal file can bypass it.
4. **Demo mode's `/api/me` returns every company for every identity** (`UI/lib/demoFixtures.ts:2261`).
   Any test of the company choice has to set `clientOf` per identity.
5. **No company branding field exists** (no logo, no brand name). PV-2 shows the company's name.
   A logo needs a company setting, which is a later ticket and not invented here.
6. **No project-membership table exists.** Projects have only `owner_id`, and clients have
   `owner_user_id` (CC-D10). PV-2 shows the **project lead** and the **account manager** only. A
   fuller "your team" list is a later decision.
7. **Six portal paths are sent to clients in notifications.** They are
   `/portal/approvals/:runId`, `/portal/contracts/:id`, `/portal/invoices/:id`,
   `/portal/requests` and `/portal/social-reviews` (`PN/src/core/client-notify.ts`,
   `contracts.controller.ts`, `pipeline.controller.ts`, `webdev-change-requests.controller.ts`,
   `modules/social/event-handlers.ts`, `mail/intake.ts`), plus `/portal/company` (CC-D9). **No
   ticket moves any portal path.**
8. **CI does not run Playwright** (`.github/workflows/ci.yml` runs `npm test` only). The portal e2e
   (`UI/../e2e/portal.spec.ts`) is a manual step in each ticket's Verify list, and in PV2-08.
9. **The overview's "needs you" items have exactly two kinds, `gate` and `contract`**
   (`UI/lib/portal.ts:51-61`), so the badge split needs no backend change. Overdue invoices come
   from `overview.finance.byCurrency[].overdueCount`.

## Tickets

| Id | Title | Who (model) | Depends on | Wave |
|---|---|---|---|---|
| PV2-01 | One definition of "finished project", including `completed` | medior (Sonnet) | — | 1 |
| PV2-02 | `/api/me` says which companies the caller is a client of (`clientOf`) | medior (Sonnet); lead reviews the RLS read | — | 1 |
| PV2-03 | Portal payloads: `finished`, project lead, account manager, contact side | medior (Sonnet) | PV2-01 | 2 |
| PV2-04 | Portal navigation: five areas, sub-tabs, split badges, new labels | medior (Sonnet) | — | 1 |
| PV2-05 | One portal company resolver, a company switch, the provider's name in the header | medior (Sonnet); lead reviews | PV2-02, PV2-04 | 2 |
| PV2-06 | Workspace ⇄ Client view links | junior (Haiku) | PV2-02 | 2 |
| PV2-07 | Active/Past projects, project lead, the People area | medior (Sonnet) | PV2-03, PV2-04 | 3 |
| PV2-08 | QA gate, live drive, release | qa (Sonnet); lead releases | all above | 4 |
| PV2-09 | `projects.status` CHECK constraint, after a live value survey | senior-db | PV2-01; owner permission for a production read | after |

**Why waves.** Tickets in the same wave own disjoint files. PV2-03 follows PV2-01 because both edit
`portal-workspace.controller.ts`. PV2-05 follows PV2-04 because both edit `PortalShell.tsx` and the
portal layout. The lead reviews every diff before merge, and writes `MODULES.md` and `CHANGELOG.md`
personally (root `CLAUDE.md`).

**Rules for every ticket:**

- **Work in your own worktree from `origin/main`**, never in the shared checkout.
- **Update the matching `docs/FRONTEND-BFF-CONTRACT.md` row in the same change:** §1 for `/api/me`,
  §16 for the portal.
- **Additive fields only.** No existing field changes meaning.
- **Every new portal read keeps its `portal-scope.ts` predicate** (BFF §16 "Isolation model").
- **Background the server gate:** `ssh sumopod 'nohup bash ~/gate.sh <id> both ~/<id>.patch > ~/gate-<id>.log 2>&1 & echo started'`,
  then poll. A foreground run stalls the agent after 600s.
- **Status words:** PLANNED → IN PROGRESS → PROTOTYPED → DEV-VERIFIED. Only PV2-08 can claim
  DEV-VERIFIED.

---

### PV2-01: One definition of "finished project", including `completed`

**Goal.** A project staff mark as completed shows as finished everywhere a client or staff member
sees it.

**Owned paths:**
- `PN/src/core/project-status.ts` (new)
- `PN/src/core/portal-workspace.controller.ts`, at lines 85-86 and 281 only
- `PN/src/modules/clients/clients.controller.ts`, at lines 294-295 only
- `UI/lib/portal.ts` (`statusTone` only)

**Change:**
- Create `project-status.ts` exporting:
  - `FINISHED_PROJECT_STATUSES = ["done", "complete", "completed", "archived", "cancelled"] as const`;
  - `DONE_PROJECT_STATUSES = ["done", "complete", "completed"] as const`;
  - `finishedSql(col)` and `doneSql(col)`, which return `col = ANY($n::text[])`-style fragments, or
    pass the arrays as bind parameters.
- Replace the three hand-written lists with these. Keep the meanings: "active" = not finished;
  "done" = done statuses (archived and cancelled are finished but not *done*).
- `statusTone`: add `"completed"` beside `"complete"` (success).
- Header comment: this is the one list; the staff project form (`ProjectForm.tsx:10`) and PV2-09's
  CHECK must agree with it.

**Must not:**
- change `ProjectForm`'s options;
- add a migration (that is PV2-09).

**Tests:**
- A DB test in `PN` that creates projects in each of the four form statuses and asserts the counts
  from `GET /portal/overview` and `GET /clients/:id/overview`. A `completed` project counts as done
  and not active, and `on_hold` counts as active.
- Prove the test bites: drop `completed` from the constant, and the test must fail.
- Add a `statusTone("completed")` case in `UI/lib/portal.test.ts`.

**Verify:** the server gate for both (`both`); `tsc --noEmit` in both.

**Done when** the gate is green with the new test, and the BFF §16a and §26 rows say "finished =
done, complete, completed, archived, cancelled".

---

### PV2-02: `/api/me` says which companies the caller is a client of

**Goal.** The UI can tell "companies I work in" from "companies I am a client of" without guessing.

**Owned paths:**
- `PN/src/core/core.controller.ts` (`me()` only)
- `PN/src/me.api.test.ts`
- `UI/lib/platform.ts` (`Me` type)
- `UI/lib/demoFixtures.ts` (the `/api/me` route and identity objects only)
- `docs/FRONTEND-BFF-CONTRACT.md` §1

**Change:**
- Add `clientOf: { companyId: string; companyName: string }[]` to the `/api/me` response. It lists
  the distinct companies where the caller has an `active`, non-deleted `client_contacts` row, sorted
  by company name.
- `Me.clientOf` is optional in the UI type, so an older backend still type-checks; treat a missing
  value as `[]`.

**⚠ The trap that decides whether this works.** `client_contacts` is FORCE RLS with a
`principal_lookup` policy keyed on `app.principal_user_id`. Read it from a plain `withGlobal` and it
returns **zero rows with no error**. That exact bug shipped once before (MON-00i, the comment at
`PN/src/rbac/principal.ts:300-311`). Copy that block's pattern:

```
BEGIN; SELECT set_config('app.principal_user_id', $1, true); <query>; COMMIT
```

**Demo mode:**
- The `/api/me` demo route overrides `companies` for every identity (line 2261). Keep that.
- Add `clientOf` from the identity: the client identity is `[{companyId:"co-agency", companyName:"Gaia Digital Agency"}]`;
  staff identities are `[]`.
- Add one demo identity that is **staff of `co-resort` and a contact of `co-agency`** (the PV-D2
  case), for PV2-05 and PV2-06 to test against.

**Tests** (`me.api.test.ts`):
- A user with two active contacts in two companies gets both, sorted.
- A revoked contact is excluded.
- A staff member with no contact row gets `[]`.
- **Teeth:** remove the `set_config` line, and the two-company test must fail (it would return
  `[]`).

**Verify:** the server gate (`both`).

**Done when** the gate is green, the teeth check is recorded in the PR notes, and BFF §1 has a
`clientOf` row marked additive, like the `serviceScopes` row.

---

### PV2-03: Portal payloads: `finished`, project lead, account manager, contact side

**Goal.** The portal can split Active/Past, name who leads each project and who manages the
account, and tell the client's own people from ours, all without the UI re-deriving rules.

**Owned paths:**
- `PN/src/core/portal-workspace.controller.ts` (`projects` and `projectDetail` only)
- `PN/src/core/portal-profile.controller.ts`
- their tests
- `UI/lib/portal.ts` (types only)
- `UI/lib/demoPortal.ts`
- BFF §16a and §16c

**Change** (all additive):

| Endpoint | New field | Source |
|---|---|---|
| `GET /portal/projects`, `GET /portal/projects/:id` | `finished: boolean` | `FINISHED_PROJECT_STATUSES` from PV2-01, the same constant as the sort order |
| `GET /portal/projects/:id` | `lead: { name: string; email: string } \| null` | `projects.owner_id` → `users` (active, not deleted) |
| `GET /portal/profile` | `clients[].accountManager: { name: string; email: string } \| null` | `clients.owner_user_id` → `users` |
| `GET /portal/profile` | `contacts[].side: "client" \| "provider"` | `users.kind`: `client` → client; anything else → provider |

Notes:
- Every query keeps its existing scope predicate. The new joins only read the `users` rows of
  owners already reachable through scoped `projects` and `clients` rows.
- `side` does **not** filter anyone out. Staff who hold contact rows (for example placeholder P-04)
  stay visible, labelled as our side. Hiding someone who holds signer access would be the wrong
  failure.

**Tests:**
- `finished` is true for each finished status and false for `on_hold`.
- `lead` is null when there is no owner, and when the owner is deleted.
- `accountManager` is scoped: a contact of client A never sees client B's account manager.
- `side` is `provider` for an employee contact.
- Each new field is absent from no row; check the select list, because a missing column reads as
  null.

**Verify:** the server gate (`both`).

**Done when** the gate is green and BFF §16a and §16c rows list the four fields.

---

### PV2-04: Portal navigation: five areas, sub-tabs, split badges, new labels

**Goal.** The PV-D4 navigation, with every existing URL unchanged.

**Owned paths:**
- `UI/lib/portalNav.ts` (new) and `UI/lib/portalNav.test.ts` (new)
- `UI/components/portal/PortalTabs.tsx`
- `UI/components/portal/portal.css`
- `UI/components/portal/PortalShell.tsx` (the props for tabs and badges only)
- `UI/app/(portal)/portal/layout.tsx` (the badge counts only)
- page headings in `UI/app/(portal)/portal/contracts/**`, `profile/page.tsx` and `company/**`
- `e2e/portal.spec.ts`

**Change:**

1. `portalNav.ts` exports `PORTAL_AREAS` and the pure function
   `activePortalNav(pathname): { areaKey, tabHref }`. It uses longest-prefix matching, with an exact
   match only for `/portal`.

   | Area | Sub-tabs (label → existing path) |
   |---|---|
   | Overview | Overview → `/portal` |
   | Projects | Projects → `/portal/projects` · Approvals → `/portal/approvals` · Deliverables → `/portal/deliverables` · Requests → `/portal/requests` · Post reviews → `/portal/social-reviews` · Timeline → `/portal/timeline` |
   | Business | Business → `/portal/company` |
   | Contracts & billing | Contracts → `/portal/contracts` · Invoices → `/portal/invoices` |
   | People | People → `/portal/profile` |

   It is portal-only on purpose: do not import or refactor `UI/components/shell/DeptTabs.tsx`. The
   portal shares no chrome with the staff shell (`(portal)/portal/layout.tsx` header).
2. `PortalTabs` renders a primary strip of five links (each linking to its area's first sub-tab) and,
   when the active area has more than one tab, a secondary strip. It uses `aria-current="page"` on
   the active link in each strip. Keep the existing `.cp-tab` look for the primary strip, and add
   `.cp-subtabs`/`.cp-subtab` styled from the existing portal tokens (no new colours).
3. **Badges:**
   - `projectsBadge` = `needsYou` items with `kind === "gate"`.
   - `billingBadge` = `needsYou` items with `kind === "contract"`, plus the sum of
     `finance.byCurrency[].overdueCount`.
   - Compute both in the layout from the overview it already fetches. No new fetch.
   - The Post reviews sub-tab keeps **no** badge, for the reason in today's `PortalTabs` comment.
4. **Labels:**
   - "Agreements" → **Contracts** (tab and `h1`);
   - "Profile" → **People**;
   - "Business profile" → **Business**.

   Change user-facing words only. Code identifiers, routes and API names stay as they are.
5. Rewrite `PortalTabs`' header comment to record PV-D4 and why paths did not move (finding 7).

**Must not:**
- move, rename or redirect any route;
- touch `getActiveTenant` (that is PV2-05).

**Tests:**
- `portalNav.test.ts` maps **every** current route, including each dynamic detail route
  (`/portal/projects/p1`, `/portal/approvals/r1`, `/portal/contracts/k1`, `/portal/invoices/i1`,
  `/portal/social-reviews/s1`, `/portal/company/mk/web`), to the right area and tab.
- `/portal` lights only Overview.
- An unknown `/portal/xyz` lights nothing and does not throw.
- Update the e2e "every portal tab renders" test: the heading for `/portal/contracts` becomes
  `/Contracts/`, and the test also clicks each **area** link once.

**Verify:**
- the server gate (`ui`);
- `next build` (a green suite can still hide a server-only violation);
- the portal e2e in DEMO_MODE, run on the server in the background:
  `npm run e2e -- e2e/portal.spec.ts`.

**Done when:**
- the gate, the build and the portal e2e are green;
- screenshots of an area with sub-tabs and one without, at desktop and phone widths, are in the PR
  notes.

---

### PV2-05: One portal company resolver, a company switch, the provider's name in the header

**Goal.**
- Every portal page and action uses the same, explicit choice of company.
- A contact of two companies can switch between them.
- The header names the serving company.

**Owned paths:**
- `UI/lib/portal-company.ts` (new, `server-only`) and its test
- every `UI/app/(portal)/portal/**/page.tsx` (the `getActiveTenant` line only)
- `UI/app/(portal)/portal/layout.tsx`
- `UI/lib/portalActions.ts` (`ctx()` only)
- `UI/components/portal/PortalShell.tsx` (the brand only)
- `UI/components/portal/PortalCompanySwitch.tsx` (new)

**Change:**

1. `portal-company.ts` exports:
   - `getPortalCompanies(me)` → `me.clientOf ?? []`;
   - `getActivePortalCompany(me)` → `{ id, name } | null`, read from a **separate** httpOnly cookie
     `gaiada_portal_tenant`;
   - `switchPortalCompany(formData)`.

   Selection rules:
   - Validate the cookie against `clientOf`.
   - With no valid cookie, fall back to the **only** company when there is exactly one.
   - With several companies and no cookie, choose the first by name, and show the switch.
   - With none, return `null` (the existing staff teach-state).

   It must never fall back to a company the caller is merely employed by. It uses its own cookie
   because the staff cookie `gaiada_tenant` belongs to the workspace. A Viceroy employee's
   workspace choice must not change which company their portal shows, or the reverse.
2. Replace `getActiveTenant(me)` with `getActivePortalCompany(me)` in all 16 portal pages, the
   portal layout, and `portalActions.ts` `ctx()`.
3. Add a test that **fails if any file under `UI/app/(portal)/` or `UI/lib/portalActions.ts` imports
   `getActiveTenant`**, by reading the files as text. This is the guard for finding 3.
4. `PortalShell` brand: `<company name> · Client Portal`, falling back to "Client Portal" alone
   when null. Remove the hard-coded "Syrowatka" (PV-D13).
5. `PortalCompanySwitch` is rendered in the header **only when `clientOf.length > 1`**. It is a
   `<select>` posting to `switchPortalCompany`, which sets the cookie and redirects to `/portal`.
   With one company, nothing renders.
6. Per-company Overview sections (plan §3.2) are **not** in this ticket. They wait for a second
   company with portal clients.

**Tests:**
- Unit tests of the selection rules: one company; two companies with a valid cookie; a cookie
  naming a company not in `clientOf` (ignored); a staff-only user (null).
- The import guard from step 3.
- An e2e with the PV2-02 demo identity (staff of `co-resort`, contact of `co-agency`): opening
  `/portal` shows Gaia Digital Agency's portal, not the staff teach-state. A two-company demo
  identity sees the switch, switches, and the brand changes.

**Verify:** the server gate (`ui`), `next build`, and the portal e2e.

**Done when** all are green and the BFF §16 header notes that the portal's company comes from
`clientOf`.

---

### PV2-06: Workspace ⇄ Client view links

**Goal.** People who are both staff and a client contact can move between the two interfaces.

**Owned paths:**
- `UI/components/shell/UserMenu.tsx`
- `UI/components/portal/PortalUserMenu.tsx`
- their tests

**Change:**
- In the staff `UserMenu`, add a **"Client view"** link to `/portal` when `(me.clientOf ?? []).length > 0`.
- In `PortalUserMenu`, add a **"Back to workspace"** link to `/` when the user has any non-`client`
  role (the existing `isStaff` in `UI/lib/rbac.ts`).
- This is navigation only. No authorization changes, and no redirects added or removed.

**Tests:** both links render for the PV2-02 demo identity, and neither renders for a pure client or
a pure staff identity.

**Verify:** the server gate (`ui`).

---

### PV2-07: Active/Past projects, project lead, the People area

**Goal.** The client sees past projects as history, who leads each project, and who serves them.

**Owned paths:**
- `UI/app/(portal)/portal/projects/page.tsx`
- `UI/app/(portal)/portal/projects/[projectId]/page.tsx`
- `UI/app/(portal)/portal/profile/page.tsx`
- portal components they use
- `UI/lib/demoPortal.ts` (data only)

**Change:**
- **Projects list:** two sections, **Active** and **Past**, split on `finished` from PV2-03. Never
  re-derive it from `status` in the UI. Past is collapsed by default when Active is not empty.
  Empty states name the next step.
- **Project page:** a "Project lead" line (name, plus the email as text with a copy button).
  Nothing renders when `lead` is null; never show "Unknown".
- **People** (`/portal/profile`, now headed **People**), in three groups:
  - "Your people": `side === "client"`, with their access;
  - "Your account manager", per client from `accountManager`;
  - "On our side": `side === "provider"` contacts, showing their access, so a client can see who
    from our company can sign on their account.

**Tests:** unit tests of the Active/Past split and the People grouping against `demoPortal`
fixtures; an e2e that a finished demo project appears under Past.

**Verify:** the server gate (`ui`), `next build`, and the portal e2e.

---

### PV2-08: QA gate, live drive, release

Owner: the qa agent. The lead releases.

1. **Merged tree:** run the server gate on the merged branch (`both`). The test count must equal
   the baseline plus the sum of each ticket's added tests. Read `patch: N files touched, of which
   NEW: M` from `gate.sh`, never `git diff --stat`.
2. **`next build`.**
3. **Portal e2e in DEMO_MODE**, in the background on the server. Also run the axe a11y spec for the
   portal routes: `npm run e2e:a11y`.
4. **Link check:** every portal path the backend emits (finding 7) opens the right area and tab, as
   a logged-in client.
5. **Live drive after deploy, as a client.**
   - Use a P-03 placeholder login (`portal@<slug>.test`); it is a placeholder, so this is allowed.
   - Walk the five areas. Mark a project `completed` in the staff UI and see it move to Past on the
     portal.
   - Sign in as the dual identity, if one exists on the server, and check the company choice.
   - Record what was observed. **DEV-VERIFIED requires this step**; a green suite is not enough.
6. **Release** (lead):
   - Run `docs/plans/2026-10-10-three-perspectives.md` §10's contract checks.
   - Bump `MODULES.md` and write the `CHANGELOG.md` entry yourself. Check
     `git diff --numstat` shows 0 deletions, and that no heading is duplicated.
   - Regenerate MAP from a clean worktree.
   - Tag. Cerbos restarts only if a policy changed; none should have.

---

### PV2-09: `projects.status` CHECK constraint, after a live value survey

Owner: senior-db. It runs after PV-2.

**Why:**
- PV2-01 fixes the symptom, but `projects.status` is still free text (`PN/migrations/0001_core.sql`).
- The next hand-typed status (for example `finished`) would silently count as active again.

**Steps:**

1. **With the owner's permission** (production reads need it every time), run
   `SELECT status, count(*) FROM projects GROUP BY 1` on `gda-aicenter`.
2. Write a migration that:
   - maps stray values to the canonical set, `planned, active, on_hold, completed, cancelled,
     archived`, keeping `done` and `complete` only if the survey shows they are in use, with the
     mapping reviewed by the owner;
   - adds the CHECK;
   - asserts its own row counts. An unset RLS GUC makes an UPDATE touch zero rows silently.
3. Make `ProjectForm`, `FINISHED_PROJECT_STATUSES` and the CHECK one set, with a parity test across
   the three.

**Must not** use DROP+ADD on any other shared CHECK in the same migration.

---

## Not in PV-2 (and where each goes)

| Item | Why not now | Goes to |
|---|---|---|
| Per-company Overview sections | Only Gaiada has portal clients | when a second company has clients (plan §3.2) |
| A client switch within one company | The portal already shows all of a contact's clients in a company together, and every row carries its client name | when a real multi-client contact exists |
| Company logo in the header | There is no branding setting to read | a later company-settings ticket |
| Requirement documents on the project page | Exposing pipeline artifacts needs new backend reads | PV-4 or a dedicated ticket |
| Client document library | It belongs to Contracts & billing depth | PV-5 |
| Staff hub relabel and the staff Contracts & billing area | A different surface | PV-3 |
| Fuller "your team" list | No project-membership table; needs a decision | later decision |
