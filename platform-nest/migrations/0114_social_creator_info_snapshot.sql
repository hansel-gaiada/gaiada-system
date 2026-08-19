-- SMM-10 — D-22's creator-info snapshot: two additive nullable columns on `social_post_variants`,
-- and nothing else. No new table.
--
-- Design: docs/blueprints/smm-design-addendum-2026-08-12.md §A4i OQ-8 -> D-22 (owner decision
-- 2026-08-18: the composer's explicit selections ARE the TikTok creator consent, and `creator_info`
-- is re-verified at dispatch). Contract: `src/modules/social/publish-precondition.ts`'s
-- `CreatorInfoVerifier` seam ("SMM-10 owns where that snapshot is written... and owns the fetch that
-- refreshes it").
--
-- ── WHY TWO COLUMNS ON THE EXISTING TABLE, NOT A NEW TABLE ─────────────────────────────────────────
-- `social_post_variants` already carries 0105's THIRD RLS wall (`app_module_allowed('social')`) and
-- the tenant wall, so a snapshot living here inherits both for free. It also already carries
-- `settings jsonb` — the composer's own per-network selections (privacy level, comment/duet/stitch
-- toggles for TikTok) — which is exactly what the snapshot is compared AGAINST at dispatch. Putting
-- the two side by side is the ticket's own instruction, and it avoids inventing a second table whose
-- only job would be a 1:1 join back to this one.
--
-- ── WHAT THE VERIFIER MAY DO WITH THESE COLUMNS, RESTATED FROM THE SEAM'S OWN CONTRACT ─────────────
-- `creator_info_snapshot` is written ONLY by the live fetch SMM-10's dispatch flow performs OUTSIDE
-- the executor's claim transaction (network I/O there is exactly what the seam forbids). The
-- installed `CreatorInfoVerifier` (also SMM-10's) reads these two columns READ-ONLY, INSIDE the
-- claim transaction, under the advisory lock — no network I/O, matching the seam's own contract.
--
-- ── FRESHNESS IS THE VERIFIER'S CALL, NOT THE SCHEMA'S ──────────────────────────────────────────────
-- This migration does not encode a staleness ceiling in a CHECK: TikTok's "immediately before upload"
-- requirement is a runtime policy question (how stale is too stale), not a structural one, and a
-- CHECK constraint cannot reason about `now()` at write time in a way that would still be true when
-- the row is READ later. `creator_info_fetched_at` carries the fact; the verifier decides what to do
-- with its age.
--
-- ── NUMBERING (migrations/README.md rule 5) ─────────────────────────────────────────────────────────
-- `ls migrations | sort | tail` immediately before writing showed the head as
-- `0113_social_inbox_retention.sql` (SMM-36, landed on `main` after this worktree's branch point —
-- fast-forwarded before this file was written) with `0114` genuinely free. `0058`/`0059`/`0070`
-- remain the permanently-orphaned reservation gaps — not touched.
--
-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
-- Additive nullable columns on a table that already carries every wall it needs (0105). No new RLS
-- policy, no backfill DML (every existing row reads NULL for both, which is the correct "never
-- fetched" state), so the 0050 unset-GUC trap does not apply. Self-asserted below anyway, per the
-- 0106/0112/0113 discipline: never trust, always assert what actually landed.

ALTER TABLE social_post_variants
  ADD COLUMN creator_info_snapshot jsonb,
  ADD COLUMN creator_info_fetched_at timestamptz;

-- ── SELF-ASSERTION (0106/0112/0113 idiom) ───────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'social_post_variants'
     AND column_name IN ('creator_info_snapshot', 'creator_info_fetched_at');
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected 2 new creator-info snapshot columns on social_post_variants, found %', n;
  END IF;

  -- Both columns must be nullable (no backfill, no NOT NULL) — a typo'd DEFAULT/NOT NULL here would
  -- fail every existing row's next UPDATE silently until someone happened to hit it.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'social_post_variants'
     AND column_name IN ('creator_info_snapshot', 'creator_info_fetched_at')
     AND is_nullable = 'YES';
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected both creator-info snapshot columns to be nullable, found % nullable', n;
  END IF;
END $$;
-- Behavioural coverage (the verifier reads these read-only, under lock, and refuses on absence/
-- staleness/mismatch) lives in
-- `src/modules/social/creator-info-verifier.test.ts` against the repo's own `initTestDb` harness.
