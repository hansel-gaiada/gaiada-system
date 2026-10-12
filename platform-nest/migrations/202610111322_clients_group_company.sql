-- 202610111322_clients_group_company.sql — PV3-04: a client can be one of OUR group companies.
-- Tickets: docs/plans/2026-10-11-pv3-hub-symmetry-tickets.md, PV3-04. Rulings: PV-D2 (a group
-- company that the agency serves is a client of the agency), PV-D10 (one client record per company),
-- PV-D13 (no company names or ids in code — and none here: there is NO backfill).
--
-- ── NUMBERING (migrations/README.md — timestamp scheme) ─────────────────────────────────────────
-- `ls migrations | sort | tail` immediately before writing this file showed the head as
-- `202610111030_iam_webdesk_media_permissions.sql`. This takes a later minute.
--
-- ── WHAT ────────────────────────────────────────────────────────────────────────────────────────
-- `clients.group_company_id` points at the company (one of ours, under the same root) that this client
-- IS. NULL for an ordinary external client, which is every existing row. Nothing is backfilled: which
-- client is which company is data the owner marks, not something a migration may guess by name.
--
-- ── WHY THE SAME-ROOT RULE IS NOT HERE ──────────────────────────────────────────────────────────
-- `companies` is a GLOBAL table with no row-level security, and a foreign-key check runs as the table
-- owner, outside RLS. So the FK proves only that the company EXISTS — it would happily accept a company
-- of another group. "Same root as the client's own tenant" is therefore enforced in the application
-- (platform-nest/src/modules/clients/group-company.ts, the resolveGithubOrgTenant precedent, through
-- withGlobal), exactly as 202609290551_client_owner.sql does for the owner's tenancy. It is deliberately
-- not a trigger: a root can change later (re-parenting), and a trigger would only look at write time.
--
-- The CHECK is the one part the database CAN own: a client may not be linked to its own tenant (a
-- company serving itself is the PV-D10 duplicate-record case, not a group client).
--
-- ── RLS / GRANTS ────────────────────────────────────────────────────────────────────────────────
-- Unchanged. `clients` keeps its existing FORCE RLS tenant policy; a column adds no policy and no
-- grant. No new table, role or privilege.
--
-- ── ROLLOUT ─────────────────────────────────────────────────────────────────────────────────────
-- Purely additive and safe on live data: a nullable column with no default, a CHECK that every existing
-- row satisfies (NULL IS DISTINCT FROM tenant_id), and a partial index over zero rows today. Old code
-- never selects or writes the column, so migration-first or code-first deploys both work. Reverse:
-- DROP INDEX idx_clients_group_company; ALTER TABLE clients DROP CONSTRAINT ck_clients_group_company_not_self,
-- DROP COLUMN group_company_id.
--
-- No DML — nothing to backfill, so the NOBYPASSRLS zero-row trap (migration-backfill-rls-trap) does
-- not apply; `npm run lint:migration-rls` has nothing to flag.

ALTER TABLE clients ADD COLUMN group_company_id uuid REFERENCES companies(id);

ALTER TABLE clients
  ADD CONSTRAINT ck_clients_group_company_not_self CHECK (group_company_id IS DISTINCT FROM tenant_id);

CREATE INDEX idx_clients_group_company ON clients (tenant_id, group_company_id) WHERE group_company_id IS NOT NULL;
