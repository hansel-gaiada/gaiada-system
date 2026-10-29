-- 202610291200 — AIP-D5 holders: `assistant.brain.choose_provider` (pick a named AI provider for your own assistant threads) is
-- held by the superadmin and the owner ONLY. The owner's ruling, 2026-10-29, in their words: "only superadmin and owner"
-- (docs/PERMISSION-CONTRACT.md §55.1, docs/plans/2026-10-27-ai-plan.md §9 AIP-D5). Pure IAM data: no DDL.
--
-- 202610281210 seeded the key on platform_admin, company_admin and owner, uiGrantable TRUE (a role edit could grant it). This file
-- narrows it to the SCP-1b owner-only pattern (§53.11):
--   platform_admin  — keeps its row (its Cerbos wildcard; role-permission-parity.db.test.ts compares the bundle with it)
--   owner           — keeps its row, now through OWNER_EXTENSION (scripts/generate-role-bundles.mjs): owner == company_admin's
--                     envelope + OWNER_EXTENSION, and owner-role.db.test.ts pins exactly that
--   company_admin   — LOSES its row; resource_assistant_brain.yaml loses its company_admin rule in the same change
--   any custom role — LOSES its row (a role edit made after 454 could have granted it)
--   ui_grantable    — true -> false, so no role edit, position or request can carry it again (position_roles_guard() clause (b)
--                     and assertRoleUiGrantable() both read it)
--
-- The other artifacts, all in the same change: the policy (company_admin rule removed), the catalog (`uiGrantable: false`), the
-- groups (description only), the generator (OWNER_EXTENSION) and role-permission-bundles.json regenerated from it.
--
-- RLS / DML NOTE: the only DML is on `permissions` and `role_permissions`, GLOBAL reference tables with no RLS, so the zero-rows
-- trap does not apply. Every step is a delta (0 rows is legitimate on a re-run or a database seeded after this change).
DO $$
DECLARE
  n integer;
  got integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE key = 'assistant.brain.choose_provider') THEN
    RAISE EXCEPTION '202610291200: assistant.brain.choose_provider is missing — 202610281210 must run first';
  END IF;
  SELECT count(*) INTO got FROM roles WHERE company_id IS NULL AND name IN ('platform_admin', 'owner');
  IF got <> 2 THEN
    RAISE EXCEPTION '202610291200: expected the two global roles platform_admin and owner, found %', got;
  END IF;

  -- ── company_admin loses the key (at most one row). ──
  DELETE FROM role_permissions rp
   USING roles r, permissions p
   WHERE rp.role_id = r.id AND rp.permission_id = p.id
     AND r.company_id IS NULL AND r.name = 'company_admin' AND p.key = 'assistant.brain.choose_provider';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 1 THEN
    RAISE EXCEPTION '202610291200: expected at most 1 company_admin row for assistant.brain.choose_provider, deleted %', n;
  END IF;
  RAISE NOTICE '202610291200: company_admin lost % row(s) on assistant.brain.choose_provider', n;

  -- ── No other route in: a CUSTOM (per-company) role holding the key loses it. DELTA-logged. ──
  DELETE FROM role_permissions rp
   USING roles r, permissions p
   WHERE rp.role_id = r.id AND rp.permission_id = p.id
     AND r.company_id IS NOT NULL AND p.key = 'assistant.brain.choose_provider';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '202610291200: removed % custom-role pair(s) on assistant.brain.choose_provider', n;

  -- ── ui_grantable = false (at most one flip). ──
  UPDATE permissions SET ui_grantable = false WHERE key = 'assistant.brain.choose_provider' AND ui_grantable;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 1 THEN
    RAISE EXCEPTION '202610291200: expected to flip at most 1 permission to ui_grantable=false, flipped %', n;
  END IF;

  -- ══ Assert, don't assume ══════════════════════════════════════════════════════════════════════════════════════
  SELECT count(*) INTO got FROM permissions
   WHERE key = 'assistant.brain.choose_provider' AND cerbos_kind = 'assistant_brain' AND cerbos_action = 'choose_provider'
     AND class = 'grantable' AND NOT ui_grantable AND NOT sensitive;
  IF got <> 1 THEN
    RAISE EXCEPTION '202610291200: expected assistant.brain.choose_provider grantable, not sensitive and ui_grantable=false, found %', got;
  END IF;

  -- exactly the two holders, and nobody else (a GLOBAL role other than these two would be a bundle this file did not expect: stop).
  SELECT count(*) INTO got
    FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'assistant.brain.choose_provider';
  IF got <> 2 THEN
    RAISE EXCEPTION '202610291200: expected 2 role_permissions rows for assistant.brain.choose_provider (platform_admin, owner), found %', got;
  END IF;
  SELECT count(*) INTO got
    FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'assistant.brain.choose_provider' AND r.company_id IS NULL AND r.name IN ('platform_admin', 'owner');
  IF got <> 2 THEN
    RAISE EXCEPTION '202610291200: expected platform_admin AND owner to hold assistant.brain.choose_provider, found % of 2', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
   WHERE p.key = 'assistant.brain.choose_provider' AND rp.self_scoped;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610291200: % self-scoped row(s) for assistant.brain.choose_provider (expected none)', got;
  END IF;

  RAISE NOTICE '202610291200: assistant.brain.choose_provider is held by platform_admin and owner only, ui_grantable=false';
END $$;
