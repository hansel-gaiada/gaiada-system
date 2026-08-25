-- Finance — record WHICH template a company's chart was instantiated from.
--
-- `finance_company_settings.coa_template_key` has existed since F0 and nothing ever wrote it. It was
-- invisible until UI-02b rendered it, at which point the settings page showed "Chart of accounts: —"
-- for three companies whose charts had plainly been instantiated from `id_psak_general_v1` minutes
-- earlier.
--
-- ── WHY RECORD IT ──────────────────────────────────────────────────────────────────────────────
-- The template is not configuration — the accountant edits accounts afterwards and the chart
-- diverges immediately. It is PROVENANCE: "this chart started as the Indonesian PSAK general
-- template". It cannot be reconstructed once accounts have been added, renamed and retired.
--
-- ── WRITTEN BY THE FUNCTION, NOT THE CALLER ────────────────────────────────────────────────────
-- This function is the only thing that knows which template was applied, and it is called from a
-- seed today and a UI tomorrow. Recording it in the caller means every future caller must remember,
-- and the one that forgets reproduces exactly the NULL this fixes.
--
-- ⚠ THE BODY BELOW IS THE ORIGINAL FROM 202608241011, COPIED VERBATIM.
-- The first draft of this migration RETYPED it and silently dropped `allow_manual_posting` and
-- `source_template_line_id` from the INSERT, invented a `sort_order` column, and changed pass 2's
-- guard from `child.parent_id IS NULL` to a DISTINCT FROM — which would have overwritten an
-- accountant's deliberate re-parenting on every re-run. Only the provenance UPDATE is new.
--
-- ⚠ AND THE SECOND DRAFT LEFT THE ORIGINAL'S `RETURN v_created;` ABOVE THE NEW UPDATE, making it
-- unreachable. The function still compiled, the suite still passed — because nothing asserted the
-- column. A test now does; a migration whose whole purpose is one UPDATE must have that UPDATE
-- pinned, or 'it ran' and 'it worked' stay indistinguishable.

CREATE OR REPLACE FUNCTION finance_instantiate_coa(p_company uuid, p_template_key text)
  RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_template uuid;
  v_created  integer := 0;
BEGIN
  SELECT id INTO v_template FROM finance_coa_templates WHERE key = p_template_key;
  IF v_template IS NULL THEN
    RAISE EXCEPTION 'FINANCE_TEMPLATE_UNKNOWN: no CoA template with key %', p_template_key;
  END IF;

  -- Pass 1: the accounts themselves, parents left NULL.
  INSERT INTO finance_accounts
    (tenant_id, code, name, account_type, normal_balance, is_postable, is_control,
     control_subledger, allow_manual_posting, source_template_line_id)
  SELECT p_company, l.code, l.name, l.account_type, l.normal_balance, l.is_postable, l.is_control,
         l.control_subledger,
         -- Control accounts refuse manual journals (see ck_finance_accounts_control_manual).
         NOT l.is_control,
         l.id
    FROM finance_coa_template_lines l
   WHERE l.template_id = v_template
     AND NOT EXISTS (
       SELECT 1 FROM finance_accounts a
        WHERE a.tenant_id = p_company AND a.code = l.code AND a.deleted_at IS NULL
     );
  GET DIAGNOSTICS v_created = ROW_COUNT;

  -- Pass 2: resolve parent_code -> parent_id, now that every row exists. Only fills NULLs, so an
  -- accountant who has already re-parented an account keeps their change.
  UPDATE finance_accounts child
     SET parent_id = parent.id
    FROM finance_coa_template_lines l
    JOIN finance_accounts parent
      ON parent.tenant_id = p_company AND parent.code = l.parent_code AND parent.deleted_at IS NULL
   WHERE l.template_id = v_template
     AND child.tenant_id = p_company
     AND child.code = l.code
     AND child.deleted_at IS NULL
     AND child.parent_id IS NULL
     AND l.parent_code IS NOT NULL;

  -- ── THE ONLY ADDITION ────────────────────────────────────────────────────────────────────────
  -- Fills a NULL and never more. The FIRST template is the true provenance: a later re-run against a
  -- different template only adds the accounts that were missing, it does not re-found the chart.
  UPDATE finance_company_settings
     SET coa_template_key = p_template_key, updated_at = now()
   WHERE tenant_id = p_company AND coa_template_key IS NULL;

  RETURN v_created;
END $$;
COMMENT ON FUNCTION finance_instantiate_coa(uuid, text) IS
  'Copies a CoA template into a company as editable rows. Idempotent by code; NEVER overwrites an '
  'existing account — the company''s chart always wins over the template (owner ruling D-F5). Also '
  'records the template on finance_company_settings as PROVENANCE, filling a NULL only.';
