-- WS11 §6: meeting-to-delivery pipeline state. The pipeline is orchestrated in n8n (backbone rule:
-- n8n orchestrates, mcp-hub accesses, services hold logic), but its DURABLE state lives here — not in
-- n8n Wait nodes — so multi-day human gates (PRD sign, scope sign-off, feedback review) survive n8n
-- restarts. n8n advances state via hub tools; humans act in the ADNARA ERP / client portal; a
-- `pipeline.gate.decided` / `scope.signed` event resumes the waiting workflow via the event->n8n bridge.
--
-- Four tables:
--   pipeline_runs    — one meeting -> one run, spanning the three tracks (delivery/report/scope).
--   pipeline_stages  — per-track stages (prd_extract, claude_design, prototype, claude_code, staging, ...).
--   pipeline_gates   — human-in-the-loop stops; actor_side routes to internal inbox vs client portal.
--   scope_signoffs   — dual-party scope-agreement signature ledger (both parties required).
-- All tenant-scoped under FORCE RLS on the authorized-tenant-set (mirrors 0001 / 0011 / 0014).

CREATE TABLE pipeline_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  source_meeting_id text,                     -- bot's stable meeting id (dedupe key); null for manual runs
  title text,
  mom_ref text,                               -- storage ref to the generated minutes (MOM)
  status text NOT NULL DEFAULT 'extracting'
    CHECK (status IN ('extracting','delivery_active','report_done','scope_pending','complete','blocked')),
  created_by uuid REFERENCES users(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
-- One run per meeting (when the bot supplies an id): the dispatcher dedupes, this is the backstop.
CREATE UNIQUE INDEX pipeline_runs_meeting_idx ON pipeline_runs (tenant_id, source_meeting_id)
  WHERE source_meeting_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE pipeline_stages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  run_id uuid NOT NULL REFERENCES pipeline_runs(id),
  track text NOT NULL CHECK (track IN ('delivery','report','scope')),
  name text NOT NULL,                         -- e.g. prd_extract | claude_design | prototype | claude_code | staging
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','awaiting_gate','done','failed')),
  artifact_ref text,                          -- ref to the stage output (PRD doc, prototype URL, repo, ...)
  confidence numeric,                         -- extraction confidence (0..1); a hint for PM review, not a gate
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pipeline_stages_run_idx ON pipeline_stages (tenant_id, run_id);

CREATE TABLE pipeline_gates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  run_id uuid NOT NULL REFERENCES pipeline_runs(id),
  stage_id uuid REFERENCES pipeline_stages(id),
  kind text NOT NULL
    CHECK (kind IN ('prd_review','prd_sign','pm_review','customer_feedback','pm_approval','scope_signoff')),
  actor_side text NOT NULL CHECK (actor_side IN ('internal','client')),  -- drives which surface shows it
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','decided')),
  decision text CHECK (decision IN ('approved','changes_requested','signed','rejected')),
  note text,                                  -- feedback / rejection reason
  opened_by uuid REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX pipeline_gates_pending_idx ON pipeline_gates (tenant_id, actor_side, status) WHERE deleted_at IS NULL;
CREATE INDEX pipeline_gates_run_idx ON pipeline_gates (tenant_id, run_id);

CREATE TABLE scope_signoffs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  run_id uuid NOT NULL REFERENCES pipeline_runs(id),
  gate_id uuid REFERENCES pipeline_gates(id),
  party text NOT NULL,                        -- e.g. 'provider' | 'client'; both required to complete
  signer uuid REFERENCES users(id),           -- staff signer; null when an external client is recorded by name
  signer_name text,
  signature_ref text,
  origin_site text NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scope_signoffs_party_idx ON scope_signoffs (run_id, party);

-- FORCE RLS + authorized-tenant-set isolation (mirrors 0001 / 0011 / 0014).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pipeline_runs','pipeline_stages','pipeline_gates','scope_signoffs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I FOR ALL
      USING (tenant_id = ANY(string_to_array(current_setting('app.current_tenant_ids', true), ',')::uuid[]))
      WITH CHECK (tenant_id = ANY(string_to_array(current_setting('app.current_tenant_ids', true), ',')::uuid[]))$f$, t);
  END LOOP;
END $$;
