-- 202610271000_social_pipeline.sql — SCP-1b: the Social Media content pipeline's data.
-- Contract: docs/FRONTEND-BFF-CONTRACT.md §63.1, file 1 ("<prefix>_social_pipeline.sql"). Plan:
-- docs/plans/2026-10-15-social-content-pipeline.md §4.2 (the contract wins on any difference). Fixture:
-- src/modules/social/scp-stage-machine.json (`statuses`, `blockableStatuses`, `changeCases`, `handoffChecks`).
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────────────────
--   social_engagements          the allocation: target, creative route, batch, report format and day,
--                               platforms, formats, default time, per-step estimates; ix_social_engagements_owner.
--   social_brand_profiles       the brand book: pillars, must-have notes, rules, channels, key dates, links.
--                               (`tone.summary` and `hashtag_strategy.sets` are keys inside existing jsonb
--                               columns; the routes validate them, so they need no DDL.)
--   social_settings      (new)  one row per company: the ready-by buffer and the boost-candidate factor.
--   social_cycles        (new)  one client's content month.
--   social_posts                the pipeline columns, their CHECKs and four indexes.
--   social_post_designs  (new)  a post's designs, in order.
--   social_post_copy_edits (new) the copy edit log, append-only (the 0087 trigger shape).
--   social_post_client_reviews  change kind, pin, recorded decision, decision id and undo window.
--
-- ── WALLS ───────────────────────────────────────────────────────────────────────────────────────────────
-- The four new tables take the THIRD wall, written in 0105's DO-loop form so the predicate cannot drift:
--     tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social')
-- on USING and WITH CHECK, FORCE RLS. The columns added to existing tables change no policy:
-- social_engagements, social_brand_profiles and social_posts keep 0105's third wall, and
-- social_post_client_reviews keeps its PLAIN tenant wall (0105 D-16: the portal writes it and declares no
-- module scope). Do not add app_module_allowed() to the review table.
--
-- ── EXISTING ROWS ───────────────────────────────────────────────────────────────────────────────────────
-- No DML. Every new column is NULL or carries a constant DEFAULT (a catalogue change in Postgres 11+), so
-- every existing social_posts row reads pipeline_status NULL and stays a Composer post, exactly as today.
-- Each new CHECK is validated against the existing rows by the DDL itself (a table scan run by the
-- constraint machinery, which row security does not filter). Every new CHECK holds on a row carrying only
-- NULLs and the defaults, so adding them cannot fail on live data.
--
-- The contract asks the closing DO block to count `pipeline_status IS NOT NULL` rows. It does not, on
-- purpose: migrations run as platform_owner without BYPASSRLS, and social_posts is FORCE RLS on the third
-- wall, so with the GUCs unset that count reads ZERO ROWS whatever the table holds (the 0050 trap). A
-- vacuous assertion is worse than none. "No existing row changed" is proved instead by the migration suite
-- (src/modules/social/scp-pipeline-schema.db.test.ts): rows written by today's insert paths read NULL and the
-- defaults, and re-applying this file leaves every row byte-identical. The DO block below asserts structure.
--
-- ── RE-RUNNABLE ─────────────────────────────────────────────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS, CREATE TABLE/INDEX IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD, DROP POLICY
-- IF EXISTS + CREATE, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE. The runner applies it once
-- (schema_migrations); CI's sync-engine-go job applies it with plain `psql -f` and no ledger, so it reads
-- nothing from schema_migrations and stands on its own.
--
-- ── FOREIGN KEYS ────────────────────────────────────────────────────────────────────────────────────────
-- Composite (id, tenant_id) FKs where the contract names them: cycle → social_engagements
-- (ux_social_engagements_id_tenant, 0105), post → social_cycles (ux_social_cycles_id_tenant, below), design and
-- copy edit → social_posts (ux_social_posts_id_tenant, 0105). Plain FKs where the contract writes a plain
-- arrow: work_requests, creative_assets, files, users (house pattern for those parents, 202610140840).
--
-- ── ROLLOUT ─────────────────────────────────────────────────────────────────────────────────────────────
-- Additive. Runs on boot. Brief ACCESS EXCLUSIVE locks on the four altered tables while their CHECKs are
-- validated (small tables). Today's routes write none of the new columns and every new column has a NULL or a
-- default, so the old code keeps working against the new schema; no deploy-order constraint.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) social_engagements — the allocation. `owner_id` (0105) is the client's SMM Officer; no second column.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE social_engagements
  ADD COLUMN IF NOT EXISTS posts_per_cycle smallint,
  ADD COLUMN IF NOT EXISTS creative_source text NOT NULL DEFAULT 'creatives',
  ADD COLUMN IF NOT EXISTS delivery_batch text,
  ADD COLUMN IF NOT EXISTS report_format text,
  ADD COLUMN IF NOT EXISTS report_due_day smallint,
  ADD COLUMN IF NOT EXISTS platforms text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS formats text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS default_post_time time,
  ADD COLUMN IF NOT EXISTS step_estimates jsonb NOT NULL DEFAULT '{}';

ALTER TABLE social_engagements
  DROP CONSTRAINT IF EXISTS social_engagements_posts_per_cycle_ck,
  ADD CONSTRAINT social_engagements_posts_per_cycle_ck
    CHECK (posts_per_cycle IS NULL OR posts_per_cycle BETWEEN 0 AND 200),
  DROP CONSTRAINT IF EXISTS social_engagements_creative_source_ck,
  ADD CONSTRAINT social_engagements_creative_source_ck
    CHECK (creative_source IN ('creatives','in_team')),
  DROP CONSTRAINT IF EXISTS social_engagements_delivery_batch_ck,
  ADD CONSTRAINT social_engagements_delivery_batch_ck
    CHECK (delivery_batch IN ('A','B')),
  DROP CONSTRAINT IF EXISTS social_engagements_report_format_ck,
  ADD CONSTRAINT social_engagements_report_format_ck
    CHECK (report_format IN ('email','meeting')),
  DROP CONSTRAINT IF EXISTS social_engagements_report_due_day_ck,
  ADD CONSTRAINT social_engagements_report_due_day_ck
    CHECK (report_due_day BETWEEN 1 AND 31),
  DROP CONSTRAINT IF EXISTS social_engagements_platforms_ck,
  ADD CONSTRAINT social_engagements_platforms_ck
    CHECK (platforms <@ ARRAY['instagram','facebook','tiktok','linkedin','x','youtube','threads',
                              'pinterest','bluesky','mastodon']::text[]),
  DROP CONSTRAINT IF EXISTS social_engagements_formats_ck,
  ADD CONSTRAINT social_engagements_formats_ck
    CHECK (formats <@ ARRAY['feed','carousel','reel','story']::text[]),
  DROP CONSTRAINT IF EXISTS social_engagements_step_estimates_ck,
  ADD CONSTRAINT social_engagements_step_estimates_ck
    CHECK (jsonb_typeof(step_estimates) = 'object');

-- An officer's clients (the home feed).
CREATE INDEX IF NOT EXISTS ix_social_engagements_owner
  ON social_engagements (tenant_id, owner_id) WHERE deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) social_brand_profiles — the brand book. Per-element lengths and the jsonb element shapes are the
--     routes' to validate (§63.1); the DDL holds the array kinds and the counts.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE social_brand_profiles
  ADD COLUMN IF NOT EXISTS content_pillars text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS must_have_notes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS brand_rules text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS channels jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS key_dates jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]';

ALTER TABLE social_brand_profiles
  DROP CONSTRAINT IF EXISTS social_brand_profiles_content_pillars_ck,
  ADD CONSTRAINT social_brand_profiles_content_pillars_ck CHECK (cardinality(content_pillars) <= 20),
  DROP CONSTRAINT IF EXISTS social_brand_profiles_must_have_notes_ck,
  ADD CONSTRAINT social_brand_profiles_must_have_notes_ck CHECK (cardinality(must_have_notes) <= 20),
  DROP CONSTRAINT IF EXISTS social_brand_profiles_brand_rules_ck,
  ADD CONSTRAINT social_brand_profiles_brand_rules_ck CHECK (cardinality(brand_rules) <= 30),
  DROP CONSTRAINT IF EXISTS social_brand_profiles_channels_ck,
  ADD CONSTRAINT social_brand_profiles_channels_ck CHECK (jsonb_typeof(channels) = 'array'),
  DROP CONSTRAINT IF EXISTS social_brand_profiles_key_dates_ck,
  ADD CONSTRAINT social_brand_profiles_key_dates_ck CHECK (jsonb_typeof(key_dates) = 'array'),
  DROP CONSTRAINT IF EXISTS social_brand_profiles_links_ck,
  ADD CONSTRAINT social_brand_profiles_links_ck CHECK (jsonb_typeof(links) = 'array');

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) social_settings — one row per company; no row means the defaults.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS social_settings (
  tenant_id uuid PRIMARY KEY REFERENCES companies(id),
  buffer_working_days smallint NOT NULL DEFAULT 1,
  boost_candidate_factor numeric(4,2) NOT NULL DEFAULT 1.25,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL DEFAULT 'central',
  CONSTRAINT social_settings_buffer_ck CHECK (buffer_working_days BETWEEN 0 AND 10),
  CONSTRAINT social_settings_boost_factor_ck CHECK (boost_candidate_factor BETWEEN 1.00 AND 10.00)
);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) social_cycles — one client's content month. `ready_by` is written by the server only (the deadline
--     less the buffer in working days). The 1:1 with a Creatives request is the partial unique below.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS social_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  engagement_id uuid NOT NULL,
  month date NOT NULL,
  deadline date NOT NULL,
  ready_by date NOT NULL,
  creative_request_id uuid REFERENCES work_requests(id),
  created_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  -- The first of a month. `month::timestamp` pins the immutable date_trunc(text, timestamp) overload.
  CONSTRAINT social_cycles_month_ck CHECK (month = date_trunc('month', month::timestamp)::date),
  CONSTRAINT social_cycles_deadline_ck CHECK (
    deadline BETWEEN (month - interval '3 months')::date
                 AND (month + interval '1 month' - interval '1 day')::date
  ),
  CONSTRAINT social_cycles_ready_by_ck CHECK (ready_by <= deadline),
  CONSTRAINT fk_social_cycles_engagement_tenant FOREIGN KEY (engagement_id, tenant_id)
    REFERENCES social_engagements (id, tenant_id),
  CONSTRAINT ux_social_cycles_id_tenant UNIQUE (id, tenant_id)
);
-- One live cycle per client and month. Partial, so a soft-deleted month can be planned again.
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_cycles_month
  ON social_cycles (tenant_id, engagement_id, month) WHERE deleted_at IS NULL;
-- One cycle per Creatives request (NULLs are distinct, so this is partial over the non-null set).
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_cycles_request
  ON social_cycles (creative_request_id) WHERE creative_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_social_cycles_tenant_month ON social_cycles (tenant_id, month);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) social_posts — the pipeline. `pipeline_status` NULL is a Composer post and behaves exactly as today.
--     `scheduled_at` (0105) is the planned date and time.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE social_posts
  ADD COLUMN IF NOT EXISTS cycle_id uuid,
  ADD COLUMN IF NOT EXISTS pipeline_status text,
  ADD COLUMN IF NOT EXISTS status_since timestamptz,
  ADD COLUMN IF NOT EXISTS format text,
  ADD COLUMN IF NOT EXISTS pillar text,
  ADD COLUMN IF NOT EXISTS angle text,
  ADD COLUMN IF NOT EXISTS objective text,
  ADD COLUMN IF NOT EXISTS key_message text,
  ADD COLUMN IF NOT EXISTS visual_direction text,
  ADD COLUMN IF NOT EXISTS on_asset_text text,
  ADD COLUMN IF NOT EXISTS cta text,
  ADD COLUMN IF NOT EXISTS caption text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS hashtags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS raw_assets jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS placement text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS must_haves text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS skipped_checks jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS suggestions jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS change_by text,
  ADD COLUMN IF NOT EXISTS change_kind text,
  ADD COLUMN IF NOT EXISTS return_to text,
  ADD COLUMN IF NOT EXISTS change_note text,
  ADD COLUMN IF NOT EXISTS changed_only boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS copy_before jsonb,
  ADD COLUMN IF NOT EXISTS block_reason text,
  ADD COLUMN IF NOT EXISTS block_waiting_on text,
  ADD COLUMN IF NOT EXISTS blocked_from text,
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS creative_source text,
  ADD COLUMN IF NOT EXISTS creative_state text,
  ADD COLUMN IF NOT EXISTS creative_request_id uuid REFERENCES work_requests(id),
  ADD COLUMN IF NOT EXISTS is_extra boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS idea_id uuid,                              -- SCP-5c adds its FK
  ADD COLUMN IF NOT EXISTS author_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS client_first_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS schedule_via text,
  ADD COLUMN IF NOT EXISTS live_url text,
  ADD COLUMN IF NOT EXISTS went_live_at timestamptz,
  ADD COLUMN IF NOT EXISTS simulated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS archive_reason text,
  ADD COLUMN IF NOT EXISTS last_action_id uuid,
  ADD COLUMN IF NOT EXISTS last_action_at timestamptz;

ALTER TABLE social_posts
  DROP CONSTRAINT IF EXISTS fk_social_posts_cycle_tenant,
  ADD CONSTRAINT fk_social_posts_cycle_tenant FOREIGN KEY (cycle_id, tenant_id)
    REFERENCES social_cycles (id, tenant_id),

  -- ── value lists ───────────────────────────────────────────────────────────────────────────────────────
  -- The twelve statuses of the fixture (`statuses`). NULL is a Composer post.
  DROP CONSTRAINT IF EXISTS social_posts_pipeline_status_ck,
  ADD CONSTRAINT social_posts_pipeline_status_ck CHECK (pipeline_status IN
    ('planned','drafting','proofread','hod','design','final','client','approved','scheduled','live',
     'changes','blocked')),
  DROP CONSTRAINT IF EXISTS social_posts_format_ck,
  ADD CONSTRAINT social_posts_format_ck CHECK (format IN ('feed','carousel','reel','story')),
  DROP CONSTRAINT IF EXISTS social_posts_block_values_ck,
  ADD CONSTRAINT social_posts_block_values_ck CHECK (
    (block_waiting_on IS NULL OR block_waiting_on IN ('client','designer','copywriter','approver','officer','external'))
    -- the fixture's `blockableStatuses`
    AND (blocked_from IS NULL OR blocked_from IN ('planned','drafting','proofread','hod','design','final','changes'))
  ),
  DROP CONSTRAINT IF EXISTS social_posts_creative_values_ck,
  ADD CONSTRAINT social_posts_creative_values_ck CHECK (
    (creative_source IS NULL OR creative_source IN ('creatives','in_team'))
    AND (creative_state IS NULL OR creative_state IN ('not_started','in_progress','revision','submitted'))
  ),
  DROP CONSTRAINT IF EXISTS social_posts_schedule_via_values_ck,
  ADD CONSTRAINT social_posts_schedule_via_values_ck CHECK (schedule_via IN ('manual','publisher')),
  -- The ten networks.
  DROP CONSTRAINT IF EXISTS social_posts_placement_ck,
  ADD CONSTRAINT social_posts_placement_ck CHECK (placement <@ ARRAY['instagram','facebook','tiktok',
    'linkedin','x','youtube','threads','pinterest','bluesky','mastodon']::text[]),
  -- The ten must-have keys (fixture `handoffChecks`, rule `must_haves_unticked`).
  DROP CONSTRAINT IF EXISTS social_posts_must_haves_ck,
  ADD CONSTRAINT social_posts_must_haves_ck CHECK (must_haves <@ ARRAY['logo','brand_colours','brand_fonts',
    'contact_info','handle_and_tags','mandatory_words','no_forbidden_claims','price_terms_checked',
    'location_tag','hashtag_set']::text[]),

  -- ── lengths and shapes ────────────────────────────────────────────────────────────────────────────────
  DROP CONSTRAINT IF EXISTS social_posts_text_lengths_ck,
  ADD CONSTRAINT social_posts_text_lengths_ck CHECK (
        (pillar IS NULL OR char_length(pillar) <= 60)
    AND (angle IS NULL OR char_length(angle) <= 500)
    AND (objective IS NULL OR char_length(objective) <= 200)
    AND (key_message IS NULL OR char_length(key_message) <= 500)
    AND (visual_direction IS NULL OR char_length(visual_direction) <= 2000)
    AND (on_asset_text IS NULL OR char_length(on_asset_text) <= 500)
    AND (cta IS NULL OR char_length(cta) <= 120)
    AND char_length(caption) <= 5000
    AND (change_note IS NULL OR char_length(change_note) <= 2000)
    AND (block_reason IS NULL OR char_length(block_reason) <= 500)
    AND (archive_reason IS NULL OR char_length(archive_reason) <= 500)
  ),
  -- At most 60, none NULL, none carrying '#'. Subquery-free: array_position finds a NULL element (it compares
  -- with IS NOT DISTINCT FROM), and joining the elements puts any '#' into one string strpos can see.
  DROP CONSTRAINT IF EXISTS social_posts_hashtags_ck,
  ADD CONSTRAINT social_posts_hashtags_ck CHECK (
    cardinality(hashtags) <= 60
    AND array_position(hashtags, NULL) IS NULL
    AND strpos(array_to_string(hashtags, ''), '#') = 0
  ),
  -- An array of at most 10 entries, each an object whose `source` is one of the five strings. The jsonpath
  -- selects an entry whose source is missing, not a string, or not in the list (an entry that is not an
  -- object has no `source` in lax mode, so it is selected too); CASE keeps jsonb_array_length off non-arrays.
  DROP CONSTRAINT IF EXISTS social_posts_raw_assets_ck,
  ADD CONSTRAINT social_posts_raw_assets_ck CHECK (
    CASE WHEN jsonb_typeof(raw_assets) = 'array' THEN
      jsonb_array_length(raw_assets) <= 10
      AND NOT jsonb_path_exists(raw_assets,
        '$[*] ? (@.source.type() != "string" || !(@.source == "own" || @.source == "client" || @.source == "stock" || @.source == "ai" || @.source == "unknown"))')
    ELSE false END
  ),
  DROP CONSTRAINT IF EXISTS social_posts_skipped_checks_ck,
  ADD CONSTRAINT social_posts_skipped_checks_ck CHECK (jsonb_typeof(skipped_checks) = 'array'),
  -- An object keyed only by the four copy fields.
  DROP CONSTRAINT IF EXISTS social_posts_suggestions_ck,
  ADD CONSTRAINT social_posts_suggestions_ck CHECK (
    jsonb_typeof(suggestions) = 'object'
    AND (suggestions - ARRAY['caption','on_asset_text','cta','hashtags']::text[]) = '{}'::jsonb
  ),
  DROP CONSTRAINT IF EXISTS social_posts_copy_before_ck,
  ADD CONSTRAINT social_posts_copy_before_ck CHECK (copy_before IS NULL OR jsonb_typeof(copy_before) = 'object'),
  DROP CONSTRAINT IF EXISTS social_posts_live_url_ck,
  ADD CONSTRAINT social_posts_live_url_ck CHECK (
    live_url IS NULL OR (live_url ~* '^https?://' AND char_length(live_url) <= 500)
  ),

  -- ── the state CHECKs of §63.1, each NULL-safe ─────────────────────────────────────────────────────────
  DROP CONSTRAINT IF EXISTS social_posts_pipeline_needs_cycle_ck,
  ADD CONSTRAINT social_posts_pipeline_needs_cycle_ck CHECK (pipeline_status IS NULL OR cycle_id IS NOT NULL),
  DROP CONSTRAINT IF EXISTS social_posts_status_since_ck,
  ADD CONSTRAINT social_posts_status_since_ck CHECK ((pipeline_status IS NULL) = (status_since IS NULL)),
  -- All or none of the four change columns.
  DROP CONSTRAINT IF EXISTS social_posts_change_all_or_none_ck,
  ADD CONSTRAINT social_posts_change_all_or_none_ck CHECK (
        (change_by IS NULL) = (change_kind IS NULL)
    AND (change_by IS NULL) = (return_to IS NULL)
    AND (change_by IS NULL) = (change_note IS NULL)
  ),
  -- The six change cases only (fixture `changeCases`). With all-or-none above, the row comparison never
  -- meets a NULL.
  DROP CONSTRAINT IF EXISTS social_posts_change_case_ck,
  ADD CONSTRAINT social_posts_change_case_ck CHECK (
    change_by IS NULL OR (change_by, change_kind, return_to) IN (
      ('copywriter','copy','proofread'), ('hod','copy','hod'), ('final','copy','final'),
      ('final','design','final'), ('client','copy','proofread'), ('client','design','final'))
  ),
  DROP CONSTRAINT IF EXISTS social_posts_changes_needs_change_ck,
  ADD CONSTRAINT social_posts_changes_needs_change_ck CHECK (
    pipeline_status IS DISTINCT FROM 'changes' OR change_by IS NOT NULL
  ),
  -- A change is held only in `changes`, or in `blocked` when blocked from `changes`.
  DROP CONSTRAINT IF EXISTS social_posts_change_only_in_changes_ck,
  ADD CONSTRAINT social_posts_change_only_in_changes_ck CHECK (
    change_by IS NULL
    OR pipeline_status IS NOT DISTINCT FROM 'changes'
    OR (pipeline_status IS NOT DISTINCT FROM 'blocked' AND blocked_from IS NOT DISTINCT FROM 'changes')
  ),
  -- Loop e: `changed_only` is set exactly when the client's view of the copy is kept, and only for a client
  -- change (or with no change held).
  DROP CONSTRAINT IF EXISTS social_posts_changed_only_ck,
  ADD CONSTRAINT social_posts_changed_only_ck CHECK (changed_only = (copy_before IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS social_posts_changed_only_client_ck,
  ADD CONSTRAINT social_posts_changed_only_client_ck CHECK (
    NOT changed_only OR change_by IS NULL OR change_by = 'client'
  ),
  -- `blocked` exactly when all four block columns are set.
  DROP CONSTRAINT IF EXISTS social_posts_blocked_ck,
  ADD CONSTRAINT social_posts_blocked_ck CHECK (
        (pipeline_status IS NOT DISTINCT FROM 'blocked') = (blocked_from IS NOT NULL)
    AND (pipeline_status IS NOT DISTINCT FROM 'blocked') = (block_reason IS NOT NULL)
    AND (pipeline_status IS NOT DISTINCT FROM 'blocked') = (block_waiting_on IS NOT NULL)
    AND (pipeline_status IS NOT DISTINCT FROM 'blocked') = (blocked_at IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS social_posts_design_ck,
  ADD CONSTRAINT social_posts_design_ck CHECK (
    pipeline_status IS DISTINCT FROM 'design' OR (creative_state IS NOT NULL AND creative_source IS NOT NULL)
  ),
  -- A Creatives request only on a post whose design goes through Creatives.
  DROP CONSTRAINT IF EXISTS social_posts_request_needs_creatives_ck,
  ADD CONSTRAINT social_posts_request_needs_creatives_ck CHECK (
    creative_request_id IS NULL OR creative_source IS NOT DISTINCT FROM 'creatives'
  ),
  -- How it is scheduled, exactly while scheduled or live.
  DROP CONSTRAINT IF EXISTS social_posts_schedule_via_ck,
  ADD CONSTRAINT social_posts_schedule_via_ck CHECK (
    pipeline_status IS NULL OR (pipeline_status IN ('scheduled','live')) = (schedule_via IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS social_posts_live_ck,
  ADD CONSTRAINT social_posts_live_ck CHECK (
    pipeline_status IS DISTINCT FROM 'live' OR (live_url IS NOT NULL AND went_live_at IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS social_posts_archived_ck,
  ADD CONSTRAINT social_posts_archived_ck CHECK (
        (archived_at IS NULL) = (archived_by IS NULL)
    AND (archived_at IS NULL) = (archive_reason IS NULL)
  );

-- The home feed (about 600 live posts across two months): reads stay index-only on the status and cycle.
CREATE INDEX IF NOT EXISTS ix_social_posts_pipeline
  ON social_posts (tenant_id, pipeline_status, status_since)
  WHERE pipeline_status IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_social_posts_cycle
  ON social_posts (tenant_id, cycle_id, pipeline_status)
  WHERE cycle_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_social_posts_request
  ON social_posts (tenant_id, creative_request_id)
  WHERE creative_request_id IS NOT NULL AND deleted_at IS NULL;
-- The calendar, the feed preview and the client page.
CREATE INDEX IF NOT EXISTS ix_social_posts_engagement_date
  ON social_posts (tenant_id, engagement_id, scheduled_at)
  WHERE pipeline_status IS NOT NULL AND deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) social_post_designs — a post's designs, in order. A design is an Asset Library version group (the
--     latest live version is the design) or a shared link (for the final check only), never both.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS social_post_designs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  post_id uuid NOT NULL,
  position smallint NOT NULL,
  asset_group_id uuid REFERENCES creative_assets(id),   -- COALESCE(version_group_id, id) of the asset
  link_url text,
  link_source text,
  link_ai_note text,
  file_id uuid REFERENCES files(id),                    -- the version materialized for the client at final_approve
  file_version_no int,
  added_by uuid NOT NULL REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_by uuid REFERENCES users(id),
  removed_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  CONSTRAINT social_post_designs_position_ck CHECK (position BETWEEN 1 AND 20),
  CONSTRAINT social_post_designs_target_ck CHECK ((asset_group_id IS NULL) <> (link_url IS NULL)),
  CONSTRAINT social_post_designs_link_meta_ck CHECK (
    link_url IS NOT NULL OR (link_source IS NULL AND link_ai_note IS NULL)
  ),
  CONSTRAINT social_post_designs_link_source_required_ck CHECK (link_url IS NULL OR link_source IS NOT NULL),
  CONSTRAINT social_post_designs_ai_note_ck CHECK (link_source IS DISTINCT FROM 'ai' OR link_ai_note IS NOT NULL),
  CONSTRAINT social_post_designs_link_values_ck CHECK (
    (link_url IS NULL OR (link_url ~* '^https?://' AND char_length(link_url) <= 500))
    AND (link_source IS NULL OR link_source IN ('own','client','stock','ai','unknown'))
    AND (link_ai_note IS NULL OR char_length(link_ai_note) <= 1000)
  ),
  CONSTRAINT social_post_designs_removed_ck CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  CONSTRAINT fk_social_post_designs_post_tenant FOREIGN KEY (post_id, tenant_id)
    REFERENCES social_posts (id, tenant_id)
);
-- One live design per position (a removed one frees its slot).
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_post_designs_position
  ON social_post_designs (post_id, position) WHERE removed_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (7) social_post_copy_edits — the copy edit log, APPEND-ONLY (the 0087 trigger shape). The first draft is
--     not logged; the log starts at the first review.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS social_post_copy_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  post_id uuid NOT NULL,
  field text NOT NULL,
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  via text NOT NULL,
  suggested_by uuid REFERENCES users(id),
  edited_by uuid NOT NULL REFERENCES users(id),
  stage text NOT NULL,
  edited_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL DEFAULT 'central',
  CONSTRAINT social_post_copy_edits_field_ck CHECK (field IN ('caption','on_asset_text','cta','hashtags')),
  CONSTRAINT social_post_copy_edits_via_ck CHECK (via IN ('suggestion','fix')),
  CONSTRAINT social_post_copy_edits_suggested_by_ck CHECK (via <> 'suggestion' OR suggested_by IS NOT NULL),
  -- Text (or JSON null, for a field that was empty) for the three text fields; an array for hashtags.
  CONSTRAINT social_post_copy_edits_shape_ck CHECK (
    CASE WHEN field = 'hashtags'
      THEN jsonb_typeof(before) = 'array' AND jsonb_typeof(after) = 'array'
      ELSE jsonb_typeof(before) IN ('string','null') AND jsonb_typeof(after) IN ('string','null')
    END
  ),
  -- The post's status at the time: one of the twelve.
  CONSTRAINT social_post_copy_edits_stage_ck CHECK (stage IN
    ('planned','drafting','proofread','hod','design','final','client','approved','scheduled','live',
     'changes','blocked')),
  CONSTRAINT fk_social_post_copy_edits_post_tenant FOREIGN KEY (post_id, tenant_id)
    REFERENCES social_posts (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS ix_social_post_copy_edits_post
  ON social_post_copy_edits (tenant_id, post_id, edited_at DESC);

CREATE OR REPLACE FUNCTION social_post_copy_edits_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'social_post_copy_edits is append-only: % is not permitted (id=%)', TG_OP, OLD.id;
END $$;
DROP TRIGGER IF EXISTS trg_social_post_copy_edits_append_only ON social_post_copy_edits;
CREATE TRIGGER trg_social_post_copy_edits_append_only
  BEFORE UPDATE OR DELETE ON social_post_copy_edits
  FOR EACH ROW EXECUTE FUNCTION social_post_copy_edits_append_only();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- (8) social_post_client_reviews — PLAIN wall unchanged (0105 D-16). A recorded decision (the client
--     decided outside the ERP) has decided_by NULL and carries recorded_by + channel instead.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE social_post_client_reviews
  ADD COLUMN IF NOT EXISTS change_kind text,
  ADD COLUMN IF NOT EXISTS anchor jsonb,
  ADD COLUMN IF NOT EXISTS recorded_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS decision_id uuid,
  ADD COLUMN IF NOT EXISTS undo_until timestamptz;

ALTER TABLE social_post_client_reviews
  DROP CONSTRAINT IF EXISTS spcr_change_kind_ck,
  ADD CONSTRAINT spcr_change_kind_ck CHECK (
    change_kind IS NULL OR (change_kind IN ('copy','design') AND status = 'changes_requested')
  ),
  -- A pin {x, y, fileId}: x and y numbers from 0 to 1. CASE keeps the numeric casts off anything that is not
  -- a number, so a malformed pin is a CHECK violation rather than a cast error.
  DROP CONSTRAINT IF EXISTS spcr_anchor_ck,
  ADD CONSTRAINT spcr_anchor_ck CHECK (
    anchor IS NULL OR CASE
      WHEN jsonb_typeof(anchor) = 'object'
       AND jsonb_typeof(anchor->'x') IS NOT DISTINCT FROM 'number'
       AND jsonb_typeof(anchor->'y') IS NOT DISTINCT FROM 'number'
      THEN (anchor->>'x')::numeric BETWEEN 0 AND 1 AND (anchor->>'y')::numeric BETWEEN 0 AND 1
      ELSE false
    END
  ),
  DROP CONSTRAINT IF EXISTS spcr_recorded_ck,
  ADD CONSTRAINT spcr_recorded_ck CHECK ((recorded_by IS NULL) = (channel IS NULL)),
  DROP CONSTRAINT IF EXISTS spcr_channel_ck,
  ADD CONSTRAINT spcr_channel_ck CHECK (channel IN ('whatsapp','email','meeting'));

CREATE INDEX IF NOT EXISTS ix_spcr_decision
  ON social_post_client_reviews (tenant_id, decision_id) WHERE decision_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- FORCE RLS + the third wall on the four new tables, in 0105's DO-loop form (byte-identical predicate).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'social_settings','social_cycles','social_post_designs','social_post_copy_edits'
  ] LOOP
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

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- Assert, don't assume: columns, constraints, indexes, walls and the trigger. Catalogue reads only (no row
-- of a forced-RLS table is read here; see the header for why the row count lives in the test suite).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n integer;
  missing text;
BEGIN
  -- Columns, per table.
  SELECT string_agg(want.t || '.' || want.c, ', ') INTO missing
    FROM (VALUES
      ('social_engagements','posts_per_cycle'), ('social_engagements','creative_source'),
      ('social_engagements','delivery_batch'), ('social_engagements','report_format'),
      ('social_engagements','report_due_day'), ('social_engagements','platforms'),
      ('social_engagements','formats'), ('social_engagements','default_post_time'),
      ('social_engagements','step_estimates'),
      ('social_brand_profiles','content_pillars'), ('social_brand_profiles','must_have_notes'),
      ('social_brand_profiles','brand_rules'), ('social_brand_profiles','channels'),
      ('social_brand_profiles','key_dates'), ('social_brand_profiles','links'),
      ('social_posts','cycle_id'), ('social_posts','pipeline_status'), ('social_posts','status_since'),
      ('social_posts','format'), ('social_posts','pillar'), ('social_posts','angle'), ('social_posts','objective'),
      ('social_posts','key_message'), ('social_posts','visual_direction'), ('social_posts','on_asset_text'),
      ('social_posts','cta'), ('social_posts','caption'), ('social_posts','hashtags'), ('social_posts','raw_assets'),
      ('social_posts','placement'), ('social_posts','must_haves'), ('social_posts','skipped_checks'),
      ('social_posts','suggestions'), ('social_posts','change_by'), ('social_posts','change_kind'),
      ('social_posts','return_to'), ('social_posts','change_note'), ('social_posts','changed_only'),
      ('social_posts','copy_before'), ('social_posts','block_reason'), ('social_posts','block_waiting_on'),
      ('social_posts','blocked_from'), ('social_posts','blocked_at'), ('social_posts','creative_source'),
      ('social_posts','creative_state'), ('social_posts','creative_request_id'), ('social_posts','is_extra'),
      ('social_posts','idea_id'), ('social_posts','author_id'), ('social_posts','client_first_sent_at'),
      ('social_posts','schedule_via'), ('social_posts','live_url'), ('social_posts','went_live_at'),
      ('social_posts','simulated'), ('social_posts','archived_at'), ('social_posts','archived_by'),
      ('social_posts','archive_reason'), ('social_posts','last_action_id'), ('social_posts','last_action_at'),
      ('social_post_client_reviews','change_kind'), ('social_post_client_reviews','anchor'),
      ('social_post_client_reviews','recorded_by'), ('social_post_client_reviews','channel'),
      ('social_post_client_reviews','decision_id'), ('social_post_client_reviews','undo_until'),
      ('social_settings','buffer_working_days'), ('social_settings','boost_candidate_factor'),
      ('social_cycles','month'), ('social_cycles','deadline'), ('social_cycles','ready_by'),
      ('social_cycles','creative_request_id'),
      ('social_post_designs','position'), ('social_post_designs','asset_group_id'), ('social_post_designs','link_url'),
      ('social_post_designs','file_id'), ('social_post_designs','file_version_no'),
      ('social_post_copy_edits','field'), ('social_post_copy_edits','before'), ('social_post_copy_edits','after'),
      ('social_post_copy_edits','via'), ('social_post_copy_edits','stage')
    ) AS want(t, c)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                      WHERE ic.table_schema = current_schema() AND ic.table_name = want.t AND ic.column_name = want.c);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610271000: missing columns: %', missing;
  END IF;

  -- The defaults that make every existing row a Composer post with empty pipeline fields.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'social_posts' AND is_nullable = 'YES'
     AND column_name IN ('pipeline_status','cycle_id','status_since') AND column_default IS NULL;
  IF n <> 3 THEN
    RAISE EXCEPTION '202610271000: social_posts.pipeline_status, cycle_id and status_since must be nullable with no default, found % of 3', n;
  END IF;

  -- Constraints, by name.
  SELECT string_agg(want.c, ', ') INTO missing
    FROM (VALUES
      ('social_engagements','social_engagements_posts_per_cycle_ck'), ('social_engagements','social_engagements_creative_source_ck'),
      ('social_engagements','social_engagements_delivery_batch_ck'), ('social_engagements','social_engagements_report_format_ck'),
      ('social_engagements','social_engagements_report_due_day_ck'), ('social_engagements','social_engagements_platforms_ck'),
      ('social_engagements','social_engagements_formats_ck'), ('social_engagements','social_engagements_step_estimates_ck'),
      ('social_brand_profiles','social_brand_profiles_content_pillars_ck'), ('social_brand_profiles','social_brand_profiles_must_have_notes_ck'),
      ('social_brand_profiles','social_brand_profiles_brand_rules_ck'), ('social_brand_profiles','social_brand_profiles_channels_ck'),
      ('social_brand_profiles','social_brand_profiles_key_dates_ck'), ('social_brand_profiles','social_brand_profiles_links_ck'),
      ('social_settings','social_settings_buffer_ck'), ('social_settings','social_settings_boost_factor_ck'),
      ('social_cycles','social_cycles_month_ck'), ('social_cycles','social_cycles_deadline_ck'),
      ('social_cycles','social_cycles_ready_by_ck'), ('social_cycles','fk_social_cycles_engagement_tenant'),
      ('social_cycles','ux_social_cycles_id_tenant'),
      ('social_posts','fk_social_posts_cycle_tenant'), ('social_posts','social_posts_pipeline_status_ck'),
      ('social_posts','social_posts_format_ck'), ('social_posts','social_posts_block_values_ck'),
      ('social_posts','social_posts_creative_values_ck'), ('social_posts','social_posts_schedule_via_values_ck'),
      ('social_posts','social_posts_placement_ck'), ('social_posts','social_posts_must_haves_ck'),
      ('social_posts','social_posts_text_lengths_ck'), ('social_posts','social_posts_hashtags_ck'),
      ('social_posts','social_posts_raw_assets_ck'), ('social_posts','social_posts_skipped_checks_ck'),
      ('social_posts','social_posts_suggestions_ck'), ('social_posts','social_posts_copy_before_ck'),
      ('social_posts','social_posts_live_url_ck'), ('social_posts','social_posts_pipeline_needs_cycle_ck'),
      ('social_posts','social_posts_status_since_ck'), ('social_posts','social_posts_change_all_or_none_ck'),
      ('social_posts','social_posts_change_case_ck'), ('social_posts','social_posts_changes_needs_change_ck'),
      ('social_posts','social_posts_change_only_in_changes_ck'), ('social_posts','social_posts_changed_only_ck'),
      ('social_posts','social_posts_changed_only_client_ck'), ('social_posts','social_posts_blocked_ck'),
      ('social_posts','social_posts_design_ck'), ('social_posts','social_posts_request_needs_creatives_ck'),
      ('social_posts','social_posts_schedule_via_ck'), ('social_posts','social_posts_live_ck'),
      ('social_posts','social_posts_archived_ck'),
      ('social_post_designs','social_post_designs_position_ck'), ('social_post_designs','social_post_designs_target_ck'),
      ('social_post_designs','social_post_designs_link_meta_ck'), ('social_post_designs','social_post_designs_link_source_required_ck'),
      ('social_post_designs','social_post_designs_ai_note_ck'), ('social_post_designs','social_post_designs_link_values_ck'),
      ('social_post_designs','social_post_designs_removed_ck'), ('social_post_designs','fk_social_post_designs_post_tenant'),
      ('social_post_copy_edits','social_post_copy_edits_field_ck'), ('social_post_copy_edits','social_post_copy_edits_via_ck'),
      ('social_post_copy_edits','social_post_copy_edits_suggested_by_ck'), ('social_post_copy_edits','social_post_copy_edits_shape_ck'),
      ('social_post_copy_edits','social_post_copy_edits_stage_ck'), ('social_post_copy_edits','fk_social_post_copy_edits_post_tenant'),
      ('social_post_client_reviews','spcr_change_kind_ck'), ('social_post_client_reviews','spcr_anchor_ck'),
      ('social_post_client_reviews','spcr_recorded_ck'), ('social_post_client_reviews','spcr_channel_ck')
    ) AS want(t, c)
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint pc
                      WHERE pc.conrelid = to_regclass(want.t) AND pc.conname = want.c);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610271000: missing constraints: %', missing;
  END IF;

  -- Indexes, by name, with their partial predicates where they carry one.
  SELECT string_agg(want.i, ', ') INTO missing
    FROM (VALUES
      ('social_engagements','ix_social_engagements_owner', 'WHERE (deleted_at IS NULL)'),
      ('social_cycles','ux_social_cycles_month', 'WHERE (deleted_at IS NULL)'),
      ('social_cycles','ux_social_cycles_request', 'WHERE (creative_request_id IS NOT NULL)'),
      ('social_cycles','ix_social_cycles_tenant_month', ''),
      ('social_posts','ix_social_posts_pipeline', 'archived_at IS NULL'),
      ('social_posts','ix_social_posts_cycle', 'cycle_id IS NOT NULL'),
      ('social_posts','ix_social_posts_request', 'creative_request_id IS NOT NULL'),
      ('social_posts','ix_social_posts_engagement_date', 'pipeline_status IS NOT NULL'),
      ('social_post_designs','ux_social_post_designs_position', 'WHERE (removed_at IS NULL)'),
      ('social_post_copy_edits','ix_social_post_copy_edits_post', ''),
      ('social_post_client_reviews','ix_spcr_decision', 'WHERE (decision_id IS NOT NULL)')
    ) AS want(t, i, pred)
   WHERE NOT EXISTS (SELECT 1 FROM pg_indexes pi
                      WHERE pi.schemaname = current_schema() AND pi.tablename = want.t AND pi.indexname = want.i
                        AND pi.indexdef LIKE '%' || want.pred || '%');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '202610271000: missing or misshapen indexes: %', missing;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = current_schema()
     AND indexname IN ('ux_social_cycles_month','ux_social_cycles_request','ux_social_post_designs_position')
     AND indexdef LIKE 'CREATE UNIQUE INDEX%';
  IF n <> 3 THEN
    RAISE EXCEPTION '202610271000: the three partial unique indexes must be UNIQUE, found % of 3', n;
  END IF;

  -- The third wall on the four new tables.
  SELECT count(*) INTO n FROM pg_class
   WHERE relname IN ('social_settings','social_cycles','social_post_designs','social_post_copy_edits')
     AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity;
  IF n <> 4 THEN
    RAISE EXCEPTION '202610271000: the four new tables must have RLS ENABLED and FORCED, found % of 4', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename IN ('social_settings','social_cycles','social_post_designs','social_post_copy_edits')
     AND policyname = 'tenant_isolation'
     AND qual LIKE '%app_current_tenants()%' AND qual LIKE '%app_module_allowed(''social''::text)%'
     AND with_check LIKE '%app_current_tenants()%' AND with_check LIKE '%app_module_allowed(''social''::text)%';
  IF n <> 4 THEN
    RAISE EXCEPTION '202610271000: the four new tables need the composed tenant + module policy on USING and WITH CHECK, found % of 4', n;
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename IN ('social_settings','social_cycles','social_post_designs','social_post_copy_edits');
  IF n <> 4 THEN
    RAISE EXCEPTION '202610271000: the four new tables must carry exactly one policy each, found %', n;
  END IF;

  -- The review table keeps its PLAIN wall (0105 D-16): one policy, no module clause.
  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename = 'social_post_client_reviews'
     AND (policyname <> 'tenant_isolation' OR qual LIKE '%app_module_allowed%' OR with_check LIKE '%app_module_allowed%');
  IF n <> 0 THEN
    RAISE EXCEPTION '202610271000: social_post_client_reviews must keep its plain tenant wall (0105 D-16)';
  END IF;

  -- The append-only trigger, on UPDATE and DELETE, BEFORE, per row.
  SELECT count(*) INTO n FROM pg_trigger tg
   WHERE tg.tgrelid = 'social_post_copy_edits'::regclass AND NOT tg.tgisinternal
     AND tg.tgname = 'trg_social_post_copy_edits_append_only'
     AND (tg.tgtype & 1) = 1      -- ROW
     AND (tg.tgtype & 2) = 2      -- BEFORE
     AND (tg.tgtype & 8) = 8      -- DELETE
     AND (tg.tgtype & 16) = 16;   -- UPDATE
  IF n <> 1 THEN
    RAISE EXCEPTION '202610271000: social_post_copy_edits needs its BEFORE UPDATE OR DELETE row trigger';
  END IF;
END $$;
