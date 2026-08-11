-- HIER-2 — seed `org_unit_lead` (DR-9), the `team_lead` replacement's first real-role instance:
-- the org-chart-subtree-scoped lead tier, landed the same day IAM-09's closure table
-- (org_unit_closure, migration 0101) and HIER-1's `org_unit` scope (migration 0100) did.
--
-- SAME DEFECT CLASS 0091/0095/0096/0097/0098 already closed four times: a role named in Cerbos
-- policy (`derived_roles.yaml`) with no `roles` row is ungrantable. This migration seeds BOTH
-- halves in one file (the role row AND its `role_permissions` bundle) rather than splitting them
-- across two migrations the way 0097/0098 had to — there is no ordering hazard here forcing a
-- split, since this ticket writes the Cerbos policy, the role row, and the bundle together.
--
-- ── ROLE ROW ─────────────────────────────────────────────────────────────────────────────────────
-- Global reference data (`company_id IS NULL`), same idiom as every migration in this family:
-- `gen_random_uuid()` id, `NOT EXISTS` guard scoped to `company_id IS NULL` (idempotent/
-- re-runnable), backstopped by 0073's `roles_global_name_uniq` partial index.
--
-- ── BUNDLE — METHOD (identical derivation to 0094/0098, applied to org_unit_lead's own two rules) ─
-- Source of truth is the ACTUAL Cerbos policies this ticket writes, not a hand-guess:
--   resource_report_document.yaml   org_unit_lead: ["read_department"]        (inTenant && notLow)
--   resource_appraisal.yaml         org_unit_lead: ["read"]                   (inTenant && notLow)
-- Resource-instance conditions (org_unit_lead's OWN derived-role condition tests
-- `g.scopeId in resource.attr.unitAncestors` — an attribute-dependent match) are treated as
-- SATISFIED for bundling purposes, the same abstraction 0094's header and
-- `role-permission-parity.db.test.ts`'s `computeCerbosCoverage()` use for every other
-- resource-instance-conditioned role (self-ownership, `team_lead`'s own team-scope match, etc.) —
-- the bundle records REACH, not LIVE reachability at every possible grant. Unlike `team_lead` on
-- `pm_task` (the proven dead-grant instance), org_unit_lead's reach on these two actions is real:
-- `reports.controller.ts`/`appraisals.controller.ts` (this ticket) resolve and pass
-- `resource.attr.unitAncestors` on exactly these two call sites, so a real org_unit-scoped grant
-- genuinely fires here — no dead-grant caveat to record.
--
-- So: org_unit_lead = {reports.appraisal.read, reports.document.read_department} = 2 pairs.
--
-- class='relationship' permissions are never reachable here by construction (neither key is
-- relationship-class) and 0093's `role_permissions_reject_relationship` trigger remains the
-- backstop regardless.
--
-- ── NO RLS CONCERN ───────────────────────────────────────────────────────────────────────────────
-- `roles`/`permissions`/`role_permissions` are global reference data with no RLS policy (confirmed
-- by every prior migration in this family). The "runs NOBYPASSRLS with an unset tenant GUC ->
-- silently matches zero rows" trap does not apply structurally here; asserted below anyway, per
-- the same discipline 0095/0096/0097/0098 apply.
INSERT INTO roles (id, company_id, name, description)
SELECT gen_random_uuid(), NULL, 'org_unit_lead',
       'Org-unit (department/division) lead — the org-chart subtree cascade role (HIER-2, DR-9). ' ||
       'A grant at unit U covers every resource whose own unit is U or a descendant of U, via ' ||
       'IAM-09''s org_unit_closure ancestor containment. Landed on report_document ' ||
       '(read_department) and appraisal (read) only — the two kinds whose handlers resolve and ' ||
       'pass resource.attr.unitAncestors. Always its own Cerbos rule, never mixed with a ' ||
       'scope-only role in the same rule (the team_lead over-grant shape this role replaces).'
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE company_id IS NULL AND name = 'org_unit_lead'
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('org_unit_lead', 'reports.appraisal.read'),
  ('org_unit_lead', 'reports.document.read_department')
) AS bundle(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT DO NOTHING;

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  role_missing int;
  role_dupes int;
  bundle_count int;
  leaked int;
BEGIN
  SELECT count(*) INTO role_missing FROM (
    SELECT 'org_unit_lead' AS name
    EXCEPT
    SELECT name FROM roles WHERE company_id IS NULL
  ) x;
  IF role_missing > 0 THEN
    RAISE EXCEPTION '0102: org_unit_lead role still missing after seed';
  END IF;

  SELECT count(*) INTO role_dupes FROM roles WHERE company_id IS NULL AND name = 'org_unit_lead';
  IF role_dupes <> 1 THEN
    RAISE EXCEPTION '0102: expected exactly 1 global org_unit_lead role row, found %', role_dupes;
  END IF;

  SELECT count(*) INTO bundle_count
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
   WHERE r.company_id IS NULL AND r.name = 'org_unit_lead';
  IF bundle_count <> 2 THEN
    -- NOTE: RAISE's format string must be a single literal, never a `||`-concatenated expression
    -- (unlike a plain SELECT) — PL/pgSQL's grammar rejects the latter with exactly the syntax
    -- error this line originally hit. Kept as one literal below.
    RAISE EXCEPTION '0102: org_unit_lead: expected 2 bundled permissions, found % (missing/typo''d permission key in the JOIN, or a prior partial application)', bundle_count;
  END IF;

  -- Defense-in-depth re-assertion of Ruling 3, redundant with 0093's DB trigger.
  SELECT count(*) INTO leaked
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    JOIN roles r ON r.id = rp.role_id
   WHERE r.company_id IS NULL AND r.name = 'org_unit_lead'
     AND p.class = 'relationship';
  IF leaked <> 0 THEN
    RAISE EXCEPTION '0102: % relationship-class permission(s) leaked into org_unit_lead''s bundle — Ruling 3 violated', leaked;
  END IF;

  RAISE NOTICE '0102: org_unit_lead seeded — 1 role row, 2 bundled permissions, 0 relationship-class leaks';
END $$;
