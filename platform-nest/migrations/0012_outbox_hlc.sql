-- Hybrid Logical Clock column on the shared outbox (sync-engine revision
-- 2026-07-06-ws1-sync-engine-revision.md §2, D3 fix #2): the HLC is the ONLY clock used for
-- cross-site ordering and conflict comparison. Never `created_at`/`updated_at` (wall clocks).
--
-- Canonical text format is ZERO-PADDED "%013d.%010d" (wallMs.counter) so plain text ordering
-- equals logical ordering — this is what makes `hlc > last_pushed_hlc` cursors and MAX(hlc)
-- seeding correct as ordinary text comparisons (unpadded "%d.%d" would sort "1000..." before
-- "999..."). Both platform-nest (src/events/hlc.ts) and sync-engine-go emit this same format.

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS hlc text;

-- Backfill any pre-existing rows deterministically from (created_at, id) order so no row is
-- left with a null clock. wallMs = epoch-ms of created_at; counter = per-origin ordinal within
-- an identical wallMs, assigned by (created_at,id) so it is stable and monotonic.
WITH ordered AS (
  SELECT id,
         (extract(epoch FROM created_at) * 1000)::bigint AS wall_ms,
         row_number() OVER (
           PARTITION BY origin_site, (extract(epoch FROM created_at) * 1000)::bigint
           ORDER BY created_at, id
         ) - 1 AS ctr
  FROM outbox_events
  WHERE hlc IS NULL
)
UPDATE outbox_events e
SET hlc = lpad(o.wall_ms::text, 13, '0') || '.' || lpad(o.ctr::text, 10, '0')
FROM ordered o
WHERE e.id = o.id;

-- Feeds startup seeding: SELECT MAX(hlc) WHERE origin_site = $1 (correct as text, see above).
CREATE INDEX IF NOT EXISTS idx_outbox_hlc_origin ON outbox_events (origin_site, hlc);
