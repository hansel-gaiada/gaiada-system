-- 202609050857_agency_discovery_intake.sql — agency discovery intake (AD-1).
--
-- Design: docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md
--   §3.1 module-wall decision · §3.3 DDL · §6 idempotency backstops · §7 PII
--
-- RLS: CORE plain tenant wall on all three tables, deliberately NOT app_module_allowed('agency').
-- The primary writer is a token-guarded, non-module surface that declares no `app.scopes`, so a
-- third wall would make every prospect write and every subsequent read return ZERO ROWS, silently
-- (0028:39-52 is a two-sided handshake). This follows MI-02's owner-ratified D-2a amendment for
-- the same reason, and the 0072:214 / 0075:242 doctrine that a client-reachable table is never
-- module-walled. What the wall would have bought is provided by Cerbos instead (design §5.2).
--
-- No DML in this migration — nothing to backfill, so the 0050 NOBYPASSRLS backfill trap does not
-- apply.

-- ─────────────────────────────────────────────────── tenant-scoped FK targets
-- 0075 §0 pattern. An FK check runs as the table owner, OUTSIDE RLS, so a single-column FK to
-- clients(id) would happily point at another tenant's row. The composite form is the actual
-- tenancy guarantee. Additive and cannot fail: id is each table's PK, so (id, tenant_id) is
-- trivially unique.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pipeline_runs', 'pm_tasks', 'projects', 'clients'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = format('ux_%s_id_tenant', t)) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT ux_%s_id_tenant UNIQUE (id, tenant_id)', t, t);
    END IF;
  END LOOP;
END $$;

-- ───────────────────────────────────────────────────────────────────── leads
-- NOT a CRM (design §1). The minimum record that lets a prospect exist long enough to be
-- converted or declined. There is no deal stage, no forecast, no value weighting here, and if the
-- group later wants sales-pipeline management it should own this table rather than this feature
-- growing into it.
CREATE TABLE agency_leads (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  org_name text NOT NULL,
  contact_name text,
  contact_email text,
  contact_phone text,
  source text NOT NULL DEFAULT 'invite' CHECK (source IN ('invite','open','staff')),
  -- Lifecycle (design §4.1).
  --   'new'       the lead exists but NO invite has been minted yet — a prospect who phoned in.
  --   'invited'   a token has been minted and sent; we are waiting on them.
  -- Those two are deliberately distinct. Collapsing them (the first draft of this design did)
  -- makes a staff-entered lead indistinguishable from one we actually contacted, so the single
  -- most droppable thing in an agency pipeline — "we met them and never sent the form" —
  -- becomes invisible in the queue. 'new' is therefore an ACTIONABLE state, not a placeholder.
  --   'nurturing' is the difference between "we said no" and "not this quarter".
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','invited','submitted','in_review','nurturing','converted','declined')),
  owner_id uuid REFERENCES users(id),
  converted_client_id uuid,
  converted_project_id uuid,
  pipeline_run_id uuid,
  declined_reason text,
  triaged_by uuid REFERENCES users(id),
  triaged_at timestamptz,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- This table is itself a composite-FK TARGET for the two child tables below, so it needs its own
  -- (id, tenant_id) unique — the 0075 §0 pattern applied to a table created in the same migration.
  -- Without it Postgres refuses the children's FKs outright ("no unique constraint matching given
  -- keys"), which is the loud failure; the quiet one would be shipping single-column FKs instead
  -- and losing the cross-tenant guarantee.
  CONSTRAINT ux_agency_leads_id_tenant UNIQUE (id, tenant_id),
  -- STRUCTURAL state machine, not controller discipline (the 0075 doctrine: bake it into the DDL).
  -- "converted with no client" and "declined with no reason" are both unrepresentable, rather than
  -- merely untested.
  CONSTRAINT lead_converted_has_client CHECK (
    (status = 'converted') = (converted_client_id IS NOT NULL)
  ),
  CONSTRAINT lead_declined_has_reason CHECK (
    status <> 'declined' OR declined_reason IS NOT NULL
  ),
  CONSTRAINT fk_lead_client_tenant  FOREIGN KEY (converted_client_id, tenant_id)  REFERENCES clients (id, tenant_id),
  CONSTRAINT fk_lead_project_tenant FOREIGN KEY (converted_project_id, tenant_id) REFERENCES projects (id, tenant_id),
  CONSTRAINT fk_lead_run_tenant     FOREIGN KEY (pipeline_run_id, tenant_id)      REFERENCES pipeline_runs (id, tenant_id)
);

-- Trap #6 (NULL defeats UNIQUE): both backstops are PARTIAL uniques over the non-null set, the
-- 0072:73 / 0075:148 house pattern. A plain UNIQUE on a nullable column constrains nothing.
-- These are the schema half of the convert idempotency story (design §6.2) — a second client or a
-- second run can never be LINKED to a lead, even by a future hand-written path (the 0052
-- philosophy: make the duplicate physically impossible, not merely unlikely).
CREATE UNIQUE INDEX ux_lead_client ON agency_leads (converted_client_id) WHERE converted_client_id IS NOT NULL;
CREATE UNIQUE INDEX ux_lead_run    ON agency_leads (pipeline_run_id)     WHERE pipeline_run_id IS NOT NULL;

CREATE INDEX ix_lead_queue ON agency_leads (tenant_id, status)   WHERE deleted_at IS NULL;
CREATE INDEX ix_lead_owner ON agency_leads (tenant_id, owner_id) WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────── intake tokens
-- The access model (design §2). This endpoint is NOT unauthenticated — it is authenticated by a
-- capability token rather than a platform session. The token carries the tenant, so tenancy is
-- never guessed from a body or a Host header.
CREATE TABLE agency_intake_tokens (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  lead_id uuid,
  -- 'open' (a long-lived per-tenant key for cold inbound) is SCHEMA-ADMITTED here but REFUSED by
  -- the v1 endpoint, so enabling it later needs no migration — the same move MI-02 made for its
  -- 'control_plane' route. It is not a flag flip: it needs bot defence, a per-IP limit and a
  -- quarantine state before junk can reach the triage queue (AD-9).
  kind text NOT NULL CHECK (kind IN ('invite','open')),
  -- SHA-256 of the plaintext. The plaintext exists once, in the mint response. A leaked database
  -- therefore leaks no working links. Mirrors the credential-reveal discipline in
  -- core/connection-reveal.ts.
  token_hash bytea NOT NULL,
  expires_at timestamptz,
  used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES users(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tok_invite_has_lead CHECK ((kind = 'invite') = (lead_id IS NOT NULL)),
  CONSTRAINT fk_tok_lead_tenant FOREIGN KEY (lead_id, tenant_id) REFERENCES agency_leads (id, tenant_id)
);

-- Lookup is BY HASH and this is the entire read path for the guard. UNIQUE so that a collision
-- cannot silently authenticate the wrong lead.
CREATE UNIQUE INDEX ux_tok_hash ON agency_intake_tokens (token_hash);
CREATE INDEX ix_tok_lead ON agency_intake_tokens (tenant_id, lead_id) WHERE lead_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────── submissions
-- An IMMUTABLE document (design §3.2): what the prospect actually said, at a point in time.
-- Deliberately separate from agency_leads, which is mutable state. Conflating them would mean
-- triage mutates the record of the client's own words — and those words are the evidentiary basis
-- of scope. Corrections arrive as a NEW row with supersedes_id set; both are kept.
CREATE TABLE agency_discovery_submissions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  lead_id uuid NOT NULL,
  token_id uuid REFERENCES agency_intake_tokens(id),
  -- A stored answer set is meaningless without knowing which question set produced it.
  schema_version text NOT NULL,
  -- Keyed by the form's stable machine ids. JSONB, not 122 columns: the question set WILL change
  -- (per vertical, per rewording) and a column-per-question schema turns every edit into a
  -- migration. Readers MUST distinguish "key absent" from "answered empty" — the review UI depends
  -- on showing what the prospect did NOT tell us.
  answers jsonb NOT NULL,
  -- Submission-time facts, kept out of `answers` so that column stays purely the client's words.
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- App-written, NOT generated columns. A GENERATED expression must be provably IMMUTABLE and the
  -- jsonpath route is not worth gambling on a migration that cannot be rehearsed locally (the
  -- 16-container stack is off by owner decision). The row is INSERT-only, so an app-written count
  -- cannot drift the way it could on a mutable row.
  answered_count int NOT NULL DEFAULT 0,
  required_answered int NOT NULL DEFAULT 0,
  required_total int NOT NULL DEFAULT 0,
  supersedes_id uuid REFERENCES agency_discovery_submissions(id),
  -- Count returned by scrubText() (design §7). Stored so a reviewer can SEE that scrubbing ran,
  -- rather than assuming it.
  redactions int NOT NULL DEFAULT 0,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_sub_lead_tenant FOREIGN KEY (lead_id, tenant_id) REFERENCES agency_leads (id, tenant_id)
);

CREATE INDEX ix_sub_lead ON agency_discovery_submissions (tenant_id, lead_id, created_at DESC);
-- A token is single-submission (design §2.1). The schema half of the submit idempotency story;
-- the transition half is the used_at re-check under advisory lock (design §6.1).
CREATE UNIQUE INDEX ux_sub_token ON agency_discovery_submissions (token_id) WHERE token_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────── RLS
-- Plain tenant wall on all three. NO app_module_allowed() (see the header). NULLIF hardening per
-- 0025: without it, an unset app.current_tenant_ids makes string_to_array('') yield {''} and the
-- comparison errors rather than failing closed.
-- No principal_lookup policy: unlike client_contacts (0072 §7b), nothing here is read during
-- principal assembly — every read runs under withTenants.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agency_leads','agency_intake_tokens','agency_discovery_submissions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I FOR ALL
        USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
        WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
    $f$, t);
  END LOOP;
END $$;
