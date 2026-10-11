# Three perspectives: Client, Employee, Company (PV-*)

**Status: PLANNED.** Nothing in this document is built. It is a map of where the ERP stands, a
proposed model, and the decisions the owner needs to make before anything is ticketed.

**Scope (owner, 2026-10-10): Gaiada first.**

- **Ruled:** PV-D1, PV-D2, PV-D3, PV-D4, PV-D10, PV-D11, PV-D12, PV-D13 and PV-D14 to PV-D20. See the
  decision log at the end, and §11 for how D1, D4 and D10 were worked through.
  - Viceroy is a Gaiada client today, and its own hotel and F&B system is deferred.
  - Each of our companies gets a vertical that selects its modules, and each client keeps a business
    type.
  - The portal and the staff client page share five areas.
  - A client's record belongs to exactly one of our companies.
  - The product is an internal tool now, to be sold much later as a subscription product.
- **Open:** D5–D9 and D11.

**Owner ask (2026-10-10):** a clean separation between **Client**, **group-company Employee** and
**the Syrowatka company itself** (Gaiada, Viceroy). The goal is a UI that can be shown from each
perspective, with each one focused on its own performance and productivity.

**Evidence base:** `origin/main` at `9fff3ce3` (`v1.0.0-alpha.343`), read from a clean detached
worktree on 2026-10-10. The shared checkout was 20 commits behind and was not used. File references
are repo-relative. `PN` = `platform-nest/`, `UI` = `platform-ui/src/`.

---

## 0. Summary

1. **"Who is looking" is already separated well.** Clients have:
   - their own shell, `(portal)`;
   - their own principal kind, `users.kind='client'`;
   - their own isolation kernel, `PN/src/core/portal-scope.ts`;
   - no `company_memberships` row.

   This part needs a re-cut, not a rebuild.
2. **"Which company you are in" is not separated.**
   - Every group company gets the same agency-shaped staff nav.
   - `companies.type` is free text that no behaviour reads.
   - Viceroy has no hotel capability at all. Its only "customer" is a placeholder agency-client
     row called *Walk-in Guests* (`PN/src/seed/agency.ts:551`).
3. **"Whose business a record is about" is blurred.** The Client Centre gives every client nine
   "departments": Reservations, Marketing, Accounting, Human Resources, Legal & Corporate, Sales,
   Communication, IT & Security and Operations, with 103 sub-pages between them. Several of those
   names are the same as our own HR, Finance and IT. This is the confusion the owner expected.
4. **Viceroy is two things and nothing links them.**
   - It is a sibling company in the group: `companies` row, type `resort`.
   - It is also a Gaiada client: `clients` row, monitored `viceroybali.com`, an AR customer in the
     finance demo data.
5. **The proposal is one model with three axes:**
   - **Viewer:** client or staff.
   - **Subject:** our company, an engagement, the client's business, or contracts & billing.
   - **Company context:** the vertical pack (agency, hospitality), plus a group tier above it.

   The three perspectives are the three the owner named. The axes keep them apart in data, in
   authorization and on screen.

---

## 1. Where we are

### 1.1 Viewer: client vs staff (mostly right)

| Fact | Evidence |
|---|---|
| Separate route group and shell for clients ("Syrowatka / Client Portal") | `UI/app/(portal)/portal/layout.tsx` |
| Client-only users are redirected out of the staff app | `UI/app/(app)/layout.tsx:27` (`isClientOnly`) |
| Isolation in four layers: RLS, Cerbos `client` on `portal`, a scope predicate on every query, per-route ownership | `PN/src/core/portal-scope.ts` |
| Contacts can be scoped to the whole client or to one project, with capability `signer` or `viewer` | `PN/migrations/0072_*.sql` |
| The portal has **11 flat tabs**: Overview, Business profile, Projects, Timeline, Deliverables, Requests, Approvals, Post reviews, Invoices, Agreements, Profile | `UI/components/portal/PortalTabs.tsx:15-31` |
| The staff client hub: Overview, Work, Profile, Contacts & meetings, Notes & history | `UI/app/(app)/clients/[clientId]/layout.tsx:56-66` |
| A person who is both staff and a client contact gets the staff shell, with no way to see their client view | `UI/components/shell/nav.ts:28-36` |

### 1.2 Company: the tenant wall exists, the company context does not

| Fact | Evidence |
|---|---|
| The holding is a real row. `D & A Syrowatka` (type `holding`) has children `Gaia Digital Agency` (`agency`) and `Viceroy Bali` (`resort`). The seed also defines Bali Catering and four Viceroy venues, which were not created live | `PN/src/seed/agency.ts:27-43,115-124`; `docs/blueprints/github-tenant-scope-ruling.md:47` |
| `companies.type` is free text with no CHECK. Module enablement and permissions never read it | `PN/migrations/0001_core.sql:7-18` |
| RLS is flat tenant equality, with no parent rollup. The only cross-company fence is the root | `PN/src/rbac/principal.ts` (`rootCompanies`) |
| Modules are enabled per company (`enabled_modules[]` plus shared-service assignments). The staff nav **never hides a row** for a disabled module; the page renders "module off" instead | `PN/src/modules/registry.ts:37-72`; `UI/lib/modules.ts` |
| The Business nav hard-lists Agency, Delivery Pipeline, Deliverables and Monitoring for **every** company | `UI/components/shell/nav.ts:42-59` |
| Department consoles are chosen by department **name**, not by company. A Viceroy department named "SEO" would get the agency SEO console | `UI/lib/deptToolkits.ts` |
| Viceroy's org tree is Operations > Front Office > GM. There is no reservation, room, guest, F&B or housekeeping table anywhere | `PN/src/seed/agency.ts:300-316`; grep of `PN/migrations` |
| The resort "owns no capabilities", and the agentic bar cannot be applied until its scope is defined | `docs/superpowers/plans/2026-08-03-agentic-native-erp-plan.md:216-220` |
| Standing rule: integrate commodity verticals such as a hotel PMS through connectors rather than building them | `docs/superpowers/specs/2026-07-04-ws1-gaiada-platform-architecture.md:18` |
| Finance books exist for Gaia only. The holding and Viceroy have none yet | `docs/plans/2026-08-25-finance-phase2-PROGRESS.md:93` |
| Intercompany tagging exists (F9-04). Eliminations are a later change | `PN/migrations/202608251430_finance_intercompany_accounts.sql` |

### 1.3 Subject: our business, their business, and contracts & billing are blurred

| Fact | Evidence |
|---|---|
| A client belongs to exactly one group company (`clients.tenant_id NOT NULL`). The same real client of two companies is two unrelated rows | `PN/migrations/0001_core.sql:125-136` |
| Client Centre "departments" reuse ERP names (Accounting, Human Resources, IT & Security), and the 103 leaf pages are "Coming soon" placeholders | `PN/src/modules/clients/centre/registry.json` |
| **There is no client↔staff conversation.** Notes (`comments`, target `client`) are staff-only by design. Client input is one-way: gate notes, change requests with no replies, payment-claim notes | client-domain sweep, `portal-*.controller.ts` |
| Contracts sign by **typed name plus an "I agree" box** (`signature_ref` unused). That is an attestation, not a certified e-signature | `PN/src/core/portal-commerce.controller.ts:307-351` |
| `invoices` has **no invoice number, due date, tax line or issuer details**. The issuer is implicitly the owning tenant | `PN/migrations/0021_*.sql:4-18` |
| A separate ledger AR (`finance_ar_invoices`) exists. The client sees the `invoices` tracker, not the ledger | finance module; `docs/blueprints/finance-accounting-foundation.md:14-36` |
| No payment gateway. "Card" is only a label on a manual claim. Portal v1 chose bank transfer plus proof upload | `docs/plans/2026-08-04-client-portal-deployment.md:155` |
| **Staff have no UI to draft, send or countersign a contract, or to confirm a client payment.** The endpoints exist, so a client's payment claim stays `pending` until someone calls the API | `PN/src/core/contracts.controller.ts`; BFF §16e |
| Reports have four grains (person, project, department, company). **There is no client grain** and no client-facing report | `docs/blueprints/tracker-reporting-foundation.md:472` |

### 1.4 The owner's requirements against today

| Requirement | Today | Gap |
|---|---|---|
| Client · Projects: requirements, timeline, progress | Projects, milestones, progress and gate labels are visible | Requirement documents (brief, PRD, scope text) are not shown, only gate names |
| Client · Projects: history of past projects | Finished projects are sorted last in one list | No past/archive view. `projects.status` has no CHECK |
| Client · Projects: staff↔client interaction | One-way decisions and requests | No conversation, no "your team", no meeting notes for the client |
| Client · their own business (CMC) | Client Centre profile, editable by a client-wide signer | Names collide with our modules; 103 empty pages; no link to the services we actually run for them |
| Client · contracts & billing | Agreements and invoices visible; typed-name signing; proof upload | No invoice numbers, due dates or tax; no document library; no gateway; no staff UI for contracts and payments |
| Employee · work and drill into clients | Strong personal home; client hub | The hub's tabs do not mirror what the client sees; no visibility markers |
| Company · Gaiada shows agency, Viceroy shows hotel | One nav for all | No vertical, no hotel modules, agency rows shown to Viceroy |
| Each perspective sees its own performance | Person/project/department/company reports; GM console | No client grain; no client KPIs in the portal; no hospitality KPIs |

---

## 2. The model

### 2.1 Three axes

Every screen and every record answers three questions.

| Axis | Values | Decides | Mechanism (existing → new) |
|---|---|---|---|
| **Viewer:** who is looking? | client · staff | Which **shell** | `users.kind`, `isClientOnly`, `(portal)` vs `(app)` → unchanged, plus a view switch for people who are both |
| **Subject:** whose business is this about? | our company · an engagement · the client's business · contracts & billing | Which **area**, who writes, who sees | the division test (§2.3) |
| **Context:** in which company? | Gaiada (agency) · Viceroy (hospitality) · group (holding) | Which **modules, nav, KPIs and vocabulary** | tenant cookie and RLS → plus `companies.vertical` and vertical packs (§2.6) |

How the owner's three perspectives map onto the axes:

| Perspective | Axes |
|---|---|
| **Client POV** | viewer = client |
| **Employee POV** | viewer = staff, personal and department tier |
| **Company POV** | viewer = staff, company tier, shaped by the company's vertical |

The **group** tier (Syrowatka) sits above the company tier and is seen only by owners of the
root.

### 2.2 Reserved words

The glossary is binding for UI copy, route names and docs. "Company" is already reserved by CC-D9.

| Word | Means | Never means |
|---|---|---|
| **Group** | D & A Syrowatka and everything under it | a client's group of companies |
| **Company** | one of *our* group companies (Gaia Digital Agency, Viceroy Bali, …) | a client's business |
| **Vertical** | *our* company's line of business, which selects its pack: `agency`, `hospitality`, `catering`, `holding` | a client's industry (that is the business type) |
| **Business type** | a *client's* industry, from the Client Centre registry: hotel, restaurant, hospital, spa, agency, services, retail, ecommerce, saas, other | our company's vertical |
| **Department** | an org unit of one of our companies | a section of a client's business |
| **Client** | an external organisation that buys services from one of our companies | a hotel guest |
| **Business** | the client's own organisation, as described in its profile | our company |
| **Business area** | a section of the client's business profile (replaces CMC's "department") | our department |
| **Guest** | a hospitality customer of Viceroy | a client |
| **Contracts & billing** | formal instruments between our company (as a legal entity) and the client: contracts, invoices, payments, legal documents. The owner's brief calls this "paperwork"; §11.2 explains the label | chat or status updates |
| **Conversation** | the working channel between the client and the staff serving them | formal correspondence |

### 2.3 The division test: where a record lives

This is the rule that stops the Client Centre from turning into a second ERP for every client.

| If the record is about… | It lives in | Written by | Seen by |
|---|---|---|---|
| how **our company** runs: our people, money, org, assets, guests | a **company module** (HR, Finance, IT, internal PM, the hospitality pack) | company staff | staff, by role. **Never** clients |
| **work we do for a client**: project, requirement, deliverable, approval, status | an **engagement** (Projects) | staff, with client decisions at gates | both |
| **the client's own business**: brand, channels, accounts, setup, KPIs | the **client's Business** (Client Centre) | client signer, plus staff assisting | both |
| a **legal or money instrument** between the client and our legal entity | **Contracts & billing** | our company issues it; the client signs or pays | both, plus Finance |

What the Business area is (and is not):

- **It is never a system of record for the client's internal operations.** We do not hold their
  employees, their ledger or their guests.
- When we sell a managed service that operates on client data (social accounts, website, SEO,
  uptime), the operational data stays in **our service module**, keyed by `client_id`. This is
  already the pattern: `social_accounts.client_id`, `search`, `monitoring`, `webdesk`. The Business
  area **displays** that data; it does not own it.
- So every Business area has exactly three parts:
  1. **Setup:** the CMC fields.
  2. **Connections:** the CMC connection registry.
  3. **Services & results:** what we run for them in that area, and its KPIs.

  An area where we sell nothing shows only Setup and Connections. The 103 placeholder pages go.

### 2.4 Two client channels, kept apart

This is what the owner described as "client and Gaiada employee" versus "client and company".

| | **Conversation** (client ↔ staff) | **Contracts & billing** (client ↔ company) |
|---|---|---|
| About | progress, questions, feedback, approvals, change requests | agreements, invoices, payments, legal documents |
| Parties | the client's contacts on the project, plus the project team | our company as a legal entity, plus the client's authorized signatories |
| Tone | fast, informal, editable | formal, versioned, immutable once issued or signed |
| Sender shown as | a named person | the company (legal name, tax ID) |
| Lives | inside each project | in the Contracts & billing area |
| Today | does not exist | partly exists (contracts, invoices, payment claims) |

**Binding rule:** anything with a legal or money effect that is agreed in Conversation must land in
Contracts & billing before it takes effect. For example, a change request that changes the price creates a
contract amendment for signature; it is never just a chat message. Conversation gets its **own
tables**, never the staff-only `comments` table. Client visibility then comes from the table
itself, not from a flag that someone can forget to check.

### 2.5 Viceroy's two identities

**Ruled: PV-D2.** From Gaiada's perspective, Viceroy is a client. Viceroy is also a Syrowatka group
company, and it will get its own modules and interface later, as Gaiada has.

| Identity | Where it lives | Used for |
|---|---|---|
| **Viceroy the company** | its own tenant, with the hospitality pack | running the hotel: rooms, guests, F&B, its staff, its books |
| **Viceroy, a client of Gaiada** | a `clients` row in Gaiada's tenant, plus a new link `clients.group_company_id → companies(id)` | Gaiada's agency work for the hotel: website, SEO, social, monitoring, invoices |

Consequences:

- **Gaiada staff never need access to Viceroy's tenant to do agency work.** They serve Viceroy
  through Gaiada's client hub, like any other client.
- **Viceroy's marketing people are the client contacts.** They are Viceroy employees, so they need
  the **Workspace ⇄ Client view switch** (§4) to see Gaiada's portal.
- **Gaiada → Viceroy invoices are intercompany.** `group_company_id` lets Finance tag them
  automatically (F9-04 intercompany accounts), so consolidation can eliminate them.
- **Shared services (`service_assignments`) are kept for internal functions only.** For example,
  one HR or IT department serving both companies inside Viceroy's tenant. This replaces the design
  mockups' "Creatives → Viceroy" shared-service idea for agency work (PV-D2).

### 2.6 Vertical packs

**Ruled: PV-D1.** Our companies are different businesses, so each one gets its own set of modules
through a vertical.

**How it is stored.** Add `companies.vertical`, referencing a small `company_verticals` table
(`holding`, `agency`, `hospitality`, `catering`, `general`).

- It is a lookup table, not a CHECK constraint, so adding a vertical later is an INSERT. Rewriting a
  shared CHECK with DROP+ADD has already deleted a live value once.
- A vertical with no code pack yet (today: `hospitality`, `catering`) falls back to the generic nav.
- A parity test pins the table against the pack registry.

It is backfilled from `type`:

| `type` | `vertical` |
|---|---|
| `agency` | `agency` |
| `resort`, `restaurant`, `bar`, `spa` | `hospitality` |
| `catering` | `catering` |
| `holding` | `holding` |

`type` stays as the descriptive sub-type.

A **pack** is a code registry, mirrored in `PN` and `UI` like `deptToolkits.ts`. For each vertical
it declares:

- the default modules;
- the nav sections;
- the department toolkits allowed;
- the dashboard KPIs;
- the vocabulary (Client vs Guest, Project vs Booking);
- the shape of the client portal's work area.

Enabled modules stay per company. The pack supplies the defaults and the layout, and **nav rows for
disabled modules are hidden**. Deep links still land on the existing "module off" page.

| | **Agency pack** (Gaiada) | **Hospitality pack** (Viceroy) | **Generic** (every company) |
|---|---|---|---|
| Nav | Clients, Projects, Delivery (pipeline, deliverables, meetings), Services (Web, SEO, Social, Creative consoles), Monitoring, Leads | Front office, Rooms & housekeeping, F&B outlets, Spa, Events, Guests, Revenue | Company dashboard, Departments, Organization, Finance, HR, IT, internal Projects, Reports, Knowledge, Learning |
| Portal work area | **Projects** | **Bookings & events** (later, for corporate and event accounts) | Overview, Contracts & billing, People |
| KPIs | revenue, AR, project health, client health, utilization (ops only), pipeline | occupancy, ADR, RevPAR, F&B covers and revenue per outlet, spa revenue, guest satisfaction, housekeeping turnaround, maintenance backlog, labour cost %, GOP | headcount, payroll, AR/AP, approvals |

Only the **agency pack** is in scope now (PV-D3). The hospitality column records the shape so that
the pack model is not designed around one vertical. Nothing in it is ticketed.

### 2.7 Internal now, sellable later (PV-D13)

The ERP is an internal tool for the Syrowatka group. Much later it will be sold as a subscription
product (SaaS and PaaS).

**What this changes now.** Nothing product-only enters the Gaiada scope. That excludes self-signup,
subscription billing, customer SSO/SAML, SOC 2 and a marketplace. The one thing it does change is a
design constraint: what we build for ourselves must not hard-wire our own group. That is cheap to
respect now and expensive to unpick later.

| Constraint | Why it maps to a product later | Where it bites in this plan |
|---|---|---|
| **A root company is a customer organization.** The Syrowatka holding is one root, and a future subscriber is another. Never assume a single root | The cross-root fence already exists (`rootCompanies` in `PN/src/rbac/principal.ts`). `platform_admin` is already described as the operator tier (`docs/plans/2026-08-20-monitoring-gated-rulings.md` §1.3) | the Group tier (§5.3) is "the root's owners", never "Syrowatka" |
| **A vertical is a future edition, and a module is a future add-on.** Per-company enablement is where entitlements would later attach | the packs (§2.6) | packs are keyed by **vertical**, never by a company's name or id |
| **No company names or ids in code.** "Gaiada", "Viceroy" and "Syrowatka" are data | department toolkits are chosen by department name today (`UI/lib/deptToolkits.ts`); `org.ts` picks a default tree by `type` | PV-1 keys toolkits by (vertical, department slug) |
| **The client sees their provider's brand.** The portal shell is currently branded "Syrowatka / Client Portal" | a subscriber's clients must never see our holding's name | PV-2: the portal shows the provider company's name and logo (proposed, not ruled) |

---

## 3. Perspective 1: Client

### 3.1 The portal: 11 flat tabs become 5 areas

**Ruled: PV-D4.** The analysis is in §11.2.

The portal and the staff client hub use the same five areas with the same names:
**Overview · Projects · Business · Contracts & billing · People**.

The portal keeps **every existing URL**. Six of them are already sent to clients by notifications:
`/portal/approvals/:runId`, `/portal/contracts/:id`, `/portal/invoices/:id`, `/portal/requests`,
`/portal/social-reviews`, and `/portal/company` (kept by CC-D9). Only the grouping changes: a
primary strip of five areas, plus a sub-strip inside an area that holds more than one page.

This is the same two-level, paths-unchanged pattern the department consoles adopted on 2026-07-23
(`UI/components/shell/DeptTabs.tsx`, longest-prefix match). The portal gets its own copy of the
component, because it shares no chrome with the staff shell. Only the pure matching function is
shared.

| Area | Sub-tabs → existing path | What it answers | Badge |
|---|---|---|---|
| **Overview** | `/portal` | What needs me, how my projects are going, what I owe | — |
| **Projects** | Projects `/portal/projects` (+ `/[projectId]`) · Approvals `/portal/approvals` (+ `/[runId]`) · Deliverables `/portal/deliverables` · Requests `/portal/requests` · Post reviews `/portal/social-reviews` (+ `/[reviewId]`) · Timeline `/portal/timeline` | What you are doing for me, and what you need me to decide | pending gates and post reviews |
| **Business** | `/portal/company/[[...section]]` | How my business is set up, and the results of what you run for me (D6) | — |
| **Contracts & billing** | Contracts `/portal/contracts` (+ `/[contractId]`) · Invoices `/portal/invoices` (+ `/[invoiceId]`) | What we agreed, and what I owe and have paid | unsigned contracts, invoices due |
| **People** | `/portal/profile` | Who on my side has access, and who serves me on yours | — |

Notes:

- **The badge splits by area.** Today one number (`needsYou.length`) sits on Approvals and mixes
  gates with unsigned contracts. It splits by item kind: gates and post reviews go on Projects;
  contracts and due invoices go on Contracts & billing.
- **Work with no project still appears.** Post reviews and client-wide change requests sit under
  Projects as "Not tied to a project". Nothing is hidden for lacking a project.
- **What PV-2 adds on top** (§3.5; tickets in `docs/plans/2026-10-10-pv2-portal-recut-tickets.md`):
  - Active and Past projects;
  - the project lead, and the account manager on People.

  Requirement documents on the project page and a document library under Contracts & billing come
  later (PV-4 and PV-5), because both need new backend reads.
- **"Contracts", not "Agreements".** The sub-tab is renamed so the word matches the staff side, the
  backend entity and the URL.

Header:

- **Brand:** the provider company's name and logo, not "Syrowatka" (`PortalShell.tsx:37`, PV-D13).
- **Company switch:** shown only when the contact is a client of more than one of our companies
  (§3.2).
- **Client switch:** shown only when the contact belongs to more than one client of the same
  company.

### 3.2 A client of two of our companies (PV-D10)

**The owner's rule:**

- Each client record belongs to exactly one of our companies.
- A real client engaging Gaiada and Viceroy has a record in each, and each company handles only its
  own scope.
- The client sees both.
- The holding may see both, with every record properly tagged.

**What is already true:**

- `clients.tenant_id` is NOT NULL.
- Every client-domain table (projects, contracts, invoices, payments, contacts, profiles) carries
  `tenant_id` under FORCE RLS. Gaiada staff cannot read Viceroy's record of the same client, and
  vice versa.
- One person can be a contact of both. The invite adopts an existing login by email, and each
  company gets its own `client_contacts` row.

**What is missing (measured):**

1. **The client cannot see both.** The portal shows whichever company is first in the contact's
   list (`UI/lib/tenant.ts:8-13`), with no switch and no sign that the other exists. Which company
   is "first" is arbitrary.
2. **Portal data carries no company tag.** Every portal payload assumes a single provider.
3. **The holding has no combined view.** Its "sees all descendants" edge is the *finance* ownership
   graph (`PN/migrations/202608241010_finance_ownership_and_scope.sql`). Client records need an
   `owner` grant in each company, and the UI shows one company at a time.

**Design:**

| Rule | How |
|---|---|
| **One request, one company** | The portal BFF fetches each of the contact's companies separately, each under its own RLS and portal scope, and merges in the BFF. There is never a cross-company SQL query for client data. A merge bug can mislabel a row; it cannot leak one company's data to another |
| **Every row carries its company** | Portal and group payloads include `company {id, name}`, and every list that can mix companies shows it as a badge |
| **Money never mixes** | Contracts & billing always shows the issuing company's legal name. A payment is recorded against one invoice of one company |
| **The client sees both** | When a contact belongs to two or more companies, Overview shows one section per company ("Your work with Gaiada", "Your work with Viceroy"). The other four areas are scoped to one company at a time by the company switch, which remembers the last choice. Business and People are inherently per company (each company keeps its own profile and its own account manager), and scoping keeps every number attributable to one company |
| **The holding sees both, tagged** | Through the Group tier (§5.3), with a company label on every row, and money per company plus a labelled sum. Rows from two companies are never shown as one unlabelled merge |
| **"Same organization" is a holding-only link** | So the holding can see that "Client X works with Gaiada and Viceroy", a link between the two records is owned by the root and **invisible to both companies**. Gaiada staff do not learn about the Viceroy engagement through it. It is built with the Group tier, not before |

**Gaiada-first sequencing.** Only Gaiada has portal clients today. Three cheap changes avoid rework
and land in PV-2:

- the company tag on portal payloads;
- the per-company fetch in the BFF;
- replacing the "first company" fallback with an explicit choice.

The per-company Overview sections and the holding link wait until a second company has clients.

### 3.3 The client's business type (PV-D1)

Clients keep a **business type** so the data is usable. It already exists as
`client_centre_profiles.business_type`, and it has been a column in the Clients list since CC-D8.
But a client with no profile row reads as `other`, so today the value is optional and often unset.

PV-3 makes it **required when a client is created or edited**, and gives staff a review list of
clients still on `other`. This is the client's industry, never our vertical (§2.2).

### 3.4 The client's performance view

- **Project health:** milestones on time, approvals turnaround on **both** sides (who holds the
  ball), and open change requests.
- **Business results:** KPIs from the services we run (rankings, traffic, social growth, uptime),
  read from the service modules by `client_id`.
- **Delivered reports:** client-facing reports published to the portal. This needs the client
  grain and a publication step (§5.4). It is currently out of scope in the tracker blueprint.
- **Never shown:** internal person-grain data (staff productivity, time entries, internal gates or
  notes).

### 3.5 New data for this perspective

| Need | Change |
|---|---|
| Project history | `projects.status` CHECK (`planned, active, on_hold, completed, cancelled, archived`) plus `completed_at`; the portal splits Active and Past |
| "Your team" | a client-facing project team. No project-membership table exists today, only `projects.owner_id`. Either add `project_members(role, client_visible)` or derive the team from task assignees. Decide in the ticket |
| Requirements | expose the signed brief, PRD and scope **documents** (pipeline artifacts) through the portal file route; link AD-3 discovery answers from lead to client on conversion |
| Conversation | `conversation_threads(tenant_id, client_id, project_id NULL = client-wide, subject)` and `conversation_messages(author, body, attachments)`. This is a new Cerbos kind, which means **six artifacts**, not one YAML file. It needs portal scope, SSE topic, notifications and an MCP tool |
| Meetings | a shareable MOM flag on meeting records; the portal reads only the shared ones |

---

## 4. Perspective 2: Employee

### 4.1 Where an employee works

The standing decision that `/me` stays a section inside the staff app (employee-portal foundation)
is kept. What changes is that duplicates are folded and the tiers are made visible.

| Section | Contains | Change from today |
|---|---|---|
| **My work** | Home (the ranked queue, kept), My tasks, Calendar, Approvals, Inbox | Project Management currently appears three times (Workspace `/pm`, Business `/project-management`, each console). Keep one personal "My tasks" entry and one company Projects entry |
| **Me** | Profile, Leave, Loans, Pay, Learning, **My performance** (my report, timesheets, appraisals as tabs) | Learning currently appears twice; reports, timesheets and appraisals are reachable from three places |
| **My department** | the console from my placement | Toolkits keyed by **(vertical, department)**, not by name alone |
| **My clients** *(agency pack)* | clients where I am the owner or on a project | new, a filter over the client list |

People who are both staff and a client contact (Viceroy's marketing manager, or a PM added to their
own client) get a **Workspace ⇄ Client view** switch in the user menu. It is navigation only. The
portal's own authorization is unchanged, and it has no staff bypass.

### 4.2 Drilling into a client: the hub mirrors the portal

**Ruled: PV-D4.** The staff hub uses the **same five areas with the same names** as the client
portal, plus one staff-only area. It keeps CC-D8's one-client-one-page rule and supersedes its tab
list.

Existing hub URLs are kept and only the labels change, so no redirect chain is added on top of
CC-D8's `/client-centre → /profile` redirects. New content gets a new path.

| Hub area | Path | Staff see | Change |
|---|---|---|---|
| **Overview** | `/clients/[id]` | waiting on us / waiting on the client, money, next commitment | unchanged |
| **Projects** | `/clients/[id]/work` (path kept) | projects and tasks, deliverables, approvals (runs and gates), requests, meetings; later the conversation (PV-4) | label "Work" → "Projects"; meetings move here from Contacts & meetings |
| **Business** | `/clients/[id]/profile/…` (path kept) | the client's profile in assisted mode (staff edit under `client.update`) | label "Profile" → "Business" |
| **Contracts & billing** | `/clients/[id]/billing` (**new**) | Contracts (draft, send, countersign) · Invoices · Payments to confirm | **new.** Closes the open gap from `client-side-separate-interface` and CC slice 2. The endpoints exist; invoices need the `clientId` facet from the client-centric design |
| **People** | `/clients/[id]/contacts` (path kept) | contacts, portal access and capability, invites, account manager | label "Contacts & meetings" → "People" |
| **Internal** | `/clients/[id]/notes` (path kept) | internal notes and the activity log | label "Notes & history" → "Internal"; styled so it can never be mistaken for a client-visible area |

**Visibility markers.** Every row on a hub area is marked **Client sees this** or **Internal**. It is
a projection, not impersonation; there is no "log in as client".

The marker is computed **by the backend**, from the same predicate functions the portal endpoints
use to decide what a client can read. It is returned as `clientVisible` on hub payloads. It is never
a second list kept by hand in the UI, because that list would drift from what the portal really
shows. That is the frontend-first drift class, at the worst possible place.

### 4.3 The employee's productivity view

Use what already exists: My report (person grain, narrowed to the reporting line), check-ins,
timesheets, appraisals and learning compliance. Put it under one **My performance** entry. The
tracker blueprint's rule stands: appraisal is blended and manager-weighted with human commentary,
and utilization is never an appraisal signal.

---

## 5. Perspective 3: the company, and the group above it

### 5.1 Gaiada (agency pack)

- **Company dashboard:** the GM console that already exists, composed over `reports/overview`, plus
  agency KPIs.
- **Client health board:** every client's needs-us and needs-client counts, overdue work and money,
  from `clients/:id/overview` fanned in.
- **Department throughput** for Web Dev, Creatives, SEO and Social Media, and revenue/AR from the
  ledger.

### 5.2 Viceroy (hospitality pack): DEFERRED

**Ruled: PV-D3.** Viceroy's hotel management system (HMS) and F&B system will be built much later.
Gaiada comes first. Nothing here is ticketed.

What is settled, so that today's work does not paint it into a corner:

- **Viceroy is its own company** with its own modules and interface (PV-D2).
- **Its venues are separate companies.** Apéritif, CasCades, Pinstripe Bar and Akoya Spa are
  separate legal entities, and so is Bali Catering and Events. Each becomes its own company with
  its own books when it is created (PV-D12). The seed already models them as children; live has
  only the holding, Gaia and Viceroy Bali.
- **The owner's stated intent is to build the HMS and F&B system.** That supersedes, for Viceroy,
  the 2026-07-04 rule to integrate commodity verticals such as a hotel PMS
  (`docs/superpowers/specs/2026-07-04-ws1-gaiada-platform-architecture.md:18`). How much is built
  natively and how much is connected is designed when the work is picked up.
- **Guests are not `clients`.** They get their own model, and the *Walk-in Guests* seed row
  (`PN/src/seed/agency.ts:551`) is retired then.
- **Cardholder data stays isolated** (`docs/superpowers/specs/2026-07-04-compliance-data-governance.md:39`).
- **The agentic-native bar still has no capability set for the resort**
  (`docs/superpowers/plans/2026-08-03-agentic-native-erp-plan.md:216-220`). It is defined with the
  HMS design, not before.

Until then, Viceroy appears in the ERP in two ways only:

1. as a **Gaiada client**, through Gaiada's hub and portal;
2. as an **empty company** in the switcher.

PV-1 removes the agency rows from its nav, because that is a by-product of the agency pack. No
other work is planned for it.

### 5.3 Syrowatka group tier

**Ruled: PV-D11** (2026-10-11), with the audience and placement below.

A **Group** area is visible only to owners of the root (finance D-F8: authority comes from owning
the root entity; `group_executive` is gone), and **only while the root company itself is the
active company** in the switcher. It contains:

- per-company cards, each in its **own vertical's** KPIs (Gaiada: revenue, AR, client health;
  Viceroy: occupancy, RevPAR, F&B, GOP);
- group headcount;
- group approvals;
- shared-service assignments;
- money shown both as **Sum of companies** and **Consolidated**. The consolidated figure is rendered
  only once F9 eliminations exist, as the finance blueprint already requires.

Holding-level rows move out of the company nav:

- Rollups and the cross-company Company Report move to **Group**.
- Systems (WA/TG bot, AI gateway, MCP hub, automation, observability) moves to a **Platform** area
  for `platform_admin` **and owners of the root, with full controls** (PV-D18). Today those rows are
  ungated in every company's nav. Hiding a row is not security: the pages and their BFF reads get the
  same gate (PV-1).
- A **group report** is built in PV-1 (PV-D19): per-company cards plus **Sum of companies**. The
  **Consolidated** figure still waits for F9 eliminations.
- "Owner of the root" means holding the IAM `owner` role on the root company (PV-D20).

### 5.4 The client grain in reports

Add a **client** grain as a rollup over the existing project grain (`projects.client_id`, derived by
join, never denormalized, per client-centric decision 3). It feeds:

- the agency's client health board;
- the client's own Overview;
- client-facing report publication, the piece the tracker blueprint deferred to WS11/SM-22.

---

## 6. Performance and productivity by perspective

| Perspective | Sees | Source | Exists? |
|---|---|---|---|
| Client | project health, ball on each side, business results, delivered reports, money due | portal overview, service modules by `client_id`, client grain | partly (overview only) |
| Employee | my queue, throughput, on-time, check-ins, time, appraisal, learning | reports person grain, timesheets, appraisals, LMS | yes, scattered |
| Department | throughput, overdue, ball, capacity (ops only) | reports department grain, dept console | yes |
| Company: Gaiada | revenue, AR, project health, client health, utilization, pipeline | GM console, ledger, client grain | partly |
| Company: Viceroy | occupancy, ADR, RevPAR, F&B, spa, guest satisfaction, GOP | the HMS and F&B system | **no**: deferred (PV-D3) |
| Group | each company in its own KPIs; sum vs consolidated money | group tier, F9 | **no** |

---

## 7. Decisions needed (owner)

Each one has a recommendation. Rulings go in the decision log at the bottom of this file, not in
code comments.

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Add a `companies.vertical` that selects a pack (modules, nav, KPIs, vocabulary, portal shape)? | **RULED: PV-D1.** Yes for our companies; clients keep a required business type (§2.6, §3.3, §11.1) |
| **D2** | Agency work for Viceroy: a Gaiada **client relationship** (with `group_company_id` and intercompany invoices) or a **shared-service** assignment into Viceroy's tenant? | **RULED: PV-D2.** Client relationship. Viceroy also gets its own modules and interface later |
| **D3** | The hotel system: integrate Viceroy's PMS/POS, or build one? | **RULED: PV-D3.** Built much later. Gaiada first |
| **D4** | Same five area names on the client portal and the staff hub? | **RULED: PV-D4.** Overview · Projects · Business · Contracts & billing · People, with every existing URL kept (§3.1, §4.2, §11.2) |
| **D5** | A Conversation channel per project, separate from Contracts & billing, with the "money or legal effect must land in Contracts & billing" rule? | **Yes.** It is new tables and a new Cerbos kind |
| **D6** | Client Business boundary: Business areas = Setup · Connections · Services & results; never a system of record for the client's internal operations; rename "departments" to **Business areas**; remove the 103 placeholder pages? | **Yes** |
| **D7** | Which invoice the client sees: make the ledger AR invoice the record (number, due date, tax, issuer legal details) and retire the `invoices` tracker, or extend the tracker? | **Ledger AR as the record**, so there is one invoice and no reconciliation drift. Sequence it with Finance |
| **D8** | Signature tiers: keep the typed-name attestation for routine approvals and use a certified e-signature provider for agreements above a threshold? | **Yes, with counsel setting the threshold.** Indonesian law treats certified and uncertified e-signatures differently. The provider needs a vendor-exit row |
| **D9** | Payment gateway: hosted checkout (no card data in the ERP), auto-confirming `invoice_payments`, after invoice numbering lands? Bank transfer plus proof stays | **Yes, provider TBD**, fees per transaction only (no per-seat), with a written exit |
| **D10** | A client of more than one group company? | **RULED: PV-D10.** One record per company, each handling its own scope; the client sees both; the holding sees both, tagged (§3.2, §11.3) |
| **D11** | A Group area for root owners and a Platform area for `platform_admin`, with holding-level rows moved out of the company nav? | **RULED: PV-D11.** Yes, both. Group shows only while the root company is active; Platform is for `platform_admin` and root owners, with full controls (§5.3, PV-D18 to PV-D20) |
| **D12** | Viceroy's venues (Apéritif, CasCades, Pinstripe Bar, Akoya Spa) and Bali Catering: separate legal entities (then companies with their own books), or outlets inside Viceroy? | **RULED: PV-D12.** Separate: each is its own company |
| **D13** | The assessment's open question: an internal operating system or a product to sell? | **RULED: PV-D13.** Internal now, sold much later as a subscription (SaaS and PaaS). See §2.7 |
| **D21** | PV-D18 gives Platform (our bots, AI gateway, MCP hub, automation, observability) to the owner of ANY root. Today only the Syrowatka root exists. Under PV-D13 a subscriber's root is another root, and its owner would reach our whole deployment's system consoles. Restrict the owner arm to the operator's own root before the first customer root exists? (Raised by PV1-05, 2026-10-11) | **Yes, before any customer root exists:** name the operator root (one setting, never a hard-coded id) and accept owners of that root only. Nothing is exposed today, with one root |

---

## 8. Delivery

Each phase is sequenced so that something visible lands early and nothing later invalidates it.
Every capability meets the agentic-native bar, gets a BFF contract row and passes the Linux gate on
sumopod. MAP is regenerated from a clean worktree.

**Blocks any real client seeing the new portal** (true today regardless of this plan):

- retire placeholder principals P-03 and P-04 (`portal@*.test` logins; a staff signer on all 19
  clients, which also lists staff in every client's contact list);
- a mailer (mail module `0.0.19`);
- Legal Gate 1.

**Order: Gaiada first (PV-D3).**

- The client-facing track (PV-2 → PV-7) is the main line.
- PV-1 is small and runs **alongside PV-2**. It must land before any new agency row is added to
  the nav, because it is what stops the agency work from hard-wiring itself (PV-D13).
- PV-8 is deferred.
- PV-9 waits for a second company with books.

| Order | Phase | Scope | Depends on |
|---|---|---|---|
| 0 | **PV-0: Decide** | the open rulings, D5–D9 and D11; the glossary (§2.2) adopted in the root `CLAUDE.md` | owner |
| 1 | **PV-2: Client portal re-cut** (tickets: `2026-10-10-pv2-portal-recut-tickets.md`) | fix the "completed project shows as active" bug; 5 areas with sub-tabs, **every existing URL kept** (§3.1); badges split by area; "Agreements" → "Contracts"; Active/Past projects (`projects.status` CHECK); a "your team" read; the provider company's brand in the header (§2.7); the D10 groundwork: a company tag on portal payloads, a per-company fetch in the BFF, and an explicit company choice replacing the "first company" fallback (§3.2); the Workspace ⇄ Client view switch, so Viceroy's own staff can reach Gaiada's portal | PV-D4, PV-D10 (ruled) |
| 1 | **PV-1: Company context** *(alongside)* | `companies.vertical` plus backfill; the pack registry (PN and UI) with the **agency pack only**; `/me` returns the vertical; nav built from the pack; disabled-module rows hidden; toolkits keyed by (vertical, department); Group and Platform areas; scope markers. Side effect: Viceroy stops seeing agency rows | PV-D1 (ruled), D11 |
| 2 | **PV-3: Hub symmetry and staff Contracts & billing** | hub labels renamed with paths kept (§4.2); the new **Contracts & billing** area at `/clients/[id]/billing` (contract draft, send and countersign; payment confirm queue); backend-computed `clientVisible` markers; the client-filter facets from the client-centric design, slice 2; **`clients.group_company_id`**, so Viceroy shows as a group client (PV-D2); business type required on client create and edit, plus a review list (§3.3) | PV-D4 (ruled) |
| 3 | **PV-4: Conversation** | threads and messages tables; the new Cerbos kind (six artifacts); portal and hub UI; SSE topic; notifications; MCP tool; the billing-landing rule enforced on price-changing change requests | D5, PV-2, PV-3 |
| 4 | **PV-5: Contracts & billing depth** | invoice of record (number, issue and due dates, tax, issuer legal details from company settings); **intercompany tagging** of invoices to group clients (F9-04); a client document library; signature tiers; gateway | D7, D8, D9; Finance |
| 5 | **PV-6: Client Business re-cut** | Business areas with Setup · Connections · Services & results; service KPIs by `client_id`; placeholder leaves removed; reconcile with AD-3 (CC-D6) | D6 |
| 6 | **PV-7: Performance surfaces** | the client grain; the agency client health board; the client Overview KPIs; client report publication; My performance for employees | PV-6, the reports program |
| — | **PV-8: Viceroy HMS and F&B** | **DEFERRED** (PV-D3, §5.2) | owner reopens it |
| — | **PV-9: Group tier** | the group dashboard with per-vertical cards; sum vs consolidated money | PV-1; a second company with books; F9 eliminations |

---

## 9. Traps, ranked

1. **Treating a filter or a view switch as authorization.**
   - The Workspace ⇄ Client switch, the provider switcher and the visibility markers are all
     navigation.
   - Isolation stays RLS, Cerbos and `portal-scope.ts`. **Every new portal query takes its
     predicate from that file.**
   - This is the same warning the client-centric design gives about `client-filter.ts`.
2. **Reusing `comments` for Conversation.** That table is staff-only by design, and flipping a flag
   on it is how internal notes would leak to a client. Use separate tables.
3. **Letting a pack become an authorization layer.** A pack decides what is *shown*. Modules are
   still enabled per company, and Cerbos still decides access. A hidden nav row is not a denied
   route.
4. **A new Cerbos kind is six artifacts.** Policy YAML is about 15% of the work, and four pinned
   count tests will fail. Cerbos must be restarted and probed after the policy lands.
5. **Hospitality facts through a second aggregation path.** The GM ruling is to compose over
   `reports/overview`. Hotel KPIs enter the reports program as a metric family.
6. **Showing a consolidated figure that cannot be computed.** Until F9 eliminations exist, the group
   tier shows Sum of companies only, labelled as such.
7. **Contract countersign authority.** The role arm grants countersign to `platform_admin` only
   (`company_admin` is deliberately excluded; `group_executive` is gone). Before PV-3 ships, verify
   that the company `owner` reaches it through the permission arm. Otherwise the new Contracts & billing tab
   has a button nobody can press.
8. **Module wall reads.** Service KPIs in the Business area read module tables (`social_*`,
   `search_*`). A read without `{modules: [...]}` returns zero rows with no error, which looks like
   "no results".
9. **A visibility marker kept by hand.** If "Client sees this" is decided in the UI, it drifts from
   what the portal actually returns. Staff then trust a marker that is wrong in the direction that
   leaks. It comes from the backend's portal predicates or it does not ship (§4.2).
10. **One query across two companies for client data.** It is the tempting shortcut for "the client
    sees both" and for the holding view. It moves isolation from RLS into a WHERE clause someone
    wrote by hand. The rule is one request per company, merged after (§3.2).
11. **Breaking a link already sent to a client.** Six portal paths appear in notifications. The
    re-cut moves none of them. Any future move needs a redirect and a test that every path in
    `client-notify.ts` and the other senders still resolves.

---

## 10. Contracts to update as phases land

- `docs/FRONTEND-BFF-CONTRACT.md`: §16 (portal), §25/§26 (Client Centre, clients), plus a new §
  for Conversation.
- `docs/PERMISSION-CONTRACT.md` and the permission catalog: the Conversation kind, and any
  Contracts & billing actions.
- `docs/plans/2026-09-29-client-centre.md`: record that PV-D4 supersedes CC-D8's tab list
  (relabelled, paths kept, plus Contracts & billing), and that D6, if ruled, supersedes the
  "department" naming.
- `docs/plans/2026-08-24-client-centric-erp-design.md`: PV-3 absorbs its slices 2 and 3.
- `docs/modules/MODULES.md` and `CHANGELOG.md`: written by the lead session, never by a subagent.
- `docs/MAP.md`: regenerated from a clean worktree.

---

## 11. How D1, D4 and D10 were decided

On D4 the owner asked to "proceed if it is better, but plan it properly so we don't take a bad
decision". Each decision below lists the options weighed, the facts that settled it, and what was
rejected.

### 11.1 D1: verticals for our companies, business types for clients

**Owner's answer, read both ways:**

- Our companies "will come up with their own modules, as it is a different set of business".
- Clients that contract with Gaiada should be typed "so we can have proper data".

Both are yes. They are different fields with different words (§2.2).

| Option for our companies | Verdict |
|---|---|
| Hand-pick modules per company (today's `enabled_modules[]` only) | **Rejected.** PV-D12 makes Apéritif, CasCades, Pinstripe Bar and Akoya Spa separate companies in one line of business, and Bali Catering another. Hand-picking repeats the same set four or five times and lets the copies drift. PV-D13 also needs an edition concept for the product later |
| A vertical that selects a pack; modules still toggle per company | **Chosen.** One definition per line of business; per-company toggles remain for exceptions |
| A CHECK-constrained `vertical` column | **Rejected** in favour of a lookup table. Adding a value to a shared CHECK by DROP+ADD has silently deleted another value on live before |

For clients, the field already exists (`client_centre_profiles.business_type`). The gap is that it
is optional and defaults to `other`. Making it required is a PV-3 detail, not a new design.

### 11.2 D4: the same five areas on both sides

**Criteria:**

1. Both parties can point at the same place ("it's under Contracts & billing").
2. No link already sent to a client breaks.
3. Staff can never mistake internal material for client-visible material.
4. It still works with two of our companies (D10) and with the product later (D13).
5. It costs little against CC-D8, which was ruled on 2026-09-29 and shipped in alpha.343.

| Option | 1 | 2 | 3 | 4 | 5 | Verdict |
|---|---|---|---|---|---|---|
| **A. Keep as is:** portal with 11 flat tabs; hub with Overview · Work · Profile · Contacts & meetings · Notes & history | ✗ | ✓ | ✗ (no markers) | ✗ | ✓ | **Rejected.** The portal tab bar has grown with every module (Post reviews came with SMM; SEO reports and uptime would add more). The hub still has no home for contracts or payment confirmation |
| **B. Same areas and names, two levels, URLs kept** | ✓ | ✓ | ✓ (backend markers, separate Internal area) | ✓ | ✓ | **Chosen** |
| **C. Same areas, different words per side** (portal "Home"/"Team", hub "Overview"/"People") | partly | ✓ | ✓ | ✓ | ✓ | **Rejected.** It needs a translation table forever, for no gain. "Overview" is already the label on both sides today |
| **D. One page rendered for both**, with staff overlays | ✓✓ | ✓ | ✗ | ✓ | ✗ | **Rejected.** It merges the two trust surfaces the 2026-08-04 owner decision separated. One component bug would show internal data to a client |

**Facts that settled it:**

- **Nothing moves.** All six portal paths used in notifications keep working, because only the
  grouping changes. The department consoles proved this pattern on 2026-07-23.
- **It costs the least it ever will.** No real client uses the portal yet. All 19 portal logins are
  placeholders (`docs/PLACEHOLDER-PRINCIPALS.md` P-03), so nobody has to relearn anything. The cost
  of this change only rises once real clients arrive.
- **CC-D8's principle survives.** One client still has one page; CC-D8's tabs are relabelled and
  one area is added. The staff hub needed that area anyway, to close the oldest open gap: no UI to
  send a contract or confirm a payment.

**Each label against its alternatives:**

| Chosen | Over | Why |
|---|---|---|
| Overview | Home | It is already the label on both sides |
| Projects | Work | It is the owner's word and what clients ask about. Work with no project is shown, not hidden |
| Business | Profile, Business profile | D6 adds services and results, so "profile" undersells it. CC-D9 reserves "Company" for our group |
| Contracts & billing | Paperwork, Documents, Agreements & billing | Clients scan for "contract" and "invoice". In English UI copy, "paperwork" reads as a chore and hides what is inside. "Contracts" matches the staff side, the entity and the URL `/portal/contracts`. The owner's term survives in the glossary |
| People | Team & access, Contacts & meetings | "Team" is ambiguous (theirs or ours?); People holds both. Meetings belong with projects |

**Residual risks, and what handles each:**

- **Sub-tabs hide Approvals one click deeper.** The per-area badges and Overview's "Needs you" list
  surface every pending decision.
- **The hub's Projects area lives at `/work`.** The label/path mismatch is invisible in use, and it
  avoids a second redirect chain.

### 11.3 D10: one client record per company

**The owner's rule:**

- One record per company, each company handling its own scope.
- The client sees both.
- The holding sees both, properly tagged.

| Option | Verdict |
|---|---|
| **One record per company, merged only for display** (BFF fan-out per company; company tag on every row; a holding-only "same organization" link) | **Chosen.** It matches the owner's rule exactly, and keeps RLS as the only thing separating Gaiada's data from Viceroy's |
| One shared group-level client record used by both companies | **Rejected.** It breaks the 1:1 rule. Contracts, invoices and books are per legal entity, so a shared record would be split again everywhere money is involved |
| Per-company records with no link and no client-side merge | **Rejected.** The client would not see both (the owner's rule), and today one engagement is silently hidden behind an arbitrary "first company" |

**Answer to "it will be properly tagged, right?"** Yes:

- Every client-domain row already carries its company (`tenant_id`), enforced by FORCE RLS.
- The plan adds the company tag to every portal and group payload, and a badge to every list that
  could mix companies.
- It forbids any unlabelled merge (§3.2).

---

## Decision log

| Id | Date | Ruling | Supersedes |
|---|---|---|---|
| PV-D1 | 2026-10-10 (owner) | **Our companies are different businesses and get their own modules.** This is expressed as `companies.vertical`, referencing a `company_verticals` lookup table, which selects a code pack (§2.6). Only the agency pack is built now. **Clients keep a business type for proper data:** `client_centre_profiles.business_type` becomes required on create and edit (§3.3). Two words, two meanings: vertical is ours, business type is the client's | — |
| PV-D2 | 2026-10-10 (owner) | **From Gaiada's company perspective, Viceroy is a client.** Its agency work is a `clients` row in Gaiada's tenant, served through Gaiada's client hub and portal, and linked to the Viceroy company by `clients.group_company_id`, so its invoices count as intercompany. Viceroy is also a Syrowatka group company, and will get **its own modules and interface later**, as Gaiada has. Shared-service assignments stay for internal functions only | The design mockups' shared-service framing of agency work for Viceroy ("Creatives → Viceroy") |
| PV-D3 | 2026-10-10 (owner) | **Viceroy's HMS and F&B system will be built much later. The focus now is Gaiada.** PV-8 is deferred, and no Viceroy-specific work is ticketed. The owner's words were "we will build", so the stated intent is to build; how much is native and how much is connected is designed when the work is picked up | §5.2's earlier "integrate the PMS first" recommendation; for Viceroy, the 2026-07-04 rule to integrate commodity verticals such as a hotel PMS (`docs/superpowers/specs/2026-07-04-ws1-gaiada-platform-architecture.md:18`) |
| PV-D4 | 2026-10-10 (owner delegated: "if it's better, proceed, but plan it properly") | **The client portal and the staff client hub use the same five areas: Overview · Projects · Business · Contracts & billing · People.** The hub adds one staff-only area, Internal. Two-level navigation; **every existing URL is kept**; only labels and grouping change, except the new hub path `/clients/[id]/billing`. The portal sub-tab "Agreements" becomes "Contracts". Visibility markers are computed by the backend. Analysis: §11.2 | CC-D8's hub tab list (Overview · Work · Profile · Contacts & meetings · Notes & history), relabelled with paths kept. CC-D8's one-client-one-page principle stands. Also the portal's 11-tab bar (`PortalTabs.tsx`) |
| PV-D10 | 2026-10-10 (owner) | **Each client record belongs to exactly one of our companies.** A client engaging two companies has one record in each, and each company handles only its own scope. **The client sees both:** Overview has a section per company, and the other areas are scoped by a company switch. **The holding sees both, tagged:** a company label on every row in the Group tier, and a "same organization" link owned by the root and invisible to the companies. One request per company, merged after; never a cross-company query for client data. Analysis: §3.2, §11.3 | The portal's "first company in the list" fallback (`UI/lib/tenant.ts:8-13`) for contacts |
| PV-D11 | 2026-10-11 (owner) | **A Group area and a Platform area, with holding-level rows moved out of the company nav.** **Group** (rollups, the cross-company Company Report, later per-company cards and group money) is shown to owners of the root, and only while the root company is the active company. **Platform** (WA/TG bot, AI gateway, MCP hub, automation, observability) is shown to `platform_admin` and owners of the root, in every company. Pages and BFF reads behind both get the same gate as the nav (§5.3) | The ungated Systems rows and the company-nav Rollups and Company Report rows |
| PV-D12 | 2026-10-10 (owner) | **Viceroy's venues (Apéritif, CasCades, Pinstripe Bar, Akoya Spa) and Bali Catering and Events are separate legal entities.** Each is its own company, with its own tenant and books, when it is created. None is an outlet inside Viceroy | — |
| PV-D13 | 2026-10-10 (owner) | **The ERP is an internal tool now. It will be sold much later as a subscription product (SaaS and PaaS).** Product-only work (self-signup, subscription billing, customer SSO/SAML, SOC 2, marketplace) is out of scope until the owner opens it. What we build must not hard-wire our own group (§2.7) | Answers the open question in the 2026-09-17 system assessment ("internal operating system or product to sell?"), which is program-wide, not limited to this plan |
| PV-D14 | 2026-10-11 (owner) | **The verticals are `holding`, `agency`, `hospitality`, `catering` and `general`.** Hotel, restaurant, bar and spa stay as the company `type` inside `hospitality`. Adding a vertical later is a row in `company_verticals` (§2.6) | — |
| PV-D15 | 2026-10-11 (owner) | **A company outside the agency vertical gets the generic menu.** Viceroy and future non-agency companies see Company dashboard, Departments, Organization, Finance, HR, IT, internal Projects, Reports, Knowledge and Learning; no Clients, Agency, Delivery Pipeline or service consoles. Deep links still land on the module-off page (§2.6, §5.2) | Viceroy's current agency rows |
| PV-D16 | 2026-10-11 (owner) | **Only `platform_admin` may set or change a company's vertical.** It works like a product edition: set at creation, rarely changed (§2.7) | — |
| PV-D17 | 2026-10-11 (owner) | **A pack's default modules are switched on only when a company is created.** Existing companies keep exactly the modules they have; for them the pack shapes the menu and hides rows for modules that are off. Changing a vertical never resets modules | — |
| PV-D18 | 2026-10-11 (owner) | **Owners of the root get FULL platform and system controls in the Platform area** (bots, AI gateway, MCP hub, automation, observability), the same as `platform_admin`. The server gate for those surfaces becomes "`platform_admin` at global scope, or the `owner` role on a root company". **Consequence, recorded:** owner and `platform_admin` stop being disjoint for system surfaces, which D-9's "one platform_admin + one owner" appointment pair leaned on. Owner grants already need that two-person appointment (`owner` is in `ELEVATED_TIER`, `grant-write.service.ts`), so system power still has no single-step path | **D-8 / IAM-14's "owner: NO platform/system controls"**, for the system surfaces only (`PN/src/admin/elevated.ts`); owner's business scope is unchanged |
| PV-D19 | 2026-10-11 (owner) | **A cross-company group report is built in PV-1.** Owners of the root may read group rollups, each owned company's Company Report, and a new group report: per-company cards plus Sum of companies. Consolidated figures wait for F9 eliminations | Rollups and the Company Report being `platform_admin`-only |
| PV-D20 | 2026-10-11 (owner) | **"Owner of the root" means holding the IAM `owner` role on the root company** (a `user_roles` grant scoped to the company whose id equals its own `root_company_id`). Not the Finance ownership register | — |
