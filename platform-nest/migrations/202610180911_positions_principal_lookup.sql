-- DW-10g-2 Part B (docs/PERMISSION-CONTRACT.md §50, BFF §60.17) — `principal_lookup` on the three seat tables, so principal
-- assembly can tell WHICH COMPANIES back a person's `org_unit_lead` grants.
--
-- WHY. An `org_unit_lead` grant carries no company (scopeType `org_unit`, scopeId a bare node id), and node ids repeat across
-- group companies (`d-webdev`, `d-hr`). Cerbos's `org_unit_lead` derived role used to match `g.scopeId in unitAncestors` alone,
-- so a member of company H holding a grant made for company P's `d-web` acted as the head of H's `d-web`. From this change the
-- principal carries, per `org_unit` grant, the companies whose OWN lead seat backs it (`tenantIds`), and the derived role
-- requires `resource.attr.tenantId in g.tenantIds`. `rbac/principal.ts` reads those seats while assembling the principal,
-- BEFORE any tenant context exists. `positions`, `position_assignments` and `position_roles` carry `tenant_isolation` alone
-- (0109), so under an unset `app.current_tenant_ids` that read matches ZERO rows with no error: every lead rule in Cerbos would
-- silently stop matching (the zero-row trap). These policies are the narrow second door, exactly like company_memberships'
-- (0001, hardened in 0004), client_contacts' (0072 §7b) and user_role_editorial_scopes' (202610111816).
--
-- SCOPE: one user, and only their OPEN assignments (`valid_to IS NULL`).
--   * position_assignments: the rows of the user named in `app.principal_user_id`, still open.
--   * positions / position_roles: only the positions such an open assignment references (same tenant).
-- SELECT only. The GUC is transaction-local: `set_config('app.principal_user_id', <user>, true)` inside the assembly's own
-- BEGIN/COMMIT. Unset GUC -> NULLIF(...,'') -> NULL -> no row. NULLIF is not optional: a bare ''::uuid ERRORS the whole query and
-- drags every other permissive policy on the table down with it (0004's finding). `position_assignments`' policy references no
-- other table, and the other two reference only `position_assignments`, so there is no policy recursion.
--
-- No data is written: DDL only (lint:migration-rls has nothing to guard here).

DROP POLICY IF EXISTS principal_lookup ON position_assignments;
CREATE POLICY principal_lookup ON position_assignments FOR SELECT
  USING (
    user_id = NULLIF(current_setting('app.principal_user_id', true), '')::uuid
    AND valid_to IS NULL
  );

DROP POLICY IF EXISTS principal_lookup ON positions;
CREATE POLICY principal_lookup ON positions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM position_assignments pa
     WHERE pa.position_id = positions.id
       AND pa.tenant_id = positions.tenant_id
       AND pa.user_id = NULLIF(current_setting('app.principal_user_id', true), '')::uuid
       AND pa.valid_to IS NULL
  ));

DROP POLICY IF EXISTS principal_lookup ON position_roles;
CREATE POLICY principal_lookup ON position_roles FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM position_assignments pa
     WHERE pa.position_id = position_roles.position_id
       AND pa.tenant_id = position_roles.tenant_id
       AND pa.user_id = NULLIF(current_setting('app.principal_user_id', true), '')::uuid
       AND pa.valid_to IS NULL
  ));
