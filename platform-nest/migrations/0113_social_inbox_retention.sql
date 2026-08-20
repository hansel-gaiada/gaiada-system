-- SMM-36 — per-network inbox retention: purge bookkeeping columns + the state-law CHECKs that
-- make "purged" mean "scrubbed", on both engagement-inbox tables 0105 created.
--
-- Design: docs/blueprints/smm-design-addendum-2026-08-12.md §A4e item 1 (the LinkedIn finding that
-- created this ticket) and §PD (SMM-38's phasing table — 38b explicitly depends on the framework
-- this migration + `src/modules/social/inbox-retention-job.ts` establish, and 38c depends on this
-- ticket landing first). Retention numbers themselves live in code
-- (`src/modules/social/retention-policy.ts`), not in this migration, for the same reason
-- `media-rules.ts` never hardcodes a quota constant: LinkedIn's 24h/48h are the only DOCUMENTED
-- ceiling from OQ-1's research, and a schema-level constant would need a new migration every time
-- research adds or corrects a network's number. This migration only adds the columns a purge needs
-- to be SAFE (idempotent — never re-purges the same row) and OBSERVABLE (a marker an operator or a
-- future audit can point at and say "this is why the comment text is gone").
--
-- ── WHY THIS TICKET OUTRANKS ITS SIZE (see the design doc for the full argument) ─────────────────
-- (1) LinkedIn checks retention compliance at Standard Tier review; `social_inbox_threads`/
--     `social_inbox_messages` were designed (0105) to retain indefinitely — that is what an
--     engagement inbox IS — so this must exist before the first LinkedIn client connects.
-- (2) Owner decision D-20 (2026-08-18) chose to build a `direct` SocialPublisher driver (new ticket
--     SMM-38), which moves OAuth token custody IN-HOUSE for the networks it serves. That makes this
--     migration's purge FRAMEWORK load-bearing custody infrastructure, not only a LinkedIn
--     compliance chore: SMM-38 phase 38b's token-custody purge is designed to register into the
--     SAME per-tenant sweep this migration's columns and the job built on them provide (see that
--     job file's header for exactly what 38b must implement).
--
-- ── WHAT IS PURGED, AND WHAT SURVIVES (the "shell" — addendum §A4e) ───────────────────────────────
-- LinkedIn's two data classes land on DIFFERENT columns of the SAME two tables, so each table gets
-- TWO independent purge markers rather than one:
--   PROFILE data  (another member's name/handle/avatar) -> `profile_data_purged_at`
--     scrubs: social_inbox_threads.author_handle / .author_name
--             social_inbox_messages.author_handle
--   ACTIVITY content (the member's own comment/DM text)  -> `activity_content_purged_at`
--     scrubs: social_inbox_threads.excerpt
--             social_inbox_messages.body (reset to '' — the column is NOT NULL DEFAULT '')
-- Deliberately NOT scrubbed by either marker: id, external_thread_id/external_id (IDs/URNs carry NO
-- restriction per §A4e's own table), status, sentiment, assigned_to, sla_due_at, last_message_at,
-- timestamps, and (on messages) approval_id/args_sha256/status for an outbound reply — an outbound
-- reply is OUR content, not "another member's", and 0105's own `sim_sent_reply_has_approval` CHECK
-- already depends on those columns surviving. The thread/message ROW survives as a shell so the
-- inbox UI can still render "a comment existed here" after its content expires, instead of a
-- disappearing row that looks like a sync bug.
--
-- ── IDEMPOTENCY, ENFORCED IN DDL NOT ONLY IN THE JOB (0105's own CHECK-heavy convention) ─────────
-- Each purge marker is settable exactly once in practice (the job's own `WHERE ... IS NULL` guard),
-- and the four CHECK constraints below encode the state law directly: "if the marker is set, the
-- content IT covers is gone" — so a future write path that sets a marker without scrubbing the
-- column (or vice versa) fails at the database rather than shipping a silent compliance gap.
--
-- ── NUMBERING (migrations/README.md rule 5) ───────────────────────────────────────────────────────
-- `ls migrations | sort | tail` immediately before writing showed the head as
-- `0112_iam_owner_decisions_2026_08_18.sql` with `0113` genuinely free. `0058`/`0059`/`0070` remain
-- the permanently-orphaned reservation gaps — not touched.
--
-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────────
-- Both tables already carry 0105's THIRD wall (`app_module_allowed('social')`); this migration adds
-- columns and constraints only, no new table, so no new RLS policy is needed. ADDITIVE, nullable
-- columns on tables with ZERO rows in every environment this program has (the inbox sync ticket,
-- SMM-15, has not shipped yet) — so there is NO backfill DML, and the 0050 "migration runs
-- NOBYPASSRLS with an unset GUC -> silently matches zero rows and reports success" trap does not
-- apply structurally. Self-asserted anyway below, per the 0106/0112 discipline: never trust, always
-- assert what actually landed.

ALTER TABLE social_inbox_threads
  ADD COLUMN profile_data_purged_at timestamptz,
  ADD COLUMN activity_content_purged_at timestamptz;

ALTER TABLE social_inbox_threads
  ADD CONSTRAINT sit_profile_purge_scrubs_author CHECK (
    profile_data_purged_at IS NULL OR (author_handle IS NULL AND author_name IS NULL)
  );
ALTER TABLE social_inbox_threads
  ADD CONSTRAINT sit_activity_purge_scrubs_excerpt CHECK (
    activity_content_purged_at IS NULL OR excerpt IS NULL
  );

-- Purge-scan index: "which threads of network N still have something left to purge", matching
-- 0105's own `ix_social_inbox_threads_queue`/`_sla` partial-index shape (deleted_at IS NULL).
CREATE INDEX ix_social_inbox_threads_retention
  ON social_inbox_threads (tenant_id, network, created_at)
  WHERE deleted_at IS NULL
    AND (profile_data_purged_at IS NULL OR activity_content_purged_at IS NULL);

ALTER TABLE social_inbox_messages
  ADD COLUMN profile_data_purged_at timestamptz,
  ADD COLUMN activity_content_purged_at timestamptz;

ALTER TABLE social_inbox_messages
  ADD CONSTRAINT sim_profile_purge_scrubs_author CHECK (
    profile_data_purged_at IS NULL OR author_handle IS NULL
  );
ALTER TABLE social_inbox_messages
  ADD CONSTRAINT sim_activity_purge_scrubs_body CHECK (
    activity_content_purged_at IS NULL OR body = ''
  );

CREATE INDEX ix_social_inbox_messages_retention
  ON social_inbox_messages (tenant_id, thread_id, created_at)
  WHERE profile_data_purged_at IS NULL OR activity_content_purged_at IS NULL;

-- ── SELF-ASSERTION (0106/0112 idiom) ────────────────────────────────────────────────────────────
-- Zero DML above, so there is no "delta" to assert — this instead asserts that every object the
-- migration claims to have created actually exists with the shape described, catching a typo'd
-- column/constraint name that would otherwise pass silently (CREATE INDEX/ALTER TABLE with a typo
-- in a WHERE clause does not always error the way a SELECT would).
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'social_inbox_threads'
     AND column_name IN ('profile_data_purged_at', 'activity_content_purged_at');
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected 2 new purge-marker columns on social_inbox_threads, found %', n;
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'social_inbox_messages'
     AND column_name IN ('profile_data_purged_at', 'activity_content_purged_at');
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected 2 new purge-marker columns on social_inbox_messages, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conname IN (
     'sit_profile_purge_scrubs_author', 'sit_activity_purge_scrubs_excerpt',
     'sim_profile_purge_scrubs_author', 'sim_activity_purge_scrubs_body'
   );
  IF n <> 4 THEN
    RAISE EXCEPTION 'expected 4 new purge state-law CHECK constraints, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE indexname IN ('ix_social_inbox_threads_retention', 'ix_social_inbox_messages_retention');
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected 2 new retention-scan indexes, found %', n;
  END IF;
END $$;
-- The state-law CHECKs' actual refusal behavior (a purge marker set WITHOUT scrubbing its column)
-- is exercised against REAL rows with real FK parents in
-- `src/modules/social/inbox-retention-job.test.ts`, using the repo's own `initTestDb` harness —
-- deliberately not attempted here with synthetic FK values, which would make an FK violation and a
-- CHECK violation indistinguishable and turn this assertion into a false pass.
