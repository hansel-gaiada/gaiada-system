-- M5-P2 — Google Ads click conversions + enhanced conversions for leads, uploaded from `search` when a lead changes stage.
-- Design: docs/plans/2026-10-11-m5-lead-pipeline-design.md §7 (what P1 hands over), §8 (the P2 interface), §1 D8.
--
-- Two tables, both tenant-scoped and `search`-module-scoped, no existing object touched:
--
--   search_conversion_targets  — per (tenant, WebDesk site slug, platform, stage): WHICH conversion a stage change maps to
--                                (the Google conversion action) and whether the deal value is sent. No target = skip, silently.
--   search_conversion_uploads  — the LEDGER. One row per (tenant, platform, stage event). Inserting the claim row IS the claim:
--                                a partial UNIQUE on (tenant, platform, submission_ref, conversion_key) WHERE status <> 'skipped'
--                                means a lead that regresses and advances again can never upload twice (design §8.5).
--
-- THE LEDGER NEVER HOLDS PERSONAL DATA. It stores ids, the stage, the conversion key, the deal value and currency, a status and a
-- typed reason. It never stores an email, a phone, a name, a hash of either, or a click id (gclid / gbraid / wbraid), and none of
-- those are put into the WS4 approval's `tool_args` either. The identifiers are read from the lead at execution time, hashed in
-- memory and sent; nothing about them is written down. `outcome` records WHAT KIND of identifier would be sent (for example
-- `["gclid","email"]`), never the value.
--
-- No FOREIGN KEY from the ledger to agency_leads, on purpose. The retention purge (M5-G5) hard-deletes a lead, and the ledger is the
-- evidence of what was sent to a third party and the de-duplication record. A FK would either block the purge or delete that evidence
-- with it. The ledger's ids are pseudonymous and carry no contact data. (Counsel / the owner: whether `submission_ref` here must also
-- be erased on a DSR is a question for the G5 owner; it identifies no one by itself.)
--
-- Status machine of a ledger row:
--   pending_approval -> executing -> simulated | uploaded | failed          (a human approved; executed in-band at decide())
--   pending_approval -> rejected                                           (a human refused: the claim STAYS, nobody is asked again)
--   pending_approval -> skipped                                            (the gate failed again at execution; the claim is released)
--   (no row) -> skipped                                                    (the gate failed at planning: consent, suppression, no identifier ...)
-- `skipped` is the only status outside the claim index, so a skipped attempt never blocks a later one.
--
-- RLS: the same third wall as every search_* table: tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search'),
-- FORCE ROW LEVEL SECURITY. Reach it only through withTenants([t], fn, { modules: ['search'] }); without the scope it reads ZERO
-- rows with no error. `property_id` and `target_id` are FKs checked as the table owner, outside RLS, so the BFF validates the
-- property through RLS BEFORE inserting (the controller does).
--
-- No data DML, no backfill: nothing here touches an existing row, so the RLS zero-row trap does not apply. To undo:
-- DROP TABLE search_conversion_uploads; DROP TABLE search_conversion_targets.

CREATE TABLE search_conversion_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),   -- where the platform account (Google connection + Ads customer) comes from
  web_site_slug text NOT NULL CHECK (web_site_slug ~ '^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$'),   -- agency_leads.web_site_slug
  platform text NOT NULL CHECK (platform IN ('google_ads','meta_capi','linkedin_capi')),
  stage_key text NOT NULL REFERENCES agency_lead_stages(key),   -- global reference table, no RLS
  conversion_key text NOT NULL CHECK (conversion_key ~ '^[a-z][a-z0-9_]{0,63}$'),   -- OUR name for it; part of the de-dupe key
  conversion_action text NOT NULL CHECK (char_length(conversion_action) BETWEEN 1 AND 300),   -- Google: a conversionActions resource name or its numeric id
  send_value boolean NOT NULL DEFAULT false,                    -- O4: the deal value rides the upload only when the target says so AND it is set
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX ux_search_conv_target
  ON search_conversion_targets (tenant_id, web_site_slug, platform, stage_key) WHERE deleted_at IS NULL;
CREATE INDEX ix_search_conv_target_property ON search_conversion_targets (tenant_id, property_id) WHERE deleted_at IS NULL;

CREATE TABLE search_conversion_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  target_id uuid REFERENCES search_conversion_targets(id),
  platform text NOT NULL CHECK (platform IN ('google_ads','meta_capi','linkedin_capi')),
  lead_id uuid NOT NULL,                       -- deliberately no FK (see the header)
  stage_event_id uuid NOT NULL,                -- agency_lead_stage_events.id: the consumer's idempotency key
  submission_ref uuid NOT NULL,                -- the WebDesk submission id: the de-duplication key across stage changes
  stage text NOT NULL,                         -- the stage the lead moved INTO
  conversion_key text NOT NULL CHECK (conversion_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  deal_value numeric(20,4),                    -- only when the target sends value AND the lead had one at the stage change
  deal_currency text REFERENCES finance_currencies(code),
  status text NOT NULL CHECK (status IN ('pending_approval','executing','simulated','uploaded','failed','rejected','skipped')),
  reason text,                                 -- a typed snake_case token: why skipped, or how it failed. Never user text.
  mode text CHECK (mode IS NULL OR mode IN ('simulate','live')),   -- set when execution starts
  approval_id uuid REFERENCES automation_approvals(id),
  content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),   -- sha256 of the ids, platform, key, value, currency
  outcome jsonb,                               -- non-personal summary of what was (or WOULD be) sent: kinds of identifier, whether a value rode along
  occurred_at timestamptz NOT NULL,            -- the stage change's own time (becomes conversion_date_time)
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_conv_deal_pair CHECK ((deal_value IS NULL) = (deal_currency IS NULL)),
  CONSTRAINT search_conv_deal_nonneg CHECK (deal_value IS NULL OR deal_value >= 0),
  CONSTRAINT search_conv_reason_required CHECK (status NOT IN ('skipped','failed') OR reason IS NOT NULL),
  CONSTRAINT search_conv_outcome_object CHECK (outcome IS NULL OR jsonb_typeof(outcome) = 'object')
);
-- One row per stage event per platform: a redelivered event converges on the row it already wrote (skipped rows included).
CREATE UNIQUE INDEX ux_search_conv_stage_event ON search_conversion_uploads (tenant_id, platform, stage_event_id);
-- THE CLAIM (design §8.5). Everything except `skipped` holds the slot, so a pending, rejected, failed or sent conversion for this
-- submission and conversion key blocks every later attempt: a lead that regresses and advances again never uploads twice.
CREATE UNIQUE INDEX ux_search_conv_claim
  ON search_conversion_uploads (tenant_id, platform, submission_ref, conversion_key) WHERE status <> 'skipped';
CREATE UNIQUE INDEX ux_search_conv_approval ON search_conversion_uploads (approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX ix_search_conv_lead ON search_conversion_uploads (tenant_id, lead_id, created_at DESC);
CREATE INDEX ix_search_conv_property ON search_conversion_uploads (tenant_id, property_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['search_conversion_targets', 'search_conversion_uploads'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))', t);
  END LOOP;
END $$;

COMMENT ON TABLE search_conversion_uploads IS
  'M5-P2: the ledger of ad-platform conversion uploads for lead stage changes (Google Ads first). The insert of a non-skipped row is the '
  'claim that de-duplicates by submission. Holds ids, stage, value, currency, status and typed reasons ONLY: never an email, phone, name, '
  'hash of either, or a click id. Each upload needs its own WS4 approval (origin search, workflow search.conversions.upload).';

-- Self-assertions (pg_catalog has no RLS, so these fire under the non-superuser migrator too).
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'search_conversion_uploads' AND indexname IN ('ux_search_conv_claim', 'ux_search_conv_stage_event', 'ux_search_conv_approval');
  IF n <> 3 THEN RAISE EXCEPTION 'M5-P2: expected the three unique indexes on search_conversion_uploads, found %', n; END IF;
  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'search_conversion_uploads' AND indexname = 'ux_search_conv_claim' AND indexdef ILIKE '%WHERE%skipped%';
  IF n <> 1 THEN RAISE EXCEPTION 'M5-P2: the claim index must be partial on status <> skipped'; END IF;
  SELECT count(*) INTO n FROM pg_class WHERE relname IN ('search_conversion_targets', 'search_conversion_uploads') AND relforcerowsecurity;
  IF n <> 2 THEN RAISE EXCEPTION 'M5-P2: both conversion tables must FORCE row level security, found %', n; END IF;
END $$;
