-- Harden RLS policies against an empty/unset session setting (5b.4 fix). A bare
-- current_setting(...)::uuid becomes ''::uuid when the GUC is unset in a given
-- transaction, which ERRORS the whole query (any other permissive policy on the table
-- is dragged down with it). NULLIF(...,'') → NULL makes the predicate cleanly false.

-- principal_lookup on company_memberships (used during principal assembly only).
DROP POLICY IF EXISTS principal_lookup ON company_memberships;
CREATE POLICY principal_lookup ON company_memberships FOR SELECT
  USING (user_id = NULLIF(current_setting('app.principal_user_id', true), '')::uuid);

-- tenant_isolation on every tenant-scoped table: empty set → no rows (never an error).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'company_memberships','teams','team_memberships','clients','projects','tasks',
    'deliverables','time_entries','activities','comments','notifications',
    'custom_field_definitions','rollup_metrics','agency_campaigns','agency_briefs','agency_approvals'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))
         WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))',
        t
      );
    END IF;
  END LOOP;
END $$;
