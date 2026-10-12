-- 202610132000_pv5_document_files_seal.sql — PV-5 / PV5-07: issued-invoice PDFs and the sealed signed copy of a contract.
-- Plan: docs/plans/2026-10-12-pv5-contracts-billing-tickets.md (PV5-07; design decisions 18, 19, 21). Ruling PV-D25 (the
-- company seal). PV-D13: no company names or ids anywhere in this file.
--
-- WHAT THIS ADDS
--   files.role                 : NULL for every ordinary attachment; 'invoice_pdf' or 'contract_signed_copy' for a document
--                                the platform rendered once and stored (decision 19: never re-rendered on download).
--   ux_files_live_role         : at most ONE live file per (target_entity_type, target_entity_id, role). This is what makes
--                                the render jobs idempotent under a race: the loser's INSERT fails and it stores nothing.
--   pv5_files_guard_role_file  : a role file is a record. It cannot be soft-deleted, hard-deleted, re-pointed or have its
--                                bytes, hash or role changed, and no existing file can be given a role after the fact.
--                                (0400's contract-file guard is untouched; this is a second trigger, not an edit of it.)
--   company_seal_certificates  : the PUBLIC certificate of each company sealing key (PV-D25), kept after a rotation so an
--                                old seal stays checkable. The private key and its passphrase are NEVER here: they are a
--                                file mount on the platform container (see platform-nest/src/core/document-seal.ts).
--   document_jobs              : one row per document the render jobs owe (an invoice PDF, a sealed copy): its state, the
--                                reason it is not there yet, the retry clock, and when an owner was told (once).
--
-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────────
-- Both new tables: ENABLE + FORCE RLS and the NULLIF-hardened tenant policy (an unset GUC reads ZERO rows), the shape of
-- 202610130400 §11. Core policy, not a module wall: sealing runs for every company, finance module or not.
--
-- ── GRANTS (security-relevant, stated for review; NO existing grant is widened) ────────────────────
-- platform_app gets SELECT, INSERT on company_seal_certificates and nothing else: a certificate row is evidence for every
-- seal made with that key, so the runtime role can neither rewrite nor delete one. document_jobs: SELECT, INSERT,
-- UPDATE (no DELETE: the failure history is the audit trail). sync_app gets NOTHING on either table.
--
-- ── ROLLOUT ────────────────────────────────────────────────────────────────────────────────────────
-- Additive. Brief ACCESS EXCLUSIVE lock on files while the column, CHECKs and the trigger are added (no rewrite: the
-- column is nullable with no default, and the CHECKs pass trivially on NULL). NO DML in this file. Nothing reads or
-- writes the new objects until the PV5-07 code ships; until a company's sealing key is mounted, signed contracts stay
-- "being prepared" and document_jobs records why. Reverse (before any role file exists): DROP the trigger and function,
-- the index, the three CHECKs and files.role; DROP the two tables.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · files.role and its CHECKs
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE files ADD COLUMN role text;

ALTER TABLE files
  ADD CONSTRAINT files_role_check CHECK (role IS NULL OR role IN ('invoice_pdf', 'contract_signed_copy')),
  -- A role names what the file is OF, so it fixes the parent kind: an invoice PDF hangs off an invoice, a sealed copy
  -- off a contract. The portal's download route resolves ownership through that parent kind.
  ADD CONSTRAINT files_role_target CHECK (
    role IS NULL
    OR (role = 'invoice_pdf' AND target_entity_type = 'invoice')
    OR (role = 'contract_signed_copy' AND target_entity_type = 'contract')
  ),
  -- A rendered document is stored bytes with the hash of those bytes, never a link-only reference.
  ADD CONSTRAINT files_role_has_content CHECK (role IS NULL OR (storage_key IS NOT NULL AND sha256 IS NOT NULL));

-- One live document per parent and role. Partial: NULL defeats UNIQUE, and ordinary attachments (role NULL) are many.
CREATE UNIQUE INDEX ux_files_live_role
  ON files (target_entity_type, target_entity_id, role)
  WHERE role IS NOT NULL AND deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · the guard: a role file is a record (widens 0400's soft-delete guard to every file with a role)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Written for `files` only (plpgsql OLD/NEW resolve against the triggering table).
CREATE OR REPLACE FUNCTION pv5_files_guard_role_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.role IS NOT NULL THEN
      RAISE EXCEPTION 'PV5_ROLE_FILE_IS_A_RECORD: file % is an issued document (%) and cannot be deleted', OLD.id, OLD.role
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  -- A role is given when the document is stored (INSERT) and never changes: an existing attachment cannot be promoted
  -- into "the invoice of record", and a record cannot be demoted into an ordinary, deletable attachment.
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'PV5_ROLE_FILE_IS_A_RECORD: the role of file % is set when it is stored and cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.role IS NOT NULL AND (
       NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.target_entity_type IS DISTINCT FROM OLD.target_entity_type
    OR NEW.target_entity_id IS DISTINCT FROM OLD.target_entity_id
  ) THEN
    RAISE EXCEPTION 'PV5_ROLE_FILE_IS_A_RECORD: file % is an issued document (%) and cannot be deleted, moved or changed', OLD.id, OLD.role
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_files_guard_role_file
  BEFORE UPDATE OR DELETE ON files
  FOR EACH ROW EXECUTE FUNCTION pv5_files_guard_role_file();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · company_seal_certificates — the public half of each company sealing key (PV-D25)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE company_seal_certificates (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES companies(id),
  -- Lower-case hex of the certificate's serial number.
  serial              text NOT NULL,
  -- The name the certificate was issued in (the billing profile's legal name on the day the key was made).
  subject             text NOT NULL,
  -- SHA-256 of the certificate's DER bytes, lower-case hex: what a reader's "certificate details" pane shows.
  fingerprint_sha256  text NOT NULL,
  valid_from          timestamptz NOT NULL,
  valid_to            timestamptz NOT NULL,
  certificate_pem     text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seal_certificates_serial_format CHECK (serial ~ '^[0-9a-f]{2,64}$'),
  CONSTRAINT seal_certificates_fingerprint_format CHECK (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT seal_certificates_subject_nonblank CHECK (btrim(subject) <> ''),
  CONSTRAINT seal_certificates_validity CHECK (valid_to > valid_from),
  -- Public material only. A private key pasted here by mistake is refused by the database, not by care.
  CONSTRAINT seal_certificates_public_only CHECK (
    certificate_pem LIKE '-----BEGIN CERTIFICATE-----%' AND certificate_pem NOT LIKE '%PRIVATE KEY%'
  ),
  CONSTRAINT ux_seal_certificates_serial UNIQUE (tenant_id, serial)
);
CREATE UNIQUE INDEX ux_seal_certificates_fingerprint ON company_seal_certificates (fingerprint_sha256);
CREATE INDEX ix_seal_certificates_tenant_valid ON company_seal_certificates (tenant_id, valid_from DESC);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · document_jobs — what the render jobs owe, and why a document is not there yet
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- status:
--   pending  : owed, not yet attempted (or attempted and about to be retried);
--   stored   : the file exists (file_id);
--   blocked  : waiting on configuration (no sealing key or certificate, no renderer); retried on a slow clock;
--   failed   : a transient error (renderer down, timeout); retried with backoff;
--   refused  : will never be produced as things stand (the attached document no longer matches the hash the client
--              signed; a contract with no fixed content). Not retried automatically.
CREATE TABLE document_jobs (
  tenant_id          uuid NOT NULL REFERENCES companies(id),
  role               text NOT NULL,
  entity_id          uuid NOT NULL,
  status             text NOT NULL DEFAULT 'pending',
  attempts           integer NOT NULL DEFAULT 0,
  -- A short machine reason (`seal_key_missing`, `content_mismatch`, ...) followed by words staff can act on. Never key
  -- material, never a passphrase, never document content.
  last_error         text,
  last_attempt_at    timestamptz,
  next_attempt_at    timestamptz,
  -- Set the first (and only) time an owner was told this document is stuck. Not on every retry.
  owner_notified_at  timestamptz,
  file_id            uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role, entity_id),
  CONSTRAINT document_jobs_role_check CHECK (role IN ('invoice_pdf', 'contract_signed_copy')),
  CONSTRAINT document_jobs_status_check CHECK (status IN ('pending', 'stored', 'blocked', 'failed', 'refused')),
  CONSTRAINT document_jobs_stored_has_file CHECK ((status = 'stored') = (file_id IS NOT NULL)),
  CONSTRAINT document_jobs_attempts_nonneg CHECK (attempts >= 0)
);
CREATE INDEX ix_document_jobs_due ON document_jobs (tenant_id, status, next_attempt_at) WHERE status <> 'stored';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5 · RLS + grants for the two new tables
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_seal_certificates', 'document_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I FOR ALL
        USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
        WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
    $f$, t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sync_app') THEN
      EXECUTE format('REVOKE ALL ON %I FROM sync_app', t);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    -- NARROWING: ALTER DEFAULT PRIVILEGES hands platform_app full DML on owner-created tables; take back what it must
    -- never do. A certificate is never rewritten or deleted; a job's history is never deleted.
    GRANT SELECT, INSERT ON company_seal_certificates TO platform_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON company_seal_certificates FROM platform_app;
    GRANT SELECT, INSERT, UPDATE ON document_jobs TO platform_app;
    REVOKE DELETE, TRUNCATE ON document_jobs FROM platform_app;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 6 · Self-assertion: a migration that cannot prove its own shape fails loudly instead of shipping
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  t text;
  c text;
  def text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_seal_certificates', 'document_jobs'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = format('public.%I', t)::regclass AND relrowsecurity AND relforcerowsecurity) THEN
      RAISE EXCEPTION 'PV5-07: RLS is not ENABLED+FORCED on %', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation') THEN
      RAISE EXCEPTION 'PV5-07: tenant_isolation policy missing on %', t;
    END IF;
  END LOOP;
  FOREACH c IN ARRAY ARRAY['files_role_check', 'files_role_target', 'files_role_has_content',
                           'seal_certificates_public_only', 'document_jobs_stored_has_file'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'c') THEN
      RAISE EXCEPTION 'PV5-07: CHECK % is missing', c;
    END IF;
  END LOOP;
  SELECT indexdef INTO def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_files_live_role';
  IF def IS NULL OR def NOT LIKE 'CREATE UNIQUE INDEX%' OR def NOT LIKE '%WHERE%' THEN
    RAISE EXCEPTION 'PV5-07: ux_files_live_role is missing or is not a partial UNIQUE index';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_files_guard_role_file' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'PV5-07: trigger trg_files_guard_role_file is missing';
  END IF;
  -- 0400's contract-file guard must still be there: this file widens it, it never replaces it.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_files_guard_contract_file' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'PV5-07: 0400''s trg_files_guard_contract_file is missing';
  END IF;
END $$;

COMMENT ON COLUMN files.role IS
  'PV5-07: NULL for an ordinary attachment; invoice_pdf / contract_signed_copy for a document rendered once and stored. A role file is a record (trg_files_guard_role_file).';
COMMENT ON TABLE company_seal_certificates IS
  'PV5-07 (PV-D25): the public certificate of each company sealing key, kept after rotation so old seals stay checkable. The private key is a file mount, never in the database.';
COMMENT ON TABLE document_jobs IS
  'PV5-07: the invoice PDFs and sealed contract copies the render jobs owe, with the reason one is not there yet and when an owner was told (once).';
