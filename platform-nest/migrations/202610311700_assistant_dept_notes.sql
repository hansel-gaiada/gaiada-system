-- AIP-23b (docs/plans/2026-10-31-aip-23-department-notes.md §4.7; owner rulings AIP-D20 to AIP-D24; docs/FRONTEND-BFF-CONTRACT.md §67;
-- docs/PERMISSION-CONTRACT.md §59): DEPARTMENT NOTES, a department's shared assistant memory.
--
--   assistant_dept_notes - one row per note. A person in the department deliberately suggests a short work fact (1 to 500 characters); an
--                          approver (the department's head, the GM, the owner or the superadmin: AIP-D21) approves it. Only approved notes
--                          will reach the assistant (AIP-23c). Two statuses only: `proposed` and `approved`. A REJECTED or WITHDRAWN note is
--                          DELETED, text and all (plan §4.1: no graveyard of refused text), so there is no third status.
--
-- ── NOTES ─────────────────────────────────────────────────────────────────────────────────────
--   * `unit_node_id` is an org-blob node id (free text, no FK): the `assistant_dept_preambles` / `dept_notices` convention. The application
--     validates it against the tenant's org tree (resolveDepartment) before it writes. At most 120 characters (department-context.ts NODE_ID_MAX).
--   * `body` is 1 to 500 characters (code points, `char_length`, as the service counts them). The service trims and scrubs first; the CHECK
--     holds the line for any other writer.
--   * `record_kind` + `record_id` link the note to ONE record (plan §4.5): both set or neither. The kinds are the families the knowledge filter
--     checks (modules/knowledge/search-filter.ts FAMILIES); the application validates the kind and that the record exists in this company and
--     is readable by the person who links it. No FK: the record lives in one of several tables, and a deleted record simply withholds the note.
--   * ERASURE (AIP-D23, the owner's choice): `proposed_by` and `decided_by` reference users ON DELETE SET NULL, and the person's NAME is stored
--     as text when they suggest (`proposed_by_name`) and when they decide (`decided_by_name`). Deleting a user row therefore keeps the note,
--     approved or waiting, and keeps the name; the read marks it "former colleague". An erasure request cannot remove the name from these notes
--     (plan R6, accepted by the owner on 2026-10-31). No erasure function is needed: the FK does it.
--   * `pinned` only on an approved note; `decided_at` and `decided_by_name` exactly when approved (the status CHECK below). `decided_by` may be
--     NULL on an approved note: the approver's user row was erased.
--   * Core table, no module: RLS is the single tenant isolation policy (`tenant_id = ANY(app_current_tenants())`, FORCE), the
--     `assistant_dept_preambles` shape. No `app_module_allowed(..)` term, so no module declaration is needed to read it.
--   * No `origin_site`: the template table (assistant_dept_preambles) does not carry one.
--
-- ── THE CHECKS, AND THE NULL TRAP ────────────────────────────────────────────────────────────────
-- A CHECK passes when its expression is NULL. Every column a CHECK compares is either NOT NULL or tested with IS [NOT] NULL, so no CHECK below
-- can evaluate to NULL on a row that should be refused.
--
-- Pure DDL. The Cerbos kind's permission seed is the NEXT migration (202610311710).

-- ── 1 · assistant_dept_notes ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assistant_dept_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  unit_node_id text NOT NULL CONSTRAINT assistant_dept_notes_unit_ck CHECK (char_length(unit_node_id) BETWEEN 1 AND 120),
  body text NOT NULL CONSTRAINT assistant_dept_notes_body_ck CHECK (char_length(body) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'proposed' CONSTRAINT assistant_dept_notes_status_ck CHECK (status IN ('proposed', 'approved')),
  record_kind text CONSTRAINT assistant_dept_notes_record_kind_ck CHECK (record_kind IS NULL OR char_length(record_kind) BETWEEN 1 AND 40),
  record_id uuid,
  proposed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  proposed_by_name text NOT NULL CONSTRAINT assistant_dept_notes_proposed_name_ck CHECK (char_length(proposed_by_name) BETWEEN 1 AND 200),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by_name text CONSTRAINT assistant_dept_notes_decided_name_ck CHECK (decided_by_name IS NULL OR char_length(decided_by_name) BETWEEN 1 AND 200),
  pinned boolean NOT NULL DEFAULT false,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- the optional record link: both halves or neither
  CONSTRAINT assistant_dept_notes_record_pair_ck CHECK ((record_kind IS NULL) = (record_id IS NULL)),
  -- a waiting note carries no decision; an approved one carries when and by whom (the id may be NULL after erasure, the name never)
  CONSTRAINT assistant_dept_notes_decision_ck CHECK (
    (status = 'proposed' AND decided_at IS NULL AND decided_by IS NULL AND decided_by_name IS NULL)
    OR (status = 'approved' AND decided_at IS NOT NULL AND decided_by_name IS NOT NULL)
  ),
  -- only an approved note is pinned
  CONSTRAINT assistant_dept_notes_pinned_ck CHECK (NOT pinned OR status = 'approved')
);

-- The department's list and its caps (50 approved per department, the approvers' queue).
CREATE INDEX IF NOT EXISTS ix_assistant_dept_notes_unit ON assistant_dept_notes (tenant_id, unit_node_id, status);
-- A person's own suggestions and the 10-waiting cap.
CREATE INDEX IF NOT EXISTS ix_assistant_dept_notes_proposer ON assistant_dept_notes (tenant_id, proposed_by, status);

ALTER TABLE assistant_dept_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_dept_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON assistant_dept_notes;
CREATE POLICY tenant_isolation ON assistant_dept_notes FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

COMMENT ON TABLE assistant_dept_notes IS
  'AIP-23b — department notes: short work facts a person suggests and an approver (head, GM, owner, superadmin) approves. Status proposed or '
  'approved; rejected and withdrawn notes are deleted. Names are stored as text and kept after erasure (AIP-D23). Core table, tenant RLS only.';

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = current_schema() AND c.relname = 'assistant_dept_notes' AND c.relrowsecurity AND c.relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610311700: assistant_dept_notes must have RLS enabled and FORCED (found % matching table)', n;
  END IF;

  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'assistant_dept_notes';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610311700: expected exactly one policy (tenant_isolation) on assistant_dept_notes, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'assistant_dept_notes'::regclass AND contype = 'c' AND conname IN (
     'assistant_dept_notes_unit_ck', 'assistant_dept_notes_body_ck', 'assistant_dept_notes_status_ck', 'assistant_dept_notes_record_kind_ck',
     'assistant_dept_notes_proposed_name_ck', 'assistant_dept_notes_decided_name_ck', 'assistant_dept_notes_record_pair_ck',
     'assistant_dept_notes_decision_ck', 'assistant_dept_notes_pinned_ck');
  IF n <> 9 THEN
    RAISE EXCEPTION '202610311700: expected the 9 named CHECKs on assistant_dept_notes, found %', n;
  END IF;

  -- erasure (AIP-D23): deleting a user nulls proposed_by and decided_by (it must not block the delete and must not delete the note)
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'assistant_dept_notes'::regclass AND contype = 'f' AND confrelid = 'users'::regclass AND confdeltype = 'n';
  IF n <> 2 THEN
    RAISE EXCEPTION '202610311700: proposed_by and decided_by must reference users ON DELETE SET NULL, found % matching foreign key(s)', n;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'assistant_dept_notes' AND indexname IN ('ix_assistant_dept_notes_unit', 'ix_assistant_dept_notes_proposer');
  IF n <> 2 THEN
    RAISE EXCEPTION '202610311700: expected the unit and proposer indexes on assistant_dept_notes, found %', n;
  END IF;

  RAISE NOTICE '202610311700: assistant_dept_notes ready (RLS forced, 9 CHECKs, 2 FKs ON DELETE SET NULL, 2 indexes)';
END $$;
