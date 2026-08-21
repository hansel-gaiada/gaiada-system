-- MON-12 — make `monitor_results` partition roll-forward actually possible.
--
-- ── THE DEFECT, WHICH HAD A DUE DATE ─────────────────────────────────────────────────────────────
-- `ensureResultPartitions()` in runner.ts was supposed to keep partitions ahead of the calendar. It
-- never created a single one, for two independent reasons stacked on top of each other:
--
--   1. It issued `CREATE TABLE ... FOR VALUES FROM ($1) TO ($2)` with bind parameters. Postgres does
--      not accept bind parameters in DDL, so every call threw
--      "bind message supplies 2 parameters, but prepared statement requires 0".
--   2. Even with that fixed, the runtime role cannot execute the statement at all. Verified against
--      production: `has_schema_privilege('platform_app','public','CREATE')` is FALSE, and the app
--      connects as `platform_app`. DDL rights belong to the owner/migrator role by deliberate design
--      (MON-09m's role separation), and that separation is worth keeping.
--
-- Nothing looked wrong because migration 0116 created partitions 202608..202611 up front, so the
-- table was correctly partitioned while the mechanism meant to extend it was dead. `monitor_results`
-- is RANGE-partitioned with NO default partition, so this is a dated failure rather than a
-- degradation: the first insert on 2026-12-01 fails with "no partition of relation found for row"
-- and results simply stop being recorded.
--
-- ── WHY SECURITY DEFINER RATHER THAN GRANTING THE APP DDL ────────────────────────────────────────
-- Granting `platform_app` CREATE on `public` would let every code path in the platform issue
-- arbitrary DDL in order to solve one monthly maintenance task. This mirrors 0119's heartbeat fix,
-- which faced the same shape (a runtime role that legitimately needs one privileged action) and
-- answered it the same way: one narrow function, owned by the migrator, doing exactly one thing.
--
-- `search_path` is pinned. A SECURITY DEFINER function with a mutable search_path is the classic
-- privilege-escalation shape, and this one runs as a role that CAN create tables.
--
-- The function takes NO caller-supplied input at all: it derives every bound from `now()` internally,
-- so there is no argument through which a caller could influence the DDL it builds.

CREATE OR REPLACE FUNCTION monitoring_ensure_result_partitions(p_months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  i          integer;
  start_d    date;
  end_d      date;
  part_name  text;
  created    integer := 0;
BEGIN
  -- Bounded so a bad argument cannot ask for ten thousand tables.
  IF p_months_ahead IS NULL OR p_months_ahead < 0 OR p_months_ahead > 24 THEN
    RAISE EXCEPTION 'monitoring_ensure_result_partitions: months_ahead must be between 0 and 24, got %', p_months_ahead;
  END IF;

  FOR i IN 0..p_months_ahead LOOP
    start_d := date_trunc('month', (now() AT TIME ZONE 'UTC')::date + (i || ' months')::interval)::date;
    end_d   := (start_d + interval '1 month')::date;
    part_name := 'monitor_results_' || to_char(start_d, 'YYYYMM');

    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name AND relkind = 'r') THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF monitor_results FOR VALUES FROM (%L) TO (%L)',
        part_name, start_d, end_d
      );
      created := created + 1;
    END IF;
  END LOOP;

  RETURN created;
END $$;

COMMENT ON FUNCTION monitoring_ensure_result_partitions(integer) IS
  'MON-12. Creates monitor_results partitions for the current month plus N ahead. SECURITY DEFINER '
  'because the runtime role has no CREATE on public by design; takes no caller-controlled input.';

REVOKE ALL ON FUNCTION monitoring_ensure_result_partitions(integer) FROM PUBLIC;

-- Grant to whatever runtime roles actually exist. Named roles differ between environments (dev uses a
-- single shared role; production has per-service roles), so this is conditional rather than a hard
-- reference to a role that may not exist here.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['platform_app', 'platform_app_test'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION monitoring_ensure_result_partitions(integer) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- Run it once now, so the window is extended the moment this migration lands rather than on the
-- runner's next tick — and so the self-check below has something real to assert against.
SELECT monitoring_ensure_result_partitions(3);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Self-check. The whole point of this migration is that a silent failure here has a calendar date
-- attached, so it must fail loudly now rather than on 1 December.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  covered boolean;
  n_parts integer;
BEGIN
  SELECT count(*) INTO n_parts FROM pg_class WHERE relname LIKE 'monitor_results_2%' AND relkind = 'r';
  IF n_parts < 4 THEN
    RAISE EXCEPTION 'MON-12: expected at least 4 monitor_results partitions, found %', n_parts;
  END IF;

  -- The assertion that actually matters: a row dated three months out must have somewhere to land.
  SELECT EXISTS (
    SELECT 1 FROM pg_class
     WHERE relname = 'monitor_results_' || to_char(
             date_trunc('month', (now() AT TIME ZONE 'UTC')::date + interval '3 months'), 'YYYYMM')
       AND relkind = 'r'
  ) INTO covered;
  IF NOT covered THEN
    RAISE EXCEPTION 'MON-12: no partition covers three months ahead — roll-forward is not working';
  END IF;

  RAISE NOTICE 'MON-12 partition roll-forward OK: % partitions present', n_parts;
END $$;
