-- 202609040404_webdev_sites_vault_ref_format_comment.sql — VLT-1/VLT-6 follow-on: document
-- `webdev_sites.vault_ref`'s expected format now that a concrete vault target exists.
-- Plan: docs/plans/2026-09-04-client-hosting-credential-vault.md §3 ("Also required" — vault_ref).
--
-- ── NUMBERING (migrations/README.md — the timestamp scheme) ────────────────────────────────────
-- `date -u +%Y%m%d%H%M` at authoring time. `ls migrations | sort | tail` showed head =
-- 202609040403_integration_connections_credential_lifecycle.sql (this same ticket set's VLT-6,
-- written moments earlier in this session); re-verified immediately before writing this file.
--
-- ── WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
-- COMMENT ON COLUMN only. No ALTER, no FK, no CHECK, no data touched. This is a documentation
-- update to a comment `202608300747_webdev_sites_portfolio_registry.sql` already wrote — that
-- comment correctly stated "a pointer to an operator vault item, never a credential" but was
-- written before there was a concrete target for the pointer to name. Now that VLT-1
-- (202609040401_integration_connections_hosting_providers.sql, this same session) has widened
-- `integration_connections.provider` to admit hosting-credential kinds, the pointer has a real
-- destination worth spelling out.
--
-- ── WHY NO FOREIGN KEY (considered and rejected, not merely omitted) ──────────────────────────
-- `webdev_sites.vault_ref` stays a plain `text` column with no FK to `integration_connections.id`.
-- This was considered and is rejected here for two independent reasons, either one sufficient on
-- its own:
--
-- 1. WSK-D30 (docs/blueprints/webdesk-design-v2.md, restated verbatim in 202608300747's header,
--    lines 25-27) rules that `webdev_sites` lives in "Zone A only" and "references credentials,
--    never stores them" — the deliberate design is that this table does not need to know the
--    SHAPE of what it points at, only that it points somewhere. A `uuid` FK column would still
--    not "store a credential", but it would couple this Zone-A table's schema to Zone-A-adjacent
--    `integration_connections` in a way the design's own words ("there is deliberately no column
--    they could go in" for a credential) suggest was meant to be avoided for the pointer too — a
--    schema-level dependency is a smaller version of the same coupling the design refuses for the
--    credential itself. Loosening `text` to a typed FK is a design-authority call, not a call this
--    migration makes unilaterally.
-- 2. Practically, a real FK would require `vault_ref` to change type from `text` to `uuid` (VLT-2's
--    own read of the current column confirms it is plain `text` today, with no writer at all yet
--    per the plan's VLT-2 ticket), which is exactly the kind of structural column change this
--    ticket's brief instructs against doing unilaterally ("do NOT add a foreign key ... unless you
--    can show it does not violate D30's intent, and if you consider it, explain your reasoning").
--    Both the type change and the FK are therefore left to VLT-2's own design review, where the
--    application-layer validation (cross-tenant / cross-existence checks on PATCH, per VLT-2's
--    acceptance criteria) is being built anyway and can enforce the same invariant a DB-level FK
--    would, without this table taking on a schema dependency the design doc's own wording leans
--    against.
--
-- What THIS migration does instead — a COMMENT clarifying the expected format, so a future reader
-- (or VLT-2's own implementer) knows what a well-formed `vault_ref` value looks like without
-- guessing, while the column itself stays exactly the loosely-typed pointer WSK-D30 specifies.
--
-- ── RLS / GRANTS ────────────────────────────────────────────────────────────────────────────────
-- None. COMMENT ON COLUMN does not touch table security or privileges.
--
-- ── ROLLOUT ─────────────────────────────────────────────────────────────────────────────────────
-- Zero-risk, no rollout step: a comment change cannot affect a running query or writer.

COMMENT ON COLUMN webdev_sites.vault_ref IS
  'Pointer to an operator vault item. NEVER a credential (WSK-D30). For a hosting-credential-backed '
  'site (VLT-1, 2026-09), the expected well-formed value is the text form of an '
  'integration_connections.id (owner_kind=''client'', owner_id -> clients.id, provider one of '
  'cpanel|ftp|ssh|wp_admin) in the SAME tenant as this row — enforced at the application layer '
  '(VLT-2''s PATCH validation), not by a DB foreign key: this column is deliberately untyped text, '
  'not uuid, so this table carries no schema dependency on the vault table''s shape (see this '
  'migration''s header for why an FK was considered and rejected). NULL, or any other operator-vault '
  'reference the write path chooses to accept, both remain valid — this comment documents the '
  'hosting-credential case''s expected shape, it does not constrain the column to it.';
