# Workstream 1 — Custom Gaiada Platform: Architecture

**Date:** 2026-07-04
**Status:** Architecture draft (brainstorming stage — not being built yet)
**Parent:** `2026-07-04-gaiada-ai-platform-roadmap.md` (Workstream 1)
**Scope:** The foundation platform — the "one interface to track all work" — as a **fully custom, modular, multi-tenant, local-first** system. This doc fixes the architecture; detailed per-area sub-specs (entity schemas, the sync engine, RBAC, each vertical module) follow.

---

## 1. What this is

Gaiada's central operating platform, spanning multiple **child companies in radically different businesses** (5-star resort + F&B, marine/yacht/jet logistics + catering, printing, digital agency, …). It gives every company operational tooling AND gives management **one unified cross-company view**, with **native AI** (voice/video/audio/file handling, MCP-driven assistance) woven in.

**Scale target:** hundreds of employees, multi-device (web desktop, tablet, iOS, Android), multi-location, multi-server (local + VPS + cloud). *Mid-scale, not hyperscale — architecture and data model are the constraints, not raw language speed.*

---

> **Critique-pass refinements (roadmap §3b):** (1) **Vertical strategy** — build custom only for *differentiating* verticals/capabilities; integrate *commodity* verticals (hotel PMS, accounting) via **MCP connectors**, unify at the data/AI layer. (2) An **event backbone** (Redpanda/NATS) is added program-wide — modules emit/consume events (audit, real-time, AI triggers) alongside the service layer.

## 2. Core architectural decisions (locked)

| Area | Decision |
|---|---|
| Build approach | **Fully custom, modular platform** (common core + pluggable vertical modules). Build/buy re-evaluated with the multi-vertical requirement in view; custom chosen for control + all-local. |
| Backend | **TypeScript / NestJS** for domain/business/API core (shared types with MCP + WA bot); **Go** for perf-critical edge services (realtime hub, media workers, gateway, **sync engine**). |
| Data model shape | **Common core + vertical modules.** Core = universal entities; each business is a module adding its own entities/UI, referencing core + emitting standardized rollup KPIs. |
| Multi-tenancy | **Shared DB + `tenant_id` (company) + Postgres Row-Level Security.** Heterogeneity handled at the **module layer** (which modules a company enables) + **custom fields**, NOT by fragmenting the DB. |
| Business model | **Mixed:** a Project optionally belongs to a Client (client work) or has none (internal). |
| First vertical module | **Digital agency** (maps closest to the core work model; lowest-risk slice; aligns with the WA bot). |
| Data topology | **Regional primaries + scheduled reconciliation** (local-first, offline-write capable). Ownership-partitioned to minimize conflicts. |
| API style | **API-first** (REST/GraphQL + WebSockets) so one backend serves all devices identically. |
| RBAC | First-class, org-wide, role + scope (same engine as MCP/WA bot). |
| AI integration | Native — consumes the **MCP hub** (WS2) + **Gateway/CapabilityRouter** (WS3) + media pipeline; not reinvented here. |

---

## 3. Layered structure

```
                        ┌───────────────────────────────────────────┐
   Clients              │  Web (Next.js)  ·  Mobile (RN/Flutter)  ·   │
   (all via API)        │  Tablet  ·  Voice/AI surfaces  ·  WA bot    │
                        └───────────────────┬───────────────────────┘
                                            │ REST/GraphQL + WebSockets
        ┌───────────────────────────────────┴───────────────────────────────┐
        │  PLATFORM BACKEND                                                   │
        │                                                                     │
        │  ┌───────────────── Common Core (NestJS) ─────────────────┐         │
        │  │ Identity · Companies(tenants) · RBAC · Users/Teams      │         │
        │  │ Universal work: Projects·Tasks·Deliverables·Clients     │         │
        │  │ Files · Activity · Comments · Notifications             │         │
        │  │ Custom fields · Rollup/Reporting · AI/MCP access        │         │
        │  └──────────────────────┬──────────────────────────────────┘        │
        │        module API        │  (modules reference core + emit KPIs)     │
        │  ┌───────────┬───────────┼───────────┬───────────────┐              │
        │  │ Agency*   │ Resort    │ Marine    │ Printing  ...  │  (per-tenant │
        │  │ module    │ module    │ module    │ module         │   flagged)   │
        │  └───────────┴───────────┴───────────┴───────────────┘              │
        │                                                                     │
        │  Go edge services:  Realtime hub · Media workers · Sync engine      │
        └──────────────────────────────┬──────────────────────────────────────┘
                                        │
                Postgres (regional primary per site, RLS) + Redis
                                        │  append-only outbox → scheduled sync
                        ┌───────────────┴───────────────┐
                   Central DB (reconciliation hub +      VPS (internet-facing
                   management cross-company view)          sync/access edge)
```
*Agency = first module built.

---

## 4. Common core entity model (first pass)

All tables: **UUID PKs**, `tenant_id` (company), `origin_site`, `created_at`, `updated_at` (logical clock), soft-delete, RLS by `tenant_id`.

- **`companies`** — the child companies (tenants); `type`, `enabled_modules[]`.
- **`users`** — employees; auth identity; global vs company-scoped.
- **`teams` / `departments`**, **`memberships`** (user↔company/team + role).
- **`roles`, `permissions`** — RBAC (role + scope; scopes can be company-, project-, or module-level).
- **`clients`** — external clients (nullable link from projects).
- **`projects`** — belongs to a company; optional `client_id`; `is_internal`; status.
- **`tasks`** — belong to project; assignees, status, priority, due; subtasks.
- **`deliverables`** — outputs tied to project/client.
- **`time_entries`** — logged against tasks/projects; billable flag.
- **`files` / `attachments`** — per entity; storage ref (local-first, synced).
- **`activities` / `comments`** — feed + threaded comments.
- **`custom_fields` / `custom_values`** — per-tenant/entity extension without a full module.
- **`rollup_metrics`** — standardized KPI rows each module emits (revenue, utilization, status counts, alerts) → powers the unified management dashboard.

### Digital agency module (first) — adds:
- `campaigns`, `creative_deliverables`/`assets`, `client_briefs`, `approval_workflows` (review/approve), retainer/scope tracking. References core `projects`/`clients`/`tasks`; emits agency KPIs into `rollup_metrics`.

---

## 5. Multi-tenancy & heterogeneity

- One database; every row carries `tenant_id`; **RLS** enforces isolation automatically at the DB layer (defense in depth beneath app-layer RBAC).
- A company "is" a resort or a print shop by **which modules are enabled** (`companies.enabled_modules`) — different tables in use, one DB.
- **Custom fields** cover light per-company variation that doesn't justify a module.
- Management's "see everything" view = querying across tenants (authorized by role) + the standardized `rollup_metrics` layer, so wildly different businesses compare on common terms.

---

## 6. Data topology — regional primaries + reconciliation

- Each **site** (main office, each location, VPS, cloud) runs the app + a **regional-primary Postgres**; sites can **read and write while disconnected**.
- **Conflict minimization by ownership:** records are owned by the site that operates them → reconciliation is mostly a merge of disjoint sets.
- **Sync mechanism:** per-site **append-only outbox/event log** → **scheduled sync** ships events to the central hub and pulls others'; **idempotent apply**; UUID PKs prevent ID collision.
- **Conflict resolution (rare, shared records):** deterministic LWW by logical clock (`updated_at` + `site_id` tiebreak); true conflicts flagged for human review.
- **Central DB** = reconciliation hub + management cross-company view. **VPS** = internet-facing sync/access edge.
- Implemented as a dedicated **Go sync engine** edge service.
- ⚠️ **Highest-risk area** — gets its own detailed sub-spec before build (event schema, ordering, idempotency, resolution rules, backfill, monitoring).

---

## 7. Clients & AI-native capability

- **API-first**; web = Next.js, mobile = React Native or Flutter (one codebase iOS+Android) — final client choice deferred to Workstream 5 (Surfaces).
- **Realtime** via WebSockets (Go hub): live updates, presence, voice/AI streaming.
- **Native AI**: voice command/reply, video/audio/file handling all route through the **MCP hub (WS2)** + **Gateway/CapabilityRouter (WS3)** + the **media pipeline** (from the WA bot spec). Each vertical module can expose its own MCP tools.

---

## 8. Build discipline (avoid boiling the ocean)

**Thin first slice:** common core (companies, users, RBAC, universal work model, files, activity, reporting skeleton) + **digital-agency module** + web UI + API — single-site first, then layer in the sync engine, then additional modules and mobile. Each is its own spec.

---

## 9. Sub-specs to follow (Workstream 1 decomposition)

1. Core entity schema + migrations + RLS policy detail.
2. RBAC engine (role + scope) — shared with MCP/WA bot.
3. **Sync engine** (regional primaries + reconciliation) — highest risk.
4. Digital-agency module design.
5. API surface (REST/GraphQL + WebSocket contracts).
6. Module framework (how a vertical module registers entities, UI, MCP tools, rollup KPIs).

---

## 10. Open items

- Exact auth/identity provider (SSO? local? per-company?) — decide in RBAC sub-spec.
- File storage backend (local-first + synced object store) — decide in sync sub-spec.
- Mobile: React Native vs Flutter vs PWA-first — Workstream 5.
- Reporting/dashboard tech for the unified management view.
- Whether module framework is compile-time (monorepo packages) or runtime plugins.
