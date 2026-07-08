# Workstream 1 · Sub-spec — RBAC / Authorization Engine

**Date:** 2026-07-04
**Status:** Design draft (brainstorming stage — not being built yet)
**Parent:** `2026-07-04-ws1-gaiada-platform-architecture.md` (sub-spec #2)
**Scope:** Authentication + authorization shared across the platform, MCP hub, and WA bot. Cross-cutting Governance (Workstream 6) building block.

---

> **D5 carry-over (adversarial review) — adopt from day one even in v1:** RLS must key on an **authorized-tenant-SET**, not a scalar — `tenant_id = ANY(current_setting('app.current_tenant_ids')::uuid[])`, populated per request from the principal's authorized set — and **no app/service role may hold BYPASSRLS**. Mandate `SET LOCAL` in-transaction; never transaction-pool a tenant-bound connection without reset. This is cheap now and is the fix for the "RLS provides zero isolation on cross-tenant paths" finding; the full sync/cross-tenant enforcement lands with the (deferred) sync engine. Cross-company reads served read-only from the aggregated rollup layer under the parent tenant, Cerbos-gated — never raw cross-tenant reads into a tool-authorizing context.

## 1. Split of concerns (locked)

| Concern | Owner | Notes |
|---|---|---|
| **Authentication** (who are you) | **Self-hosted IdP** (Zitadel or Keycloak) | OIDC/SSO, MFA, token rotation. No custom crypto. Zitadel's native multi-tenant "organizations" map to child companies; Keycloak = most battle-tested. Final pick at build. |
| **Authorization** (what may you do) | **Cerbos** (self-hosted policy decision service) | Every service calls `Check(principal, resource, action) → allow/deny`. Language-agnostic (TS + Go), centralized versioned policy, built-in audit. |
| **Hard tenant isolation** | **Postgres RLS** | Defense-in-depth beneath app-layer authz; rows filtered by `tenant_id` session var. |

---

## 2. Model

- **Principal** = user + attributes assembled per request from the **IdP token** + DB (`company_memberships`, `user_roles`, `team_memberships`). Shape: `{ id, roles:[{role, scopeType, scopeId}], companies:[...], teams:[...], attr:{...} }`.
- **Resource** = an entity + attributes: `{ kind, id, tenant_id, owner_id, project_id, module, ... }`.
- **Action** = `resource:action`, e.g. `projects:read`, `tasks:write`, `agency:campaign:approve`.
- **Scope hierarchy:** `global → company → team → project → record`. A `user_roles` row binds a role **at a scope** (`scope_type` + `scope_id`). Grants **cascade downward** (a `manager` at company scope manages that company's projects) unless a narrower override exists.

---

## 3. Role catalog (initial)

| Tier | Role | Purpose |
|---|---|---|
| Global | `platform_admin` | Full system administration. |
| Global | `group_executive` | **Cross-company read** — the management "see everything" role (powers the WA bot management digest + unified dashboard). |
| Company | `company_admin` | Admin within one company (tenant). |
| Company | `manager` | Manage projects/tasks/teams in scope. |
| Company | `member` | Regular contributor. |
| Company | `viewer` | Read-only in scope. |
| Module | e.g. `agency_approver` | Module-specific elevated action (approve creative). |

Roles are data (`roles` table); the catalog above is the seed set. Company-scoped roles have `roles.company_id` set; global roles leave it null.

---

## 4. Cerbos policies

- One **versioned policy repo**, tested in CI (Cerbos supports policy unit tests).
- Per **resource kind** (project, task, campaign, …): a resource policy lists actions and, per action, the roles/conditions that allow it.
- **Conditions** express fine-grained rules beyond role membership:
  - `request.principal.attr.tenant == request.resource.attr.tenant_id` (tenant match — belt-and-suspenders with RLS)
  - ownership: `principal.id == resource.attr.owner_id`
  - scope match: principal holds the required role at a scope that covers the resource
- **Derived roles** encode the scope cascade (e.g. `project_manager` derived when the principal has `manager` at the resource's company/project scope).
- Services send the assembled principal + resource(s) + candidate actions; Cerbos returns per-action decisions. Decisions are **cacheable** (short TTL keyed on principal+resource version) to amortize the network hop.

---

## 5. Cross-service reuse

### 5.1 Platform (NestJS)
- A global guard builds the principal (from OIDC token + DB) and calls Cerbos before controller/service execution.
- RLS session variable (`app.current_tenant`) set per request/connection from the principal.

### 5.2 MCP hub (Workstream 2)
- **Tool visibility filtering:** before advertising tools to an agent, the hub asks Cerbos which the requester may use → withholds the rest (matches the WA bot Phase 3 role+scope gating).
- **Per-call authorization:** each tool invocation is checked against its target resource + action.

### 5.3 WA bot / external surfaces
- **`identity_links`** table maps an external identity to a user:
  | `identity_links` | `id`, `user_id`, `provider` (whatsapp/telegram/…), `external_id` (phone/handle), `verified_at` |
- WA sender → `identity_links` → user → assemble principal.
- **Unknown/unlinked sender** → minimal principal (no roles/scopes) → Cerbos denies DB/MCP tools → the bot falls back to chat-history/general answers only.

---

## 5.4 D4 resolution — assurance-tiered identity (LOCKED, adversarial review)

Token-less surfaces (WhatsApp/Telegram) are **low-trust**; the bot must never be the identity authority.

1. **Platform mints the principal.** The bot presents only a `(provider, external_id)` envelope; the trusted platform (sole holder of `identity_links`) resolves it to a principal. **The hub rejects any bot-asserted user or role.** Agent hops are **attenuate-only** (never re-broaden), re-checked at Cerbos each hop.
2. **Channel assurance is a first-class Cerbos attribute.** `WA-DM = low`. Low-assurance sessions get **general AI + the group's own chat history only** — no company-DB data, no cross-tenant, no bulk export.
3. **Step-up precondition.** Any **sensitive / bulk / cross-tenant / `group_executive`** action requires `assurance == high`, obtained via an **IdP step-up** (one-time auth link + MFA). WS7's step-up MFA is thus a *precondition*, not only an incident response. A WS7 rule flags any high-assurance action attempted under a low-assurance session.
4. **`identity_links.verified_at` = dual-proof enrollment** — the user proves control of the WhatsApp number **and** an IdP account before any linkage grants elevated scope.
5. **Batch management digest** (no requesting user) runs as a **pre-scoped read-only service account** restricted to the `rollup.metrics` aggregate path (never raw tables), with a short-lived per-run credential, named in the audit — an **explicit bounded exception to OBO**. No standing broad `group_executive` principal exists anywhere.

## 6. Audit

- **Every decision** (allow AND deny) captured: Cerbos audit sink + a platform-level entry in `activities` for data-touching actions (who, action, resource, decision, scope).
- Denials return a clear "not authorized" message to the surface and are logged for review.

---

## 7. Token & session flow

1. User logs in via IdP → receives OIDC access + refresh tokens.
2. Platform/API validates the JWT (IdP JWKS), extracts subject → resolves internal `users` row (auto-provision on first login, linked by IdP subject).
3. Principal assembled (memberships/roles/teams) → cached per session with short TTL; invalidated on role change.
4. Refresh handled by the IdP; services never store passwords.

---

## 7b. D11 — authoritative revocation (LOCKED, adversarial review)

JWT signature validation alone lets an unexpired token survive an IdP disable. Therefore: **minute-scale access-token TTL**, plus a **server-side session-version / deny-list checked on every sensitive or high-impact request** (and every MCP tool call) so a disabled/scoped-down principal is cut off immediately, not at token expiry. Wire the SOC/admin revoke action to bump the session-version. The full offline-lease model (leases that fail-closed when a node can't reach central) lands with the deferred sync engine.

## 8. New / referenced tables

- **New:** `identity_links` (external identity ↔ user).
- **Referenced (from schema sub-spec):** `roles`, `permissions`, `role_permissions`, `user_roles`, `company_memberships`, `team_memberships`.

---

## 9. Open items

- Zitadel vs Keycloak final selection (multi-tenant ergonomics vs maturity).
- Principal cache invalidation strategy on role/scope changes (event-driven bust).
- Whether Cerbos runs as sidecar (per-service, low latency) or shared service (simpler ops) — infra decision.
- Break-glass / emergency admin access procedure (Governance / WS6).
- Service-to-service (non-user) principals for automations (N8N, schedulers) — likely dedicated service accounts with scoped roles.
