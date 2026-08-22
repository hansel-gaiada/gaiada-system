-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- IAM-15 · remove `group_executive` (D-7) — the last Phase 3 ticket
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- D-7: "Remove `group_executive` — the last unrestricted cross-company business role."
--
-- ── WHY THIS IS SAFE TO DO NOW, AND WAS NOT BEFORE ────────────────────────────────────────────────
-- The Phase 3 readiness assessment deliberately sequenced this LAST, for two reasons that have both
-- now been satisfied:
--
--   1. MON-00c root-bounded `group_executive` behind `variables.inRoot` across ~40 policies as INTERIM
--      protection. Doing the removal first would have discarded that work for no gain; doing it last
--      means the estate was protected for the whole interval either way.
--   2. `owner` (IAM-14) now exists. That matters because the two roles overlap in INTENT — several
--      policies literally commented the exec rule as "Owner (group_executive) ... design §11 owner" —
--      so removing the exec tier before a real `owner` existed would have left holding-wide business
--      oversight with no representation at all.
--
-- ⚠ WHO LOSES ACCESS: NOBODY REAL. The estate's only holder is `exec@gaiada.test`, a seed FIXTURE.
-- That was checked before writing this, not assumed — a role removal is a narrowing, and narrowing
-- authorization without knowing who holds the role is how an outage gets shipped as a cleanup.
-- The seed's own grant is removed in the same change (src/seed/agency.ts + roster.ts).
--
-- ⚠ THE POLICY SIDE IS THE REAL REMOVAL, NOT THIS FILE. 54 `group_executive`-only rules were deleted
-- from 46 Cerbos policies in the same commit; those rules WERE the role's entire reach. This migration
-- removes the grant and the row so nothing can hold a role that now confers nothing. Order matters
-- for a live rollout: the policies ship with the image and Cerbos must be RESTARTED (it does not
-- hot-reload), so between deploy and restart a holder briefly retains reach — which is precisely why
-- revoking the grant here, in the migration that runs at boot, is the belt to the policy's braces.

-- ── 1 · revoke every grant ────────────────────────────────────────────────────────────────────────
-- Deleted rather than expired: `expires_at` is not read by `assemblePrincipal()` yet (the sweep that
-- acts on it is P2-09's), so an "expired" grant would still be live. A revocation that does not
-- revoke is worse than none, because it reads as done.
DELETE FROM user_roles
 WHERE role_id IN (SELECT id FROM roles WHERE name = 'group_executive');

-- ── 2 · bump the session version of anyone who held it ────────────────────────────────────────────
-- D11: a live session caches its principal. Without this, a holder keeps exec reach until their token
-- naturally refreshes — and the whole point of step 1 is that they should not.
--
-- ⚠ This runs AFTER the delete, so it cannot read user_roles to find who was affected. Bumping every
-- user is the correct trade: session_version is a cheap monotonic counter and a re-assembled principal
-- is identical for everyone who never held the role. Under-bumping would leave exactly the principals
-- this ticket is about still holding it.
UPDATE users SET session_version = session_version + 1, updated_at = now()
 WHERE deleted_at IS NULL;

-- ── 3 · drop any permission-arm rows, then the role itself ────────────────────────────────────────
-- `group_executive` should have NO role_permissions: IAM-04c is explicit that the tier bypass never
-- enters the permission catalog, and every batch report says a group_executive-only rule is never
-- mirrored. Deleting defensively anyway — if a row DID exist, the FK below would refuse the drop and
-- the failure would be a puzzle rather than a fact.
DELETE FROM role_permissions
 WHERE role_id IN (SELECT id FROM roles WHERE name = 'group_executive');

DELETE FROM position_roles
 WHERE role_id IN (SELECT id FROM roles WHERE name = 'group_executive');

DELETE FROM roles WHERE name = 'group_executive';

-- ── 4 · report, so the outcome is checked rather than trusted ─────────────────────────────────────
DO $$
DECLARE
  n_roles integer;
  n_grants integer;
BEGIN
  SELECT count(*) INTO n_roles FROM roles WHERE name = 'group_executive';
  SELECT count(*) INTO n_grants FROM user_roles ur
    WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = ur.role_id);

  RAISE NOTICE 'IAM-15: group_executive role rows remaining = % (want 0)', n_roles;

  IF n_roles <> 0 THEN
    RAISE EXCEPTION 'IAM-15: group_executive still exists after the delete — refusing to report a removal that did not happen';
  END IF;
  -- An orphaned user_roles row (role_id pointing at nothing) would mean the FK did not cascade the way
  -- this file assumes. `assemblePrincipal` joins roles, so such a row is invisible rather than
  -- dangerous — but it is still a broken invariant and better surfaced here than found later.
  IF n_grants <> 0 THEN
    RAISE EXCEPTION 'IAM-15: % user_roles row(s) now reference a non-existent role', n_grants;
  END IF;
END $$;
