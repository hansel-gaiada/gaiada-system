-- vdb schema, step 2 (M5-V3-b): the consented channel's 72-hour buffer (design 4.2 step 2, 4.4, 4.7).
-- Rows exist only for visitors who accepted analytics and sent a consent id. The ERP pulls them over
-- /ops/v1/events and builds profiles there; the collector deletes every row 72 hours after receipt, and on
-- /lib/kestrel/f and /ops/v1/forget at once. There is NO column for an IP address or a user agent, and none
-- may be added: a schema test in internal/store pins that, and so does a catalogue check on the gate.
-- No DML in this file.

CREATE TABLE IF NOT EXISTS consented_events (
  id           bigserial   PRIMARY KEY,                 -- the ERP's paging cursor
  website      uuid        NOT NULL,
  visitor_id   uuid        NOT NULL,
  consent_id   uuid        NOT NULL,
  received_at  timestamptz NOT NULL,                    -- set by the collector's clock; drives the 15 s read lag and the purge
  occurred_at  timestamptz NOT NULL,                    -- the browser's time, clamped to +-10 minutes of receipt
  kind         text        NOT NULL CHECK (kind IN ('pageview', 'event')),
  path         text        NOT NULL CHECK (length(path) BETWEEN 1 AND 512),
  name         text        CHECK (length(name) <= 50),
  data         jsonb       CHECK (pg_column_size(data) <= 1024),
  device       text        NOT NULL DEFAULT 'unknown' CHECK (device IN ('desktop', 'mobile', 'tablet', 'unknown')),
  country      text        CHECK (country ~ '^[A-Z]{2}$'),
  city         text        CHECK (length(city) <= 120),
  asn          bigint      CHECK (asn BETWEEN 1 AND 4294967295),
  network_name text        CHECK (length(network_name) <= 120),
  company      jsonb       CHECK (pg_column_size(company) <= 1024),  -- the CompanyResolver result, or NULL
  -- A pageview carries a path only; an event must be named.
  CONSTRAINT consented_events_kind_name CHECK (kind <> 'event' OR name IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_consented_events_site_id  ON consented_events (website, id);
CREATE INDEX IF NOT EXISTS ix_consented_events_received ON consented_events (received_at);
CREATE INDEX IF NOT EXISTS ix_consented_events_visitor  ON consented_events (website, visitor_id);
CREATE INDEX IF NOT EXISTS ix_consented_events_consent  ON consented_events (website, consent_id);

-- The purge deletes tombstones by age.
CREATE INDEX IF NOT EXISTS ix_tombstones_created ON tombstones (created_at);
