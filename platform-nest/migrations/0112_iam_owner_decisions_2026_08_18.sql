-- 0112_iam_owner_decisions_2026_08_18.sql — three OWNER DECISIONS taken 2026-08-18, synced into the
-- live catalog + bundle tables so the DB matches the amended Cerbos policies and
-- `permission-catalog.json` / `role-permission-bundles.json`.
--
-- The policy edits and the JSON regeneration are in the same commit; this migration is ONLY the DB
-- half. The parity suites (`role-permission-parity.db.test.ts`, `principal-permissions.db.test.ts`,
-- `cerbos-catalog-alignment.test.ts`) compare all three and go red if any one of them drifts, which
-- is exactly why all three move together here.
--
-- ── NUMBERING (migrations/README.md rule 5) ────────────────────────────────────────────────────
-- `ls migrations | sort | tail` immediately before writing showed the head as
-- `0111_iam_phase2_employee_work_email_key.sql` with `0112` free. `0058`/`0059`/`0070` remain the
-- permanently orphaned reservation gaps — not touched.
--
-- ── DECISION 1: `member` loses `core.client.delete` (keeps create/update) ──────────────────────
-- Found while preparing the sensitivity-flag review: `core.client.delete` sat in the BASELINE
-- `member` bundle. A live probe (a principal whose only grant is `member @ company`) returned
-- EFFECT_ALLOW on client create/update/delete — tenant-wide, no `owns` carve-out — and
-- `clients.controller.ts:80` passes no ownership attribute to narrow it. Every staff member could
-- remove any client in their company. Soft-delete and audited, so recoverable, but real reach.
-- `resource_client.yaml`'s member rule is now `create`/`update` only; this drops the matching bundle
-- row so the permission arm cannot re-grant what the role arm now refuses.
--
-- ── DECISION 2: `hr_people_ops` gains `core.position.assign` / `.unassign` ─────────────────────
-- P2-06 proved design §5.1 ("HR ... opens the position assignment") contradicted §4.1/§6.2 ("dept
-- head assigns"): an `hr_manager` got 403 on placement, transfer and terminate. Owner ruled HR runs
-- joiner/mover/leaver end to end. `hr_people_ops` resolves to `hr_manager` ONLY (derived_roles.yaml
-- §TR-13 — the ACTING HR tier), so `hr_staff` is deliberately NOT granted these; the generator
-- reflects that and this migration matches it row for row.
--
-- ── DECISION 3: seven READ permissions are no longer `sensitive` ───────────────────────────────
-- The `sensitive` flag became load-bearing on 2026-08-18 (P2-08's dept-head gate routes a
-- sensitive-carrying role as an override instead of granting it). Owner reviewed the 107 flagged
-- keys and ruled that a READ is not sensitive authority — except `hr.record.read`, which stays
-- flagged because it is bulk personal data. Flagging reads would have routed most real roles as
-- overrides, and until P2-08 part B exists "routes as an override" means "is refused".
-- 107 -> 100 flagged.
--
-- ── ZERO SCHEMA CHANGE ─────────────────────────────────────────────────────────────────────────
-- DML only, against `permissions` and `role_permissions`. Every statement asserts what it did
-- (GET DIAGNOSTICS) rather than trusting it — the 0093 lesson: a migration may assert WHAT IT DID,
-- never the state of a shared table forever, so these checks are all deltas, not totals.

DO $$
DECLARE
  n integer;
  member_role uuid;
  hr_manager_role uuid;
  perm_assign uuid;
  perm_unassign uuid;
BEGIN
  -- ── DECISION 3 — un-flag the seven reads ────────────────────────────────────────────────────
  UPDATE permissions SET sensitive = false
   WHERE key IN (
     'core.contract.read', 'core.identity_link.read', 'core.rollup.read', 'core.role_grant.read',
     'billing.invoice.read', 'it.account.read', 'hr.case.read'
   ) AND sensitive;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 7 THEN
    RAISE EXCEPTION 'expected to un-flag exactly 7 read permissions, un-flagged % — the catalog and '
      'this migration disagree about which keys were sensitive', n;
  END IF;

  -- hr.record.read is deliberately NOT in that list. Assert it, so a future edit that "tidies" the
  -- list by adding it has to delete this check on purpose rather than by accident.
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE key = 'hr.record.read' AND sensitive) THEN
    RAISE EXCEPTION 'hr.record.read must remain sensitive (bulk personal data) — owner decision 2026-08-18';
  END IF;

  -- ── DECISION 1 — member loses core.client.delete ────────────────────────────────────────────
  SELECT id INTO member_role FROM roles WHERE name = 'member' AND company_id IS NULL;
  IF member_role IS NULL THEN
    RAISE EXCEPTION 'baseline role "member" not found (0095 seeds it) — refusing to guess';
  END IF;

  DELETE FROM role_permissions rp
   USING permissions p
   WHERE rp.permission_id = p.id
     AND rp.role_id = member_role
     AND p.key = 'core.client.delete';
  GET DIAGNOSTICS n = ROW_COUNT;
  -- 0 is legitimate on a database seeded AFTER this policy change (the bundle row would never have
  -- been written); 1 is the expected value on every environment seeded before it. More than 1 means
  -- duplicate bundle rows, which is a real defect worth stopping for.
  IF n > 1 THEN
    RAISE EXCEPTION 'expected at most 1 (member, core.client.delete) bundle row, deleted % — duplicates in role_permissions', n;
  END IF;

  -- ── DECISION 2 — hr_manager gains position assign/unassign ──────────────────────────────────
  SELECT id INTO hr_manager_role FROM roles WHERE name = 'hr_manager' AND company_id IS NULL;
  SELECT id INTO perm_assign   FROM permissions WHERE key = 'core.position.assign';
  SELECT id INTO perm_unassign FROM permissions WHERE key = 'core.position.unassign';
  IF hr_manager_role IS NULL THEN
    RAISE EXCEPTION 'role "hr_manager" not found (0091/0095 seed it) — refusing to guess';
  END IF;
  IF perm_assign IS NULL OR perm_unassign IS NULL THEN
    RAISE EXCEPTION 'core.position.assign/unassign not in the catalog (0110 seeds them) — refusing to guess';
  END IF;

  INSERT INTO role_permissions (role_id, permission_id)
  VALUES (hr_manager_role, perm_assign), (hr_manager_role, perm_unassign)
  ON CONFLICT DO NOTHING;

  -- hr_staff must NOT pick these up: `hr_people_ops` is hr_manager-only (the ACTING tier). Asserted
  -- rather than assumed, because the two HR roles are seeded side by side and a copy-paste that
  -- granted both would be invisible in a diff.
  IF EXISTS (
    SELECT 1 FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.name = 'hr_staff' AND r.company_id IS NULL
       AND p.key IN ('core.position.assign', 'core.position.unassign')
  ) THEN
    RAISE EXCEPTION 'hr_staff must not hold core.position.assign/unassign — hr_people_ops is hr_manager only';
  END IF;
END $$;
