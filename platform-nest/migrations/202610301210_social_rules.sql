-- 202610301210_social_rules.sql — SCP-5 W5-A0: the company rules (SCP-Q41). Each company sets its own SCP-5 rules in Settings, and
-- the owner's rulings SCP-Q25 to SCP-Q40 are the seeded defaults (platform-nest/src/modules/social/social-rules-defaults.json).
-- Contract: docs/FRONTEND-BFF-CONTRACT.md §63.30.3 ("<prefix+7>_social_rules.sql", landing before the other wave-5 files); plan
-- docs/plans/2026-10-15-social-content-pipeline.md §7 wave 5, row W5-A0. The reader, the validation and the routes are
-- src/modules/social/pipeline/rules.ts and rules.controller.ts.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────────────────────────────────────────────────────
-- (1) social_rule_versions (new; the THIRD wall, as every social_* table): one row per save, the whole rules document.
--       tenant_id, version   uuid NOT NULL -> companies, integer NOT NULL; PRIMARY KEY (tenant_id, version); version >= 1.
--       rules                jsonb NOT NULL, an object (CHECK jsonb_typeof = 'object'); its contents are the server's to validate.
--       section              text NOT NULL, one of reports | ideas | cycle | audit | saved: the section this version changed.
--       reset                boolean NOT NULL DEFAULT false: the section was set back to the seed.
--       defaults_version     text NOT NULL, a version token (^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$): the seed the edit was made against.
--       effective_from       timestamptz NOT NULL DEFAULT now().
--       edited_by            uuid NOT NULL -> users: a version always names who saved it.
--       origin_site          text NOT NULL DEFAULT 'central', as usual.
--     APPEND-ONLY: a BEFORE UPDATE OR DELETE row trigger raises (the 0087 shape), so no version is ever rewritten.
--     CONSECUTIVE PER COMPANY: a BEFORE INSERT row trigger refuses any version but the company's latest + 1 (1 for the first). The
--     route also takes pg_advisory_xact_lock('social_rules:<tenantId>') and checks expectedVersion; two inserts racing past both
--     would still collide on the primary key, so a version number is never taken twice. The trigger reads the table as the
--     inserting session: the policy's WITH CHECK already holds the row to a tenant and module scope that can read that company's
--     rows, so the max it sees is the company's own.
--     NO ROW means the seed: a company that never saved reads the seed file as version 0, and nothing is written until a save.
-- (2) rules_ref text NOT NULL DEFAULT 'default:scp-5a' on social_reports and social_cycles: the rules the record was made under,
--     'company:<version>' or 'default:<defaultsVersion>' (CHECK on the shape, the same expression W5-B1 gives social_audits.rules_ref;
--     a CHECK cannot know which versions exist, so the server reads it, rules.ts rulesByRef). social_report_runs and social_audits
--     declare theirs in their own files. No constraint on social_reports other than the CHECK is added here (W5-B1's ideas file adds
--     ux_social_reports_id_tenant).
--
-- ── THE NULL CASES ────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Every new column is NOT NULL, so no CHECK below can pass on a NULL (a CHECK passes on NULL): SQL NULL is refused by NOT NULL
-- (23502) and a JSON null in `rules` by the object CHECK (23514).
--
-- ── NO DML, AND THE BACKFILL RULE ─────────────────────────────────────────────────────────────────────────────────────────
-- No row is read or written. `rules_ref` is added with a CONSTANT default, which Postgres records in the catalogue: every existing
-- social_reports and social_cycles row reads 'default:scp-5a' (the seed's monthly rules as SCP-5a built them) without being
-- rewritten. The default stays on the column, so a writer that does not name the column yet (a test fixture, a path a later
-- wave-5 ticket moves onto the rules) still writes a row that reads as SCP-5a's rules; the report create and the cycle write set it
-- from the company's rules (rules.ts rulesRefFor). The RLS zero-row trap (an unset tenant GUC reads zero rows of a FORCE-RLS table)
-- cannot bite: nothing here counts rows. The closing DO block asserts the catalogue, never a row count.
--
-- ── RE-RUNNABLE ───────────────────────────────────────────────────────────────────────────────────────────────────────────
-- CREATE TABLE / INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER / CONSTRAINT / POLICY IF EXISTS + CREATE, ADD COLUMN
-- IF NOT EXISTS. Applies on its own with plain `psql -f` (CI's sync-engine-go job applies every migration that way, with no ledger)
-- and again without error. No table here is in the sync-engine's write-back registry, so nothing reaches a replica.
--
-- ── GRANTS ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- No in-migration GRANT: runtime DML grants come from the owner's ALTER DEFAULT PRIVILEGES and migrate.ts's RUNTIME_GRANTS_SQL pass,
-- exactly as for the other social tables. The append-only trigger, not a missing grant, is what refuses UPDATE and DELETE.
--
-- ── ROLLOUT ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Additive. Runs on boot; the two ALTERs take a brief ACCESS EXCLUSIVE lock on small tables and validate one CHECK over their rows
-- (all holding the default). No Cerbos change (PERMISSION §57), so the deploy needs no Cerbos restart.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) social_rule_versions
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS social_rule_versions (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  version integer NOT NULL,
  rules jsonb NOT NULL,
  section text NOT NULL,
  reset boolean NOT NULL DEFAULT false,
  defaults_version text NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  edited_by uuid NOT NULL REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  CONSTRAINT pk_social_rule_versions PRIMARY KEY (tenant_id, version),
  CONSTRAINT social_rule_versions_version_ck CHECK (version >= 1),
  CONSTRAINT social_rule_versions_rules_ck CHECK (jsonb_typeof(rules) = 'object'),
  CONSTRAINT social_rule_versions_section_ck CHECK (section IN ('reports','ideas','cycle','audit','saved')),
  CONSTRAINT social_rule_versions_defaults_version_ck CHECK (defaults_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$')
);
-- The history filtered by section, newest first (GET rules/versions?section=, and GET rules' last change per section).
CREATE INDEX IF NOT EXISTS ix_social_rule_versions_section
  ON social_rule_versions (tenant_id, section, version DESC);

CREATE OR REPLACE FUNCTION social_rule_versions_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'social_rule_versions is append-only: % is not permitted (tenant_id=%, version=%)', TG_OP, OLD.tenant_id, OLD.version;
END $$;
DROP TRIGGER IF EXISTS trg_social_rule_versions_append_only ON social_rule_versions;
CREATE TRIGGER trg_social_rule_versions_append_only
  BEFORE UPDATE OR DELETE ON social_rule_versions
  FOR EACH ROW EXECUTE FUNCTION social_rule_versions_append_only();

CREATE OR REPLACE FUNCTION social_rule_versions_consecutive() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
BEGIN
  SELECT max(version) INTO latest FROM social_rule_versions WHERE tenant_id = NEW.tenant_id;
  IF NEW.version IS DISTINCT FROM coalesce(latest, 0) + 1 THEN
    RAISE EXCEPTION 'social_rule_versions: version % is not consecutive (the company''s latest is %)', NEW.version, coalesce(latest, 0)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_social_rule_versions_consecutive ON social_rule_versions;
CREATE TRIGGER trg_social_rule_versions_consecutive
  BEFORE INSERT ON social_rule_versions
  FOR EACH ROW EXECUTE FUNCTION social_rule_versions_consecutive();

-- FORCE RLS + the third wall, in 0105's form (byte-identical predicate).
ALTER TABLE social_rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_rule_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON social_rule_versions;
CREATE POLICY tenant_isolation ON social_rule_versions FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social'));

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) rules_ref on social_reports and social_cycles
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE social_reports
  ADD COLUMN IF NOT EXISTS rules_ref text NOT NULL DEFAULT 'default:scp-5a';
ALTER TABLE social_reports
  DROP CONSTRAINT IF EXISTS social_reports_rules_ref_ck,
  ADD CONSTRAINT social_reports_rules_ref_ck
    CHECK (rules_ref ~ '^(company:[1-9][0-9]{0,9}|default:[A-Za-z0-9][A-Za-z0-9._-]{0,59})$');

ALTER TABLE social_cycles
  ADD COLUMN IF NOT EXISTS rules_ref text NOT NULL DEFAULT 'default:scp-5a';
ALTER TABLE social_cycles
  DROP CONSTRAINT IF EXISTS social_cycles_rules_ref_ck,
  ADD CONSTRAINT social_cycles_rules_ref_ck
    CHECK (rules_ref ~ '^(company:[1-9][0-9]{0,9}|default:[A-Za-z0-9][A-Za-z0-9._-]{0,59})$');

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Assert, don't assume: the columns, the CHECKs, the key, the triggers and the walls. Catalogue reads only.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n integer;
BEGIN
  -- social_rule_versions: the nine columns, their types and nullability.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'social_rule_versions' AND is_nullable = 'NO'
     AND ((column_name = 'tenant_id' AND data_type = 'uuid')
       OR (column_name = 'version' AND data_type = 'integer')
       OR (column_name = 'rules' AND data_type = 'jsonb')
       OR (column_name = 'section' AND data_type = 'text')
       OR (column_name = 'reset' AND data_type = 'boolean' AND column_default = 'false')
       OR (column_name = 'defaults_version' AND data_type = 'text')
       OR (column_name = 'effective_from' AND data_type = 'timestamp with time zone' AND column_default = 'now()')
       OR (column_name = 'edited_by' AND data_type = 'uuid')
       OR (column_name = 'origin_site' AND data_type = 'text'));
  IF n <> 9 THEN
    RAISE EXCEPTION '202610301210: social_rule_versions needs its nine NOT NULL columns with their types, found % of 9 right', n;
  END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'social_rule_versions';
  IF n <> 9 THEN
    RAISE EXCEPTION '202610301210: social_rule_versions must hold exactly nine columns, found %', n;
  END IF;

  -- The key, the CHECKs with their exact expressions, and the two foreign keys.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = to_regclass('social_rule_versions')
     AND ((conname = 'pk_social_rule_versions' AND contype = 'p' AND pg_get_constraintdef(oid) = 'PRIMARY KEY (tenant_id, version)')
       OR (conname = 'social_rule_versions_version_ck' AND pg_get_constraintdef(oid) = 'CHECK ((version >= 1))')
       OR (conname = 'social_rule_versions_rules_ck' AND pg_get_constraintdef(oid) = 'CHECK ((jsonb_typeof(rules) = ''object''::text))')
       OR (conname = 'social_rule_versions_section_ck' AND pg_get_constraintdef(oid) LIKE 'CHECK ((section = ANY (ARRAY[''reports''::text, ''ideas''::text, ''cycle''::text, ''audit''::text, ''saved''::text])))')
       OR (conname = 'social_rule_versions_defaults_version_ck' AND contype = 'c'));
  IF n <> 5 THEN
    RAISE EXCEPTION '202610301210: social_rule_versions needs its key and four CHECKs with their exact expressions, found % of 5', n;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = to_regclass('social_rule_versions') AND contype = 'f'
     AND confrelid IN (to_regclass('companies'), to_regclass('users'));
  IF n <> 2 THEN
    RAISE EXCEPTION '202610301210: social_rule_versions needs its foreign keys to companies and users, found % of 2', n;
  END IF;

  -- The two row triggers: append-only (BEFORE UPDATE OR DELETE) and consecutive (BEFORE INSERT).
  SELECT count(*) INTO n FROM pg_trigger tg
   WHERE tg.tgrelid = to_regclass('social_rule_versions') AND NOT tg.tgisinternal
     AND ((tg.tgname = 'trg_social_rule_versions_append_only'
           AND (tg.tgtype & 1) = 1 AND (tg.tgtype & 2) = 2 AND (tg.tgtype & 8) = 8 AND (tg.tgtype & 16) = 16 AND (tg.tgtype & 4) = 0)
       OR (tg.tgname = 'trg_social_rule_versions_consecutive'
           AND (tg.tgtype & 1) = 1 AND (tg.tgtype & 2) = 2 AND (tg.tgtype & 4) = 4 AND (tg.tgtype & 8) = 0 AND (tg.tgtype & 16) = 0));
  IF n <> 2 THEN
    RAISE EXCEPTION '202610301210: social_rule_versions needs its BEFORE UPDATE OR DELETE and BEFORE INSERT row triggers, found % of 2', n;
  END IF;

  -- The third wall: RLS enabled and forced, one policy, the composed tenant + module predicate on USING and WITH CHECK.
  SELECT count(*) INTO n FROM pg_class
   WHERE oid = to_regclass('social_rule_versions') AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301210: social_rule_versions must have RLS ENABLED and FORCED';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = current_schema() AND tablename = 'social_rule_versions' AND policyname = 'tenant_isolation'
     AND qual LIKE '%app_current_tenants()%' AND qual LIKE '%app_module_allowed(''social''::text)%'
     AND with_check LIKE '%app_current_tenants()%' AND with_check LIKE '%app_module_allowed(''social''::text)%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301210: social_rule_versions needs the composed tenant + module policy on USING and WITH CHECK';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'social_rule_versions';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301210: social_rule_versions must carry exactly one policy, found %', n;
  END IF;

  -- rules_ref on both tables: text NOT NULL DEFAULT 'default:scp-5a', and its shape CHECK.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name IN ('social_reports', 'social_cycles') AND column_name = 'rules_ref'
     AND data_type = 'text' AND is_nullable = 'NO' AND column_default LIKE '''default:scp-5a''%';
  IF n <> 2 THEN
    RAISE EXCEPTION '202610301210: social_reports and social_cycles need rules_ref text NOT NULL DEFAULT ''default:scp-5a'', found % of 2', n;
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'c'
     AND ((conrelid = to_regclass('social_reports') AND conname = 'social_reports_rules_ref_ck')
       OR (conrelid = to_regclass('social_cycles') AND conname = 'social_cycles_rules_ref_ck'))
     AND pg_get_constraintdef(oid) LIKE '%company:[1-9][0-9]{0,9}|default:[A-Za-z0-9][A-Za-z0-9._-]{0,59}%';
  IF n <> 2 THEN
    RAISE EXCEPTION '202610301210: social_reports_rules_ref_ck and social_cycles_rules_ref_ck must hold the ref shape, found % of 2', n;
  END IF;

  -- The walls of the two existing tables are untouched (third wall, forced).
  SELECT count(*) INTO n FROM pg_class
   WHERE oid IN (to_regclass('social_reports'), to_regclass('social_cycles')) AND relrowsecurity AND relforcerowsecurity;
  IF n <> 2 THEN
    RAISE EXCEPTION '202610301210: social_reports and social_cycles must keep RLS ENABLED and FORCED';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = current_schema() AND tablename IN ('social_reports', 'social_cycles') AND qual LIKE '%app_module_allowed%';
  IF n < 2 THEN
    RAISE EXCEPTION '202610301210: social_reports and social_cycles must keep their module wall (app_module_allowed) policies';
  END IF;
END $$;
