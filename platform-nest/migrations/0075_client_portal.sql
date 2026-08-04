-- CP-1 — client portal: contracts (with two-party e-signature) and invoice payments.
-- Program: docs/plans/2026-08-04-client-portal-program.md
--
-- ── NUMBERING (migrations/README.md rule 5) ───────────────────────────────────────────────────────
-- `ls migrations | sort | tail` at write time showed head = 0074_pipeline_runs_backfill_client_from_
-- meeting.sql, so 0075 is next-unused. `0058`/`0059` remain the reports program's permanently-
-- orphaned reservation gaps: do NOT fill them. The README's "next unused is 0070" line is five slots
-- stale — as every entry in that log warns, only `ls` is authoritative at the moment DDL is written.
--
-- ── WHY THESE TWO CONCEPTS ARE NEW RATHER THAN DERIVED ────────────────────────────────────────────
-- The client portal surfaces seven things. Five already have a home and are NOT touched here:
-- progress + timeline (`projects` + `pm_tasks` + `pm_progress_snapshots`), milestones
-- (`pm_milestones`), deliverables (`deliverables`), approvals/sign-offs (`pipeline_gates` +
-- `scope_signoffs`), profile (`users` + `clients` + `client_contacts`). Two had no representation at
-- all:
--
--   * CONTRACT. The nearest existing thing is `scope_signoffs`, which signs a *pipeline run's scope*
--     — it has no term, no value, no document, no version, and no life outside one delivery run. A
--     client asking "what did we agree, for how much, until when" cannot be answered from it. So
--     `contracts` is a first-class agreement object, and `contract_signatures` deliberately COPIES
--     the scope_signoffs two-party shape (one row per party, UNIQUE on the pair) rather than
--     inventing a second signing idiom — the portal's sign path and the pipeline's sign path then
--     read the same way to anyone maintaining either.
--
--   * PAYMENT. `invoices` (0021) carries a status enum and nothing else: draft|sent|paid|void. There
--     is no record of WHEN money arrived, HOW MUCH (so no partial payments, no balance), by what
--     METHOD, under what REFERENCE, or with what PROOF. A client could not tell us they had paid, and
--     staff flipping `status='paid'` destroyed the only bit of information there was. `invoice_payments`
--     is an append-only ledger against an invoice; `invoices.status` becomes a DERIVED cache of it,
--     which is why nothing here alters that column's meaning — the portal computes balance from this
--     table and the commerce controller updates the status as a convenience for the staff billing UI.
--
-- ── CLIENT-WRITABLE TABLES: THE THREAT MODEL THAT SHAPED THE COLUMNS ──────────────────────────────
-- These are the FIRST tables in this schema that an EXTERNAL party writes to (the portal's
-- record-payment and sign-contract paths). Two consequences are baked into the DDL rather than left
-- to controller discipline:
--   1. A client-supplied payment is `status='pending'` by DEFAULT and only staff move it to
--      'confirmed'. The CHECK plus the default mean a client claim can never *by itself* look like
--      settled money, even if a future controller forgets to force the status.
--   2. Money and identity columns a client must not choose are separate from the ones they may:
--      `recorded_by` (who claims) is distinct from `confirmed_by` (who verified). Collapsing them
--      into one `actor_id` would have made "the client confirmed their own payment" representable.
-- FORCE RLS on all three mirrors 0001/0021/0072 — a client's connection carries their tenant in the
-- authorized-tenant-set, so cross-tenant reads are impossible below the controller as well.
-- Per-CLIENT isolation (this client, not merely this tenant) is NOT expressible in RLS here and is
-- enforced by portal-scope.ts's `client_id = ANY(:callerClientIds)` predicate on every portal query.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 0 · TENANT-SCOPED FOREIGN KEYS — composite UNIQUEs on the parents these tables point at
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- A plain `col uuid REFERENCES parent(id)` on a TENANT-SCOPED parent proves only that the id exists
-- SOMEWHERE. Postgres enforces referential integrity through an internal system trigger that is NOT
-- subject to row security on the referenced table, so a bug or a future write path could construct a
-- row carrying tenant A's `tenant_id` while pointing at tenant B's parent — and no ordinary
-- RLS-scoped SELECT would ever surface it (under `withTenants([A])` the mismatched parent's real owner
-- is simply invisible, which reads as "does not exist").
--
-- The fix is the standard tenant-scoped composite FK established by `0027` on
-- `service_assignments.unit_id`: declare the FK over `(col, tenant_id) -> parent(id, tenant_id)` and
-- the DATABASE guarantees the parent belongs to the same tenant, unconditionally, from any session,
-- on INSERT and on every UPDATE that touches the column.
--
-- APPLIED HERE AND NOT IN 0072 (the closest analogue, same domain, three days earlier — which used
-- plain FKs): these are the tables that carry MONEY and a signed legal agreement, which is where a
-- cross-tenant pointer is least acceptable and least likely to be noticed. The controllers do validate
-- every parent id against a tenant-scoped query, so this is defence in depth rather than a live bug —
-- but it is free, it cannot fail, and it is the documented standard for new DDL. `0072`'s plain FKs are
-- deliberately left alone: retrofitting them is a separate, riskier migration against live rows.
--
-- Each ADD CONSTRAINT below is additive and cannot fail: `id` is already the primary key of every
-- parent, so `(id, tenant_id)` is trivially unique. `IF NOT EXISTS` is not available for
-- ADD CONSTRAINT, so a guarded DO block keeps this idempotent if a future migration adds the same
-- composite unique for its own composite FK.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clients', 'projects', 'invoices', 'files'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = format('ux_%s_id_tenant', t)
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT ux_%s_id_tenant UNIQUE (id, tenant_id)', t, t);
    END IF;
  END LOOP;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · contracts — the agreement, versioned, with a term and a value
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE contracts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  -- NOT NULL: a contract with no client is not a contract. (Contrast `projects.client_id`, nullable
  -- because internal work is a real case there.) Tenant-scoped composite FK declared below (§0).
  client_id uuid NOT NULL,
  -- Nullable: a master services agreement covers the whole relationship; a statement of work is
  -- scoped to one project. Both are this table, distinguished by whether this column is set.
  project_id uuid,
  title text NOT NULL,
  -- Human reference ("GDA-2026-014") shown to the client and quoted in email. Free text, not
  -- generated, because the agency's existing paper numbering has to be representable.
  reference text,
  -- Bumped when terms are re-issued. A signed contract is NEVER edited in place — a new version row
  -- supersedes it via `supersedes_id`, so the signature on v1 keeps meaning what it meant.
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- No inline REFERENCES: the tenant-scoped composite self-FK is added after the table exists.
  supersedes_id uuid,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'signed', 'declined', 'expired', 'void')),
  -- The document itself. `file_id` is the PDF the client downloads (files, 0009/0022); `body_md` is
  -- for terms authored in-app with no attachment. Either may be null: a contract can be a link-only
  -- reference attachment, and `files` already models that (storage_key NULL, url set).
  file_id uuid,
  body_md text,
  -- numeric, not float8: this is contract value. `invoices.total` is numeric for the same reason.
  value numeric,
  currency text NOT NULL DEFAULT 'IDR',
  starts_on date,
  ends_on date,
  sent_at timestamptz,
  signed_at timestamptz,          -- set when the LAST required party signs (both, not either)
  declined_at timestamptz,
  decline_reason text,
  created_by uuid REFERENCES users(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- A term that ends before it starts is a data-entry error that would silently render as an
  -- already-expired contract in the portal. Cheap to refuse here.
  CONSTRAINT contracts_term_ordered CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  -- Tenant-scoped composite FKs (see §0). `supersedes_id` is a SELF-reference and so gets the same
  -- treatment via the table's own composite unique, added after creation below.
  CONSTRAINT fk_contracts_client_tenant  FOREIGN KEY (client_id, tenant_id)  REFERENCES clients (id, tenant_id),
  CONSTRAINT fk_contracts_project_tenant FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id),
  CONSTRAINT fk_contracts_file_tenant    FOREIGN KEY (file_id, tenant_id)    REFERENCES files (id, tenant_id)
);
-- Lets `contracts` be the target of a two-column FK — needed by `supersedes_id` just below and by
-- `contract_signatures`/`invoice_payments`. Redundant with the PK on `id` alone, as in 0027.
ALTER TABLE contracts ADD CONSTRAINT ux_contracts_id_tenant UNIQUE (id, tenant_id);
-- A version chain must stay inside one tenant. Added after the table exists because a self-referencing
-- composite FK cannot name a constraint the table does not have yet.
ALTER TABLE contracts
  ADD CONSTRAINT fk_contracts_supersedes_tenant
  FOREIGN KEY (supersedes_id, tenant_id) REFERENCES contracts (id, tenant_id);
-- The portal's list query is (tenant, client) filtered on the undeleted set — the hot path.
CREATE INDEX ix_contracts_client ON contracts (tenant_id, client_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_contracts_project ON contracts (tenant_id, project_id) WHERE project_id IS NOT NULL AND deleted_at IS NULL;
-- Partial, because `reference` is optional and SQL NULLs are distinct — a plain UNIQUE would have
-- constrained nothing for the (common) unnumbered case while still tripping on it. Exactly the trap
-- that let 10 duplicate `manager` roles accumulate before 0073.
CREATE UNIQUE INDEX ix_contracts_reference_uniq
  ON contracts (tenant_id, reference, version)
  WHERE reference IS NOT NULL AND deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · contract_signatures — one row per party (shape deliberately copied from scope_signoffs, 0017)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE contract_signatures (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  -- Tenant-scoped composite FK (§0), declared at table level below so ON DELETE CASCADE rides on the
  -- two-column form. CASCADE is right here and only here: a signature has no meaning without its
  -- contract, unlike a payment, which is a money record that must survive.
  contract_id uuid NOT NULL,
  party text NOT NULL CHECK (party IN ('provider', 'client')),
  signer uuid REFERENCES users(id),
  signer_name text,
  signer_title text,
  -- Opaque reference to a drawn/typed signature artifact if one is ever captured. Kept for parity
  -- with scope_signoffs.signature_ref; the v1 portal signs by typed name + attestation.
  signature_ref text,
  -- Evidence-of-signing, PII-minimised on purpose: a salted HASH of the client's IP and the raw
  -- user-agent string, never the address itself. Enough to answer "was this the same browser" in a
  -- dispute without making the table a personal-data store subject to erasure plumbing.
  ip_hash text,
  user_agent text,
  signed_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_contract_signatures_contract_tenant
    FOREIGN KEY (contract_id, tenant_id) REFERENCES contracts (id, tenant_id) ON DELETE CASCADE
);
-- The idempotency key: signing twice is a no-op (ON CONFLICT DO NOTHING at the call site), exactly
-- as scope_signoffs' `UNIQUE (run_id, party)` makes a re-sign harmless there.
CREATE UNIQUE INDEX ix_contract_signatures_party_uniq ON contract_signatures (contract_id, party);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · invoice_payments — the money ledger behind invoices.status
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE invoice_payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  invoice_id uuid NOT NULL,
  -- Denormalised from the invoice ON PURPOSE. Every portal query filters by the caller's client set,
  -- and joining `invoices` to get there on each one would make the isolation predicate depend on a
  -- join the query author has to remember to write. Kept correct by the controller reading it FROM
  -- the invoice row rather than from the request body — a client cannot name their own client_id.
  client_id uuid,
  amount numeric NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'IDR',
  paid_on date NOT NULL,
  method text NOT NULL DEFAULT 'bank_transfer'
    CHECK (method IN ('bank_transfer', 'card', 'cash', 'other')),
  -- Bank reference / transaction id the client quotes so finance can match it against the statement.
  reference text,
  -- The transfer receipt (files, target_entity_type='invoice_payment'). Nullable: a staff-recorded
  -- payment reconciled straight off the bank statement has no client-supplied proof.
  proof_file_id uuid,
  -- DEFAULT 'pending' is a security control, not a convenience — see the header. A client-recorded
  -- payment is a CLAIM until staff confirm it, and only 'confirmed' rows count toward the balance.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'rejected')),
  note text,
  -- Two distinct identities: who claimed it (may be the external client) and who verified it (must
  -- be staff). Collapsing these would make self-confirmation representable.
  recorded_by uuid REFERENCES users(id),
  confirmed_by uuid REFERENCES users(id),
  confirmed_at timestamptz,
  rejected_reason text,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- Tenant-scoped composite FKs (§0). NO ON DELETE CASCADE anywhere here, deliberately: a payment is a
  -- money record and must outlive a mis-deleted invoice rather than vanish with it. `invoices` has no
  -- hard-delete path anyway (it soft-deletes via `deleted_at`), so this only matters if one is ever
  -- added — which is exactly when the wrong choice here would be discovered too late.
  CONSTRAINT fk_invoice_payments_invoice_tenant FOREIGN KEY (invoice_id, tenant_id) REFERENCES invoices (id, tenant_id),
  CONSTRAINT fk_invoice_payments_client_tenant  FOREIGN KEY (client_id, tenant_id)  REFERENCES clients (id, tenant_id),
  CONSTRAINT fk_invoice_payments_proof_tenant   FOREIGN KEY (proof_file_id, tenant_id) REFERENCES files (id, tenant_id)
);
CREATE INDEX ix_invoice_payments_invoice ON invoice_payments (tenant_id, invoice_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_invoice_payments_client ON invoice_payments (tenant_id, client_id) WHERE deleted_at IS NULL;
-- Finance's "what needs confirming" queue, and the portal's "your payment is being verified" badge.
CREATE INDEX ix_invoice_payments_pending ON invoice_payments (tenant_id, status) WHERE status = 'pending' AND deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · FORCE RLS + authorized-tenant-set isolation (mirrors 0001/0021/0072)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- NULLIF(...) is load-bearing and matches 0025's hardening: without it an UNSET GUC yields '' and
-- string_to_array('', ',') gives {''}, which casts to uuid[] and errors rather than matching nothing.
-- These are core (not module-owned) tables, so there is deliberately no app_module_allowed() clause:
-- the portal is not a per-tenant-enableable module, and gating a client's own contract behind a
-- module flag would fail the portal closed for reasons no one would find.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contracts', 'contract_signatures', 'invoice_payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
       USING (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))
       WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting(''app.current_tenant_ids'', true), ''''), '','')::uuid[]))',
      t
    );
  END LOOP;
END $$;

-- No DML in this migration — nothing to backfill (both concepts are new), so the
-- owner-runs-as-NOBYPASSRLS backfill trap that made 0050 silently affect zero rows does not apply.
