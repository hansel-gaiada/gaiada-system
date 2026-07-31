# Gaiada — Module Changelog

Per-module change history. Format follows [Keep a Changelog](https://keepachangelog.com) +
[SemVer](https://semver.org) (all `0.x` — nothing is in production yet). **Append an entry on every
notable module change or commit; bump the version in [`MODULES.md`](./MODULES.md) to match.**

Status vocabulary: `PLANNED` · `IN PROGRESS` · `PROTOTYPED` (dev-only) · `DEV-VERIFIED` (e2e on the
local stack). None of these mean "production-done".

---

## App release log

Every cut app version and the exact module manifest it contains, so any deployed build can be
reconstructed from this table alone. Format defined in [`VERSIONING.md`](./VERSIONING.md).

### `Alpha 01.001.0001b` — 2026-07-31 — re-cut (build fixes)

Same module set as `0001a`, so the module-reference counter holds at `0001` and only the revision
letter moves — exactly the case the letter exists for. `0001a` never produced a deployable image.

Two failures in the `0001a` release run, both real:

- **platform-nest image failed to build.** `dataforseo.ts(247,42) TS2345: 'string | undefined' not
  assignable to 'string'`. `0001a` snapshotted that file mid-edit while the SEO seat was writing it;
  the seat fixed it moments later. Root cause on our side was the **verification gate**: the cut was
  checked with `tsc` against `tsconfig.json`, while the Dockerfile builds with `tsconfig.build.json`.
  Cuts are now verified with the build config, which is what CI actually runs.
- **SLSA provenance failed for all 8 components** — "Feature not available for user-owned private
  repositories." `actions/attest-build-provenance` needs a public repo or an org plan. Made
  non-blocking; the controls `deploy.yml` **enforces** (cosign keyless signature + attested SBOM)
  both succeeded. This is a genuine reduction in supply-chain assurance, not a formality — remove
  `continue-on-error` once the repo is org-owned.

Registry note: the SEO/tracker seats added `search-marketing` and `reports` to the registry during
this window, so the manifest below is now 20 modules rather than 14.

### `Alpha 01.001.0001a` — 2026-07-31 — first versioned build (SUPERSEDED, no image)

Baseline manifest. Cut to deploy the trial stack onto **gda-aicenter**, the new Hermes/DeepSeek
box, and the first app version to exist at all.

| Module | Ver | Module | Ver |
|---|---|---|---|
| platform-nest | `0.7.0` ↑ | wa-chat-bot | `0.9.1` |
| platform-ui | `0.7.0` ↑ | ai-agents | `0.4.0` |
| ai-gateway-go | `0.13.0` | hermes-gateway | `0.2.0` |
| mcp-hub | `0.9.1` ↑ | capture-helper | `0.2.0` |
| sync-engine-go | `0.7.0` | webdev | `0.8.1` |
| automation (n8n) | `0.4.1` ↑ | webdesk | `0.0.0` |
| observability | `0.6.0` | infra | `0.6.0` ↑ |

**Five module bumps** (↑). Because this is the baseline manifest the module-reference counter
starts at `0001` rather than `0005` — from here it advances by the number of bumps per release.

- **platform-nest `0.6.3 → 0.7.0`** — search-marketing provider layer (DataForSEO, Ahrefs, typed
  dispatch, cost ledger), Google OAuth + GSC/GA4 + search terms + SEM export, a new `reports`
  module with its Cerbos policy, PM task assignees/contributors, dept resolution, last-resort
  exception filter. Migrations `0053`–`0057`, `0060`–`0063`.
- **platform-ui `0.6.5 → 0.7.0`** — Google connections + GSC/GA4 panels, rankings panel, change
  proposals, paid-action gate, PM contributors.
- **mcp-hub `0.9.0 → 0.9.1`** — automation-policy tightening.
- **automation `0.4.0 → 0.4.1`** — SM n8n flows retired (superseded by the platform-side pull
  scheduler); env/README updated.
- **infra `0.5.2 → 0.6.0`** — compose profile lanes (`data`/`bot`/`auth`/`multisite`/`whisper`)
  and the host-data topology overlay for gda-aicenter; `GATEWAY_TOPOLOGY_MODE` un-hardcoded;
  `EMBED_CHAIN`/`OLLAMA_EMBED_MODEL` declared; deploy pipeline parameterized; `APP_VERSION`
  plumbed to `GET /health`.

**Verification at cut time:** platform-nest typecheck clean; platform-ui typecheck + 729 tests
green; mcp-hub typecheck + 106 tests green. platform-nest's suite needs live PG + Cerbos and was
not run locally — it runs in CI.

**Known caveat:** migrations `0058` and `0059` do not exist in the tree. If they surface later they
will apply *after* `0060`–`0062`, which the ledger orders by filename — check before they run
anywhere real.

---

## Program log — module additions

| Date | Event |
|---|---|
| 2026-07-30 | `search-marketing` **P1 fully LANDED (M2 reached) · P3's SM-18 LANDED · P5 hardening wave (SM-50…SM-61) opened and mostly closed · SM-23 doc-reconcile pulled forward.** ⚡ gates cleared: SM-08/SM-10/SM-13 (§6y — the oldest gate debt), SM-18 (cluster→plan generator + RSA/negative AI drafts + change-proposal CRUD, §6r+§6x.1), SM-25a-service/SM-58/SM-60 (§6ar), SM-51 (Google OAuth sandbox, §6ar), SM-14 remainder + its gate (§6af/§6ak). **The money-path P0 (SM-50, incurred-cost ledger rows) FAILED its first gate (§6ak), was fixed by SM-60, and PASSED (§6ar)** — migration `0053`. SM-52 (money-env-guard widened to all nine cap/price/ratio vars), SM-53 (typed dispatch refusals → honest HTTP, never 500) and SM-55 (SM-15's blocked n8n flows retired + deny-by-default regression test) also LANDED. SM-25a's HTTP surface (Google OAuth routes, `search-google-oauth.controller.ts`) is DEV-VERIFIED with its gate PASSED (§6as). **Correction applied by SM-23 (this entry) to two rows this seat itself wrote wrong:** SM-56 (collect-edge double-charge fix) and SM-59 (`vendor_ref` reconciliation predicate) are DEV-VERIFIED (§6an) but had **no gate section naming them** — §1's legend requires merged **and** gated for `LANDED`, so both are corrected to **IN FLIGHT** pending a bundled ⚡ gate (§6au) that also covers SM-54 (the platform-side pull scheduler, off by default — a money control) and the newly-ruled SM-61 (absent-cadence = on-demand, never weekly-default). **SM-23 also found:** twelve P5 tickets (SM-50…SM-61) existed only in narrative sections with no §1 ledger row at all — now added, and two standing rules adopted (a ticket gets its ledger row at creation; a gate section must name every ticket it covers). Added `SEARCH_SCHEDULER_ENABLED`/`SEARCH_SCHEDULER_INTERVAL_MS` to `platform-nest/.env.example` and `infra/compose/.env.example` (present in code/`config.ts` since SM-54 but missing from both example files) — documented as a money control (does this environment spend vendor money unattended), not a performance knob. `docs/FRONTEND-BFF-CONTRACT.md` §14 corrected: the engagement ledger read (SM-17, `GET engagements/:id/ledger`) is built and UI-wired (`CostLedgerPanel.tsx`) and was wrongly still listed as fully PENDING; only the tenant-scope MTD/threshold-event reads remain unbuilt. `docs/modules/MODULES.md`'s search-marketing "What exists (dev)" narrative was three landings stale (still described P0 as in-progress and SM-07/SM-11 as unbuilt) and has been rewritten against current code. **Still open:** the bundled ⚡ gate (SM-54/56/59/61), SM-17's own QA gate, SM-25b/25c (Google read paths, TODO), SM-19/20/21/22/30 (SEM apply/report loop, TODO), and real-vendor-account verification (OQ-2/9/10/11, unfunded). |
| 2026-07-30 | `reports` **TR-07 — nightly fact job + attribution engine (P1's correctness heart), `0.0.0` PLANNED → `0.1.0` IN PROGRESS.** `src/modules/reports/fact-job.ts` computes `report_work_facts` — the atomic `person × project × day` grain — plus `POST /api/:t/reports/facts/recompute {from,to}` (new Cerbos kind `report_admin`/`recompute`: platform-admin + group-executive + own-company admin; dept lead deliberately EXCLUDED per design §8). **Pure core, I/O at the edges** (house pattern): `computeFactRows()` is DB-free and clock-free, `gather*()`/`writeFactSlice()` hold every query; department resolution CALLS TR-04's `resolveDepartment` rather than re-deriving precedence ①–④, and the drift sweep CALLS TR-02's `logAssigneeDriftIfAny`. **Idempotent by construction:** each `(tenant, fact_date)` slice is a DELETE+INSERT in ONE transaction, and row ids are **deterministic uuid v5 over the table's own UNIQUE key** so two recomputes produce byte-identical rows — asserted on FULL row snapshots, with `computed_at`/`job_run_id` required to MOVE (proving the slice was genuinely rewritten, not silently skipped). §3.1's attribution table is pinned case-by-case (person-owner · unit-owner+responsible · unit-only · no-assignee) and a unit-assigned task never invents a person; Σperson ≤ Σunit = company holds with the unattributed bucket EXPLICIT; a 60-day backfill converges. Rulings honoured: `actor_user_id IS NULL` stays person-unattributed (TR-31's machine actors) but still lands on the unit axis; a SUSPENDED service edge still resolves a cross-company person's own unit and only withholds the provider stamp (TR-04 ruling); done-ness reads the consumer's `is_done`-FLAG-derived verbs; `pm_tasks.deleted_at` is filtered by the job (TR-01 backfilled soft-deleted tasks on purpose); `origin_site` passed explicitly. §5.3's leave-aware `auto_missed` check-ins ship with it (holiday/weekend/approved-leave/attendance produce nothing; a submitted or excused row is never overwritten; today is never marked missed). **Two substrate findings for TR-08:** `report_work_facts` has no `tasks_completed_with_due_date` counter, so metric #3's specified denominator (Σ completed-**with-due-date**) is not computable from the landed grain; and the shared `HttpErrorFilter` flattens every error body to `{error, field?}`, so §6.2's `422 {error:'range_too_large', maxDays:400}` ships as `{error:'range_too_large', field:'to'}`. 57 new tests (31 pure + 26 live-PG/Cerbos), `tsc` + `lint:withtenants` clean. |
| 2026-07-30 | `webdev` **WD-29 — pipeline state-transition idempotency (DEF-2 fix), DEV-VERIFIED live on a genuinely-racing driver.** `pipeline-delivery.json` is **byte-identical** (untouched, D-10 spirit); the whole fix is platform-side. New `src/core/pipeline-lock.ts`: a per-run xact advisory lock (`pg_advisory_xact_lock(0x50520001, hashtext(run_id))`) taken as the first statement inside `withTenants` by **every** run-state transition — `createStage`, `updateStage`, `openGate`, `decideGate`, `recordScopeSignoff`, `updateRun`, **plus the two client-side portal paths** (`portal.decideGate`, `portal.scopeSign`), which is where `prd_sign` and `customer_feedback` actually land in production; locking only the internal controller would have left the real-world race fully alive. **The lock alone is a no-op and that was proven, not assumed:** with the lock in place but the precondition re-check removed, the racing driver still produced **6 duplicate rows** — because each racer executes a decision computed from a snapshot read seconds earlier in n8n. The actual fix is lock + server-side re-evaluation of the workflow's own precondition (`existingStageForRepeatedCreate`): a `claude_design` create is admitted only if no design exists (initial `release_design`) or the CURRENT head design carries a decided `customer_feedback: changes_requested` (a genuine revision) — mirroring `Load + decide`'s own rule, so WD-05's bounded revise loop keeps working while raced twins resolve to the live head with `deduped:true` (same shape `createRun` already returns). Single-shot names (`prd_extract`/`report_extract`/`scope_extract`/`claude_code`/`staging`/`production`) dedupe on existence; `openGate` additionally suppresses a duplicate PENDING gate per `(run, stage, kind, actor_side)` — a duplicate pending twin would **stall a run forever**, since `gof()` resolves a beat to the LAST gate of its kind. `scope.signed` now emits on the TRANSITION to complete only (a re-filed signature was previously a row-level no-op that still re-announced the event, starting a delivery execution from nothing). Migration **`0052_pipeline_stage_idempotency.sql`**: partial `UNIQUE(run_id, track, name)` over the six single-shot names + a causal data repair. **The architect's stated repair rule ("keep-oldest, drop the rest") was wrong on all three counts and the live audit caught it before it destroyed data:** (1) the headline "4 groups / 6 excess rows" **over-counts** — run `019fb0a4` is WD-08 §1.6's *correct* rev-1/rev-2 revise pair (0 excess) and `019faebe` raced twice around one genuine revision (2, not 3), so true excess = **4**; (2) keep-oldest keeps the WRONG row — `Load + decide` always operates on `designs[designs.length-1]`, so the newest is the live lineage (run `019faec4`'s older twin held an orphaned *pending* `pm_review` while its newer row carried the whole decided chain incl. the client approval); (3) the rows aren't interchangeable (each `artifact_ref` differs — LLM output) and `pipeline_gates.stage_id` is a real FK, so a naive delete either fails or orphans human decisions. Repair instead pairs consecutive designs and treats them as raced unless a `changes_requested` was decided BETWEEN them; the excess row's gates are DETACHED + **soft**-deleted (never hard-deleted — two carried a `pm_review` a human really did approve). Live: 13→9 designs, 67→63 stages, 4 gates detached+soft-deleted with `decided_by`/`decided_at`/`decision` intact, dup groups 4→2 (both remaining are legitimate revise pairs); **idempotency proven by deleting the ledger row and re-running the real migration as `platform_owner`** — all counts unchanged. `npm run lint:migration-rls` green on `0052`, and the lint was shown to be load-bearing (removing the `set_config` wrapping makes it flag both the gate UPDATE and the stage DELETE). **Live racing verification against the running `:3004`:** 8 concurrent deciders parked behind a pre-taken lock → exactly 1 row, 7 `deduped`, one stage id; lock scope proven correct by holding run A's lock while run B transitioned in **48ms** (a per-tenant lock — the plausible wrong scope — would have serialized the entire pipeline, since every run shares the one agency tenant). **The genuine end-to-end race was reproduced, not merely hoped for:** firing the two platform triggers only serializes (the bridge delivers events one at a time — executions ran 171ms APART), so both workflow webhooks were POSTed concurrently instead, yielding **three overlapping `WS11 delivery track` executions (04:06:08.614/.660/09.259) that ALL returned `action:"released_design"`** — every one decided to create a design — and exactly **ONE** `claude_design` row plus exactly ONE pending `pm_review` resulted. New `pipeline-race.test.ts` (15 tests) is built on a deterministic race window (pre-take the lock, fire N, release) and carries a falsifiability anchor that reproduces the pre-fix duplicate at SQL level. Suites: `platform-nest` **1235/1238** (the 3 failures are the pre-existing `search-notifications.test.ts` `REDIS_URL not set` baseline, SEO-owned), WD-03 signature-lock + façade + WD-05 `updateRun` tests specifically re-verified green, `tsc` + `lint:withtenants` + `lint:migration-rls` clean. **Known limitation, stated plainly:** the schema-level backstop deliberately does NOT cover `claude_design`, because a legitimate revision and a raced duplicate are indistinguishable by the columns on the row (the discriminator is cross-table and causal) — covering it needs an additive revision-discriminator column, which is a write-contract change outside this ticket's approved DDL scope and is filed as a follow-up. |
| 2026-07-30 | `webdev` **WD-26 — digests + stale-nag + relink + n8n hygiene, DEV-VERIFIED live.** Two new n8n CRON flows modeled on `compliance-gate-nag.json` (read → `llm.summarize` → `notify`), the sole `work_activity`-reading digest source (explicitly NOT the legacy `activity.feed` hub tool, which reads the OLD flat `activities` table — LD-16's named trap). `wd-digests.json`: daily 17:00 (1-day window) + weekly Friday 17:00 (7-day window) per-person AND per-project activity digests, one `llm.summarize` call per grouped person/project (never per activity row — the shared/rate-limited Ollama Cloud key stays protected); the weekly branch also fires one `workActivity.relink` sweep. `wd-stale-nag.json`: daily, open `pm_tasks` with no linked activity in N=5 days → nag the assignee; ≥2N=10 days → ALSO notify the project owner (proven with real seeded tasks at 6 and 12 days stale — the 12-day task produced BOTH a `stale_task_nag` and a `stale_task_escalation` row, the 6-day task only the nag). New hub tools (`mcp-hub/src/work-activity-tools.ts`): `workActivity.feed`, `workActivity.staleTasks` (BE computes `daysStale` server-side off `COALESCE(last linked activity, task.created_at)` so N/2N bucketing needs no extra call), `workActivity.relink` (LD-16's deterministic relink sweep — re-runs the pure `deriveLinks` engine over zero-link rows, bounded batch, idempotent by construction). New scoped accounts `wf:wd-digests` (company_admin — needed for the relink tool's admin-only write tier) and `wf:wd-stale-nag` (manager), allowlisted to exactly their own tools (cross-checked: neither can see the other's). **A separate, narrower sweep rides the same ticket per the coordinator's live-data finding:** `POST /api/:t/meetings/recordings/relink-orphans` reconciles `meeting_recordings` rows orphaned by the (now-fixed) 5s ingest-proxy timeout (DEF-1) — matches `meeting_id` ↔ `pipeline_runs.source_meeting_id`; **3 real orphaned rows existed in the live DB and were fixed live** (scanned 13 → relinked 3 → re-run scanned 10/relinked 0, proving idempotency). WD-08-R1 (dispatcher 401 on bad secret) and R2 (dedupe echoes `runId`) were already fixed by another agent before this ticket started — verified still intact post-verification (not re-fixed, not clobbered), along with `pipeline-delivery.json`'s DEF-3 `Suspended (D14)?`/`approvals.request` nodes. **Live verification method:** n8n's CLI `execute` refuses schedule-triggered workflows outright in 2.30.4 ("Missing node to start execution") and the REST API requires an authenticated session, so both flows were fired via a temporary `executeWorkflowTrigger` node patched directly into the n8n Postgres store (never the committed file) routed at each branch in turn, using a one-off `docker run` sharing the real container's data volume + `--add-host=mcp-hub:host-gateway` (the compose `extra_hosts` trick standalone n8n needs); the temp node was stripped by re-importing the clean committed JSON before final reactivation — verified byte-identical after. **A real bug was found and fixed via this live testing, not by inspection:** the digest flow's `Is project?` IF-fan-out reconverges two branches into one downstream node without a Merge, so that node executes once PER BRANCH (separate "runs", not one batched call); `$('NodeName').first()` blindly grabs run-index 0 regardless of which branch's item is actually in flight, and crashed when the project branch's zero-item run happened to land at index 0. Fixed by switching the two affected back-references to `.item` (pairedItem-resolved), which is correct regardless of run ordering — confirmed by an end-to-end `status:"success"` execution producing a real `llm.summarize` call over 49 real live activity rows and a real `notifications` row. **Two rebuild surprises, not migration-related:** `platform-nest` and `mcp-hub` both run compiled `dist/` images in this stack (`build: ../../X` in the vps compose file, no source bind-mount) — the stale-tasks endpoint's live 500 and the hub's initial "unknown tool: workActivity.feed" were both stale-image artifacts, not code bugs; both rebuilt+recreated clean. Two SQL bugs caught only by the live Postgres (not the test suite, which happened to tolerate them): `$2 || ' days'`'s implicit-text-parameter ambiguity (fixed via `make_interval(days => $2::int)`) and a bare `l.target_id = t.id` comparing `text` against `uuid` (fixed via `t.id::text`) in the stale-tasks LATERAL join. No migration in this ticket (stale-tasks/relink are pure reads/writes over existing `work_activity`/`pm_tasks`/`pm_project_meta` tables). `platform-nest` full suite: 106 files/1223 tests, 3 pre-existing failures unrelated (`search-notifications.test.ts` `REDIS_URL not set`) + `tsc` clean; `mcp-hub` full suite 16 files/105 tests green + `tsc` clean except the pre-existing `module-tools.test.ts` `fetch.mock` typing issue. `docs/FRONTEND-BFF-CONTRACT.md` §11 extended with the new stale-tasks/relink rows. |
| 2026-07-30 | `webdev` **WD-28 — PM per-project short-codes (OQ-7 default), Phase-3's first landed ticket — DEV-VERIFIED.** `projects.short_code` (`UNIQUE(tenant_id, short_code) WHERE deleted_at IS NULL AND short_code IS NOT NULL`, derived on creation: first 3-4 uppercase alnum chars of the name, numeric-suffixed on collision) + `projects.task_seq` (atomic per-project counter) + `pm_tasks.seq` (`UNIQUE(tenant_id, project_id, seq) WHERE seq IS NOT NULL`); `CODE-SEQ` display form (e.g. `WEB-142`) computed server-side and returned on every `pm_tasks` read. **Atomicity:** single `UPDATE projects SET task_seq = task_seq + 1 WHERE id=$1 RETURNING task_seq` inside the same transaction as the task INSERT — the row lock serializes concurrent allocators; proven with 30 genuinely concurrent live HTTP POSTs against the running `:3004` container (`Promise.all`/backgrounded curl, not sequential) yielding seq `{1..30}` with zero duplicates. **Two migrations, not one — `0050` shipped a real defect, corrected by `0051` the same day:** `0050`'s backfill DO block ran as `platform_owner` (no `BYPASSRLS`, per the 2026-07-15 DB-topology role split) against `projects`/`pm_tasks`' FORCE ROW LEVEL SECURITY with no `app.current_tenant_ids` GUC set — RLS silently filtered every row to zero, so the backfill inserted nothing while the DDL half still committed and the ledger recorded "applied" with no error. Caught by this ticket's own live-DB verification (not by the test suite, which runs migrations as an unrestricted superuser and never exercises this path). `0051` reruns the identical backfill logic wrapped per-tenant (`set_config('app.current_tenant_ids', <company id>, true)` before each tenant's rows), verified idempotent by direct re-execution against `platform_owner` bypassing the ledger three times running (zero changes after the first). Cross-tenant isolation verified live: two different tenants derived the identical literal short_code text with zero collision. `tsc` + full `platform-nest` suite (106 files/1213 tests, 3 pre-existing failures unrelated — `search-notifications.test.ts` `REDIS_URL not set`, SEO/search-owned) and full `platform-ui` suite (67/67, `tsc` + `next build` clean) both green. |
| 2026-07-30 | `reports` + `report-renderer` **registered at `0.0.0` PLANNED — design only, no code.** New cross-cutting program: [`../blueprints/tracker-reporting-foundation.md`](../blueprints/tracker-reporting-foundation.md) — a multi-grain (person → project → department → company) reporting + appraisal layer over the **existing** PM tracker, at day/week/month periods, for management presentation and appraisal. **Deliberately not a new tracker:** the reuse audit found the substrate mostly already present — `work_activity`/`work_activity_links` (`0030`) is already the 4-grain evidence fabric, `metric_definitions`/`rollup_metrics` is already a governed metric registry with `ratio_of_sums`, `pm_progress_snapshots` (`0040`) already does nightly project-grain snapshots. **Three verified substrate blockers gate everything and are solved in P0:** (1) `pm_tasks.assignee` is a single unindexed JSONB blob with no multi-assignee — and a dept-assigned task has no person at all — so person-grain SQL is not trustworthy → relational `pm_task_assignees` with JSONB backfill + dual-write; (2) department resolution lives in the **frontend** (`platform-ui/src/lib/departments.ts`) off the org blob and is **not time-aware**, so a dept transfer would retroactively rewrite history → server-side resolution + as-of-date `org_unit_memberships`; (3) the estate has no chart lib, no XLSX and no PDF anywhere (only a hand-rolled SVG sparkline and a client-side CSV blob). Locked owner decisions: owner-takes-all attribution + listed contributors (company totals never double-count), **mandatory** per-person EOD check-ins (compliance measured against the HR working calendar so leave is not a false negative), manager-weighted blended appraisals with mandatory commentary + append-only acknowledgement, and server-side PDF now via a Playwright sidecar. Architecture invariants: one atomic `person × project × day` grain with additive rollups and numerator/denominator ratios; one typed `ReportDocument` feeding viewer + exporters + AI narrative + MCP tools; sealed period-close snapshots for management/appraisal vs live recompute for ops. Migrations `0050`–`0055` (**not 0048** — `0048`/`0049` were consumed by search/meeting work while the brief was being drafted; re-verify at TR-01). 30 `TR-*` tickets, P0=5 · P1=3 · P2=4 · P3=6 · P4=4 · P5=4 · P6=4, 12 QA-gated, 3 tagged Opus with in-doc justification. **Verdict recorded:** reporting NEEDS the never-built P1-05 pm→`work_activity` outbox consumer (TR-05), so person-grain completion history starts at TR-05 go-live and the first sealed month is the first appraisal-grade month. Five open questions await owner ratification (see design §13). |
| 2026-07-30 | `webdev` **WD-07 — WD-04's missing frontend + capture UX polish + docs truth (7 of 8 Phase-1 tickets landed).** Built the browser-upload half of WD-04's AC (backend was curl-only verified): `AudioUploadForm` on `/meetings/[id]` (poll-until-terminal via new `GET /api/meetings/:id/status`, mirrors `WhatsAppConnect.tsx`'s pattern) + a combined register-and-upload path in `RecordControls` for the no-existing-recording case; surfaces `transcribing` progress and a `failed`→retry affordance; DEMO_MODE equivalent (`demoUploadAudio`/`demoRetryAudio`, filename-triggered failure simulation) with 7 new unit tests. Verified client/project context end-to-end from the UI: `RecordControls` takes optional `clientId`/`projectId` (wired into the project workspace's new "Meetings" card and the client detail page); the dispatcher's client-context drop (WD-01 finding F-1) was already fixed by another agent — this ticket verified the chain, not re-fixed it. Added run-status chips on `/meetings` (linked pipeline run's own status) and a source-meeting deep link on PRD Studio. Reconciled `FRONTEND-BFF-CONTRACT.md` §8 — the meetings/pipeline/portal rows were still flagged "no UI consumer yet", which had been false since WD-02/WD-04 landed. Registered `webdev` `0.7.0 IN PROGRESS` in `MODULES.md` (was unregistered — the design doc's "register on approval" instruction had never been carried out). `tsc` + `next build` clean, 66 test files / 645 tests green. **Known defect surfaced, not fixed (queued WD-08):** the ingest proxy's `N8N_BRIDGE_TIMEOUT_MS` (5000ms default) is shorter than real dispatcher latency (15–23s), so ingest reports `dispatcher_unreachable` even though the run completes server-side — the UI already degrades honestly here (no false-success claim). |
| 2026-07-29 | `search-marketing` **P1 feature-complete — M2 reached PENDING GATES.** SM-08 (audit ingest, idempotency enforced by a `UNIQUE(tenant_id, property_id, kind, report_hash)` + `ON CONFLICT DO NOTHING`, not just in code), SM-10 (AI briefs/triage/report drafts, ≤1 gateway call per request with all network I/O outside any transaction), SM-12 (Site Audit + Keywords tabs now real surfaces; volume renders three distinct states so "switched off" is distinguishable from "no data"), SM-13 (9 event types → deep-linked notifications, dedupe + cross-tenant isolation tested) and SM-29 (editable scope grid) all AC-discharged. Verified: platform-nest **83 files / 821 tests**, platform-ui **577/577**, `tsc` + `lint:withtenants` + `next build` all clean. **Recurring bug class documented (tracker §4i): three silent frontend-first drift bugs in one day** — the console read fields the backend never sent (`limit` vs `maxKeywords`, a bare-vs-wrapped scope envelope, `tool_scope` missing from the LIST SELECT), each rendering a confident wrong answer while nothing threw; typecheck cannot catch it and demo fixtures hide it. Also fixed a real hydration divergence mis-reported as cosmetic (`toLocaleString` depends on runtime ICU data). ⚠️ **Five tickets sit AC-discharged but UNGATED** (SM-08/10/12/13/29) — the largest current risk in the module, given today's gates caught a money-path fail-open, two SSRF defects, a permanently-broken route and two fabricated doc citations. |
| 2026-07-29 | `search-marketing` **⚡ P1 gate CLEARED — SM-07 + SM-09 LANDED.** Final verified state: platform-nest **79 files / 785 tests**, `tsc` + `lint:withtenants` clean, `search-crawl-go` build/vet/test green. **The mandatory SSRF gate earned its name:** QA attacked the guard past its original 12 cases and two got through — (1) `isDeniedIP` missed the deprecated IPv4-**compatible** IPv6 form (`::7f00:1` = 127.0.0.1; `To4()` only unwraps the *mapped* `::ffff:` form, so every private/CGNAT branch skipped it and the classifier called it public — low/theoretical since modern kernels don't route it, but fixed regardless); (2) a **reachable** rate-limiter key skew — the allowlist stripped the FQDN trailing dot while `RoundTrip` only lowercased, so `site.example` and `site.example.` were one host to the allowlist but two budgets to the pacing layer, defeatable via same-host redirects. Both fixed, the second at its cause: one shared `normalizeHost()` now serves every host-keyed layer. **Cerbos decision: ACCEPT `update` for `/embed` + `/cluster`** — the architect overturned the concern with repo evidence (`resource_search_keyword.yaml` already grants `research`, a real-dollar paid pull, at the same baseline tier; design §07 types clustering as "AI draft | low"; embed/cluster never enter the SM-04 metered path). **SM-04 carry-overs applied:** 30s in-process TTL cache on `sumGlobalMonthToDate`, its read-only/aggregate-only invariant now **enforced by a SQL-shape test** rather than a comment, and `recordBlocked` guarded so a failing audit write can't mask `GlobalCeilingUnavailableError`. **Ticketed rather than silently accepted:** SM-32 (no cap on keyword-set size — one sequential gateway call per keyword inside a single held-open transaction) and a `parseKeywordImport` defect that corrupts commas inside quoted CSV fields. |
| 2026-07-28 | `search-marketing` **P1 begun: SM-09 + SM-07 AC discharged** (both awaiting their ⚡ gates). **SM-09** — keyword import (CSV/paste), `/embed` embeddings, deterministic dual-mode clustering, Hermes intent labels; no migration needed (0034 already had the columns); gateway is the asserted sole AI egress path; 1k-keyword determinism proven twice (pure-function scale test + full HTTP→DB integration), dual vector mode proven by an array-vs-pgvector-literal parity test since pgvector is absent. ⚠️ Flagged for architect: `/embed` and `/cluster` are gated under the existing Cerbos **`update`** action (no dedicated action exists), so keyword-edit rights also confer gateway-compute spend — may warrant new actions. **SM-07** — new standalone Go project `search-crawl-go/` + a `search-crawl` compose job. The egress guard enforces at `DialContext` and dials the **literal validated IP**, closing the resolve-then-connect race; redirect SSRF is covered by construction; rate limiting sits at `RoundTrip` so keep-alive can't dodge it; JSONL audit on every decision. 27 Go tests cover every required bypass class (DNS-to-private, redirect-to-private, IP-literal, IPv4-mapped IPv6, metadata IP, multi-A-record, DNS-failure-fails-closed); verified end-to-end in Docker incl. a real DNS rebind. SEONaut/open-seo-crawler/Unlighthouse runners **deliberately deferred** — one honest crawler proves the guard. **SM-31 (harness) RESOLVED:** per-file DB isolation replaced a shared destructively-reset database, so the full suite is trustworthy in one invocation for the first time — **78 files / 772 tests green, verified independently**, `tsc` + `lint:withtenants` clean. |
| 2026-07-28 | `search-marketing` **SM-11 console AC discharged — the SEO department now has a UI** (awaiting its own ⚡ gate). Pulled forward out of design order at the owner's call, since the department had no visible surface; legitimate because SM-11's only hard dep is SM-02. `platform-ui/src/lib/searchMarketing.ts` (typed BFF client — deliberately NOT `lib/search.ts`, which is unrelated global search) + the `seo` toolkit as the first **three**-craft-group console (Accounts / Optimize / Campaigns, D-10) + 12 routes. Engagements list + engagement detail render REAL landed data incl. the metered-tools table that explains why a paid pull was refused; the 10 capabilities whose backends are unbuilt render `BackendPending` naming their cost tier, missing endpoint and owning ticket rather than an empty table. `tsc` clean · UI suite **537/537** · `next build` green with all 12 routes. Two pre-existing toolkit tests that asserted SEO was unbuilt now assert the new spine (generic-fallback guard repointed at SMM). **Not done, deliberately:** the ticket's Connections additions — GSC/GA4/Ads need SM-25's OAuth work, which is externally gated. Contract documented in `FRONTEND-BFF-CONTRACT.md` §14. |
| 2026-07-28 | `search-marketing` **⚡ P0 gate CLEARED — SM-04 + SM-05 + SM-06 declared LANDED; M1 reached.** 126/126 across the six search suites on live PG + Cerbos (one file at a time, DB reset between files — see SM-31); `tsc` + `lint:withtenants` clean. **The gate found and fixed a fail-OPEN on the money path:** `dispatchProviderOp` degraded `globalMtd` to 0 when `sumGlobalMonthToDate()` threw, and a $0 month-to-date can never breach — so any error silently disabled the platform-wide ceiling, which on the default config (`globalMonthlyCapUsd` $150 always set, `tenantMonthlyCapUsd` null and skipped) is the ONLY platform-wide tier. Now fails closed via a new `GlobalCeilingUnavailableError` + a cost-0 `failed` audit row, pinned by a regression test. Architect decision: the `lint:withtenants` allowlist entry for `ledger.ts` `sumGlobalMonthToDate` is **RATIFIED** (aggregate-only/read-only; `SECURITY DEFINER` rejected because it would hide the cross-tenant read from the linter). **New ticket SM-31** (repo-wide, not search): the vitest harness destructively resets a test DB shared by all 74 suites, so multi-file runs fail nondeterministically — every failure is a schema-availability artifact, never a behavioural assertion; the full-repo `639/1` baseline is not reproducible until it lands. |
| 2026-07-27 | `search-marketing` **SM-03 declared** after verification (60/60 across the four search suites on live PG + Cerbos); status-doc drift reconciled (MODULES.md section said `0.0.0 PLANNED` while the registry said `0.1.0 IN PROGRESS`); execution tracker added (`blueprints/seo-sem-execution-tracker.md`). SM-04 confirmed half-built and now the critical path. |
| 2026-07-24 | **D1: WhatsApp + Agent runtime verified and documented** (`erp-whatsapp-and-agent-runtime-e2e.md`). wa-chat-bot 0.8.0 (session-lifecycle admin plane + writable group registry), platform-nest 0.6.0 (bot+agent proxies), platform-ui 0.6.0 (Connect-WhatsApp + Group Registry + agents-live surfaces), ai-agents 0.4.0 → PROTOTYPED (agent-runner service + goal/run store + queue), ai-gateway-go 0.11.0 (provider timeout + 429/RateLimitError breaker + error taxonomy), infra 0.5.0 (agent-runner + bot writable volumes + .env updates). Agent runtime DEV-VERIFIED end-to-end (pipeline+gateway+D13 forced_read_only persisted); bot session e2e (start→SCAN_QR_CODE→QR). UI-through path PROTOTYPED (not yet deployed — pending search-marketing build blocker). |
| 2026-07-23 | **Baseline versions assigned** to all modules for tracking-forward; this registry + changelog created. |
| 2026-07-23 | `creative` registered `PROTOTYPED` (Image Studio + `creative_assets` already in dev) with a v1.0 expansion design; new `render-gateway-go` added `PLANNED`. Foundation + design + PDF authored; 4 owner decisions locked; 27 tickets CR-00–CR-26. |
| 2026-07-23 | `social-media` added as `PLANNED` (foundation + v1.0 design; Postiz AGPL-contained; 3 decisions locked — scope, publisher, drop Chatwoot). |
| 2026-07-23 | `search-marketing` added as `PLANNED` (foundation + v1.1 design ratified; 4 owner decisions locked). |
| 2026-07-23 | `webdesk` added as `PLANNED` (blueprint approved). |
| 2026-07-15 | `observability` + `automation` reached DEV-VERIFIED (e2e on live Docker stack). |
| 2026-07-14 | `sync-engine-go` first prototyped; Node `ai-gateway` retired in favor of `ai-gateway-go`. |

> Older "Built/Complete" wording in `README.md` / `CLAUDE.md` predates this vocabulary — read it as
> `PROTOTYPED` / `DEV-VERIFIED` unless a production deploy is explicitly stated.

---

## platform-nest
### [0.6.3] — 2026-07-27 · PROTOTYPED (systems-console write levers)
- **NEW `PUT` + `DELETE /api/admin/gateway/config`** — proxies the gateway's new config-write route.
  The gateway owns validation/bounds/persistence; this layer re-throws its 4xx VERBATIM (400 bounds,
  400 non-writable key, 409 can't-take-effect) so a rejected value explains itself instead of
  collapsing into "gateway unreachable". `editable` on each ConfigField is driven by the gateway's own
  `writableKeys`, so this layer can never offer a save the gateway would refuse — and an older gateway
  yields a read-only page automatically.
- **NEW `POST /api/admin/automation/workflows/:id/activate|deactivate`** — n8n Public API, returning
  n8n's own resulting state. Gated to `isElevated`, deliberately NARROWER than the `isItOrElevated`
  read-only canvas: deactivating silently stops business automation with no other signal.
- **NEW `POST /api/admin/automation/bridge/:entityType/replay`** + `replayBridgeDeadLetters()` — moves
  dead-lettered entries back onto the source stream for redelivery. Re-adds BEFORE deleting, so a
  crash duplicates (which the at-least-once bridge + n8n's envelope-id dedupe already handle) rather
  than dropping. Refuses any stream the bridge isn't configured to watch, so an arbitrary Redis key
  can't be targeted through the route. This is the sanctioned "retry a failed automation": n8n's
  Public API has no execution-retry route, and re-running from the real input beats resuming a
  half-finished run.
- 723 tests green on live PG + Cerbos (+15: 6 admin-systems write cases, 9 new `bridge-health` unit
  tests covering the replay ordering guarantee, NOGROUP-vs-real-error, and fail-soft reads).

### [0.6.2] — 2026-07-27 · PROTOTYPED (systems-console depth: real config projections + 6 new admin reads/writes)
- **Root cause of three thin consoles:** `connectionConfig()` returned only `{url, tokenConfigured}`
  for every system except `bot`, so the Gateway/Hub/Automation "Configuration" cards were a two-row
  descriptor forever — and the Gateway page's "Provider chain" card looked for a config field keyed
  `providers` that nothing ever emitted, so it showed its empty state permanently. `GET
  /api/admin/:system/config` now returns a REAL projection per system (`gatewayConfigFields` /
  `hubConfigFields` / `automationConfigFields`), with the honest connection descriptor **appended,
  not replaced**, and every credential still `kind:"secretPresence"` (presence only).
- **NEW `GET /api/admin/gateway/detail`** — proxies the gateway's new `GET /admin/config`: chain in
  failover ORDER + live breaker state, provider inventory, budget breakdown **incl. per-tenant
  spend**, reliability tuning, security/topology posture.
- **NEW `POST /api/admin/gateway/dr-mode`** (`isElevated`) — WS9 D15 failover lever, proxied so the
  gateway token never reaches the browser. It raises the daily cap, so it is a platform-admin action.
- **`GET /api/admin/gateway/egress-audit` extended** — `?limit&provider&capability&decision` and the
  block taxonomy carried as structured `{capability, ok, blocked, redactions, latencyMs}` instead of
  being flattened into the free-text `detail`. Legacy fields retained.
- **NEW `GET /api/admin/hub/detail` + `GET /api/admin/hub/audit`** — the hub's posture block and its
  §8 tool-call decision trail. The audit had been written to JSONL and was readable nowhere.
- **NEW `GET /api/admin/automation/executions`** — n8n run history with `workflowId` resolved to a
  name + `durationMs`. The executions list was already being fetched and then discarded except for
  one "last run" cell per workflow.
- **NEW `GET /api/admin/automation/bridge`** + `src/events/bridge-health.ts` — event→n8n bridge
  delivery health (per-stream backlog, dead-letters, oldest-pending age, bridged event allow-list).
  A stalled bridge silently stops every event-triggered workflow while the workflow list still reads
  "active"; nothing in the console could show that. Fail-soft: Redis unreachable / no consumer group
  degrades to a per-stream note, never an exception.
- 708 tests green on live PG + Cerbos (admin-systems suite 17, +9 new cases).

### [0.6.1] — 2026-07-27 · PROTOTYPED (bot-proxy honesty fixes)
- **`botCall` swallowed 404s:** only a 400 was surfaced verbatim; every other non-OK status became
  `502 bot admin unreachable`. So the bot correctly answering `404 {"error":"unknown chat (no stored
  messages)"}` made the Chats tab report the bot as DOWN. 404 is now surfaced as a `NotFoundException`
  carrying the bot's own message. Found because the assertion covering it had never actually executed —
  see the stub fix below.
- **Status probe treated "unknown" as a real session:** `admin-systems.controller.ts` did
  `typeof h.session === "string" ? h.session : undefined`, and the bot's `/health` placeholder for
  "no session event observed yet" is the literal string `"unknown"` — truthy, so the fallback to the
  authoritative `/admin/session/status` never fired and the ERP pill showed UNKNOWN on a WORKING session.
  Now `"unknown"` is treated as missing.
- **Test-harness fix (`bot-admin.test.ts`):** the bot stub matched the thread route with
  `url.endsWith("/messages")`, which is false once `?limit=2` is appended — the request silently fell
  through to the chats-LIST branch, so the thread assertions were validating the wrong response and every
  assertion after the first was dead. Stub now matches on the path. New coverage: `/health` reporting
  `session:"unknown"` must still resolve to WORKING via the fallback.

### [0.6.0] — 2026-07-24 · PROTOTYPED (bot-admin + agents intelligence proxies)
- **Workstream A+B admin proxy layer (design §2.4 + §3.3):** NEW `admin/bot-admin.controller.ts` (`@Controller("api/admin/bot")`), isElevated-gated,
  proxies wa-chat-bot's `/admin/*` routes with fail-soft (bot unreachable → 502, unconfigured → 404). Routes: POST session/start, GET session/status,
  GET session/qr (Cache-Control: no-store), POST session/{stop,logout,restart}, GET/PUT groups (validates `{groups:[…]}` before forwarding),
  PUT config (`{key,value}` allow-list `{postToGroups,managementGroupId}` → 400 otherwise). Extracted `isElevated` helper to shared `admin/elevated.ts`.
- **Real agent-runner proxy (vs. old hardcoded stubs):** `intelligence.controller.ts` now makes live HTTP calls to agent-runner service. Config: `services.agents
  = {url: AGENTS_URL, token: AGENT_RUNNER_TOKEN}`. Routes: `GET /api/:t/agents/goals` (tenant-filtered, `authorize(activity read)`), `POST /api/:t/agents/goals`
  (isElevated, idempotently upserts platform self-link `identity_links(provider='platform', external_id=userId)`, calls runner `POST /goals` with envelope),
  `GET /api/:t/agents/goals/:goalId` (detail + blackboard + run summaries, tenant-pinned), `GET /api/:t/agents/runs/:runId` (full run + steps, isElevated only —
  transcript can carry user-triggered tool output). `probeStatus("agents")` now hits `/health` real-time; `connectionConfig("agents")` no longer says "CLI/library".
- **Not deployed yet:** nest endpoints verified against running agent-runner (pipeline+gateway working end-to-end per design spec §3.2).

### [0.5.0] — 2026-07-23 · PROTOTYPED
- Baseline. Core schema (FORCE RLS), ModuleContract + custom fields, Cerbos RBAC, OBO/identity links,
  rollups, agency vertical, event backbone (outbox→Redis Streams). ~92 dev tests.
- **Unreleased / next:** identity writes, org-structure endpoints.

## platform-ui
### [0.6.5] — 2026-07-27 · PROTOTYPED (console write controls)
- **Gateway config is editable** where the gateway says it is: new `OverridableConfigField` renders a
  save per writable key AND the one fact a plain form can't express — whether the value is a console
  override shadowing the env — with a **Revert to env** action. Without that, an operator who fixed
  the env and redeployed would see the old value and conclude the deploy failed. Read-only keys
  (credentials, egress allowlist, TLS mode, topology) stay in the description list, and the card shows
  a "read-only" badge when the running gateway exposes no write route at all.
- **Workflow activate/deactivate** in the Automation workflows table (elevated only), driven off the
  ID-bearing `/automation/workflows` list rather than the status probe's name-only rows — which never
  carried an id. Deactivation is confirm-gated because it stops real automation. When the ID list is
  unavailable (no n8n API key) the table still renders from the probe rows and says why the controls
  are missing.
- **Dead-letter replay** per bridge stream, offered only where something is actually parked, with a
  confirm naming the count.
- **NEW** `components/systems/ActionButton.tsx` (single-lever server action + pending/result feedback
  + optional confirm), `OverridableConfigField.tsx`; `lib/admin.ts` gained `setGatewayConfig`,
  `revertGatewayConfig`, `setWorkflowActive`, `replayBridgeStream` over a shared `writeCall` helper
  that surfaces the service's own 4xx message verbatim and maps 404/405 to "not available".
- 462 unit tests green (+7); `tsc` clean; `next build` green. Demo fixtures cover every new write.

### [0.6.4] — 2026-07-27 · PROTOTYPED (Gateway / MCP Hub / Automation consoles rebuilt with real content)
- The three pages were rendering everything the contract gave them; the contract was the problem
  (see platform-nest 0.6.2). With the backend widened, all three were rebuilt around what an operator
  actually acts on.
- **AI Gateway** — budget first (calls today vs effective cap, **per-tenant spend table**), a DR-burst
  card that states the consequence and separates declare/resolve instead of being an ambiguous toggle,
  one `ChainTable` per capability showing failover ORDER + breaker state with a plain-language reason
  per provider (and calling out providers configured in the env but never built by the gateway), a
  provider inventory with credential presence only, a DLP/egress-posture card, and an egress audit
  that is filterable by decision (incl. specific block reasons) and capability. Filters are `<Link>`s,
  so the page stays a server component and a filtered view is shareable.
- **MCP Hub** — policy card leading with **which engine decided** (Cerbos vs in-code fallback), limits
  & transport, tool registry with source attribution + filter, the **decision audit** (previously
  unreadable), the per-workflow automation scope matrix, and the **Resources + Prompts** primitives
  the page had never shown.
- **Automation** — at-a-glance strip, workflows, **execution history**, **event-bridge health** with a
  dead-letter warning band, and the **suspended-writes approval queue** (tenant-scoped, and labeled as
  such). Links to the existing read-only n8n canvas rather than duplicating it.
- **NEW** `components/systems/ChainTable.tsx` (+5 tests), `components/systems/DrModeCard.tsx`;
  `lib/admin.ts` gained the detail/audit/executions/bridge readers, a filterable `getEgressAudit`, and
  `setDrMode` (+11 tests). Demo fixtures extended so all of it is browsable with `DEMO_MODE=1`.
- 455 unit tests green; `tsc` clean; `next build` green.

### [0.6.3] — 2026-07-27 · PROTOTYPED (bot page correctness)
- **Data loss — `optIn` dropped on save:** `BotGroupConfig` had no `optIn`, and the bot's `PUT /admin/groups`
  is a FULL REPLACE that normalizes `optIn: Boolean(g.optIn)`. Any save from the ERP therefore turned
  per-group digest post-back OFF for every group. Added the "Digest back" checkbox column; `optIn` now
  round-trips (covered by the payload-shape test).
- **Unwarned mode switch:** the registry is a mode switch, not a list — while it is empty the bot ingests
  every group it sees; the first saved entry makes it ingest ONLY listed groups. The Groups tab now warns
  before that first save and names how many discovered groups would be dropped.
- **Stuck "Loading…":** a failed fetch leaves the state null, so the Chats thread and both Logs panels
  claimed to be loading forever while only a small toast showed the error. They now render an explicit
  "couldn't be loaded" state.

### [0.6.2] — 2026-07-27 · PROTOTYPED (bot Logs empty state)
- **Action audit:** the empty state said only "No audited actions yet.", which reads as a broken panel. It
  now states what populates it (member add/remove, admin promote, group rename — including denied and
  step-up attempts) and what doesn't (ordinary messages, digests). No behavior change; the audit was
  correctly empty.

### [0.6.1] — 2026-07-27 · PROTOTYPED (discovered-group rows)
- `GroupRegistry` renders the JID when a discovered group's subject is unresolved (was a blank row next to
  an Add button), and Add seeds the registry row with the JID rather than an empty name. See wa-chat-bot
  `0.8.1` for the bot-side cause.

### [0.6.0] — 2026-07-24 · PROTOTYPED (Connect-WhatsApp + Group Registry + agents-live surfaces)
- **Workstream A WhatsApp self-service UI (design §2.5, not yet deployed):** PROTOTYPED `src/components/systems/WhatsAppConnect.tsx` (client-side).
  Status pill (status + engine + paired number when WORKING), buttons Connect/Show-QR/Restart/Stop/Logout (confirm on logout). QR `<img>` from data URL.
  Poll status+qr every 3s while panel open and status ∈ {STARTING, SCAN_QR_CODE}; stop on WORKING (success) or FAILED (error + hint). Show `lastEvent` (reconnect/ban trail).
  Mutations = server actions in `systems/bot/actions.ts`; poll read via route handler `src/app/api/admin/bot/session/route.ts` (GET, no-store, server-side platformFetch).
- **Group Registry UI:** PROTOTYPED `src/components/systems/GroupRegistry.tsx` (client-side). Monitored-groups table (name/category/optIn/remove), discovered list
  with one-click add, management-group radio, single Save → PUT groups. Server action `updateBotGroups`. `updateBotConfig` action kept (degrades if backend 404).
  StatusCard now renders `detail.session` as a badge.
- **Workstream B agents-live surfaces (design §3.4):** agents UI extended with trigger card (goal textarea + agent select from status probe's `agents` list, elevated-only).
  Goals table now links to detail; status card consumes real `/health` probe. NEW `/agents/goals/[goalId]` page: status/budget/fan-out header, blackboard entries
  (specialist/task/status), run summaries linking to transcripts, `approval_id` deep-link to approvals inbox when suspended. NEW `/agents/runs/[runId]` or expandable
  detail panel: step list as text chips (model/tool kind + detail only, never HTML/markdown, never raw JSON). Poll every 4s while goal queued|running, stop otherwise.
- **NOT deployed yet:** UI-through path PROTOTYPED; backend for `/systems/bot` and `/agents` surfaces now answering (but not yet deployed container).

### [0.5.0] — 2026-07-23 · PROTOTYPED
- Baseline. ERP UI Plans 1–5 + People 360 + org builder + dept consoles + PM/AI-tracker + IT console;
  OIDC PKCE; `DEMO_MODE`; Playwright e2e.
- **Unreleased / next:** deploy once backend admin API is live.

## ai-gateway-go
### [0.13.0] — 2026-07-27 · PROTOTYPED (runtime config writes + a real chain lock)
- **NEW bearer-gated `PUT /admin/config`** (one key per call) **+ `DELETE /admin/config?key=`**
  (revert to env). Writable: the two budget caps, breaker threshold/cooldown, provider timeout, the
  DLP-classifier toggle, and each capability's chain ORDER. Every write is validated + bounds-checked,
  applied to the LIVE objects, and persisted — in that order, so a persist failure is reported rather
  than leaving the running state ahead of the file.
- **NOT writable, deliberately:** provider credentials, egress allowlist, TLS mode, topology. Those
  either can't take effect at runtime (credentials are captured in provider objects at boot) or would
  let a console session widen the gateway's own security boundary. `GET /admin/config` advertises
  `writableKeys` so the console renders exactly what it can change — and nothing more.
- **NEW `internal/adminconfig`** — the override store: pointer-per-key `Overrides` (nil = use env),
  an explicit `WritableKeys` allowlist, numeric sanity bounds, chain validation against the known
  provider set (an unknown name would otherwise silently SHORTEN the chain, since `buildProviderList`
  skips names it can't resolve), and an atomic temp+rename persist. `Apply()` folds overrides onto the
  env in `main` BEFORE anything is built, so a persisted override is in force from the first request.
- **Chain is now properly locked.** `Chain` had no mutex while `Run` mutated its `breakers` map from
  every concurrent request — a pre-existing latent data race that runtime reordering would have made
  much worse. Added `sync.Mutex` over all mutable state, with `Run` snapshotting the provider list so
  the lock is never held across a provider call. `SetProviders` keeps breaker state for retained
  providers (reordering is not a reason to forget a provider is rate-limited) and drops it for removed
  ones. New concurrency test drives Run + SetProviders + Report together.
- **The DLP-classifier toggle is now real:** `main` always constructs the classifier (building it
  makes no calls) and a runtime flag decides whether it RUNS. Previously a nil classifier meant the
  toggle could never be switched on without a restart; enabling it in a process that has none is a
  409 with an actionable message rather than a silent no-op.
- `GET /admin/config` reports the LIVE chain order plus `envOrder`, and the live classifier state --
  an override must never be mistakable for the env value.
- 13 new server tests (auth, allowlist refusal, bounds/type validation, live+persisted application,
  lowered-cap-degrades-immediately, reorder echo/rejection/breaker-preservation, revert, 409, and
  writes-absent-when-unwired). `go vet` + full `go test ./...` green.

### [0.12.0] — 2026-07-27 · PROTOTYPED (admin config surface: chain order, breaker internals, per-tenant budget)
- **NEW bearer-gated `GET /admin/config`** — the operational state the ERP console needs and could
  not previously see: per-capability chain **in failover order**, provider inventory, budget
  breakdown, reliability tuning, and security/topology posture. Provider credentials are NEVER
  returned — only `keyConfigured` presence (the gateway is the only component holding provider keys).
- **NEW `chain.Report()` / `chain.Settings()`** — `State()` returns a map, which loses the failover
  order that is the entire contract of a chain. `Report()` reports position + state + breaker
  internals (`consecutiveFails`, `rateLimited`, `openUntil`) so a console can explain WHY a provider
  is being skipped, and distinguish a rate-limit breaker (wait it out) from a failure breaker (fix it).
- **NEW `budget.Breakdown()`** — the same numbers `State()` reports plus the **per-tenant spend map**
  and the DR-burst window, so "who is burning the cap" is answerable. Stale-day counters still read
  as zero rather than being misattributed to today.
- 2 new server tests (auth gate + no-secret-leak + ordered chain; per-tenant attribution). `go vet`,
  `go build`, full `go test ./...` green on go1.26.5.

### [0.11.0] — 2026-07-24 · PROTOTYPED (provider timeout + 429/RateLimitError breaker + error taxonomy)
- **Provider timeouts (§3.5 Workstream B reliability):** NEW `PROVIDER_TIMEOUT_MS` env (default 60000). Every capability handler (Complete/Media/Embed) wraps
  provider calls with `context.WithTimeout(r.Context(), timeout)` — hung provider → clean failover + client disconnect cancels upstream (no hanging goroutines).
  Stream path (`/complete/stream`) handled separately (keeps its own flush loop, retains timeout safety).
- **429 taxonomy & breaker:** providers return typed `providers.RateLimitError{RetryAfter}` on HTTP 429. Chain.Run() parses Retry-After seconds, caps at 5m,
  opens provider's circuit breaker immediately for min(RetryAfter, cap) — one 429 stops hammering for exactly the advertised window without poisoning the
  "dying provider" consecutive-fail signal. No more treating 429 as a generic failure on the failover path.
- **Error taxonomy in audit + 502 body:** attempted-provider errors tagged `timeout|rate_limit|provider_error` in egress audit + 502 response (ERP console can
  distinguish causes). `Blocked: "rate_limit"` when all providers in chain are rate-limited (not a generic error). Audit trail now surfaceable for SLA/alerting.
- **Per-tenant call cap:** already EXISTS (`budget.perTenantCap` via x-tenant-id header) — runner NOW sends `x-tenant-id` on `/complete` calls (1-line change in
  gateway init) so agent load is tenant-attributed for daily cap enforcement.
- **Not yet live:** WhatsApp transport (WAHA up but no paired session).

### [0.10.0] — 2026-07-24 · DEV-VERIFIED (openai provider path, full stack)
- New `openai` provider (`internal/providers/openai.go`): OpenAI-compatible `/v1/chat/completions`
  with Bearer auth, fronting any compatible endpoint (Ollama Cloud, OpenRouter, vLLM …). Registered in
  the chain, excluded in `site` topology like other cloud-key providers.
- **Vision media:** `Media()` handles `image/*` via a configurable vision model (`OPENAI_VISION_MODEL`,
  default `qwen3.5:397b`) using the OpenAI `image_url` content part; audio/PDF/video decline → fail over
  to whisper/gemini. Embeddings decline (Ollama Cloud has no `/v1/embeddings`).
- Config: `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` (default `deepseek-v4-flash`) /
  `OPENAI_VISION_MODEL` / `OPENAI_MAX_TOKENS`. Compose `LLM_CHAIN` defaults `openai,ollama,gemini,claude`,
  `MEDIA_CHAIN` defaults `openai,whisper,gemini`; `ollama.com` added to `EGRESS_ALLOWLIST`. 11 provider
  tests; `go vet` + full suite green.
- **e2e (full local stack):** rebuilt+restarted `gaiada-ai-gateway-1`; verified from inside the running
  containers — bot→`ai-gateway:3002`/complete and mcp-hub→gateway both returned `{"provider":"openai",…}`;
  gateway egress-audit shows every LLM call `provider:openai, ok:true`. `/health` reports `openai:ok` on
  both llm + media chains.
- **Trial:** shared Ollama Cloud key wired into dev `.env` as the stack brain (bot, MCP `llm.*`, n8n, WS8
  agents inherit it). Shared + weekly-rate-limited — dev/test only, not a prod dependency.
  **Capability:** NO image/video *generation* (that's the GPU render-gateway's job) and NO embeddings on
  Ollama Cloud; image *understanding* works (qwen3.5). `glm-5.2`/`kimi-k2.7-code` are reasoning models
  that reply empty unless `OPENAI_MAX_TOKENS` is large — `deepseek-v4-flash` returns clean content.
- **Not yet live:** WhatsApp transport (WAHA up but no paired session — needs a QR scan).

### [0.9.0] — 2026-07-23 · PROTOTYPED
- Baseline. THE gateway (`:3002`), provider chain + failover + DLP + cost cap + egress audit + mTLS +
  site/central + DR-burst. go build/vet/test green.
- **Known risk:** docker build unverified. **Next:** verify container build, OpenBao creds, media DLP.

## mcp-hub
### [0.9.0] — 2026-07-27 · PROTOTYPED (readable decision audit + posture surface + tool attribution)
- **NEW bearer-gated `GET /audit`** (`readRecentAudit` in `audit.ts`) — the READ side of the §8
  tool-call trail, newest-first. Every allow/deny decision with its reason was being appended to
  JSONL and exposed by no route, so the hub's accountability record existed on disk and nowhere else
  (while the console's own subtitle advertised it). A missing file reads as "no activity yet"; a torn
  last line is skipped rather than blanking the whole trail.
- **NEW bearer-gated `GET /admin/info`** — the posture the console needs: **which engine actually
  decided** (Cerbos vs the in-code fail-closed fallback — the most load-bearing fact about the hub),
  deny-by-default, assurance ranks, the D14 automation write gate stated in words, revocation
  settings, rate limits (per principal AND the 10× per-service-token ceiling), mTLS mode + peer
  allowlist + topology, tool counts by source, **Resources and Prompts** (the two primitives the
  console never showed at all), and the per-workflow `AUTOMATION_ALLOWLIST` least-privilege matrix.
  Presence flags only — no secrets, mirroring the gateway's rule.
- **Tool source attribution** — `registry.withSource()` stamps each registration GROUP so a tool
  carries where it came from (`core`/`platform-read`/`platform-write`/`pipeline`/`delivery`/`module`)
  without every call site having to agree on a label. Surfaced on the open `/tools` catalog too.
- 81 tests green (+22 from the 59 baseline; 4 new cases here).

### [0.8.0] — 2026-07-23 · PROTOTYPED
- Baseline. MCP server fronting platform-nest; OBO, Cerbos policy, Tools/Resources/Prompts, rate limit,
  revocation, mTLS, site/central. 59 dev tests.
- **Next:** OpenBao creds, Redis-backed multi-instance rate limiting.

## sync-engine-go
### [0.7.0] — 2026-07-23 · PROTOTYPED
- Baseline. Central/site reconciliation, HLC, conflict rules, RLS, bootstrap, GC; property-based + chaos
  tests on a 2-Postgres harness. Runs idle (`sync-central`).
- **Next:** activate against a real second site.

## automation (n8n)
### [0.4.0] — 2026-07-23 · DEV-VERIFIED
- Baseline. n8n + MCP templates, scoped accounts, impact gate, event bridge, approvals suspension.
  3 flows verified e2e on the live dev stack (2026-07-15).
- **Next:** more flows; Temporal for durable orchestration.

## observability
### [0.6.0] — 2026-07-23 · DEV-VERIFIED
- Baseline. OTel across all services; opt-in Grafana stack; SLOs; alerting; restore drill. Verified e2e
  on a live Docker stack (2026-07-15).
- **Next:** deploy to a real host; tune SLOs on prod traffic.

## infra
### [0.5.2] — 2026-07-28 · DEV-VERIFIED (platform-nest test harness: per-file database)
- **The suite was untrustworthy, not the code.** Two root causes: (1) `initTestDb()` held a session advisory lock
  released only in `teardownTestDb()`, so a single failed `beforeAll` never released it and every later file blocked
  until `hookTimeout` — one flake cascaded into dozens (19 files, then 57); (2) `initialized` is module-scoped, so
  each vitest worker re-ran `DROP SCHEMA public CASCADE` on first use, landing underneath another worker's
  in-progress migration (`relation "schema_migrations" does not exist`).
- A third cause only visible once the race was fixed: 20+ files reuse literal fixture emails (`admin@a.test`), so
  ANY single-shared-database design collides on `users.email` regardless of timing — an interim global-setup fix
  still failed 16 suites for this reason.
- **Fix:** per-test-file physical database, `pgtest_f_<sha1(testPath)>`, dropped `WITH (FORCE)` and recreated +
  migrated in that file's own `beforeAll`; pools cleaned in `try/catch` so a throwing hook cannot leak connections.
  Locks, drops and unique constraints are all scoped to one file, so overlapping hooks cannot contend. The DB name
  is always the literal prefix plus a hex hash, so `DROP DATABASE` can never resolve to a real database (checked).
- **Verified:** 3 consecutive green full runs by the implementer + 1 independent re-run — 74 files / **734 tests** /
  0 failed / **0 skipped**, ~6m46s. No assertion touched or weakened; no suite skipped. A deliberately injected
  failing `beforeAll` no longer fails unrelated files.
- **Costs / leftovers:** ~7min per full run (migrations replay per file) and ~730MB across 60 reused
  `pgtest_f_*` databases that persist between runs by design (force-dropped and recreated, not accumulating).
  Schema-per-file within one database is the lighter-weight follow-up if runtime becomes a problem. One stray
  `gaiada_platform_test_h31` (7MB) is left from the interim attempt and can be dropped at any time.

### [0.5.1] — 2026-07-27 · PROTOTYPED (local test-infra in the dev override)
- **Why:** several suites could not run on a dev box at all. Cerbos published no ports (every authz
  check fails from the host), the bot's isolated Postgres published no port, and both projects' `.env`
  files pointed at a `localhost:5432/5433` Postgres that doesn't exist here (a native Windows Postgres
  squats :5433). Result: 3 bot tests failing + 7 skipped, and 104 nest tests skipped.
- **`docker-compose.local.yml`** (dev override; the VPS compose stays internal-only) now also publishes
  `cerbos` 3592/3593, `pg-bot` 55434, and adds a **disposable `redis-test`** on 56380. The test Redis is
  deliberately NOT the live one: `n8n-bridge.integration.test.ts` calls `FLUSHALL`, which would wipe the
  running event backbone.
- **`.env` wiring:** `wa-chat-bot` → `DATABASE_URL_TEST` at a dedicated `gaiada_bot_test` database (never
  the live crypto-shred store) and `DATABASE_URL` at the real `gaiada_bot` for host-run dev;
  `platform-nest` → test DB on 55433 plus `CERBOS_URL` and `REDIS_URL_TEST`.
- **Hazard found the hard way:** `docker compose -f docker-compose.vps.yml up -d platform` (VPS file
  alone) **silently unpublishes** `platform:3004`, which the host-run UI depends on — compose recreates
  the container without the override's ports. Always bring the stack up with BOTH files. Noted in
  `CLAUDE.md`.
- **Result:** wa-chat-bot 295/295 (was 285 passing, 3 failing, 7 skipped); platform-nest 700/700
  (was 596 passing, 104 skipped). No product code involved — infra + env only.

### [0.5.0] — 2026-07-24 · PROTOTYPED (agent-runner service + bot writable volumes + .env updates)
- **Workstream A+B compose changes:** NEW `agent-runner` service in `docker-compose.vps.yml` (build: ../../ai-agents, command: ["npx", "tsx", "src/runner/service.ts"],
  port 3006, restart unless-stopped). Env: AGENT_RUNNER_TOKEN, AGENTS_DATABASE_URL (knowledge_app role), MIGRATE_DATABASE_URL (knowledge_owner role),
  GATEWAY_URL/TOKEN, HUB_URL/HUB_SERVICE_TOKEN. Depends on postgres/ai-gateway/mcp-hub.
- **Bot writable group registry:** `wa-chat-bot` service: `GROUPS_FILE=/app/data/groups.yaml` (writable, points to bot-data volume), `GROUPS_SEED_FILE=/app/config/groups.seed.yaml`
  (read-only seed). Volumes: bot-data:/app/data (NEW), ./groups.yaml:/app/config/groups.seed.yaml:ro (updated mount path from was :/app/config/groups.yaml:ro).
  Old groups.yaml file stays as the first-boot seed (boot copy logic if file absent).
- **platform service updates:** AGENTS_URL: http://agent-runner:3006, AGENT_RUNNER_TOKEN env (reuses AGENT_RUNNER_TOKEN secret).
- **`.env.example` updates:** added AGENT_RUNNER_TOKEN secret placeholder; noted that bot groups.yaml is now the first-boot seed only (registry lives in the volume).
- **Not deployed yet:** compose stack verified locally; container builds not verified on a Docker host (same caveat as ai-gateway-go).

### [0.4.0] — 2026-07-23 · PROTOTYPED
- Baseline. VPS Compose stack, Dockerfiles, local CI, backups, supply-chain pipeline (SBOM/cosign/SLSA).
- **Next:** first production deploy; GitOps; K8s/SPIFFE (target-state).

## wa-chat-bot
### [0.9.1] — 2026-07-28 · DEV-VERIFIED (digest delivery target, async run, preview)
- **Scheduled digests were broken and nobody knew.** `schedule-state.ts` ran `CREATE TABLE IF NOT EXISTS` on the
  RUNTIME pool, which under the owner/runtime role split is `bot_app` — no rights on schema public. Every digest,
  cron included, died with `permission denied for schema public` (42501) inside `loadLastRun()` before summarizing
  anything; the empty history was the symptom. Now uses the owner DSN via `MIGRATE_DATABASE_URL` exactly like
  `PgStore.init()`, memoized (a failure is not cached). Confirmed fixed live: the 18:00 SGT cron ran successfully.
- **Delivery target may be a direct chat.** `MGMT_TARGET_RE` accepts `@c.us`/`@lid`/legacy `N-N@g.us`/`tg:` for the
  target only — a MONITORED entry must still be a real group. This enables the lowest-risk setup: deliver the
  digest to the operator's own number instead of posting into any group. Verified live end-to-end
  (`mgmtDelivered: true`, 9 groups, 0 failed).
- **INCIDENT + root fix: setting the target used to stop all ingestion.** `setManagementGroupId` wrote the target
  as a registry row, making `loadGroups()` non-null → registry mode with ZERO monitored groups (the target itself is
  never monitored) → the bot silently stored nothing. Observed live for ~2 minutes on 2026-07-28 before being
  caught and reverted; messages arriving in that window were dropped. The target now lives in its own
  `digest-target.json` (`DIGEST_TARGET_FILE`); precedence is registry `isManagement` row > standalone target >
  `MANAGEMENT_GROUP_ID`. Choosing where a digest is DELIVERED can no longer change what the bot READS. Three tests
  pin it; three older tests that encoded the unsafe "adds a minimal entry" behaviour were rewritten to the new
  contract (documented, not weakened).
- **Async run:** `POST /admin/digests/run/:slot` → 202 `{started,slot,startedAt}`, 409 if that slot is already in
  flight (two concurrent runs would double-post), errors from the detached run recorded in history instead of
  becoming unhandled rejections. The synchronous `/run-digests/:slot` is untouched — n8n's digest-fanout calls it.
- **Preview:** `GET /admin/digests/preview?chatId=&limit=` returns the digest text with no send path in the route
  and nothing persisted. Verified live: history unchanged, zero outbound sends.
- **Legacy group ids:** the chat-id validator rejected `<creator>-<created-at>@g.us`, so that group 400'd on click
  like the `@lid` DMs did. Shapes enumerated against the live store (18 `N@g.us`, 12 `N@lid`, 1 `N-N@g.us`).
- Tests 385 → **408**, `tsc` clean.

### [0.9.0] — 2026-07-28 · DEV-VERIFIED (console depth: ignore list, digests, search, paging)
Built by a 4-agent parallel run against a frozen contract (`docs/superpowers/plans/2026-07-28-wa-bot-console-depth.md`).
- **Ignore list** (`groups.ts`, own persisted `ignored-groups.json`): an ignored group is dropped before storage in
  BOTH trial and registry mode and skipped by digests, while still appearing in the snapshot so it can be un-ignored.
  `groupsSnapshot()` gains `ignored`; `discovered` now excludes ignored entries.
- **Digest history** (`digest-history.ts`, counts-only, last 50) + `GET /admin/digests` with timezone-aware next-run
  times (`next-run.ts`). **Skills catalog** `GET /admin/skills`. **Media health** `GET /admin/media/status`.
- **Search + paging:** `searchMessages` and `getMessagesPage` added to the `Store` interface and implemented for
  FileStore AND PgStore (parameterized ILIKE inside `withTenant`, so RLS still applies); `GET /admin/search`,
  plus `q`/`kind` on the chat list and `beforeTs`/`hasMore` on the thread.
- **`managementGroupId` is now a labelled select** built from registry AND discovered groups, with an explicit None.
  It falls back to free text only when there is genuinely nothing to choose — a select offering just "None" plus the
  current value would remove the ability to type an id, which is strictly worse than the text box.
- **Three defects found during integration, not by the agents:**
  1. `listChats` applied `q`/`kind` AFTER the store's limit, so filters only saw the newest N — `kind=dm&limit=8`
     returned 1 of 12 DMs and searching an older chat returned nothing. A search that silently answers "no results"
     is worse than one that errors. Now filters, then limits.
  2. **`@lid` chat ids were rejected.** The NOWEB/Baileys engine addresses most DMs by linked identity
     (`<digits>@lid`); the validator allowed only `c.us`/`g.us`/`tg:`, so all 12 LID DMs listed fine and 400'd the
     instant they were clicked. The regex was ALSO duplicated in `server.ts` and had drifted — there is now one
     definition (`isValidChatId`), imported.
  3. The kill switch answers `{actionsEnabled}` while its audit read answers `{enabled}` — see platform-ui 0.7.0.
- Tests 296 → **385**, `tsc` clean. Verified live through the ERP's own BFF: skills, media, digest next-run
  (18:00 today / 12:00 tomorrow Asia/Singapore), filters, paging, ignore-list write (reverted after), kill switch
  (restored), and a LID DM thread loading real messages.

### [0.8.3] — 2026-07-27 · DEV-VERIFIED (group names in the Chats tab + digests)
- `groupName()` consulted ONLY the registry and fell back to the raw JID. In trial mode the registry is
  empty, so the ERP's Chats tab listed groups as `1203…@g.us` while the Groups tab (which reads the
  discovery store) showed real names. It now checks registry → discovered subject → JID. Digest headers
  (`schedule.ts`) get the same benefit. Verified live: Chats now lists General, Marketplace, CLASS 7C, etc.

### [0.8.2] — 2026-07-27 · DEV-VERIFIED (session timeline: seeded from WAHA + persistent)
- **Bug:** the ERP Logs tab showed "No session events recorded yet" and the status pill read UNKNOWN, even
  with a healthy WORKING session. Two causes: the transition ring buffer was in-memory only (wiped on every
  bot restart), and it was fed *exclusively* by the `session.status` webhook — which WAHA fires only on a
  CHANGE, so a session that was already WORKING before the bot booted produced no event at all, leaving
  `/health` reporting `session: "unknown"` indefinitely.
- **`session-state.ts`:** timeline persisted atomically (tmp+rename) to `SESSION_EVENTS_FILE`
  (default `data/session-events.json`, i.e. the bot-data volume) on every append; NEW `loadSessionEvents()`
  called once at boot in `server.ts` (explicit, not lazy, so tests stay deterministic); NEW `observeStatus()`
  records a POLLED status, de-duplicated against the last known one so ERP polling can't spam the ring, and
  refusing to let `unreachable`/`unknown`/empty overwrite a real status.
- **`waha-admin.ts`:** `getSessionStatus()` feeds every REST read through `observeStatus()`, so the boot
  `refreshSelfJid()` call seeds the current status and any transition WAHA's webhook dropped is still caught
  while an operator has the console open.
- **Verified on the live stack:** after rebuild `/health` reports `WORKING` immediately, `/admin/session/events`
  carries the seeded entry, and both survive a `docker restart` with no duplicate entry. Confirmed through the
  ERP's own BFF path (`/api/admin/bot/status|session/events`).
- **Test hygiene:** `phase1/phase2.e2e` mock the store and pin `scheduleStateFile`, but `schedule-state`
  switches to Postgres whenever `config.databaseUrl` is set — so the suites passed or failed on whatever
  `DATABASE_URL` happened to be in the developer's `.env`. Both now pin `config.databaseUrl = ""`, keeping
  them on the intended file fallback (and unable to write into the live bot store).
- **Action audit: not a bug.** `/admin/actions/audit` returns `{enabled: true, entries: []}` — no mutating
  action has ever been attempted, and the audit file lives on the persistent volume. Coverage confirmed in
  `actions/executor.ts` (kill-switch, rate-limit, step-up, deny and execute outcomes all audited). The UI
  empty state now explains this instead of reading as a fault.

### [0.8.1] — 2026-07-27 · DEV-VERIFIED (discovered groups: named + persistent)
- **Bug:** the ERP Groups tab listed discovered groups as blank rows with only an Add button. Two causes: `bot.ts`
  called `noteDiscovered(chatId)` with no name (WAHA's `message` webhook carries the SENDER's `notifyName`, never the
  group subject, and `InboundMessage` has no chat-name field), and the discovery map was in-memory only, so the list
  reset on every restart.
- **NEW `src/group-names.ts`:** out-of-band subject resolution from WAHA, read-only and fail-soft (WAHA down /
  unpaired / endpoint absent → no name, never an error on the message path). One cached bulk sweep (60s TTL,
  in-flight dedup) of `GET /api/{session}/groups`, falling back to `/chats`, then bounded per-group probes.
  Shape-tolerant against the live NOWEB engine: `/groups` answers with a **JID-keyed object** (not an array),
  ids are bare strings on NOWEB and `{_serialized}` on WEBJS, subject is `subject` (NOWEB) or `name` (WEBJS).
- **`groups.ts`:** discovery persisted atomically (tmp+rename) to `discovered-groups.json` derived from
  `dirname(GROUPS_FILE)` (override `DISCOVERED_GROUPS_FILE`) so it follows the registry onto the writable volume;
  lazy hydrate on read; 500-entry oldest-first cap; NEW `setDiscoveredName()` late-binds a subject (never blanks or
  churns an existing one); re-seeing a persisted group no longer re-announces it as new.
- **Wiring:** `bot.ts` fires `ensureGroupName()` fire-and-forget per group message (no-op once known);
  `GET /admin/groups` awaits `backfillDiscoveredNames()` so the ERP shows real names on first load.
- **platform-ui `0.6.1`:** `GroupRegistry` falls back to the JID when a subject is still unresolved (was rendering a
  blank row), and seeds the registry row with the JID rather than an empty name on Add.
- **Verified on the live stack:** all 13 discovered groups resolved to real subjects on the first admin read after
  rebuild, and the list survived the restart. 32 unit tests for the two modules; bot suite green except the
  pre-existing Postgres-credential failures in this dev env.

### [0.8.0] — 2026-07-24 · PROTOTYPED (session-lifecycle admin plane + writable group registry)
- **Workstream A (WhatsApp go-live self-service, design §2):** new `waha-admin.ts` client + ADMIN_TOKEN-gated Fastify routes for session lifecycle
  (POST start, GET status, GET qr with data-URL base64, POST stop/logout/restart); all engine-tolerant (NOWEB status strings pass verbatim).
  Routes: `/admin/session/{start,status,qr,stop,logout,restart}` with responses per design spec §2.1.
- **Writable group registry:** moved from read-only compose bind mount to writable bot-data volume (`/app/data/groups.yaml`); YAML + mtime
  hot-reload unchanged; NEW `writeGroups()` validates (id regex, name/category lengths, ≤1 isManagement, ≤500 groups, atomic write);
  `discoveredGroups()` returns in-memory map of auto-discovered groups with firstSeenAt. Routes: `GET /admin/groups` (registry snapshot + discovered
  + managementGroupId), `PUT /admin/groups` (full-replace, idempotent, field-level validation 400).
- **Safe config write:** `GET /admin/config` (read-only snapshot + editable values), `PUT /admin/config {postToGroups?, managementGroupId?}` rewrites registry
  isManagement flag when managementGroupId changes (empty string clears to env fallback). **No editing of other env-backed config from ERP** (design 2.3 §2.6).
- **Session-state tracker (NEW `session-state.ts`):** extends InboundEvent with `{kind:"session", session, status, ts}`; normalizeWahaEvent maps webhook
  `session.status` events (tolerates both payload.status + payload.body.status shapes); ring buffer of last 20 transitions `{status,ts}` + WARN logs on
  FAILED|STOPPED transitions; `/health` gains `session` field (status string only, no identifiers).
- **Bot environment updates:** `GROUPS_FILE=/app/data/groups.yaml` (writable), `GROUPS_SEED_FILE=/app/config/groups.seed.yaml` (read-only seed);
  boot logic: if `groupsFile` absent and seed exists → copy seed → log one line. Existing `WHATSAPP_HOOK_EVENTS` already subscribed `message,session.status`.
- **NOT deployed yet:** bot session e2e tested (start→SCAN_QR_CODE→QR); UI surfaces pending (WS5 scope, not yet built).

### [0.7.1] — 2026-07-24 · NOWEB engine + aire-lesson hardening
- WAHA switched to the **NOWEB (Baileys) engine**, image pinned `devlikeapro/waha:noweb-2026.6.2`
  (no more `:latest` — aire hit floating-tag drift). Added `WHATSAPP_DEFAULT_ENGINE=NOWEB`,
  `WHATSAPP_DOWNLOAD_MEDIA=True` (feeds media enrichment), `WHATSAPP_HOOK_EVENTS="message,session.status"`
  (see reconnect/ban state, not just messages). Kept `RESTART_ALL_SESSIONS` + persisted `.sessions`
  volume (relink survives restart w/o re-QR).
- Bot persona renamed **Gaia → Rhea** (`BOT_NAME` default); persona still playful/professional by stakes.
- `normalize()` hardened engine-tolerant (aire lessons): `replyToBot` now also reads NOWEB-normalized
  `replyTo.fromMe`; `senderName` falls back to `_data.pushName`; **system-chat guard** drops
  `status@broadcast`/`@broadcast`/`@newsletter` (never reply there). Webhook already ACKs 200 before
  detached processing (dup-reply lesson already satisfied). +4 normalize tests; suite green.
- **NOWEB caveat:** the store must be enabled at SESSION CREATION (`config.noweb.store.enabled`), not
  via env, and final NOWEB payload shape can only be validated once a number is paired (needs the phone).

### [0.7.0] — 2026-07-24 · DEV-VERIFIED (persona + prompt-safety)
- New `src/persona.ts`: agency persona (voice adapts to stakes — playful/low-stakes, direct/work,
  firm/at-risk), scope limits, graceful decline, and an injection guard. `fence()` wraps untrusted
  content and neutralizes fence-breakout attempts; `dataNote()` marks fenced data as non-instructions.
- Wired into every chat-facing prompt: `answerQuestion` (persona + scope-narrowed — no open-ended
  general knowledge), `/know` + `/actions` skills, digest map/reduce (injection guard only, stays a
  neutral report), intent router (message fenced + "classify only, ignore embedded instructions").
- Reply gating hardened: `@bot` match changed from loose `includes()` to a standalone-token regex
  (`mentionsBot`) so "@bottom"/"x@bot.com" no longer trigger the bot. Gating unchanged otherwise:
  groups reply only on command/@mention/reply-to-bot; DMs always; non-triggered messages stored
  silently for digests. Digests remain management-only unless a group opts in / `POST_TO_GROUPS=true`.
- Config: `BOT_NAME` (default "Gaia"), `AGENCY_NAME` (default "Gaiada").
- Tests: new `persona.test.ts` + mention-hardening cases; 194 pass (3 pre-existing e2e fails are
  Postgres-auth env issues, unrelated). **Live e2e** against Ollama Cloud via the rebuilt gateway:
  in-scope Q&A answers naturally & grounded; jailbreak/prompt-leak declined w/o leaking; off-topic
  declined + redirected; at-risk prompt drew a firm, accountable reply. Bot container rebuilt + live.
- Baseline. WA + Telegram bot; scrub → crypto-shred → skills/Q&A; digests; media enrichment. Telegram live
  in dev; P5a features.
- **Blocked:** infra (OpenBao/Gemini/WAHA) + legal Gate 1 before real ingestion.

## ai-agents
### [0.4.0] — 2026-07-24 · PROTOTYPED (agent-runner service + goal/run store + queue)
- **Workstream B agent runtime e2e (design §3):** NEW `src/runner/service.ts` Fastify microservice (port 3006, AGENT_RUNNER_TOKEN auth, mirroring knowledge/service.ts patterns).
  `buildRunnerApp(deps)` factory for tests. Env: `GATEWAY_URL/GATEWAY_TOKEN`, `HUB_URL/HUB_SERVICE_TOKEN`, `AGENTS_DATABASE_URL` (runtime role), `MIGRATE_DATABASE_URL`
  (owner role), `AGENT_MAX_CONCURRENT_GOALS` (default 1), `AGENT_MAX_QUEUE` (default 10), `AGENT_SERVING_PROVIDER` (optional override for D13 gate).
- **Data model (gaiada_knowledge):** NEW tables created by owner-DSN DDL (zero infra/DB-role changes needed, auto-grant to knowledge_app per existing pattern).
  `agent_goals` (queued|running|ok|suspended|budget_exhausted|failed|interrupted|cancelled, outcome, error_kind, approval_id, model_calls, tool_calls, budget caps,
  fan_out, blackboard jsonb for supervisor goals), `agent_runs` (full traced run per direct-specialist goal, TraceStatus, steps transcript, tools_called array).
  Indexes on (tenant_id, created_at DESC) for both.
- **Execution semantics:** supervisor → `runOrchestrator` → approval suspension → `suspended` + `approval_id`; write-specialist → `runWriteAgent` → `forced_read_only`
  (outcome notes the gate); read-specialist → `traceRun` → `agent_runs` row. Boot-recovery sweep: `UPDATE agent_goals SET status='interrupted'` for orphaned (queued|running)
  goals — deterministic, human re-triggers. In-process FIFO queue, workers unref'd, max-concurrent + max-queue gates. Typed error mapping:
  Budget → `budget_exhausted`, Approval/Suspended → `suspended`, Unknown/Planner/Model/ToolNotAllowed → `failed` + `error_kind`.
- **HTTP endpoints:** `GET /health` (agents/writeAgents/queue list), `POST /goals` (token, 202 queued), `GET /goals?tenant=uuid&limit=50` (list, newest first),
  `GET /goals/:id?tenant=uuid` (goal + blackboard + run summaries), `GET /runs/:id?tenant=uuid` (full run + steps), `POST /goals/:id/cancel?tenant=uuid` (queued→cancelled),
  `GET /metrics/agents` (collector summary + alerts). All reads tenant-pinned (no cross-tenant id probing).
- **Existing integrations preserved:** episodic store (PgEpisodicStore) auto-records every finished goal/run, D9 RAG, D11 revocation, D13 forced_read_only, D14 approvals.
  `evaledProviders` enrollment via eval suite + tool-contract check (runbook: `docs/runbooks/agent-evaled-providers-enrollment.md`).
- **DEV-VERIFIED end-to-end** (2026-07-24): agent-runner container lives; goal/run store persists on gaiada_knowledge; goal execution follows approval-suspension
  path (D14 gates untouched); D13 forced_read_only surfaces in status + UI; gateway timeout + 429 breaker work with runner calls (x-tenant-id propagated).
- **NOT deployed yet:** agent-runner container exists but not deployed; pending search-marketing build blocker for full UI-through.

### [0.3.0] — 2026-07-23 · IN PROGRESS
- Baseline. Specialist framework + supervisor + pgvector RAG; D14 safety.
- **Next:** eval harness (root gate) → memory/RAG → local-model registry → trainer.

## hermes-gateway
### [0.2.0] — 2026-07-23 · PROTOTYPED
- Baseline. Local Hermes brain via the Gateway contract; verified headless.

## capture-helper
### [0.2.0] — 2026-07-23 · IN PROGRESS
- Baseline. Capture edge: record → local Whisper → ingest → Shared Drive.
- **Next:** complete the MOM→PRD delivery pipeline tails.

## webdesk
### [0.0.0] — 2026-07-23 · PLANNED
- Blueprint approved; no code. Phased plan P1–P6 (see BLUEPRINTS.md).

## search-marketing
### [0.1.0] — 2026-07-23 · IN PROGRESS
- **SM-01 landed** (migrations `0034_module_search.sql` + `0035_integration_connections_search_providers.sql`
  + `module-search-rls.test.ts`): 18 `search_*` tenant tables under third-wall FORCE-RLS + the no-RLS
  `search_data_cache` (D-4), dual-mode embedding col (float8[] fallback — pgvector absent, OQ-8),
  additive `integration_connections` widen. Merge gate cleared: QA PASS (45/45 db tests, adversarial
  RLS matrix on a second DB) + architect APPROVE-WITH-NOTES (full §04/§11 conformance).
- **SM-02 landed** (`src/modules/search/` — ModuleContract, controller `api/:t/modules/search`, 18
  `search.*` mcpTools, property/engagement/kpi CRUD, `engagements/:id/scope` + preset seeding,
  service-layer same-tenant FK validation). Full repo suite 512/512 green; tsc + withTenants lint clean.
  Module is fail-closed until SM-03 adds Cerbos policy (by design).
- **SM-03 landed** (`cerbos/policies/resource_search_{property,engagement,keyword,audit,campaign,report,
  ledger}.yaml` + derived-roles wiring + `search-cerbos.test.ts` + the `platform-ui/src/lib/rbac.ts`
  capability mirror with `search_staff`/`search_manager` derived roles). **Declared 2026-07-27 after
  verification** — the code landed 2026-07-24 but the gate was never recorded. Re-run against live
  Cerbos (49 executable policies): 25/25 parity tests green, covering owner/manager/member/served-dept
  plus every deny case in the AC (`launch`/`apply_manual`/`apply_negatives`/`set_budget` denied to staff
  and to served-dept staff, `approve`/`deliver` denied to member, `set_scope` denied to member per D-11,
  ledger `admin` denied to member, cross-tenant grants denied, low-assurance principals get nothing).
- **SM-00 (reconcile, off-design ticket) 2026-07-27:** all four search suites re-run against live
  Postgres + Cerbos → **60/60 green** (`search.test.ts` 13, `search-cerbos.test.ts` 25,
  `module-search-rls.test.ts` 15, `scope-presets.test.ts` 7). MODULES.md section header corrected
  (`0.0.0 · PLANNED` → `0.1.0 · IN PROGRESS`, matching the registry row it contradicted); execution
  tracker added at `blueprints/seo-sem-execution-tracker.md`.
- **SM-04 AC discharged 2026-07-27 (awaiting the ⚡ QA + architect gate).** The provider layer
  (`providers/{types,registry,dispatch,cache,ledger,mock-provider}.ts`, landed 07-24) gained its
  missing halves: **`providers/dispatch.test.ts` (35 tests)** and the **`GET
  engagements/:id/cost-projection`** endpoint (+3 controller tests, with `?toolScope=` what-if
  pricing and an `overBudget` flag). All five AC clauses proven on live PG — scope-disabled refused
  naming the *toggle*, cache hit = cost 0 (incl. the cross-tenant D-4 reuse that IS the cost model),
  8 concurrent identical queries → exactly 1 dispatch, engagement+tenant breach refuses/emits/blocks,
  ledger sums reconcile with the stop-loss's own reader. Plus true-up (same row, never a second),
  rollback-on-provider-failure, and fail-closed provider resolution. Search suites **98/98**; tsc and
  `lint:withtenants` clean. Three findings fixed: (1) a scope refusal could be masked by
  `unknown_provider` when no driver is registered; (2) `lint:withtenants` was **failing** on
  `ledger.ts:70` — SM-04 had landed without that gate, now a reasoned allowlist entry **pending
  architect ratification**; (3) the 80%-warn float boundary documented. Full-repo suite: 574 passed /
  1 failed / 60 skipped — the one failure is `admin/bot-admin.test.ts` (WhatsApp chat-thread proxy),
  reproducible, pre-existing and unrelated to search.
- **SM-05 + SM-06 AC discharged 2026-07-27 (awaiting the same ⚡ gate).** `providers/dataforseo.ts` —
  the real driver behind SM-04's interface (Standard-queue `task_post`→`task_get` with the 40602
  in-queue poll, keyword metrics, backlinks, AI-visibility, §8a rate table) with **25 mock-server
  tests** on an injected `fetchImpl`: no network, no credentials, no deposit needed. Live queue exists
  but only via an exact `live` string — a typo cannot triple the bill. Config: `config.search.
  {dataforseo,pillars}`, keyless bootstrap registration in `main.ts`, and env rows in
  `platform-nest/.env.example`, `infra/compose/.env.example` and `docker-compose.vps.yml`.
  **Keyless is first-class** — no credentials means the paid driver is never registered, paid
  capabilities fail closed, and the $0 pillars keep working. Added beyond the ticket text: the
  per-pillar kill switches needed somewhere to bite, so dispatch gained a **gate (-1)**
  (`PillarDisabledError`) ahead of the scope gate. Search suites **125/125**; tsc + lint clean.
  **Still gated on the $50 deposit:** the real-data pull (SM-05's one remaining AC clause).
- **M1 reached pending the gate** — the money path is fail-closed at four independent gates
  (pillar → engagement tool-scope → ordered budget stop-loss → provider capability).
- **Next:** the ⚡ QA + architect gate over the P0 tail, then P1 (SM-07 crawl workers ∥ SM-09 keywords).

### [0.0.0] — 2026-07-23 · PLANNED
- Foundation research + v1.1 architect design ratified; no code. See
  `blueprints/seo-sem-foundation.md` + `blueprints/seo-sem-design.md`.
- Owner decisions locked: dept name SEO (3-craft-group Web-Dev console), dual-mode SEM execution,
  no-RLS shared market-data cache, per-engagement tool-scope config.
- 26 tickets P0–P3 + 2 committed P4 (design §12).

## social-media
### [0.0.0] — 2026-07-23 · PLANNED
- Foundation research + v1.0 architect design; no code. See `blueprints/smm-foundation.md` +
  `blueprints/smm-design.md` (+ print `GAIADA-Social-Media-Engineering-Blueprint.pdf`).
- Decisions locked: scope v1 = organic publish + engagement + copy + assets (paid/listening/influencer
  parked); publisher = Postiz (AGPL-3.0) run AGPL-CONTAINED (Mixpost Pro paid fallback); Chatwoot dropped
  (engagement uses Postiz's comment/collab surface). Module key `social`, tables `social_*`; mandatory
  human-in-the-loop (one-shot payload-hash approvalId, no auto-publish); one usage ledger (X fees + gen
  credits); no shared no-RLS cache.
- **Next:** P0 contracts + AGPL-containment spike (SMM-01 migrations/RLS → SMM-02 module/contract →
  SMM-03 Cerbos → SMM-04 Postiz adapter/containment → SMM-05 tenant mapping → SMM-09 approve-execute).
  27 tickets P0–P4 + 2 decision-gated (design §12).

## creative
### [0.1.0] — 2026-07-23 · PROTOTYPED
- Baseline (pre-existing dev code): **Image Studio** client-side grading engine (WebGL2 LUT + Canvas2D
  fallback, pure imaging lib, 35 UI tests, visually verified) + `creative_assets` persistence (migrations
  `0031`/`0032`, `/api/:t/creative/assets`) + grading-trainer ONNX scaffold. See memory `creative-image-studio`.
- **Expansion designed (no code yet):** v1.0 architect design authored — `blueprints/creative-foundation.md`
  (research + Magnific head-to-head) + `blueprints/creative-design.md` (§00–§14) + print
  `GAIADA-Creative-Engineering-Blueprint.pdf`. Module key `creative`, tables `creative_*`, third-wall RLS,
  migration `0036`; `creative_assets` extended in place + versions/collections/brand-kits/render-jobs/
  usage-ledger/scopes. Build-light DAM (RLS store + Shared Drive + pgvector CLIP search + BLIP tags +
  imgproxy renditions). Default model stack commercial-license-CLEAN; SUPIR/FLUX-dev/RMBG/IC-Light-V2/SVD
  quarantined behind license gates.
- Owner decisions locked (2026-07-23): serverless-GPU-first · hybrid image licensing (clean default + FLUX
  paid opt-in) · hybrid video (Wan 2.2 OSS + Veo/Kling API budget) · build-light DAM.
- **Next:** Phase 0 clarity-upscaler Replicate spike (kill Magnific now) → P0 contracts → P1 upscale via
  the Render Gateway → P2 gen/edit → P3 DAM → P4 video. 27 tickets CR-00–CR-26 (design §12); Opus-flagged
  CR-01/06/13; QA gates CR-01/06/12/13/20.

## render-gateway-go
### [0.0.0] — 2026-07-23 · PLANNED
- Design only — the centerpiece of `blueprints/creative-design.md` §05; no code. Separate Go service
  (mirror of `ai-gateway-go`): typed render job-queue, `RenderBackend` abstraction (serverless GPU /
  self-host ComfyUI / commercial API) routed per capability+license+cost+health, ComfyUI-workflow-as-JSON,
  signed per-job I/O URLs, idempotent render-callback, fail-closed stop-loss (image $200 / video $300),
  structural license wall, egress audit. Outputs land in the `creative` DAM; job state on platform-nest rows.
- **Next:** built under the `creative` P1–P4 tickets; container-build verification before deploy.
