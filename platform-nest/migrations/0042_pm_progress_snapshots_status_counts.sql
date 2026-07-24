-- P3-05 — Per-status snapshot counts + flow endpoint.
-- Adds a jsonb {statusId: count} column to the existing pm_progress_snapshots (0040) so the
-- flow-diagram view can chart per-status volume over time without a new table. Aggregated by
-- pm.controller.ts's upsertTodaySnapshot() in the SAME upsert that already derives open/done
-- from the project's effective status set (P2-04) -- orphaned/stale status ids from a since-
-- deleted status are kept as-is (never pruned here). No RLS change: the table is already
-- FORCE-RLS'd via tenant_isolation (0040), and this is an additive column on it.
ALTER TABLE pm_progress_snapshots ADD COLUMN status_counts jsonb NOT NULL DEFAULT '{}';
