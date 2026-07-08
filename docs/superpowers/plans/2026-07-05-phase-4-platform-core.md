# Phase 4 — Platform Core (Solo-Viable v1) — Implementation Plan

> Detailed just-in-time per the master index. TDD throughout; update `2026-07-05-CHECKLIST.md`
> per task. **Governing specs:** `2026-07-04-ws1-gaiada-platform-architecture.md`,
> `2026-07-04-ws1-core-schema-and-module-framework.md`, `2026-07-04-ws1-rbac-engine.md`.

**Goal (spec §8 thin slice):** common core (companies, users, memberships, RBAC, universal work
model, activities, rollup skeleton) + the digital-agency module + a REST API — **single-site,
single Postgres**. Sync engine, web UI, mobile, IdP are later phases.

## Solo-Viable v1 adaptations (recorded deviations, all reversible)

| Spec target | v1 here | Why / how it stays reversible |
|---|---|---|
| NestJS + monorepo packages | Plain TS + Fastify, `src/modules/<key>/` folders | Consistency with the 3 shipped services; solo velocity. The **`ModuleContract` is implemented verbatim** (compile-time import + runtime `enabled_modules` gate + core-never-imports-module lint rule by folder convention), so a NestJS port is mechanical. |
| Zitadel/Keycloak IdP | Service-token auth + `x-user-id` dev identity; principal assembly from DB | Real OIDC lands with the UI phase. The principal SHAPE matches the spec, so the IdP swap touches one resolver. `identity_links` + envelope resolution (D4) built now for the bot. |
| Cerbos | In-code policy engine behind a Cerbos-shaped API `check(principal, resource, action)` | Call sites don't change when Cerbos arrives; policy tests carry over as fixtures. |
| Go edge services, event backbone, sync | Absent | Single-site v1 per spec §8; `origin_site`/`updated_at` columns land now so sync can retrofit. |

**Locked constraints honored from day one:** D5 (RLS on authorized-tenant-SET, no BYPASSRLS,
SET LOCAL in-transaction), D4 (platform mints principals; envelope resolution; low-assurance
ceiling), D11 (server-side session-version checked on sensitive paths), D12 (governed
`metric_definitions`, numerator/denominator, minor units + currency, idempotent upsert),
D17 (custom fields = JSONB + registry, validated on write; no reporting through JSONB).

---

- [ ] **4.1 Scaffold** — `platform/` standalone project (fastify, pg, vitest, tsx; same conventions as ai-gateway). Migration runner (ordered `.sql` files, `schema_migrations` table).
- [ ] **4.2 Core schema + RLS** — migration 0001: identity/org (`companies`, `users`, `company_memberships`, `teams`, `team_memberships`), RBAC (`roles`, `permissions`, `role_permissions`, `user_roles`, `identity_links`), work model (`clients`, `projects`, `tasks`, `deliverables`, `time_entries`, `activities`, `comments`, `notifications`), extensibility (`custom_field_definitions`, JSONB `custom_fields` on entities), reporting (`metric_definitions`, `rollup_metrics` per D12). Conventions: UUID v7 (app-generated), `tenant_id`, `origin_site`, timestamps, `deleted_at`; **FORCE RLS** on authorized-tenant-set for every tenant-scoped table; global tables (`users`, global `roles`, `permissions`) app-guarded. Test: cross-tenant isolation on a non-superuser role.
- [ ] **4.3 Module framework** — `ModuleContract` (spec §1.2 verbatim), module registry, per-tenant `enabled_modules` gate rejecting routes/tools of disabled modules. Test: module route 404/403s for a tenant without the module.
- [ ] **4.4 RBAC engine (lite)** — principal assembly (user → memberships/roles/teams), scope cascade (global→company→team→project→record), role catalog seed, Cerbos-shaped `check()`; deny-by-default; every decision audited to `activities`. Session-version per user checked on sensitive paths (D11). Test: role×scope matrix incl. `group_executive` read-only cross-company via rollups only.
- [ ] **4.5 Principal resolution for surfaces (D4)** — `POST /principal/resolve` (service-token): `(provider, external_id)` envelope → `identity_links` → principal (unlinked → minimal/low). The WA bot + MCP hub consume this later. Test: unlinked envelope gets no roles; bot-asserted role impossible by shape.
- [ ] **4.6 Core REST API** — auth middleware (service token + dev user header → principal), CRUD for companies/clients/projects/tasks (+ activities written on mutations, custom-field validation on write per D17), all queries through `withTenants` (RLS) + `check()`. Test: member vs viewer vs cross-tenant.
- [ ] **4.7 Rollups (D12)** — `metric_definitions` seed + `RollupProvider` contract + core provider (task status counts, numerator/denominator form) + idempotent `recompute(period)` + `GET /rollups` (management view; `group_executive` only). Test: idempotent recompute; ratio stored as num/den; cross-company query gated.
- [ ] **4.8 Agency module** — `src/modules/agency/`: `agency_campaigns` (FK projects), `agency_briefs`, `agency_approvals`; permissions; routes; rollup provider (active campaigns, deliverables due); MCP tool defs registered via contract. Test: enable-flag gating + an approval flow.
- [ ] **4.9 MCP hub wiring** — hub gains `projects.list` / `tasks.list` / `agency.pendingApprovals` tools that call the platform API with the OBO envelope (hub never touches the DB; set-returning tools rely on RLS+policy predicate per D16-lite). Test: unlinked principal sees nothing; linked member sees own tenant only.
- [ ] **4.10 Phase e2e** — seed 2 companies (one with agency enabled) + users/roles; exercise: isolation, module gating, approval flow, rollup recompute, management rollup view, principal resolution. Update checklist; README.

**Out of scope (later phases):** web UI (WS5), IdP + real OIDC, Cerbos swap-in, sync engine,
event backbone, resort/marine/printing modules, mobile.
