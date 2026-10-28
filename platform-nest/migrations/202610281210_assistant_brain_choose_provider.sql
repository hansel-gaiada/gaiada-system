-- 202610281210 — AIP-08b: the `assistant_brain` permission family (owner ruling AIP-D5: "only people with an 'advanced' grant may
-- pick a named provider; everyone else sees Auto, Fast and Strong"; docs/PERMISSION-CONTRACT.md §55). A NEW Cerbos kind in the
-- `assistant` module with ONE action. Pure IAM seed: no DDL.
--
--     assistant.brain.choose_provider   pick a named AI provider (not just Auto, Fast or Strong) for your own assistant threads
--
-- grantable, uiGrantable (a role edit grants it), NOT sensitive: a cost lever, not data access. It never opens another person's
-- thread; resource_assistant_thread.yaml (owner-private, no admin rule) is untouched.
--
-- A new Cerbos kind costs six coupled artifacts; this is #5. The others, all in the same change:
--   1. cerbos/policies/resource_assistant_brain.yaml (+ 1 perm_assistant_brain_choose_provider derived role in derived_roles.yaml)
--   2. src/rbac/cerbos.ts            — no allow-list change: the kind reads only `id` and `tenantId`, both already in
--                                      resourcePayload() (a comment records the new consumer)
--   3. src/rbac/permission-catalog.json  — the key + _meta counts (113 kinds / 499 pairs / 484 grantable)
--   4. src/rbac/permission-groups.json   — 1 group (`assistant_choose_provider`) + _meta counts
--   6. scripts/generate-role-bundles.mjs (NO resolver change: the kind names only platform_admin and company_admin, which DIRECT
--      already maps) and src/rbac/role-permission-bundles.json updated to the generator's output.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin       — its Cerbos wildcard; 0094's methodology materialises an explicit row per grantable key, and
--                          role-permission-parity.db.test.ts compares platform_admin's bundle with that wildcard
--   company_admin, owner — the default holders (owner MUST mirror company_admin exactly: owner-role.db.test.ts; a new
--                          company_admin key does NOT propagate to owner on its own)
--   everything else (manager, member, viewer, client, module tiers, ...) — NOTHING. They get it only through a role edit.
--
-- ── SELF-SCOPED MARKER ──────────────────────────────────────────────────────────────────────────
-- None. No rule on this kind compares a resource attribute to the caller's id.
--
-- RLS / DML NOTE: the only DML is on `permissions` and `role_permissions`, GLOBAL reference tables with no RLS, so the zero-rows
-- trap does not apply. `permissions.id` has no default, so it is supplied explicitly. `ui_grantable` is EXPLICIT (0110's default).
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('assistant.brain.choose_provider', 'assistant', 'brain', 'choose_provider',
   'Pick a named AI provider (not just Auto, Fast or Strong) for your own assistant threads.',
   'assistant_brain', 'choose_provider', 'grantable', false, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, false
FROM (VALUES ('platform_admin'), ('company_admin'), ('owner')) AS v(role_name)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = 'assistant.brain.choose_provider'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- ── Assert, don't assume (202608310900's discipline) ────────────────────────────────────────────
DO $$
DECLARE
  got integer;
BEGIN
  SELECT count(*) INTO got FROM permissions
   WHERE key = 'assistant.brain.choose_provider' AND module_key = 'assistant'
     AND cerbos_kind = 'assistant_brain' AND cerbos_action = 'choose_provider'
     AND class = 'grantable' AND ui_grantable AND NOT sensitive;
  IF got <> 1 THEN
    RAISE EXCEPTION '202610281210: expected exactly 1 assistant.brain.choose_provider permission, found %', got;
  END IF;

  SELECT count(*) INTO got FROM permissions WHERE cerbos_kind = 'assistant_brain';
  IF got <> 1 THEN
    RAISE EXCEPTION '202610281210: expected 1 assistant_brain permission (one action), found %', got;
  END IF;

  -- exactly the three named global roles hold it, and nobody else (no per-company role, no manager/member/viewer/module tier).
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'assistant.brain.choose_provider';
  IF got <> 3 THEN
    RAISE EXCEPTION '202610281210: expected 3 role_permissions rows for assistant.brain.choose_provider, found %', got;
  END IF;
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'assistant.brain.choose_provider'
     AND NOT (r.company_id IS NULL AND r.name IN ('platform_admin', 'company_admin', 'owner'));
  IF got <> 0 THEN
    RAISE EXCEPTION '202610281210: assistant.brain.choose_provider is held by % role(s) outside platform_admin, company_admin and owner', got;
  END IF;

  -- not self-scoped anywhere: the key confers authority over the holder's own threads only by being checked there, never by a rule
  -- that compares a resource attribute to the caller.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'assistant.brain.choose_provider' AND rp.self_scoped;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610281210: % self-scoped row(s) for assistant.brain.choose_provider (expected none)', got;
  END IF;

  -- owner ≡ company_admin over the kind, in BOTH directions (equal counts alone would not catch the wrong keys).
  -- owner-role.db.test.ts pins the same over the whole bundle; this block stays on the kind this file seeds, so an unrelated drift
  -- elsewhere cannot abort the boot that applies it.
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner' AND p.cerbos_kind = 'assistant_brain'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.cerbos_kind = 'assistant_brain')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin' AND p.cerbos_kind = 'assistant_brain'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner' AND p.cerbos_kind = 'assistant_brain')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610281210: owner''s assistant_brain bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  -- and both actually hold it (the EXCEPT above is also 0 when NEITHER does, e.g. if a role row were missing)
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'assistant.brain.choose_provider' AND r.company_id IS NULL AND r.name IN ('company_admin', 'owner');
  IF got <> 2 THEN
    RAISE EXCEPTION '202610281210: expected company_admin AND owner to hold assistant.brain.choose_provider, found % of 2', got;
  END IF;

  RAISE NOTICE '202610281210: assistant.brain.choose_provider seeded on platform_admin, company_admin and owner';
END $$;
