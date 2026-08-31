-- webdesk/migrations/0007_privacy_dsr.sql
-- WSK-38 — Data & Privacy / data-subject requests (design §11, WSK-D22b/c). Two additive changes,
-- both minimal on purpose (schema changes here are senior-be-proposed but land only via an
-- architect/senior-db-approved spec — this ticket does not improvise beyond what the DSR command
-- surface genuinely needs):
--
--   1. `submissions.status` gains 'erased' — a THIRD terminal state, distinct from the existing
--      'purged' (submissions-purge.service.ts's time-based retention floor). Both scrub `payload`
--      to '{}', but only 'erased' additionally clears `data_subject_ref` (see below) and only
--      'erased' is the result of an on-demand, WS4-gated, human-approved rights request rather
--      than an automatic expiry sweep. Without a distinct status, a raw row scan of `submissions`
--      could never answer "did this stop holding data because someone asked, or because the clock
--      ran out" — a real question a controller (our client) may need answered to satisfy ITS OWN
--      obligations to the data subject.
--
--   2. `dsr_requests` — a purpose-built, append-only ledger for privacy.find / privacy.export /
--      privacy.erase, distinct from the generic `audit_entries` table every other control-plane
--      command already writes to. `audit_entries` stays written too (CommandAuditService, reused
--      verbatim) for cross-command consistency, but `dsr_requests` is what a future
--      "show me every DSR action ever taken against this tenant" surface queries directly, without
--      filtering a table that also carries every unrelated tenant.provision/key.mint/release.*
--      row ever written.
--
-- ============================================================================================
-- THE DESIGN QUESTION THIS TICKET WAS SET (see ../api/README.md's WSK-38 section for the full
-- writeup) — restated here because it is the reason this table's columns are shaped the way they
-- are: erasure collides with (a) the append-only/immutable audit discipline this estate uses
-- everywhere (audit_entries' own REVOKE UPDATE, DELETE below is the concrete instance in THIS
-- schema) and (b) the consent record being itself evidence the controller (our client) may need to
-- keep. Resolution, in one sentence: SCRUB, NOT DELETE, on `submissions` (extending
-- submissions-purge.service.ts's own already-established precedent from time-based to on-demand),
-- PRESERVE the consent columns (they describe what notice a NOW-erased person was shown and that
-- they accepted it — not personal data ABOUT that person, so keeping them serves consent-as-
-- evidence without keeping any PII), and record the erasure itself in a ledger
-- (`dsr_requests`, below) that is structurally incapable of ever holding the erased PII — its own
-- `subject_ref_hash` column is a one-way SHA-256 of the normalized identifier, never the plaintext
-- (see privacy/identifier.ts). A row proving "subject X's data was erased at time T" therefore
-- SURVIVES the erasure it describes, without itself becoming a second, un-erasable copy of X's
-- personal data — which a plaintext-carrying audit row would have been. Crypto-shredding (encrypt
-- each submission's PII with a per-subject key, "erase" = destroy the key) was considered and
-- rejected for THIS ticket: it needs its own key-management schema (a KMS or a wrapped-key column
-- + custody model, same class of decision as WSK-37's AES-256-GCM secret column) that does not
-- exist yet anywhere in this ledger, and inventing one here would be improvised DDL beyond a
-- narrowly-scoped, genuinely-needed migration. Flagged as a stronger future option, not built.
-- ============================================================================================
--
-- Requires 0001_platform_core.sql (tenants, webdesk_tenant_ctx()) and 0003_forms.sql (submissions).
-- Runs as webdesk_migrator (no SET ROLE) — same posture as every prior migration in this ledger.

-- ---------------------------------------------------------------------------
-- 1. submissions.status: add 'erased' alongside the existing four values.
-- ---------------------------------------------------------------------------
-- The original CHECK was declared inline with no explicit constraint name, so Postgres assigned
-- the standard auto-generated name (<table>_<column>_check) — dropped and re-added under that same
-- name so this migration is idempotent-safe to re-read (DROP...IF EXISTS) and does not leave a
-- stray differently-named constraint behind.
ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_status_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_status_check
  CHECK (status IN ('received', 'processed', 'flagged', 'purged', 'erased'));

COMMENT ON COLUMN submissions.status IS
  'received/processed/flagged: normal lifecycle. purged: submissions-purge.service.ts''s
   time-based retention floor scrubbed payload (data_subject_ref survives — a known gap, not
   fixed by this ticket, see webdesk/api/README.md). erased: WSK-38''s on-demand DSR erase command
   scrubbed payload AND cleared data_subject_ref — the row is no longer findable by identity.';

COMMENT ON COLUMN submissions.data_subject_ref IS
  '0003_forms.sql''s own forward-looking hook for WSK-38 (see that file). Nulled by the DSR erase
   command (privacy.erase) as part of erasure — unlike the time-based purge job, which currently
   leaves this column intact (flagged as an inconsistency in the WSK-38 report, not fixed here:
   submissions-purge.service.ts is out of this ticket''s owned scope).';

-- ---------------------------------------------------------------------------
-- 2. dsr_requests — the DSR-specific ledger (append-only, same immutability posture as
--    audit_entries: REVOKE UPDATE, DELETE below).
-- ---------------------------------------------------------------------------
CREATE TABLE dsr_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  kind              text NOT NULL CHECK (kind IN ('find', 'export', 'erase')),
  -- sha256(normalized identifier) ONLY — see privacy/identifier.ts. NEVER the raw email/phone
  -- value: this table's entire reason to exist is to survive an erasure of that same value, which
  -- it could not do if it held a second plaintext copy of the thing being erased.
  subject_ref_hash  text NOT NULL,
  -- Zone B control-plane principal id (ControlPrincipal.subject) — attribution only, same
  -- convention as api_keys/releases/audit_entries.actor across this ledger.
  requested_by      text NOT NULL,
  -- Convenience mirror of the WS4 assertion's approvalId used for this call (all three privacy.*
  -- commands are HIGH-impact and always WS4-gated — see command-types.ts). The real single-use
  -- dedup source of truth stays audit_entries.ws4_approval_id (RealPolicyDecisionPoint), exactly
  -- as it already is for every other command; this column is a read-convenience only.
  ws4_approval_id   text,
  submission_count  integer NOT NULL DEFAULT 0 CHECK (submission_count >= 0),
  attachment_count  integer NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_dsr_requests_tenant ON dsr_requests (tenant_id);
CREATE INDEX ix_dsr_requests_subject ON dsr_requests (tenant_id, subject_ref_hash);

-- Append-only, same reasoning and same mechanism as audit_entries (0001_platform_core.sql): claw
-- back UPDATE/DELETE that init-roles.sh's default-privilege rule would otherwise hand to
-- webdesk_app automatically. A compromised or buggy app process can still record new entries — it
-- can never rewrite or erase the record that an erasure happened.
REVOKE UPDATE, DELETE ON dsr_requests FROM webdesk_app;

ALTER TABLE dsr_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dsr_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dsr_requests;
CREATE POLICY tenant_isolation ON dsr_requests FOR ALL
  USING      (tenant_id = webdesk_tenant_ctx())
  WITH CHECK (tenant_id = webdesk_tenant_ctx());
