-- DW-8g (docs/FRONTEND-BFF-CONTRACT.md §47.1; plan docs/plans/2026-10-13-department-workspaces.md §8.1, row 8g):
-- CALENDAR EVENTS AND MEETING SCHEDULING.
--
--   1. calendar_events          - one row per event on a company's calendar. A timed event carries starts_at/ends_at
--                                 (UTC instants); an all-day event carries starts_on/ends_on (inclusive dates). A meeting
--                                 is an event that links the scheduled recording it created (meeting_recording_id).
--   2. calendar_event_attendees - who is invited and how they answered. The organizer is always a row, answered
--                                 `accepted` (the service guarantees it; the table does not).
--
-- ── THE CHECKS, AND THE NULL TRAP ────────────────────────────────────────────────────────────────
-- A CHECK passes when its expression is NULL. Every rule below is therefore written so that it can never evaluate to NULL
-- on a row that should be refused: the time shape is a set of IS [NOT] NULL tests (never NULL), the span rules open with
-- `starts_at IS NULL OR` / `starts_on IS NULL OR`, and the cancelled rule compares two booleans with IS NOT DISTINCT FROM
-- instead of `=` (status is NOT NULL here, but the rule must not depend on that).
--
-- ── FOREIGN KEYS ─────────────────────────────────────────────────────────────────────────────────
--   * meeting_recording_id is UNIQUE (one recording serves at most one event) and its FK is composite
--     (meeting_recording_id, tenant_id) -> meeting_recordings (id, tenant_id) (ux_meeting_recordings_id_tenant,
--     202610122330), so a link can never cross companies. With the column NULL the FK is not checked (MATCH SIMPLE).
--   * project_id is composite for the same reason (ux_projects_id_tenant, 0056). client_id is a plain FK: clients has no
--     (id, tenant_id) unique, and the service validates the client against the tenant (RLS) before it writes.
--
-- Pure DDL. The Cerbos kind's permission seed is the NEXT migration (202610150410).

-- ── 1 · calendar_events ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 5000),
  -- exactly one of the two time shapes (see calendar_events_time_shape_ck)
  starts_at timestamptz,
  ends_at timestamptz,
  starts_on date,
  ends_on date,
  location text CHECK (location IS NULL OR char_length(location) <= 300),
  video_url text CHECK (video_url IS NULL OR (video_url ~ '^https://' AND char_length(video_url) <= 2048)),
  organizer_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL DEFAULT 'attendees' CHECK (visibility IN ('attendees', 'company')),
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  cancelled_at timestamptz,
  client_id uuid REFERENCES clients(id),
  project_id uuid,
  meeting_recording_id uuid,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_events_time_shape_ck CHECK (
    (starts_at IS NOT NULL AND ends_at IS NOT NULL AND starts_on IS NULL AND ends_on IS NULL)
    OR (starts_at IS NULL AND ends_at IS NULL AND starts_on IS NOT NULL AND ends_on IS NOT NULL)
  ),
  CONSTRAINT calendar_events_timed_span_ck CHECK (
    starts_at IS NULL OR (ends_at > starts_at AND ends_at - starts_at <= interval '14 days')
  ),
  CONSTRAINT calendar_events_allday_span_ck CHECK (starts_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT calendar_events_cancelled_ck CHECK ((status = 'cancelled') IS NOT DISTINCT FROM (cancelled_at IS NOT NULL)),
  CONSTRAINT ux_calendar_events_recording UNIQUE (meeting_recording_id),
  CONSTRAINT fk_calendar_events_recording_tenant FOREIGN KEY (meeting_recording_id, tenant_id)
    REFERENCES meeting_recordings (id, tenant_id),
  CONSTRAINT fk_calendar_events_project_tenant FOREIGN KEY (project_id, tenant_id)
    REFERENCES projects (id, tenant_id),
  CONSTRAINT ux_calendar_events_id_tenant UNIQUE (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS ix_calendar_events_starts_at ON calendar_events (tenant_id, starts_at);
CREATE INDEX IF NOT EXISTS ix_calendar_events_starts_on ON calendar_events (tenant_id, starts_on);
CREATE INDEX IF NOT EXISTS ix_calendar_events_organizer ON calendar_events (tenant_id, organizer_id);

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON calendar_events;
CREATE POLICY tenant_isolation ON calendar_events FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ── 2 · calendar_event_attendees ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_event_attendees (
  event_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  response text NOT NULL DEFAULT 'needs_action' CHECK (response IN ('needs_action', 'accepted', 'declined', 'tentative')),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id),
  CONSTRAINT fk_calendar_event_attendees_event_tenant FOREIGN KEY (event_id, tenant_id)
    REFERENCES calendar_events (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS ix_calendar_event_attendees_user ON calendar_event_attendees (user_id);

ALTER TABLE calendar_event_attendees ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_event_attendees FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON calendar_event_attendees;
CREATE POLICY tenant_isolation ON calendar_event_attendees FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['calendar_events', 'calendar_event_attendees'] LOOP
    SELECT count(*) INTO n FROM pg_class WHERE relname = t AND relrowsecurity AND relforcerowsecurity;
    IF n <> 1 THEN
      RAISE EXCEPTION '202610150400: % must exist with RLS ENABLED and FORCED', t;
    END IF;
    SELECT count(*) INTO n FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation';
    IF n <> 1 THEN
      RAISE EXCEPTION '202610150400: % needs exactly one tenant_isolation policy, found %', t, n;
    END IF;
  END LOOP;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'calendar_events'::regclass
     AND conname IN ('calendar_events_time_shape_ck', 'calendar_events_timed_span_ck', 'calendar_events_allday_span_ck',
                     'calendar_events_cancelled_ck', 'ux_calendar_events_recording',
                     'fk_calendar_events_recording_tenant', 'fk_calendar_events_project_tenant');
  IF n <> 7 THEN
    RAISE EXCEPTION '202610150400: calendar_events should carry its 4 CHECKs, the recording UNIQUE and the two tenant FKs, found % of 7', n;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE indexname IN ('ix_calendar_events_starts_at', 'ix_calendar_events_starts_on', 'ix_calendar_event_attendees_user');
  IF n <> 3 THEN
    RAISE EXCEPTION '202610150400: the three calendar lookup indexes are missing (found % of 3)', n;
  END IF;

  RAISE NOTICE '202610150400: calendar_events and calendar_event_attendees are in place';
END $$;
