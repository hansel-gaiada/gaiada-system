-- MON-13 fix — `monitoring_heartbeat_touch`: the ONE narrow RLS bypass the heartbeat ingest needs.
--
-- ── THE BUG THIS EXISTS TO FIX, FOUND BY A LIVE-DB TEST ─────────────────────────────────────────
-- The ingest endpoint is unauthenticated by design (a cron job or n8n flow must curl it with no
-- session, so the URL token IS the credential). With no principal there is no tenant context, so the
-- handler read `monitor_heartbeats` under `withGlobal` — where `app_current_tenants()` is EMPTY.
-- Every monitor_* table is FORCE RLS with
--     tenant_id = ANY(app_current_tenants()) AND app_module_allowed('monitoring')
-- so the SELECT returned ZERO ROWS AND REPORTED SUCCESS. The endpoint answered 200, matched nothing,
-- and could never have worked in production. Pure unit tests cannot see this: it only appears when
-- real RLS is in the loop, which is exactly why the live-DB suite was worth standing up.
--
-- ── WHY SECURITY DEFINER AND NOT A WIDER GUC ────────────────────────────────────────────────────
-- The alternatives are worse. Setting `app.current_tenant_ids` to every tenant would hand an
-- unauthenticated endpoint a cross-tenant read of the whole table. Giving the app role BYPASSRLS
-- would dissolve the third wall globally for every query it makes. So this is one function, owned by
-- the migrator, that does the lookup AND the write atomically and returns only what the caller needs.
--
-- ── WHAT KEEPS IT SAFE ──────────────────────────────────────────────────────────────────────────
--  * It takes a token HASH, never a token, and never returns one. Nothing here can leak a credential.
--  * It matches on the hash's UNIQUE index, so it can touch at most ONE row regardless of input.
--  * It returns NO tenant data beyond the ids the caller needs to record a result — no names, no
--    targets, no config.
--  * `search_path` is pinned. A SECURITY DEFINER function with a mutable search_path is the classic
--    privilege-escalation shape: a caller could shadow `monitor_heartbeats` with their own table.
--  * It is the ONLY bypass in this module. Every other monitoring read goes through withTenants.

CREATE OR REPLACE FUNCTION monitoring_heartbeat_touch(p_token_hash text)
RETURNS TABLE (monitor_id uuid, tenant_id uuid, client_id uuid, grace_sec integer, was_open boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  hb RECORD;
  closed integer := 0;
BEGIN
  SELECT h.id, h.monitor_id, h.tenant_id, h.client_id, h.grace_sec
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

  RETURN QUERY SELECT hb.monitor_id, hb.tenant_id, hb.client_id, hb.grace_sec, closed > 0;
END $$;

COMMENT ON FUNCTION monitoring_heartbeat_touch(text) IS
  'MON-13: records a heartbeat for the monitor identified by a token HASH. SECURITY DEFINER because the ingest endpoint is unauthenticated by design and therefore has no tenant context; every other monitoring read goes through withTenants. Takes and returns no secrets, touches at most one row, pinned search_path.';
