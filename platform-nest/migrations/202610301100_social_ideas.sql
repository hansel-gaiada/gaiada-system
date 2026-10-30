-- 202610301100_social_ideas.sql — SCP-5c: "Ideas for next month", per client, and the post's link back to its idea.
-- Contract: docs/FRONTEND-BFF-CONTRACT.md §63.25.1 ("<prefix+1>_social_ideas.sql"); plan
-- docs/plans/2026-10-15-social-content-pipeline.md §4.2 (the reserved name `social_ideas`, the post's `idea_id`), SCP-Q27
-- (ideas stay internal), SCP-Q41 (`ideas.metricRequired` is a company rule, so `metric` is nullable and the route enforces it).
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────────────────
--   social_reports       `ux_social_reports_id_tenant UNIQUE (id, tenant_id)` when missing (the 0075 pattern; it cannot fail,
--                        `id` is the key). 0105 gave social_reports no (id, tenant_id) key, and §63.25.1 asks for a COMPOSITE
--                        FK from the idea to its report, which needs one. Nothing else on social_reports changes (its
--                        columns, CHECKs, wall and rows are untouched).
--   social_ideas         one idea: what we saw, the metric it rests on, what we suggest; `proposed` → `shared` → `planned`.
--   social_posts         the reserved `idea_id` (202610271000) gains `fk_social_posts_idea` (composite, to the idea) and
--                        `ux_social_posts_idea UNIQUE (idea_id) WHERE idea_id IS NOT NULL`. Only "Add to next plan" writes the
--                        two pointers (post.idea_id, idea.post_id), together; the machine's `discard` clears them.
--
-- ── NULL-SAFE CHECKS ────────────────────────────────────────────────────────────────────────────────────
-- A CHECK passes on NULL, so every pairing is written as an equality of two `IS NULL` tests (never NULL itself), and `status`
-- is NOT NULL so `(status = 'planned')` is never NULL either. Each one therefore holds in BOTH directions:
--   planned ⇔ post_id; post_id ⇔ cycle_id ⇔ planned_at ⇔ planned_by; shared_at ⇔ shared_by; deleted_at ⇔ deleted_by.
-- `status = 'shared'` needs `shared_at`; a planned idea keeps its `shared_at` as the record. A planned idea cannot be deleted.
--
-- ── WALL: THE THIRD WALL ────────────────────────────────────────────────────────────────────────────────
-- `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social')` on USING and WITH CHECK, FORCE RLS, in 0105's
-- DO-loop form. Ideas never reach the portal (SCP-Q27), so no path reads them without the module scope.
--
-- ── FOREIGN KEYS ────────────────────────────────────────────────────────────────────────────────────────
-- Composite (id, tenant_id) FKs, so an idea never points into another company: engagement → social_engagements
-- (ux_social_engagements_id_tenant, 0105), report → social_reports (ux_social_reports_id_tenant, above), cycle → social_cycles
-- (ux_social_cycles_id_tenant, 202610271000), post → social_posts (ux_social_posts_id_tenant, 0105); and back, post.idea_id →
-- social_ideas (ux_social_ideas_id_tenant). MATCH SIMPLE: a NULL pointer is not checked. Plain FKs to users for every person.
-- The idea and its post point at each other; both pointers are nullable, so the route inserts the post (with idea_id) and then
-- updates the idea in the same transaction, and no FK needs to be DEFERRABLE.
--
-- ── NO DML ──────────────────────────────────────────────────────────────────────────────────────────────
-- No row is read or written. No `social_posts.idea_id` is set today; `fk_social_posts_idea`'s own validation checks every
-- existing row as the owner, outside RLS, so the ADD fails loudly if one is. This file does NOT try to prove that with a
-- count: under the migration's unset tenant GUC a count of the forced-RLS social_posts reads ZERO rows and proves nothing.
-- The closing DO block asserts the catalogue only.
--
-- ── RE-RUNNABLE ─────────────────────────────────────────────────────────────────────────────────────────
-- CREATE TABLE/INDEX IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD, DROP POLICY IF EXISTS + CREATE. Applies on its own with
-- plain `psql -f` and again without error. Neither table is in the sync-engine's write-back registry.
--
-- ── ROLLOUT ─────────────────────────────────────────────────────────────────────────────────────────────
-- Additive. Runs on boot. The UNIQUE on social_reports builds a small index under a brief lock; the FK on social_posts takes
-- SHARE ROW EXCLUSIVE on social_posts and social_ideas while it validates (every idea_id is NULL, so it is a scan, no lookup);
-- the partial unique index on social_posts covers zero rows. No deploy-order constraint: no existing code reads the table.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (0) social_reports gets the (id, tenant_id) key a composite FK needs (0075's "when missing" pattern).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = to_regclass('social_reports') AND conname = 'ux_social_reports_id_tenant'
  ) THEN
    ALTER TABLE social_reports ADD CONSTRAINT ux_social_reports_id_tenant UNIQUE (id, tenant_id);
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) social_ideas — one idea for a client's next month.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS social_ideas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  engagement_id uuid NOT NULL,
  saw text NOT NULL,
  -- Required by default (the design); a company may make it optional (`ideas.metricRequired`, §63.30). The route enforces it.
  metric text,
  suggestion text NOT NULL,
  status text NOT NULL DEFAULT 'proposed',
  -- The monthly report it was raised with, when it was.
  report_id uuid,
  -- Where it was planned ("Add to next plan"): the cycle and the post, both or neither.
  cycle_id uuid,
  post_id uuid,
  shared_at timestamptz,
  shared_by uuid REFERENCES users(id),
  planned_at timestamptz,
  planned_by uuid REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  CONSTRAINT ux_social_ideas_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT fk_social_ideas_engagement_tenant FOREIGN KEY (engagement_id, tenant_id)
    REFERENCES social_engagements (id, tenant_id),
  CONSTRAINT fk_social_ideas_report_tenant FOREIGN KEY (report_id, tenant_id)
    REFERENCES social_reports (id, tenant_id),
  CONSTRAINT fk_social_ideas_cycle_tenant FOREIGN KEY (cycle_id, tenant_id)
    REFERENCES social_cycles (id, tenant_id),
  CONSTRAINT fk_social_ideas_post_tenant FOREIGN KEY (post_id, tenant_id)
    REFERENCES social_posts (id, tenant_id)
);

ALTER TABLE social_ideas
  DROP CONSTRAINT IF EXISTS social_ideas_status_ck,
  ADD CONSTRAINT social_ideas_status_ck CHECK (status IN ('proposed','shared','planned')),
  DROP CONSTRAINT IF EXISTS social_ideas_lengths_ck,
  ADD CONSTRAINT social_ideas_lengths_ck CHECK (
    char_length(saw) BETWEEN 1 AND 500
    AND (metric IS NULL OR char_length(metric) BETWEEN 1 AND 300)
    AND char_length(suggestion) BETWEEN 1 AND 500
  ),
  -- Planned exactly when it has its post.
  DROP CONSTRAINT IF EXISTS social_ideas_planned_ck,
  ADD CONSTRAINT social_ideas_planned_ck CHECK ((status = 'planned') = (post_id IS NOT NULL)),
  -- The post, its cycle, and who planned it when: all four or none.
  DROP CONSTRAINT IF EXISTS social_ideas_planned_cycle_ck,
  ADD CONSTRAINT social_ideas_planned_cycle_ck CHECK ((post_id IS NULL) = (cycle_id IS NULL)),
  DROP CONSTRAINT IF EXISTS social_ideas_planned_at_ck,
  ADD CONSTRAINT social_ideas_planned_at_ck CHECK ((post_id IS NULL) = (planned_at IS NULL)),
  DROP CONSTRAINT IF EXISTS social_ideas_planned_by_ck,
  ADD CONSTRAINT social_ideas_planned_by_ck CHECK ((post_id IS NULL) = (planned_by IS NULL)),
  DROP CONSTRAINT IF EXISTS social_ideas_shared_pair_ck,
  ADD CONSTRAINT social_ideas_shared_pair_ck CHECK ((shared_at IS NULL) = (shared_by IS NULL)),
  -- A shared idea says when; a planned one keeps its shared_at as the record (or never had one).
  DROP CONSTRAINT IF EXISTS social_ideas_shared_ck,
  ADD CONSTRAINT social_ideas_shared_ck CHECK (status <> 'shared' OR shared_at IS NOT NULL),
  DROP CONSTRAINT IF EXISTS social_ideas_deleted_ck,
  ADD CONSTRAINT social_ideas_deleted_ck CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  -- A planned idea is deleted only by releasing it first (discard), never directly.
  DROP CONSTRAINT IF EXISTS social_ideas_deleted_planned_ck,
  ADD CONSTRAINT social_ideas_deleted_planned_ck CHECK (deleted_at IS NULL OR status <> 'planned');

-- One idea per post (NULLs are distinct, so the index is partial over the planned set).
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_ideas_post
  ON social_ideas (post_id) WHERE post_id IS NOT NULL;
-- The report page's list: a client's live ideas by status, newest first.
CREATE INDEX IF NOT EXISTS ix_social_ideas_engagement_status
  ON social_ideas (tenant_id, engagement_id, status, created_at DESC) WHERE deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) social_posts.idea_id (reserved by 202610271000) gains its FK and its one-post-per-idea index.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE social_posts
  DROP CONSTRAINT IF EXISTS fk_social_posts_idea,
  ADD CONSTRAINT fk_social_posts_idea FOREIGN KEY (idea_id, tenant_id) REFERENCES social_ideas (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_social_posts_idea
  ON social_posts (idea_id) WHERE idea_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the third wall, in 0105's DO-loop form (byte-identical predicate).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['social_ideas'] LOOP
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

COMMENT ON TABLE social_ideas IS
  'SCP-5c (BFF 63.25): ideas for a client''s next month. Internal: never in the portal or the report PDF unless the company '
  'prints shared ideas (ideas.sharedInMonthlyReport). Third wall. post_id and social_posts.idea_id are written together by '
  '"Add to next plan" and cleared together by the machine''s discard (release_idea).';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- Assert, don't assume: columns, CHECK expressions, keys, indexes and the walls. Catalogue reads only.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n integer;
  missing text;
BEGIN
  -- Columns with their type and nullability.
  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES
      ('id','uuid','NO'), ('tenant_id','uuid','NO'), ('engagement_id','uuid','NO'), ('saw','text','NO'),
      ('metric','text','YES'), ('suggestion','text','NO'), ('status','text','NO'), ('report_id','uuid','YES'),
      ('cycle_id','uuid','YES'), ('post_id','uuid','YES'), ('shared_at','timestamp with time zone','YES'),
      ('shared_by','uuid','YES'), ('planned_at','timestamp with time zone','YES'), ('planned_by','uuid','YES'),
      ('created_by','uuid','NO'), ('created_at','timestamp with time zone','NO'), ('updated_at','timestamp with time zone','NO'),
      ('deleted_at','timestamp with time zone','YES'), ('deleted_by','uuid','YES'), ('origin_site','text','NO')
    ) AS want(c, ty, nul)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                      WHERE ic.table_schema = current_schema() AND ic.table_name = 'social_ideas'
                        AND ic.column_name = want.c AND ic.data_type = want.ty AND ic.is_nullable = want.nul);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301100: social_ideas columns missing or misshapen: %', missing;
  END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'social_ideas' AND column_name = 'status'
     AND column_default LIKE '''proposed''::text%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301100: social_ideas.status must default to ''proposed''';
  END IF;

  -- The CHECKs, each with its exact expression as Postgres prints it back.
  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES
      ('social_ideas_status_ck', 'CHECK ((status = ANY (ARRAY[''proposed''::text, ''shared''::text, ''planned''::text])))'),
      ('social_ideas_lengths_ck', 'CHECK ((((char_length(saw) >= 1) AND (char_length(saw) <= 500)) AND ((metric IS NULL) OR ((char_length(metric) >= 1) AND (char_length(metric) <= 300))) AND ((char_length(suggestion) >= 1) AND (char_length(suggestion) <= 500))))'),
      ('social_ideas_planned_ck', 'CHECK (((status = ''planned''::text) = (post_id IS NOT NULL)))'),
      ('social_ideas_planned_cycle_ck', 'CHECK (((post_id IS NULL) = (cycle_id IS NULL)))'),
      ('social_ideas_planned_at_ck', 'CHECK (((post_id IS NULL) = (planned_at IS NULL)))'),
      ('social_ideas_planned_by_ck', 'CHECK (((post_id IS NULL) = (planned_by IS NULL)))'),
      ('social_ideas_shared_pair_ck', 'CHECK (((shared_at IS NULL) = (shared_by IS NULL)))'),
      ('social_ideas_shared_ck', 'CHECK (((status <> ''shared''::text) OR (shared_at IS NOT NULL)))'),
      ('social_ideas_deleted_ck', 'CHECK (((deleted_at IS NULL) = (deleted_by IS NULL)))'),
      ('social_ideas_deleted_planned_ck', 'CHECK (((deleted_at IS NULL) OR (status <> ''planned''::text)))')
    ) AS want(c, def)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass('social_ideas') AND pc.conname = want.c AND pc.contype = 'c'
                        AND pg_get_constraintdef(pc.oid) = want.def);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301100: social_ideas CHECKs missing or with another expression: %', missing;
  END IF;

  -- Keys and FKs (composite, with the tenant).
  SELECT string_agg(want.t || '.' || want.c, ', ') INTO missing
    FROM (VALUES
      ('social_reports','ux_social_reports_id_tenant','UNIQUE (id, tenant_id)'),
      ('social_ideas','ux_social_ideas_id_tenant','UNIQUE (id, tenant_id)'),
      ('social_ideas','fk_social_ideas_engagement_tenant','FOREIGN KEY (engagement_id, tenant_id) REFERENCES %social_engagements(id, tenant_id)'),
      ('social_ideas','fk_social_ideas_report_tenant','FOREIGN KEY (report_id, tenant_id) REFERENCES %social_reports(id, tenant_id)'),
      ('social_ideas','fk_social_ideas_cycle_tenant','FOREIGN KEY (cycle_id, tenant_id) REFERENCES %social_cycles(id, tenant_id)'),
      ('social_ideas','fk_social_ideas_post_tenant','FOREIGN KEY (post_id, tenant_id) REFERENCES %social_posts(id, tenant_id)'),
      ('social_posts','fk_social_posts_idea','FOREIGN KEY (idea_id, tenant_id) REFERENCES %social_ideas(id, tenant_id)')
    ) AS want(t, c, def)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass(want.t) AND pc.conname = want.c AND pg_get_constraintdef(pc.oid) LIKE want.def);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301100: keys or FKs missing or misshapen: %', missing;
  END IF;

  -- Indexes, with their exact definitions (partial predicates included).
  SELECT string_agg(want.i, ', ') INTO missing
    FROM (VALUES
      ('social_ideas','ux_social_ideas_post','CREATE UNIQUE INDEX ux_social_ideas_post ON % USING btree (post_id) WHERE (post_id IS NOT NULL)'),
      ('social_ideas','ix_social_ideas_engagement_status','CREATE INDEX ix_social_ideas_engagement_status ON % USING btree (tenant_id, engagement_id, status, created_at DESC) WHERE (deleted_at IS NULL)'),
      ('social_posts','ux_social_posts_idea','CREATE UNIQUE INDEX ux_social_posts_idea ON % USING btree (idea_id) WHERE (idea_id IS NOT NULL)')
    ) AS want(t, i, def)
   WHERE NOT EXISTS (SELECT 1 FROM pg_indexes pi
                      WHERE pi.schemaname = current_schema() AND pi.tablename = want.t AND pi.indexname = want.i
                        AND pi.indexdef LIKE replace(want.def, '%', '%' || want.t));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610301100: indexes missing or misshapen: %', missing;
  END IF;

  -- The third wall: RLS enabled and forced, exactly one policy, the tenant predicate and the module clause on both sides.
  SELECT count(*) INTO n FROM pg_class
   WHERE oid = to_regclass('social_ideas') AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301100: social_ideas must have RLS ENABLED and FORCED';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = current_schema() AND tablename = 'social_ideas' AND policyname = 'tenant_isolation' AND cmd = 'ALL'
     AND qual LIKE '%app_current_tenants()%' AND qual LIKE '%app_module_allowed(''social''::text)%'
     AND with_check LIKE '%app_current_tenants()%' AND with_check LIKE '%app_module_allowed(''social''::text)%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301100: social_ideas needs the third-wall tenant_isolation policy on USING and WITH CHECK';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'social_ideas';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610301100: social_ideas must carry exactly one policy, found %', n;
  END IF;
END $$;
