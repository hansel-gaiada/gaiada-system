# Web Dev — real-data readiness gap assessment

> ### ⚠️ PARTIALLY SUPERSEDED — read this before trusting any row below
> Several of these gaps were **closed the same day this was written** (W0/W1, commits `ad10e85`
> → `9176c49`). Two lines in particular were stale within hours and misled a reader:
>
> - **B1 / §E — `scope_signoff.create` "requires company_admin/group_executive, so the manager-tier
>   automation account was rightly denied".** The policy was **widened to include `manager`** on
>   2026-08-03 (owner decision D-2). An agent caught this by reading the live policy instead of this
>   doc — do the same.
> - **A3 — "`clients.portal_user_id` has no write path".** Still true of that column, but the portal
>   now resolves through `client_contacts` (migration 0072), so the *gap* is closed by a different
>   mechanism than this row implies.
>
> Also newly known and NOT in the rows below: the scope-signoff endpoint accepted an **arbitrary
> `party` string** (only checked for truthiness), so a wrong value stored a signature that could never
> satisfy `REQUIRED_SCOPE_PARTIES ["provider","client"]` — a run permanently unable to complete, with
> `complete:false` reading exactly like a correct "waiting on the other party". Now validated.
>
> The **status table in the addendum and the CHANGELOG entry for 2026-08-03 are authoritative** over
> this document. Kept as written otherwise, because the *reasoning* still holds and rewriting a
> findings register after the fact loses the record of what was actually observed.


**Date:** 2026-08-03 · **Purpose:** enumerate everything that stops the Web Dev department running on
**real client data**, so the whole set can be closed in one wave.
**Method:** read against current code + verified live on `gda-aicenter` (see
[server E2E notes](../../../infra/runbooks/deploy-vps.md#web-dev-department--post-deploy-checklist)).
Every row cites evidence; nothing here is inferred from a doc.

## What already works (so the wave doesn't rebuild it)

Proven live on the server 2026-08-03: capture → transcribe (local whisper, audio **and** video) →
ingest → pipeline run + 3 extraction tracks (real MOM + a genuine PRD) → fan-out opens the client
`scope_signoff` gate → agency records its half. ⚠️ **That last clause was WRONG as originally written**
("`complete:false`, correctly waiting on the client"): the walk sent `party:"agency"`, which is not one
of `REQUIRED_SCOPE_PARTIES ["provider","client"]`, so it recorded a signature counting for neither and
the run could never complete. `complete:false` was indistinguishable from the correct waiting state,
which is exactly how it fooled me. The endpoint now validates `party`.
Client context flows onto the run (`client_id` set), so runs are portal-scoped. The client portal page
itself is genuinely built — it lists the client's runs, **renders the actual artifact inline**, and has
working decide / scope-sign forms.

---

## A · Structural gaps (schema — real data cannot be modelled correctly)

### A1 🔴 `pipeline_runs` has no `project_id` — the project link is LOST at ingest
**This is the project↔client connection gap.** `meeting_recordings` carries **both** `client_id` and
`project_id`; `pipeline_runs` carries **only** `client_id` (`0017_pipeline.sql:15-26` +
`0018_pipeline_portal.sql:7`). So a recording started from a project workspace knows its project, and
the run it produces forgets it — permanently.

Consequences, all real today:
- The report sink can't attach its doc/task to the run's project, which is why WD-06 had to invent a
  `WEBDEV_REPORT_PROJECT_ID` env var pointing at **one** project for the whole tenant.
- The run workspace can't link back to the project, and the project workspace can't list its runs.
- Deliverables produced by a run can't be attributed to the project that paid for them.

**Fix:** additive `pipeline_runs.project_id uuid REFERENCES projects(id)`, populated by the dispatcher
from `meeting_recordings.project_id` (the same hop F-1 already built for `client_id` — extend
`meeting.recordingContext`, don't add a second mechanism). Retire the env var.

### A2 🟠 `pipeline_runs` has no owner / assigned-PM column
Notifications therefore reuse `NOTIFY_USER_ID` — every run notifies the same person regardless of who
owns it. **Fix:** `pipeline_runs.owner_id uuid REFERENCES users(id)`, defaulted to the recording's
`created_by`, editable in the run workspace.

### A3 🔴 `clients.portal_user_id` has NO write path — the client portal is unreachable
The column exists (`0018_pipeline_portal.sql:11`) and every portal read depends on it
(`portal.controller.ts:47-56` resolves the caller via it), but it is written **only in test fixtures**
(`platform-nest/src/testing/fixtures.ts:110`). There is no endpoint and no UI. Verified on the server:
`portal_user_id` is NULL for both real clients.

So the client half of every gate — `scope_signoff`, `customer_feedback`, staging review — **can never
be countersigned in production**, and the delivery chain permanently stops at "waiting on client".

**Fix (three parts):** a BE write path (`PATCH /api/:t/clients/:id/portal-user` or fold into the
existing client PATCH) + a Cerbos rule (company_admin-tier: granting portal access is a governance
action) + UI on the client detail page to invite/link a contact. Decide whether the portal user is an
existing platform user or a newly provisioned one — see Open Questions.

---

## B · Missing UI write paths (the backend endpoint EXISTS; nothing calls it)

Produced by diffing every endpoint the UI calls against the controllers' routes. The UI's whole
pipeline write surface is **two** calls: gate decide, and stage-artifact PATCH.

| # | Sev | Endpoint that exists | What a human cannot do today |
|---|---|---|---|
| B1 | ✅ FIXED (W1: `recordScopeSignoffAction`) | `POST /api/:t/pipeline/runs/:runId/scope-signoffs` | **The agency cannot record its half of the scope dual-sign from the app.** I had to curl it during the server walk. Together with A3 this means *no* scope agreement can ever complete in the product. |
| B2 | 🟠 STILL OPEN | `POST /api/:t/pipeline/runs` | Start a delivery run for an existing client/project **without** a meeting recording. Every run must currently originate from a recording. |
| B3 | ✅ FIXED (W1: `updateRunStatusAction`) | `PATCH /api/:t/pipeline/runs/:runId` (WD-05 `updateRun`) | Park / unblock / re-status a run. A stuck run stays stuck. |
| B4 | ✅ FIXED (W1: `createStageAction`) | `POST /api/:t/pipeline/runs/:runId/stages` | Add a beat by hand when automation didn't create it. |
| B5 | ✅ FIXED (W1: `openGateAction`) | `POST /api/:t/pipeline/gates` | Open a review gate manually — the only recovery when a workflow missed one. |
| B6 | 🟡 STILL OPEN (API-only) | `POST /api/:t/meetings/recordings/relink-orphans` | Repair recordings orphaned from their run. API-only; needed on the server today. |

`decideGateAction` covers all six `GateKind`s generically (`lib/pipeline.ts:21`), so gate decisions
themselves are fine — it is the *surrounding* run lifecycle that has no controls.

---

## C · Real-data scale + workflow UX

| # | Sev | Gap | Evidence |
|---|---|---|---|
| C1 | 🟠 | `/pipeline` fetches **every** run with no filter, search or pagination | `lib/pipeline.ts:102` — bare `GET /pipeline/runs`; page passes nothing |
| C2 | 🟠 | `/meetings` has no filter UI although the lib already supports it | `listRecordings` accepts `status`/`clientId`/`projectId` (`lib/meetings.ts:82-90`); `meetings/page.tsx:25` passes none |
| C3 | ✅ FIXED 2026-08-04 (batched: 2 queries, + a free `pendingActions` count) | The portal did **N+1 fetches** — lists all runs then calls `getPortalRun` for each | `portal/page.tsx:29-31` (`Promise.all` over every run). Fine at 3 runs, not at 300 |
| C4 | ✅ FIXED 2026-08-04 (list SELECT now carries `client_id`/`project_id`/`owner_id`) | The pipeline **list** had no client column, so you cannot see whose work a run is without opening it | `lib/pipeline.ts:14` states the list SELECT omits `client_id` |
| C5 | ✅ FIXED 2026-08-04 (`/portal/[runId]` + shared `PortalGateActions`; the list is now a summary) | No client-facing run **detail** route — everything was inline on one page, and `getPortalRun`/`PortalRunDetail` were dead code | only `portal/page.tsx` existed |
| C6 | ✅ FIXED 2026-08-04 (unblocked by W0's `project_id` + WD-30 populating it; both selects now carry it, run workspace links to the project) | No run→project / run→recording→project navigation anywhere | — |

---

## D · Deployed-state gaps (server)

| # | Sev | Gap |
|---|---|---|
| D1 | ✅ FIXED 2026-08-04 (recorder + video allowlist deployed on `alpha-01.011.0030a`) | The browser recorder + video allowlist are **not deployed** — the running image `alpha-01.004.0005a` predates them. Two real recordings from 2026-07-31 sit at `status='recording'`: users pressed a button that never recorded. |
| D2 | ✅ FIXED (verified live: agency `enabled_modules` now carries `pm`) | `pm` is **not** in the agency tenant's `enabled_modules` (`agency,hr` only), so the WD-06 report sink (`pm.createDoc`/`pm.createTask`) will fail module-gating when the report track reaches it. |
| D3 | ✅ FIXED 2026-08-04 (server migration head `0074` == repo head) | DB migration head `0063` vs repo `0069` (search + reports, other sessions'). Not webdev's, but the box is behind. |
| D4 | ✅ | whisper not started · bridge entity types empty · bridge timeout too tight — **fixed 2026-08-03**, and now in `.env.example` + the deploy runbook so a redeploy can't regress them (commit `8ddf538`). |

---

## E · Code defects found on the live walk

| # | Sev | Defect |
|---|---|---|
| E1 | 🟠 | **WD-08-R2's fix is circular.** The dispatcher's dedupe node resolves the runId from the recording's own `pipeline_run_id` — the very field a timed-out first attempt failed to set — so it always yields `runId: null`, and its try/catch fail-soft hides it. Should resolve via `pipeline_runs.source_meeting_id`. |
| E2 | 🟠 | **`relink-orphans` excludes the case it exists for.** Predicate `pipeline_run_id IS NULL AND status <> 'ingested'`; the orphan shape is exactly `ingested` + unlinked. Live proof: `scanned 2, relinked 0` with a matching run present. `pipeline_run_id IS NULL` alone suffices. |

Not defects, confirmed correct and deliberately left alone: `scope_signoff.create` requiring
`company_admin`/`group_executive` (so `wf:scope`'s manager role is rightly denied), and the ingest
proxy reporting `reason` verbatim rather than claiming false success.

---

## Proposed single wave — ordered, with the dependencies that actually bind

Sequenced so each step unblocks the next; A1/A3 are the roots.

```
W1 (schema roots, must land first — one migration, next-unused at merge)
   S1  pipeline_runs += project_id, owner_id            (A1, A2)
   S2  clients.portal_user_id write path + Cerbos       (A3 backend half)

W2 (make the chain completable — depends on W1)
   S3  dispatcher carries project_id through recordingContext; retire
       WEBDEV_REPORT_PROJECT_ID                          (A1 wiring)
   S4  agency scope sign-off UI + client portal-user invite UI   (B1, A3 UI half)
   S5  fix E1 (dedupe resolves via source_meeting_id) + E2 (drop the status clause)

W3 (run lifecycle controls — independent of each other)
   S6  run create / status-update / stage-add / gate-open UI      (B2-B5)
   S7  relink-orphans admin affordance                            (B6)

W4 (scale + navigation — safe last, no one blocks on it)
   S8  filters + search + pagination on /pipeline and /meetings; client column
       on the pipeline list                                       (C1, C2, C4)
   S9  portal: kill the N+1, add /portal/[runId]                  (C3, C5)
   S10 run↔project↔recording navigation                           (C6)

W5 (deploy + tenant config — needs the image cut)
   S11 deploy the recorder + video allowlist; forward
       MEETING_VIDEO_MAX_BYTES (already in compose)               (D1)
   S12 enable `pm` on the agency tenant                           (D2)
```

**Why this order:** every UI gap in B and C is cheap; A1 and A3 are the only ones that change the
data contract, and four other items (S3, S4, the report sink, C6) are meaningless until they land.
Doing them first avoids building UI against a shape that is about to change.

---

## Open questions for the owner (each changes what gets built)

1. **Client portal identity model (A3):** is a client contact (a) an existing platform `users` row you
   invite, (b) a newly provisioned Keycloak account per contact, or (c) a magic-link/token holder with
   no account? This decides whether S2 is a link-picker or a full invite+provisioning flow, and
   whether portal users appear in `/people`. **Blocks S2/S4.**
2. **One portal user per client, or several?** `clients.portal_user_id` is singular. Real engagements
   usually have 2-3 stakeholders who each want to sign. If several, this becomes a join table and A3
   grows accordingly — worth deciding now rather than migrating twice.
3. **Should a run be able to exist without a project (B2/A1)?** i.e. is `project_id` nullable
   (internal/spec work) or required for client runs? Affects the constraint and the create-run form.
4. **Who may sign the agency half of a scope (B1)?** Policy today is company_admin/group_executive.
   Confirm a PM/manager should NOT be able to, or the policy widens with S4.

Nothing above blocks W1's schema work except Q2 (portal user cardinality), which does change S2's
shape — worth answering before the wave starts.

---

*Cross-references:* [Phase-3 tickets](./2026-07-30-webdev-phase3-tickets.md) ·
[webdev design](../../blueprints/webdev-design.md) · [WD-08 defect register](./2026-07-30-wd08-evidence.md) ·
[BFF contract](../../FRONTEND-BFF-CONTRACT.md) · [deploy runbook](../../../infra/runbooks/deploy-vps.md)
