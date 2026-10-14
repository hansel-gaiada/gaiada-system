-- 202610150300_pv5_certified_signing_simulated.sql — PV-5 / PV5-11: certified signing through a provider, built against a
-- SIMULATED certified-signature provider (PSrE) for the review stage.
-- Plan: docs/plans/2026-10-12-pv5-contracts-billing-tickets.md (PV5-11; design decisions 11-15 and 21).
-- Rulings: PV-D8 (two signature tiers, content fixed at send), PV-D25 (VIDA when first needed), PV-D43 (2026-10-14: certified
-- signing is unparked for the REVIEW stage with a simulated PSrE, labelled, audited, flag-gated, switched off before real
-- data; the real PSrE comes later as a second adapter). PV-D13: no company names or ids anywhere in this file.
--
-- WHAT THIS ADDS
--   1. contracts.signature_provider + contracts.provider_envelope_id: the provider and envelope a CERTIFIED contract is
--      signed through. Set once, when the client reaches the sign step (never at send: a PSrE charges per signature), and
--      frozen afterwards by its own trigger (trg_contracts_envelope_frozen; 0400's content-freeze trigger is untouched).
--      CHECKs: both or neither; only on a certified contract with fixed content. One envelope belongs to one contract
--      (partial unique index, NULL defeats UNIQUE).
--   2. trg_contract_signatures_tier_guard: the database's own rule for WHO may sign a certified contract. A certified
--      contract takes provider signatures only (a typed name is refused here too, not only by the two routes), and a
--      provider signature must name the provider and envelope the contract is signed through.
--   3. files.role gains 'contract_certified_copy' (the provider's signed PDF) and 'contract_certified_certificate' (the
--      certificate the provider signed it with), both under a contract. They are records: 202610132000's role-file guard
--      covers every role, so they can never be deleted, moved or changed. Both CHECKs are re-declared WHOLE (a DROP+ADD on
--      a shared CHECK re-declares everything): every value 202610132000 allowed is kept.
--   4. simulated_psre_envelopes: the SIMULATED PSrE's own store (src/signatures/simulated-psre.ts). It stands where a real
--      provider's database would be: what was sent to it (its own copy of the document, by storage key and SHA-256), the
--      signers and their state, and on completion the signed PDF (storage key + SHA-256) and the PUBLIC certificate it
--      was signed with. Never a private key: the simulated PSrE's key lives in process memory only (see that file's
--      header, "KEY CUSTODY"), and a CHECK refuses anything that looks like one.
--
-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────────
-- simulated_psre_envelopes: ENABLE + FORCE RLS and the NULLIF-hardened tenant policy (an unset GUC reads ZERO rows), the
-- shape of 202610130400 §11. Core policy, not a module wall (contracts are core). The new contracts columns and the files
-- CHECKs inherit their tables' existing policies.
--
-- ── GRANTS (security-relevant, stated for review; NO existing grant is widened) ────────────────────
-- platform_app: SELECT, INSERT, UPDATE on simulated_psre_envelopes; DELETE and TRUNCATE revoked (an envelope is the
-- provider's evidence of who signed what). sync_app gets NOTHING on it.
--
-- ── ROLLOUT ────────────────────────────────────────────────────────────────────────────────────────
-- Additive, NO DML. Brief ACCESS EXCLUSIVE locks on contracts, contract_signatures and files while columns, CHECKs and
-- triggers are added (no rewrite: nullable columns, no defaults; the new CHECKs pass on every existing row because every
-- new column is NULL and the files CHECKs only widen). The signature guard is BEFORE INSERT OR UPDATE on
-- contract_signatures: existing rows are not re-checked, and no existing writer can trip it (the typed-name routes already
-- refuse a certified contract; provider signatures did not exist before this ticket). Nothing reads or writes the new
-- objects unless SIGNATURE_SIMULATION_ENABLED is on. Reverse: drop the two triggers and functions, the index, the CHECKs
-- and the two contracts columns; re-declare the two files CHECKs without the certified roles (only while no such file
-- exists); drop simulated_psre_envelopes.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · contracts: the provider and envelope a certified contract is signed through
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE contracts
  ADD COLUMN signature_provider   text,
  ADD COLUMN provider_envelope_id text;

ALTER TABLE contracts
  ADD CONSTRAINT contracts_signature_provider_format
    CHECK (signature_provider IS NULL OR signature_provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  ADD CONSTRAINT contracts_provider_envelope_format
    CHECK (provider_envelope_id IS NULL OR (length(provider_envelope_id) BETWEEN 1 AND 128)),
  -- A provider with no envelope (or the reverse) is an incoherent record.
  ADD CONSTRAINT contracts_envelope_pair CHECK ((signature_provider IS NULL) = (provider_envelope_id IS NULL)),
  -- Only a CERTIFIED contract is signed through a provider, and only once its content is fixed (the envelope is created
  -- from that content; content_fixed_at is set together with the hash, 202610130400's contracts_content_hash_stamped).
  ADD CONSTRAINT contracts_envelope_only_certified
    CHECK (provider_envelope_id IS NULL OR (signature_tier = 'certified' AND content_sha256 IS NOT NULL));

-- One envelope, one contract. Partial: NULL defeats UNIQUE, and almost every contract has none.
CREATE UNIQUE INDEX ux_contracts_provider_envelope
  ON contracts (signature_provider, provider_envelope_id) WHERE provider_envelope_id IS NOT NULL;

-- Once set, the envelope is part of the record of how the contract was signed: it cannot be re-pointed or cleared.
-- Written for `contracts` only (plpgsql OLD/NEW resolve against the triggering table).
CREATE OR REPLACE FUNCTION pv5_contracts_envelope_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.provider_envelope_id IS NOT NULL
     AND (NEW.provider_envelope_id IS DISTINCT FROM OLD.provider_envelope_id
          OR NEW.signature_provider IS DISTINCT FROM OLD.signature_provider) THEN
    RAISE EXCEPTION 'PV5_CONTRACT_ENVELOPE_FIXED: contract % is signed through provider envelope %; it cannot be re-pointed or cleared', OLD.id, OLD.provider_envelope_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_contracts_envelope_frozen
  BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION pv5_contracts_envelope_frozen();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · contract_signatures: a certified contract takes provider signatures only, from its own envelope
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- The contract is read with the inserting session's own tenant context (contracts is tenant-RLS; every writer runs inside
-- withTenants for the signature's tenant, and contract_signatures' own policy refuses the row otherwise). NOT FOUND can
-- therefore only mean a row the FK will refuse anyway; it is left to the FK rather than guessed at here.
-- Written for `contract_signatures` only.
CREATE OR REPLACE FUNCTION pv5_contract_signatures_tier_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k record;
BEGIN
  SELECT signature_tier, signature_provider, provider_envelope_id INTO k
    FROM contracts WHERE id = NEW.contract_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF k.signature_tier = 'certified' AND NEW.provider IS NULL THEN
    RAISE EXCEPTION 'PV5_CERTIFIED_NEEDS_PROVIDER: contract % is in the certified tier and is signed through a certified provider, never by typed name', NEW.contract_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.provider IS NOT NULL AND (
       k.signature_tier IS DISTINCT FROM 'certified'
    OR NEW.provider IS DISTINCT FROM k.signature_provider
    OR NEW.provider_envelope_id IS DISTINCT FROM k.provider_envelope_id
  ) THEN
    RAISE EXCEPTION 'PV5_PROVIDER_SIGNATURE_MISMATCH: a provider signature on contract % must name the provider and envelope that contract is signed through', NEW.contract_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_contract_signatures_tier_guard
  BEFORE INSERT OR UPDATE ON contract_signatures
  FOR EACH ROW EXECUTE FUNCTION pv5_contract_signatures_tier_guard();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · files.role: the provider's signed copy and its certificate
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Re-declared WHOLE: 'invoice_pdf' and 'contract_signed_copy' (202610132000) are kept exactly.
ALTER TABLE files DROP CONSTRAINT files_role_check;
ALTER TABLE files DROP CONSTRAINT files_role_target;
ALTER TABLE files
  ADD CONSTRAINT files_role_check CHECK (
    role IS NULL OR role IN ('invoice_pdf', 'contract_signed_copy', 'contract_certified_copy', 'contract_certified_certificate')
  ),
  ADD CONSTRAINT files_role_target CHECK (
    role IS NULL
    OR (role = 'invoice_pdf' AND target_entity_type = 'invoice')
    OR (role IN ('contract_signed_copy', 'contract_certified_copy', 'contract_certified_certificate') AND target_entity_type = 'contract')
  );

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · simulated_psre_envelopes: the simulated PSrE's own store (review stage only, PV-D43)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE simulated_psre_envelopes (
  -- The simulator's envelope id ('simenv_' + 24 hex), the value the ERP stores as contracts.provider_envelope_id.
  id                     text PRIMARY KEY,
  tenant_id              uuid NOT NULL REFERENCES companies(id),
  -- The partner's own reference for the envelope ("<tenant id>:<contract id>"), echoed in every notice like VIDA's
  -- partnerTrxId. One envelope per reference: creating again with the same reference returns the first one.
  partner_ref            text NOT NULL,
  title                  text NOT NULL,
  document_filename      text NOT NULL,
  document_content_type  text NOT NULL,
  -- SHA-256 of the bytes the simulator RECEIVED, computed by it (a provider reports the hash of what it holds).
  document_sha256        text NOT NULL,
  document_storage_key   text NOT NULL,
  -- [{ role: 'client' | 'countersigner', displayName, state: 'pending' | 'signed', signedAt, signerRef, signerName,
  --    signerTitle }]. Updated only under the envelope's row lock.
  signers                jsonb NOT NULL,
  status                 text NOT NULL DEFAULT 'pending',
  completed_at           timestamptz,
  signed_storage_key     text,
  signed_sha256          text,
  certificate_pem        text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT simulated_psre_envelopes_id_format CHECK (id ~ '^simenv_[0-9a-f]{24}$'),
  CONSTRAINT simulated_psre_envelopes_status_check CHECK (status IN ('pending', 'completed')),
  CONSTRAINT simulated_psre_envelopes_document_sha256_format CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT simulated_psre_envelopes_signed_sha256_format CHECK (signed_sha256 IS NULL OR signed_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT simulated_psre_envelopes_signers_array CHECK (jsonb_typeof(signers) = 'array' AND jsonb_array_length(signers) > 0),
  -- Completed means the signed document and its certificate are held; pending means none of it is.
  CONSTRAINT simulated_psre_envelopes_completed_complete CHECK (
    (status = 'completed') = (completed_at IS NOT NULL AND signed_storage_key IS NOT NULL AND signed_sha256 IS NOT NULL AND certificate_pem IS NOT NULL)
  ),
  -- Public material only. A private key here is refused by the database, not by care.
  CONSTRAINT simulated_psre_envelopes_public_only CHECK (
    certificate_pem IS NULL OR (certificate_pem LIKE '-----BEGIN CERTIFICATE-----%' AND certificate_pem NOT LIKE '%PRIVATE KEY%')
  ),
  CONSTRAINT ux_simulated_psre_envelopes_partner_ref UNIQUE (tenant_id, partner_ref)
);

DO $$
BEGIN
  ALTER TABLE simulated_psre_envelopes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE simulated_psre_envelopes FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON simulated_psre_envelopes;
  CREATE POLICY tenant_isolation ON simulated_psre_envelopes FOR ALL
    USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
    WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]));
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    GRANT SELECT, INSERT, UPDATE ON simulated_psre_envelopes TO platform_app;
    -- NARROWING: ALTER DEFAULT PRIVILEGES hands platform_app full DML on owner-created tables. An envelope is the
    -- (simulated) provider's evidence of who signed what; the runtime role never deletes one.
    REVOKE DELETE, TRUNCATE ON simulated_psre_envelopes FROM platform_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sync_app') THEN
    REVOKE ALL ON simulated_psre_envelopes FROM sync_app;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5 · Self-assertion: a migration that cannot prove its own shape fails loudly instead of shipping
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  c text;
  def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.simulated_psre_envelopes'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'PV5-11: RLS is not ENABLED+FORCED on simulated_psre_envelopes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'simulated_psre_envelopes' AND policyname = 'tenant_isolation') THEN
    RAISE EXCEPTION 'PV5-11: tenant_isolation policy missing on simulated_psre_envelopes';
  END IF;
  FOREACH c IN ARRAY ARRAY['contracts_signature_provider_format', 'contracts_provider_envelope_format', 'contracts_envelope_pair',
                           'contracts_envelope_only_certified', 'files_role_check', 'files_role_target',
                           'simulated_psre_envelopes_completed_complete', 'simulated_psre_envelopes_public_only'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'c') THEN
      RAISE EXCEPTION 'PV5-11: CHECK % is missing', c;
    END IF;
  END LOOP;
  -- The re-declared role CHECK kept every earlier value.
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = 'files'::regclass AND conname = 'files_role_check';
  IF def NOT LIKE '%invoice_pdf%' OR def NOT LIKE '%''contract_signed_copy''%' OR def NOT LIKE '%contract_certified_copy%'
     OR def NOT LIKE '%contract_certified_certificate%' THEN
    RAISE EXCEPTION 'PV5-11: files_role_check lost a role or did not gain the certified ones: %', def;
  END IF;
  SELECT indexdef INTO def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_contracts_provider_envelope';
  IF def IS NULL OR def NOT LIKE 'CREATE UNIQUE INDEX%' OR def NOT LIKE '%WHERE%' THEN
    RAISE EXCEPTION 'PV5-11: ux_contracts_provider_envelope is missing or is not a partial UNIQUE index';
  END IF;
  FOREACH c IN ARRAY ARRAY['trg_contracts_envelope_frozen', 'trg_contract_signatures_tier_guard',
                           -- the earlier guards this file builds beside, never replaces
                           'trg_contracts_content_frozen', 'trg_files_guard_role_file', 'trg_files_guard_contract_file'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = c AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'PV5-11: trigger % is missing', c;
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN contracts.provider_envelope_id IS
  'PV5-11: the certified-signature provider''s envelope this contract is signed through (with signature_provider). Created when the client reaches the sign step; frozen once set.';
COMMENT ON TABLE simulated_psre_envelopes IS
  'PV5-11 / PV-D43 (review stage only): the SIMULATED PSrE''s own store. Not a certification authority; its signatures are labelled SIMULATED everywhere. The signing key is in process memory only, never here.';
