-- WS11 capture edge (plan 2026-07-20 §3): the recordings registry — the durable record of every
-- client-meeting recording so the whole team can reference it. The desktop capture-helper records
-- local-first, transcribes with the local whisper service, and registers here; platform-nest then
-- PROXIES the frozen ingestion contract to n8n (so the helper never holds N8N_BRIDGE_SECRET) and,
-- separately + non-blocking, syncs the media to the company Shared Drive.
--
-- Only the transcript text travels into the pipeline (frozen contract: transcript is a string) — the
-- heavy audio/video stays local + goes to Drive. `meeting_id` is the frozen-contract dedupe key and is
-- reused as pipeline_runs.source_meeting_id downstream, so one meeting = one recording = one run.
-- Tenant-scoped under FORCE RLS on the authorized-tenant-set (mirrors 0001/0011/0017/0021).

CREATE TABLE meeting_recordings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  meeting_id text NOT NULL,                    -- stable id minted at start; frozen-contract dedupe key
  client_id uuid REFERENCES clients(id),       -- optional link to the client this meeting is with
  project_id uuid REFERENCES projects(id),     -- optional link to the project
  title text,
  kind text NOT NULL DEFAULT 'audio' CHECK (kind IN ('audio','video')),
  status text NOT NULL DEFAULT 'recording'
    CHECK (status IN ('recording','recorded','transcribing','transcribed','ingested','failed')),
  started_at timestamptz,
  ended_at timestamptz,
  duration_sec integer,
  size_bytes bigint,
  local_hint text,                             -- operator-machine path/filename (reference only; never fetched)
  transcript text,                             -- the .txt (local whisper output); what the pipeline ingests
  transcript_ref text,                         -- optional external ref (files id / Drive) for the transcript
  drive_status text NOT NULL DEFAULT 'none'
    CHECK (drive_status IN ('none','pending','uploading','synced','failed')),
  drive_file_id text,
  drive_link text,
  pipeline_run_id uuid REFERENCES pipeline_runs(id),  -- set once ingest creates/dedupes to a run
  created_by uuid REFERENCES users(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
-- One recording per meeting id per tenant (idempotent start / helper retries).
CREATE UNIQUE INDEX meeting_recordings_meeting_idx ON meeting_recordings (tenant_id, meeting_id)
  WHERE deleted_at IS NULL;
CREATE INDEX meeting_recordings_tenant_idx ON meeting_recordings (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX meeting_recordings_client_idx ON meeting_recordings (tenant_id, client_id) WHERE deleted_at IS NULL;

-- FORCE RLS + authorized-tenant-set isolation (mirrors 0001/0011/0017/0021).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['meeting_recordings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
       USING (tenant_id = ANY(string_to_array(current_setting(''app.current_tenant_ids'', true), '','')::uuid[]))
       WITH CHECK (tenant_id = ANY(string_to_array(current_setting(''app.current_tenant_ids'', true), '','')::uuid[]))',
      t
    );
  END LOOP;
END $$;
