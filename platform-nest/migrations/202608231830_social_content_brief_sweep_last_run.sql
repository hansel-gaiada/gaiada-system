-- SMM-26 follow-up — closing the scheduled `smm-agent-content-brief` sweep the addendum's v1.0
-- design named ("weekly per opted-in engagement") and SMM-26 itself deliberately did NOT build,
-- because a principal-less scheduled job cannot legitimately call WS8's per-principal-scoped
-- `/search` (see `content-brief-sweep-job.ts`'s own header for the identity decision this closes).
--
-- ── WHY ONE COLUMN, NOT A NEW TABLE ─────────────────────────────────────────────────────────────
-- The sweep needs exactly one new fact per engagement: "when did the sweep last attempt this
-- engagement". Nothing else about the sweep's own state needs to persist — the drafted posts/
-- variants THEMSELVES are the durable record of what it did (ordinary `social_posts`/
-- `social_post_variants` rows, `source='agent'`), and `content-brief-sweep-job.ts` reads this
-- column back to decide whether an opted-in engagement is DUE, so a restart mid-week cannot
-- silently redraft a whole week's worth of ideas a second time. NULL means "the sweep has never
-- attempted this engagement" — a THIRD, distinct fact from "it ran and refused" or "it ran and
-- drafted" (both stamp a real timestamp here regardless of `runContentBrief`'s own `kind`) —
-- never conflated with a fabricated `now()` default on the ALTER itself.
--
-- ── WHICH RLS WALL ───────────────────────────────────────────────────────────────────────────────
-- No new wall: `social_engagements` already carries 0105's THIRD wall (`tenant_id = ANY(...) AND
-- app_module_allowed('social')`). Adding a nullable column changes no policy.
--
-- ── NO BACKFILL, NO ZERO-ROW TRAP ────────────────────────────────────────────────────────────────
-- A bare `ADD COLUMN ... timestamptz` with no `DEFAULT` and no `UPDATE` touches zero existing rows
-- — every existing engagement simply reads NULL ("never attempted"), which is the honest answer:
-- the sweep has never run against any of them. There is no data to move under RLS here, so the
-- 0050-class NOBYPASSRLS backfill trap does not apply; the self-assertion below still checks the
-- column/comment landed, per the 0106/.../202608221603 discipline.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────────────
-- UTC-timestamp scheme (`migrations/README.md`); the sequential `NNNN_` scheme is closed above 0118.

BEGIN;

ALTER TABLE social_engagements
  ADD COLUMN content_brief_last_run_at timestamptz;

COMMENT ON COLUMN social_engagements.content_brief_last_run_at IS
  'SMM-26 follow-up — last time content-brief-sweep-job.ts ATTEMPTED this engagement (any outcome: '
  'drafted, refused, or a mid-tick disappearance), used to enforce the design''s own "weekly per '
  'opted-in engagement" cadence independent of how often the process restarts. NULL = never '
  'attempted, distinct from "attempted and refused".';

-- Documents the NEW nested tool_scope key this ticket reads (jsonb, no migration for the key
-- itself — 0105's own tool_scope column is additive by design, see its header). Extending the
-- EXISTING column comment rather than editing 0105's historical CREATE TABLE text.
COMMENT ON COLUMN social_engagements.tool_scope IS
  '0105 + SMM-26 follow-up. Per-engagement config, shape: '
  '{"networks":{...},"posting":{"cadencePerWeek":5,"requiresClientOk":false},'
  '"inbox":{...},"ai":{"drafting":true,"cloudPolish":true,"imageGen":false},'
  '"reporting":{"cadence":"monthly"},'
  '"contentBrief":{"scheduledEnabled":false}}. '
  '`contentBrief.scheduledEnabled` (added this ticket) is the per-engagement opt-IN for the '
  '`smm-content-brief-sweep` scheduled job — absence or any non-true value means NOT opted in, '
  'the opposite default from `ai.drafting` (which defaults ON): a scheduled job that spends '
  'gateway calls unattended must be opted into per engagement, never opted out of.';

-- ⚠ THE ZERO-ROW TRAP (platform-nest/CLAUDE.md) IS LIVE IN THE LAST CHECK BELOW. Migrations run as
-- `platform_owner`, NOBYPASSRLS. `social_engagements` carries 0105's THIRD wall
-- (`tenant_id = ANY(app_current_tenants()) AND app_module_allowed('social')`); with both GUCs unset
-- a `SELECT count(*)` matches ZERO ROWS and raises NOTHING, which would make the "no row was
-- touched" assertion below trivially true for the WRONG reason (RLS hid the rows, not "there is
-- nothing to find") — exactly 202608201442's own documented trap, applied here to a read instead of
-- a backfill. Both GUCs are set for the duration of this transaction, same idiom.
DO $$
DECLARE
  n integer;
  all_tenants text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'social_engagements' AND column_name = 'content_brief_last_run_at';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected social_engagements.content_brief_last_run_at to exist, found %', n;
  END IF;

  IF (SELECT data_type FROM information_schema.columns
       WHERE table_name = 'social_engagements' AND column_name = 'content_brief_last_run_at')
       <> 'timestamp with time zone' THEN
    RAISE EXCEPTION 'expected content_brief_last_run_at to be timestamptz';
  END IF;

  SELECT string_agg(id::text, ',') INTO all_tenants FROM companies;
  IF all_tenants IS NOT NULL THEN
    PERFORM set_config('app.current_tenant_ids', all_tenants, true);
    PERFORM set_config('app.scopes', 'social', true);
  END IF;

  -- No DML above — every existing row this transaction can actually SEE (both GUCs now set, so
  -- this is a real read, not an RLS-blinded one) must read NULL, the honest "never attempted" state.
  SELECT count(*) INTO n FROM social_engagements WHERE content_brief_last_run_at IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'expected every social_engagements row to have content_brief_last_run_at NULL immediately after ADD COLUMN, found % non-null', n;
  END IF;
END $$;

COMMIT;
