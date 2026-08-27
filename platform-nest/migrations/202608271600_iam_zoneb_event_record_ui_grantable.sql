-- IAM fix — `webdev.zoneb_event.record` must be ui_grantable (2026-08-27).
--
-- 202608271400 (WSK-12) inserted this key with `ui_grantable = false` AND bundled it onto `manager`
-- and `company_admin`. Those two facts cannot both stand, and the database says so:
-- `position_roles_guard()` clause (b) refuses to attach any role carrying a non-ui_grantable
-- permission to a position, so `seedPositions()` throws
--
--     position_roles: role "manager" carries 1 non-ui_grantable permission(s) in its bundle and
--     can never be attached to a position
--
-- which took NINE test files red on `main` — the four seed suites, the positions controller, the
-- IAM guard, the catalog-parity and ui-grantable pins, and the permission-chain sweep. One flag,
-- eight files that never mention it. Reproduced on a clean origin/main checkout before this fix was
-- written, so it is not a merge artifact.
--
-- ── WHY `true` IS THE CORRECT SIDE OF THE CONTRADICTION ────────────────────────────────────────
-- `ui_grantable = false` is not a general "hide this" flag. It is a narrow allow-list carve-out with
-- a stated composition, pinned by `iam-phase2-ui-grantable-guard.test.ts`:
--
--     exactly 22 rows are ui_grantable=false (15 relationship + 7 portal.*)
--
-- and documented in that file's header as "portal.*/relationship-class false; everything else true".
-- `webdev.zoneb_event.record` is grantable-class and is not a `portal.*` key, so it is neither of the
-- two things the carve-out exists for. Its own sibling `webdev.zoneb_event.read` is `true`. Setting
-- it false made the count 23 and broke the invariant by construction.
--
-- The alternative fix — dropping `record` from the manager/company_admin bundles — was considered and
-- rejected, because `resource_webdev_zoneb_event.yaml` grants the action to those roles deliberately
-- and says why: it is the intake endpoint for the `wd-zoneb-intake` flow and is pinned `impact:
-- "low"` ("can create at most a notification and a log row, never a privileged transition"). Removing
-- the grant would change WSK-12's access design to satisfy a flag; correcting the flag leaves the
-- design intact. Owner ruled for this side on 2026-08-27.
--
-- ⚠ A NEW MIGRATION, not an edit to 202608271400 — that file is already on the deploy branch, and
-- editing it would reach fresh databases only while never reaching an estate that had already run
-- it. That is the exact failure `npm run lint:migration-immutable` exists to refuse, and the gate
-- would (correctly) reject the edit.

UPDATE permissions
   SET ui_grantable = true
 WHERE key = 'webdev.zoneb_event.record'
   AND ui_grantable IS DISTINCT FROM true;

-- Assert, rather than trust. A silent no-op here would leave `main` red and look like a clean run —
-- and this table is not tenant-scoped, so there is no RLS/GUC trap of the kind that makes other
-- backfills report success against zero rows.
DO $$
DECLARE v_bad integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE key = 'webdev.zoneb_event.record') THEN
    RAISE EXCEPTION 'IAM_ZONEB_KEY_MISSING: webdev.zoneb_event.record is not in the catalog — 202608271400 did not run';
  END IF;
  IF EXISTS (SELECT 1 FROM permissions WHERE key = 'webdev.zoneb_event.record' AND ui_grantable IS NOT TRUE) THEN
    RAISE EXCEPTION 'IAM_ZONEB_UI_GRANTABLE_NOT_SET: the update matched no row';
  END IF;

  -- The invariant this restores, checked directly: ui_grantable=false is relationship-class or
  -- portal.* and nothing else.
  SELECT count(*) INTO v_bad
    FROM permissions
   WHERE ui_grantable IS NOT TRUE
     AND class <> 'relationship'
     AND key NOT LIKE 'portal.%';
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'IAM_UI_GRANTABLE_INVARIANT_BROKEN: % non-relationship, non-portal permission(s) are still ui_grantable=false', v_bad;
  END IF;
END $$;
