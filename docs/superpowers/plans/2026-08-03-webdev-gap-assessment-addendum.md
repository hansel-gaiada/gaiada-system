# Addendum — owner decisions + the client-access design they imply

**Date:** 2026-08-03 · Amends [`2026-08-03-webdev-gap-assessment.md`](./2026-08-03-webdev-gap-assessment.md)
**Status:** decisions RATIFIED by the owner; design proposed for build.

## Owner decisions (2026-08-03)

| # | Decision |
|---|---|
| **D-1** | **Client portal contacts are one OR several, depending on the project and the client.** ⇒ singular `clients.portal_user_id` is the wrong shape; it becomes a join table with **project-level scoping**. |
| **D-2** | **A PM may delegate internally AND start the external (client) setup.** ⇒ provisioning client access is a **manager-tier** action, not company_admin-only. |
| **D-3** | **Clients get access BEFORE the meeting starts**, so every party is trackable, notified and on the same page from the outset. |

### D-3 is a reframe, not a feature

Today the department's entry point is **a recording**: a meeting happens, a run is created, and client
context is attached along the way. D-3 inverts that — **the engagement is set up first** (client +
project + who is involved on both sides), and meetings then happen *inside* an already-established
context.

That changes what "working end to end" means. The chain is no longer
`record → … → ask the client to sign`; it is
`set up engagement (internal + external participants, all notified) → record → … → the client is
already there and already watching`. Two consequences the original assessment did not carry:

- **Client access provisioning is not a gate-time action.** It belongs to client/project setup, and it
  must be possible with **no recording in existence** — which also makes B2 (create a run without a
  meeting) a first-class need rather than a convenience.
- **"Trackable + notified" is its own gap**, and a silent one — see §3.

---

## 1 · What a client contact actually needs today — five things, none with a write path

Traced through the code. A working client portal user requires **all five**:

| | Requirement | Exists? | Write path? |
|---|---|---|---|
| 1 | a `users` row | yes | admin user CRUD |
| 2 | a `roles` row named **`client`** | ⚠️ **never seeded anywhere** | none |
| 3 | a `user_roles` grant `client` @ company scope | schema yes | role-assign exists |
| 4 | a `company_memberships` row (for `inTenant`) | schema yes | **none for clients** |
| 5 | `clients.portal_user_id` → them | schema yes | **only `testing/fixtures.ts:110`** |

Evidence for (3)+(4): `resource_portal.yaml` allows `read`/`decide`/`sign` to derived role **`client`**
gated on `variables.inTenant`, and `inTenant` is `resource.tenantId in principal.companies`, which
`assemblePrincipal` builds **exclusively** from `company_memberships` (`rbac/principal.ts:52-67`).
So a client with no membership fails authorization before any per-run check runs.

**The security design is already sound and should be preserved:** the `client` derived role
(`derived_roles.yaml:88-94`) is deliberately *not* a parent of any staff role — its own comment says it
"matches no other resource policy". So a client grant cannot satisfy a staff rule. The trust boundary
is the role graph, and it holds. What is missing is purely the plumbing.

---

## 2 · Proposed schema — `client_contacts` (replaces the singular column)

```
client_contacts
  id           uuid PK
  tenant_id    uuid NOT NULL -> companies(id)
  client_id    uuid NOT NULL -> clients(id)
  user_id      uuid NOT NULL -> users(id)
  project_id   uuid NULL     -> projects(id)   -- NULL = the whole client (every project)
  capability   text NOT NULL CHECK (capability IN ('signer','viewer'))
  status       text NOT NULL CHECK (status IN ('invited','active','revoked'))
  invited_by   uuid -> users(id)
  invited_at / activated_at / revoked_at  timestamptz
  UNIQUE (tenant_id, client_id, user_id, project_id)   -- partial-unique for the NULL case
```

Design notes, each load-bearing:

- **`project_id NULL` = client-wide** satisfies D-1's "depends on the project and client" with one
  table: a contact on 2 of 5 projects gets 2 rows, and *signer on project A, viewer on project B* is
  expressible. This mirrors the `user_roles` `scope_type`/`scope_id` convention the codebase already
  uses, rather than inventing a second scoping idiom.
- **`capability`** exists because D-3's "on the same page" implies contacts who **watch** but must not
  **sign**. Without it every invited stakeholder could countersign a scope agreement. The portal's
  decide/sign paths check `capability='signer'`; read only needs a row.
- **`clients.portal_user_id` is retired, not dual-written** — backfilled into `client_contacts` as a
  client-wide signer, then dropped in a later migration. Keeping both invites divergence, and the
  column has no production data to preserve (it is NULL for every real client).
- The portal controller's `callerClientId()` (`portal.controller.ts:47-56`) resolves through this table
  instead, and gains project scoping for free.

---

## 3 · 🔴 NEW GAP — client notifications are silently dropped (D-3's blocker)

`notify()` (`core/http.ts:68-89`) requires an **active `company_memberships` row** and otherwise
`return`s — **no error, no log**:

```ts
const member = await c.query(`SELECT 1 FROM company_memberships WHERE user_id = $1 ...`);
if (!member.rows[0]) return;
```

So until a client contact has a membership, **every notification to them vanishes silently** — which
is precisely the failure D-3 exists to prevent, in its least detectable form. This was not in the
original assessment; it surfaced from D-3.

**Fix:** give client contacts a real membership row (needed for `inTenant` anyway, §1.4) — which makes
`notify()` work with no change to it.

### ⚠️ But that has a leak hazard that must be closed in the same change

`company_memberships.kind` today is `CHECK (kind IN ('employee','service'))`
(`0026_service_layer.sql:173`). Adding client contacts means widening it to include **`'client'`** —
and **every staff-listing query must then filter it**, or clients start appearing in `/people`, the HR
directory, org charts and rollups as if they were employees.

There are ~20 non-test query sites over `company_memberships`. The 0026 service-account work already
established the precedent of filtering on `kind`, so the pattern exists — but each site needs an
explicit audit, and this deserves a **lint or a shape-pinning test** rather than a careful once-over,
because the failure mode (a client in the staff directory) is a data-exposure bug that no test
currently asserts against.

---

## 4 · Policy change from D-2

`scope_signoff.create` is currently `company_admin` / `group_executive`
(`resource_scope_signoff.yaml`). D-2 says a PM starts the external setup and delegates internally, so:

- **new resource kind `client_contact`** — `create`/`revoke` allowed to
  `company_admin`, `manager`, `group_executive` (+ the exec carve-out gated on `notLow` only, **never**
  `inTenant` — the WD-20-R1 lesson).
- **`scope_signoff.create` widens to `manager`** so the PM who owns the engagement can sign the agency
  half. (Previously flagged as open Q4; D-2 answers it.)
- Cerbos does **not** hot-reload on the Windows bind mount — any policy change restarts the container.

---

## 5 · Revised wave

D-3 promotes engagement setup to the front. New **W0**; the rest renumbers.

```
W0  ENGAGEMENT SETUP FIRST (the D-3 reframe — nothing else is orderable before it)
    S0a  migration: client_contacts + widen memberships.kind to include 'client'
         + pipeline_runs.project_id / owner_id          (A1, A2, D-1)
    S0b  seed the missing `client` role; invite/revoke endpoints + Cerbos
         `client_contact` kind (manager-tier per D-2)    (A3, D-2)
    S0c  kind='client' filter audit across all ~20 membership query sites,
         with a lint/shape-pin so it cannot regress       (§3 hazard)

W1  CLIENT IS PRESENT AND WATCHING (depends on W0)
    S1  client-contacts UI on the client + project pages: invite, capability,
        project scope, revoke; portal resolves via client_contacts
    S2  notify client contacts on every pipeline event they are scoped to
        (this is what makes D-3 true rather than nominal)
    S3  agency scope sign-off UI                          (B1)

W2  COMPLETE THE CHAIN
    S4  dispatcher carries project_id through recordingContext; retire
        WEBDEV_REPORT_PROJECT_ID                          (A1 wiring)
    S5  fix E1 (dedupe via source_meeting_id) + E2 (drop the status clause)
    S6  create-run-without-a-meeting                      (B2 — now first-class per D-3)

W3  RUN LIFECYCLE CONTROLS
    S7  run status update / stage add / gate open UI       (B3-B5)
    S8  relink-orphans admin affordance                    (B6)

W4  SCALE + NAVIGATION
    S9  filters/search/pagination on /pipeline + /meetings; client column       (C1,C2,C4)
    S10 portal: kill the N+1; /portal/[runId]                                   (C3,C5)
    S11 run↔project↔recording navigation                                        (C6)

W5  DEPLOY + TENANT CONFIG
    S12 deploy recorder + video allowlist                  (D1)
    S13 enable `pm` on the agency tenant                   (D2)
```

**Why W0 is one migration:** `client_contacts`, the `kind` widening and `pipeline_runs.project_id` are
all additive DDL with no backfill risk, and every later step depends on at least one of them. Splitting
them costs an extra migration slot and a second live-apply window for no benefit. Take **next-unused at
merge time** and re-verify the ledger (head was `0069` in-repo, `0063` applied on the server).

---

## 6 · Remaining open questions (narrowed to two)

1. **How does an invited client contact authenticate?** The server runs `AUTH_MODE=oidc`, so a portal
   contact needs a Keycloak identity. Options: (a) provision a Keycloak user per contact at invite
   time, (b) invite only people who already have an account, (c) a magic-link/token flow that mints a
   short-lived session without a Keycloak account. **This decides whether S0b is a link-picker or a
   full provisioning flow** — it does not block S0a's migration.
2. **Should `client_contacts` rows be created for an engagement with no project yet?** i.e. can a
   contact exist client-wide before any project is created (`project_id NULL` allows it). Assumed
   **yes** per D-3 ("access before the meeting"), stated so it is a decision rather than an accident.

Everything else the original assessment listed is unchanged and unblocked.
