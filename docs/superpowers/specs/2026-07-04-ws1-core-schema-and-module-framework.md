# Workstream 1 · Sub-spec — Core Entity Schema + Module Framework

**Date:** 2026-07-04
**Status:** Design draft (brainstorming stage — not being built yet)
**Parent:** `2026-07-04-ws1-gaiada-platform-architecture.md` (sub-spec #1 + #6)
**Scope:** The concrete core data model AND the framework by which vertical modules extend it. Everything else in WS1 (RBAC engine, sync engine, agency module, API surface) builds on this.

---

## 1. Module framework

### 1.1 Mechanism — DECIDED
**Compile-time NestJS modules + runtime enable-flag.**
- Each vertical is a NestJS module in a monorepo package, e.g. `@gaiada/module-agency`, compiled into the app.
- `companies.enabled_modules` gates activation **per tenant at runtime**: guards/middleware reject access to a module's routes/entities/tools if that company hasn't enabled it.
- Adding a business = ship a new module version (no dynamic code loading, sandboxing, or runtime migrations).

### 1.2 `ModuleContract` — what every module registers
```ts
interface ModuleContract {
  key: string;                       // 'agency', 'resort', 'marine', 'printing'
  entities: EntityDef[];             // own tables + migrations (tenant-scoped, RLS)
  routes: RouteModule;               // namespaced API, e.g. /agency/*
  permissions: PermissionDef[];      // scopes contributed to RBAC, e.g. 'agency:campaign:read'
  customFieldTargets: string[];      // entity types that accept custom fields
  mcpTools: McpToolDef[];            // tool definitions exposed to the MCP hub (WS2)
  rollupProviders: RollupProvider[]; // emit standardized KPIs -> rollup_metrics
  uiManifest: UiManifest;            // nav entries/pages the frontend renders conditionally
}
```

### 1.3 Dependency rule (strict)
- **Modules depend on core; core NEVER imports a module.**
- Modules reference core entities via FKs (agency `campaign.project_id → projects.id`).
- A core **module registry** discovers enabled modules via NestJS DI and wires their routes, permissions, MCP tools, rollups, and UI manifest.
- Enforced by monorepo package boundaries (lint rule: `core` package may not import `module-*`).

---

## 2. Schema conventions

Every **tenant-scoped** table carries:
- `id` — **UUID v7** PK (time-ordered → good index locality + sync ordering).
- `tenant_id` — the owning company (FK `companies.id`).
- `origin_site` — site that created the row (for reconciliation).
- `created_at`, `updated_at` — `updated_at` doubles as the logical clock for sync LWW.
- `deleted_at` — soft delete (nullable).
- **RLS policy** keyed on `tenant_id` via a session variable (`app.current_tenant`), enforced beneath app-layer RBAC (defense in depth).

Global (non-tenant) tables: `users`, `permissions`, and global `roles` (no `tenant_id`; access controlled at the app layer).

---

## 3. Core entities

### 3.1 Identity & org
| Table | Key columns | Notes |
|---|---|---|
| `companies` | `id`, `name`, `type`, `enabled_modules` (jsonb/text[]), `parent_company_id` (nullable → group hierarchy: Gaiada parent + children), `settings` jsonb, `status` | The tenants. |
| `users` | `id`, `email`, `name`, `auth_*`, `status` | **Global identity** — one login across child companies. |
| `company_memberships` | `id`, `user_id`, `company_id`, `primary_role_id`, `status` | User↔company M:N (shared-services staff). |
| `teams` | `id`, `tenant_id`, `name`, `parent_team_id` | Departments/teams within a company. |
| `team_memberships` | `id`, `tenant_id`, `user_id`, `team_id`, `role` | |

### 3.2 RBAC (core tables; full engine in the RBAC sub-spec)
| Table | Key columns |
|---|---|
| `roles` | `id`, `company_id` (nullable = global role), `name`, `description` |
| `permissions` | `id`, `key` (e.g. `projects:read`), `description` |
| `role_permissions` | `role_id`, `permission_id` |
| `user_roles` | `id`, `user_id`, `role_id`, `scope_type` (company/project/module/global), `scope_id` |

### 3.3 Universal work model
| Table | Key columns | Notes |
|---|---|---|
| `clients` | `id`, `tenant_id`, `name`, `contact` jsonb, `status` | |
| `projects` | `id`, `tenant_id`, `client_id` (nullable), `is_internal`, `name`, `status`, `start_date`, `due_date`, `owner_id` | Mixed client/internal. |
| `tasks` | `id`, `tenant_id`, `project_id`, `parent_task_id` (subtasks), `title`, `status`, `priority`, `assignee_id`, `due_date`, `order` | |
| `deliverables` | `id`, `tenant_id`, `project_id`, `client_id`, `name`, `status`, `due_date` | |
| `time_entries` | `id`, `tenant_id`, `user_id`, `task_id` (nullable), `project_id`, `minutes`, `billable`, `date`, `notes` | |
| `files` | `id`, `tenant_id`, `owner_entity_type`, `owner_entity_id`, `storage_ref`, `mime`, `size`, `checksum` | Polymorphic owner; local-first storage + synced. |
| `activities` | `id`, `tenant_id`, `actor_id`, `verb`, `target_entity_type`, `target_entity_id`, `metadata` jsonb, `occurred_at` | Feed + audit trail. |
| `comments` | `id`, `tenant_id`, `author_id`, `target_entity_type`, `target_entity_id`, `body`, `parent_comment_id` | |
| `notifications` | `id`, `tenant_id`, `user_id`, `type`, `payload` jsonb, `read_at` | |

### 3.4 Extensibility & reporting
| Table | Key columns | Notes |
|---|---|---|
| `custom_field_definitions` | `id`, `tenant_id`, `entity_type`, `key`, `label`, `data_type`, `options` jsonb, `required` | Registry driving validation + UI. |
| *(custom values)* | JSONB `custom_fields` column **on the entity itself** | GIN-indexed; **no EAV**. |
| `rollup_metrics` | `id`, `tenant_id`, `company_id`, `module`, `metric_key`, `value_numeric`, `dimensions` jsonb, `period`, `computed_at` | Standardized cross-company KPI store → unified management dashboard. |

### 3.5 Sync (full design in the sync sub-spec)
| Table | Key columns |
|---|---|
| `sync_outbox` | `id`, `tenant_id`, `entity_type`, `entity_id`, `op` (insert/update/delete), `payload` jsonb, `logical_clock`, `origin_site`, `created_at`, `synced_at` |

---

## 4. Design rationale (the three forks)

1. **Custom fields = JSONB column + `custom_field_definitions` registry**, not EAV. GIN-indexable, no join explosion, registry powers validation + dynamic UI. EAV is the classic ERP performance/consistency trap — avoided.
2. **Identity = global `users` + `company_memberships`** (M:N). One login for staff who work across child companies; company/role context resolved per session. (Auth provider — SSO vs local — decided in the RBAC sub-spec.)
3. **Work model = concrete core entities**, not one polymorphic `work_item` uber-table. Keeps FKs, constraints, and queries sane; modules add their own concrete tables. Also sidesteps EAV.

---

## 4b. D12 — rollup_metrics correctness (LOCKED, adversarial review)

`rollup_metrics` as first sketched is wrong-by-construction (bare `value_numeric`, free-string `metric_key`). Adopt from day one even in single-tenant v1:

- **Governed `metric_definitions` registry** (canonical `metric_key` PK, `unit`, `is_monetary`, `aggregation_rule` enum, owning module) enforced in CI — the only source of comparable metrics.
- **Ratios store numerator + denominator** (never a pre-divided percentage — you cannot re-aggregate an average of percentages).
- **Money in minor units + a `currency` column**; normalize via `fx_rates` at query time (prevents summing IDR + USD).
- **`as_of` / `source_watermark` per row** distinguishing provisional vs closed figures; recompute is **idempotent** keyed on `(tenant, company, module, metric_key, period)` with explicit late-event handling.
- Rollups computed at the **owning node/module against local data** and emitted (no central full-table scans); dashboard reads a replica. Integrated commodity verticals feed rollups via a `rollupProvider` like native modules.

## 5. Rollup contract (unified management view)

- Each module implements `rollupProviders` that compute standardized KPIs (revenue, utilization, deliverables due, task-status counts, alerts) and write them to `rollup_metrics` on a schedule and/or on relevant events.
- The management dashboard queries `rollup_metrics` **across tenants** (authorized by role) so radically different businesses compare on common terms — without sharing a schema.

---

## 6. Digital-agency module (concrete framework example)

Package `@gaiada/module-agency` registers:
- **Entities:** `agency_campaigns` (FK→`projects`), `agency_creative_assets`, `agency_briefs`, `agency_approvals`.
- **Permissions:** `agency:campaign:*`, `agency:asset:*`, `agency:approval:*`.
- **Custom-field targets:** campaigns, assets.
- **MCP tools:** e.g. `agency.listCampaigns`, `agency.campaignStatus`, `agency.pendingApprovals`.
- **Rollups:** active campaigns, deliverables due this week, team utilization.
- **UI manifest:** Campaigns board, Asset library, Approvals inbox.

---

## 6b. D17 — custom-field limits & migration discipline (LOCKED, adversarial review)

- **Reporting/range queries go through `rollup_metrics` (D12), NOT JSONB custom fields** — GIN indexes serve containment/existence, not inequality/ORDER BY. DB-unique/FK constraints on custom fields conflict with offline LWW; avoid.
- **Re-validate custom fields against `custom_field_definitions` on write** (and on the sync-apply path when it exists) so registry changes don't silently strand old rows.
- **Expand/contract migration discipline as the standard now** (additive → backfill → dual-read → cutover → drop) so old/new schema coexist — a habit before multi-site (hub-first ordering + per-`entity_type` version-skew guard + upcasters for offline-queued events) makes it mandatory.

## 7. Open items (feed later sub-specs)

- Auth/identity provider (SSO vs local vs per-company) → RBAC sub-spec.
- File storage backend (local-first object store + sync) → sync sub-spec.
- `sync_outbox` event schema, ordering, idempotency, conflict resolution → sync sub-spec.
- Exact RLS session-variable wiring + connection pooling implications → RBAC/infra.
- Whether `rollup_metrics` is recomputed (batch) vs incrementally maintained → reporting sub-spec.
