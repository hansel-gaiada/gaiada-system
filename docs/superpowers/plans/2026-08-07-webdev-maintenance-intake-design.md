# Web Dev — Maintenance Intake (D-7): design + /army ticket decomposition

**Status: PLANNED** (design only — nothing here is built; no module version is bumped by this doc)
**Date:** 2026-08-07 · **Author:** architect seat · **Program:** webdev Phase 5 (blueprint §12), decision D-7 ⚡ client-facing
**Blueprint:** [`../../blueprints/webdev-design.md`](../../blueprints/webdev-design.md) §04 (DDL sketch, lines 287–302), §07 (gate spine), §11, §12 Phase 5, §14 D-7
**Verified against code 2026-08-07.** Migration ledger head on disk today = `0087_pm_task_assignment_events.sql`
(untracked, a concurrent session's PM work). `0058`/`0059` remain permanently-orphaned reservations.
**Every migration number below means "next-unused at merge time" (migrations/README.md rule 5) — never
inherit a number from this doc.**

---

## §0 · What changed since D-7 was written (all verified in code, not docs)

D-7 ("typed `webdev_change_requests` + one PM triage gate, routed by kind; mini-runs are normal
`pipeline_runs` rows") was written when the portal was a role-gated dashboard inside `(app)`. The
client-facing half now has real, shipped machinery — this design is mostly *composition*, not invention:

| Assumption in the blueprint | Reality today | Evidence |
|---|---|---|
| Portal = pages under `(app)/portal` | Portal is its **own route group** `(portal)/portal/{overview, projects, timeline, deliverables, invoices, contracts, profile, approvals}` with its own layout; staff-group guard is `if (isClientOnly(me)) redirect("/portal")` — `isClientOnly`, NOT `!isElevated` | `platform-ui/src/app/(app)/layout.tsx:27`, `platform-ui/src/lib/rbac.ts:221` |
| Client identity = `clients.portal_user_id` | **`client_contacts`** (many per client, `capability IN ('signer','viewer')`, `project_id NULL` = client-wide, `status IN ('invited','active','revoked')`); legacy column still UNIONed in during retirement | migration `0072:50–83`; union at `platform-nest/src/core/portal-scope.ts:51–66` |
| `requested_by_portal_user uuid` (bare, no FK) in the sketch | Portal principals are ordinary `users` rows; `resolvePortalScope()` returns `{clientIds, projectIds\|null, canSign}` and `requireSigner()` already exists | `portal-scope.ts:26–33, 100–104` |
| Notifications to clients impossible (`notify()` silently dropped non-members) | **RESOLVED (W0-2):** `notify()` admits recipients via `company_memberships` OR `client_contacts` (`status='active'`); `client-notify.ts` has the full recipient-resolution kit (`resolveClientRecipients`, signature→signers-only, `notifyBestEffort`) | `platform-nest/src/core/http.ts:86–107`; `client-notify.ts:43–60` |
| Runs don't know their project/owner | `pipeline_runs.project_id` + `owner_id` exist; `createRun` accepts `clientId/projectId/ownerId` and inherits from the source meeting (WD-30) | `0072:132–138`; `pipeline.controller.ts:151–225` |
| Race-safety folklore | DEF-2 is fixed with a **named idiom**: per-run `pg_advisory_xact_lock` + server-side precondition re-check, plus a 0052 partial-unique backstop | `pipeline-lock.ts` (whole file), `pipeline.controller.ts:93–124`, `0052:139–141` |
| Client-writable tables have no precedent | CP-1 shipped **two** client-writable tables with a codified threat model (claim-status default, claimer≠confirmer, tenant-scoped composite FKs, CORE plain-wall RLS) | `0075_client_portal.sql` header + §0 + lines 242–244 |

`webdev_change_requests` itself: **zero hits across all 87 migration files** — it does not exist anywhere.

---

## §1 · Schema — `webdev_change_requests` DDL (the authoritative refinement of the §04 sketch)

### 1.1 The module-wall decision (trap #2) — **plain tenant wall, NOT the third wall. This amends D-2's table list.**

> **✅ OWNER-RATIFIED 2026-08-07.** This amendment was raised to the owner as an explicit
> ratify-or-reject decision (an architect had amended a locked decision) and was **ratified**. It is
> now recorded as **D-2a** in [`webdev-design.md` §14](../../blueprints/webdev-design.md), so a future
> session reading the decision log cannot pick up the superseded rule and rebuild the wall.
> The exception class is deliberately narrow: **a `webdev_*` table whose primary writer is the client
> portal** takes the plain tenant wall. Estimates, rate cards and QA runs stay third-walled per D-2.

Blueprint D-2 (§14) listed "change requests" among the dept-private surfaces that take the
`app_module_allowed('webdev')` third wall. **That assignment is amended here, with cause, and the
conflict is flagged rather than silently overridden:**

1. **The primary writer is the client portal** (`source` defaults to `'portal'` in the blueprint's own
   sketch). Two shipped, later-than-the-blueprint precedents rule that portal-reachable tables are
   never module-walled: `0072:214–215` ("a client's portal access must not depend on which modules the
   tenant has enabled") and `0075:242–244` ("gating a client's own contract behind a module flag would
   fail the portal closed for reasons no one would find"). A client asking "why did my request vanish"
   because someone toggled `enabled_modules` is exactly that failure.
2. **The third wall is a two-sided handshake** (`app_module_allowed(mod)` reads the request-declared
   `app.scopes` GUC set by `withTenants(..., { modules: [...] })` — `0028:39–52`,
   `platform-nest/src/db/index.ts:39,55–56`). The portal controllers are core and declare no module
   scope; every portal read of a third-walled table would return **zero rows, silently** — trap #2's
   exact failure mode, on the feature's primary surface.
3. What the third wall would have bought — keeping non-webdev staff requests out of these rows — is
   provided by Cerbos (`webdev_change_request` resource, §4) + the controller surface, and these rows
   are client-visible by design, i.e. the least-secret data in the webdev domain. Contrast
   estimates/rate-cards/QA-runs/contract-snapshots, which stay third-walled per D-2 **unchanged**.

**Consequently there is NO `module` column and no `app_module_allowed()` clause on this table**, and
nothing for trap #2 to break. The per-row-module pattern (`0076:148–157`) is also not applicable —
that exists for one table shared by many modules; this table has exactly one owner.

Corollary: the staff endpoints live in **core** (beside `pipeline.controller.ts`, which is where every
shipped webdev surface lives — verified: `platform-nest/src/modules/` contains NO webdev module), so
no `ModuleEnabledGuard` ever sits in front of triage while clients can still submit. Whether the
*portal UI affordance* hides when the tenant hasn't enabled `webdev` is a display concern (OQ-3).

### 1.2 DDL (migration takes **next-unused at merge time**; head was `0087` on 2026-08-07)

```sql
-- NNNN_webdev_change_requests.sql — maintenance intake (webdev D-7).
-- NUMBERING: `ls migrations | sort | tail` at write time; 0058/0059 are dead reservations, do not fill.
-- RLS: CORE plain tenant wall (D-7a amendment, §1.1 of the design doc) — deliberately NOT
-- app_module_allowed('webdev'): the client portal writes this table (0072/0075 doctrine).
-- No DML in this migration — nothing to backfill, so the 0050 NOBYPASSRLS backfill trap does not apply.

-- Tenant-scoped composite-FK targets (0075 §0 pattern; clients/projects/files already have theirs).
-- Additive and cannot fail: id is each table's PK, so (id, tenant_id) is trivially unique.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pipeline_runs', 'pm_tasks'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = format('ux_%s_id_tenant', t)) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT ux_%s_id_tenant UNIQUE (id, tenant_id)', t, t);
    END IF;
  END LOOP;
END $$;

CREATE TABLE webdev_change_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  -- Which client asked. SERVER-DERIVED on the portal path (from the caller's resolved scope, never the
  -- body — 0075's "rule 1": a client cannot name their own client_id). Nullable only for
  -- source='internal' (staff logging internal maintenance), enforced by the CHECK below.
  client_id uuid,
  -- Optional narrowing to one project. Portal rule (§5 of the design): a project-scoped contact MUST
  -- name one of their projects; only a client-wide contact may leave it NULL.
  project_id uuid,
  source text NOT NULL DEFAULT 'portal' CHECK (source IN ('portal','internal')),
  kind text NOT NULL CHECK (kind IN ('content','design','feature','bug')),
  title text NOT NULL,
  body text,
  -- Lifecycle (see §2.2 state machine): new → (declined | triaged → in_progress → done).
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','triaged','in_progress','done','declined')),
  -- Set at triage. 'control_plane' is schema-admitted now but refused by the v1 convert endpoint
  -- (webdesk P4 does not exist yet) — see §2.3.
  route text CHECK (route IN ('control_plane','mini_run','pm_task')),
  -- STRUCTURAL state machine, not controller discipline: a route exists exactly on the post-triage,
  -- non-declined statuses. (v1 declines only from 'new', so declined rows carry no route.)
  CONSTRAINT wcr_route_matches_status CHECK ((route IS NULL) = (status IN ('new','declined'))),
  -- A portal submission always has a requester and a client; collapsing that into controller
  -- discipline is how a "who asked this?" NULL appears in the triage queue a month later.
  CONSTRAINT wcr_portal_has_requester CHECK (
    source <> 'portal' OR (client_id IS NOT NULL AND requested_by IS NOT NULL)
  ),
  -- The spawned artifacts (exactly one, per route). Tenant-scoped composite FKs: an FK check runs as
  -- the table owner OUTSIDE RLS, so the two-column form is what actually guarantees same-tenant (0075 §0).
  pipeline_run_id uuid,
  pm_task_id uuid,
  triaged_by uuid REFERENCES users(id),
  triaged_at timestamptz,
  declined_reason text,
  -- The requester as a plain users FK (replaces the sketch's bare `requested_by_portal_user`):
  -- portal contacts ARE users rows (0072), and notify()/display need the user either way.
  requested_by uuid REFERENCES users(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_wcr_client_tenant   FOREIGN KEY (client_id, tenant_id)       REFERENCES clients (id, tenant_id),
  CONSTRAINT fk_wcr_project_tenant  FOREIGN KEY (project_id, tenant_id)      REFERENCES projects (id, tenant_id),
  CONSTRAINT fk_wcr_run_tenant      FOREIGN KEY (pipeline_run_id, tenant_id) REFERENCES pipeline_runs (id, tenant_id),
  CONSTRAINT fk_wcr_task_tenant     FOREIGN KEY (pm_task_id, tenant_id)      REFERENCES pm_tasks (id, tenant_id)
);

-- Portal list ("my client's requests") — the hot path.
CREATE INDEX ix_wcr_client  ON webdev_change_requests (tenant_id, client_id)  WHERE deleted_at IS NULL;
-- The triage queue (mirrors ix_invoice_payments_pending, 0075:235).
CREATE INDEX ix_wcr_new     ON webdev_change_requests (tenant_id, status)     WHERE status = 'new' AND deleted_at IS NULL;
CREATE INDEX ix_wcr_project ON webdev_change_requests (tenant_id, project_id) WHERE project_id IS NOT NULL AND deleted_at IS NULL;
-- "Requests I raised" (portal detail auth + my-requests filter).
CREATE INDEX ix_wcr_requester ON webdev_change_requests (tenant_id, requested_by) WHERE deleted_at IS NULL;

-- Trap #6 (NULL defeats UNIQUE / ON CONFLICT): both backstops below are PARTIAL uniques over the
-- non-null set, the 0072:73–79 / 0075:148–153 house pattern. A plain UNIQUE on a nullable column
-- constrains nothing.
-- One change request per spawned run — the schema half of the spawner's idempotency story (§3);
-- the transition half is the advisory lock + precondition re-check.
CREATE UNIQUE INDEX ux_wcr_run  ON webdev_change_requests (pipeline_run_id) WHERE pipeline_run_id IS NOT NULL;
CREATE UNIQUE INDEX ux_wcr_task ON webdev_change_requests (pm_task_id)      WHERE pm_task_id IS NOT NULL;

-- FORCE RLS, plain tenant wall — byte-identical to 0075's block (NULLIF hardening per 0025).
-- NO app_module_allowed() clause (§1.1). NO principal_lookup policy either: unlike client_contacts
-- (0072 §7b), nothing reads this table during principal assembly — every read runs under withTenants.
ALTER TABLE webdev_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE webdev_change_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webdev_change_requests;
CREATE POLICY tenant_isolation ON webdev_change_requests FOR ALL
  USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]));
```

Notes the implementer must not "simplify" away:
- **Composite FKs are the tenancy guarantee, not the plain FK** — FK checks bypass RLS (0075 §0;
  `pipeline.controller.ts:139–140` makes the same point for owner validation).
- The two CHECK constraints encode the state machine and the portal threat model **structurally**
  (0075's "baked into the DDL rather than left to controller discipline").
- `ON CONFLICT` is never used against the partial uniques here (trap #6's second half); the convert
  path re-checks preconditions under a lock instead (§3).
- D17 custom fields: register `webdev_change_request` in `customFieldTargets` per blueprint §04 — a
  follow-up ticket concern (MI-06), not DDL.

---

## §2 · The triage gate — its exact place in the gate spine

### 2.1 Where it sits

The shipped spine (blueprint §07, all verified in code): **hard build gate** (PRD signed AND scope
dual-signed) → **3-beat Submission** at design and code (`pm_review → customer_feedback →
pm_approval`, bounded revise ≤3) → **D-3 artifact signature lock** → **D-9 QA gate** (deploy.staging
needs green-or-override). Gate rows are `pipeline_gates` with
`kind IN ('prd_review','prd_sign','pm_review','customer_feedback','pm_approval','scope_signoff')`
(`0017:53–54`) and they all hang off a run.

**Triage sits in front of the spine, not inside it.** A change request has no run yet, so the triage
gate is *not* a `pipeline_gates` row — it is the CR's own `new → triaged/declined` transition,
decided by a PM in the dept console (Cerbos action `triage`, §4). For a CR-born run, **triage plays
the role `prd_review` plays for a meeting-born run** (the internal "is this requirement sane?" beat):
the requester authored the text, the PM disposes of it, and the *client-side* confirmation is the
run's normal `prd_sign` gate. From the moment the mini-run exists, **the spine applies unmodified** —
D-3 locks its artifacts once signed, WD-05's bounded revise loop counts its designs, D-9 gates its
staging deploy. Zero special-casing is the whole point of D-7.

### 2.2 CR lifecycle (all transitions server-side, event-emitting)

```
            submit (portal client | staff)
                      │
                      ▼
                    new ──── triage: decline (+reason) ───► declined   [terminal; requester notified]
                      │
                      ▼ triage: convert (route chosen)
   route=mini_run ────┼──── route=pm_task
        │             │             │
        ▼             │             ▼
   in_progress ◄──────┘        in_progress
   (run spawned,               (pm_task created,
    pipeline_run_id set)        pm_task_id set)
        │                           │
        ▼ staff "mark done"         ▼ staff "mark done"
       done                        done
```

- `triaged` (route recorded, nothing spawned) exists in the CHECK for the deferred `control_plane`
  route only; the v1 convert endpoint always lands `in_progress` in the same transaction as the spawn.
- v1 completion is a **manual staff action**; auto-completing from `pipeline.run.updated
  status=complete` events is OQ-5 (default: defer — the event consumer plumbing exists but the mapping
  "run complete ⇒ request done" has judgment in it, e.g. a run parked `blocked`).
- The CR detail (both surfaces) joins the linked run/task at read time, so status is live regardless.

### 2.3 Routing by kind (D-7's table, made operational for v1)

| kind | Default route offered at triage | v1 behavior |
|---|---|---|
| `content` | `pm_task` (v1) | `control_plane` is refused with an explicit 501-style error naming webdesk P4 — **schema admits it now so no migration is needed when webdesk lands**; the operator does the edit by hand off the PM task until then |
| `design` | `mini_run` | mini-run seeded per §3.2 |
| `feature` | `mini_run` | mini-run seeded per §3.2 |
| `bug` | `pm_task`, PM may pick `mini_run` | PM task under the CR's project via the PM module's task-creation service (in-process call; PM tables are plain-tenant-wall so the core transaction reaches them) |

The default is a *suggestion rendered in the triage drawer* — the PM's choice is the record
(blueprint §07: "the PM's triage decision is the record"; the AI `kind` suggestion via gateway
`/complete` stays deferred, OQ-6).

---

## §3 · The mini-run spawner (route=`mini_run`)

### 3.1 What gets created — ordinary rows only, and why the pipeline picks them up with zero special-casing

One `withTenants([tenantId], …)` transaction (BEGIN/COMMIT is what makes the advisory lock real —
`pipeline-lock.ts:47–52`):

1. `pipeline_runs` row — `title` = CR title, `client_id`/`project_id` copied from the CR,
   `owner_id` = the triaging PM (validated by the existing staff-membership rule, the
   `assertOwnerIsStaff` idiom at `pipeline.controller.ts:141–149`), `status='delivery_active'`,
   `source_meeting_id = NULL` (this is the honest value — mini-runs have no meeting; the 0017 dedupe
   index is partial on non-null, so NULLs are fine — and it is also why meeting-id dedupe can do
   nothing for us here, see §3.3).
2. Two pre-filled extraction stages, exactly the shape `createRun` writes (`pipeline.controller.ts:215–219`):
   - `delivery/prd_extract` `status='done'`, `artifact_ref` = a requirement doc rendered from the CR
     (title + body + kind + requester + link back to the CR),
   - `scope/scope_extract` `status='done'`, `artifact_ref` = a scope note rendered from the CR
     (work description; the estimate embed arrives with the D-6 estimates program, not here).
   No `report` track — there is no meeting to minute (blueprint §07: report is the internal-only track).
3. Open the delivery-track client `prd_sign` gate (ordinary `pipeline_gates` row, `actor_side='client'`,
   the `openGate` path's row shape) — this substitutes the dispatcher step that opens it for
   meeting-born runs; triage already served as the internal review beat (§2.1).
4. UPDATE the CR: `status='in_progress'`, `route='mini_run'`, `pipeline_run_id`, `triaged_by/_at`.
5. `emitEvent('pipeline_run', runId, 'pipeline.run.created', …)` in the same transaction — **this is
   the load-bearing line for zero-special-casing**: the shipped `pipeline-fanout` n8n workflow
   triggers on exactly this event (`automation/workflows/pipeline-fanout.json:11`) and opens the
   client `scope_signoff` gate + PM notify itself (`automation/README.md:101`). Also emit a
   `webdev.change_request.updated` event for the CR row (SSE + activity).
6. After commit: `notifyBestEffort` to the requester + client recipients (§5.3) and
   `writeActivity('converted', 'webdev_change_request', …)`.

From here the run is indistinguishable from a meeting-born run mid-spine: client signs PRD in the
portal (`POST :tenantId/portal/gates/:id/decide`, `portal.controller.ts:169`), both parties sign
scope, `pipeline.gate.decided`/`scope.signed` resume the delivery workflow's `Load + decide`, the
**hard build gate holds by construction** (it requires PRD-signed AND scope-dual-signed — the
mini-run satisfies it the same way every run does: by real client signatures, never by pre-seeded
gate rows, which would forge what a client signed). Design → 3-beat → code → staging → D-9 QA gate →
production, all unchanged. The portal shows the run because `/portal/runs` filters on `client_id`
(`0018:1–8`), which step 1 set.

### 3.2 Idempotency argument (trap #5 — the DEF-2 lesson applied, precisely)

The double-trigger surface: the PM double-clicks Convert; two staff triage the same CR concurrently;
an HTTP retry replays the convert. A lock alone does nothing (the DEF-2 finding,
`pipeline-lock.ts:17–25`): both racers would take it *in turn* and both would insert, each acting on
a stale snapshot. The fix is the full idiom — **lock, then re-evaluate the precondition server-side,
then act, all inside one transaction**:

```
withTenants([tenantId], async (c) => {
  // 1. Serialize on the CR id — new namespace, NOT PIPELINE_RUN_LOCK_NS (0x50520001): the resource
  //    being serialized is the change request (no run id exists yet to lock on).
  //    e.g. WEBDEV_CR_LOCK_NS = 0x57430001 ('WC'+1), same two-int idiom as pipeline-lock.ts:71.
  await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [WEBDEV_CR_LOCK_NS, crId]);
  // 2. Re-read UNDER the lock and re-check the precondition — this line, not the lock, is the fix:
  //    SELECT status, route, pipeline_run_id, pm_task_id FROM webdev_change_requests WHERE id=$1 ...
  //    require status='new' (and therefore route IS NULL, pipeline_run_id IS NULL — the CHECK ties them).
  //    Loser of a race sees status<>'new' here and returns 409 { existing: {route, pipelineRunId|pmTaskId} }
  //    instead of inserting — mirroring existingStageForRepeatedCreate's "resolve to the existing row"
  //    (pipeline.controller.ts:89–124), because a second convert is a stale retrigger, never an intent.
  // 3. Spawn (run+stages+gate, or pm_task) and UPDATE the CR in this same transaction.
});
```

Why each layer is there, and what breaks without it:
- **Without the lock:** two racers both read `status='new'` before either commits, both spawn — two
  runs, one CR, and the second UPDATE clobbers `pipeline_run_id`. (MVCC alone does not save you:
  neither transaction sees the other's uncommitted UPDATE.)
- **Without the re-check:** the racers serialize and *still* both spawn — DEF-2's exact shipped bug,
  the variant that "passes every ordinary test" (`pipeline-lock.ts:24–25`).
- **Schema backstop** (the 0052 philosophy — make the duplicate physically impossible even for a
  future hand-written path): `ux_wcr_run` / `ux_wcr_task` partial uniques (§1.2) mean a second run
  can never be *linked*; and if a crash lands between spawn and CR-update — impossible here since
  they share a transaction, but cheap to state — the transaction rolls back atomically, leaving no
  orphan run, because `emitEvent` is transactional-outbox (`pipeline.controller.ts:222` pattern).
- **Lock scope is the CR id, not the tenant** (the pipeline-lock.ts:32–37 lesson: a tenant-wide lock
  would serialize every triage in the one-agency deployment) **and not narrower** — the CR is the
  unit two deciders can disagree about.
- The transaction also does NOT take `PIPELINE_RUN_LOCK_NS` on the new run id: the id is freshly
  minted inside this transaction, so no concurrent handler can address it yet — the same reasoning
  `createRun` documents for its stage loop (`pipeline.controller.ts:208–210`). No second lock ⇒ no
  lock-ordering deadlock question.

The **submit** path needs no lock: inserts are independent rows (a double-submit makes two `new`
CRs, visibly identical in the queue — the UI disables the button in flight; a server idempotency key
is deliberately out of v1, OQ-7).

---

## §4 · Authorization — Cerbos resource kind, actions, and the client invariant

### 4.1 Client side rides the `portal` resource (one new narrow action) — preserving the 0072 invariant

`0072:32–36` proved the design safe on an invariant that is easy to destroy silently: **the `client`
derived role satisfies exactly one policy file, `resource_portal.yaml`** ("A principal holding just
the client grant can therefore satisfy exactly one policy, so making `inTenant` true for them opens
nothing else"). This design keeps that invariant intact:

- `POST /api/:tenantId/portal/change-requests` authorizes `portal : request_change` — a **new
  narrow-named action** added to the client rule in `resource_portal.yaml` (the policy's own comment
  explains the naming rule: `update_profile` was deliberately not `update` "…a generic `update`
  would silently widen the day someone reuses it", `resource_portal.yaml:20–21`).
- Portal GETs (list own requests, request detail) are covered by the existing `read` action ("every
  portal GET", `resource_portal.yaml:13–14`).
- Row-level reach is, as everywhere in the portal, **NOT the policy's job**
  (`resource_portal.yaml:23–27`): the portal-scope predicate (`clientIds` + the
  `($n::uuid[] IS NULL OR project_id = ANY($n))` idiom, `portal-scope.ts:24–25`) is applied on every
  CR query, RLS beneath it, per-route ownership on top.

### 4.2 New resource kind: `webdev_change_request` (staff-only — the `client` role appears NOWHERE in it)

`platform-nest/cerbos/policies/resource_webdev_change_request.yaml`, actions **`create`** (internal-
source submissions by staff), **`read`** (list/detail incl. the triage queue), **`triage`** (one
action for the whole disposition — decline *and* convert — mirroring `pipeline_gate`'s single
`decide` for approve/reject/sign):

| Rule | Actions | Condition | Precedent |
|---|---|---|---|
| `platform_admin` | `*` | — | every policy |
| `group_executive` | `create, read, triage` | **`variables.notLow` ONLY — no `inTenant`** | **trap #4**: a global grant does not populate `principal.companies`, so an `inTenant`-gated rule never fires for it; the shipped pattern is `resource_integration_connection.yaml:29–33` |
| `company_admin`, `manager` | `create, read, triage` | `inTenant && notLow` | `pipeline_gate` decide/read tiers (`resource_pipeline_gate.yaml:19–30`) |
| `module_manager` | `read, triage` | `inTenant && notLow` (derived role string-composes `webdev_manager` from `resource.attr.module`) | `derived_roles.yaml:126–135` |
| `module_staff` | `read` | `inTenant && notLow` | `derived_roles.yaml:115–124` |

- Handlers therefore pass `resource.attr = { kind: "webdev_change_request", tenantId, module: "webdev", id? }`.
  **`attr.module` is a Cerbos attribute and has nothing to do with the `app.scopes` GUC** — passing it
  does not (and must not) cause anyone to add a module wall back onto the table (§1.1).
  It buys the ORG-6 shared-service future for free: a serving webdev dept's reconciler-materialized
  `webdev_manager` grant lights up triage in the served tenant.
- Plain `member` is deliberately excluded from `read`: the triage queue exposes client asks
  tenant-wide, the same rationale that made `pipeline_gate:read` elevated (`resource_pipeline_gate.yaml:18`).
- **QA must probe the invariant positively**: a client-role-only principal gets DENY on every
  `webdev_change_request` action, and the 0072 header's safety argument stays true verbatim.

### 4.3 Operational trap #3 (Cerbos does not hot-reload here)

Every ticket that adds/edits a policy file carries this AC line: *"restart the `gaiada-test-cerbos`
container (it owns :3592 — not `gaiada-cerbos-1`) after the policy sync and BEFORE verifying; an
unlisted kind/action reads as a silent DENY that looks exactly like a logic bug; diagnose with
`includeMeta`, not `docker exec`."* On the server, Cerbos policies are deployable and the deploy
pipeline's Cerbos-restart step exists (client-portal deploy verified it) — dev is where the trap bites.

---

## §5 · Portal surface + signer-vs-viewer ruling + notifications

### 5.1 The ruling: **submitting a change request is a `viewer`-permitted act. Signing its consequences is not.**

**Any `status='active'` contact — viewer or signer — may submit, view, and comment-by-body on change
requests within their project scope.** Signature capability gates only what it has always gated: the
sign gates on the resulting mini-run.

Grounds (all shipped precedent, not taste):
1. The capability column exists to stop *countersigning*, not communication: `0072:59–61` ("contacts
   who WATCH but must not SIGN. Without this, every invited stakeholder could countersign a scope
   agreement").
2. The portal already ruled an analogous write for viewers: recording a payment — a act with real
   commercial consequence — is explicitly NOT signer-gated ("*paying is not signing*, and a `viewer`
   contact who handles accounts payable is an entirely ordinary person to exist",
   `portal-commerce.controller.ts:145–146`). Reporting a bug or asking for a change is strictly
   weaker than claiming money was paid.
3. Commercial commitment is structurally downstream and already capability-gated: the mini-run's
   `prd_sign`/`scope_signoff` gates route their notifications to signers only
   (`client-notify.ts:18,37–38`) and the portal sign routes call `requireSigner(scope)`
   (`portal-scope.ts:100–104`). A viewer-submitted feature request cannot become committed work
   without a signer signing — by construction.

Scope rules on submit (server-side, from `resolvePortalScope`, never from the body):
- `client_id` := derived from the caller's scope; if the caller is a contact of multiple clients the
  form picks one, validated against `scope.clientIds` (the 0075 "rule 1" discipline).
- `project_id` ∈ `scope.projectIds` when that is non-null; **a project-scoped contact must name one
  of their projects** — only a client-wide contact (`scope.projectIds === null`) may submit a
  client-wide (`project_id IS NULL`) request. This mirrors the widening rule at `portal-scope.ts:85–90`.
- `requested_by` := `req.principal.userId`; `source` := `'portal'`; `status`/`route` never from the body.
- `title`/`body` pass `scrubText` with length caps, exactly like payment `reference`/`note`
  (`portal-commerce.controller.ts:202–204`).

### 5.2 Pages (sited in the portal route group, staff console in the dept template)

- **Portal:** new `platform-ui/src/app/(portal)/portal/requests/page.tsx` (list + "New request" form;
  status chips new/in progress/done/declined; detail view links a spawned mini-run to the EXISTING
  `/portal/approvals/[runId]` page — the deep-link idiom `client-notify.ts:107–113` standardized).
  Nav item added in the portal layout (`(portal)/portal/layout.tsx`). No sign affordance exists on
  this page, so `canSign` does not gate anything here.
- **Staff:** "Requests" tab in the webdev dept console (Build group, per the §08 console table —
  the blueprint already reserved intake surfaces for P5) with the triage queue (= `status='new'`
  filter), triage drawer (kind override, route choice with §2.3 defaults, decline+reason), and
  detail with linked run/task. Registered per the dept-interface-template toolkit rule (a tab
  registers only when its route exists).
- **SSE:** the portal live stream is an *invalidation* stream (topics, no data). Add the CR event
  types to the topic map in `platform-nest/src/core/portal-live.service.ts` (the map at line ~51
  already carries `"pipeline.run.created": "projects"`) under a new `requests` topic; the portal
  page subscribes and refetches.

### 5.3 Notifications (trap #1 — resolved upstream; this design just uses the kit correctly)

| Event | Recipients | Mechanism |
|---|---|---|
| CR submitted (portal) | The client's project owners — `SELECT DISTINCT owner_id FROM projects WHERE client_id=$1…`, **falls back to nobody, never to everybody** | the exact `notifyInternal` precedent, `portal-commerce.controller.ts:548–566`; queue visibility is the backstop |
| CR declined / converted | The requester + every active contact in scope | `resolveClientRecipients(kind='general')` — viewers included, per §5.1; `notifyBestEffort` AFTER commit (a notify failure must never roll back the write, `client-notify.ts:63–68`) |
| Mini-run's `prd_sign`/`scope_signoff` open | signers only — **already shipped**, nothing to build | `client-notify.ts:18,25–27` + the fanout workflow |

> ### ✅ F1 — AMENDMENT, ruled + implemented 2026-08-08: **a disposition follows AUTHORSHIP, not the client_id**
> MI-03's verification found that declining or converting a **`source='internal'`** change request
> notified the named client's contacts with *"Your change request was declined"* **and the staff
> `reason` verbatim** — internal commentary delivered to the customer, for work nobody client-side
> asked for. Cause: `resolveClientRecipients` keys on `client_id` alone and never sees `source`, while
> `createInternal` had already reasoned its way to the opposite conclusion for the *submit* event. The
> table above is silent on internal rows because row 2 was written about the portal flow.
>
> **Ruling (owner-adopted):** the `kind:'general'` disposition audience is gated on `source='portal'`
> — implemented as `dispositionClientRecipients()` in `webdev-change-requests.controller.ts`.
>
> **Deliberately NOT gated: the `kind:'signature'` audience on the `mini_run` path.** An internally
> raised mini-run still opens a real `prd_sign` gate the client must actually sign; suppressing that
> would strand the run exactly the way the portal's own "waiting on client" failure did. The rule is
> **silence about our internal notes, never silence about a signature we are waiting on.**
>
> Pinned by two tests that must stay paired — `F1:` (internal ⇒ staff requester notified, zero client
> contacts) and `F1 counter-case:` (portal ⇒ contacts still notified, reason included). The
> counter-case is what stops the fix drifting into "clients are never notified", and the positive
> control inside the first is what stops its zero being satisfiable by a merely broken notify path.
> Mutation-probed: removing the `source` gate turns the F1 test RED (`expected 0, received 1`) while
> the counter-case stays green.

Two facts every implementer on this feature must hold: `notify()` admits client contacts **only when
`status='active'`** (`http.ts:98–107`) — an `invited`/`revoked` recipient silently drops, which is
correct (`client-notify.ts:33–35` documents why); and the notification INSERT is tenant-scoped, so it
must run with the CR's tenant in the authorized set (all call sites here do — they're inside or right
after the same `withTenants`).

---

## §6 · Traps audit for this feature (what turned out handled vs. live)

| # | Trap (as briefed) | Disposition for this design |
|---|---|---|
| 1 | `notify()` silently drops non-members | **Already handled upstream** (W0-2): `http.ts:98–107` unions `client_contacts`; plus a full routing kit (`client-notify.ts`) and a staff-side recipients precedent (`portal-commerce.controller.ts:548–566`). Design consumes it; QA asserts real `notifications` rows, not the absence of errors |
| 2 | `app_module_allowed` two-sided handshake | **Designed out structurally**: no module wall on this table at all (§1.1, amending D-2's list with cause). There is no scope to declare and no handshake to break on the portal path |
| 3 | Cerbos no hot-reload on Windows | **Live and unavoidable** — carried as an explicit AC line on every policy-touching ticket (§4.3) |
| 4 | Global exec grant × `inTenant` | **Live** — the staff policy includes the dedicated `group_executive` + `notLow`-only rule per `resource_integration_connection.yaml:29–33` (§4.2) |
| 5 | Lock without precondition re-check | **Live and central** — the spawner's whole §3.2 is this idiom; new lock namespace, re-check under lock, one transaction, schema backstop uniques. QA's positive control drives a real concurrent double-convert |
| 6 | NULL defeats UNIQUE / ON CONFLICT | **Live** — both spawn-link backstops are partial uniques over the non-null set; no ON CONFLICT is used anywhere in the feature (§1.2) |

One trap found **worse than briefed** while verifying: nothing in the briefed list — but note a
*documentation* drift found en route: `docs/modules/MODULES.md` carries `webdev 0.11.0` in its index
row (line 49) and `0.8.1` in the section heading (line 274). MI-06 reconciles it (report-only here;
this doc bumps nothing).

---

## §7 · /army-ready tickets

Tiers per the agent-army standard; **model = seat default unless flagged** (senior-* Sonnet·high,
medior Sonnet·medium, junior Haiku, qa Sonnet·medium). ⚡ = client-facing/contract/gate path → QA
gate + architect design-review on the diff. **Opus flags: exactly 1** (MI-03) — everything else is
bounded pattern-following on shipped precedents that this doc cites by file:line.

Shared-checkout rules bind every seat: commit only files you authored, by explicit path; never
`git add -A`, never `git checkout`; re-verify the migration ledger head at merge time (a concurrent
session is landing PM migrations right now).

| # | Ticket | Seat | Model | Deps | Done when (acceptance criteria — with positive controls) |
|---|---|---|---|---|---|
| MI-01 ⚡ | **Migration: `webdev_change_requests`** — the §1.2 DDL verbatim (next-unused number at merge; coordinate with concurrent sessions), incl. the `ux_pipeline_runs_id_tenant`/`ux_pm_tasks_id_tenant` guarded DO block, both CHECK constraints, the four indexes, both partial uniques, and the 0075-shape FORCE-RLS plain tenant wall (NO `app_module_allowed`). Files: `platform-nest/migrations/NNNN_webdev_change_requests.sql` | senior-db | default | — | Applies clean + idempotent-safe on a **disposable postgres** (hand-built-deploy runbook idiom); `npm run lint:migration-rls` green; probes with evidence: (a) cross-tenant — insert under tenant A, read under tenant B ⇒ 0 rows; (b) unset-GUC read ⇒ 0 rows **without error** (0025 NULLIF); (c) composite FK refuses a `pipeline_run_id` belonging to another tenant (constructed mismatch ⇒ FK error, the positive control); (d) `wcr_portal_has_requester` + `wcr_route_matches_status` refuse the bad combinations; (e) `ux_wcr_run` allows many NULLs, refuses a second row naming the same run |
| MI-02 ⚡ | **Portal endpoints + `request_change` action + SSE topic.** `POST /api/:tenantId/portal/change-requests`, `GET …/change-requests`, `GET …/change-requests/:id` in a new core controller following the `portal-commerce` shape (authorize `portal:request_change` / `portal:read`; `resolvePortalScope` predicate on EVERY query; server-derived `client_id/requested_by/source/status`; §5.1 project rule; `scrubText`+caps; `emitEvent('webdev.change_request.created')`; `writeActivity`; staff notify via the `notifyInternal` precedent). Add `request_change` to the client rule in `resource_portal.yaml` (comment it narrow-named, per that file's own doctrine). Add the CR event types → `requests` topic in `portal-live.service.ts`. Files: `platform-nest/src/core/webdev-change-requests-portal.controller.ts` (new) + tests, `platform-nest/cerbos/policies/resource_portal.yaml`, `platform-nest/src/core/portal-live.service.ts` | senior-be | default | MI-01 | Positive controls first: an active **viewer** submits successfully (the §5.1 ruling is test-pinned, not implied) and an active signer too; per-owner `notifications` **rows asserted present** (a 200 is not a pass — assert row content, not absence of error). Refusals: project-scoped contact + out-of-scope project ⇒ 4xx; project-scoped contact + NULL project ⇒ 4xx; `invited`/`revoked` contact ⇒ 403 (via `callerClientIds`); client A reading client B's CR (same tenant) ⇒ invisible; body-supplied `status:'done'`/foreign `client_id` ignored (row shows server values). Outbox row `webdev.change_request.created` present in the same transaction. **Cerbos restarted (`gaiada-test-cerbos`, :3592) before verifying** — trap #3 AC line. Unit + http tests green |
| MI-03 ⚡ | **Staff surface + triage + the mini-run spawner.** Staff list/detail (`GET /api/:tenantId/webdev/change-requests[/:id]`), internal create (`POST …`, `source='internal'`), and `POST …/:id/triage` `{action: 'decline'\|'convert', route?, reason?, kindOverride?}` implementing §2–§3 exactly: new lock namespace + helper (`webdev-cr-lock.ts`, mirroring `pipeline-lock.ts`), **lock → re-read → precondition re-check (`status='new'`) → spawn → CR update → events, ONE `withTenants` transaction**; mini-run per §3.1 (run + `prd_extract`/`scope_extract` done-stages + client `prd_sign` gate + `pipeline.run.created` with the `createRun:222` payload shape); pm_task route via a PM-module-exported service function (add the export in `modules/pm` if none exists — do NOT duplicate its insert logic in core); `control_plane` refused with an explicit webdesk-P4 error; decline records reason + notifies requester; convert notifies per §5.3; D17 `customFieldTargets` gains `webdev_change_request`. New policy `resource_webdev_change_request.yaml` per the §4.2 table (incl. the trap-#4 `group_executive`+`notLow`-only rule; `client` role appears NOWHERE). Files: `platform-nest/src/core/webdev-change-requests.controller.ts` (new), `platform-nest/src/core/webdev-cr-lock.ts` (new), `platform-nest/cerbos/policies/resource_webdev_change_request.yaml` (new), `platform-nest/src/modules/pm/*` (service export only), tests incl. a `pipeline-race.test.ts`-style concurrency test | senior-be | **opus·medium** — raced double-triage idempotency where a lock-without-re-check implementation passes every ordinary test (the DEF-2 class), plus cross-surface correctness (spawned rows must satisfy the shipped fanout + `Load + decide` with zero special-casing); a cheap-first failure re-runs the whole ticket and can ship a silent race | MI-01 (∥ MI-02 fine — disjoint files except none) | The concurrency test is the headline AC: **two concurrent converts ⇒ exactly ONE run**, loser gets 409 carrying the existing `pipeline_run_id` (positive control modeled on `pipeline-race.test.ts`); a fault injected after the run INSERT rolls back run+stages+gate+CR atomically (transactional-outbox assert). Fanout compatibility proven: the emitted event resumes `pipeline-fanout` on live n8n (or, minimum, payload-shape parity with `createRun:222` test-pinned + one live walk deferred to MI-07). Cerbos probes: client-only principal ⇒ DENY on all three actions (the §4.1 invariant, probed positively); `group_executive` with NO membership row ⇒ ALLOW (trap #4); plain member ⇒ DENY read. Staff reads work both with and without `withTenants` `modules:['webdev']` declared (plain-wall regression guard, trap #2). **Cerbos restart AC line** (trap #3). All tests green |
| MI-04 ⚡ | **Portal Requests page.** `(portal)/portal/requests/page.tsx` (+ detail view or expandable rows): "New request" form (kind/title/body/project selector fed by the caller's scope), list with status chips, declined-reason display, `in_progress` mini-run deep-link to the existing `/portal/approvals/[runId]`; nav item in `(portal)/portal/layout.tsx`; subscribe the SSE `requests` topic → refetch; DEMO fixtures. Files: `platform-ui/src/app/(portal)/portal/requests/*` (new), `(portal)/portal/layout.tsx`, the portal data lib (follow the invoices page's fetch idiom), `platform-ui/src/lib/demoFixtures.ts` | senior-fe | default | MI-02 | Submits succeed as viewer AND signer fixtures; project selector offers ONLY in-scope projects (client-wide fixture additionally gets an "all projects" option; project-scoped fixture gets NO such option); SSE ping refetches (live probe with backend up); degrades cleanly backend-off (ConnectionState/EmptyNote idiom); phone-width usable; a11y (labels, focus order, reduced-motion); `tsc` + unit + e2e (DEMO_MODE) green |
| MI-05 | **Staff console Requests tab** in the webdev dept console (Build group, dept-interface-template): triage queue (`status='new'` first), triage drawer (kind override, §2.3 route defaults rendered as suggestion, decline+reason, convert), detail w/ linked run/task links to `/pipeline/[runId]` / the PM task; toolkit registration so the tab appears only when the route exists. Files: `platform-ui/src/components/departments/*`, `platform-ui/src/lib/deptToolkits.ts`, a `lib/` read helper, fixtures | medior | default | MI-03 | Queue renders + orders correctly; drawer round-trips decline and both convert routes against the live API; RBAC: manager-tier fixture sees triage actions, member-tier does not; teach-state when empty; `tsc` + unit + e2e green |
| MI-06 | **Docs truth.** `docs/FRONTEND-BFF-CONTRACT.md`: add the five new endpoint rows with BUILT/PENDING per reality, each citing its controller file; `docs/modules/MODULES.md`: webdev section gains the maintenance-intake lines (status language: IN PROGRESS until MI-07 passes, then DEV-VERIFIED) **and fix the 0.11.0 (index, line 49) vs 0.8.1 (heading, line 274) drift**; CHANGELOG entry per the per-module 0.x scheme. No code | junior | default | MI-02..05 merged | Contract rows match shipped routes exactly (spot-checked against the controllers); registry drift gone; status words are only PLANNED/IN PROGRESS/PROTOTYPED/DEV-VERIFIED; CHANGELOG present |
| MI-07 ⚡ | **Phase QA gate (runs alone, last).** Evidence-driven full walk on the live stack: portal submit as viewer / signer / project-scoped contact → staff decline (+requester notified) → convert `pm_task` → convert `mini_run` → client signs `prd_sign` + both parties sign scope **on the mini-run** → design stage releases via live n8n fanout + `Load + decide` → run visible in `/portal/approvals`; the double-convert race driven BOTH ways (repo concurrency test + a real double-click through the UI); notification assertions **by row**: submit→project owners, decline/convert→requester, `prd_sign`→signers ONLY (assert the viewer fixture did NOT receive it); Cerbos matrix incl. the §4.1 invariant probe and the trap-#4 exec probe; RLS probes incl. unset-GUC; cross-client + cross-tenant isolation; trap-#2 regression guard (reads with and without declared module scope). File regressions as tickets, never fix ad hoc | qa | default | all of MI-01..06 | The written evidence list exists in full (WD-08 style); zero critical findings open; every "notified" claim is backed by a `notifications` row cited by id — **the missing-field-reads-as-null rule applies: a 200 with an empty list proves nothing** |

> ### F2 — D17 custom fields on change requests: **DEFERRED out of this phase, 2026-08-08**
> MI-03's row listed *"D17 `customFieldTargets` gains `webdev_change_request`"*. Verification found it
> has **no home**: `customFieldTargets` is a `ModuleContract` field, there is **no
> `src/modules/webdev/`**, `0088` has no `custom_fields` column, and neither controller calls
> `validateCustomFields`. The seat correctly refused to improvise DDL.
>
> **Ruled: dropped from this phase, and NOT a gap MI-07 gates on.** The cost is not the reason —
> the reason is that closing it pulls the wrong way. Creating a `webdev` **module** to host the
> contract field would drag this surface toward module registration and module gating, which is
> precisely what **D-2a** rejected for a table whose primary writer is the client portal: the module
> gate is a two-sided handshake on the request-declared `app.scopes` GUC, so module-ising the CR
> surface reintroduces the silent-zero-rows failure by the back door. Adding a `custom_fields` column
> alone, with no module and no validation call, would ship a column nothing reads — the
> "correct-but-unwired is indistinguishable from absent" pattern this estate has hit six times.
>
> Reopen when there is a real demand for per-tenant fields on a change request. At that point it is a
> deliberate schema + contract ticket (column + validation call + a decision about where the contract
> field lives), not a line item inside a triage ticket.

**Waves (1–2 concurrency cap per the standard):**
W1 `MI-01` alone (schema first, everything verifies against it) → W2 `MI-02 ∥ MI-03` (disjoint new
files; both add distinct Cerbos files — MI-02 edits `resource_portal.yaml`, MI-03 adds a new policy
file, no overlap) → W3 `MI-04 ∥ MI-05` → W4 `MI-06` → W5 `MI-07` alone.
**Seat count:** senior-db 1 · senior-be 2 (one **opus·medium**) · senior-fe 1 · medior 1 · junior 1 ·
qa 1 = **7 tickets, 1 Opus flag, 5 ⚡ QA-gate flags** (MI-01/02/03/04/07).

---

## §8 · Open questions for the owner (each with a default that holds if unanswered)

| # | Question | Blocks | Default if unanswered |
|---|---|---|---|
| OQ-1 | Should triage items ALSO surface in the unified "Waiting on me" approvals rail (which unions WS4 approvals + pipeline gates today)? | Nothing — additive later | **No for v1.** Dept-console queue + bell notification; adding a third source to the rail is a WSUX contract change with its own ticket |
| OQ-2 | Internal submissions (`source='internal'`): any staff member, or manager+? | MI-03 policy width | **Manager+** (as specced §4.2). Widening to member later is a one-rule policy edit, no schema change |
| OQ-3 | Hide the portal Requests page when the tenant lacks `webdev` in `enabled_modules`? | MI-04 polish only | **Show always** (the agency is a webdev shop; the API stays module-agnostic either way per §1.1). Display-only toggle later if multi-dept intake arrives |
| OQ-4 | Client attachments (screenshots) on submit? | Nothing in v1 | **Defer to v1.1.** The base64-in-body pattern exists to lift verbatim (`recordPayment`'s `storeProof`), but image caps + scrub deserve their own ticket (the ERP-recorder one-multipart-limit lesson) |
| OQ-5 | Auto-complete the CR when its linked run/task completes? | Nothing — manual "mark done" ships | **Defer.** The event-consumer plumbing exists, but "run complete ⇒ request done" has judgment in it (a run parked `blocked` is not done) |
| OQ-6 | AI `kind`-classification assist at triage (blueprint §07 row: gateway `/complete`, suggestion-only)? | Nothing | **Defer post-v1**; zero schema impact when it lands |
| OQ-7 | Server-side idempotency key on portal submits? | Nothing | **No for v1** — UI-disabled double-submit; duplicate CRs are visible and declinable, unlike duplicate runs |
| OQ-8 | Cancel/decline after convert (`in_progress` CRs)? | Nothing | **Not v1** — cancel the run/task through their own surfaces; note the `wcr_route_matches_status` CHECK encodes the v1 machine, so widening later needs a migration (deliberate: state machines in CHECKs are cheap to widen, expensive to un-widen) |

---

*Cross-references:* [webdev blueprint](../../blueprints/webdev-design.md) (§04 sketch this refines,
§07 spine, §12 P5, §14 D-2/D-7) · [0072](../../../platform-nest/migrations/0072_client_contacts_and_engagement_setup.sql) ·
[0075](../../../platform-nest/migrations/0075_client_portal.sql) ·
[pipeline-lock](../../../platform-nest/src/core/pipeline-lock.ts) ·
[pipeline controller](../../../platform-nest/src/core/pipeline.controller.ts) ·
[portal-scope](../../../platform-nest/src/core/portal-scope.ts) ·
[client-notify](../../../platform-nest/src/core/client-notify.ts) ·
[portal policy](../../../platform-nest/cerbos/policies/resource_portal.yaml) ·
[integration-connection policy (trap-#4 precedent)](../../../platform-nest/cerbos/policies/resource_integration_connection.yaml) ·
[fanout workflow](../../../automation/workflows/pipeline-fanout.json) ·
[BFF contract](../../FRONTEND-BFF-CONTRACT.md) · [MODULES registry](../../modules/MODULES.md)
