# Permission catalog — the canonical contract (IAM-01b)

**Status:** PROTOTYPED — 2026-08-10. Catalog derived from source and machine-verified against a
fresh, independent re-parse of every Cerbos policy. It becomes FROZEN at IAM-07a after owner
review; until then additions are possible, renames are cheap. **After the freeze, additions are
additive-only and removals need an owner decision.**

**Machine-readable catalog:** `platform-nest/src/rbac/permission-catalog.json` (230 entries:
215 `grantable` + 15 `relationship`). That file and this doc are generated from the same parse —
they cannot disagree as of this date; IAM-07b's drift test takes over from there.

**Parents:** `2026-08-10-iam-phase1-tickets.md` (IAM-01b) ·
`2026-08-10-iam-01a-02a-analysis.md` §6 (Rulings 1–3, owner-decided 2026-08-10) ·
`2026-08-10-identity-rbac-program.md` (D-1..D-11).

---

## 1. Re-derived surface — independent verification, 2026-08-10

Per the ticket instruction, every number was re-derived from
`platform-nest/cerbos/policies/resource_*.yaml` with a real YAML parse (js-yaml) and full
wildcard expansion, **not** copied from the earlier analysis. Result: **every number agrees**
with the measured facts in the phase-1 ticket doc.

| Fact | Ticket claim | Re-derived | Agree |
|---|---|---|---|
| Resource policy files / distinct kinds | 61 | 61 / 61 (no duplicate `resource:` fields) | YES |
| Raw `(kind, action)` pairs incl. `*` | 286 | 286 | YES |
| Concrete pairs after wildcard expansion | 230 | 230 | YES |
| Kinds carrying a `*` wildcard rule | 56 of 61 | 56 | YES |
| `platform_admin` reach | 215 / 230, 57 kinds | 215 pairs / 57 kinds | YES |
| The 15 pairs superadmin cannot reach | 9 + 4 + 1 + 1 | exactly the same 15 (§5) | YES |
| `EFFECT_DENY` rules anywhere | — | **0** | n/a |

Role-reach cross-checks also reproduce the analysis doc exactly: `company_admin` 199/55,
`group_executive` 118/35, `manager` 109/41, `member` 74, `team_lead` 60, `module_manager` 56,
`module_staff` 34, `viewer` 30, `client` 6, `it_staff` 3, `hr_people_ops` 5, `hr_people_reader` 5,
`module_approver` 1.

**Boundary well-definedness check (new):** zero pairs are reachable by any *other* derived role
but not by `platform_admin`. So "role-grantable = what superadmin reaches" is a clean boundary,
not an approximation — nothing falls between the two classes.

**The five kinds with no `*` wildcard rule:** `assistant_thread`, `assistant_memory`, `agent_run`,
`mcp_tool` (the four exempt kinds, §5) — and **`rollup`**. `rollup` is not exempt: its single
action `read` is granted unconditionally to `platform_admin` + `group_executive` and nothing else
(`resource_rollup.yaml` — the whole policy IS the elevated grant; D12's only cross-company read
path). `core.rollup.read` is therefore role-grantable and in the catalog. Note for IAM-02a: after
D-7 removes `group_executive`, `rollup.read`'s only holder is superadmin until bundles re-grant it
deliberately.

## 2. Key format and normalization (Ruling 2, applied)

Format: **`<domain>.<resource>.<action>`**, dotted, exactly three segments; segments may contain
underscores (`webdev.change_request.triage`, `reports.document.read_person`).

Normalization rules (the kind → `(domain, resource)` map is injective — no two kinds collide):

| Rule | Applies to | Example |
|---|---|---|
| N1 | Module-prefixed kinds strip the module prefix | `hr_case` → `hr.case`, `pm_task` → `pm.task`, `agency_creative_asset` → `agency.creative_asset`, `webdev_provisioned_site` → `webdev.provisioned_site` |
| N2 | The six-plus-one `resource_search_*` kinds normalize the redundant kind prefix away; **the mapping table carries the real kind** | key `search.property.update` ↔ Cerbos `(resource_search_property, update)` |
| N3 | `report_*` kinds strip `report_` under the `reports` domain | `report_document` → `reports.document`, `report_period` → `reports.period`, `report_admin` → `reports.admin` |
| N4 | Non-module (core) kinds keep the kind verbatim as the resource | `client_contact` → `core.client_contact`, `automation_approval` → `core.automation_approval` |
| N5 | **Actions are never renamed** — `cerbosAction` == `action` for all 230 entries | `read_person`, `apply_manual`, `confirm_write` pass through untouched |

Consequence of N5: the catalog↔Cerbos mapping is mechanical in the action dimension; all naming
judgement is confined to the kind dimension, where `cerbosKind` records the truth.

## 3. Domain attribution — all 61 kinds

Attribution rule applied (in priority order): a kind is **module-owned** if (a) its kind name
carries a module key prefix, or (b) its `authorize()` call sites live in that module's
controllers, or (c) the module declares matching permissions in its `ModuleContract`. Otherwise
**core**. Evidence = every `authorize(req.principal, { kind: ... })` call site in
`platform-nest/src` (non-test), enumerated 2026-08-10.

| Domain | Kinds | Grantable perms |
|---|---|---|
| `core` | 31 grantable kinds + `mcp_tool` (exempt) | **103** |
| `agency` | agency_approval, agency_brief, agency_campaign, agency_creative_asset | 15 |
| `assistant` | assistant_thread, assistant_memory, agent_run — **all exempt** | 0 (15 relationship) |
| `billing` | invoice | 4 |
| `hr` | hr_case, hr_record | 11 |
| `it` | device | 4 |
| `knowledge` | knowledge_source | 2 |
| `pm` | pm_task, pm_project | 7 |
| `portal` | portal | 6 |
| `reports` | appraisal, checkin, report_admin, report_document, report_period | 21 |
| `search` | resource_search_{audit,campaign,engagement,keyword,ledger,property,report} | 36 |
| `webdev` | webdev_change_request, webdev_provisioned_site | 6 |

The 31 grantable core kinds: activity, automation_approval, chat_group, client, client_contact,
comment, company, compliance_gate, contract, custom_field, deliverable, file, identity_link,
integration_connection, meeting_recording, member, notification, org_structure, pipeline_gate,
pipeline_run, pipeline_stage, project, rollup, rollup_recompute, scope_signoff,
service_assignment, task, team, time_entry, user, work_activity.

> **Correction to the program doc:** the ruling estimated "~20 non-module kinds". The measured
> count is **33** (32 grantable + mcp_tool) before the DR-4 amendment split `portal` into its own
> domain; **core now carries 31 grantable kinds + mcp_tool (32 total)**, with `portal` a
> one-kind, 6-permission domain of its own (owner decision, §8 J2). The estimate was low; the
> rule itself holds.

Attribution calls that were NOT mechanical are flagged in §8 (J1–J8) — read them before treating
any domain as settled.

## 4. The catalog — 215 role-grantable permissions

Grouped by domain. **Sensitive** = drives step-up auth + D-10 approval routing later (§6 rubric).
The `Cerbos kind / action` columns ARE the complete mapping table `permission ↔ (kind, action)`;
`permission-catalog.json` carries the identical mapping machine-readably.

### `core` — 103 permissions

| Permission key | Cerbos kind | Cerbos action | Sensitive | Description |
|---|---|---|---|---|
| `core.activity.read` | `activity` | `read` |  | View tenant activity-feed entries. |
| `core.automation_approval.create` | `automation_approval` | `create` |  | File an automation approval request. |
| `core.automation_approval.decide` | `automation_approval` | `decide` | **YES** | Approve or reject an automation approval request; approval EXECUTES the registered action as the original principal (D14). |
| `core.automation_approval.read` | `automation_approval` | `read` |  | View automation approval requests (D14 write gate). |
| `core.automation_approval.retry` | `automation_approval` | `retry` | **YES** | Re-drive a failed approved automation action. |
| `core.chat_group.add_member` | `chat_group` | `add_member` | **YES** | Add a member to a bot-managed WhatsApp group. |
| `core.chat_group.pin` | `chat_group` | `pin` |  | Pin a message in a bot-managed WhatsApp group. |
| `core.chat_group.promote_member` | `chat_group` | `promote_member` | **YES** | Promote a member to admin in a bot-managed WhatsApp group. |
| `core.chat_group.remove_member` | `chat_group` | `remove_member` | **YES** | Remove a member from a bot-managed WhatsApp group. |
| `core.chat_group.set_subject` | `chat_group` | `set_subject` |  | Change a bot-managed WhatsApp group's subject line. |
| `core.client.create` | `client` | `create` |  | Create client records. |
| `core.client.delete` | `client` | `delete` | **YES** | Delete client records. |
| `core.client.read` | `client` | `read` |  | View client records. |
| `core.client.update` | `client` | `update` |  | Edit client records. |
| `core.client_contact.create` | `client_contact` | `create` | **YES** | Create external client contacts (portal identities). |
| `core.client_contact.read` | `client_contact` | `read` |  | View external client contacts (portal identities). |
| `core.client_contact.revoke` | `client_contact` | `revoke` | **YES** | Revoke an external client contact's portal access. |
| `core.client_contact.update` | `client_contact` | `update` | **YES** | Edit external client contacts (portal identities). |
| `core.comment.create` | `comment` | `create` |  | Create threaded comments. |
| `core.comment.read` | `comment` | `read` |  | View threaded comments. |
| `core.company.delete` | `company` | `delete` | **YES** | Delete company (tenant) records. |
| `core.company.read` | `company` | `read` |  | View company (tenant) records. |
| `core.company.update` | `company` | `update` | **YES** | Edit company settings, including enabled modules. |
| `core.compliance_gate.read` | `compliance_gate` | `read` |  | View legal/compliance gates. |
| `core.compliance_gate.update` | `compliance_gate` | `update` | **YES** | Flip a legal/compliance gate for the tenant. |
| `core.contract.create` | `contract` | `create` | **YES** | Create client contracts. |
| `core.contract.delete` | `contract` | `delete` | **YES** | Delete client contracts. |
| `core.contract.read` | `contract` | `read` | **YES** | View client contracts. |
| `core.contract.send` | `contract` | `send` | **YES** | Send a client contract for signature. |
| `core.contract.update` | `contract` | `update` | **YES** | Edit client contracts. |
| `core.custom_field.create` | `custom_field` | `create` |  | Create custom-field definitions. |
| `core.custom_field.delete` | `custom_field` | `delete` |  | Delete custom-field definitions. |
| `core.custom_field.read` | `custom_field` | `read` |  | View custom-field definitions. |
| `core.custom_field.update` | `custom_field` | `update` |  | Edit custom-field definitions. |
| `core.deliverable.create` | `deliverable` | `create` |  | Create client deliverables. |
| `core.deliverable.delete` | `deliverable` | `delete` |  | Delete client deliverables. |
| `core.deliverable.read` | `deliverable` | `read` |  | View client deliverables. |
| `core.deliverable.update` | `deliverable` | `update` |  | Edit client deliverables. |
| `core.file.create` | `file` | `create` |  | Upload/attach files. |
| `core.file.delete` | `file` | `delete` |  | Delete files and attachments. |
| `core.file.read` | `file` | `read` |  | View files and attachments. |
| `core.identity_link.delete` | `identity_link` | `delete` | **YES** | Delete cross-channel identity links (WhatsApp/Telegram to platform user). |
| `core.identity_link.read` | `identity_link` | `read` | **YES** | View identity links between chat identities and platform users. |
| `core.identity_link.update` | `identity_link` | `update` | **YES** | Edit cross-channel identity links (WhatsApp/Telegram to platform user). |
| `core.integration_connection.create` | `integration_connection` | `create` | **YES** | Create third-party integration connections (OAuth/API). |
| `core.integration_connection.delete` | `integration_connection` | `delete` | **YES** | Delete third-party integration connections (OAuth/API). |
| `core.integration_connection.read` | `integration_connection` | `read` |  | View third-party integration connections (OAuth/API). |
| `core.integration_connection.update` | `integration_connection` | `update` | **YES** | Edit third-party integration connections (OAuth/API). |
| `core.meeting_recording.create` | `meeting_recording` | `create` |  | Create meeting recordings. |
| `core.meeting_recording.ingest` | `meeting_recording` | `ingest` |  | Submit captured meeting audio/video for transcription. |
| `core.meeting_recording.read` | `meeting_recording` | `read` |  | View meeting recordings. |
| `core.meeting_recording.relink` | `meeting_recording` | `relink` | **YES** | Re-attach a recording to a different client/pipeline run. |
| `core.meeting_recording.sync_drive` | `meeting_recording` | `sync_drive` |  | Sync a meeting recording to the Shared Drive. |
| `core.meeting_recording.update` | `meeting_recording` | `update` |  | Edit meeting recordings. |
| `core.member.read` | `member` | `read` |  | List the company's members. |
| `core.notification.create` | `notification` | `create` |  | Create notifications for users in the tenant. |
| `core.notification.read` | `notification` | `read` |  | View per-user notifications. |
| `core.notification.update` | `notification` | `update` |  | Edit per-user notifications. |
| `core.org_structure.read` | `org_structure` | `read` |  | View the company org chart. |
| `core.org_structure.update` | `org_structure` | `update` | **YES** | Edit the company org chart (drives service/role reconciliation). |
| `core.pipeline_gate.create` | `pipeline_gate` | `create` |  | Open an approval gate on a delivery-pipeline run. |
| `core.pipeline_gate.decide` | `pipeline_gate` | `decide` | **YES** | Decide a delivery-pipeline gate (approve/reject progression). |
| `core.pipeline_gate.read` | `pipeline_gate` | `read` |  | View delivery-pipeline approval gates. |
| `core.pipeline_run.create` | `pipeline_run` | `create` |  | Start a delivery-pipeline run. |
| `core.pipeline_run.read` | `pipeline_run` | `read` |  | View delivery-pipeline runs (meeting-to-scope). |
| `core.pipeline_run.update` | `pipeline_run` | `update` |  | Advance or edit a delivery-pipeline run. |
| `core.pipeline_stage.create` | `pipeline_stage` | `create` |  | Create delivery-pipeline stages. |
| `core.pipeline_stage.read` | `pipeline_stage` | `read` |  | View delivery-pipeline stages. |
| `core.pipeline_stage.update` | `pipeline_stage` | `update` |  | Edit a delivery-pipeline stage (artifacts, status). |
| `core.project.create` | `project` | `create` |  | Create core projects. |
| `core.project.delete` | `project` | `delete` |  | Delete core projects. |
| `core.project.read` | `project` | `read` |  | View core projects. |
| `core.project.update` | `project` | `update` |  | Edit core projects. |
| `core.rollup.read` | `rollup` | `read` | **YES** | Read cross-company metric rollups (the only cross-company read path, D12). |
| `core.rollup_recompute.create` | `rollup_recompute` | `create` |  | Trigger a rollup recompute for the tenant. |
| `core.scope_signoff.create` | `scope_signoff` | `create` |  | Create a scope sign-off request for a client. |
| `core.scope_signoff.read` | `scope_signoff` | `read` |  | View client scope sign-offs. |
| `core.service_assignment.accept` | `service_assignment` | `accept` | **YES** | Accept a proposed service assignment (activates cross-company access). |
| `core.service_assignment.propose` | `service_assignment` | `propose` | **YES** | Propose a cross-company service assignment. |
| `core.service_assignment.read` | `service_assignment` | `read` |  | View cross-company service assignments. |
| `core.service_assignment.reconcile` | `service_assignment` | `reconcile` | **YES** | Re-run the grant reconciler for service assignments. |
| `core.service_assignment.relink` | `service_assignment` | `relink` | **YES** | Re-link a service assignment to a different providing unit. |
| `core.service_assignment.resume` | `service_assignment` | `resume` | **YES** | Resume a suspended service assignment. |
| `core.service_assignment.revoke` | `service_assignment` | `revoke` | **YES** | Revoke a service assignment (tears down materialized grants). |
| `core.service_assignment.suspend` | `service_assignment` | `suspend` | **YES** | Suspend a service assignment (suspends materialized grants). |
| `core.task.create` | `task` | `create` |  | Create core tasks. |
| `core.task.delete` | `task` | `delete` |  | Delete core tasks. |
| `core.task.read` | `task` | `read` |  | View core tasks. |
| `core.task.update` | `task` | `update` |  | Edit core tasks. |
| `core.team.create` | `team` | `create` |  | Create teams. |
| `core.team.delete` | `team` | `delete` |  | Delete teams. |
| `core.team.read` | `team` | `read` |  | View teams. |
| `core.team.update` | `team` | `update` |  | Edit a team and its membership (feeds team-scope coverage). |
| `core.time_entry.create` | `time_entry` | `create` |  | Create time entries. |
| `core.time_entry.delete` | `time_entry` | `delete` |  | Delete time entries. |
| `core.time_entry.read` | `time_entry` | `read` |  | View time entries. |
| `core.time_entry.update` | `time_entry` | `update` |  | Edit time entries. |
| `core.user.create` | `user` | `create` | **YES** | Create platform user accounts in the tenant. |
| `core.user.delete` | `user` | `delete` | **YES** | Delete/deactivate platform user accounts. |
| `core.user.read` | `user` | `read` |  | View platform user accounts. |
| `core.user.update` | `user` | `update` | **YES** | Edit platform user accounts. |
| `core.work_activity.create` | `work_activity` | `create` |  | Ingest work-activity events (tracker writes). |
| `core.work_activity.read` | `work_activity` | `read` |  | Read work-activity events. |

### `agency` — 15 permissions

| Permission key | Cerbos kind | Cerbos action | Sensitive | Description |
|---|---|---|---|---|
| `agency.approval.approve` | `agency_approval` | `approve` | **YES** | Decide (approve/reject) an agency approval request. |
| `agency.approval.create` | `agency_approval` | `create` |  | Create agency approval requests. |
| `agency.approval.read` | `agency_approval` | `read` |  | View agency approval requests. |
| `agency.brief.create` | `agency_brief` | `create` |  | Create agency campaign briefs. |
| `agency.brief.delete` | `agency_brief` | `delete` |  | Delete agency campaign briefs. |
| `agency.brief.read` | `agency_brief` | `read` |  | View agency campaign briefs. |
| `agency.brief.update` | `agency_brief` | `update` |  | Edit agency campaign briefs. |
| `agency.campaign.create` | `agency_campaign` | `create` |  | Create agency marketing campaigns. |
| `agency.campaign.delete` | `agency_campaign` | `delete` |  | Delete agency marketing campaigns. |
| `agency.campaign.read` | `agency_campaign` | `read` |  | View agency marketing campaigns. |
| `agency.campaign.update` | `agency_campaign` | `update` |  | Edit agency marketing campaigns. |
| `agency.creative_asset.create` | `agency_creative_asset` | `create` |  | Create agency creative assets. |
| `agency.creative_asset.delete` | `agency_creative_asset` | `delete` |  | Delete agency creative assets. |
| `agency.creative_asset.read` | `agency_creative_asset` | `read` |  | View agency creative assets. |
| `agency.creative_asset.update` | `agency_creative_asset` | `update` |  | Edit agency creative assets. |

### `billing` — 4 permissions

| Permission key | Cerbos kind | Cerbos action | Sensitive | Description |
|---|---|---|---|---|
| `billing.invoice.create` | `invoice` | `create` | **YES** | Create client invoices. |
| `billing.invoice.delete` | `invoice` | `delete` | **YES** | Delete client invoices. |
| `billing.invoice.read` | `invoice` | `read` | **YES** | View client invoices. |
| `billing.invoice.update` | `invoice` | `update` | **YES** | Edit an invoice / transition its status. |

### `hr` — 11 permissions

| Permission key | Cerbos kind | Cerbos action | Sensitive | Description |
|---|---|---|---|---|
| `hr.case.cancel` | `hr_case` | `cancel` | **YES** | Cancel an HR case (policy also grants subjects self-cancel). |
| `hr.case.create` | `hr_case` | `create` | **YES** | Create HR cases (onboarding, leave, loans, grievances). |
| `hr.case.delete` | `hr_case` | `delete` | **YES** | Delete HR cases (onboarding, leave, loans, grievances). |
| `hr.case.export` | `hr_case` | `export` | **YES** | Bulk-export HR cases (policy requires high assurance). |
| `hr.case.read` | `hr_case` | `read` | **YES** | View HR cases (onboarding, leave, loans, grievances). |
| `hr.case.update` | `hr_case` | `update` | **YES** | Edit HR cases (onboarding, leave, loans, grievances). |
| `hr.record.create` | `hr_record` | `create` | **YES** | Create HR records (contracts, documents, notes). |
| `hr.record.delete` | `hr_record` | `delete` | **YES** | Delete HR records (contracts, documents, notes). |
| `hr.record.export` | `hr_record` | `export` | **YES** | Bulk-export HR records (policy requires high assurance). |
| `hr.record.read` | `hr_record` | `read` | **YES** | View HR records (contracts, documents, notes). |
| `hr.record.update` | `hr_record` | `update` | **YES** | Edit HR records (contracts, documents, notes). |

### `it` — 4 permissions

| Permission key | Cerbos kind | Cerbos action | Sensitive | Description |
|---|---|---|---|---|
| `it.device.create` | `device` | `create` |  | Register an IT device (also used by the discovery-report push path). |
| `it.device.delete` | `device` | `delete` |  | Delete IT device-registry entries. |
| `it.device.read` | `device` | `read` |  | View IT device-registry entries. |
| `it.device.update` | `device` | `update` |  | Edit an IT device or ingest its heartbeat. |

### `knowledge` — 2 permissions

| Permission key | Cerbos kind | Cerbos action | Sensitive | Description |
|---|---|---|---|---|
| `knowledge.source.read` | `knowledge_source` | `read` |  | View knowledge/RAG sources. |
| `knowledge.source.update` | `knowledge_source` | `update` | **YES** | Approve, reject or edit a knowledge source (controls what enters the org-wide RAG). |

### `pm` — 7 permissions

| Permission key | Cerbos kind | Cerbos action | Sensitive | Description |
|---|---|---|---|---|
| `pm.project.manage` | `pm_project` | `manage` |  | Manage PM projects (settings, milestones, structure). |
| `pm.project.read` | `pm_project` | `read` |  | View PM console projects. |
| `pm.task.create` | `pm_task` | `create` |  | Create PM console tasks. |
| `pm.task.delete` | `pm_task` | `delete` |  | Delete PM console tasks. |
| `pm.task.manage` | `pm_task` | `manage` |  | Assign and manage PM tasks, milestones and docs. |
| `pm.task.read` | `pm_task` | `read` |  | View PM console tasks. |
| `pm.task.update` | `pm_task` | `update` |  | Edit PM console tasks. |

### `portal` — 6 permissions

Owner decision DR-4 (2026-08-10): the client portal is a separate trust surface with its own
route group and shell, so it gets its own top-level domain rather than folding into `core`. See
§8 J2. The Cerbos kind (`portal`) and `cerbosKind`/`cerbosAction` mapping are unchanged — only
the catalog key and `domain` field moved.

| Permission key | Cerbos kind | Cerbos action | Sensitive | Description |
|---|---|---|---|---|
| `portal.decide` | `portal` | `decide` | **YES** | Decide a gate exposed to the client in the portal. |
| `portal.pay` | `portal` | `pay` | **YES** | Initiate payment of an invoice in the client portal. |
| `portal.read` | `portal` | `read` |  | Access the client portal workspace (client-facing surface). |
| `portal.request_change` | `portal` | `request_change` |  | File a website change request from the portal. |
| `portal.sign` | `portal` | `sign` | **YES** | Sign a contract/scope document in the client portal. |
| `portal.update_profile` | `portal` | `update_profile` |  | Update your own client-contact profile in the portal. |

### `reports` — 21 permissions

| Permission key | Cerbos kind | Cerbos action | Sensitive | Description |
|---|---|---|---|---|
| `reports.admin.recompute` | `report_admin` | `recompute` |  | Trigger recomputation of report facts/rollups. |
| `reports.appraisal.ack` | `appraisal` | `ack` | **YES** | Acknowledge your own finalized appraisal (subject action). |
| `reports.appraisal.confirm_evidence` | `appraisal` | `confirm_evidence` | **YES** | Confirm the evidence pack attached to an appraisal. |
| `reports.appraisal.cycle_admin` | `appraisal` | `cycle_admin` | **YES** | Administer appraisal cycles (open, configure, close). |
| `reports.appraisal.finalize` | `appraisal` | `finalize` | **YES** | Finalize an appraisal, sealing its outcome. |
| `reports.appraisal.read` | `appraisal` | `read` | **YES** | View employee performance appraisals. |
| `reports.appraisal.submit` | `appraisal` | `submit` | **YES** | Submit an appraisal draft for the review chain. |
| `reports.appraisal.write` | `appraisal` | `write` | **YES** | Author or edit appraisal content for a subject in scope. |
| `reports.checkin.excuse` | `checkin` | `excuse` | **YES** | Excuse a missed check-in (moves an appraisal-safe metric). |
| `reports.checkin.missed_by_unit` | `checkin` | `missed_by_unit` | **YES** | List missed check-ins grouped by org unit. |
| `reports.checkin.pending_reminders` | `checkin` | `pending_reminders` | **YES** | List pending check-in reminders for the tenant. |
| `reports.checkin.read` | `checkin` | `read` | **YES** | Read employee check-ins (HR reader tier and management). |
| `reports.checkin.submit` | `checkin` | `submit` |  | Submit your own work check-in (subject-self only in policy). |
| `reports.document.read_company` | `report_document` | `read_company` |  | Read company-grain report documents. |
| `reports.document.read_department` | `report_document` | `read_department` |  | Read department-grain report documents. |
| `reports.document.read_person` | `report_document` | `read_person` | **YES** | Read person-grain report documents (individual performance data). |
| `reports.document.read_project` | `report_document` | `read_project` |  | Read project-grain report documents. |
| `reports.period.amend` | `report_period` | `amend` | **YES** | Amend a sealed reporting period. |
| `reports.period.pin` | `report_period` | `pin` |  | Pin a reporting period. |
| `reports.period.seal` | `report_period` | `seal` | **YES** | Seal a reporting period (freezes the record appraisals consume). |
| `reports.period.view` | `report_period` | `view` |  | View reporting periods. |

### `search` — 36 permissions

| Permission key | Cerbos kind | Cerbos action | Sensitive | Description |
|---|---|---|---|---|
| `search.audit.create` | `resource_search_audit` | `create` |  | Create SEO technical/content audits. |
| `search.audit.delete` | `resource_search_audit` | `delete` |  | Delete SEO technical/content audits. |
| `search.audit.read` | `resource_search_audit` | `read` |  | View SEO technical/content audits. |
| `search.audit.run` | `resource_search_audit` | `run` |  | Trigger a technical/CWV/content audit run. |
| `search.audit.update` | `resource_search_audit` | `update` |  | Edit SEO technical/content audits. |
| `search.campaign.apply_manual` | `resource_search_campaign` | `apply_manual` | **YES** | Mark a manual-mode SEM change proposal as applied on the ad platform. |
| `search.campaign.apply_negatives` | `resource_search_campaign` | `apply_negatives` | **YES** | Apply negative keywords to live SEM campaigns. |
| `search.campaign.create` | `resource_search_campaign` | `create` |  | Create SEM campaigns (ads, ad groups, negatives). |
| `search.campaign.delete` | `resource_search_campaign` | `delete` |  | Delete SEM campaigns (ads, ad groups, negatives). |
| `search.campaign.launch` | `resource_search_campaign` | `launch` | **YES** | Execute an api-mode SEM change / launch on the live ad platform. |
| `search.campaign.propose_change` | `resource_search_campaign` | `propose_change` |  | Draft a change proposal against a SEM campaign. |
| `search.campaign.read` | `resource_search_campaign` | `read` |  | View SEM campaigns (ads, ad groups, negatives). |
| `search.campaign.set_budget` | `resource_search_campaign` | `set_budget` | **YES** | Set/change live SEM campaign budgets (client ad spend). |
| `search.campaign.update` | `resource_search_campaign` | `update` |  | Edit SEM campaigns (ads, ad groups, negatives). |
| `search.engagement.create` | `resource_search_engagement` | `create` |  | Create search-marketing engagements. |
| `search.engagement.delete` | `resource_search_engagement` | `delete` |  | Delete search-marketing engagements. |
| `search.engagement.read` | `resource_search_engagement` | `read` |  | View search-marketing engagements. |
| `search.engagement.set_scope` | `resource_search_engagement` | `set_scope` |  | Set a search engagement's commercial scope. |
| `search.engagement.update` | `resource_search_engagement` | `update` |  | Edit search-marketing engagements. |
| `search.keyword.create` | `resource_search_keyword` | `create` |  | Create keyword sets and rank tracking. |
| `search.keyword.delete` | `resource_search_keyword` | `delete` |  | Delete keyword sets and rank tracking. |
| `search.keyword.read` | `resource_search_keyword` | `read` |  | View keyword sets and rank tracking. |
| `search.keyword.research` | `resource_search_keyword` | `research` |  | Trigger keyword research / rank-and-metrics pulls (provider spend). |
| `search.keyword.update` | `resource_search_keyword` | `update` |  | Edit keyword sets and rank tracking. |
| `search.ledger.admin` | `resource_search_ledger` | `admin` | **YES** | Override a provider budget stop-loss (elevated, audited). |
| `search.ledger.read` | `resource_search_ledger` | `read` |  | View the provider usage/cost ledger. |
| `search.property.create` | `resource_search_property` | `create` |  | Create search properties (sites, GSC bindings, content briefs). |
| `search.property.delete` | `resource_search_property` | `delete` |  | Delete search properties (sites, GSC bindings, content briefs). |
| `search.property.read` | `resource_search_property` | `read` |  | View search properties (sites, GSC bindings, content briefs). |
| `search.property.update` | `resource_search_property` | `update` |  | Edit search properties (sites, GSC bindings, content briefs). |
| `search.report.approve` | `resource_search_report` | `approve` | **YES** | Approve an engagement report (delivery gate). |
| `search.report.create` | `resource_search_report` | `create` |  | Create search engagement reports. |
| `search.report.delete` | `resource_search_report` | `delete` |  | Delete search engagement reports. |
| `search.report.deliver` | `resource_search_report` | `deliver` | **YES** | Deliver an approved engagement report to the client. |
| `search.report.read` | `resource_search_report` | `read` |  | View search engagement reports. |
| `search.report.update` | `resource_search_report` | `update` |  | Edit search engagement reports. |

### `webdev` — 6 permissions

| Permission key | Cerbos kind | Cerbos action | Sensitive | Description |
|---|---|---|---|---|
| `webdev.change_request.create` | `webdev_change_request` | `create` |  | Create website change requests. |
| `webdev.change_request.read` | `webdev_change_request` | `read` |  | View website change requests. |
| `webdev.change_request.triage` | `webdev_change_request` | `triage` |  | Triage a website change request (accept/route/reject). |
| `webdev.provisioned_site.provision` | `webdev_provisioned_site` | `provision` | **YES** | Provision a client site: create the real repo + hosting for a delivery run. |
| `webdev.provisioned_site.read` | `webdev_provisioned_site` | `read` |  | View provisioned client sites (repo + hosting). |
| `webdev.provisioned_site.reconcile` | `webdev_provisioned_site` | `reconcile` |  | Re-poll a provisioned site's provisioning state. |


---

## 5. The 15 relationship-granted / bypass-exempt pairs (Ruling 3)

These are **not** role-grantable and **must never be**: no wildcard rule, no superadmin, and no
future `owner` role (D-8) may reach them. They are held by a relationship to the resource, not by
any grant in `user_roles`. The catalog JSON carries them with `class: "relationship"` so the
three-class ruling is modelled, not forgotten; their dotted keys are informational.

| Key (informational) | Cerbos pair | Granted via |
|---|---|---|
| `assistant.thread.{create,read,update,delete,message,stream,stop,handoff,confirm_write}` — 9 pairs | `assistant_thread:*` | base role `user` + `owns` (`resource.attr.ownerId == principal.id`) + `inTenant` + `notLow` |
| `assistant.memory.{list,propose,confirm,delete}` — 4 pairs | `assistant_memory:*` | base role `user` + `owns` + `inTenant` + `notLow` |
| `assistant.agent_run.read` | `agent_run:read` | base role `user` + `owns` + `resource.attr.origin == "assistant_handoff"` |
| `core.mcp_tool.call` | `mcp_tool:call` | base role **`hub_caller`** — minted only by the MCP hub's OBO principal (`mcp-hub/src/cerbos.ts`), conditioned on assurance vs the tool's `minAssurance`, automation scope, and D14 approval for high-impact writes |

**Why (the recorded rationale):** `resource_assistant_thread.yaml`'s header states it at length —
a chat thread IS a transcript containing tool output fetched under the chatting user's own
authority; widening read to any admin role "turns every admin grant into a transcript-reading
backdoor across every tool a user has ever run through the assistant". The header explicitly
warns the absence of the wildcard rule is "intentional, not a gap someone should 'restore for
consistency'". `owns` fails CLOSED if a handler forgets to pass `ownerId`.

**Mechanism notes discovered during this derivation (feed into IAM-01b-2):**

1. `mcp_tool:call` is not ownership-granted at all — it is **channel-granted**. Only principals
   minted by the MCP hub carry the `hub_caller` base role (`principalPayload` in
   `platform-nest/src/rbac/cerbos.ts` always emits `roles: ["user"]` for platform principals, so
   no platform request can ever satisfy the rule). Its exemption from superadmin is therefore
   structural, and consistent with WS2's OBO design ("clients can't assert roles"). This reads as
   deliberate, but the policy file carries no written rationale — IAM-01b-2 should add the
   one-line header, not change behaviour.
2. `agent_run:read`'s condition has **no assurance floor** — it checks `inTenant && owns &&
   origin == "assistant_handoff"` but not `notLow`, unlike both assistant policies beside it.
   Reading a run transcript at low assurance is thereby possible where reading the thread that
   spawned it is not. Boundary-neutral (the pair stays exempt either way) but looks like an
   oversight; flagged for IAM-01b-2 / an owner call. Do not fix silently inside Phase 1.

**Guard rails downstream:** IAM-02b's parity suite must assert the full 230-pair matrix including
these 15, so any future "consistency restore" on the assistant policies fails loudly. IAM-04c's
bypass ruling and the Phase-3 `owner` envelope must both state this exemption explicitly.

---

## 6. Sensitivity assessment — 79 of 215 flagged

`sensitive: true` later drives step-up auth (D-9) and D-10 approval routing. **This is the
deriving agent's assessment, pending the owner/HR/finance pass the program doc §6 already calls
for.** Tighten additively at will; loosening after the freeze is an owner decision. The lens is
*grant-time scrutiny* — "would handing this permission to a role deserve a second look" — not
"is the data private", which is why everyday baseline reads stay unflagged.

| Rubric | Flagged |
|---|---|
| S1 — HR / people data | all `hr.case.*` (6) + `hr.record.*` (5); all `reports.appraisal.*` (7); `reports.checkin.{read,excuse,missed_by_unit,pending_reminders}`; `reports.document.read_person`; `reports.period.{seal,amend}` (ledger integrity feeding appraisals) |
| S2 — finance / commercial commitments | all `billing.invoice.*` (4); all `core.contract.*` (5); `portal.{decide,sign,pay}`; `search.campaign.{set_budget,launch,apply_manual,apply_negatives}` (live client ad spend); `search.ledger.admin` (budget stop-loss override); `core.rollup.read` (cross-company exec aggregates) |
| S3 — deploys / provisioning / gate execution | `webdev.provisioned_site.provision`; `core.automation_approval.{decide,retry}` (D14 — approving EXECUTES as the original principal); `core.pipeline_gate.decide`; `agency.approval.approve`; `search.report.{approve,deliver}` (client-facing delivery gates) |
| S4 — client data boundary | `core.client.delete`; `core.client_contact.{create,update,revoke}` (portal-access lifecycle for external people) |
| S5 — credentials / identity / access control | `core.user.{create,update,delete}`; all `core.identity_link.*` (impersonation-risk channel mapping); `core.integration_connection.{create,update,delete}` (OAuth credentials); all seven `core.service_assignment` verbs except `read` (they materialize cross-company grants); `core.org_structure.update` (drives grant reconciliation); `core.company.{update,delete}` (enabled-modules surface); `core.compliance_gate.update`; `core.chat_group.{add_member,remove_member,promote_member}` (live WA group membership) |
| S6 — content-integrity chokepoints | `knowledge.source.update` (controls what enters the org-wide RAG); `core.meeting_recording.relink` (can rebind one client's recording into another's context) |

**Borderlines resolved as NOT sensitive** (revisit in the owner pass): `core.team.update` (feeds
team-scope coverage, but flagging it would flag routine team management); `core.client.{read,create,update}`
and `core.meeting_recording.{read,ingest,sync_drive}` (everyday member-tier baseline);
`search.ledger.read` (internal cost visibility, not client finance); `search.engagement.set_scope`
(commercial-ish but drafting-grade); all `it.device.*`; `reports.checkin.submit` and
`reports.document.read_{project,department,company}` (self-service / aggregate grain);
`core.integration_connection.read` and `core.service_assignment.read` (list metadata, not secrets).

---

## 7. Reconciliation — the 54 `ModuleContract.permissions` keys

The 54 colon-style keys declared across 12 modules (`src/modules/*/index.ts`, zero consumers
today) were each traced to their actual enforcement. Summary:

| Disposition | Count | Meaning |
|---|---|---|
| **CLEAN** | 35 | maps exactly to catalog permissions (1:1, a bundle of them, or a pure rename) |
| **ALIAS** | 12 | enforced through a *different* Cerbos kind/action than the key implies |
| **RELATIONSHIP** | 5 | maps only to §5 exempt pairs — must never appear as grantable |
| **ORPHAN** | 2 | no Cerbos enforcement exists at all |

> Refinement of the earlier analysis: `2026-08-10-iam-01a-02a-analysis.md` named four keys as
> having "no Cerbos resource at all". Literally true (no kind of that name exists), but tracing
> enforcement shows `search:rank:read` and `it:discovery:report` ARE enforced — via other kinds —
> and `assistant:handoff` maps to exempt pairs. Only `search:content:publish` (plus
> `automation:workflow:read`, which that list missed) have **no** Cerbos enforcement anywhere.

Full disposition table (this is the migration map IAM-01d executes):

| Declared key | Module | Disposition | Maps to | Recommendation |
|---|---|---|---|---|
| `agency:campaign:read` | agency | CLEAN | `agency.campaign.read` | adopt renamed key |
| `agency:campaign:create` | agency | CLEAN | `agency.campaign.create` | adopt |
| `agency:brief:write` | agency | CLEAN (bundle) | `agency.brief.{create,update,delete}` | declare the 3 fine-grained keys; "brief write" becomes a UI group (IAM-01b-3) |
| `agency:asset:write` | agency | CLEAN (bundle) | `agency.creative_asset.{create,update,delete}` | same pattern |
| `agency:approval:approve` | agency | CLEAN | `agency.approval.approve` | adopt |
| `assistant:thread:read` | assistant | RELATIONSHIP | `assistant.thread.read` (exempt) | remove from `permissions` — never grantable |
| `assistant:thread:write` | assistant | RELATIONSHIP | `assistant.thread.{create,update,delete}` (exempt) | remove |
| `assistant:memory:read` | assistant | RELATIONSHIP | `assistant.memory.list` (exempt) | remove |
| `assistant:memory:write` | assistant | RELATIONSHIP | `assistant.memory.{propose,confirm,delete}` (exempt) | remove |
| `assistant:handoff` | assistant | RELATIONSHIP | `assistant.thread.handoff` + `assistant.agent_run.read` (exempt) | remove |
| `automation:workflow:read` | automation-console | **ORPHAN** | — (in-code platform-admin check; the module file's own header documents the deviation: AdminSystemsController is global-scoped, not per-tenant) | drop at IAM-01d; if the n8n viewer should ever be role-grantable, mint an `automation_workflow` Cerbos kind first (Phase 2+, additive) |
| `billing:invoice:read` | billing | CLEAN | `billing.invoice.read` | adopt |
| `billing:invoice:create` | billing | CLEAN | `billing.invoice.create` | adopt |
| `billing:invoice:update` | billing | CLEAN | `billing.invoice.update` | adopt (`billing.invoice.delete` exists undeclared — catalog covers it) |
| `clients:client:read` | clients | CLEAN (re-domained) | `core.client.read` | adopt — see J1: `client` is a core kind |
| `clients:client:create` | clients | CLEAN (re-domained) | `core.client.create` | adopt |
| `clients:client:update` | clients | CLEAN (re-domained) | `core.client.update` | adopt |
| `clients:client:delete` | clients | CLEAN (re-domained) | `core.client.delete` | adopt |
| `hr:case:read` | hr | CLEAN | `hr.case.read` | adopt |
| `hr:case:write` | hr | CLEAN (bundle) | `hr.case.{create,update}` | declare fine-grained |
| `hr:leave:file` | hr | ALIAS | `hr.case.create` (leave = an hr_case type; subject-self via policy condition, `hr.controller.ts:419`) | drop key; "file leave" is a UI group over `hr.case.create` |
| `hr:leave:decide` | hr | ALIAS | `core.automation_approval.decide` (module=hr routing rule in the policy) | drop key |
| `hr:loan:request` | hr | ALIAS | `hr.case.create` (`loans.controller.ts:95`) | drop key |
| `hr:loan:decide` | hr | ALIAS | `core.automation_approval.decide` | drop key |
| `hr:loan:repay` | hr | ALIAS | `hr.case.{create,update}` (staff records repayment against the loan case) | drop key |
| `hr:record:read` | hr | CLEAN | `hr.record.read` | adopt |
| `hr:record:write` | hr | CLEAN (bundle) | `hr.record.{create,update}` | declare fine-grained |
| `hr:record:export` | hr | CLEAN | `hr.record.export` | adopt |
| `it:device:read` | it | CLEAN | `it.device.read` | adopt |
| `it:device:manage` | it | CLEAN (bundle) | `it.device.{create,update,delete}` | declare fine-grained |
| `it:discovery:report` | it | ALIAS | `it.device.create` + `it.device.update` (push-based discovery authorizes on device create/update — `it.controller.ts:296–326`) | drop key; "discovery collector" is a UI group |
| `knowledge:source:read` | knowledge | CLEAN | `knowledge.source.read` | adopt |
| `knowledge:source:review` | knowledge | ALIAS | `knowledge.source.update` (approve/reject quarantine authorizes `update`) | drop key or accept the `update` spelling |
| `pm:task:read` | pm | CLEAN | `pm.task.read` | adopt |
| `pm:task:create` | pm | CLEAN | `pm.task.create` | adopt |
| `pm:task:manage` | pm | CLEAN | `pm.task.manage` | adopt (`pm.task.{update,delete}`, `pm.project.{read,manage}` exist undeclared) |
| `reports:metrics:read` | reports | ALIAS | `reports.document.read_*` + `reports.period.view` (`reports.controller.ts:360–504`) | drop key; the fine-grained reads cover it |
| `search:engagement:read` | search | CLEAN | `search.engagement.read` | adopt |
| `search:engagement:write` | search | CLEAN (bundle) | `search.engagement.{create,update}` + `search.property.{create,update}` (its description spans both) | declare fine-grained |
| `search:scope:write` | search | ALIAS | `search.engagement.set_scope` | adopt the real action name |
| `search:keyword:write` | search | CLEAN (bundle) | `search.keyword.{create,update}` | declare fine-grained |
| `search:rank:read` | search | ALIAS | `search.keyword.read` (rank-snapshots route authorizes keyword read — `search.controller.ts:1880–1886`) | drop key |
| `search:audit:run` | search | CLEAN | `search.audit.run` | adopt |
| `search:brief:write` | search | ALIAS | `search.property.update` (+ `.delete` for removal) — briefs authorize against the parent property (`search.controller.ts:2637–2752`) | drop key; "brief authoring" is a UI group |
| `search:campaign:write` | search | CLEAN (bundle) | `search.campaign.{create,update,propose_change}` | declare fine-grained |
| `search:campaign:launch` | search | CLEAN (bundle) | `search.campaign.launch` + `search.campaign.apply_manual` (its own description: "covers both dual-mode twins") | declare fine-grained |
| `search:content:publish` | search | **ORPHAN** | — (no route exists; `ai-drafts.ts` contains zero authorize calls — declared ahead of an unbuilt feature) | drop at IAM-01d; when publishing ships, add the Cerbos action + catalog entry first (additive) |
| `search:report:write` | search | CLEAN (bundle) | `search.report.{create,update}` | declare fine-grained |
| `search:report:approve` | search | CLEAN (bundle) | `search.report.approve` + `search.report.deliver` (`search-reports.controller.ts:306,348`) | declare fine-grained |
| `search:ledger:read` | search | CLEAN | `search.ledger.read` | adopt |
| `search:provider:admin` | search | ALIAS | `search.ledger.admin` | adopt the real kind/action |
| `webdev:site:read` | webdev | CLEAN (renamed) | `webdev.provisioned_site.read` | adopt |
| `webdev:site:provision` | webdev | CLEAN (renamed) | `webdev.provisioned_site.provision` | adopt |
| `webdev:site:reconcile` | webdev | CLEAN (renamed) | `webdev.provisioned_site.reconcile` | adopt |

**Coverage note:** the declarations were always partial — 161 of the 215 grantable pairs have no
module declaration at all, and no module declares core-domain permissions. IAM-01d's fail-closed
check must therefore validate *module-declared ⊆ catalog*, never equality.

**Interaction warning for IAM-01d:** the registry "fails closed on drift — a module declaring an
uncatalogued permission must refuse to start". Under that rule, the 2 orphans and the 5
relationship keys are boot-blockers the moment IAM-01d lands unless this table's migrations are
applied in the same change. Sequence them together.

---

## 8. Judgement calls (all of them, consolidated)

Every non-mechanical decision in this catalog, so review can target them:

- **J1 — `client` (and `client_contact`) are `core`, not `clients`-module.** The `clients` module
  authorizes kind `client` for CRUD, but `client` is a 0001 core-schema entity shared by files,
  meetings, pipeline, portal, contracts, search bindings and mail; its siblings (`deliverable`,
  `time_entry`) are unambiguously core, and module-owned kinds elsewhere carry the module prefix
  in the kind name. Choosing `clients.client.*` would have split one entity family across domains.
  Flip this before the freeze if the owner disagrees — it is a pure key rename today.
- **J2 — `portal` is its own top-level domain, `portal.*` (DECIDED — owner decision DR-4,
  2026-08-10).** The deriving agent's literal application of Ruling 2 (non-module kind → `core`)
  produced `core.portal.*` and flagged the collision with the program doc's `portal.*`
  recommendation as the one genuine pre-freeze naming call. The owner has now decided `portal.*`:
  the client portal is a separate trust surface with its own route group and shell, so it earns
  its own domain rather than folding into `core`. This is a deliberate, owner-sighted amendment
  to Ruling 2, not a violation of it — see the note appended to Ruling 2 in
  `2026-08-10-iam-01a-02a-analysis.md` §6. All 6 keys renamed `core.portal.*` → `portal.*`
  (domain field: `core` → `portal`); the Cerbos kind (`portal`) and `cerbosKind`/`cerbosAction`
  mapping are unchanged.
- **J3 — `invoice` → `billing`, but `contract` → `core`.** Billing declares and enforces invoice;
  no module declares or enforces `contract` (it lives in `core/contracts.controller.ts`). The
  asymmetry is evidence-driven, not aesthetic.
- **J4 — `knowledge_source` → `knowledge`** although its only authorize site is
  `admin/intelligence.controller.ts`; the knowledge module declares matching permissions and owns
  the surface conceptually.
- **J5 — `agent_run` → `assistant`** (informational, exempt): created by assistant handoff, read
  back in the assistant UI. Alternative `core` defensible; irrelevant to grantability.
- **J6 — `webdev_change_request` → `webdev`** by kind-name prefix, although its authorize sites
  currently live in `core/webdev-change-requests*.controller.ts`, not the webdev module.
- **J7 — `pipeline_run/gate/stage`, `meeting_recording`, `scope_signoff` → `core`,** not
  `webdev`: enforced by `core/pipeline.controller.ts` / `core/meetings.controller.ts` and consumed
  by portal + agency + webdev alike. The Web Dev program *welds* these into its dept experience
  but does not own their kinds.
- **J8 — `chat_group` → `core`** with a caveat: its five actions are enforced **out-of-process**
  by `wa-chat-bot/src/actions/group-admin.ts` (zero platform-nest authorize sites). Same for
  `mcp_tool` (enforced by mcp-hub). The catalog is the union of what *Cerbos* enforces, regardless
  of which service asks.
- **J9 — `report_*` prefix-stripping (N3)** parallels the search normalization: `reports.document`
  not `reports.report_document`. `checkin`/`appraisal` keep their kind names as resources.
- **J10 — sensitivity borderlines** as listed in §6 — notably `team.update`,
  `meeting_recording.read`, `search.ledger.read`, `search.engagement.set_scope`, `it.device.*`
  resolved NOT sensitive, and `chat_group` member-management resolved sensitive.
- **J11 — the 15 exempt pairs carry informational dotted keys and `sensitive: false`** in the
  JSON (the flag drives grant-time controls; they are ungrantable by definition). Their data is
  private by construction, which is the point of the class.
- **J12 — HR leave/loan declared keys alias `hr.case.*` + `core.automation_approval.decide`** —
  the leave/loan verticals are hr_case types plus the D14 approvals surface; they get no
  dedicated permissions until someone deliberately mints finer Cerbos actions (additive, post-freeze).
- **J13 — core-kind count corrected** from the ruling's "~20" estimate to the measured 33 (§3).

## 9. Open questions for the owner (decide before IAM-07a freezes the catalog)

> **Portal domain naming (J2) — RESOLVED 2026-08-10 (DR-4):** the owner decided `portal.*` as its
> own top-level domain. See §8 J2. No longer open.

1. **Sensitivity sign-off (§6):** 79 flags are my rubric-based assessment; the program doc §6
   already schedules an HR/finance pass. Sign off (or amend) before D-9 step-up and D-10 routing
   are built on the flags.
2. **IAM-01b-2 confirmations (§5):** bless the `mcp_tool:call` channel-grant rationale (my
   evidence says structural and deliberate — platform principals can never carry `hub_caller`),
   and rule on `agent_run:read`'s missing `notLow` assurance floor (looks like an oversight;
   boundary-neutral either way). Neither changes the 215 count.
