-- 202609011500_webdev_provisioned_sites_provider_widen.sql
--
-- `provision` (gda-s01) is DECOMMISSIONED, not merely deprecated: `https://provision.gaiada.online`
-- measured 000 on every request 2026-09-01, and the live `.env` on gda-aicenter carries no
-- PROVISION_* vars at all. webdesk-design-v2.md §08 rules this: "ERP repo control (new, replaces
-- `provision`)" owns "the repo from a per-kind template + the `webdev_sites` row + the Zone B
-- tenant" — §08 SUPERSEDES docs/blueprints/provision-erp-seam-design.md v1.0. This migration is the
-- schema quarter of that swap: `0090`'s `provider CHECK IN ('provision','webdesk')` gets a third
-- value, `'erp_repo'` — the new driver's stable identifier (`ProvisionProvider.key`, see
-- `modules/webdev/erp-repo-control-provider.ts`), so the mirror table can record which driver
-- actually created a given site's repo.
--
-- ── WHAT "WIDEN" MEANS HERE, PRECISELY (mirrors 202609011230's own framework-widen idiom) ────────
-- ADDITIVE ONLY: `'provision'` and `'webdesk'` are KEPT, not renamed or dropped — every already-
-- applied row used `'provision'` (the DEFAULT), and rule 4 (migrations/README.md) forbids
-- rewriting history. `'erp_repo'` is the only new member. The column's `DEFAULT 'provision'` is
-- also LEFT AS-IS: `provisioning.service.ts`'s INSERT always supplies an explicit `provider.key`
-- from the caller-selected `ProvisionProvider` instance (`webdev.controller.ts`'s `resolveProvider`,
-- which as of this ticket only ever constructs the `erp_repo` driver) — the column default is a
-- schema-level safety net for a hand-written INSERT that omits the column, not a live code path,
-- and changing which literal it defaults to is a separate decision this migration does not make.
--
-- ── WHY DROP-AND-RE-ADD, LOOKED UP BY DEFINITION (0028 / 0115 / 202609011230's own verbatim idiom) ──
-- Postgres cannot ALTER a CHECK in place. The constraint is found by its DEFINITION (`%provider%`),
-- not a hardcoded name, because 0090 let Postgres auto-name it and a literal guess would break
-- silently on any environment where that name differs — MEASURED here to in fact be
-- `webdev_provisioned_sites_provider_check`, Postgres's own default auto-name for an inline
-- `CHECK` on the `provider` column (table_column_check), which is also the literal name this
-- migration re-ADDs below; without the DROP succeeding first, the ADD collides with it
-- (`constraint "webdev_provisioned_sites_provider_check" already exists`) instead of widening it.
-- The bare `%provider%` pattern (not `%provider%IN%`, which this migration originally tried and
-- which never matched) is deliberate: Postgres CANONICALIZES `x IN (a,b,c)` into
-- `x = ANY (ARRAY[...])` in `pg_get_constraintdef`'s output, so a pattern requiring the literal
-- substring `IN` never matches a real `CHECK (... IN (...))` constraint at all — 202609011230's own
-- bare `%framework%` (no `IN`) is the correct precedent, not an oversight to tighten. `%provider%`
-- ALSO matches `wps_provider_ref_present_once_egressed` (0090's OTHER check constraint — its
-- definition mentions `provider_ref`, which contains `provider` as a substring), so the
-- `NOT ILIKE '%provider_ref%'` guard below is required and load-bearing, not defensive noise.
--
-- ── ZERO BACKFILL DML ──────────────────────────────────────────────────────────────────────────
-- No UPDATE/DELETE/INSERT..SELECT anywhere in this file. Every existing row's `provider` value
-- (`'provision'`; nothing has ever used `'webdesk'` in production) is already a member of the
-- widened set, so there is nothing to backfill.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'webdev_provisioned_sites'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%provider%'
     AND pg_get_constraintdef(oid) NOT ILIKE '%provider_ref%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE webdev_provisioned_sites DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE webdev_provisioned_sites
  ADD CONSTRAINT webdev_provisioned_sites_provider_check
  CHECK (provider IN ('provision', 'webdesk', 'erp_repo'));
