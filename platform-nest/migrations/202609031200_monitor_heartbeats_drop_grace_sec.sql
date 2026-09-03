-- Eliminates the duplicate source of truth for the heartbeat grace period.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────────
-- `monitor_heartbeats.grace_sec` (0116) is written ONCE, at monitor creation
-- (monitoring.controller.ts's createMonitor), and NEVER updated — updateMonitor's PATCH path only
-- ever touches `monitors.config`. The runner's DUE_SELECT does alias the column in
-- (`hb.grace_sec AS hb_grace_sec`, runner.ts), but nothing reads that alias: `runSweep` builds the
-- heartbeat driver's config from `driver.validate(row.config)`, i.e. `monitors.config.graceSec`
-- (validated by `validateHeartbeatConfig`, defaulting to 300s). That is the ONLY value that has ever
-- controlled a heartbeat monitor's evaluated grace period, and it already survives every edit through
-- the normal PATCH path. `monitor_heartbeats.grace_sec` is a second, frozen representation that
-- silently diverges the moment a monitor is edited — confirmed live: patching a monitor to
-- graceSec=600 left the runner enforcing the 300s default forever, because it never looked at the
-- column it had itself just written.
--
-- ── WHY REMOVE THE COLUMN RATHER THAN TEACH THE RUNNER TO READ IT ────────────────────────────────
-- `monitors.config` is already authoritative in practice: it is validated by the driver
-- (`validateHeartbeatConfig`), and both write paths (create AND patch) keep it current. A repo-wide
-- grep (platform-nest, platform-ui, mcp-hub, docs, every *.sql) turns up exactly one other reference
-- to this column: `monitoring_heartbeat_touch` (0119) selects and returns it, but its one caller — the
-- unauthenticated heartbeat-ingest endpoint (`MonitoringHeartbeatController#ingest`) — runs
-- `SELECT * FROM monitoring_heartbeat_touch($1)` and discards the entire result set. Nothing anywhere
-- makes a decision from this column's value. A column that looks load-bearing (same table, same name
-- as the thing it appears to gate) and is not is a trap, not a feature — the safer fix is to make it
-- impossible to read a stale number, not to give the stale number a reader.
--
-- ── SURGICAL, NOT DROP+ADD ────────────────────────────────────────────────────────────────────────
-- `grace_sec`'s `CHECK (grace_sec >= 30)` is a single-column constraint, not one shared with any other
-- column on this table (unlike the CHECK this estate has previously redeclared and silently truncated
-- by DROP+ADD) — `ALTER TABLE ... DROP COLUMN` removes it with no risk to any other column's rules.
--
-- `monitoring_heartbeat_touch` must be redefined FIRST: its RETURNS TABLE lists `grace_sec`, and
-- `CREATE OR REPLACE FUNCTION` cannot change a function's output columns, so the column cannot be
-- dropped out from under the old signature. Drop and recreate the function, then drop the column.

DROP FUNCTION IF EXISTS monitoring_heartbeat_touch(text);

CREATE FUNCTION monitoring_heartbeat_touch(p_token_hash text)
RETURNS TABLE (monitor_id uuid, tenant_id uuid, client_id uuid, was_open boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  hb RECORD;
  closed integer := 0;
BEGIN
  SELECT h.id, h.monitor_id, h.tenant_id, h.client_id
    INTO hb
    FROM monitor_heartbeats h
   WHERE h.token_hash = p_token_hash;

  -- No match: return zero rows. The CALLER must answer identically either way, or this becomes an
  -- oracle for enumerating valid tokens.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE monitor_heartbeats SET last_seen_at = now() WHERE id = hb.id;

  -- A heartbeat arriving IS the recovery signal, so it closes the open incident itself rather than
  -- leaving a human to close something that already resolved.
  UPDATE monitor_incidents SET closed_at = now()
   WHERE monitor_incidents.monitor_id = hb.monitor_id AND closed_at IS NULL;
  GET DIAGNOSTICS closed = ROW_COUNT;

  UPDATE monitors
     SET status = 'up', last_checked_at = now(), updated_at = now()
   WHERE id = hb.monitor_id;

  INSERT INTO monitor_results (tenant_id, client_id, monitor_id, status, detail)
  VALUES (hb.tenant_id, hb.client_id, hb.monitor_id, 'up', NULL);

  RETURN QUERY SELECT hb.monitor_id, hb.tenant_id, hb.client_id, closed > 0;
END $$;

COMMENT ON FUNCTION monitoring_heartbeat_touch(text) IS
  'MON-13 (0119); grace_sec dropped 202609031200 (it was written once, never updated, and never read
   — monitors.config.graceSec is the sole source of truth). Records a heartbeat for the monitor
   identified by a token HASH. SECURITY DEFINER because the ingest endpoint is unauthenticated by
   design and therefore has no tenant context; every other monitoring read goes through withTenants.
   Takes and returns no secrets, touches at most one row, pinned search_path.';

-- The trap itself: a value nothing reads, kept alive only by an INSERT that never had a matching
-- UPDATE. Dropping it makes the two representations this ticket exists to reconcile literally unable
-- to exist — there is only one place a heartbeat monitor's grace period can live from here on.
ALTER TABLE monitor_heartbeats DROP COLUMN grace_sec;
