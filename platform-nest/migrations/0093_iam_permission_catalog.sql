-- 0093_iam_permission_catalog.sql — IAM-01c: persist the permission catalog.
--
-- Seeds the pre-existing, previously zero-consumer `permissions` table (0001_core.sql) from
-- `platform-nest/src/rbac/permission-catalog.json` — 230 entries independently re-derived and
-- machine-verified against every Cerbos policy file (docs/superpowers/plans/
-- 2026-08-10-permission-catalog.md). 215 are `class = 'grantable'` (role-assignable, 1:1 with a
-- Cerbos (kind, action) pair); 15 are `class = 'relationship'` (the assistant/mcp_tool exemptions,
-- Ruling 3 — held by owning the resource or by the MCP hub's channel grant, NEVER by any role,
-- including a future `owner` role). This migration is companion to IAM-01d
-- (src/modules/registry.ts's `validateModulePermissions()`), which loads every registered module's
-- declared permissions at boot and fails closed if any key here is missing — so this file and the
-- renamed `ModuleContract.permissions` declarations across src/modules/*/index.ts must land in the
-- SAME change (the boot-block warning in the IAM-01c/01d ticket).
--
-- ── RLS conclusion (ticket requirement: assert, don't assume) ───────────────────────────────────
-- `permissions` has NO `tenant_id` column and has never had FORCE ROW LEVEL SECURITY applied — it
-- is listed under 0001_core.sql's own "Global tables (no tenant_id; app-layer guarded)" section,
-- alongside `companies`/`users`/`roles`. This migration does not add FORCE RLS to it (the catalog
-- is global reference data shared by every tenant, not tenant data), so:
--   (a) `npm run lint:migration-rls` cannot and does not flag this file — that lint only tracks
--       tables that have had `ALTER TABLE ... FORCE ROW LEVEL SECURITY` applied (see that script's
--       own header); `permissions` is never in that set.
--   (b) the "unset GUC + no BYPASSRLS ⇒ silent zero-row match" trap (migration-backfill-rls-trap,
--       confirmed real for 0050) categorically cannot apply here — that failure mode is specific to
--       an UPDATE/DELETE/INSERT...SELECT whose row-set is filtered by a FORCE-RLS USING policy
--       reading an unset `app.current_tenant_ids` GUC. This file's only DML is a literal-VALUES
--       INSERT ... ON CONFLICT DO UPDATE against a table with no RLS policy of any kind, so every
--       one of the 230 rows below is written or updated unconditionally — there is no row-set for a
--       missing GUC to silently narrow to zero. The closing DO block below still asserts the exact
--       post-seed counts rather than assuming the INSERT did what it looks like it did.
--
-- ── Idempotency ───────────────────────────────────────────────────────────────────────────────────
-- Column adds are `IF NOT EXISTS`; the CHECK constraint and the role_permissions guard trigger are
-- DROP-then-ADD by fixed name (safe against a re-run finding them already present); the seed INSERT
-- is `ON CONFLICT (key) DO UPDATE` (re-running with an updated catalog re-syncs every column,
-- including flipping `sensitive`/`class` if the source catalog changes before the IAM-07a freeze).
-- Nothing here is destructive — no permission is ever deleted by this file, matching "additions are
-- additive-only" for a not-yet-frozen catalog.
ALTER TABLE permissions
  ADD COLUMN IF NOT EXISTS module_key text,       -- catalog "domain" (owning module, or 'core'/'portal' for non-module kinds — NOT a strict FK to a registered ModuleContract.key; see permission-catalog.md §3)
  ADD COLUMN IF NOT EXISTS resource text,          -- catalog "resource" segment of the dotted key
  ADD COLUMN IF NOT EXISTS action text,            -- catalog "action" segment of the dotted key (== cerbos_action always, N5)
  ADD COLUMN IF NOT EXISTS cerbos_kind text,       -- the real Cerbos resource kind this permission enforces (e.g. 'resource_search_property')
  ADD COLUMN IF NOT EXISTS cerbos_action text,     -- the real Cerbos action this permission enforces
  ADD COLUMN IF NOT EXISTS class text NOT NULL DEFAULT 'grantable',
  ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deprecated_at timestamptz;

COMMENT ON TABLE permissions IS
  'Global reference data (no tenant_id, no RLS) — the IAM permission catalog. Seeded from '
  'platform-nest/src/rbac/permission-catalog.json (IAM-01c, 0093). class=grantable rows are '
  'role-assignable via role_permissions; class=relationship rows are the 15 bypass-exempt pairs '
  '(Ruling 3) and the role_permissions_reject_relationship trigger below refuses to grant them.';

COMMENT ON COLUMN permissions.class IS
  'grantable (role-assignable, 215) | relationship (held by owning the resource or the MCP hub '
  'channel grant, never by any role — 15; see permissions_class_check + the guard trigger).';

DO $$
BEGIN
  ALTER TABLE permissions DROP CONSTRAINT IF EXISTS permissions_class_check;
  ALTER TABLE permissions
    ADD CONSTRAINT permissions_class_check CHECK (class IN ('grantable', 'relationship'));
END $$;

-- ── DB-level enforcement of Ruling 3 ("must NEVER be seeded as role-grantable") ──────────────────
-- Defense in depth beneath the app-layer IAM-01d boot check: even a direct INSERT into
-- role_permissions (future IAM-02a bundle seeding, an admin tool, a bad migration) cannot grant a
-- class='relationship' permission to any role. Fires on INSERT and UPDATE (an UPDATE could
-- otherwise repoint an existing grant's permission_id onto an exempt row).
CREATE OR REPLACE FUNCTION permissions_reject_relationship_grant() RETURNS trigger AS $fn$
DECLARE
  perm_class text;
  perm_key text;
BEGIN
  SELECT class, key INTO perm_class, perm_key FROM permissions WHERE id = NEW.permission_id;
  IF perm_class = 'relationship' THEN
    RAISE EXCEPTION
      'permission "%" is class=relationship (Ruling 3, bypass-exempt) and can never be granted to '
      'a role via role_permissions — it is held only by owning the resource or, for mcp_tool.call, '
      'by the MCP hub''s channel grant', perm_key;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS role_permissions_reject_relationship ON role_permissions;
CREATE TRIGGER role_permissions_reject_relationship
  BEFORE INSERT OR UPDATE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION permissions_reject_relationship_grant();

-- ── The seed: all 230 catalog entries, machine-generated from permission-catalog.json ────────────
-- (key, module_key/domain, resource, action, description, cerbos_kind, cerbos_action, class, sensitive)
-- `id` is a fresh gen_random_uuid() only on first insert (ON CONFLICT DO UPDATE never touches id, so
-- re-running this migration against a database that already has these rows is a pure metadata sync,
-- never a churn of primary keys anything else might have referenced).
INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive
FROM (VALUES
  ('agency.approval.approve', 'agency', 'approval', 'approve', 'Decide (approve/reject) an agency approval request.', 'agency_approval', 'approve', 'grantable', true),
  ('agency.approval.create', 'agency', 'approval', 'create', 'Create agency approval requests.', 'agency_approval', 'create', 'grantable', false),
  ('agency.approval.read', 'agency', 'approval', 'read', 'View agency approval requests.', 'agency_approval', 'read', 'grantable', false),
  ('agency.brief.create', 'agency', 'brief', 'create', 'Create agency campaign briefs.', 'agency_brief', 'create', 'grantable', false),
  ('agency.brief.delete', 'agency', 'brief', 'delete', 'Delete agency campaign briefs.', 'agency_brief', 'delete', 'grantable', false),
  ('agency.brief.read', 'agency', 'brief', 'read', 'View agency campaign briefs.', 'agency_brief', 'read', 'grantable', false),
  ('agency.brief.update', 'agency', 'brief', 'update', 'Edit agency campaign briefs.', 'agency_brief', 'update', 'grantable', false),
  ('agency.campaign.create', 'agency', 'campaign', 'create', 'Create agency marketing campaigns.', 'agency_campaign', 'create', 'grantable', false),
  ('agency.campaign.delete', 'agency', 'campaign', 'delete', 'Delete agency marketing campaigns.', 'agency_campaign', 'delete', 'grantable', false),
  ('agency.campaign.read', 'agency', 'campaign', 'read', 'View agency marketing campaigns.', 'agency_campaign', 'read', 'grantable', false),
  ('agency.campaign.update', 'agency', 'campaign', 'update', 'Edit agency marketing campaigns.', 'agency_campaign', 'update', 'grantable', false),
  ('agency.creative_asset.create', 'agency', 'creative_asset', 'create', 'Create agency creative assets.', 'agency_creative_asset', 'create', 'grantable', false),
  ('agency.creative_asset.delete', 'agency', 'creative_asset', 'delete', 'Delete agency creative assets.', 'agency_creative_asset', 'delete', 'grantable', false),
  ('agency.creative_asset.read', 'agency', 'creative_asset', 'read', 'View agency creative assets.', 'agency_creative_asset', 'read', 'grantable', false),
  ('agency.creative_asset.update', 'agency', 'creative_asset', 'update', 'Edit agency creative assets.', 'agency_creative_asset', 'update', 'grantable', false),
  ('assistant.agent_run.read', 'assistant', 'agent_run', 'read', 'Read an agent run you created via assistant handoff.', 'agent_run', 'read', 'relationship', false),
  ('assistant.memory.confirm', 'assistant', 'memory', 'confirm', 'Confirm a proposed entry in your own assistant memory.', 'assistant_memory', 'confirm', 'relationship', false),
  ('assistant.memory.delete', 'assistant', 'memory', 'delete', 'Delete an entry from your own assistant memory.', 'assistant_memory', 'delete', 'relationship', false),
  ('assistant.memory.list', 'assistant', 'memory', 'list', 'List your own assistant memory.', 'assistant_memory', 'list', 'relationship', false),
  ('assistant.memory.propose', 'assistant', 'memory', 'propose', 'Propose a new entry in your own assistant memory.', 'assistant_memory', 'propose', 'relationship', false),
  ('assistant.thread.confirm_write', 'assistant', 'thread', 'confirm_write', 'Confirm or dismiss a write proposed in your own thread.', 'assistant_thread', 'confirm_write', 'relationship', false),
  ('assistant.thread.create', 'assistant', 'thread', 'create', 'Create your own assistant chat thread.', 'assistant_thread', 'create', 'relationship', false),
  ('assistant.thread.delete', 'assistant', 'thread', 'delete', 'Delete your own assistant thread.', 'assistant_thread', 'delete', 'relationship', false),
  ('assistant.thread.handoff', 'assistant', 'thread', 'handoff', 'Hand your own thread''s task off to a specialist agent.', 'assistant_thread', 'handoff', 'relationship', false),
  ('assistant.thread.message', 'assistant', 'thread', 'message', 'Send a message in your own assistant thread.', 'assistant_thread', 'message', 'relationship', false),
  ('assistant.thread.read', 'assistant', 'thread', 'read', 'Read your own assistant thread and its transcript.', 'assistant_thread', 'read', 'relationship', false),
  ('assistant.thread.stop', 'assistant', 'thread', 'stop', 'Stop your own assistant thread''s in-flight response.', 'assistant_thread', 'stop', 'relationship', false),
  ('assistant.thread.stream', 'assistant', 'thread', 'stream', 'Stream your own assistant thread''s live response.', 'assistant_thread', 'stream', 'relationship', false),
  ('assistant.thread.update', 'assistant', 'thread', 'update', 'Rename/pin/archive your own assistant thread.', 'assistant_thread', 'update', 'relationship', false),
  ('billing.invoice.create', 'billing', 'invoice', 'create', 'Create client invoices.', 'invoice', 'create', 'grantable', true),
  ('billing.invoice.delete', 'billing', 'invoice', 'delete', 'Delete client invoices.', 'invoice', 'delete', 'grantable', true),
  ('billing.invoice.read', 'billing', 'invoice', 'read', 'View client invoices.', 'invoice', 'read', 'grantable', true),
  ('billing.invoice.update', 'billing', 'invoice', 'update', 'Edit an invoice / transition its status.', 'invoice', 'update', 'grantable', true),
  ('core.activity.read', 'core', 'activity', 'read', 'View tenant activity-feed entries.', 'activity', 'read', 'grantable', false),
  ('core.automation_approval.create', 'core', 'automation_approval', 'create', 'File an automation approval request.', 'automation_approval', 'create', 'grantable', false),
  ('core.automation_approval.decide', 'core', 'automation_approval', 'decide', 'Approve or reject an automation approval request; approval EXECUTES the registered action as the original principal (D14).', 'automation_approval', 'decide', 'grantable', true),
  ('core.automation_approval.read', 'core', 'automation_approval', 'read', 'View automation approval requests (D14 write gate).', 'automation_approval', 'read', 'grantable', false),
  ('core.automation_approval.retry', 'core', 'automation_approval', 'retry', 'Re-drive a failed approved automation action.', 'automation_approval', 'retry', 'grantable', true),
  ('core.chat_group.add_member', 'core', 'chat_group', 'add_member', 'Add a member to a bot-managed WhatsApp group.', 'chat_group', 'add_member', 'grantable', true),
  ('core.chat_group.pin', 'core', 'chat_group', 'pin', 'Pin a message in a bot-managed WhatsApp group.', 'chat_group', 'pin', 'grantable', false),
  ('core.chat_group.promote_member', 'core', 'chat_group', 'promote_member', 'Promote a member to admin in a bot-managed WhatsApp group.', 'chat_group', 'promote_member', 'grantable', true),
  ('core.chat_group.remove_member', 'core', 'chat_group', 'remove_member', 'Remove a member from a bot-managed WhatsApp group.', 'chat_group', 'remove_member', 'grantable', true),
  ('core.chat_group.set_subject', 'core', 'chat_group', 'set_subject', 'Change a bot-managed WhatsApp group''s subject line.', 'chat_group', 'set_subject', 'grantable', false),
  ('core.client_contact.create', 'core', 'client_contact', 'create', 'Create external client contacts (portal identities).', 'client_contact', 'create', 'grantable', true),
  ('core.client_contact.read', 'core', 'client_contact', 'read', 'View external client contacts (portal identities).', 'client_contact', 'read', 'grantable', false),
  ('core.client_contact.revoke', 'core', 'client_contact', 'revoke', 'Revoke an external client contact''s portal access.', 'client_contact', 'revoke', 'grantable', true),
  ('core.client_contact.update', 'core', 'client_contact', 'update', 'Edit external client contacts (portal identities).', 'client_contact', 'update', 'grantable', true),
  ('core.client.create', 'core', 'client', 'create', 'Create client records.', 'client', 'create', 'grantable', false),
  ('core.client.delete', 'core', 'client', 'delete', 'Delete client records.', 'client', 'delete', 'grantable', true),
  ('core.client.read', 'core', 'client', 'read', 'View client records.', 'client', 'read', 'grantable', false),
  ('core.client.update', 'core', 'client', 'update', 'Edit client records.', 'client', 'update', 'grantable', false),
  ('core.comment.create', 'core', 'comment', 'create', 'Create threaded comments.', 'comment', 'create', 'grantable', false),
  ('core.comment.read', 'core', 'comment', 'read', 'View threaded comments.', 'comment', 'read', 'grantable', false),
  ('core.company.delete', 'core', 'company', 'delete', 'Delete company (tenant) records.', 'company', 'delete', 'grantable', true),
  ('core.company.read', 'core', 'company', 'read', 'View company (tenant) records.', 'company', 'read', 'grantable', false),
  ('core.company.update', 'core', 'company', 'update', 'Edit company settings, including enabled modules.', 'company', 'update', 'grantable', true),
  ('core.compliance_gate.read', 'core', 'compliance_gate', 'read', 'View legal/compliance gates.', 'compliance_gate', 'read', 'grantable', false),
  ('core.compliance_gate.update', 'core', 'compliance_gate', 'update', 'Flip a legal/compliance gate for the tenant.', 'compliance_gate', 'update', 'grantable', true),
  ('core.contract.create', 'core', 'contract', 'create', 'Create client contracts.', 'contract', 'create', 'grantable', true),
  ('core.contract.delete', 'core', 'contract', 'delete', 'Delete client contracts.', 'contract', 'delete', 'grantable', true),
  ('core.contract.read', 'core', 'contract', 'read', 'View client contracts.', 'contract', 'read', 'grantable', true),
  ('core.contract.send', 'core', 'contract', 'send', 'Send a client contract for signature.', 'contract', 'send', 'grantable', true),
  ('core.contract.update', 'core', 'contract', 'update', 'Edit client contracts.', 'contract', 'update', 'grantable', true),
  ('core.custom_field.create', 'core', 'custom_field', 'create', 'Create custom-field definitions.', 'custom_field', 'create', 'grantable', false),
  ('core.custom_field.delete', 'core', 'custom_field', 'delete', 'Delete custom-field definitions.', 'custom_field', 'delete', 'grantable', false),
  ('core.custom_field.read', 'core', 'custom_field', 'read', 'View custom-field definitions.', 'custom_field', 'read', 'grantable', false),
  ('core.custom_field.update', 'core', 'custom_field', 'update', 'Edit custom-field definitions.', 'custom_field', 'update', 'grantable', false),
  ('core.deliverable.create', 'core', 'deliverable', 'create', 'Create client deliverables.', 'deliverable', 'create', 'grantable', false),
  ('core.deliverable.delete', 'core', 'deliverable', 'delete', 'Delete client deliverables.', 'deliverable', 'delete', 'grantable', false),
  ('core.deliverable.read', 'core', 'deliverable', 'read', 'View client deliverables.', 'deliverable', 'read', 'grantable', false),
  ('core.deliverable.update', 'core', 'deliverable', 'update', 'Edit client deliverables.', 'deliverable', 'update', 'grantable', false),
  ('core.file.create', 'core', 'file', 'create', 'Upload/attach files.', 'file', 'create', 'grantable', false),
  ('core.file.delete', 'core', 'file', 'delete', 'Delete files and attachments.', 'file', 'delete', 'grantable', false),
  ('core.file.read', 'core', 'file', 'read', 'View files and attachments.', 'file', 'read', 'grantable', false),
  ('core.identity_link.delete', 'core', 'identity_link', 'delete', 'Delete cross-channel identity links (WhatsApp/Telegram to platform user).', 'identity_link', 'delete', 'grantable', true),
  ('core.identity_link.read', 'core', 'identity_link', 'read', 'View identity links between chat identities and platform users.', 'identity_link', 'read', 'grantable', true),
  ('core.identity_link.update', 'core', 'identity_link', 'update', 'Edit cross-channel identity links (WhatsApp/Telegram to platform user).', 'identity_link', 'update', 'grantable', true),
  ('core.integration_connection.create', 'core', 'integration_connection', 'create', 'Create third-party integration connections (OAuth/API).', 'integration_connection', 'create', 'grantable', true),
  ('core.integration_connection.delete', 'core', 'integration_connection', 'delete', 'Delete third-party integration connections (OAuth/API).', 'integration_connection', 'delete', 'grantable', true),
  ('core.integration_connection.read', 'core', 'integration_connection', 'read', 'View third-party integration connections (OAuth/API).', 'integration_connection', 'read', 'grantable', false),
  ('core.integration_connection.update', 'core', 'integration_connection', 'update', 'Edit third-party integration connections (OAuth/API).', 'integration_connection', 'update', 'grantable', true),
  ('core.mcp_tool.call', 'core', 'mcp_tool', 'call', 'Invoke an MCP tool through the hub (channel-granted, never role-granted).', 'mcp_tool', 'call', 'relationship', false),
  ('core.meeting_recording.create', 'core', 'meeting_recording', 'create', 'Create meeting recordings.', 'meeting_recording', 'create', 'grantable', false),
  ('core.meeting_recording.ingest', 'core', 'meeting_recording', 'ingest', 'Submit captured meeting audio/video for transcription.', 'meeting_recording', 'ingest', 'grantable', false),
  ('core.meeting_recording.read', 'core', 'meeting_recording', 'read', 'View meeting recordings.', 'meeting_recording', 'read', 'grantable', false),
  ('core.meeting_recording.relink', 'core', 'meeting_recording', 'relink', 'Re-attach a recording to a different client/pipeline run.', 'meeting_recording', 'relink', 'grantable', true),
  ('core.meeting_recording.sync_drive', 'core', 'meeting_recording', 'sync_drive', 'Sync a meeting recording to the Shared Drive.', 'meeting_recording', 'sync_drive', 'grantable', false),
  ('core.meeting_recording.update', 'core', 'meeting_recording', 'update', 'Edit meeting recordings.', 'meeting_recording', 'update', 'grantable', false),
  ('core.member.read', 'core', 'member', 'read', 'List the company''s members.', 'member', 'read', 'grantable', false),
  ('core.notification.create', 'core', 'notification', 'create', 'Create notifications for users in the tenant.', 'notification', 'create', 'grantable', false),
  ('core.notification.read', 'core', 'notification', 'read', 'View per-user notifications.', 'notification', 'read', 'grantable', false),
  ('core.notification.update', 'core', 'notification', 'update', 'Edit per-user notifications.', 'notification', 'update', 'grantable', false),
  ('core.org_structure.read', 'core', 'org_structure', 'read', 'View the company org chart.', 'org_structure', 'read', 'grantable', false),
  ('core.org_structure.update', 'core', 'org_structure', 'update', 'Edit the company org chart (drives service/role reconciliation).', 'org_structure', 'update', 'grantable', true),
  ('core.pipeline_gate.create', 'core', 'pipeline_gate', 'create', 'Open an approval gate on a delivery-pipeline run.', 'pipeline_gate', 'create', 'grantable', false),
  ('core.pipeline_gate.decide', 'core', 'pipeline_gate', 'decide', 'Decide a delivery-pipeline gate (approve/reject progression).', 'pipeline_gate', 'decide', 'grantable', true),
  ('core.pipeline_gate.read', 'core', 'pipeline_gate', 'read', 'View delivery-pipeline approval gates.', 'pipeline_gate', 'read', 'grantable', false),
  ('core.pipeline_run.create', 'core', 'pipeline_run', 'create', 'Start a delivery-pipeline run.', 'pipeline_run', 'create', 'grantable', false),
  ('core.pipeline_run.read', 'core', 'pipeline_run', 'read', 'View delivery-pipeline runs (meeting-to-scope).', 'pipeline_run', 'read', 'grantable', false),
  ('core.pipeline_run.update', 'core', 'pipeline_run', 'update', 'Advance or edit a delivery-pipeline run.', 'pipeline_run', 'update', 'grantable', false),
  ('core.pipeline_stage.create', 'core', 'pipeline_stage', 'create', 'Create delivery-pipeline stages.', 'pipeline_stage', 'create', 'grantable', false),
  ('core.pipeline_stage.read', 'core', 'pipeline_stage', 'read', 'View delivery-pipeline stages.', 'pipeline_stage', 'read', 'grantable', false),
  ('core.pipeline_stage.update', 'core', 'pipeline_stage', 'update', 'Edit a delivery-pipeline stage (artifacts, status).', 'pipeline_stage', 'update', 'grantable', false),
  ('core.project.create', 'core', 'project', 'create', 'Create core projects.', 'project', 'create', 'grantable', false),
  ('core.project.delete', 'core', 'project', 'delete', 'Delete core projects.', 'project', 'delete', 'grantable', false),
  ('core.project.read', 'core', 'project', 'read', 'View core projects.', 'project', 'read', 'grantable', false),
  ('core.project.update', 'core', 'project', 'update', 'Edit core projects.', 'project', 'update', 'grantable', false),
  ('core.rollup_recompute.create', 'core', 'rollup_recompute', 'create', 'Trigger a rollup recompute for the tenant.', 'rollup_recompute', 'create', 'grantable', false),
  ('core.rollup.read', 'core', 'rollup', 'read', 'Read cross-company metric rollups (the only cross-company read path, D12).', 'rollup', 'read', 'grantable', true),
  ('core.scope_signoff.create', 'core', 'scope_signoff', 'create', 'Create a scope sign-off request for a client.', 'scope_signoff', 'create', 'grantable', false),
  ('core.scope_signoff.read', 'core', 'scope_signoff', 'read', 'View client scope sign-offs.', 'scope_signoff', 'read', 'grantable', false),
  ('core.service_assignment.accept', 'core', 'service_assignment', 'accept', 'Accept a proposed service assignment (activates cross-company access).', 'service_assignment', 'accept', 'grantable', true),
  ('core.service_assignment.propose', 'core', 'service_assignment', 'propose', 'Propose a cross-company service assignment.', 'service_assignment', 'propose', 'grantable', true),
  ('core.service_assignment.read', 'core', 'service_assignment', 'read', 'View cross-company service assignments.', 'service_assignment', 'read', 'grantable', false),
  ('core.service_assignment.reconcile', 'core', 'service_assignment', 'reconcile', 'Re-run the grant reconciler for service assignments.', 'service_assignment', 'reconcile', 'grantable', true),
  ('core.service_assignment.relink', 'core', 'service_assignment', 'relink', 'Re-link a service assignment to a different providing unit.', 'service_assignment', 'relink', 'grantable', true),
  ('core.service_assignment.resume', 'core', 'service_assignment', 'resume', 'Resume a suspended service assignment.', 'service_assignment', 'resume', 'grantable', true),
  ('core.service_assignment.revoke', 'core', 'service_assignment', 'revoke', 'Revoke a service assignment (tears down materialized grants).', 'service_assignment', 'revoke', 'grantable', true),
  ('core.service_assignment.suspend', 'core', 'service_assignment', 'suspend', 'Suspend a service assignment (suspends materialized grants).', 'service_assignment', 'suspend', 'grantable', true),
  ('core.task.create', 'core', 'task', 'create', 'Create core tasks.', 'task', 'create', 'grantable', false),
  ('core.task.delete', 'core', 'task', 'delete', 'Delete core tasks.', 'task', 'delete', 'grantable', false),
  ('core.task.read', 'core', 'task', 'read', 'View core tasks.', 'task', 'read', 'grantable', false),
  ('core.task.update', 'core', 'task', 'update', 'Edit core tasks.', 'task', 'update', 'grantable', false),
  ('core.team.create', 'core', 'team', 'create', 'Create teams.', 'team', 'create', 'grantable', false),
  ('core.team.delete', 'core', 'team', 'delete', 'Delete teams.', 'team', 'delete', 'grantable', false),
  ('core.team.read', 'core', 'team', 'read', 'View teams.', 'team', 'read', 'grantable', false),
  ('core.team.update', 'core', 'team', 'update', 'Edit a team and its membership (feeds team-scope coverage).', 'team', 'update', 'grantable', false),
  ('core.time_entry.create', 'core', 'time_entry', 'create', 'Create time entries.', 'time_entry', 'create', 'grantable', false),
  ('core.time_entry.delete', 'core', 'time_entry', 'delete', 'Delete time entries.', 'time_entry', 'delete', 'grantable', false),
  ('core.time_entry.read', 'core', 'time_entry', 'read', 'View time entries.', 'time_entry', 'read', 'grantable', false),
  ('core.time_entry.update', 'core', 'time_entry', 'update', 'Edit time entries.', 'time_entry', 'update', 'grantable', false),
  ('core.user.create', 'core', 'user', 'create', 'Create platform user accounts in the tenant.', 'user', 'create', 'grantable', true),
  ('core.user.delete', 'core', 'user', 'delete', 'Delete/deactivate platform user accounts.', 'user', 'delete', 'grantable', true),
  ('core.user.read', 'core', 'user', 'read', 'View platform user accounts.', 'user', 'read', 'grantable', false),
  ('core.user.update', 'core', 'user', 'update', 'Edit platform user accounts.', 'user', 'update', 'grantable', true),
  ('core.work_activity.create', 'core', 'work_activity', 'create', 'Ingest work-activity events (tracker writes).', 'work_activity', 'create', 'grantable', false),
  ('core.work_activity.read', 'core', 'work_activity', 'read', 'Read work-activity events.', 'work_activity', 'read', 'grantable', false),
  ('hr.case.cancel', 'hr', 'case', 'cancel', 'Cancel an HR case (policy also grants subjects self-cancel).', 'hr_case', 'cancel', 'grantable', true),
  ('hr.case.create', 'hr', 'case', 'create', 'Create HR cases (onboarding, leave, loans, grievances).', 'hr_case', 'create', 'grantable', true),
  ('hr.case.delete', 'hr', 'case', 'delete', 'Delete HR cases (onboarding, leave, loans, grievances).', 'hr_case', 'delete', 'grantable', true),
  ('hr.case.export', 'hr', 'case', 'export', 'Bulk-export HR cases (policy requires high assurance).', 'hr_case', 'export', 'grantable', true),
  ('hr.case.read', 'hr', 'case', 'read', 'View HR cases (onboarding, leave, loans, grievances).', 'hr_case', 'read', 'grantable', true),
  ('hr.case.update', 'hr', 'case', 'update', 'Edit HR cases (onboarding, leave, loans, grievances).', 'hr_case', 'update', 'grantable', true),
  ('hr.record.create', 'hr', 'record', 'create', 'Create HR records (contracts, documents, notes).', 'hr_record', 'create', 'grantable', true),
  ('hr.record.delete', 'hr', 'record', 'delete', 'Delete HR records (contracts, documents, notes).', 'hr_record', 'delete', 'grantable', true),
  ('hr.record.export', 'hr', 'record', 'export', 'Bulk-export HR records (policy requires high assurance).', 'hr_record', 'export', 'grantable', true),
  ('hr.record.read', 'hr', 'record', 'read', 'View HR records (contracts, documents, notes).', 'hr_record', 'read', 'grantable', true),
  ('hr.record.update', 'hr', 'record', 'update', 'Edit HR records (contracts, documents, notes).', 'hr_record', 'update', 'grantable', true),
  ('it.device.create', 'it', 'device', 'create', 'Register an IT device (also used by the discovery-report push path).', 'device', 'create', 'grantable', false),
  ('it.device.delete', 'it', 'device', 'delete', 'Delete IT device-registry entries.', 'device', 'delete', 'grantable', false),
  ('it.device.read', 'it', 'device', 'read', 'View IT device-registry entries.', 'device', 'read', 'grantable', false),
  ('it.device.update', 'it', 'device', 'update', 'Edit an IT device or ingest its heartbeat.', 'device', 'update', 'grantable', false),
  ('knowledge.source.read', 'knowledge', 'source', 'read', 'View knowledge/RAG sources.', 'knowledge_source', 'read', 'grantable', false),
  ('knowledge.source.update', 'knowledge', 'source', 'update', 'Approve, reject or edit a knowledge source (controls what enters the org-wide RAG).', 'knowledge_source', 'update', 'grantable', true),
  ('pm.project.manage', 'pm', 'project', 'manage', 'Manage PM projects (settings, milestones, structure).', 'pm_project', 'manage', 'grantable', false),
  ('pm.project.read', 'pm', 'project', 'read', 'View PM console projects.', 'pm_project', 'read', 'grantable', false),
  ('pm.task.create', 'pm', 'task', 'create', 'Create PM console tasks.', 'pm_task', 'create', 'grantable', false),
  ('pm.task.delete', 'pm', 'task', 'delete', 'Delete PM console tasks.', 'pm_task', 'delete', 'grantable', false),
  ('pm.task.manage', 'pm', 'task', 'manage', 'Assign and manage PM tasks, milestones and docs.', 'pm_task', 'manage', 'grantable', false),
  ('pm.task.read', 'pm', 'task', 'read', 'View PM console tasks.', 'pm_task', 'read', 'grantable', false),
  ('pm.task.update', 'pm', 'task', 'update', 'Edit PM console tasks.', 'pm_task', 'update', 'grantable', false),
  ('portal.decide', 'portal', 'portal', 'decide', 'Decide a gate exposed to the client in the portal.', 'portal', 'decide', 'grantable', true),
  ('portal.pay', 'portal', 'portal', 'pay', 'Initiate payment of an invoice in the client portal.', 'portal', 'pay', 'grantable', true),
  ('portal.read', 'portal', 'portal', 'read', 'Access the client portal workspace (client-facing surface).', 'portal', 'read', 'grantable', false),
  ('portal.request_change', 'portal', 'portal', 'request_change', 'File a website change request from the portal.', 'portal', 'request_change', 'grantable', false),
  ('portal.sign', 'portal', 'portal', 'sign', 'Sign a contract/scope document in the client portal.', 'portal', 'sign', 'grantable', true),
  ('portal.update_profile', 'portal', 'portal', 'update_profile', 'Update your own client-contact profile in the portal.', 'portal', 'update_profile', 'grantable', false),
  ('reports.admin.recompute', 'reports', 'admin', 'recompute', 'Trigger recomputation of report facts/rollups.', 'report_admin', 'recompute', 'grantable', false),
  ('reports.appraisal.ack', 'reports', 'appraisal', 'ack', 'Acknowledge your own finalized appraisal (subject action).', 'appraisal', 'ack', 'grantable', true),
  ('reports.appraisal.confirm_evidence', 'reports', 'appraisal', 'confirm_evidence', 'Confirm the evidence pack attached to an appraisal.', 'appraisal', 'confirm_evidence', 'grantable', true),
  ('reports.appraisal.cycle_admin', 'reports', 'appraisal', 'cycle_admin', 'Administer appraisal cycles (open, configure, close).', 'appraisal', 'cycle_admin', 'grantable', true),
  ('reports.appraisal.finalize', 'reports', 'appraisal', 'finalize', 'Finalize an appraisal, sealing its outcome.', 'appraisal', 'finalize', 'grantable', true),
  ('reports.appraisal.read', 'reports', 'appraisal', 'read', 'View employee performance appraisals.', 'appraisal', 'read', 'grantable', true),
  ('reports.appraisal.submit', 'reports', 'appraisal', 'submit', 'Submit an appraisal draft for the review chain.', 'appraisal', 'submit', 'grantable', true),
  ('reports.appraisal.write', 'reports', 'appraisal', 'write', 'Author or edit appraisal content for a subject in scope.', 'appraisal', 'write', 'grantable', true),
  ('reports.checkin.excuse', 'reports', 'checkin', 'excuse', 'Excuse a missed check-in (moves an appraisal-safe metric).', 'checkin', 'excuse', 'grantable', true),
  ('reports.checkin.missed_by_unit', 'reports', 'checkin', 'missed_by_unit', 'List missed check-ins grouped by org unit.', 'checkin', 'missed_by_unit', 'grantable', true),
  ('reports.checkin.pending_reminders', 'reports', 'checkin', 'pending_reminders', 'List pending check-in reminders for the tenant.', 'checkin', 'pending_reminders', 'grantable', true),
  ('reports.checkin.read', 'reports', 'checkin', 'read', 'Read employee check-ins (HR reader tier and management).', 'checkin', 'read', 'grantable', true),
  ('reports.checkin.submit', 'reports', 'checkin', 'submit', 'Submit your own work check-in (subject-self only in policy).', 'checkin', 'submit', 'grantable', false),
  ('reports.document.read_company', 'reports', 'document', 'read_company', 'Read company-grain report documents.', 'report_document', 'read_company', 'grantable', false),
  ('reports.document.read_department', 'reports', 'document', 'read_department', 'Read department-grain report documents.', 'report_document', 'read_department', 'grantable', false),
  ('reports.document.read_person', 'reports', 'document', 'read_person', 'Read person-grain report documents (individual performance data).', 'report_document', 'read_person', 'grantable', true),
  ('reports.document.read_project', 'reports', 'document', 'read_project', 'Read project-grain report documents.', 'report_document', 'read_project', 'grantable', false),
  ('reports.period.amend', 'reports', 'period', 'amend', 'Amend a sealed reporting period.', 'report_period', 'amend', 'grantable', true),
  ('reports.period.pin', 'reports', 'period', 'pin', 'Pin a reporting period.', 'report_period', 'pin', 'grantable', false),
  ('reports.period.seal', 'reports', 'period', 'seal', 'Seal a reporting period (freezes the record appraisals consume).', 'report_period', 'seal', 'grantable', true),
  ('reports.period.view', 'reports', 'period', 'view', 'View reporting periods.', 'report_period', 'view', 'grantable', false),
  ('search.audit.create', 'search', 'audit', 'create', 'Create SEO technical/content audits.', 'resource_search_audit', 'create', 'grantable', false),
  ('search.audit.delete', 'search', 'audit', 'delete', 'Delete SEO technical/content audits.', 'resource_search_audit', 'delete', 'grantable', false),
  ('search.audit.read', 'search', 'audit', 'read', 'View SEO technical/content audits.', 'resource_search_audit', 'read', 'grantable', false),
  ('search.audit.run', 'search', 'audit', 'run', 'Trigger a technical/CWV/content audit run.', 'resource_search_audit', 'run', 'grantable', false),
  ('search.audit.update', 'search', 'audit', 'update', 'Edit SEO technical/content audits.', 'resource_search_audit', 'update', 'grantable', false),
  ('search.campaign.apply_manual', 'search', 'campaign', 'apply_manual', 'Mark a manual-mode SEM change proposal as applied on the ad platform.', 'resource_search_campaign', 'apply_manual', 'grantable', true),
  ('search.campaign.apply_negatives', 'search', 'campaign', 'apply_negatives', 'Apply negative keywords to live SEM campaigns.', 'resource_search_campaign', 'apply_negatives', 'grantable', true),
  ('search.campaign.create', 'search', 'campaign', 'create', 'Create SEM campaigns (ads, ad groups, negatives).', 'resource_search_campaign', 'create', 'grantable', false),
  ('search.campaign.delete', 'search', 'campaign', 'delete', 'Delete SEM campaigns (ads, ad groups, negatives).', 'resource_search_campaign', 'delete', 'grantable', false),
  ('search.campaign.launch', 'search', 'campaign', 'launch', 'Execute an api-mode SEM change / launch on the live ad platform.', 'resource_search_campaign', 'launch', 'grantable', true),
  ('search.campaign.propose_change', 'search', 'campaign', 'propose_change', 'Draft a change proposal against a SEM campaign.', 'resource_search_campaign', 'propose_change', 'grantable', false),
  ('search.campaign.read', 'search', 'campaign', 'read', 'View SEM campaigns (ads, ad groups, negatives).', 'resource_search_campaign', 'read', 'grantable', false),
  ('search.campaign.set_budget', 'search', 'campaign', 'set_budget', 'Set/change live SEM campaign budgets (client ad spend).', 'resource_search_campaign', 'set_budget', 'grantable', true),
  ('search.campaign.update', 'search', 'campaign', 'update', 'Edit SEM campaigns (ads, ad groups, negatives).', 'resource_search_campaign', 'update', 'grantable', false),
  ('search.engagement.create', 'search', 'engagement', 'create', 'Create search-marketing engagements.', 'resource_search_engagement', 'create', 'grantable', false),
  ('search.engagement.delete', 'search', 'engagement', 'delete', 'Delete search-marketing engagements.', 'resource_search_engagement', 'delete', 'grantable', false),
  ('search.engagement.read', 'search', 'engagement', 'read', 'View search-marketing engagements.', 'resource_search_engagement', 'read', 'grantable', false),
  ('search.engagement.set_scope', 'search', 'engagement', 'set_scope', 'Set a search engagement''s commercial scope.', 'resource_search_engagement', 'set_scope', 'grantable', false),
  ('search.engagement.update', 'search', 'engagement', 'update', 'Edit search-marketing engagements.', 'resource_search_engagement', 'update', 'grantable', false),
  ('search.keyword.create', 'search', 'keyword', 'create', 'Create keyword sets and rank tracking.', 'resource_search_keyword', 'create', 'grantable', false),
  ('search.keyword.delete', 'search', 'keyword', 'delete', 'Delete keyword sets and rank tracking.', 'resource_search_keyword', 'delete', 'grantable', false),
  ('search.keyword.read', 'search', 'keyword', 'read', 'View keyword sets and rank tracking.', 'resource_search_keyword', 'read', 'grantable', false),
  ('search.keyword.research', 'search', 'keyword', 'research', 'Trigger keyword research / rank-and-metrics pulls (provider spend).', 'resource_search_keyword', 'research', 'grantable', false),
  ('search.keyword.update', 'search', 'keyword', 'update', 'Edit keyword sets and rank tracking.', 'resource_search_keyword', 'update', 'grantable', false),
  ('search.ledger.admin', 'search', 'ledger', 'admin', 'Override a provider budget stop-loss (elevated, audited).', 'resource_search_ledger', 'admin', 'grantable', true),
  ('search.ledger.read', 'search', 'ledger', 'read', 'View the provider usage/cost ledger.', 'resource_search_ledger', 'read', 'grantable', false),
  ('search.property.create', 'search', 'property', 'create', 'Create search properties (sites, GSC bindings, content briefs).', 'resource_search_property', 'create', 'grantable', false),
  ('search.property.delete', 'search', 'property', 'delete', 'Delete search properties (sites, GSC bindings, content briefs).', 'resource_search_property', 'delete', 'grantable', false),
  ('search.property.read', 'search', 'property', 'read', 'View search properties (sites, GSC bindings, content briefs).', 'resource_search_property', 'read', 'grantable', false),
  ('search.property.update', 'search', 'property', 'update', 'Edit search properties (sites, GSC bindings, content briefs).', 'resource_search_property', 'update', 'grantable', false),
  ('search.report.approve', 'search', 'report', 'approve', 'Approve an engagement report (delivery gate).', 'resource_search_report', 'approve', 'grantable', true),
  ('search.report.create', 'search', 'report', 'create', 'Create search engagement reports.', 'resource_search_report', 'create', 'grantable', false),
  ('search.report.delete', 'search', 'report', 'delete', 'Delete search engagement reports.', 'resource_search_report', 'delete', 'grantable', false),
  ('search.report.deliver', 'search', 'report', 'deliver', 'Deliver an approved engagement report to the client.', 'resource_search_report', 'deliver', 'grantable', true),
  ('search.report.read', 'search', 'report', 'read', 'View search engagement reports.', 'resource_search_report', 'read', 'grantable', false),
  ('search.report.update', 'search', 'report', 'update', 'Edit search engagement reports.', 'resource_search_report', 'update', 'grantable', false),
  ('webdev.change_request.create', 'webdev', 'change_request', 'create', 'Create website change requests.', 'webdev_change_request', 'create', 'grantable', false),
  ('webdev.change_request.read', 'webdev', 'change_request', 'read', 'View website change requests.', 'webdev_change_request', 'read', 'grantable', false),
  ('webdev.change_request.triage', 'webdev', 'change_request', 'triage', 'Triage a website change request (accept/route/reject).', 'webdev_change_request', 'triage', 'grantable', false),
  ('webdev.provisioned_site.provision', 'webdev', 'provisioned_site', 'provision', 'Provision a client site: create the real repo + hosting for a delivery run.', 'webdev_provisioned_site', 'provision', 'grantable', true),
  ('webdev.provisioned_site.read', 'webdev', 'provisioned_site', 'read', 'View provisioned client sites (repo + hosting).', 'webdev_provisioned_site', 'read', 'grantable', false),
  ('webdev.provisioned_site.reconcile', 'webdev', 'provisioned_site', 'reconcile', 'Re-poll a provisioned site''s provisioning state.', 'webdev_provisioned_site', 'reconcile', 'grantable', false)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive)
ON CONFLICT (key) DO UPDATE SET
  module_key = EXCLUDED.module_key,
  resource = EXCLUDED.resource,
  action = EXCLUDED.action,
  description = EXCLUDED.description,
  cerbos_kind = EXCLUDED.cerbos_kind,
  cerbos_action = EXCLUDED.cerbos_action,
  class = EXCLUDED.class,
  sensitive = EXCLUDED.sensitive;

-- ── Assert, don't assume (ticket requirement) ────────────────────────────────────────────────────
-- The RLS backfill trap (silent zero-row match) cannot occur here (see the header), but "the INSERT
-- ran without error" is still not proof it wrote what the source catalog says it should have —
-- confirm the exact post-seed shape instead of trusting the statement's own silence.
DO $$
DECLARE
  n_total integer;
  n_grantable integer;
  n_relationship integer;
  n_sensitive integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE class = 'grantable'), count(*) FILTER (WHERE class = 'relationship'),
         count(*) FILTER (WHERE sensitive)
    INTO n_total, n_grantable, n_relationship, n_sensitive
    FROM permissions
   WHERE key LIKE '%.%'; -- every catalog key is dotted; excludes any stray legacy colon-style row
  IF n_total <> 230 THEN
    RAISE EXCEPTION 'IAM-01c seed assertion FAILED: expected exactly 230 catalog permission rows, found %', n_total;
  END IF;
  IF n_grantable <> 215 THEN
    RAISE EXCEPTION 'IAM-01c seed assertion FAILED: expected exactly 215 class=grantable rows, found %', n_grantable;
  END IF;
  IF n_relationship <> 15 THEN
    RAISE EXCEPTION 'IAM-01c seed assertion FAILED: expected exactly 15 class=relationship rows, found %', n_relationship;
  END IF;
  IF n_sensitive <> 79 THEN
    RAISE EXCEPTION 'IAM-01c seed assertion FAILED: expected exactly 79 sensitive=true rows, found %', n_sensitive;
  END IF;
  RAISE NOTICE 'IAM-01c: permissions catalog seeded — % total (% grantable, % relationship, % sensitive)',
    n_total, n_grantable, n_relationship, n_sensitive;
END $$;
