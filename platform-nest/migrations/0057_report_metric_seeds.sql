-- TR-08 (Work Tracker / Reports / Appraisal program, §4/§5/§15) — the reports metric seeds +
-- the two additive counters §15 ruling ② requires `report_work_facts` to gain.
--
-- ─────────────────────────── NUMBERING (read before assuming this is "0059") ───────────────────────
-- The blueprint's §4 heading and `migrations/README.md`'s own tracker-program entry both say TR-08
-- lands as `0059_report_metric_seeds.sql` (0057 reserved for TR-14's report_periods/report_documents,
-- 0058 for TR-23's appraisal tables). Per the doc's own §15 PROCESS RULE ("claim your number at
-- implementation time... do NOT trust the number written in this doc"): `ls migrations | tail`
-- at TR-08 implementation time showed head = `0056_module_reports_core.sql` with 0057 STILL FREE —
-- TR-14/TR-23 have not executed yet in this session's timeline, so their reservations are stale.
-- TR-08 therefore takes **0057**, not 0059. This is recorded in `migrations/README.md` alongside
-- this file (search "TR-08" there) so whoever implements TR-14/TR-23 next re-checks `ls` themselves
-- rather than colliding on 0057/0058.
--
-- ─────────────────────────── WHAT THIS IS FOR ───────────────────────────
-- (1) Two ADDITIVE counter columns on `report_work_facts` (0056) that TR-07's fact job did not
--     originally populate, per the architect ruling recorded in the blueprint's §15 ("Metric #3's
--     denominator is not computable from the landed grain" + "the same shape of gap affects #13"):
--       - `tasks_completed_with_due_date` — metric #3 `delivery.on_time_rate`'s DENOMINATOR.
--         Redefining the denominator as `tasks_completed` (the tempting shortcut) would silently
--         DILUTE the rate for any team that sets fewer due dates, inverting the metric's meaning —
--         forbidden. This is the correct fix: complete the grain, don't redefine the metric.
--       - `estimate_minutes_completed_with_actual` / `minutes_logged_completed_with_actual` — metric
--         #13 `effort.estimate_accuracy`'s matched numerator/denominator (completed tasks that carry
--         BOTH an estimate AND actual logged minutes; the existing `estimate_minutes_completed`/
--         `minutes_logged` counters live on separate, unmatched axes and cannot answer this alone).
--     `platform-nest/src/modules/reports/fact-job.ts` (TR-07, extended by TR-08 per its brief's
--     explicit allowance) now populates all three going forward. No backfill DML ships here: TR-07's
--     own migration (0056) shipped with zero historical rows for the identical reason ("computed
--     entirely by TR-07's job, never backfilled by DDL") — these are the SAME rows, just gaining
--     columns before anything has ever been sealed. A `DEFAULT 0` on the ALTER makes any already-
--     written fact row correct-by-construction (0 is the honest value for "not yet computed with
--     the new logic"), and the next nightly/backfill recompute (a plain DELETE+INSERT per §4a
--     invariant 5) supersedes it with the real count. No NOBYPASSRLS-role backfill test is required
--     (ruling ④) because there is no backfill DML — only a schema-default, exactly TR-06's precedent.
-- (2) The §5 metric registry: 21 SEEDED rows into the governed `metric_definitions` (module
--     'reports'). `aggregation_rule` is drawn ONLY from the EXISTING CHECK vocabulary
--     ('sum','ratio_of_sums','max','last') — 0001_core.sql:83 — which this migration does NOT widen
--     (every other module's rollup consumers read that column). Metric #20
--     `discipline.overdue_open` seeds as `'last'` (point-in-time — summing it across a range would
--     multiply the same still-overdue task by the day count, §5.4). Metric #22
--     `evidence.source_diversity` is NOT seeded at all (a `COUNT(DISTINCT source)` union has no
--     representable `aggregation_rule`; it is read-time derived — see
--     `src/modules/reports/metrics.ts`, the single source of truth this migration's literal INSERT
--     values below are kept byte-identical to). `ON CONFLICT (metric_key) DO NOTHING`: idempotent
--     re-run, and `rollups/engine.ts`'s `syncMetricDefinitions()` (called at every app boot) is the
--     ongoing keeper-in-sync should the TS catalog's description/unit ever change without a new
--     migration — this migration only needs to seed the INITIAL rows so a DB-only/replica boot that
--     never runs the Node app still has a populated registry.
--
-- ─────────────────────── RULINGS FROM §15 APPLIED (binding, not preference) ───────────────────────
-- `origin_site`/composite-FK/backfill rulings are N/A here: this migration adds no new TABLE (only
-- columns on the existing, already-compliant `report_work_facts`, and rows in the existing GLOBAL
-- `metric_definitions`, which carries no `tenant_id`/`origin_site` at all — see 0001_core.sql:77).

-- ══ (1) the two additive counters (§15 ruling ②) ══════════════════════════════════════════════════
ALTER TABLE report_work_facts
  ADD COLUMN tasks_completed_with_due_date       int NOT NULL DEFAULT 0,
  ADD COLUMN estimate_minutes_completed_with_actual int NOT NULL DEFAULT 0,
  ADD COLUMN minutes_logged_completed_with_actual   int NOT NULL DEFAULT 0;

COMMENT ON COLUMN report_work_facts.tasks_completed_with_due_date IS
  'TR-08 (0057, §15 ruling ②) — completed tasks that carried a due date (regardless of on-time-ness). '
  'Metric #3 delivery.on_time_rate''s DENOMINATOR; seeding against tasks_completed instead would '
  'dilute the rate for teams that set fewer due dates.';
COMMENT ON COLUMN report_work_facts.estimate_minutes_completed_with_actual IS
  'TR-08 (0057, §15 ruling ②) — Σ estimate minutes for completed tasks that ALSO have >=1 logged '
  'minute. Metric #13 effort.estimate_accuracy''s numerator (paired with the sibling column below).';
COMMENT ON COLUMN report_work_facts.minutes_logged_completed_with_actual IS
  'TR-08 (0057, §15 ruling ②) — Σ actual minutes logged against the SAME matched tasks as '
  'estimate_minutes_completed_with_actual. Metric #13''s denominator.';

-- ══ (2) the 21 seeded metric_definitions rows (module 'reports') ══════════════════════════════════
-- Values here MUST stay byte-identical to src/modules/reports/metrics.ts's REPORT_METRICS catalog
-- (SEEDED_REPORT_METRICS / toMetricDefs()) — that TS file is the single source of truth; this INSERT
-- is a defensive mirror for a DB-only boot, kept in sync by review, not by codegen.
INSERT INTO metric_definitions (metric_key, module, description, unit, is_monetary, aggregation_rule) VALUES
  ('delivery.throughput_weighted', 'reports', 'Estimate-weighted completed throughput (anti-slicing weight; Σ estimate_minutes_completed)', 'minutes', false, 'sum'),
  ('delivery.tasks_completed', 'reports', 'Raw completed-task count (appraisal-unsafe: rewards task-slicing; see #1)', 'count', false, 'sum'),
  ('delivery.on_time_rate', 'reports', 'On-time completions over completions that carried a due date (§15 ruling ②: NOT tasks_completed — that would dilute the rate for teams that set fewer due dates)', 'ratio', false, 'ratio_of_sums'),
  ('delivery.estimate_coverage', 'reports', 'Completed tasks that carried an estimate, over all completions (estimation hygiene)', 'ratio', false, 'ratio_of_sums'),
  ('delivery.milestone_hit_rate', 'reports', 'Milestones due in-range that are done, over milestones due in-range (project/lead level; sourced from pm_milestones, NOT report_work_facts)', 'ratio', false, 'ratio_of_sums'),
  ('delivery.backlog_delta', 'reports', 'Net backlog change: Σ tasks_created − Σ tasks_completed (not person-attributable)', 'count', false, 'sum'),
  ('flow.wip_open_avg', 'reports', 'Average daily open task count over the range (pm_progress_snapshots; context, not attributable)', 'ratio', false, 'ratio_of_sums'),
  ('flow.blocked_share', 'reports', 'Daily blocked-status count over daily open count (blocked is often external; pm_progress_snapshots)', 'ratio', false, 'ratio_of_sums'),
  ('flow.reopen_rate', 'reports', 'Reopened over completed (quality proxy; owner-attributed)', 'ratio', false, 'ratio_of_sums'),
  ('flow.avg_progress', 'reports', 'Progress·open weighted average over the range (self-reported progress; pm_progress_snapshots)', 'ratio', false, 'ratio_of_sums'),
  ('effort.minutes_logged', 'reports', 'Raw logged minutes (appraisal-unsafe alone: hours are not value; §5.2)', 'minutes', false, 'sum'),
  ('effort.billable_share', 'reports', 'Billable minutes over logged minutes (safe at D/C; caution at P — §5 table)', 'ratio', false, 'ratio_of_sums'),
  ('effort.estimate_accuracy', 'reports', 'Estimate over actual, for completed tasks that carry BOTH (§15 ruling ②''s second gap). Display with a band (±25% is "good", not 100%)', 'ratio', false, 'ratio_of_sums'),
  ('effort.capacity_utilization', 'reports', 'Logged minutes over expected calendar minutes (presence proxy; ops capacity planning only)', 'ratio', false, 'ratio_of_sums'),
  ('collab.contributed_minutes', 'reports', 'Credited contributor-role minutes on OTHER people''s tasks (real logged time helping)', 'minutes', false, 'sum'),
  ('collab.comments_authored', 'reports', 'Raw comment count (chatter is gameable)', 'count', false, 'sum'),
  ('collab.docs_updated', 'reports', 'Raw doc-update count (unsafe raw; pack shows cohort band only)', 'count', false, 'sum'),
  ('discipline.checkin_compliance', 'reports', 'Submitted check-ins over expected (calendar + leave + attendance aware, §5.3)', 'ratio', false, 'ratio_of_sums'),
  ('discipline.time_logging_coverage', 'reports', 'Days with >=1 logged time entry over expected working days (hygiene, not volume)', 'ratio', false, 'ratio_of_sums'),
  ('discipline.overdue_open', 'reports', 'Open tasks past due, evaluated AT THE RANGE END (point-in-time — §5.4; NOT a sum). Pack shows trend only', 'count', false, 'last'),
  ('evidence.link_rate', 'reports', 'Exactly-linked activity over all activity events (measures the linker, not the person)', 'ratio', false, 'ratio_of_sums')
ON CONFLICT (metric_key) DO NOTHING;
