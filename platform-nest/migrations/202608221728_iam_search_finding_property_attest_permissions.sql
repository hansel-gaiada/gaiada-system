-- SM-76 — SEO/site-audit capability, IAM wave (docs/plans/2026-08-23-seo-audit-capability.md §6).
-- Three new catalog permissions for the new `resource_search_finding` Cerbos kind + a new `attest`
-- action on the existing `resource_search_property` kind, plus their role bundles.
--
-- ── WHY THIS LANDS IN THE SAME CHANGE-SET AS THE SCHEMA MIGRATION, NOT AFTER ──────────────────────
-- `validateModulePermissions()` (modules/registry.ts) refuses boot if any `ModuleContract.permissions`
-- key does not resolve to a `class='grantable'` catalog row — same reasoning 0106/0117 give.
--
-- ── THE FAILURE MODE THIS FILE IS WRITTEN AGAINST (0117's own, on this exact estate, days ago) ────
-- 0117 seeded 9 of the 14 actions its own Cerbos policies named, and gave `manager`/`group_executive`
-- zero bundle rows though every monitoring policy names them — both silently invisible because
-- `permission-catalog.db.test.ts` skips without DATABASE_URL_TEST. This file's bundles are read
-- DIRECTLY off `cerbos/policies/resource_search_finding.yaml` (new) and the widened
-- `resource_search_property.yaml`'s `attest` rule — not inferred from the ticket text — and every
-- role BOTH policy files name for these three (kind, action) pairs gets a row below:
--   resource_search_finding::triage       -> module_staff/module_manager/company_admin (inTenant).
--   resource_search_finding::accept_risk  -> module_manager/company_admin (inTenant) — sensitive,
--                                             NOT module_staff.
--   resource_search_property::attest      -> module_manager/company_admin (inTenant) — sensitive,
--                                             NOT module_staff.
-- `module_staff`/`module_manager` on every `resource_search_*` kind resolve to `search_staff`/
-- `search_manager` (the ONLY names Cerbos will ever match for this module — scripts/
-- generate-role-bundles.mjs's SEARCH_KINDS set, extended by this same change to include
-- `resource_search_finding`). `owner` is NOT auto-derived in the DATABASE the way it is in the JSON
-- generator (`roles.owner = [...roles.company_admin]`, scripts/generate-role-bundles.mjs) —
-- `202608221409_iam14_owner_role.sql`'s owner bundle was a ONE-TIME `INSERT..SELECT` snapshot of
-- company_admin's rows AT THAT MOMENT, so every migration landing new company_admin permissions
-- since then must explicitly mirror them onto `owner` too, or `owner-role.db.test.ts`'s "the DB
-- bundle matches company_admin EXACTLY" goes red. Done below (§2, owner block).
--
-- ── NO `group_executive` ROW HERE — DELIBERATELY, FOUND MID-WRITE, NOT ASSUMED ─────────────────────
-- A concurrent, same-day migration already sits later in this ledger
-- (`202608230230_iam15_remove_group_executive.sql`, D-7 "remove group_executive — the last
-- unrestricted cross-company business role") that deletes the role and every one of its
-- `role_permissions` rows outright. Its own Cerbos-policy half (stripping the role from ~46
-- `resource_*.yaml` files) had already reached 6 of the 7 `resource_search_*` policies on this
-- checkout by the time this file was written (verified by reading them, not assumed) — only
-- `resource_search_property.yaml` had not yet been swept, and this ticket's own new
-- `resource_search_finding.yaml` obviously predates that sweep entirely. Both were brought in line
-- with the other 6 (group_executive rule removed) rather than left as fresh instances of a pattern
-- an owner-ratified decision is actively retiring across this exact directory. Seeding a
-- `group_executive` bundle row here — for a role the very next migration in the ledger deletes
-- entirely — would be dead-on-arrival DDL a reader would have to explain twice.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Catalog permissions. `ON CONFLICT (key) DO UPDATE` so a re-run is a metadata sync and never
--    churns the `id` role_permissions rows reference (0117's own idiom).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive
FROM (VALUES
  -- Not sensitive: assigning a finding, moving it to in_remediation, or claiming a fix does not by
  -- itself conceal anything — the claim renders as a claim (design §7.5) until a later run verifies
  -- it. Baseline working-set action, same tier as search.audit.update.
  ('search.finding.triage', 'search', 'finding', 'triage',
   'Assign a finding, move it to in_remediation, or claim a fix (fixed_claimed). Manual "fixed" no '
   'longer exists as a target — only a later measured run can verify it.', 'resource_search_finding', 'triage',
   'grantable', false),

  -- SENSITIVE: this is the CONCEALING direction (design §6, mirroring monitoring's
  -- maintenance.create reasoning) — accepting risk or marking a finding a false positive makes a
  -- live, measured problem stop surfacing as open. false_positive rides this same grant/action
  -- (design §5.2: distinct triage outcomes, one permission).
  ('search.finding.accept_risk', 'search', 'finding', 'accept_risk',
   'Accept risk (with expiry or explicit indefinite) or mark a finding a false positive. Conceals a '
   'live, measured problem from the open-findings view.', 'resource_search_finding', 'accept_risk',
   'grantable', true),

  -- SENSITIVE: an attested fact can flip a security check (e.g. security.wp_salts) from "not
  -- verified" to a passing outcome on the NEXT run (design §3.5) — an accountability record a named
  -- human stands behind, not a routine property edit.
  ('search.property.attest', 'search', 'property', 'attest',
   'Record an attested property fact (CMS/hosting/security posture) that a dependent check can '
   'resolve from on a later run. Requires recorded_by; never retro-edits a completed run.',
   'resource_search_property', 'attest', 'grantable', true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive)
ON CONFLICT (key) DO UPDATE SET
  module_key    = EXCLUDED.module_key,
  resource      = EXCLUDED.resource,
  action        = EXCLUDED.action,
  description   = EXCLUDED.description,
  cerbos_kind   = EXCLUDED.cerbos_kind,
  cerbos_action = EXCLUDED.cerbos_action,
  class         = EXCLUDED.class,
  sensitive     = EXCLUDED.sensitive;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Role -> permission bundles. Mirrors the Cerbos role arm exactly (see header). `search_staff`
--    gets ONLY triage (matching its existing 22-of-36 "baseline, not elevated" reach on every other
--    resource_search_* kind); `search_manager`/`company_admin`/`platform_admin`/`owner` get all
--    three, matching those roles' existing full reach on every resource_search_* kind. `manager`
--    gets NOTHING here (unlike monitoring's `manager` rule, no resource_search_* policy file names
--    plain `manager` anywhere, in any rule). `group_executive` deliberately absent — see header.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',  'search.finding.triage'),
  ('company_admin',  'search.finding.accept_risk'),
  ('company_admin',  'search.property.attest'),

  ('platform_admin', 'search.finding.triage'),
  ('platform_admin', 'search.finding.accept_risk'),
  ('platform_admin', 'search.property.attest'),

  ('search_manager', 'search.finding.triage'),
  ('search_manager', 'search.finding.accept_risk'),
  ('search_manager', 'search.property.attest'),

  ('search_staff',   'search.finding.triage')
) AS bundle(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT DO NOTHING;

-- `owner` (D-8/IAM-14): explicit mirror of company_admin for these 3 keys — see header for why this
-- cannot be left to the one-time 202608221409 backfill. None of the 3 falls on the 19-key exclusion
-- list that migration documents (no portal.*, no platform-credential, no cross-company operator, no
-- self-scoped action) — owner gets exactly what company_admin gets here, same as everywhere else.
INSERT INTO role_permissions (role_id, permission_id)
SELECT o.id, p.id
FROM roles o, permissions p
WHERE o.company_id IS NULL AND o.name = 'owner'
  AND p.key IN ('search.finding.triage', 'search.finding.accept_risk', 'search.property.attest')
ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. Self-check. FLOORS, not equalities (ticket instruction: an exact-count tripwire fires on
--    correct later growth — this program has hit that false alarm five times). Fails loudly rather
--    than shipping a silently-partial seed.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n_perms  integer;
  n_bundle integer;
  n_owner  integer;
  n_admin  integer;
BEGIN
  SELECT count(*) INTO n_perms FROM permissions
   WHERE key IN ('search.finding.triage', 'search.finding.accept_risk', 'search.property.attest')
     AND class = 'grantable';
  IF n_perms < 3 THEN
    RAISE EXCEPTION 'SM-76: expected 3 new grantable search permissions, found %', n_perms;
  END IF;

  SELECT count(*) INTO n_bundle
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
  WHERE p.key IN ('search.finding.triage', 'search.finding.accept_risk', 'search.property.attest');
  -- 5 roles x 3 keys - 2 (search_staff holds only triage) = 13.
  IF n_bundle < 13 THEN
    RAISE EXCEPTION 'SM-76: expected at least 13 role->permission pairs for the 3 new search keys, found %', n_bundle;
  END IF;

  -- owner must stay an EXACT mirror of company_admin across its WHOLE bundle, not just these 3 keys
  -- (owner-role.db.test.ts's own invariant) — checked here too so a future re-run of this file
  -- cannot silently let the two drift apart again.
  SELECT count(*) INTO n_owner FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
   WHERE r.company_id IS NULL AND r.name = 'owner';
  SELECT count(*) INTO n_admin FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
   WHERE r.company_id IS NULL AND r.name = 'company_admin';
  IF n_owner <> n_admin THEN
    RAISE EXCEPTION 'SM-76: owner bundle (%) no longer matches company_admin (%) after this migration', n_owner, n_admin;
  END IF;

  RAISE NOTICE 'SM-76 IAM seed OK: % new permissions, % new bundle pairs, owner=company_admin (%)', n_perms, n_bundle, n_owner;
END $$;
