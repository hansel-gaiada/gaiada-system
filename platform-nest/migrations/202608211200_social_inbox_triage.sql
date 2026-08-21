-- SMM-16 — AI triage columns on `social_inbox_threads`: sentiment / category / urgency, and the
-- three-fact classification-state model `capabilities.ts` already established for this module
-- (`unclassified` / `unavailable` / `classified` — never collapsed into one boolean or one nullable
-- column that cannot tell "never asked" from "asked, got nothing usable").
--
-- ── WHY THREE STATES, NOT JUST A NULLABLE `sentiment` ─────────────────────────────────────────────
-- 0105 already shipped `sentiment text CHECK (... 'positive','neutral','negative','urgent')`,
-- nullable, "AI-stamped". A nullable column can tell "classified as X" from "never classified" —
-- but it CANNOT tell "we tried and the gateway had nothing usable" from "we never tried at all",
-- and a triage QUEUE (SMM-18) needs exactly that distinction to know whether a thread is waiting on
-- the next sweep or waiting on a human because AI drafting is down. `ai_triage_status` makes that a
-- real, queryable fact instead of something inferred from `ai_triage_at` being null-or-not.
--
-- `sentiment`'s existing 'urgent' value is left in place (0105 already shipped it; a live column
-- value is history, same as the provenance migration's 'postiz_sync') but this ticket never writes
-- it going forward — urgency is now its OWN axis (`urgency`), independent of tone. Sentiment answers
-- "how does the commenter feel", urgency answers "how fast should a human respond"; 0105 conflated
-- them into one enum before urgency had its own column.
--
-- ── category / urgency ────────────────────────────────────────────────────────────────────────────
-- `category`: question | complaint | praise | spam | other.
-- `urgency`:  low | normal | high — see `inbox-triage-job.ts`'s header for why this does NOT drive
--             `sla_due_at` (0105's `social_engagements.tool_scope.inbox.slaMinutes` does, per
--             engagement — never a value this ticket invents).
--
-- ── THE RETENTION QUESTION THE TICKET ASKS BY NAME ────────────────────────────────────────────────
-- A sentiment/category/urgency label is DISTILLED FROM comment text, and LinkedIn's Data Storage
-- Requirements cap "a member's own social-activity content" (comment text) at 48h (addendum §A4e,
-- `retention-policy.ts`). A classification derived from that text is not the raw text, but it is
-- still a representation of it — keeping "the model said this comment was an angry complaint"
-- forever, after the comment itself was purged, would keep exactly the kind of derived personal-
-- content fact the 48h rule exists to bound. Decision: YES, it is subject to the same cap, on the
-- SAME clock as the excerpt/body purge (`activity_content_purged_at`), because deriving a second
-- expiry clock for the same underlying fact would be a second cap that could drift from the first
-- and is not needed. `sit_activity_purge_scrubs_triage` below makes a purged row STRUCTURALLY unable
-- to hold a live classification, mirroring `sit_activity_purge_scrubs_excerpt`
-- /`sit_profile_purge_scrubs_author` exactly (0113) — never a convention, a CHECK. The 'purged'
-- status is the fourth, honest fact this creates: "this thread WAS classified, and the derivative
-- was scrubbed along with its source text", distinct from 'unclassified' ("never touched"). Wired
-- into `inbox-retention-job.ts`'s EXISTING purge step (SMM-36's seam) — never a second job.
--
-- ── sla_alerted_at ─────────────────────────────────────────────────────────────────────────────────
-- Dedup marker for the SLA guard sweep (`inbox-triage-job.ts#runInboxSlaGuard`): a breach is
-- notified once per time the thread crosses its OWN `sla_due_at`, not once per 15-minute sweep tick
-- for as long as it stays open. Re-armed automatically the next time `sla_due_at` moves forward
-- (`sla_alerted_at < sla_due_at` is the guard's own re-check), so a resolved-then-reopened SLA still
-- gets a fresh alert rather than being silenced forever by one stale timestamp.

BEGIN;

ALTER TABLE social_inbox_threads
  ADD COLUMN category text,
  ADD COLUMN urgency text CHECK (urgency IN ('low', 'normal', 'high')),
  ADD COLUMN ai_triage_status text NOT NULL DEFAULT 'unclassified'
    CHECK (ai_triage_status IN ('unclassified', 'unavailable', 'classified', 'purged')),
  ADD COLUMN ai_triage_at timestamptz,
  ADD COLUMN sla_alerted_at timestamptz;

ALTER TABLE social_inbox_threads
  ADD CONSTRAINT sit_triage_category_check
  CHECK (category IS NULL OR category IN ('question', 'complaint', 'praise', 'spam', 'other'));

-- The three/four-fact shape: exactly one of these holds at all times.
ALTER TABLE social_inbox_threads
  ADD CONSTRAINT sit_triage_shape CHECK (
    (ai_triage_status = 'unclassified'
      AND sentiment IS NULL AND category IS NULL AND urgency IS NULL AND ai_triage_at IS NULL)
    OR (ai_triage_status IN ('unavailable', 'purged')
      AND sentiment IS NULL AND category IS NULL AND urgency IS NULL AND ai_triage_at IS NOT NULL)
    OR (ai_triage_status = 'classified'
      AND sentiment IS NOT NULL AND category IS NOT NULL AND urgency IS NOT NULL AND ai_triage_at IS NOT NULL)
  );

-- The retention interaction named above, in the 0113 idiom: structurally, not conventionally.
ALTER TABLE social_inbox_threads
  ADD CONSTRAINT sit_activity_purge_scrubs_triage
  CHECK (activity_content_purged_at IS NULL OR ai_triage_status <> 'classified');

COMMENT ON COLUMN social_inbox_threads.ai_triage_status IS
  'unclassified = never attempted. unavailable = attempted, gateway/parse gave nothing usable '
  '(NEVER a guessed value). classified = sentiment/category/urgency are the model''s real answer. '
  'purged = WAS classified, then scrubbed on the same clock as activity_content_purged_at (SMM-16 '
  'migration header: a classification is derived from comment text and inherits its retention cap).';

-- Self-assertions, in the 0106 idiom: prove the shape holds on THIS database, not just in the SQL
-- above, so a future edit that loosens a CHECK fails here rather than in a classifier.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'social_inbox_threads' AND column_name = 'ai_triage_status'
  ) THEN
    RAISE EXCEPTION 'social_inbox_threads.ai_triage_status was not created';
  END IF;

  IF (SELECT column_default FROM information_schema.columns
       WHERE table_name = 'social_inbox_threads' AND column_name = 'ai_triage_status') NOT LIKE '%unclassified%' THEN
    RAISE EXCEPTION 'social_inbox_threads.ai_triage_status default is not unclassified';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sit_triage_shape'
  ) THEN
    RAISE EXCEPTION 'sit_triage_shape constraint is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sit_activity_purge_scrubs_triage'
  ) THEN
    RAISE EXCEPTION 'sit_activity_purge_scrubs_triage constraint is missing';
  END IF;

  -- Prove the shape CHECK's own definition actually names the 'classified' branch requiring all
  -- three fields — a text-level proof (no dependency on any existing company/account row existing
  -- at migration time, unlike a real INSERT attempt, which would hit `social_accounts`' FK first
  -- and never reach this CHECK at all on a fresh database).
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'sit_triage_shape')
       NOT LIKE '%classified%' THEN
    RAISE EXCEPTION 'sit_triage_shape does not mention the classified branch';
  END IF;
END $$;

COMMIT;
