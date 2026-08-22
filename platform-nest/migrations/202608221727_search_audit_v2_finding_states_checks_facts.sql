-- SM-76 — SEO/site-audit capability, schema wave (docs/plans/2026-08-23-seo-audit-capability.md
-- §2.3, §6). Three new tables (finding state, per-run check coverage, property facts) + constraint
-- surgery on the existing `search_audits`/`search_audit_findings` tables SM-01/SM-08 shipped.
--
-- ── WHY THESE THREE TABLES, IN ONE SENTENCE EACH (design §1.2) ──────────────────────────────────
-- `search_audit_checks` is the HONESTY SPINE: a check with no row here DID NOT RUN and must render
-- "not checked", never "passed" — this is what makes "0 findings" distinguishable from "never
-- audited" (design §7.1).
-- `search_finding_states` is THE TRACKABLE ENTITY: one row per (property, check, scope) turns
-- "which of my N sites still have X" into one indexed SELECT (ix_search_finding_states_portfolio
-- below) and makes triage STICKY across runs — today's `search_audit_findings` diff (0045/SM-08)
-- flips a re-detected `ignored` finding back to `regressed`, which this table's state machine
-- (SM-77) stops doing.
-- `search_property_facts` is PROVENANCE-STAMPED fact storage (CMS, hosting, "salts rotated by
-- whom, when") — flat columns on `search_properties` cannot carry who-asserted-this-and-when,
-- which for attested security facts (design §3.5) is the entire point.
--
-- ── CONVENTIONS (byte-for-byte from 0034_module_search.sql / 0116_module_monitoring.sql) ─────────
-- tenant_id + client_id NOT NULL (design §6: "all three new tables carry tenant_id + client_id
-- NOT NULL — the portal and billing hang off client", matching monitoring's own three-level
-- tenancy, NOT search_audits' own tenant_id+property_id-only shape — these are genuinely new
-- tables, so they follow the newer, stricter convention rather than search_audits' older one,
-- per platform-nest/CLAUDE.md's "match the table you're extending, don't fix its neighbours" —
-- these three have no existing shape to match). origin_site default 'central' on the tables that
-- carry it (search_property_facts, an append-only provenance chain, same shape as
-- search_rank_snapshots). No in-migration GRANTs (owner's ALTER DEFAULT PRIVILEGES + the external
-- RUNTIME_GRANTS_SQL pass owns that, migrations/README.md). Additive, CREATE-only.
--
-- ── TWO DELIBERATE REFINEMENTS OVER THE DESIGN DOC'S §2.3 DDL SKETCH (flagged, not silent) ────────
-- The doc's own header calls its DDL a "sketch — refined at SM-76", so these are refinements, not
-- deviations, and both are additive (they narrow what can be inserted; they add no column, drop
-- none, and change no table's shape or RLS approach):
--   1. `search_audit_checks.source` gets a CHECK constraint the sketch's own comment already lists
--      as its intended vocabulary (`'crawler' | 'monitor-probe' | 'psi' | 'attestation'`) but never
--      turned into a constraint — every sibling closed-vocabulary provenance column in this schema
--      (search_audits.source, search_property_facts.source in this same file) enforces its list;
--      leaving this one as a bare comment looks like an oversight, not a deliberate open-ended
--      column (contrast `monitors.kind` in 0116, which IS deliberately free text, WITH a header
--      comment explaining why — no such comment exists here).
--   2. A handful of `(tenant_id, client_id)`-leading indexes not named in the sketch, matching the
--      house convention every existing search_*/monitor_* table already follows (e.g.
--      ix_search_properties_client, ix_monitors_client) — RLS filters every query on tenant_id, so
--      an index that doesn't lead with it is the wrong shape for this schema.
-- `search_property_facts.recorded_by` stays WITHOUT a DB CHECK enforcing "required when attested" —
-- the design sketch itself annotates that column `-- REQUIRED (app-enforced) when attested`,
-- an explicit, deliberate choice to keep it out of the DB layer. Honoured as written.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (A) search_finding_states — one row per (property, check, scope). THE trackable entity (§2.3).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE search_finding_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  check_key text NOT NULL,
  scope_key text NOT NULL DEFAULT '',   -- '' = property-level; else a stable URL-group discriminator
  status text NOT NULL DEFAULT 'open' CHECK (status IN
    ('open','in_remediation','fixed_claimed','fixed_verified','accepted_risk','false_positive','regressed')),
  severity text NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
      -- seeded from the catalog default; a human override is recorded via the triage fields below
  first_seen_audit_id uuid NOT NULL REFERENCES search_audits(id),
  last_seen_audit_id  uuid NOT NULL REFERENCES search_audits(id),
  first_seen_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  verified_absent_audit_id uuid REFERENCES search_audits(id),  -- the run that MEASURED it gone
  assignee_id uuid REFERENCES users(id),
  remediation_task_id uuid,             -- PM linkage; exact FK target verified at SM-87, not assumed here
  triage_note text,
  triaged_by uuid REFERENCES users(id),
  triaged_at timestamptz,
  accepted_until timestamptz,           -- accepted_risk expiry; NULL = indefinite (UI must flag it)
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, property_id, check_key, scope_key)
);
CREATE INDEX ix_search_finding_states_portfolio
  ON search_finding_states (tenant_id, check_key, status);
CREATE INDEX ix_search_finding_states_property
  ON search_finding_states (tenant_id, property_id, status);
CREATE INDEX ix_search_finding_states_client
  ON search_finding_states (tenant_id, client_id);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (B) search_audit_checks — per-run check coverage. The honesty spine (§2.3, §7.1).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE search_audit_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  audit_id uuid NOT NULL REFERENCES search_audits(id),
  check_key text NOT NULL,          -- catalog key, e.g. 'security.hsts'
  outcome text NOT NULL CHECK (outcome IN ('passed','failed','error','not_run','unsupported')),
      -- unsupported = not applicable to this property (e.g. wp.* on a non-WordPress site): an
      -- HONEST skip. not_run = applicable but not executed (collector down/refused): a GAP.
      -- error = the check itself failed to evaluate. The three must never collapse into one.
  evidence jsonb NOT NULL DEFAULT '{}',  -- measured facts (header value, cert notAfter…). NOT public-safe.
  source text NOT NULL CHECK (source IN ('crawler','monitor-probe','psi','attestation')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (audit_id, check_key)
);
CREATE INDEX ix_search_audit_checks_client ON search_audit_checks (tenant_id, client_id);
CREATE INDEX ix_search_audit_checks_audit ON search_audit_checks (tenant_id, audit_id);
CREATE INDEX ix_search_audit_checks_portfolio ON search_audit_checks (tenant_id, check_key, outcome);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (C) search_property_facts — provenance-stamped facts. Append-only chain: the current value is the
-- row with superseded_at IS NULL (partial unique index — NULLs defeat a plain UNIQUE, per this
-- estate's own standing lesson).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE search_property_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  key text NOT NULL,                    -- 'cms', 'hosting.provider', 'wp.table_prefix_customized',
                                        -- 'wp.salts_rotated_at', 'wp.salts_unique_confirmed', …
  value jsonb NOT NULL,
  source text NOT NULL CHECK (source IN ('detected','attested','imported')),
  audit_id uuid REFERENCES search_audits(id),   -- set when detected
  recorded_by uuid REFERENCES users(id),        -- REQUIRED (app-enforced) when attested — see header
  observed_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_search_property_facts_current
  ON search_property_facts (tenant_id, property_id, key) WHERE superseded_at IS NULL;
CREATE INDEX ix_search_property_facts_client ON search_property_facts (tenant_id, client_id);
CREATE INDEX ix_search_property_facts_property ON search_property_facts (tenant_id, property_id, key);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the one composed tenant_isolation policy, third-wall predicate byte-identical to
-- 0034/0116: `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search')` on BOTH
-- USING (reads) and WITH CHECK (writes), for exactly the 3 tables this migration creates.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'search_finding_states','search_audit_checks','search_property_facts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))',
      t
    );
  END LOOP;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Widenings on search_audits (design §2.3): `group_id` (the "run audit" action's correlation id —
-- no FK, same "not a table" reasoning as search_keywords.cluster_id in 0034) + constraint surgery
-- widening `kind` (+'security') and `source` (+'psi'), both via the CONKEY-matching idiom
-- `202608201518_search_audits_nexus_import_source.sql` established for this exact table (identify
-- the constraint by its EXACT single-column match, never by name or substring — search_audits
-- carries three separate CHECKs (kind/source/status) and a name/substring guess has already cost a
-- deploy once on this table).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE search_audits ADD COLUMN group_id uuid;
CREATE INDEX ix_search_audits_group ON search_audits (tenant_id, group_id) WHERE group_id IS NOT NULL;
COMMENT ON COLUMN search_audits.group_id IS
  'SM-76/§2.1: the set of runs produced by one "run audit" action across kinds — the unit a report '
  'renders (design §5.4). Nullable: pre-SM-82 rows (and any audit created outside the group-mint '
  'orchestrator) have no group.';

DO $$
DECLARE cname text;
BEGIN
  SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
   WHERE con.conrelid = 'search_audits'::regclass
     AND con.contype = 'c'
   GROUP BY con.conname
  HAVING array_agg(att.attname::text ORDER BY att.attname::text) = ARRAY['kind']::text[];

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE search_audits DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE search_audits DROP CONSTRAINT IF EXISTS search_audits_kind_check;

  ALTER TABLE search_audits
    ADD CONSTRAINT search_audits_kind_check
    CHECK (kind IN ('technical','cwv','content','links','geo','security'));
END $$;

DO $$
DECLARE cname text;
BEGIN
  SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
   WHERE con.conrelid = 'search_audits'::regclass
     AND con.contype = 'c'
   GROUP BY con.conname
  HAVING array_agg(att.attname::text ORDER BY att.attname::text) = ARRAY['source']::text[];

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE search_audits DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE search_audits DROP CONSTRAINT IF EXISTS search_audits_source_check;

  ALTER TABLE search_audits
    ADD CONSTRAINT search_audits_source_check
    CHECK (source IN ('seonaut','crawler','unlighthouse','ai','nexus-import','psi'));
END $$;

COMMENT ON COLUMN search_audits.kind IS
  'technical | cwv | content | links | geo (SM-01) | security (SM-76, design §3: WP/security '
  'checks — HSTS, debug exposure, table-prefix, salts — represented as a distinct audit kind).';
COMMENT ON COLUMN search_audits.source IS
  'seonaut | crawler | unlighthouse (report-shape adapters, SM-08) | ai (SM-10 AI-drafted findings) | '
  'nexus-import (SM-70 historical import) | psi (SM-76/SM-81: PageSpeed Insights field+lab performance '
  'runs, kind=''cwv'').';

-- ── search_audit_findings.state_id — links each per-run observation to its trackable state row
-- (design §2.3). Nullable: pre-SM-77 rows, and any observation from a check with no catalogued
-- state-machine pass yet, have none until the SM-77 state-maintenance pass backfills going forward
-- (no retro-synthesis of history, design §8.4 — this column stays NULL for pre-existing rows).
ALTER TABLE search_audit_findings ADD COLUMN state_id uuid REFERENCES search_finding_states(id);
CREATE INDEX ix_search_audit_findings_state
  ON search_audit_findings (tenant_id, state_id) WHERE state_id IS NOT NULL;
