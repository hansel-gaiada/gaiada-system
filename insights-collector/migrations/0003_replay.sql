-- vdb schema, step 3 (M5-V6-a): our own sampled session replay (design 6.2). A recording exists only for a visitor
-- who accepted analytics and sent a consent id. The collector deletes it 30 days after started_at, and at once on
-- /lib/kestrel/f and /ops/v1/forget. There is NO column for an IP address or a user agent, and none may be added: a
-- schema test in internal/store pins that, and so does a catalogue check on the gate.
-- The DATA of both tables is deliberately NOT in the nightly backup (design O2): infra/sumopod/umami/backup.sh
-- excludes them by these exact names, and a test reads that script. Rename a table and that test fails.
-- No DML in this file.

CREATE TABLE IF NOT EXISTS replay_sessions (
  id            uuid        PRIMARY KEY,                -- the browser's recordingId
  website       uuid        NOT NULL,
  visitor_id    uuid        NOT NULL,
  consent_id    uuid        NOT NULL,
  started_at    timestamptz NOT NULL,                   -- the collector's clock at the first chunk; drives the 30-day purge and the 30-minute cap
  last_chunk_at timestamptz NOT NULL,
  chunks        integer     NOT NULL DEFAULT 0 CHECK (chunks >= 0),
  bytes         bigint      NOT NULL DEFAULT 0 CHECK (bytes >= 0),   -- stored (compressed) bytes; the 5 MB cap and the budget count these
  pages         text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(pages) <= 50)  -- distinct paths from the meta events, no query or hash
);

CREATE TABLE IF NOT EXISTS replay_chunks (
  session_id  uuid        NOT NULL REFERENCES replay_sessions (id) ON DELETE CASCADE,
  seq         integer     NOT NULL CHECK (seq >= 0),
  received_at timestamptz NOT NULL,
  bytes       integer     NOT NULL CHECK (bytes > 0),
  data        bytea       NOT NULL,                     -- gzip of a JSON array of rrweb events, already checked for typed input
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS ix_replay_sessions_site_started ON replay_sessions (website, started_at);
CREATE INDEX IF NOT EXISTS ix_replay_sessions_visitor      ON replay_sessions (website, visitor_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_replay_sessions_consent      ON replay_sessions (website, consent_id);
CREATE INDEX IF NOT EXISTS ix_replay_sessions_started      ON replay_sessions (started_at);
