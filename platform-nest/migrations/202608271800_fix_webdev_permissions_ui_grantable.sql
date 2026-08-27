-- Corrective: three webdev permissions were seeded ui_grantable = false, which silently breaks
-- position attachment on any FRESH database.
--
-- WHAT BROKE, AND WHY IT WAS INVISIBLE. `position_roles_guard()` (migration 0110, clause b) refuses
-- to attach a role to a position if that role's role_permissions bundle contains even ONE
-- ui_grantable = false permission. 202608271400 (WSK-12) granted webdev.zoneb_event.record --
-- flagged ui_grantable = false -- directly to company_admin / manager / owner / platform_admin.
-- 202608271700 (WSK-31) followed that precedent and added two more, newly reaching webdev_manager.
--
-- On the LIVE database this never fired: the permissions row already existed with ui_grantable =
-- true, so those migrations' `INSERT ... WHERE NOT EXISTS` skipped the insert and the flag stayed
-- true. Verified directly on production before writing this. On a FRESH database -- CI, a new
-- environment, the Zone B box when it is provisioned -- the insert DOES run, the flag lands false,
-- and no position can ever hold `manager` again. A latent bug that only appears where nobody was
-- looking, which is the worst place for one.
--
-- WHY ui_grantable = true IS THE CORRECT VALUE, not a workaround for the guard. The Cerbos policies
-- genuinely grant these actions to human roles: resource_webdev_zoneb_event.yaml allows `record` to
-- company_admin and manager, and resource_webdev_provisioned_site.yaml allows operate/promote to the
-- same tiers. Marking them ui_grantable = false asserted the opposite -- that no human may ever hold
-- them -- and two artifacts asserting different things IS the defect. I made that mistake in
-- WSK-12's catalog entry, corrected the description at the time, and left the flag wrong.
--
-- They remain `sensitive` and stay in permission-groups.json's advancedOnly list: that is a
-- UI-authoring restriction (keep them out of the simple group picker), which is a different claim
-- from "no human may hold this".
--
-- Corrective and idempotent by construction. 202608271400 is already applied in production and is
-- NOT edited -- editing an applied migration only ever reaches fresh databases, which is the exact
-- bug class that put two wrong functions into production earlier this month.

UPDATE permissions
   SET ui_grantable = true
 WHERE key IN (
   'webdev.zoneb_event.record',
   'webdev.provisioned_site.operate',
   'webdev.provisioned_site.promote'
 )
   AND ui_grantable = false;

DO $$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad FROM permissions
   WHERE key IN ('webdev.zoneb_event.record','webdev.provisioned_site.operate','webdev.provisioned_site.promote')
     AND ui_grantable = false;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'WEBDEV_UI_GRANTABLE_FIX_FAILED: % row(s) still ui_grantable = false', v_bad;
  END IF;
END $$;
