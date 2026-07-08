# Gaiada ERP UI — Design Spec

**Date:** 2026-07-05
**Status:** Approved (plain CSS + "ERP Suite" tag confirmed by user)
**Component:** new standalone project `platform-ui/`
**Design source:** `design/erp-suite-dashboard-handoff/` (Claude Design export: ERP shell prototype + Luxury Minimalist design system)

---

## 1. Purpose

The WS5 "thin web UI → ERP UI" surface: the human one-interface for Gaiada corporate
and all child companies (resort, marine, printing, digital agency, …). It is both the
daily work surface (projects, tasks, approvals) **and the settings control plane for
every subsystem already built** (wa-chat-bot, ai-gateway, mcp-hub, ai-agents,
knowledge, automation). Branded **GAIADA / ERP Suite** — deliberately broad: all
departments and companies, even though the agency module is the only vertical live
today.

## 2. Stack & project shape

- **`platform-ui/`** — standalone Next.js (App Router, TypeScript) project. Own
  package, tests, Dockerfile, entry in `infra/compose/docker-compose.vps.yml`.
  Not a monorepo member (program rule).
- **Plain CSS, no Tailwind/shadcn.** The design system's 3-tier token files
  (`tokens/colors|typography|spacing|fonts.css`) are ported verbatim as global CSS;
  fonts (Cormorant Garamond, Inter) self-hosted. A small React component library
  recreates the prototype primitives under the system's hard rules: zero radius,
  no shadows, 0.5px hairlines at 18% ink opacity, opacity-only hovers,
  10/15/20/30/40/50/60/100 spacing scale, `cubic-bezier(.22,.61,.36,1)` easing.
- **One backend: the platform.** The UI calls only the platform API. The platform
  proxies the other services' admin APIs at `/api/admin/:system/*` so auth, RBAC,
  and audit stay at a single chokepoint. The UI never holds service credentials,
  never asserts identity (D4), never sees key material.

## 3. Branding

- Wordmark **GAIADA**, product tag **ERP Suite**.
- Default bronze accent `#6E5A43` kept; all branding via the token layer.
- Sidebar user card renders the real logged-in principal — for the primary user:
  **Clement Hansel — AI Manager — initials CH**. No hardcoded persona.

## 4. Information architecture

Sidebar nav in five groups, pending-count badges, **RBAC-gated visibility**
(deny-by-default: a section renders only if the principal's roles allow it):

| Group | Items |
|---|---|
| Workspace | My Work (home) · Approvals (unified inbox) |
| Business | Companies · Projects · Tasks · Agency · Rollups (exec-only, D12) |
| Intelligence | Knowledge · AI Agents |
| Systems | WhatsApp/Telegram Bot · AI Gateway · MCP Hub · Automation (n8n) |
| Admin | Users & Roles · Identity Links · Modules & Custom Fields · Compliance Gates · Audit |

Top bar: module eyebrow + date, global search, "New" action, notifications popover,
and a **company/tenant switcher** (multi-business is core; the mock lacked this).

## 5. Screens

All pages compose the prototype's proven blocks (KPI row, SVG line chart, approvals
panel with inline approve/decline, hairline table with status badges, activity
timeline, dark agenda card, toast):

| Page | Content |
|---|---|
| My Work | Real KPIs (approvals pending, tasks due, agent runs, gateway spend today), throughput chart, "Awaiting you" panel, assigned-items table, activity from platform audit log |
| Approvals | One inbox merging: agency approvals, ai-agents suspension bubbles, identity-link requests, bot erasure confirmations. Inline approve/decline; every action audited |
| Companies / Projects / Tasks | Tenant-scoped lists + detail over existing platform REST; custom fields (D17) rendered on detail/edit; create/edit forms |
| Agency | Campaigns, briefs, approval flow (existing module endpoints) |
| Rollups | D12 ratio cards + trends; `group_executive` only — the sole cross-company read |
| Knowledge | Sources w/ provenance, quarantine review queue (approve/reject), erasure actions w/ confirmation, search test console |
| AI Agents | Goals + per-goal budget/spend, fan-out caps, run history, read-only blackboard inspector |
| Bot | Group registry editor (first real settings write — `groups.yaml` hot-reloads), digest opt-in/schedule, media pipeline status, Telegram fallback status |
| AI Gateway | Provider chain order editor, daily cost cap + live spend, circuit-breaker state, DLP toggles, egress audit viewer. Key **presence** only — never material |
| MCP Hub | Per-principal tool-visibility policy editor, tool registry, audit viewer |
| Automation | n8n workflow inventory/status, deep link out |
| Admin | Users, role assignment (Cerbos-shaped), identity links (D4), session revocation (D11), per-tenant module enable, compliance G-gate checklist, decision-audit browser |

Empty/error states use the system's quiet editorial voice ("All clear — nothing
awaiting your review"); errors reassure, never red-alert. Layout presets
(Balanced/Workspace/Analytics) and density (Comfortable/Compact) carried over as
user preferences.

## 6. Auth & identity

- v1: platform's existing dev/service auth, **contract-shaped for the OIDC/IdP
  swap** (same recorded-deviation pattern as Phase 4).
- Session cookie; **D11 session-version** checked per request; **OBO envelope** on
  every platform call. The UI asserts neither identity nor roles.
- The UI hosts the **D4 step-up landing** (`/step-up`) for WA/Telegram users
  escalating to sensitive actions.

## 7. Admin API contract (settings backbone)

Each service gains a minimal uniform surface (new work per service, kept small):

```
GET /admin/status   → health, version, live counters (uptime, spend, queue depths)
GET /admin/config   → current effective config, secrets redacted
PUT /admin/config   → allowlisted safe fields only; anything else rejected; every write audited
```

- Auth: bearer service-token minted by the platform; fail-closed.
- Platform mounts them at `/api/admin/:system/*`, RBAC-checks (`system_admin`
  scope), writes decision audit **before** proxying.
- Rollout order: bot → gateway → agents → hub → knowledge (hot-reloadable first).

## 8. Data, realtime, testing

- Fetching: SWR-style polling for v1; WebSocket is target-state (WS5).
- Tests: vitest + testing-library (components), MSW contract mocks (API states),
  one Playwright smoke e2e against live platform, a11y pass (WS5 requires a11y
  from the start).

## 9. Build order (one deliverable, staged)

1. Scaffold + design-system port + shell (nav, top bar, auth, tenant switcher, brand)
2. My Work + Approvals on real platform data
3. Business modules (Companies/Projects/Tasks/Agency/Rollups)
4. Admin APIs per service + Systems settings pages (bot → gateway → agents → hub → knowledge)
5. Admin section + step-up landing
6. Polish: layout presets, density, a11y audit, empty/error states everywhere

## 10. Non-negotiables inherited

- UI never holds provider keys; never asserts identity; deny-by-default RBAC.
- All settings writes audited; secrets never rendered.
- Separate standalone project; platform is the single backend chokepoint.
