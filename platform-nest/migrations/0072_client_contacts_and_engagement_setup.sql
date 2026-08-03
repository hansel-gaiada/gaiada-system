-- W0-1 — engagement setup: client contacts + magic-link invites, meeting scheduling with
-- participants, and the run's missing project/owner links.
-- Spec: docs/superpowers/plans/2026-08-03-webdev-w0-engagement-setup-spec.md
-- Decisions: docs/superpowers/plans/2026-08-03-webdev-gap-assessment-addendum.md (D-1..D-3)
--
-- ── NUMBERING (rule 5, migrations/README.md) ───────────────────────────────────────────────────────
-- `ls migrations | sort | tail` at write time showed head = 0071_it_network_discovery.sql (another
-- session, landed today), so 0072 is next-unused. The webdev Phase-3 plan's "next unused is 0050" is
-- long stale — its own LD-1 says verify, never inherit, and the ledger has moved 22 slots since.
-- `0058`/`0059` remain the reports program's permanently-orphaned reservation gaps: do NOT fill them.
--
-- ── WHY CLIENT CONTACTS DO **NOT** GET A company_memberships ROW (design correction) ───────────────
-- The spec originally proposed giving each client contact a `company_memberships` row with a new
-- kind='client', because that is what `principal.companies` (rbac/principal.ts) and `notify()`
-- (core/http.ts) both read, and `resource_portal.yaml` needs `inTenant` to hold.
--
-- An audit of every call site changed the answer. There are 27 non-test queries over
-- `company_memberships` and only 6 filter on `kind` at all — so widening that CHECK would have
-- required adding a filter at ~10 staff-listing sites (admin identity listings, company user CRUD,
-- teams, PM assignee candidates, claude seats, knowledge ingest, ...) and left every FUTURE site free
-- to forget. The failure mode is a client contact appearing in /people and the HR directory as an
-- employee: a data-exposure bug that looks like ordinary data once it happens.
--
-- So `company_memberships` keeps its meaning — staff and service accounts of this company — and the
-- two places that genuinely need to see client contacts read `client_contacts` instead:
--   * rbac/principal.ts  — `principal.companies` unions in the contact's tenant, which is what makes
--                          `variables.inTenant` hold for the portal policy.
--   * core/http.ts       — `notify()` accepts a client contact as a valid recipient.
-- Two deliberate edits instead of ten defensive ones, and clients are STRUCTURALLY absent from every
-- staff query rather than absent by discipline. No CHECK widening, and no lint needed to hold the line.
--
-- This is safe because of a property that was verified, not assumed: `"user"` (the parent role of
-- `client` in derived_roles.yaml) is NEVER granted by any resource policy — every grant in
-- cerbos/policies names a concrete staff role or `client`, and `derivedRoles: ["client"]` appears
-- ONLY in resource_portal.yaml. A principal holding just the `client` grant can therefore satisfy
-- exactly one policy, so making `inTenant` true for them opens nothing else.
--
-- ── NO DML EXCEPT ONE IDEMPOTENT ROLE SEED ────────────────────────────────────────────────────────
-- The only INSERT is the global `client` role (§6), which follows 0069's exact NOT EXISTS shape.
-- `roles` has no tenant column and no RLS, so it is NOT subject to the owner-runs-as-NOBYPASSRLS
-- backfill trap that made 0050 silently affect zero rows. Every other statement here is DDL.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · client_contacts — MANY contacts per client, optionally scoped to one project (D-1)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Replaces the singular `clients.portal_user_id`, which is written ONLY in testing/fixtures.ts and is
-- NULL for every real client (verified on gda-aicenter). That column is left in place for now and
-- retired in a follow-up once the portal reads through this table — it carries no production data, so
-- there is nothing to migrate and nothing to dual-write.
CREATE TABLE client_contacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  user_id uuid NOT NULL REFERENCES users(id),
  -- NULL = client-wide (every project of this client). A contact on 2 of 5 projects gets 2 rows, and
  -- "signer on project A, viewer on project B" is expressible. Mirrors the user_roles
  -- scope_type/scope_id convention already in this schema rather than inventing a second idiom.
  project_id uuid REFERENCES projects(id),
  -- D-3's "everyone on the same page" implies contacts who WATCH but must not SIGN. Without this,
  -- every invited stakeholder could countersign a scope agreement.
  capability text NOT NULL DEFAULT 'viewer' CHECK (capability IN ('signer', 'viewer')),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'revoked')),
  invited_by uuid REFERENCES users(id),
  invited_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  revoked_at timestamptz,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
-- Two partial uniques, because UNIQUE treats NULLs as distinct: without the second one a contact
-- could be added client-wide twice over.
CREATE UNIQUE INDEX client_contacts_scoped_uniq
  ON client_contacts (tenant_id, client_id, user_id, project_id)
  WHERE deleted_at IS NULL AND project_id IS NOT NULL;
CREATE UNIQUE INDEX client_contacts_clientwide_uniq
  ON client_contacts (tenant_id, client_id, user_id)
  WHERE deleted_at IS NULL AND project_id IS NULL;
-- The principal path (rbac/principal.ts) resolves a user's client tenants on every request, so this
-- index is on the hot path, not just for reporting.
CREATE INDEX ix_client_contacts_user ON client_contacts (user_id, status) WHERE deleted_at IS NULL;
CREATE INDEX ix_client_contacts_client ON client_contacts (tenant_id, client_id) WHERE deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · client_invites — the single-use magic link (owner decision: A+C)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Shape copied from enrollment_codes (0005): single-use, expiring, partial index on the unconsumed
-- set. NOT a reuse of that table — it is user-keyed, untenanted, and exists to link a chat identity to
-- an already-authenticated IdP user, which is the opposite direction of travel.
--
-- WHY THE TENANT TRAVELS IN THE TOKEN, NOT ONLY IN THIS ROW (a correction to the spec's §3): the
-- accept route is necessarily tenant-agnostic — the clicker has no session and cannot supply
-- :tenantId — and this table is FORCE-RLS tenant-scoped, so a lookup with no tenant GUC set would
-- match ZERO rows. Reading the row to discover its own tenant is therefore circular. The token is
-- instead `inv1.<b64url(id)>.<b64url(tenantId)>.<b64url(HMAC)>`, exactly the format and reasoning
-- modules/search/google/oauth-state.ts already uses for the Google callback: verify the HMAC first
-- (cheap, no DB), and only then open the tenant the signature names.
--
-- `token_hash` is still stored and still compared, as defence in depth behind the HMAC: it is the
-- thing that makes a stolen-then-replayed link fail even if the signing key were ever compromised.
-- The RAW token is never stored — it travels through email (or a pasted message) and exists only in
-- the single response that mints it.
CREATE TABLE client_invites (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_contact_id uuid NOT NULL REFERENCES client_contacts(id) ON DELETE CASCADE,
  -- Bound at issue and re-compared at acceptance, so a leaked token cannot be redeemed for a
  -- different address. Stored lower-cased (no citext extension is used anywhere in this schema, so
  -- case-insensitivity is a write-time normalisation, not a column type).
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  -- Short on purpose: this token grants ACCOUNT CREATION, not merely a read.
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invited_by uuid REFERENCES users(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_client_invites_open ON client_invites (token_hash) WHERE consumed_at IS NULL;
CREATE INDEX ix_client_invites_contact ON client_invites (tenant_id, client_contact_id);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · pipeline_runs finally remembers its project and its owner
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- THE PROJECT LINK WAS BEING LOST AT INGEST. `meeting_recordings` carries BOTH client_id and
-- project_id (0023:16-17); `pipeline_runs` carried only client_id (0018:7). So a recording started
-- from a project workspace knew its project and the run it produced forgot it — permanently. That is
-- why WD-06 had to invent WEBDEV_REPORT_PROJECT_ID pointing at ONE project for the whole tenant.
-- Nullable because internal/spec runs legitimately have no project, and because manual runs
-- (POST /pipeline/runs) may be created before a project exists.
ALTER TABLE pipeline_runs
  ADD COLUMN project_id uuid REFERENCES projects(id),
  -- The assigned PM. Notifications currently reuse a single NOTIFY_USER_ID env var, so every run
  -- notifies the same person regardless of who owns it.
  ADD COLUMN owner_id uuid REFERENCES users(id);
CREATE INDEX ix_pipeline_runs_project ON pipeline_runs (tenant_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX ix_pipeline_runs_owner ON pipeline_runs (tenant_id, owner_id) WHERE owner_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · Meeting SCHEDULING, on the existing registry (D-3)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- There was no way to schedule a meeting in the product: meeting_recordings had started_at/ended_at
-- and nothing else. Scheduling rides THIS table rather than a parallel `meetings`/calendar table
-- because it already carries client_id, project_id, title and kind, and already mints the stable
-- `meeting_id` that the FROZEN dispatcher contract keys on — a separate table would duplicate the
-- registry and force a merge at record time.
--
-- The new 'scheduled' status is the pre-recording state, so the row exists — scoped to client,
-- project and both sides' participants — BEFORE anyone presses record. That is what makes D-3
-- ("clients have access before the meeting starts") true rather than nominal.
ALTER TABLE meeting_recordings
  ADD COLUMN scheduled_at timestamptz,
  ADD COLUMN scheduled_by uuid REFERENCES users(id);
CREATE INDEX ix_meeting_recordings_scheduled
  ON meeting_recordings (tenant_id, scheduled_at)
  WHERE deleted_at IS NULL AND scheduled_at IS NOT NULL;

-- Widen the status CHECK to admit 'scheduled'. Rebuilt by name-independent lookup because 0023 did
-- not name the constraint, so its generated name is the only handle and must not be hard-coded.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'meeting_recordings'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%transcribing%';   -- disambiguates from the drive_status CHECK
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE meeting_recordings DROP CONSTRAINT %I', cname);
  END IF;
  EXECUTE $q$
    ALTER TABLE meeting_recordings
      ADD CONSTRAINT meeting_recordings_status_check
      CHECK (status IN ('scheduled','recording','recorded','transcribing','transcribed','ingested','failed'))
  $q$;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5 · meeting_participants — who is in the meeting, on BOTH sides
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- The list D-3's "all parties notified" is addressed from. `side` is denormalised rather than derived
-- from client_contacts at read time so a participant list stays truthful after a contact is revoked:
-- who attended is a historical fact, not a current permission.
CREATE TABLE meeting_participants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  recording_id uuid NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  side text NOT NULL CHECK (side IN ('internal', 'client')),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX meeting_participants_uniq ON meeting_participants (tenant_id, recording_id, user_id);
CREATE INDEX ix_meeting_participants_user ON meeting_participants (tenant_id, user_id);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 6 · Seed the global `client` role — it has NEVER existed
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- resource_portal.yaml grants read/decide/sign to derived role `client`, and derived_roles.yaml:88-94
-- defines that role as "a grant named `client` at company scope" — but no `roles` row named `client`
-- is seeded anywhere in the codebase, so the grant was unissuable and the portal was unreachable
-- even before the missing plumbing. Global (company_id IS NULL) so one row serves every tenant,
-- exactly like 0069's reports_staff/reports_manager. Idempotent via NOT EXISTS, same shape as 0069.
INSERT INTO roles (id, company_id, name, description)
SELECT gen_random_uuid(), NULL, 'client',
       'External client portal access. Deliberately NOT a parent of any staff role: it satisfies '
       'resource_portal.yaml only.'
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE company_id IS NULL AND name = 'client');

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 7 · RLS — FORCE on all three new tenant tables
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- CORE tables (D-2 of the webdev design): the plain tenant wall, NO app_module_allowed() gate — a
-- client's portal access must not depend on which modules the tenant has enabled.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['client_contacts', 'client_invites', 'meeting_participants'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()))
         WITH CHECK (tenant_id = ANY(app_current_tenants()))', t);
  END LOOP;
END $$;

-- 7b · principal_lookup on client_contacts — WITHOUT THIS THE WHOLE DESIGN SILENTLY DOES NOTHING.
-- `rbac/principal.ts` must discover a user's tenants BEFORE any tenant context exists (that is the
-- entire reason company_memberships carries this second, narrow policy — 0001:302-306, hardened in
-- 0004). Under `tenant_isolation` alone, principal assembly sets no `app.current_tenant_ids`, so
-- `app_current_tenants()` is empty, the read matches ZERO rows, and `principal.companies` comes back
-- empty for every client contact — `variables.inTenant` then never holds and the portal stays exactly
-- as unreachable as it is today, with no error anywhere to say why.
--
-- Scope is one user, not one tenant: exactly the rows of the user named in app.principal_user_id.
-- NULLIF(...,'') is not optional — a bare current_setting(...)::uuid becomes ''::uuid when the GUC is
-- unset in a transaction, which ERRORS the whole query and drags every other permissive policy on the
-- table down with it (0004's own finding).
DROP POLICY IF EXISTS principal_lookup ON client_contacts;
CREATE POLICY principal_lookup ON client_contacts FOR SELECT
  USING (user_id = NULLIF(current_setting('app.principal_user_id', true), '')::uuid);

COMMENT ON TABLE client_contacts IS
  'W0 (D-1): many portal contacts per client, project_id NULL = client-wide. Replaces the singular '
  'clients.portal_user_id. Deliberately NOT company_memberships rows — see the migration header: that '
  'would have required a kind filter at ~10 staff-listing query sites and leaked clients into /people. '
  'rbac/principal.ts unions this table into principal.companies (so resource_portal.yaml''s inTenant '
  'holds) and core/http.ts notify() accepts these users as recipients.';
COMMENT ON TABLE client_invites IS
  'W0: single-use magic link. Token is inv1.<id>.<tenantId>.<HMAC> (the oauth-state.ts format) because '
  'the accept route is tenant-agnostic and this table is FORCE-RLS — reading the row to learn its own '
  'tenant would be circular. token_hash is defence in depth behind the HMAC; the raw token is never stored.';
COMMENT ON TABLE meeting_participants IS
  'W0 (D-3): both sides of a scheduled meeting, the list notifications are addressed from. `side` is '
  'denormalised so an attendee list stays truthful after a client contact is revoked.';
COMMENT ON COLUMN pipeline_runs.project_id IS
  'W0: the project this delivery belongs to. Previously absent, so the project link a recording '
  'carried was lost at ingest (hence WD-06''s WEBDEV_REPORT_PROJECT_ID single-project env hack).';
