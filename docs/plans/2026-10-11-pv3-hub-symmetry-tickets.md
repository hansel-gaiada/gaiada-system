# PV-3: the staff client page mirrors the portal (tickets)

**Status: PLANNED.** Nothing here is built.

- **Parent plan:** `docs/plans/2026-10-10-three-perspectives.md` §3.3, §4.2, §9 (traps 1, 7, 9, 11).
  PV-3 implements PV-D4 on the staff side, plus the PV-D1 business-type rule and the PV-D2 group-client
  link. It absorbs slices 2 and 3 of `docs/plans/2026-08-24-client-centric-erp-design.md`.
- **Rulings in force:** PV-D4 (same five areas as the portal, every URL kept, the hub adds Internal),
  PV-D2 (Viceroy is a Gaiada client), PV-D10 (one client record per company), PV-D13 (no company
  names or ids in code).
- **Base:** `origin/main` at `c679aab1` (`v1.0.0-alpha.355`), read 2026-10-11 from a clean detached
  worktree. 355 already carries the portal signing fix (`a783fbba`) that PV-3 was told to wait for.
- **Paths:** `PN` = `platform-nest/`, `UI` = `platform-ui/src/`.

## What people will notice

- **Staff on a client page:** the tabs read **Overview · Projects · Business · Contracts & billing ·
  People · Internal**. Every old address still works; only `/clients/[id]/billing` is new.
- **Projects** now holds everything about the work: projects and tasks, deliverables, approvals,
  requests (change requests and post reviews) and meetings. Meetings move here from People.
- **Contracts & billing** is new. For the first time staff can draft, send and countersign a contract,
  and confirm or reject a payment a client reported, without calling the API by hand. Invoices show
  as a list.
- **Every row says who sees it:** "Client sees this" or "Internal". The backend decides, from the same
  rules the portal uses. **Internal** (notes and history) is styled so it can't be mistaken for a
  client area.
- **Company owners can countersign.** Today nobody but `platform_admin` can (finding 2).
- **New clients need a business type**, and the Clients list can filter to the ones still on
  "Other or not set".
- **Viceroy shows as a group client** once the owner marks it (PV-D2).
- **Clients see no change.** The portal is not touched, except that its visibility rules move into one
  shared file with identical results (PV3-02).

## Findings from reading the code (they shaped the tickets)

1. **The hub is a flat, five-tab strip with a loose matcher.** The tabs are Overview, Work, Profile,
   Contacts & meetings, Notes & history (`UI/app/(app)/clients/[clientId]/layout.tsx:56-66`).
   `ClientHubTabs.tsx:36` matches with a bare `startsWith`, with no segment boundary (`/work` would
   also match `/workshop`). → **PV3-05.**
2. **Plan trap 7 is real: a company `owner` cannot countersign.**
   - `resource_contract.yaml` has no countersign rule at all. Only the `platform_admin` wildcard
     reaches it (lines 13-15).
   - The comment at lines 20-23 says "COUNTERSIGNING IS OWNER-ONLY", but no owner arm exists.
     `owner` is permission-native and has no derived role.
   - `core.contract.countersign` is in neither the catalog (`PN/src/rbac/permission-catalog.json:872-920`)
     nor the owner bundle (`role-permission-bundles.json:1632-1636`).
   - BFF §16e (`docs/FRONTEND-BFF-CONTRACT.md:1752`) still says "owner-only
     (platform_admin/group_executive)", and `group_executive` is gone.
   - The intent was recorded as "owner-only, deliberately narrower than company_admin"
     (`docs/modules/CHANGELOG.md:9082`, `docs/plans/2026-08-04-client-portal-deployment.md:141`).
     PV3-01 implements that intent. It is not a new ruling.
   - PV-1 set the precedent shape: a `roles: ["user"]` rule with a `grants.exists(g.role == "owner" …)`
     condition (`resource_report_document.yaml:85-96`). No permission key moves, so a custom role or a
     `company_admin` can never reach countersign. → **PV3-01.**
3. **A contract is `signed` only when both parties have signed, in either order.** There is no
   `countersigned` status (CHECK `0075_client_portal.sql:107-108`: `draft, sent, signed, declined,
   expired, void`). A client who signs first leaves the contract `sent` until staff countersign
   (`portal-commerce.controller.ts:366-389`). So without PV3-01 and PV3-08, every client-signed
   contract waits forever. → **PV3-01, PV3-08.**
4. **The portal's visibility rules are inline SQL, copied across controllers.**
   - `portal-scope.ts` only resolves a caller to `{clientIds, projectIds, canSign}`. It holds no row
     predicate.
   - The one shared fragment, `PROJECT_SCOPE` (`portal-workspace.controller.ts:37`), is module-private,
     although its comment says "exported".
   - Contracts' `status <> 'draft'` appears four times (`portal-commerce.controller.ts:255,481,502`,
     `portal-workspace.controller.ts:456`), and gates' `actor_side = 'client'` at least four times.
   - Backend-computed markers therefore need one shared predicate module first, or the staff marker and
     the portal will drift (trap 9). → **PV3-02**, then **PV3-07.**
5. **Facts the markers must encode** (each from the portal's own SQL):
   - Projects, milestones and deliverables are visible through `PROJECT_SCOPE`. Deliverables have no
     visibility flag.
   - Runs are visible, with the `report` stage hidden. Gates are visible only when
     `actor_side = 'client'`.
   - Contracts and invoices are visible when not `draft`.
   - A payment is visible through its parent invoice, and the timeline shows only `confirmed` ones.
   - Change requests: client plus project scope, or no project. Post reviews: client only.
   - **Never visible:** tasks (the portal deliberately lists none, `portal-workspace.controller.ts:9-14`),
     meetings (no portal read exists), notes (`comments`) and history (`activities`).
   - No `client_visible`-style column exists anywhere today. → **PV3-02, PV3-07.**
6. **The hub's reads fold refusals into empty lists, and one reads more than it shows.**
   - `work/page.tsx:33` has `listProjects(...).catch(() => [])`, so a denied read shows as "no projects"
     (agentic bar criterion 5).
   - Deliverables are fetched for the whole tenant and filtered in the browser (`work/page.tsx:37-41`).
     The backend already filters by `clientId` (`client-work.controller.ts:19-24`), but
     `listDeliverables` never passes it (`UI/lib/entities.ts:249-250`). → **PV3-05.**
7. **Meetings live on Contacts & meetings today**, in the "Scheduled" and "Meetings" cards
   (`contacts/page.tsx:35-45, 75-114`, `ScheduleMeetingPanel`, `RecordControls`). The move is a lift of
   those reads and that JSX into Projects. → **PV3-05.**
8. **Staff have no screen for contracts or payment claims.**
   - No staff page or UI wrapper calls `/contracts` or `/invoice-payments`.
   - `/billing` is a 308 shim to `/invoices` (`UI/app/(app)/billing/[[...rest]]/page.tsx`).
   - The demo has no handlers for either endpoint.
   - The hub Overview's demo items link to `/clients/:id/requests` and `/clients/:id/commercial`, and
     neither page exists (`UI/lib/demoFixtures.ts:~2680-2684`). → **PV3-05, PV3-08.**
9. **Payment claims have a decide route but no client filter.**
   - `GET /:t/invoice-payments` takes `status` only (`contracts.controller.ts:331-356`).
   - `POST /:t/invoice-payments/:id/decide` (`:365-474`) confirms or rejects. It needs a reason to
     reject, and the person who recorded a payment cannot confirm it.
   - `GET /:t/contracts` takes `clientId` as a raw uuid, so `?clientId=internal` hits the uuid cast and
     500s (`:66`; BFF §22a's "KNOWN GAP").
   - `client-filter.ts` exists, but only projects, pm/tasks and invoices use it. → **PV3-03.**
10. **No agent can do any of this.**
    - There are no MCP tools for contracts or payment decisions. The only invoice tool is a read
      (`PN/src/modules/invoice/index.ts:32-40`).
    - The agentic-native plan names invoicing "the one GM loop with zero automation surface"
      (`docs/superpowers/plans/2026-08-03-agentic-native-erp-plan.md:170-205`).
    - Staff UI for money and legal writes without tool parity would widen that gap. → **PV3-06.**
11. **Business type is optional by construction.**
    - `client_centre_profiles.business_type` is `NOT NULL DEFAULT 'other'`
      (`202609281655_client_centre_profiles.sql:30`), but creating a client writes no profile row
      (`clients.controller.ts:77`; lead conversion likewise, `agency-lead-convert.service.ts:568`).
    - A client with no row reads as `other` (`centre/store.ts:12-16`, `clients-centre.controller.ts:45-47`).
    - So "explicitly other" and "never set" look the same, and the review list has to treat both alike.
    - Leads carry no business type, so conversion can't supply one.
    - The MCP `clients.create` tool sends only `{name, contact}` (`mcp-hub/src/platform-write-tools.ts:92-103`).
      → **PV3-04.**
12. **`clients` has no link to our companies, and `companies` is global.**
    - Nothing maps a client to a company today. The only `counterparty_company_id` is on
      `finance_accounts` (`202608251430_finance_intercompany_accounts.sql`).
    - `companies` has no RLS. A plain FK to it runs outside the tenant wall, so the same-root rule must
      be enforced in the app. Precedent: `resolveGithubOrgTenant` (`PN/src/core/github-org-tenant.ts:52`).
    - The PATCH history diff is hard-coded (`client-input.ts:88`), so a new column won't appear in
      History unless that diff is extended.
    - The seed has no Viceroy client row; the live one is data. → **PV3-04.**
13. **WebDesk overlap is small today.** WSK-49f's backend is on main (BFF §16i, line 1857, "no UI yet").
    Its "website editor" grant control is on no branch yet. PV3-05 touches `contacts/page.tsx` only to
    remove the meetings cards. Tell the WebDesk sessions before merging, because their control will
    land on the same page and on `ClientContactsPanel.tsx`.
14. **Tests that pin today's hub:** `e2e/client-hub.spec.ts:56-58` clicks a link named `/^Work/`,
    which breaks on the rename on purpose. No unit test pins the hub labels. The hub has no axe spec;
    `e2e/a11y-axe-portal.spec.ts:23,55` is the pattern.

## Waves

| Wave | Tickets | Why this order |
|---|---|---|
| 1 | PV3-01 (countersign rule), PV3-02 (predicate module), PV3-03 (client facets), PV3-04 (client data), PV3-05 (hub areas and Projects) | disjoint files; nothing here needs another ticket |
| 2 | PV3-02b (mail thread scope), PV3-02c (isolation fixes), PV3-06 (billing tools), PV3-07 (`clientVisible` + parity), PV3-08 (Contracts & billing page) | 02b and 02c need 02; 06 needs 01 and 03; 07 needs 02 and 03 (same controllers as 03); 08 needs 01 and 03, and edits the layout after 05 |
| 3 | PV3-09 (markers on every area, hub axe) | needs 05, 07 and 08 merged |
| 4 | PV3-10 (QA, release, live) | after the merged tree is green |

**Rules for every ticket:**

- Work in your own worktree from `origin/main`, never in the shared checkout.
- No company names or ids in code (PV-D13).
- Every portal query keeps its predicate from `portal-scope.ts` and, after PV3-02,
  `portal-visibility.ts` (trap 1).
- A visibility marker comes from the backend or it doesn't ship (trap 9).
- Authorization runs before validation, so denial tests test authorization.
- Update the matching `docs/FRONTEND-BFF-CONTRACT.md` row in the same change.
- Background the server gate (`gate-full.sh <id> both <patch>`) and poll for `### done`.
- Prove each new test bites (break the code, watch it fail) and say how in the hand-back.
- Status words: PLANNED → IN PROGRESS → PROTOTYPED → DEV-VERIFIED. Only PV3-10 can claim DEV-VERIFIED.
- The lead writes `MODULES.md` and `CHANGELOG.md`, regenerates MAP and the capability inventory from
  a clean tree, and reviews every diff before merge.

---

### PV3-01: company owners can countersign (plan trap 7)

**Owner:** senior-be. **Wave 1.**

**Owned paths:** `PN/cerbos/policies/resource_contract.yaml` and its Cerbos test matrix;
`PN/src/core/contracts.controller.ts` (`GET` contract list and detail only: the new `canCountersign`
field, and the list's `clientId` filter, so one ticket owns that handler);
`docs/FRONTEND-BFF-CONTRACT.md` §16e; `docs/PERMISSION-CONTRACT.md` (a dated note).

**Change:**
- Add a `countersign` rule for `roles: ["user"]` with the condition `variables.inTenant &&
  variables.notLow && request.principal.attr.grants.exists(g, g.role == "owner" && g.scopeType ==
  "company" && g.scopeId == request.resource.attr.tenantId)`. Copy the shape and its comment from
  `resource_report_document.yaml:85-96`.
- **No permission key, no bundle change, no perm-arm rule.** That keeps countersign out of reach of
  `company_admin` and of any custom role, which is the recorded intent.
- Rewrite the comment at lines 20-23: who countersigns now, and why `company_admin` stays excluded.
  Drop the dead `group_executive` mention.
- `GET /:t/contracts` and `GET /:t/contracts/:id` rows gain `canCountersign`, true when all of these
  hold:
  - one Cerbos check per request allows `countersign` on `{kind: "contract", tenantId}` (the rule
    depends only on the tenant, so one check covers every row; never one check per row, since the
    batch limit is 50);
  - the status is `sent`;
  - no `provider` signature exists.
- `GET /:t/contracts` parses `clientId` with `parseClientFilter(raw, true)` and `clientFilterSql`, as
  PV3-03 does for the other lists: `internal` means `client_id IS NULL`, and a non-uuid gets a 400
  instead of today's 500 (finding 9).
- Correct BFF §16e's countersign note.

**Tests:**
- Cerbos and HTTP:
  - the owner of the contract's company countersigns a `sent` contract (200);
  - the owner of another company, a `company_admin`, a `manager`, and a user whose custom role holds
    every `core.contract.*` key all get 403;
  - `platform_admin` gets 200.
- `canCountersign` is true for that owner and false for a `company_admin`.
- `GET contracts?clientId=`: a uuid returns only that client's rows, `internal` returns only clientless
  rows, and garbage returns 400.
- Teeth: delete the rule and the owner case fails. Widen `scopeId` to any company and the
  other-company case fails.

**Deploy note:** Cerbos needs a restart, then a probe proving an owner ALLOW and a `company_admin` DENY.

### PV3-02: one set of portal visibility predicates

**Owner:** senior-be. **Wave 1.** A behaviour-preserving refactor of the portal's isolation layer, so
it needs a senior and a careful review.

**Owned paths:** new `PN/src/core/portal-visibility.ts` and its test. The predicate SQL only (no other
lines) in `PN/src/core/portal-workspace.controller.ts`, `portal-commerce.controller.ts`,
`portal.controller.ts`, `webdev-change-requests-portal.controller.ts` and
`social-client-review-portal.controller.ts`.

**Change:**
- Export one SQL fragment builder per entity, parameterised by table alias, for example
  `contractClientVisible("k")`. Cover:
  - project (`PROJECT_SCOPE`, now exported) and milestone;
  - deliverable;
  - run, including the hidden `report` stage, and gate (`actor_side = 'client'`);
  - contract and invoice (not `draft`);
  - invoice payment, in two named contexts: "detail" (parent invoice visible) and "timeline"
    (`confirmed`);
  - change request and post review;
  - client contact, using whatever the portal People area reads (PV2-07).
- Export `NEVER_CLIENT_VISIBLE = ["task", "meeting", "note", "history"]`, with the reason for each
  (finding 5).
- Every portal controller builds its WHERE clause from these builders. Results must not change.

**Must not:** change any portal response, add a route, or touch `portal-scope.ts`'s resolver.

**Tests:**
- Every existing portal suite stays green unchanged: `portal-payloads.db.test.ts`, `portal.test.ts`,
  `portal-dashboard.test.ts`, `portal-client-contacts.test.ts`, `portal-centre.db.test.ts`,
  `social-client-review-portal.controller.test.ts` and `webdev-change-requests-portal.controller.test.ts`.
- New guard test. It scans every `PN/src` file that imports from `portal-scope` (`resolvePortalScope`,
  `callerClientIds`, `requireSigner`), not a hand-kept list, so new portal routes are covered
  automatically. Today that includes `client-website-access.controller.ts`; WebDesk's
  `webdesk-client-website.*` files join in 356. None of these files may contain the old inline
  literals (`status <> 'draft'`, `actor_side = 'client'`, the `PROJECT_SCOPE` body) outside
  `portal-visibility.ts`. The test also asserts that the scan found the five refactored controllers,
  so a broken scan can't pass vacuously.
- Teeth: re-inline one predicate and the guard fails.

### PV3-02b: portal mail threads follow the portal's run scope (found by PV3-02's guard)

**Owner:** senior-be. **Wave 2** (needs PV3-02 merged).

**Finding (2026-10-11).** `GET /:t/portal/mail/threads?runId=` (`PN/src/mail/thread.controller.ts:288-294`)
admits a run with no project to a **project-scoped** contact (`OR r.project_id IS NULL`). The portal's
own run list and run page do not (`runInPortalScope` admits no project-less run for such a contact),
so the run's thread panel is unreachable in the UI, yet the thread is readable through the API by run
id. Same client only: no cross-client or cross-company exposure. The `gateId` branch of the same route
already matches the portal.

**Owned paths:** `PN/src/mail/thread.controller.ts` (the `runId` branch only) and its test; the
`NOT_YET_SWITCHED` entry in `PN/src/core/portal-visibility.test.ts`.

**Change:** build both branches from `runInPortalScope` and `gateClientVisible`, then remove the file
from the ratchet list. This narrows a read to what the portal already shows, so it needs no new ruling;
the owner may overrule it.

**Tests:** a project-scoped contact gets 404 for a project-less run's thread, and a client-wide contact
gets 200. Teeth: put back `OR r.project_id IS NULL` and the 404 case fails.

### PV3-02c: portal isolation fixes found while extracting the predicates

**Owner:** senior-be. **Wave 2** (needs PV3-02 merged). Each fix narrows what a client can do or see to
what the rest of the portal already allows, so none needs a new ruling.

1. **A client can decide an internal gate (moderate).** `POST /:t/portal/runs/:runId/scope-sign`
   (`PN/src/core/portal.controller.ts:291-297` on 355) marks the gate named by the client-supplied
   `body.gateId` as decided when the sign-off completes, with no `actor_side = 'client'` check. A
   client signer can close an internal review gate on their own run. It fires once per run, needs a
   signer contact, and stays within the client's own run. Fix: add `gateClientVisible("")` (or check
   that the gate is the run's scope sign-off gate) to that UPDATE. Test: an internal gate id in the body
   stays pending; teeth: drop the check and it is decided.
2. **A deliverable file stays downloadable after its project is deleted (low).**
   `ownsEntity.deliverable` (`portal-commerce.controller.ts:497-499`) uses the project's reach without
   `p.deleted_at IS NULL`, while every deliverable list hides it. Fix: use `projectInPortalScope`.
3. **A payment shows without its invoice (low).** The timeline's payments and the receipt download reach
   a payment by its own `client_id` (`portal-workspace.controller.ts:470`, `portal-commerce.controller.ts:508`)
   and never check the parent invoice, so a confirmed payment on a deleted invoice still shows. Fix:
   join the invoice and require `invoiceInPortalScope`.

**Owned paths:** those three call sites, their tests, and the equivalence entries in
`PN/src/core/portal-visibility.test.ts` that pin the old shapes (update them on purpose).

### PV3-03: client facets for Contracts & billing (client-centric slice 2, backend)

**Owner:** senior-be. **Wave 1.**

**Owned paths:**
- the list filters in `PN/src/core/contracts.controller.ts` (`GET invoice-payments` only; PV3-01 owns
  `GET contracts`),
  `client-work.controller.ts` (`GET deliverables`), `pipeline.controller.ts` (`GET pipeline/runs`),
  `meetings.controller.ts` (`GET meetings/recordings`), `webdev-change-requests.controller.ts`
  (`GET webdev/change-requests`), and the social lists in `PN/src/modules/social/`. **No staff
  post-review list exists** (PV3-03 found only per-variant review routes), so the facet went on the two
  social lists that already took `clientId`: engagements and accounts;
- `docs/FRONTEND-BFF-CONTRACT.md` §16e and §22a.

**Change:**
- Each of these lists (and `GET contracts`, in PV3-01) parses `clientId` with `parseClientFilter(raw, true)` and filters with
  `clientFilterSql`:
  - `internal` means `client_id IS NULL`;
  - a non-uuid gets a 400, not today's 500;
  - strict mode, because a hub page asking for one client must never silently get every client.
- `GET /:t/invoice-payments` gains `clientId`.
- Remove §22a's "KNOWN GAP".
- First check whether pipeline, meetings and change requests already honour `internal` (the strings
  appear there). Say what you found.
- The three existing users (projects, pm/tasks, invoices) keep their fail-open mode. Changing that
  is out of scope.

**Tests:**
- Per endpoint: a uuid returns only that client's rows; `internal` returns only clientless rows;
  garbage returns 400.
- `invoice-payments?clientId=` never lists another client's payment.
- Teeth: drop the payments filter and the other-client case fails.

### PV3-04: client data: a group-company link and a required business type

**Owner:** senior-db (migration) with senior-be and senior-fe, **in one worktree**, because both halves
edit the same write path. **Wave 1.**

**Owned paths:**
- **Database and API:**
  - a new migration `PN/migrations/<UTC-minute>_clients_group_company.sql`;
  - `PN/src/modules/clients/clients.controller.ts` (`CLIENT_COLUMNS`, POST, PATCH);
  - `PN/src/modules/clients/client-input.ts`;
  - the profile store reuse in `PN/src/modules/clients/centre/store.ts`;
  - a seed row in `PN/src/seed/agency.ts`.
- **Tools:** `mcp-hub/src/platform-write-tools.ts` (`clients.create`, `clients.update`).
- **UI:**
  - `UI/components/forms/ClientWorkForms.tsx` and `UI/lib/clientWorkActions.ts`;
  - `UI/lib/entities.ts` (`Client`);
  - `UI/app/(app)/clients/page.tsx` and `ClientsTable.tsx`;
  - the hub header in `layout.tsx` (one badge only);
  - the demo clients in `UI/lib/demoFixtures.ts`.
- **Docs:** `docs/FRONTEND-BFF-CONTRACT.md` §26.

**Change, group company (PV-D2):**
- The migration adds:
  - `clients.group_company_id uuid NULL REFERENCES companies(id)`;
  - `CHECK (group_company_id IS DISTINCT FROM tenant_id)`;
  - a partial index.
- No backfill: names are data (PV-D13).
- POST and PATCH accept `groupCompanyId` (`null` clears it).
  - **Authority (lead's default, owner may widen; see "Open for the owner"):** setting or changing it
    needs `isPlatformOperator(req)` (`PN/src/admin/elevated.ts:71`: `platform_admin`, or a root owner).
    Anyone else gets a 403, checked before validation.
  - Validation through `withGlobal` (the `resolveGithubOrgTenant` precedent): the target exists, is
    not deleted, and shares the client's tenant's `root_company_id`. Each failure is a 400 with a typed
    code.
- Reads return `groupCompany: {id, name} | null`. `companies` is global, so a LEFT JOIN works inside
  the tenant transaction.
- The hub header and the Clients list show a "Group company" badge. History records the change.
- Seed: Gaiada gets a client row for the hospitality sibling, linked to it. Demo: the same in
  `demoFixtures.ts`, linked to `co-resort`.

**Change, business type (PV-D1, §3.3):**
- `POST /clients` requires `businessType`, one of `registry.json`'s `businessTypes`. It returns 400
  `business_type_required` or `business_type_invalid`. It writes the `client_centre_profiles` row **in
  the same transaction** through the existing store, so a new client is never "not set".
- `PATCH /clients/:id` accepts `businessType` and upserts the profile in the same transaction. It
  emits the same `client.centre_updated` event the centre PATCH emits. `diffForActivity` records the
  change.
- Lead conversion is unchanged (leads carry no type). Converted clients land on the review list.
- MCP: `clients.create` requires `businessType`; `clients.update` accepts it and `groupCompanyId`.
  This is tool parity.
- **UI:**
  - New client: a required business-type select.
  - Edit: the current type is preselected. With no profile row, nothing is preselected, and the form
    will not submit until a type is chosen. "Other" is a valid explicit choice.
- Review list: a Clients-list filter, "Business type: Other or not set", over the centre list the page
  already loads. If that read fails, the page says so; an empty list must never stand in for a refusal.

**Tests:**
- DB, business type:
  - a create without `businessType` gets 400;
  - a create with it leaves a profile row of that type;
  - a PATCH changes it and writes a history entry.
- DB, group company:
  - a sibling in the same root is accepted;
  - another root's company and the client's own company each get 400;
  - a `company_admin` or `member` setting it gets 403 and the row is unchanged;
  - `platform_admin` and a root owner succeed.
- UI unit: the form refuses to submit without a type, and the review filter works.
- Teeth: drop the root check and the other-root case fails. Drop the requirement and the 400 case
  fails.

### PV3-05: hub areas, the Internal area, and everything about the work under Projects

**Owner:** senior-fe. **Wave 1.**

**Owned paths:**
- **Hub shell:** `UI/app/(app)/clients/[clientId]/layout.tsx` (tab list),
  `UI/components/clients/ClientHubTabs.tsx` and `clientHub.css`.
- **Hub pages:**
  - `work/page.tsx` and `notes/page.tsx`;
  - `contacts/page.tsx` (only to remove the meetings cards).
- **Readers and demo:**
  - `UI/lib/entities.ts` (`listDeliverables` gains `clientId`);
  - new UI readers for runs, change requests and post reviews by client, if none exist;
  - the dead demo links in `UI/lib/demoFixtures.ts`.
- **Tests:** `e2e/client-hub.spec.ts`.

**Change:**
- **Tabs:** Overview · Projects (`/work`) · Business (`/profile`) · People (`/contacts`) · Internal
  (`/notes`). PV3-08 adds Contracts & billing together with its page, so no tab ever links to a
  missing page. Keep the badges.
- **Matching:** `ClientHubTabs` matches on a segment boundary (`pathname === href ||
  startsWith(href + "/")`).
- **Internal** gets a distinct tab style and a banner ("Internal: never shown to the client"). No
  client-visible area may look like it.
- **Projects (`/work`) sections, in order:**
  1. projects and their tasks (as now);
  2. deliverables, read with `?clientId=` (finding 6);
  3. approvals: this client's pipeline runs with their client-side gates (`GET /pipeline/runs?clientId=`);
  4. requests: change requests (`GET /webdev/change-requests?clientId=`) and post reviews, with work
     that has no project under "Not tied to a project". No staff post-review list exists, so post
     reviews come from the hub aggregate's `needsUs` and `needsClient` items; a full list is a new
     ticket;
  5. meetings: the Scheduled and Meetings cards, moved unchanged from People.
- **Refusals:** every read on these pages refuses explicitly (the `ReadRefusal` pattern
  `contacts/page.tsx` already uses). No `.catch(() => [])`.
- **Demo links:** the Overview demo items point to real pages: requests to `/clients/:id/work`, and
  payments and contracts to `/clients/:id/billing` once PV3-08 lands.
- **Coordinate:** tell the WebDesk sessions before merging that `contacts/page.tsx` loses its meetings
  cards (finding 13).

**Must not:** move any path; render visibility markers (PV3-09 does that, from the backend field).

**Tests:**
- Unit: the tab matcher, including `/workshop` not matching `/work`.
- e2e:
  - the "Projects" tab opens `/work`;
  - meetings show on Projects and not on People;
  - the Internal banner shows.
- Teeth: remove the boundary and the `/workshop` case fails.

### PV3-06: billing tools for agents and n8n (agentic-native bar)

**Owner:** senior-integrator. **Wave 2** (needs PV3-01 and PV3-03).

**Owned paths:** the core tool registry (`PN/src/core/core-tools.ts`); the D14 execute registry entries
for the new high and medium tools; activity writes in `contracts.controller.ts`, if any are missing;
`docs/modules/CAPABILITY-INVENTORY.md`, regenerated by the lead.

**Change:**
- Tools over the existing endpoints, with the same authorization:

  | Tool | Impact |
  |---|---|
  | `contracts.list` (with `clientId`), `contracts.get` | read |
  | `contracts.createDraft`, `contracts.updateDraft` | low |
  | `contracts.send` (notifies the client) | medium → D14 |
  | `contracts.countersign` (binds the company) | high → D14 |
  | `invoicePayments.list` (with `clientId`) | read |
  | `invoicePayments.decide` | high → D14 |

- Approving a D14 request must actually execute it. The tools must be registry-listed.
- The maker-checker rule survives: the person who recorded a payment cannot confirm it through any
  path.
- Criterion 3: `createDraft` must be idempotent. Use the mechanism other create tools use, and name it
  in the hand-back.
- Criterion 6: send, countersign and decide each write an activity row with the actor, which may be
  non-human. Add any that are missing.
- Criterion 7: one golden case per tool.

**Tests:**
- Each tool drives its real endpoint.
- A `company_admin` principal's `contracts.countersign` is refused with a typed reason.
- `invoicePayments.decide` by the recorder is refused.
- Teeth: register `contracts.countersign` as low and the impact test fails.

### PV3-07: `clientVisible` on staff payloads, proven against the portal

**Owner:** senior-be. **Wave 2** (needs PV3-02, and PV3-03 because they share controllers).

**Owned paths:**
- **SELECT lists of the staff readers:**
  - `GET projects` (`core.controller.ts`), `GET deliverables`, `GET contracts`, `GET contracts/:id`,
    `GET invoice-payments`, `GET invoices`;
  - `GET pipeline/runs` and run detail with its gates;
  - `GET webdev/change-requests`, `GET meetings/recordings`, `GET pm/tasks` (no staff post-review
    list exists; post reviews carry the marker through the overview items);
  - `GET clients/:id/contacts`;
  - the `needsUs` and `needsClient` items of `GET clients/:id/overview`.
- **Docs:** the matching BFF rows.

**Change:**
- Every row gains `clientVisible: boolean`, defined as: **a client-wide contact of the row's client
  can read it in the portal.**
- It is computed in SQL as `client_id IS NOT NULL AND <portal-visibility builder>`. Kinds in
  `NEVER_CLIENT_VISIBLE` return `false` from that constant.
- Project-scoped contacts see a subset. Document that in the BFF rows, so the marker never claims more
  than it means.
- There is no second list anywhere.

**Tests:**
- The parity test (DB) seeds one client with:
  - a project and a deliverable;
  - draft and sent contracts, draft and issued invoices;
  - a pending and a confirmed payment;
  - client-side and internal gates, and a run with no project;
  - a change request with no project, and a post review;
  - a task and a meeting.

  Add a project-scoped contact too, and assert the NULL-project rules directly: such a contact sees a
  project-less contract and change request, and does not see a project-less run. PV3-02's teeth run
  showed that no existing portal suite catches a change to those arms.

  Then, per kind, it asserts that the staff ids with `clientVisible = true` equal the ids the portal
  endpoints return to a client-wide signer contact.
- Teeth: hand-write one staff predicate instead of using the builder and the parity test fails.

### PV3-08: the Contracts & billing area (`/clients/[id]/billing`)

**Owner:** senior-fe, with a medior for the forms. **Wave 2** (needs PV3-01 and PV3-03; edits the hub
layout after PV3-05 merges).

**Owned paths:**
- **Page:** new `UI/app/(app)/clients/[clientId]/billing/page.tsx` and its components.
- **Wrappers and actions:**
  - new `UI/lib/contracts.ts` (list, get, create, update, send, countersign, payments list, decide);
  - their server actions.
- **Hub:** `layout.tsx` (the new tab and its badge).
- **Demo:** handlers for `/contracts*` and `/invoice-payments*`.
- **Docs:** BFF §16e, flipped to "UI built".

**Change:**
- **Contracts**, grouped Draft · Sent · Signed · Void.
  - Sent contracts show who has signed: party, name, title and date.
  - **Draft form:** title, reference, a project of this client, value and currency, term dates, the
    body in markdown, and an optional PDF through the files route (`contract` is a target kind,
    `files.controller.ts:19`). Draft edit, and Void from any state with a confirm.
  - **Send:** disabled, with the reason, when the draft has neither a body nor a file.
  - **Countersign:** shown only when `canCountersign` (PV3-01). A typed name and title. It says the
    contract becomes Signed once both parties have signed (finding 3).
- **Invoices:** a list only (`listInvoices(u, t, clientId)`), linking to `/invoices/[id]`. D7 is open,
  so nothing deeper. If the invoice module is off or the read is refused, the page says so.
- **Payments to confirm:** this client's pending claims (`invoice-payments?clientId=&status=pending`):
  amount, method, reference, proof file and invoice.
  - Confirm, or Reject with a required reason.
  - The "you recorded this payment" 403 shows its message.
- **Tab badge:** pending payments plus contracts waiting for our countersignature.
- The Overview's payment and contract items link here.

**Tests:**
- Unit: the state-to-button logic (send disabled, countersign hidden, reject needs a reason).
- e2e (demo): draft → send → countersign; confirm a payment.
- Teeth: make countersign ignore `canCountersign` and its test fails.

### PV3-09: every row says who sees it, and the hub's accessibility sweep

**Owner:** senior-fe. **Wave 3** (needs PV3-05, PV3-07 and PV3-08 merged).

**Owned paths:** a new `UI/components/clients/ClientVisibilityMarker.tsx` and its test; marker
placement on the Overview, Projects, Contracts & billing and People pages; a new
`e2e/a11y-axe-client-hub.spec.ts`.

**Change:**
- Each row renders **Client sees this** or **Internal**, from `clientVisible` only. A missing field
  renders neither: it never defaults to either answer.
- Area-level notes:
  - **Business:** "The client sees and edits this profile" (it is the portal's own Business area).
    First check that the centre profile has no staff-only field.
  - **Internal:** its banner (PV3-05).
- The marker has a text label, not colour alone.

**Tests:**
- Unit: true, false and missing each render correctly.
- e2e: a draft contract shows Internal; a sent one shows Client sees this; a task shows Internal.
- Axe: every hub page, light and dark, copying `a11y-axe-portal.spec.ts`.
- Teeth: default a missing field to `true` and the missing-field test fails.

### PV3-10: QA gate, release, live drive

**Owner:** qa, with the lead. **Wave 4.**

**Before release:**
- Merged-tree server gate: both suites and `next build`.
- Hub e2e, portal e2e (the portal must be unchanged) and the hub axe sweep.
- MAP and the capability inventory regenerated from a clean tree.

**Release:**
- The slot is agreed with the WebDesk sessions. Cut it one verified step per command.
- After deploy:
  - the deploy log shows the migration's `applied:` line;
  - restart Cerbos;
  - probe that an owner may countersign and a `company_admin` may not.

**Live, read-only, as a QA staff login:**
- the six hub labels, and the Projects sections with meetings;
- `/clients/[id]/billing` renders, with markers;
- a draft contract shows Internal;
- the Clients review filter works.

**Owner steps** (no owner credential can be driven headlessly; live writes are the owner's):
- mark the live Viceroy client as a group client;
- countersign one real or test contract.

The owner says when both are done.

---

## Open for the owner (non-blocking)

| # | Question | Lead's default, used until ruled |
|---|---|---|
| PV3-Q1 | Who may link a client to one of our companies (`group_company_id`)? It later drives intercompany tagging of that client's invoices (PV-5), so a wrong link misstates group money | `platform_admin` and root owners only (`isPlatformOperator`), like PV-D16 for verticals. Widening it later is one condition |

## Not in PV-3 (and where each goes)

| Item | Why not now | Goes to |
|---|---|---|
| `clientId` facet on time entries | No PV-3 screen reads it | client-centric slice 4 (object-first parity) |
| `<ClientPicker>` on `/projects`, `/tasks`, `/invoices` | Object-first parity, not the hub | client-centric slice 4 |
| Invoice screens deeper than a list, invoice numbers, due dates, tax | D7 is open | PV-5 |
| Intercompany tagging of a group client's invoices | Needs the invoice of record and F9-04 wiring | PV-5 |
| Conversation, and meeting notes shared with the client | D5 is open | PV-4 |
| The holding-only "same organization" link between two companies' client records | Waits for a second company with clients | PV-9 |
| The staff client timeline | A UNION over client-visible objects; markers come first | client-centric slice 5 |
| The website-editor grant control on People | WebDesk M3 owns it (WSK-49f) | WebDesk |
| "My clients" filter for employees | Plan §4.1, the employee tier | later |
