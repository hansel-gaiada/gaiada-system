-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- IAM-14c · `core.integration_connection.manage` — the company tier gets its own key
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Owner decision 2026-08-23 (Design A of docs/superpowers/plans/2026-08-23-integration-connection-
-- key-split.md).
--
-- ── THE GAP THIS CLOSES, AND WHAT IT IS *NOT* ─────────────────────────────────────────────────────
-- `integration_connection` guards an at-rest credential vault. Its company tier (company_admin /
-- manager reaching ANY row) was deliberately left unmirrored by IAM-14b, because member and viewer
-- hold the SAME four keys — so an unconditional mirror would have handed every member the company's
-- whole vault. That refusal (IAM-04-B5) was and remains correct.
--
-- The cost was `owner`. Being permission-native (IAM-04c §3 — zero Cerbos rules), it reached this
-- kind only through the perm arm, so an owner could manage their own connections and NOTHING on a
-- company they own. This is not a fix for an over-grant; it is a fix for an under-grant.
--
-- ── WHY A NEW ACTION AND NOT A SECOND KEY ON AN EXISTING ONE ──────────────────────────────────────
-- A scope-suffixed key (`…read_any` beside `…read`) needs two catalog entries sharing one
-- (cerbos_kind, cerbos_action) pair. ZERO of the ~300 grantable entries do that, and
-- `cerbos-catalog-alignment.test.ts` builds those pairs as a Set — duplicates collapse silently —
-- while separately requiring every entry's action to exist as a literal in the policy. So the split
-- had to be a real ACTION. Measured before choosing, not assumed.
--
-- ⚠ ADDITIVE BY CONSTRUCTION. The four existing actions keep their rules untouched, so a
-- company_admin acting on their own row is unaffected. member/viewer gain nothing: they do not hold
-- `manage`, which is the entire point of minting a new key rather than widening an old one.

-- ── 1 · the catalog row ───────────────────────────────────────────────────────────────────────────
-- SENSITIVE: this is company-wide reach over credential-bearing rows. `read` on this kind is marked
-- not-sensitive because a member reading their OWN connection is routine; administering everyone's
-- is not, so this key is sensitive even though it shares a kind with a non-sensitive one.
-- `ON CONFLICT (key) DO UPDATE` so a re-run syncs metadata without churning the `id` that
-- role_permissions rows point at (0117/SM-76's idiom).
INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.integration_connection.manage', 'core', 'integration_connection', 'manage',
   'Administer ANY of the company''s integration connections — company-owned rows and other users'' '
   'rows. Distinct from the four per-row actions, which are self-scoped for member/viewer.',
   'integration_connection', 'manage', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
ON CONFLICT (key) DO UPDATE SET
  module_key    = EXCLUDED.module_key,
  resource      = EXCLUDED.resource,
  action        = EXCLUDED.action,
  description   = EXCLUDED.description,
  cerbos_kind   = EXCLUDED.cerbos_kind,
  cerbos_action = EXCLUDED.cerbos_action,
  class         = EXCLUDED.class,
  sensitive     = EXCLUDED.sensitive,
  ui_grantable  = EXCLUDED.ui_grantable;

-- ── 2 · the bundles — EXACTLY the roles the policy's role arm names ───────────────────────────────
-- Read off resource_integration_connection.yaml rather than inferred: the `manage` role-arm rule
-- names `company_admin` and `manager`. `platform_admin` holds the kind's `*` wildcard and is
-- bundled here for catalog consistency with every other kind. member/viewer get NOTHING — that is
-- the invariant this whole ticket exists to preserve.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',  'core.integration_connection.manage'),
  ('manager',        'core.integration_connection.manage'),
  ('platform_admin', 'core.integration_connection.manage')
) AS bundle(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT DO NOTHING;

-- ── 3 · `owner` — the mirror that CANNOT be left to IAM-14's backfill ─────────────────────────────
-- 202608221409 seeded `owner`'s bundle as a ONE-TIME `INSERT..SELECT` snapshot of company_admin's
-- rows at that moment. A key added to company_admin later does NOT propagate, and
-- `owner-role.db.test.ts` asserts "the DB bundle matches company_admin EXACTLY" — so omitting this
-- block turns that suite red rather than merely leaving owner short.
--
-- This key does not fall on any of the 19 exclusions that migration documents: it is not portal.*,
-- not a platform credential, not a cross-company operator surface, and not self-scoped. Owner gets
-- what company_admin gets, which is the definition of the role (D-8).
INSERT INTO role_permissions (role_id, permission_id)
SELECT o.id, p.id
FROM roles o, permissions p
WHERE o.company_id IS NULL AND o.name = 'owner'
  AND p.key = 'core.integration_connection.manage'
ON CONFLICT DO NOTHING;

-- ── 4 · self-check ────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n_perm  integer;
  n_bund  integer;
  n_owner integer;
  n_leak  integer;
BEGIN
  SELECT count(*) INTO n_perm FROM permissions
   WHERE key = 'core.integration_connection.manage' AND class = 'grantable';
  IF n_perm <> 1 THEN
    RAISE EXCEPTION 'IAM-14c: expected 1 grantable manage permission, found %', n_perm;
  END IF;

  SELECT count(*) INTO n_bund FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'core.integration_connection.manage';
  -- FLOOR, not an equality: an exact tripwire fires on correct later growth, which this program has
  -- hit as a false alarm several times. 3 role-arm roles + owner = 4.
  IF n_bund < 4 THEN
    RAISE EXCEPTION 'IAM-14c: expected at least 4 bundle rows for manage (3 roles + owner), found %', n_bund;
  END IF;

  SELECT count(*) INTO n_owner FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    JOIN roles r ON r.id = rp.role_id
   WHERE p.key = 'core.integration_connection.manage' AND r.company_id IS NULL AND r.name = 'owner';
  IF n_owner <> 1 THEN
    RAISE EXCEPTION 'IAM-14c: owner did not receive manage — owner-role.db.test.ts will now fail';
  END IF;

  -- ⚠ THE ASSERTION THAT PROTECTS THE WHOLE DESIGN. If member or viewer ever hold this key, the
  -- unconditional perm-arm mirror in the policy becomes the Pattern-B over-grant IAM-04-B5 refused,
  -- and every member gains the company's credential vault.
  SELECT count(*) INTO n_leak FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    JOIN roles r ON r.id = rp.role_id
   WHERE p.key = 'core.integration_connection.manage' AND r.name IN ('member', 'viewer', 'client');
  IF n_leak <> 0 THEN
    RAISE EXCEPTION 'IAM-14c: member/viewer/client hold manage (% row(s)) — this is the exact over-grant the new key exists to avoid', n_leak;
  END IF;

  RAISE NOTICE 'IAM-14c: manage seeded — % bundle rows, owner mirrored, no member/viewer leak', n_bund;
END $$;
