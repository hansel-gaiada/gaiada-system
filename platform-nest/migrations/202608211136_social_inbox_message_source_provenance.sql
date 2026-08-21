-- SMM-15 follow-up — `social_inbox_messages.source` was lying about every inbound row.
--
-- 0105 shipped `source text NOT NULL DEFAULT 'postiz_sync' CHECK (source IN ('postiz_sync','reply'))`,
-- written when Postiz was assumed to be the inbound path. It is not, and cannot be: OQ-4 established
-- that Postiz has **ZERO inbound surface** — no comments, no DMs, on any network, verified from its
-- live OpenAPI and its provider sources. So `'postiz_sync'` names a thing that has never happened
-- and never can. Every inbound row carried it because it was the only inbound token the CHECK
-- allowed, which is a provenance column telling a lie by construction.
--
-- WHY NOW, and not later: SMM-16's triage and SMM-18's inbox UI both read this column. Widening a
-- CHECK and backfilling three rows today is cheap; doing it after two tickets branch on the value is
-- a coordinated change across a classifier, a UI and a queue. This is the last cheap moment.
--
-- WHAT REPLACES IT: `'direct_sync'` — the `direct` driver is the only thing that has ever produced an
-- inbound row (SMM-38c's LinkedIn `pullComments`), and naming the DRIVER rather than the network
-- keeps the column honest when 38d's YouTube comments start landing through the same path. A
-- per-network provenance column would duplicate `social_inbox_threads.network`, which already carries
-- that fact.
--
-- `'postiz_sync'` is RETAINED in the CHECK rather than dropped. It is dead going forward, but a value
-- that already exists in a live column is history: dropping it would make this migration fail on any
-- database that has one, and the ledger keys on filename so a failed migration is not simply re-run.
-- The comment below is what stops it being reused.

BEGIN;

ALTER TABLE social_inbox_messages DROP CONSTRAINT IF EXISTS social_inbox_messages_source_check;

ALTER TABLE social_inbox_messages
  ADD CONSTRAINT social_inbox_messages_source_check
  CHECK (source IN ('direct_sync', 'reply', 'postiz_sync'));

ALTER TABLE social_inbox_messages ALTER COLUMN source SET DEFAULT 'direct_sync';

COMMENT ON COLUMN social_inbox_messages.source IS
  'Provenance of the message. ''direct_sync'' = pulled by the direct driver (SMM-38c/38d; the ONLY '
  'inbound path that exists — Postiz has no inbound surface at all, OQ-4). ''reply'' = sent by us. '
  '''postiz_sync'' is DEAD and retained only because rows may already carry it: never write it.';

-- Backfill, ONE TENANT'S AUTHORIZED SET AT A TIME.
--
-- ⚠ I got this wrong on the first pass and `lint:migration-rls` caught it. `social_inbox_messages`
-- is a FORCE-RLS table and migrations run as `platform_owner`, which is NOBYPASSRLS. An UPDATE with
-- no `app.current_tenant_ids` set therefore matches ZERO rows -- and, worse, the "did it work?"
-- assertion that follows ALSO reads zero, so the migration reports success having relabelled
-- nothing. That is the exact trap this file's own header warns about, walked into by the person
-- writing the warning. The lint exists because reasoning about it is not enough.
--
-- Pattern per 0051_pm_short_codes_backfill_fix.sql: iterate companies, set the GUC for that tenant
-- (SET LOCAL semantics, scoped to this migration's transaction -- the same mechanism `withTenants`
-- uses for every ordinary request), then touch the table. Idempotent by construction: the
-- `source = 'postiz_sync'` guard means a second run is a true no-op.
DO $$
DECLARE
  co RECORD;
  moved integer;
  total integer := 0;
  remaining integer := 0;
  left_over integer;
BEGIN
  FOR co IN SELECT id FROM companies WHERE deleted_at IS NULL LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    UPDATE social_inbox_messages SET source = 'direct_sync' WHERE source = 'postiz_sync';
    GET DIAGNOSTICS moved = ROW_COUNT;
    total := total + moved;

    SELECT count(*) INTO left_over FROM social_inbox_messages WHERE source = 'postiz_sync';
    remaining := remaining + left_over;
  END LOOP;

  IF remaining <> 0 THEN
    RAISE EXCEPTION 'SMM-15 follow-up: % row(s) still carry the dead ''postiz_sync'' source after a per-tenant backfill', remaining;
  END IF;

  RAISE NOTICE 'SMM-15 follow-up: relabelled % inbound message(s) postiz_sync -> direct_sync across all tenants', total;
END $$;

-- Self-assertions, in the 0106 idiom: prove the constraint and the default are what this file claims,
-- so a future edit that loosens either fails here rather than in a triage classifier.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'social_inbox_messages_source_check'
       AND pg_get_constraintdef(oid) LIKE '%direct_sync%'
  ) THEN
    RAISE EXCEPTION 'social_inbox_messages_source_check does not admit direct_sync';
  END IF;

  IF (SELECT column_default FROM information_schema.columns
       WHERE table_name = 'social_inbox_messages' AND column_name = 'source') NOT LIKE '%direct_sync%' THEN
    RAISE EXCEPTION 'social_inbox_messages.source default is not direct_sync';
  END IF;
END $$;

COMMIT;
