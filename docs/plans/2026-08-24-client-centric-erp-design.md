# Client-centric ERP — design (CC-*)

**Status: PLANNED.** Owner ask (2026-08-24): *"redesign the client flow in the ERP — tasks, projects
and everything shown and filtered to the client, so everything starts with a client and is centralized
with the client end to end."* Presentable client-centric result wanted ASAP.

This document is the design. It does not claim anything is built.

---

## 1. Where we actually are

Measured against the live database (`gda-aicenter`, `alpha-01.068.0144a`, 2026-08-24), not inferred
from the source:

| Fact | Number | Why it matters |
|---|---|---|
| Tasks whose project has a client | 45 of 71 | the majority, but not "everything" |
| Tasks with **no** client | 26 of 71 | 37% of the estate is internal work |
| Projects with **no** `client_id` | 9 of 20 | own-brand social, IT, HR, platform work |
| `pm_tasks.client_id` column | **does not exist** | client is reachable only through `projects` |

So the ask cannot be implemented as "every row has a client". Internal work is a first-class,
permanent third of the estate, and a design that filters it away silently will lose real work.

### The client already IS the spine of the data

`client_id` is already carried by `projects`, `invoices`, `contracts`, `invoice_payments`,
`deliverables`, `pipeline_runs`, `meeting_recordings`, `social_engagements`, `social_accounts`,
`social_post_client_reviews`, `webdev_change_requests` and `client_contacts`. **No new columns are
needed for the client axis.** What is missing is the read surface and the navigation.

### What the staff ERP does with that today

- **`/clients/[clientId]` is a 136-line page with five cards** — Details, Deliverables, Client access,
  Scheduled, Meetings. It shows the client's *contacts and calendar*. It does **not** show their
  projects, tasks, invoices, contracts, approvals, requests, post reviews or spend. The one page in
  the ERP named after a client is the one place you cannot see the client's work.
- Everything else is organised **object-first** (`/projects`, `/tasks`, `/billing`, `/approvals`,
  `/deliverables`, `/pipeline`), and most of those lists have no client facet at all.
- The **client portal** (`(portal)/portal/*`) already does this correctly — one client, everything
  they own, one timeline. The staff side has no equivalent. Staff currently have a *worse*
  client-centric view than the client does.

### Gap table — `clientId` filter on list endpoints

| Object | Endpoint | Client filter |
|---|---|---|
| Deliverables | `GET /:t/deliverables` | ✅ `clientId` |
| Pipeline runs | `GET /:t/pipeline/runs` | ✅ `clientId` (+ `projectId`) |
| Meeting recordings | `GET /:t/meetings/recordings` | ✅ `clientId` (+ `projectId`) |
| Contracts | `GET /:t/contracts` | ✅ `clientId` |
| Change requests | `GET /:t/webdev/change-requests` | ✅ `clientId` |
| Social (engagements, posts) | `GET /:t/social/*` | ✅ `clientId` |
| **Projects** | `GET /:t/projects` (`core.controller.ts:97`) | ❌ none |
| **Tasks** | `GET /:t/pm/tasks` | ❌ none — 10+ facets, no project or client |
| **Invoices** | `GET /:t/invoices` | ❌ none (`list()` takes no query at all) |
| **Invoice payments** | `GET /:t/invoice-payments` | ❌ `status` only |
| **Time entries** | `GET /:t/time-entries` | ❌ `projectId`/`taskId`/`mine` only |
| **Approvals** | — | ❌ no list endpoint exists |

Six endpoints need a facet; one needs to exist. That is the whole backend delta for filtering.

---

## 2. Decisions (owner, 2026-08-24)

1. **Client workspace hub + facets — both, not either.** A rich `/clients/[clientId]` hub is the
   client-first entry point; the existing object-first lists gain a `client` facet so the same data is
   reachable the other way. Nothing is taken away, and no page is *only* reachable through a client.
   *Rejected: a global client-scope switcher pinning every page.* It reads as the strongest form of
   "everything starts with a client", but it makes every existing screen's meaning depend on hidden
   sticky state — the "why is this list empty" class of bug, on every surface at once. The hub gives
   the same centralization with the scope visible in the URL.
2. **"Internal" is a selectable scope, not a hidden bucket.** The client picker offers real clients
   *plus* a first-class `Internal / own brand` entry that resolves to `client_id IS NULL`. Internal
   work is always reachable and always labelled, and never silently mixed into a client's view.
3. **Task→client is derived by join, never denormalized.** `GET /pm/tasks` gains a `client` facet
   implemented as a join through `projects`. No migration, no backfill, no sync trigger, one source of
   truth. At current volume the join is free; if it ever isn't, the fix is an index, not a copy of the
   column.

---

## 3. Architecture

### 3.1 One client-scope helper, and what it is NOT

Add `platform-nest/src/core/client-filter.ts` — parse-and-validate for the `clientId` query parameter,
returning a discriminated scope:

```ts
type ClientFilter =
  | { kind: "all" }                    // parameter absent
  | { kind: "internal" }               // clientId=internal -> client_id IS NULL
  | { kind: "client"; clientId: string };  // clientId=<uuid> -> client_id = $n
```

⚠ **This is a CONVENIENCE FILTER, not an authorization boundary, and the distinction has to stay
loud.** The portal's `core/portal-scope.ts` is a *boundary*: it exists because an external contact must
never reach another client's rows, and every portal query is required to carry its predicate. This new
helper is the opposite — a staff member authorized on `pm_task.read` may already see every task in the
tenant; the filter only narrows what is *displayed*. Consequences, all deliberate:

- A missing or malformed `client` parameter must fall back to **`{kind:"all"}`**, never to "deny". A
  boundary fails closed; a filter fails open, because a filter that fails closed silently hides work.
- Passing another client's id is **not** an escalation and must not 403 — it returns that client's
  rows exactly as the unfiltered list already would.
- The two files must not be refactored into one "scope" abstraction. They have opposite failure
  modes, and merging them is how a filter becomes load-bearing for isolation without anyone deciding
  that it should be. Both files get a header saying so, pointing at the other.

Isolation for staff continues to come from exactly where it comes from today: RLS for the tenant
wall, Cerbos for the action.

### 3.2 The `client` facet contract

**The parameter is `clientId`, not a new `client`.** Six endpoints already accept `?clientId=<uuid>`
(gap table above). An earlier draft of this design introduced `?client=` for the new facet so it could
carry the `internal` sentinel — which would have left the ERP with two nearly-synonymous parameters,
differing only in which endpoints accept which, forever. Instead the existing name is **extended**:

- `?clientId=<uuid>` — that client only *(unchanged on the six that already have it)*
- `?clientId=internal` — clientless rows only (`client_id IS NULL`) *(new, additive)*
- omitted — everything, unchanged from today (**no existing caller changes behaviour**)

`internal` is a reserved word and can never collide with a uuid. Accepting it on the six existing
endpoints is part of the work, not a later tidy-up — a sentinel honoured on some client-filterable
lists and silently treated as "no match" on others is worse than not having it. Compare ids **as text**, not by
casting to uuid, so a hand-edited query string matches nothing instead of 500ing — the convention
`/pipeline/runs` already established.

For `pm/tasks` the facet joins through the project:
`EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND <predicate>)`.

A note for whoever implements it, because the first draft of this design got it wrong: **do not add an
`OR t.project_id IS NULL` branch for the internal case.** `pm_tasks.project_id` is `NOT NULL` (checked
against the live schema — all 26 clientless tasks sit on clientless *projects*, none are project-less),
so the join always resolves and `clientId=internal` is complete as written. That extra branch would be
dead code that reads like a safety net.

### 3.3 The hub aggregate — `GET /:t/clients/:clientId/overview`

The hub cannot be ten client-side fetches; that is the 2N+1 mistake the portal already paid for and
fixed (`/portal/runs`, C3/C5). Add **one** staff-side aggregate mirroring `portal/overview`'s shape:

```
{ client, health: {…}, counts: {projects, openTasks, overdueTasks, deliverables, …},
  money: {outstanding, overdue, byCurrency[]}, needsUs: […], needsClient: […], nextMilestone }
```

`needsUs` vs `needsClient` is the payload's whole point and the thing the boss demo turns on: **who is
holding the ball.** `needsClient` is what the portal already surfaces to the client (unsigned
contracts, pending gates, pending reviews). `needsUs` is the mirror nothing renders today — the
`pending` payment awaiting our confirmation, the `changes_requested` post review, the `new` change
request, the client-blocked run. One number per side, on one page, per client.

### 3.4 Hub IA

`/clients/[clientId]` becomes a tabbed workspace. Tabs are routes (`/clients/[id]/projects`), not
client-side state, so a tab is linkable and shareable — and each tab is one fetch of an endpoint that
already exists or gains a facet in §3.2.

| Tab | Shows | Fed by |
|---|---|---|
| **Overview** | health, who-holds-the-ball, money, next milestone, recent activity | `clients/:id/overview` (new) |
| **Work** | projects, then tasks per project — progress, overdue, ball | `projects?clientId=`, `pm/tasks?clientId=` |
| **Delivery** | pipeline runs, gates, deliverables, meetings | `pipeline/runs?clientId=`, `deliverables?clientId=` |
| **Commercial** | contracts, invoices, payments (incl. **pending → confirm**) | `contracts?clientId=`, `invoices?clientId=`, `invoice-payments?clientId=` |
| **Requests** | change requests, social post reviews | `webdev/change-requests?clientId=`, `social/*` |
| **People** | contacts, portal access, capability, invites | existing `ClientContactsPanel` |
| **Timeline** | one chronological staff-side stream | `clients/:id/timeline` (new, later) |

The **Commercial tab closes the standing gap** recorded in `client-side-separate-interface`: staff have
no UI to send a contract or confirm a client payment, so a client-recorded payment sits `pending`
forever and contracts can only be created via API. Those endpoints exist
(`contracts.controller.ts` draft/send/countersign, `POST /invoice-payments/:id/decide`). This design
gives them their first home rather than adding a separate screen for them.

### 3.5 Client picker

A shared `<ClientPicker>` writing `?clientId=` into the URL — **URL state, no cookie.** The tenant
switcher's cookie pattern (`lib/tenant.ts`) is deliberately not copied: a sticky client scope is the
thing decision 1 rejected. Lists all clients in the active tenant plus `Internal / own brand`.

---

## 4. Delivery — demo first

Sequenced so the presentable thing lands first and nothing later invalidates it.

**Slice 1 — the client hub (the demo).**
- `GET /:t/clients/:clientId/overview` (§3.3), with `needsUs`/`needsClient`.
- `client-filter.ts` (§3.1) + the facet on `projects`, `pm/tasks`, `invoices` (§3.2).
- Hub shell + Overview and Work tabs.
- *Demoable outcome:* pick a client, see their health, who owes what, their projects and tasks.

**Slice 2 — commercial, and the staff gap closed.**
- Facet on `invoice-payments`, `time-entries`; `internal` sentinel accepted on the six pre-existing `clientId` endpoints.
- Commercial tab: contract draft/send/countersign, **payment confirm**.
- *Outcome:* a client payment can be confirmed from the UI for the first time.

**Slice 3 — the rest of the hub.** Delivery, Requests, People tabs (all endpoints already exist).

**Slice 4 — object-first parity.** `<ClientPicker>` on `/projects`, `/tasks`, `/billing`,
`/deliverables`; a client column where there is room.

**Slice 5 — the staff timeline.** `clients/:id/timeline`, built as a **UNION over client-visible
objects, never from `activities`** — the allowlist-by-construction argument from
`portal-workspace.controller.ts`'s timeline applies identically, minus the client-safety filter.

---

## 5. Traps, ranked by how expensive they'd be

1. **Treating the client filter as isolation.** §3.1. The single thing to get right; everything else
   is recoverable.
2. **Inventing a null-`project_id` case for tasks.** §3.2 — it does not exist, the column is
   `NOT NULL`. Listed here because this design asserted the opposite until it was checked against the
   schema, and a dead defensive branch is indistinguishable from a needed one six months later.
3. **A module-owned read without its module scope.** `social_*` carries
   `app_module_allowed('social')`; the Requests tab touches it. Omit the scope and the SELECT returns
   **zero rows with no error** — reads as "this client has no post reviews".
4. **Adding a facet without updating the contract.** `docs/FRONTEND-BFF-CONTRACT.md` §-rows are
   frozen contracts other departments build against; a stale row here has caused real defects.
5. **Cerbos.** No new resource kinds or actions are needed — the hub reads existing kinds
   (`project`, `pm_task`, `invoice`, `contract`, `deliverable`) with existing actions. If that turns
   out to be wrong for the aggregate, the policy needs a **restart** and a probe, not a redeploy:
   health ≠ current policy.
6. **The hub is a fan-in read.** Every tab must stay one round trip. The portal's own 2N+1 (201 round
   trips on one page) is the precedent for how fast this degrades.

---

## 6. Out of scope

- No change to the **client portal**. It is already client-centric; this is the staff mirror of it.
- No `pm_tasks.client_id` column (decision 3).
- No global sticky client scope (decision 1).
- No change to authorization. If a role can see a client's work today, it can after this; if it
  cannot, this does not grant it.

---

## 7. Contracts to update as each slice lands

- `docs/FRONTEND-BFF-CONTRACT.md` — a § row per new endpoint and per new facet.
- `docs/modules/MODULES.md` + `CHANGELOG.md` — `clients` and `pm` module bumps.
- `docs/MAP.md` — regenerate **from a clean worktree**, never from the shared checkout.
