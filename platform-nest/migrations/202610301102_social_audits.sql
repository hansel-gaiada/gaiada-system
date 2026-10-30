-- 202610301102_social_audits.sql — SCP-5g: the social audit, a client's or a prospect's scorecard.
-- Contract: docs/FRONTEND-BFF-CONTRACT.md §63.28.2 ("<prefix+4>_social_audits.sql"), with §63.30.3's `rules_ref`; plan
-- docs/plans/2026-10-15-social-content-pipeline.md SCP-Q32 (the scorecard's defaults), SCP-Q33 (a prospect lives on its
-- audit), SCP-Q34 (who writes), SCP-Q41 (the scorecard is the company's, versioned).
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────────────────
--   social_audits   one audit: `client` (an engagement and a data month) or `prospect` (a name, a business type and the
--                   public numbers typed in). A `draft` is live (the automatic part is computed on the read); `final` freezes
--                   the whole scorecard into `frozen` with the overall, band and finalizer, and is never edited or deleted.
--
-- ── rules_ref (§63.30.3) ────────────────────────────────────────────────────────────────────────────────
-- `rules_ref text NOT NULL`: the company rules the audit was made under, `'company:<version>'` (a saved version, 1 or more) or
-- `'default:<defaultsVersion>'` (the read-through seed, version 0). It replaces the former `dimensions_version`. NO default: a
-- new table has no old row to cover, so the route must name the rules it scored with. This file declares it itself and does
-- not depend on 202610301000_social_rules.sql (W5-A0); the CHECK pins the shape only, the route resolves the version.
--
-- ── NULL-SAFE CHECKS ────────────────────────────────────────────────────────────────────────────────────
-- `subject` and `status` are NOT NULL, so `subject <> 'client'` and `(status = 'final')` are never NULL; every other side is an
-- explicit `IS NULL` / `IS NOT NULL` test, and every pairing an equality of two of them (holds in both directions):
--   client   ⇒ engagement_id, month set; prospect_name NULL; public_numbers '{}';
--   prospect ⇒ prospect_name set; month NULL (engagement_id is the client it became, once attached);
--   final ⇔ finalized_at ⇔ finalized_by ⇔ frozen; overall only when final; overall ⇔ band; summary ⇔ summary_via;
--   deleted_at ⇔ deleted_by; deleted only while draft (a final audit is a record).
-- `band` is a key of the company's `audit.bands` (§63.30: 2 to 5 bands, each `{key, label, from}`), so the database checks its
-- shape, as it does a Saved category; the seeded keys `strong`, `fair` and `needs_work` all match it.
--
-- ── WALL: THE THIRD WALL ────────────────────────────────────────────────────────────────────────────────
-- `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social')` on USING and WITH CHECK, FORCE RLS, in 0105's
-- DO-loop form. Audits are internal records and never reach the portal.
--
-- ── FOREIGN KEYS ────────────────────────────────────────────────────────────────────────────────────────
-- engagement → social_engagements (composite, ux_social_engagements_id_tenant). MATCH SIMPLE: a prospect's NULL engagement is
-- not checked. Plain FKs to users for every person.
--
-- ── NO DML ──────────────────────────────────────────────────────────────────────────────────────────────
-- A new empty table. No row is read or written. The closing DO block asserts the catalogue, never a row count.
--
-- ── RE-RUNNABLE ─────────────────────────────────────────────────────────────────────────────────────────
-- CREATE TABLE/INDEX IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD, DROP POLICY IF EXISTS + CREATE. Applies on its own with
-- plain `psql -f` and again without error.
--
-- ── ROLLOUT ─────────────────────────────────────────────────────────────────────────────────────────────
-- Additive: one new empty table. Runs on boot. No deploy-order constraint: no existing code reads it.

CREATE TABLE IF NOT EXISTS social_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  subject text NOT NULL,
  -- The client; on a prospect's audit, the client it became (attach).
  engagement_id uuid,
  prospect_name text,
  -- A client's is copied from client_centre_profiles.business_type at finalize; a prospect's is typed.
  business_type text,
  -- A client audit's data month (the first of the month).
  month date,
  -- A prospect's typed public numbers `{followers, postsLast30Days, avgLikes, avgComments, lastPostOn}` (route-validated).
  public_numbers jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The typed part only: `{<key>: {score: 0..5 by halves | null, note <= 500}}` (route-validated against the rules).
  scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- At finalize: every dimension, the overall, band, fixes and the scorecard itself.
  frozen jsonb,
  overall smallint,
  band text,
  summary text,
  summary_via text,
  status text NOT NULL DEFAULT 'draft',
  rules_ref text NOT NULL,
  -- An automatic score read a simulated row (set at finalize; a draft answers it live).
  simulated boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finalized_by uuid REFERENCES users(id),
  finalized_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  CONSTRAINT ux_social_audits_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT fk_social_audits_engagement_tenant FOREIGN KEY (engagement_id, tenant_id)
    REFERENCES social_engagements (id, tenant_id)
);

ALTER TABLE social_audits
  DROP CONSTRAINT IF EXISTS social_audits_values_ck,
  ADD CONSTRAINT social_audits_values_ck CHECK (
    subject IN ('client','prospect')
    AND status IN ('draft','final')
    AND (summary_via IS NULL OR summary_via IN ('ai','template','typed'))
    AND (band IS NULL OR band ~ '^[a-z][a-z0-9_]{0,39}$')
  ),
  DROP CONSTRAINT IF EXISTS social_audits_lengths_ck,
  ADD CONSTRAINT social_audits_lengths_ck CHECK (
    (prospect_name IS NULL OR char_length(prospect_name) BETWEEN 1 AND 200)
    AND (business_type IS NULL OR char_length(business_type) <= 60)
    AND (summary IS NULL OR char_length(summary) <= 3000)
    AND (overall IS NULL OR overall BETWEEN 0 AND 100)
  ),
  DROP CONSTRAINT IF EXISTS social_audits_json_ck,
  ADD CONSTRAINT social_audits_json_ck CHECK (
    jsonb_typeof(public_numbers) = 'object'
    AND jsonb_typeof(scores) = 'object'
    AND (frozen IS NULL OR jsonb_typeof(frozen) = 'object')
  ),
  DROP CONSTRAINT IF EXISTS social_audits_rules_ref_ck,
  ADD CONSTRAINT social_audits_rules_ref_ck CHECK (
    rules_ref ~ '^(company:[1-9][0-9]{0,9}|default:[A-Za-z0-9][A-Za-z0-9._-]{0,59})$'
  ),
  -- The two subjects' shapes.
  DROP CONSTRAINT IF EXISTS social_audits_client_ck,
  ADD CONSTRAINT social_audits_client_ck CHECK (
    subject <> 'client'
    OR (engagement_id IS NOT NULL AND month IS NOT NULL AND prospect_name IS NULL AND public_numbers = '{}'::jsonb)
  ),
  DROP CONSTRAINT IF EXISTS social_audits_prospect_ck,
  ADD CONSTRAINT social_audits_prospect_ck CHECK (subject <> 'prospect' OR (prospect_name IS NOT NULL AND month IS NULL)),
  -- The first of a month. `month::timestamp` pins the immutable date_trunc(text, timestamp) overload (as social_cycles).
  DROP CONSTRAINT IF EXISTS social_audits_month_ck,
  ADD CONSTRAINT social_audits_month_ck CHECK (month IS NULL OR month = date_trunc('month', month::timestamp)::date),
  -- Final exactly when finalized, by someone, with its frozen scorecard.
  DROP CONSTRAINT IF EXISTS social_audits_finalized_at_ck,
  ADD CONSTRAINT social_audits_finalized_at_ck CHECK ((status = 'final') = (finalized_at IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS social_audits_finalized_by_ck,
  ADD CONSTRAINT social_audits_finalized_by_ck CHECK ((status = 'final') = (finalized_by IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS social_audits_frozen_ck,
  ADD CONSTRAINT social_audits_frozen_ck CHECK ((status = 'final') = (frozen IS NOT NULL)),
  -- The overall and band are set at finalize, together.
  DROP CONSTRAINT IF EXISTS social_audits_overall_ck,
  ADD CONSTRAINT social_audits_overall_ck CHECK (status = 'final' OR overall IS NULL),
  DROP CONSTRAINT IF EXISTS social_audits_band_ck,
  ADD CONSTRAINT social_audits_band_ck CHECK ((overall IS NULL) = (band IS NULL)),
  DROP CONSTRAINT IF EXISTS social_audits_summary_ck,
  ADD CONSTRAINT social_audits_summary_ck CHECK ((summary IS NULL) = (summary_via IS NULL)),
  DROP CONSTRAINT IF EXISTS social_audits_deleted_ck,
  ADD CONSTRAINT social_audits_deleted_ck CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  -- A final audit is a record and is never deleted.
  DROP CONSTRAINT IF EXISTS social_audits_deleted_draft_ck,
  ADD CONSTRAINT social_audits_deleted_draft_ck CHECK (deleted_at IS NULL OR status = 'draft');

-- One live draft per client (the route answers it with `created: false`; this index is the backstop).
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_audits_client_draft
  ON social_audits (engagement_id) WHERE subject = 'client' AND status = 'draft' AND deleted_at IS NULL;
-- The list: a company's live audits by subject and status, newest first.
CREATE INDEX IF NOT EXISTS ix_social_audits_list
  ON social_audits (tenant_id, subject, status, created_at DESC) WHERE deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the third wall, in 0105's DO-loop form (byte-identical predicate).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['social_audits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''social''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''social''))',
      t
    );
  END LOOP;
END $$;

COMMENT ON TABLE social_audits IS
  'SCP-5g (BFF 63.28): a client''s or a prospect''s social audit. A draft is live; a final audit is a frozen, dated record '
  '(never edited or deleted). rules_ref names the company rules it was made under (63.30.3). Third wall; never the portal.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- Assert, don't assume: columns, CHECK expressions, keys, indexes and the wall. Catalogue reads only.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n integer;
  missing text;
BEGIN
  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES
      ('id','uuid','NO'), ('tenant_id','uuid','NO'), ('subject','text','NO'), ('engagement_id','uuid','YES'),
      ('prospect_name','text','YES'), ('business_type','text','YES'), ('month','date','YES'),
      ('public_numbers','jsonb','NO'), ('scores','jsonb','NO'), ('frozen','jsonb','YES'), ('overall','smallint','YES'),
      ('band','text','YES'), ('summary','text','YES'), ('summary_via','text','YES'), ('status','text','NO'),
      ('rules_ref','text','NO'), ('simulated','boolean','NO'), ('created_by','uuid','NO'),
      ('created_at','timestamp with time zone','NO'), ('updated_by','uuid','YES'), ('updated_at','timestamp with time zone','NO'),
      ('finalized_by','uuid','YES'), ('finalized_at','timestamp with time zone','YES'),
      ('deleted_at','timestamp with time zone','YES'), ('deleted_by','uuid','YES'), ('origin_site','text','NO')
    ) AS want(c, ty, nul)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                      WHERE ic.table_schema = current_schema() AND ic.table_name = 'social_audits'
                        AND ic.column_name = want.c AND ic.data_type = want.ty AND ic.is_nullable = want.nul);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301102: social_audits columns missing or misshapen: %', missing;
  END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'social_audits'
     AND ((column_name = 'status' AND column_default LIKE '''draft''::text%')
       OR (column_name = 'public_numbers' AND column_default LIKE '''{}''::jsonb%')
       OR (column_name = 'scores' AND column_default LIKE '''{}''::jsonb%')
       OR (column_name = 'simulated' AND column_default = 'false')
       OR (column_name = 'rules_ref' AND column_default IS NULL));
  IF n <> 5 THEN
    RAISE EXCEPTION '202610301102: social_audits defaults (status draft, public_numbers and scores {}, simulated false, rules_ref none): % of 5 right', n;
  END IF;

  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES
      ('social_audits_values_ck', 'CHECK (((subject = ANY (ARRAY[''client''::text, ''prospect''::text])) AND (status = ANY (ARRAY[''draft''::text, ''final''::text])) AND ((summary_via IS NULL) OR (summary_via = ANY (ARRAY[''ai''::text, ''template''::text, ''typed''::text]))) AND ((band IS NULL) OR (band ~ ''^[a-z][a-z0-9_]{0,39}$''::text))))'),
      ('social_audits_lengths_ck', 'CHECK ((((prospect_name IS NULL) OR ((char_length(prospect_name) >= 1) AND (char_length(prospect_name) <= 200))) AND ((business_type IS NULL) OR (char_length(business_type) <= 60)) AND ((summary IS NULL) OR (char_length(summary) <= 3000)) AND ((overall IS NULL) OR ((overall >= 0) AND (overall <= 100)))))'),
      ('social_audits_json_ck', 'CHECK (((jsonb_typeof(public_numbers) = ''object''::text) AND (jsonb_typeof(scores) = ''object''::text) AND ((frozen IS NULL) OR (jsonb_typeof(frozen) = ''object''::text))))'),
      ('social_audits_rules_ref_ck', 'CHECK ((rules_ref ~ ''^(company:[1-9][0-9]{0,9}|default:[A-Za-z0-9][A-Za-z0-9._-]{0,59})$''::text))'),
      ('social_audits_client_ck', 'CHECK (((subject <> ''client''::text) OR ((engagement_id IS NOT NULL) AND (month IS NOT NULL) AND (prospect_name IS NULL) AND (public_numbers = ''{}''::jsonb))))'),
      ('social_audits_prospect_ck', 'CHECK (((subject <> ''prospect''::text) OR ((prospect_name IS NOT NULL) AND (month IS NULL))))'),
      ('social_audits_month_ck', 'CHECK (((month IS NULL) OR (month = (date_trunc(''month''::text, (month)::timestamp without time zone))::date)))'),
      ('social_audits_finalized_at_ck', 'CHECK (((status = ''final''::text) = (finalized_at IS NOT NULL)))'),
      ('social_audits_finalized_by_ck', 'CHECK (((status = ''final''::text) = (finalized_by IS NOT NULL)))'),
      ('social_audits_frozen_ck', 'CHECK (((status = ''final''::text) = (frozen IS NOT NULL)))'),
      ('social_audits_overall_ck', 'CHECK (((status = ''final''::text) OR (overall IS NULL)))'),
      ('social_audits_band_ck', 'CHECK (((overall IS NULL) = (band IS NULL)))'),
      ('social_audits_summary_ck', 'CHECK (((summary IS NULL) = (summary_via IS NULL)))'),
      ('social_audits_deleted_ck', 'CHECK (((deleted_at IS NULL) = (deleted_by IS NULL)))'),
      ('social_audits_deleted_draft_ck', 'CHECK (((deleted_at IS NULL) OR (status = ''draft''::text)))')
    ) AS want(c, def)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass('social_audits') AND pc.conname = want.c AND pc.contype = 'c'
                        AND pg_get_constraintdef(pc.oid) = want.def);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301102: social_audits CHECKs missing or with another expression: %', missing;
  END IF;

  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES
      ('ux_social_audits_id_tenant','UNIQUE (id, tenant_id)'),
      ('fk_social_audits_engagement_tenant','FOREIGN KEY (engagement_id, tenant_id) REFERENCES %social_engagements(id, tenant_id)')
    ) AS want(c, def)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass('social_audits') AND pc.conname = want.c AND pg_get_constraintdef(pc.oid) LIKE want.def);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301102: keys or FKs missing or misshapen: %', missing;
  END IF;

  SELECT string_agg(want.i, ', ') INTO missing
    FROM (VALUES
      ('ux_social_audits_client_draft','CREATE UNIQUE INDEX ux_social_audits_client_draft ON %social_audits USING btree (engagement_id) WHERE ((subject = ''client''::text) AND (status = ''draft''::text) AND (deleted_at IS NULL))'),
      ('ix_social_audits_list','CREATE INDEX ix_social_audits_list ON %social_audits USING btree (tenant_id, subject, status, created_at DESC) WHERE (deleted_at IS NULL)')
    ) AS want(i, def)
   WHERE NOT EXISTS (SELECT 1 FROM pg_indexes pi
                      WHERE pi.schemaname = current_schema() AND pi.tablename = 'social_audits' AND pi.indexname = want.i
                        AND pi.indexdef LIKE want.def);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301102: indexes missing or misshapen: %', missing;
  END IF;

  SELECT count(*) INTO n FROM pg_class
   WHERE oid = to_regclass('social_audits') AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301102: social_audits must have RLS ENABLED and FORCED';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = current_schema() AND tablename = 'social_audits' AND policyname = 'tenant_isolation' AND cmd = 'ALL'
     AND qual LIKE '%app_current_tenants()%' AND qual LIKE '%app_module_allowed(''social''::text)%'
     AND with_check LIKE '%app_current_tenants()%' AND with_check LIKE '%app_module_allowed(''social''::text)%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301102: social_audits needs the third-wall tenant_isolation policy on USING and WITH CHECK';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'social_audits';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301102: social_audits must carry exactly one policy, found %', n;
  END IF;
END $$;
