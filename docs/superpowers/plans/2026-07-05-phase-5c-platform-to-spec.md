# Phase 5c — Platform to Spec (agency-first-deploy priority)

> Governing: full-fidelity mandate + ws1-architecture / ws1-core-schema. TDD; commit per
> task; live PG + Cerbos.

## First-deploy reality (BINDING, 2026-07-05)
The **digital agency is a real child company shipping in the FIRST deploy.** So the agency
vertical and the core entities it depends on (clients, deliverables, time, approvals, briefs,
creative assets) must be genuinely operable day one — not skeletons. The web UI
(`platform-ui`, Next.js) is being built in parallel against the current Fastify backend.

## Sequencing decision (recorded, reversible)
The **NestJS port stays on the register but is deferred** as a non-blocking fidelity
migration: the first deploy runs on the current Fastify core, which is behavior-complete to
spec (RLS, Cerbos, ModuleContract, D-constraints all hold) and is what the UI already targets.
Porting now would churn an actively-developed `server.ts`/UI for no first-deploy benefit. The
`ModuleContract` boundary keeps the port mechanical when it's scheduled. Event backbone and
the sync engine remain single-site-deferred (their own sub-specs first).

## Tasks (agency-first order; coordinate on server.ts with the in-progress UI work)

- [x] **5c.1 Agency module completeness** — ✓ briefs CRUD + `agency_creative_assets` (table+routes) + submit-for-review→approval→review-state lifecycle; Cerbos policies for both kinds; assets-in-review rollup; 8 agency tests. Remainder of original bullet: — briefs CRUD (table exists, no routes yet),
  `agency_creative_assets` (new table: campaign FK, name, media_ref, status, review state) +
  routes, richer campaign lifecycle (budget/currency already there); Cerbos resource policies
  for `agency_brief` + `agency_creative_asset`; rollups (assets awaiting review). Tests: full
  brief→asset→approval flow, tenant isolation, module-enable gating. **[modules/agency — mine]**
- [x] **5c.2 Core client-work entities** — ✓ `clients`, `deliverables`, `time_entries` CRUD
  wired to the **CORE** tables (0001), in `src/core/client-work.ts` on the core `/api` scope;
  custom-field validation (D17), activity audit, time-entry owned by the logger; core
  billable-minutes + open-deliverables rollups; Cerbos `resource_{client,deliverable,time_entry}`
  (member time-edit gated by `owns`). **Correction:** the first pass duplicated these into the
  agency namespace (to avoid touching server.ts); once that constraint lifted they were wired
  to the shared core tables and migration 0008 dropped the agency dupes. 7 core client-work tests.
- [x] **5c.3 Comments + notifications** — ✓ `src/core/collab.ts`: threaded polymorphic comments
  + per-user notification inbox; `notify()` helper raises on assignment (new task GET+PATCH),
  mention, comment-on-assigned-work, and approval-decided (agency). Cerbos `resource_comment`
  (viewer read-only) + `resource_notification`. 7 tests.
- [x] **5c.4 Files/attachments** — ✓ migration 0009 (polymorphic `files`, FORCE RLS);
  `StorageBackend` seam + local-first impl (path-traversal-guarded); day-one PII scrub on text
  before store; base64 upload / download (attachment + nosniff + CSP), list, delete. **Security
  hardened** (review): stored-XSS, IDOR-vs-target-entity, header-injection all fixed. Cerbos
  `resource_file`. 5 tests.
- [x] **5c.5 Agency rollups → management view** — ✓ `agency.utilization` (billable ÷
  members×8h capacity, D12 num/den) + `agency.deliverables.due_week`, atop active-campaigns /
  pending-approvals / assets-in-review. Test in agency suite (now 9).
- [x] **5c.6 Web UI wiring** — ✓ closed the one real contract gap: custom-field definitions
  registry endpoint (`/:t/custom-fields`, the UI already called it) + Cerbos `resource_custom_field`;
  added typed BFF helpers (`platform-ui/src/lib/entities.ts`) for clients/deliverables/time/
  comments/notifications/files (all graceful). Every first-deploy agency contract now has a
  backend + a typed client. 4 custom-field tests. (UI screens remain the user's.)
- [x] **5c.7 Agency first-deploy e2e + seed** — ✓ `src/agency-first-deploy.e2e.test.ts` drives
  the whole day through the real API; `src/seed/agency.ts` (`npm run seed:agency`, idempotent)
  seeds a realistic Gaiada Creative tenant; readiness checklist at
  `docs/superpowers/plans/2026-07-05-agency-first-deploy-readiness.md`. 86 platform tests total.

## Deferred to later 5c sub-phases (not first-deploy blocking)
NestJS port · event backbone (Redpanda/NATS) · sync engine (Go, own sub-spec) · Go realtime
hub · additional verticals (resort/marine/printing) · multipart/large-file upload (base64
path ships now) · notification email/push fan-out (in-app inbox ships now).
