-- SMM-39 — one additive column on `social_post_variants`: a persisted map of already-uploaded
-- engine media refs, kept structurally OUTSIDE the D-15 approval hash.
--
-- Design: docs/blueprints/smm-design-addendum-2026-08-12.md §PE (uploadMedia wiring). Contract:
-- `src/modules/social/dispatch.ts`'s `resolveEngineMedia` (the upload step) and
-- `src/modules/social/canonical-args.ts`'s `variantPublishArgs` (the hash, which reads `media` and
-- MUST NEVER read this column).
--
-- ── WHY A NEW COLUMN, NOT A WRITE TO `media` ────────────────────────────────────────────────────
-- `media jsonb` is composer content: it is inside `VariantPublishArgs` (canonical-args.ts) and is
-- therefore inside `args_sha256` (D-15). If the upload step wrote engine refs into THAT column, the
-- act of resolving media for dispatch would itself change the hash the approval was minted against —
-- every media post would refuse its own approval with `args_hash_mismatch`, a self-inflicted
-- deadlock (this ticket's own brief, §PE). So the resolved refs live in a SECOND column that
-- `variantPublishArgs` never reads and never will: `uploaded_media jsonb`, keyed by the composer's
-- own `fileId` (`{"<fileId>": {"id": "<engine-media-id>", "url"?: "<engine-url>"}}`), NOT an ordered
-- array — a map is what makes "have we already uploaded THIS fileId" an O(1) key lookup rather than
-- a linear scan, and what makes the persist-write a plain jsonb merge (`uploaded_media || $2::jsonb`)
-- that can never clobber a sibling file's entry.
--
-- ── WHY THIS IS THE IDEMPOTENCY BACKSTOP, NOT JUST A CACHE ──────────────────────────────────────
-- `dispatch.ts` persists ONE file's ref immediately after ITS OWN upload succeeds — not batched at
-- the end of the loop. So a redispatch (a fresh approval filed after a prior attempt failed on the
-- Nth of N attachments, per SMM-09's `neverAutoRetry` doctrine) reads this column first and only
-- uploads the fileIds still missing from it. Without this column, a retry would re-upload every
-- attachment on every attempt — wasteful, and the ticket's own "must not produce a duplicate
-- gallery" requirement would not hold.
--
-- ── WHY NO NEW TABLE (mirrors 0114's reasoning) ─────────────────────────────────────────────────
-- `social_post_variants` already carries 0105's third RLS wall (`app_module_allowed('social')`) and
-- the tenant wall, so a column here inherits both for free, exactly as 0114's
-- `creator_info_snapshot` argued. A new table's only job would be a 1:1 keyed lookup back to this
-- row, for no benefit over a jsonb map on the row itself.
--
-- ── NUMBERING (migrations/README.md rule 5) ─────────────────────────────────────────────────────
-- `ls migrations | sort | tail` immediately before writing this file showed the head as
-- `0115_iam_override_decide.sql` with `0116` genuinely free (`0114` is DOUBLE-USED by two sessions
-- that landed concurrently — `0114_iam_self_scoped_marker.sql` and
-- `0114_social_creator_info_snapshot.sql` — a pre-existing collision this ticket does not touch).
-- `0058`/`0059`/`0070` remain the permanently-orphaned reservation gaps.
--
-- ── RLS / BACKFILL ───────────────────────────────────────────────────────────────────────────────
-- Additive column, `NOT NULL DEFAULT '{}'::jsonb` (matching the table's own `media jsonb NOT NULL
-- DEFAULT '[]'` style) so every existing row reads "nothing uploaded yet" with no backfill DML and
-- no unset-GUC trap. No new RLS policy needed — 0105's existing policy already covers this column.
-- Self-asserted below anyway, per the 0106/0112/0113/0114 discipline: never trust, always assert
-- what actually landed.

ALTER TABLE social_post_variants
  ADD COLUMN uploaded_media jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN social_post_variants.uploaded_media IS
  'SMM-39: {"<fileId>": {"id": engine media id, "url"?: engine url}} for attachments already '
  'uploaded to the publishing engine. Written incrementally by dispatch.ts, one fileId at a time, '
  'immediately after that fileId''s own upload succeeds — the idempotency backstop for a redispatch. '
  'Deliberately OUTSIDE VariantPublishArgs / args_sha256 (D-15): an upload must never invalidate the '
  'approval it is executing under.';

-- ── SELF-ASSERTION (0106/0112/0113/0114 idiom) ──────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'social_post_variants' AND column_name = 'uploaded_media';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected uploaded_media column on social_post_variants, found %', n;
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'social_post_variants' AND column_name = 'uploaded_media'
     AND is_nullable = 'NO' AND data_type = 'jsonb';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected uploaded_media to be NOT NULL jsonb, found % matching', n;
  END IF;

  -- No backfill DML above, so every existing row must read the empty-map default.
  SELECT count(*) INTO n FROM social_post_variants WHERE uploaded_media <> '{}'::jsonb;
  IF n <> 0 THEN
    RAISE EXCEPTION 'expected every existing row to default to an empty uploaded_media map, found % non-empty', n;
  END IF;
END $$;
-- Behavioural coverage (upload-then-persist, idempotent redispatch skip, partial-failure refusal,
-- text-only variants never touching this column or the driver's uploadMedia) lives in
-- `src/modules/social/dispatch.test.ts` against the repo's own `initTestDb` harness.
