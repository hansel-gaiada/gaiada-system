-- 202610110441_webdev_schedule_firings.sql — WSK-61, a scheduled publish going live rebuilds staging.
-- Design: docs/plans/2026-10-10-webdesk-write-plane-design.md §9 + §12 WSK-61; the code is
-- src/modules/webdev/scheduled-rebuilds.service.ts.
--
-- ── NUMBERING (migrations/README.md — timestamp scheme) ─────────────────────────────────────────
-- `ls migrations | sort | tail` immediately before naming this file showed the head as
-- `202610110151_projects_status_check.sql`. This takes a later minute. (First written as 202610110119;
-- renamed before merge because 202610110151 shipped in 1.0.0-alpha.351 in between.)
--
-- ── PART 1: `schedule.fired` joins the Zone B fact kinds ───────────────────────────────────────
-- WebDesk's content tick (webdesk/api/src/scheduler/content-tick.service.ts) emits `schedule.fired`
-- when a scheduled publish, swap or takedown takes effect. It is a WAKE-UP HINT, never authority
-- (§03 channel 1: a forged fact is noise): the ERP re-derives the approval from its own rows and
-- re-reads every item over the control channel before it dispatches anything.
--
-- The kind CHECK is rebuilt the 202610101500 way: the values are READ from the constraint's live
-- definition and the new kind is unioned in, so a value this file does not know about survives (the
-- DROP + ADD trap: re-declaring a shared CHECK from one migration's beliefs once deleted a value on
-- LIVE). On top of that, the six kinds this repo's code relies on are ASSERTED present before the
-- rebuild: a live CHECK that has drifted away from them is refused, loudly, rather than widened.
--
-- ── PART 2: `webdev_schedule_firings`, the settle record ───────────────────────────────────────
-- One row per (approval, transition) the ERP has SETTLED, so the sweep stops looking at it:
--
--   build_recorded  publish: a `webdev_site_builds` row now exists for the approval (its own state says
--                   whether the dispatch happened; a failed build row is terminal, by design: the
--                   ledger's UNIQUE (tenant_id, approval_id) admits one build per approval)
--   superseded      publish: no item went live at the approved version within the grace window
--                   (deleted, unpublished, or replaced). An event naming the approval may still
--                   re-check it, and only a re-read of Zone B can turn it into build_recorded.
--                   unpublish: every item was still live after the grace window.
--   stale_marked    unpublish: at least one item went down, so staging was marked stale ONCE (the
--                   row and the mark are written in one transaction; a later rebuild clears the mark)
--   expired         the effective time fell out of the sweep window without the transition settling
--   refused         the stored approval no longer matches its filed command hash (or cannot be parsed):
--                   nothing is read from Zone B and nothing is dispatched for it, ever
--
-- UNIQUE (tenant_id, approval_id, transition) is what makes the stale mark exactly-once: only the
-- INSERT that wins writes the mark.
--
-- ── RLS WALL — THIRD WALL ───────────────────────────────────────────────────────────────────────
-- The same shape as webdev_site_builds (202610101730): `tenant_id = ANY(app_current_tenants()) AND
-- app_module_allowed('webdev')`, ENABLE + FORCE. Every access runs inside withTenants(..., {modules:
-- ['webdev']}); without that context the table reads ZERO rows (scheduled-rebuilds.test.ts pins it).
--
-- ── ZERO BACKFILL DML ───────────────────────────────────────────────────────────────────────────
-- Part 1 is catalog DDL only; part 2 is a brand-new table. No UPDATE, DELETE or INSERT anywhere.

DO $$
DECLARE
  cname      text;
  live_def   text;
  lit        text;
  values_in  text[] := ARRAY[]::text[];
  known      text[] := ARRAY['form.received', 'deploy.done', 'promote.done', 'rollback.done',
                             'contract.published', 'alert.raised'];
  new_vals   text[] := ARRAY['schedule.fired'];
  final_set  text[];
  value_list text;
  missing    text;
  n_found    int;
BEGIN
  -- Locate the kind CHECK by its current definition, not by a name that may have changed.
  -- 'form.received' appears only in the kind allow-list on this table.
  SELECT count(*) INTO n_found
    FROM pg_constraint
   WHERE conrelid = 'webdev_zoneb_event_log'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%kind%'
     AND pg_get_constraintdef(oid) ILIKE '%form.received%';
  IF n_found <> 1 THEN
    RAISE EXCEPTION
      'WSK-61: expected exactly ONE kind CHECK on webdev_zoneb_event_log, found % - refusing to guess '
      'which one to widen. Inspect pg_constraint for this table before re-running.', n_found;
  END IF;

  SELECT conname, pg_get_constraintdef(oid)
    INTO cname, live_def
    FROM pg_constraint
   WHERE conrelid = 'webdev_zoneb_event_log'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%kind%'
     AND pg_get_constraintdef(oid) ILIKE '%form.received%';

  FOR lit IN SELECT (regexp_matches(live_def, '''([^'']*)''', 'g'))[1] LOOP
    values_in := array_append(values_in, lit);
  END LOOP;

  -- The assertion: the live CHECK still admits every kind the code relies on.
  SELECT string_agg(v, ', ') INTO missing FROM unnest(known) AS v WHERE NOT (v = ANY(values_in));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'WSK-61: the live kind CHECK (%) no longer admits % - it has drifted from what the code expects. '
      'Refusing to rebuild it. Definition: %', cname, missing, live_def;
  END IF;

  SELECT array_agg(DISTINCT v ORDER BY v) INTO final_set FROM unnest(values_in || new_vals) AS v;
  SELECT string_agg(quote_literal(v), ', ' ORDER BY v) INTO value_list FROM unnest(final_set) AS v;

  EXECUTE format('ALTER TABLE webdev_zoneb_event_log DROP CONSTRAINT %I', cname);
  EXECUTE format('ALTER TABLE webdev_zoneb_event_log ADD CONSTRAINT %I CHECK (kind IN (%s))', cname, value_list);

  RAISE NOTICE 'WSK-61: webdev_zoneb_event_log.kind now admits %', value_list;

  -- Self-check against the RE-READ catalog: everything that was there before, plus the new kind.
  SELECT pg_get_constraintdef(oid) INTO live_def
    FROM pg_constraint WHERE conrelid = 'webdev_zoneb_event_log'::regclass AND conname = cname;
  SELECT string_agg(v, ', ') INTO missing FROM unnest(final_set) AS v WHERE position(quote_literal(v) IN live_def) = 0;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'WSK-61: rebuilt kind CHECK is missing value(s) % - definition is now: %', missing, live_def;
  END IF;
END $$;

CREATE TABLE webdev_schedule_firings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  -- The executed `content.schedule` approval (automation_approvals, origin 'webdesk').
  approval_id uuid NOT NULL,
  -- Opaque WebDesk identifiers, copied from the approval's stored tool_args (never from an event).
  -- NULL only on a `refused` row whose stored args could not be parsed.
  tenant_slug text,
  site_id uuid,
  transition text NOT NULL CHECK (transition IN ('publish', 'unpublish')),
  outcome text NOT NULL CHECK (outcome IN ('build_recorded', 'superseded', 'stale_marked', 'expired', 'refused')),
  -- The build the publish settled into (build_recorded only).
  build_id uuid REFERENCES webdev_site_builds(id),
  -- The approval's effective instant for this transition (publishAt / unpublishAt).
  effective_at timestamptz NOT NULL,
  -- What the settle saw, as typed tokens (e.g. `items_live=2/3`), never free text from Zone B.
  detail text CHECK (detail IS NULL OR detail ~ '^[a-z0-9_=/;,.-]{1,200}$'),
  settled_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wsf_site_known_unless_refused CHECK (outcome = 'refused' OR (tenant_slug IS NOT NULL AND site_id IS NOT NULL)),
  CONSTRAINT wsf_build_only_when_recorded CHECK ((outcome = 'build_recorded') = (build_id IS NOT NULL)),
  CONSTRAINT wsf_publish_outcomes CHECK (transition = 'unpublish' OR outcome IN ('build_recorded', 'superseded', 'expired', 'refused')),
  CONSTRAINT wsf_unpublish_outcomes CHECK (transition = 'publish' OR outcome IN ('stale_marked', 'superseded', 'expired', 'refused')),
  CONSTRAINT ux_wsf_tenant_approval_transition UNIQUE (tenant_id, approval_id, transition)
);

CREATE INDEX ix_wsf_site_settled ON webdev_schedule_firings (tenant_id, site_id, settled_at DESC);

COMMENT ON TABLE webdev_schedule_firings IS
  'WSK-61: one row per (content.schedule approval, transition) the ERP has settled after Zone B made it '
  'effective: build_recorded (staging rebuild dispatched under the schedule''s own approval), superseded, '
  'stale_marked (takedown; staging marked stale exactly once), expired or refused. THIRD WALL RLS.';

ALTER TABLE webdev_schedule_firings ENABLE ROW LEVEL SECURITY;
ALTER TABLE webdev_schedule_firings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webdev_schedule_firings;
CREATE POLICY tenant_isolation ON webdev_schedule_firings FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'));
