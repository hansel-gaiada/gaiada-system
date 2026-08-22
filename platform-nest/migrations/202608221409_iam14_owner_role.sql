-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- IAM-14 · the `owner` role (D-8) — Phase 3's first ticket
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- D-8: "New `owner` role. Company owner; may hold one company, several, or the holding. Everything
-- business + role authoring in owned companies; NO platform/system controls."
--
-- ⚠ THIS DOES NOT TOUCH `platform_admin`, WHICH REMAINS THE HIGHEST ROLE IN THE SYSTEM. D-6's
-- "collapse `platform_admin` and `superadmin`" removed a duplicate NAME, never the capability: there
-- has only ever been one platform-level tier in the schema, and `owner` sits BESIDE it, not above it.
-- The two are different axes — `platform_admin` is platform/system (technical), `owner` is business
-- authority over the companies someone actually owns.
--
-- ── THE ENVELOPE IS company_admin's, AND THAT IS THE DESIGN, NOT A SHORTCUT ───────────────────────
-- `owner` gets NO Cerbos rules (IAM-04c §3: "the first permission-native role — a platform-managed
-- bundle over the grantable catalog, scoped per owned company, enforced exclusively through the
-- IAM-04 permission-matching path"). Its reach is therefore entirely its `role_permissions` rows,
-- which are seeded here as a copy of `company_admin`'s, because:
--
--   `company_admin` IS "everything business + role authoring" for ONE company. It already carries
--   core.role_grant.{create,revoke,decide_override} and the whole core.position.* set — D-5's role
--   authoring — and it holds none of the 19 keys `platform_admin` has that owner must not reach.
--
-- Those 19 were checked individually rather than assumed, because they are NOT all "platform
-- controls" in the obvious sense and a guessed exclusion list would have got them wrong:
--   · portal.{read,decide,sign,pay,approve_post,request_change,update_profile} — the staff/client
--     TRUST boundary (design §7). An owner reaching these is the portal leak path, and excluding
--     them is precisely why owner is a bundle rather than a wildcard.
--   · social.platform_app.{read,admin} — platform OAuth app credentials, not a business asset.
--   · core.rollup.read, core.service_assignment.reconcile — cross-company OPERATOR surfaces.
--   · reports.appraisal.* and reports.checkin.submit — SELF-scoped actions; a person submits their
--     own appraisal or checkin. An owner gets these as an employee if they are one, never as owner.
--   · hr.case.cancel — company_admin lacks it too, so including it would make owner MORE than
--     "everything company_admin can do", which is not what D-8 says.
--
-- What distinguishes `owner` from `company_admin` is SCOPE, not reach: the same business envelope
-- held across every company in a holding rather than one. That is why `owner` is on the Phase-2
-- elevated fence (`grant-write.service.ts`) and `company_admin` is not — the fence was written to
-- already list `owner` "ahead of its Phase-3 existence ... so it is closed on the day that role is
-- seeded, not one ticket later". Today is that day, and the fence is already shut.

-- ── 1 · the role row ──────────────────────────────────────────────────────────────────────────────
-- GLOBAL role (company_id NULL), like every other library role: the row is the role's DEFINITION,
-- while WHERE it applies is decided per grant (`user_roles.scope_type/scope_id`). A per-company
-- roles row would create one `owner` definition per company and make the bundle unmaintainable.
--
-- `0073`'s partial unique index on (name) WHERE company_id IS NULL is what makes this idempotent —
-- a bare `UNIQUE (company_id, name)` never conflicts for NULL company_id, which is how `roles`
-- previously accumulated ten `manager` rows.
INSERT INTO roles (id, company_id, name, description)
SELECT gen_random_uuid(), NULL, 'owner',
       'Company owner (D-8). Everything business + role authoring in the companies they own; no platform/system controls. Held per owned company, or across a holding.'
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE company_id IS NULL AND name = 'owner');

-- ── 2 · the bundle, copied from company_admin ─────────────────────────────────────────────────────
-- INSERT..SELECT rather than a literal key list, deliberately: the two sets must be IDENTICAL, and
-- a literal list would be a second place to update whenever a policy changes. The generator
-- (`scripts/generate-role-bundles.mjs`) derives `owner` the same way for the JSON artifact, so both
-- expressions of this rule read "owner = company_admin" rather than repeating 264 keys.
--
-- `role_permissions_reject_relationship` (0093) remains the backstop: it would refuse a
-- class='relationship' key even if company_admin somehow held one. It does not — but the trigger
-- means this file cannot introduce the Ruling-3 violation even by accident.
-- `role_permissions` is (role_id, permission_id) with a composite PK and no surrogate id or
-- origin_site — matching 0098's idiom exactly rather than the shape I first assumed.
INSERT INTO role_permissions (role_id, permission_id)
SELECT o.id, rp.permission_id
  FROM roles o
  JOIN roles ca ON ca.company_id IS NULL AND ca.name = 'company_admin'
  JOIN role_permissions rp ON rp.role_id = ca.id
 WHERE o.company_id IS NULL AND o.name = 'owner'
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions x WHERE x.role_id = o.id AND x.permission_id = rp.permission_id
   );

-- ── 3 · report, so the numbers are checked rather than trusted ────────────────────────────────────
DO $$
DECLARE
  n_owner integer;
  n_admin integer;
BEGIN
  SELECT count(*) INTO n_owner
    FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
   WHERE r.company_id IS NULL AND r.name = 'owner';
  SELECT count(*) INTO n_admin
    FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
   WHERE r.company_id IS NULL AND r.name = 'company_admin';

  RAISE NOTICE 'IAM-14: owner bundle = % rows, company_admin = % rows', n_owner, n_admin;

  -- A mismatch means company_admin had no bundle seeded in this database (a fresh DB that ran
  -- migrations without 0094/0098's data, say). Failing loudly beats seeding a SHORT envelope for the
  -- highest-risk role in the system and having nobody notice which permissions it silently lacks.
  IF n_owner <> n_admin THEN
    RAISE EXCEPTION 'IAM-14: owner bundle (%) does not match company_admin (%) — refusing to leave the owner envelope partial', n_owner, n_admin;
  END IF;
END $$;

COMMENT ON TABLE role_permissions IS
  'IAM-02a bundles. Since IAM-14, `owner` is bundled here as an exact copy of `company_admin` — '
  'owner has ZERO Cerbos rules by design (IAM-04c §3) and is enforced entirely through the '
  'permission-matching arm, so these rows ARE its reach. Regenerate the JSON twin with '
  '`npm run gen:role-bundles`.';
