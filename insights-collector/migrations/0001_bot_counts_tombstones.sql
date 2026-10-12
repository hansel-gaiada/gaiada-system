-- vdb schema, step 1 (M5-V2-a). The collector's own database; it holds no personal data and has no
-- column for an IP address or a user agent (a schema test in internal/store pins that).
-- No DML in this file.

-- Daily counts of traffic the collector refused to forward, by why. Aggregate only.
CREATE TABLE IF NOT EXISTS bot_counts (
  website uuid   NOT NULL,
  day     date   NOT NULL,                       -- UTC day of receipt
  reason  text   NOT NULL CHECK (reason IN ('ua', 'asn')),
  count   bigint NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (website, day, reason)
);

-- Forgotten visitors (V3-b writes and reads this; V2-a only creates it so the schema is one step).
-- Only the SHA-256 of the id is stored, never the id itself.
CREATE TABLE IF NOT EXISTS tombstones (
  website    uuid  NOT NULL,
  kind       text  NOT NULL CHECK (kind IN ('visitor', 'consent')),
  id_hash    bytea NOT NULL CHECK (octet_length(id_hash) = 32),
  reason     text  NOT NULL CHECK (reason IN ('withdraw', 'erase')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (website, kind, id_hash)
);
