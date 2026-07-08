# Gaiada ERP UI — Plan 4: Admin Section + Account/Identity (FE-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Complete the last empty nav group (Admin) and the account/identity gaps in the ERP UI — Users & Roles, Identity Links, Modules & Custom Fields, Compliance Gates, Audit pages, plus account/profile, sign-out, and the D4 `/step-up` landing. **FE-only:** all pages in `platform-ui/`; the backend + wiring is owned by the concurrent session. Use real endpoints where they already exist; degrade gracefully where the backend is pending, so pages light up automatically when it lands.

**Architecture:** UI-only, `platform-ui/` (Next.js 15 BFF). A new `lib/adminData.ts` (server-only) defines the admin-API contract the UI expects and wraps each call in `skipUnavailable` (→ null/[] on 404/403). Pages reuse Plan 1–3 primitives + the `systems` console primitives (StatusCard/ConnectionState/EmptyNote/ConfigField) and the graceful/degrade patterns. Sign-out is fully implementable now (it just clears the session cookie — pure BFF, no backend). No `platform/` edits.

**Tech Stack:** Next.js 15 App Router, React 19, plain CSS design tokens, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-05-gaiada-erp-ui-design.md` §4 (Admin nav), §5 (Admin rows), §6 (auth + step-up), §9 stage 5. Backend gap evidence: `.superpowers/sdd/platform-be-audit.md`. Follows Plans 1–3 (complete).

## What's real now vs graceful (from the backend audit)

- **Real endpoints usable today:** `GET /api/:t/members` (Users base list), `GET /api/:t/activity` (Audit), `GET /api/:t/custom-fields` (field defs list), `POST /api/:t/custom-fields` (create), `GET /api/companies` + `enabled_modules` (Modules read), `POST /admin/users/:userId/revoke` (session revoke, D11), `GET /api/me` (account). Sign-out = clear cookie (pure BFF).
- **Pending backend (degrade gracefully, forms ready):** users-with-roles, role assign/revoke, identity-links list/verify/unlink, module enable/disable toggle, custom-field PATCH/DELETE, compliance-gate persistence, filtered audit. These write/extra-read paths catch `PlatformError` 404/403/405 → friendly "not available yet — backend pending" and render empty/limited states.
- **Compliance Gates** content (G.1–G.6) can render as a real static checklist now (from the known gates); status persistence degrades until the backend table exists.

## Global Constraints

- **FE-only. Never edit `platform/` or any backend/DB/Cerbos.** Commit only `platform-ui/` paths with the pathspec form `git commit -m "msg" -- <paths>`; `git add <paths>` new files first; never `git add -A`. `git status --porcelain` before, `git show --stat` after (confirm only platform-ui files; the tree is shared with a backend session). Never delete `.git/index.lock` — if present, wait/retry or report.
- Plain CSS only. Reuse `@/components/ui` (Card, Eyebrow, Button, StatusBadge, statusColor, humanizeStatus, KpiTile, HairlineTable, Toast), `@/components/PageHeader`, `@/components/DescriptionList`, `@/components/forms/Field` + `CustomFields`, `@/components/systems` (StatusCard, ConnectionState, EmptyNote, ConfigField, ReviewButtons), `@/components/shell/icons`.
- Design hard rules: radius 0 (sanctioned dots only), no box-shadow, 0.5px hairlines, opacity/bg-tint hovers, `var(--erp-ease)`, no emoji, quiet editorial copy.
- **BFF discipline:** `lib/adminData.ts` carries `import "server-only"`; never imported by a client component; forwards identity only; no secrets rendered. Server actions catch `PlatformError` → `{ok,error}`; redirect() OUTSIDE try/catch.
- Admin pages are elevated-only (nav already gates them); each page ALSO handles `PlatformError` 403 → a quiet "limited to administrators" state (never a 500).
- Auth on every page: `getSessionUserId()` → redirect `/login`; resolve tenant via `getMe`/`getActiveTenant` where tenant-scoped.
- Node 22, ESM. Per task: `cd platform-ui && npm test && npx tsc --noEmit && npx next build`.

## Admin-API contract (UI-defined; backend session implements to this)

`GET /api/:t/users` → `{id,name,email,title,status,roles:{grantId,role,scopeType,scopeId}[]}[]`; `GET /api/roles` → `{id,name,company_id}[]`; `POST /api/:t/users/:userId/roles` `{roleId,scopeType,scopeId?}`; `DELETE /api/:t/users/:userId/roles/:grantId`; `POST /admin/users/:userId/revoke` (exists). `GET /api/:t/identity-links` → `{id,user_id,user_name,provider,external_id,verified_at}[]`; `POST .../:id/verify`; `DELETE .../:id`. `PATCH /api/:t/company/modules` `{module,enabled}`; `POST|PATCH|DELETE /api/:t/custom-fields[/:id]`. `GET /api/:t/compliance-gates`; `PATCH /api/:t/compliance-gates/:id`. `GET /api/:t/audit?verb=&actorId=&entityType=&since=&until=&limit=`. All wrapped graceful in `adminData.ts`.

---

### Task 1: Admin data layer + logout/account helpers

**Files:** Create `platform-ui/src/lib/adminData.ts` (server-only); `platform-ui/src/app/(app)/account/actions.ts` (logout); Test `platform-ui/src/lib/adminData.test.ts` (pure shaping helpers, e.g. a `mergeUserRoles` or the G-gate static list).

**Interfaces (produces, all graceful via `skipUnavailable`):** `listUsers(u,t)` (tries `/api/:t/users`; on 404 falls back to `listMembers` mapped to users with empty roles), `listRoles(u)`, `assignRole(...)`, `revokeRole(...)`, `revokeSession(u,userId)` (POST /admin/users/:id/revoke — real), `listIdentityLinks(u,t)`, `verifyIdentityLink`, `unlinkIdentity`, `setModuleEnabled(u,t,module,enabled)`, `createFieldDef`/`updateFieldDef`/`deleteFieldDef`, `listComplianceGates(u,t)` (→ falls back to the static G.1–G.6 template when the endpoint is absent), `patchComplianceGate`, `getAudit(u,t,filters)` (tries `/api/:t/audit`; on 404 falls back to `/api/:t/activity?limit=`). Export `GATE_TEMPLATE` (the six G-gates). `logout()` server action clears `gaiada_session` cookie + `redirect("/login")`.

- [ ] Steps: RED tests (GATE_TEMPLATE has 6 gates with keys G.1–G.6; a shaping helper) → implement adminData.ts + account/actions.ts logout → GREEN + tsc + build → commit pathspec `-- platform-ui/src/lib/adminData.ts platform-ui/src/lib/adminData.test.ts platform-ui/src/app/(app)/account/actions.ts`.

### Task 2: Users & Roles page (`/admin/users`)

**Files:** `platform-ui/src/app/(app)/admin/users/page.tsx`, `.../admin/users/actions.ts`, `platform-ui/src/components/admin/RoleManager.tsx` (client).

Elevated-only (403 → limited state). List users (real via members fallback) in a HairlineTable (name, email, title, status, roles as badges). Per user: a RoleManager client component to assign a role (role select from `listRoles` + scope select) and revoke a grant, and a "Revoke sessions" button (real `revokeSession`). Assign/revoke actions degrade with friendly message until BE lands; revoke-session works now.

- [ ] Steps: implement actions (assignRole/revokeRole graceful; revokeSession real) → page + RoleManager (client, useActionState, Toast) → verify → commit pathspec.

### Task 3: Identity Links page (`/admin/identity`)

**Files:** `platform-ui/src/app/(app)/admin/identity/page.tsx`, `.../actions.ts`, reuse ReviewButtons or a small client control.

List identity_links (provider, external_id, user, verified badge). Verify (confirm) + unlink actions degrade gracefully (BE pending). D4 note explaining dual-proof. 403 → limited state; empty/absent → EmptyNote.

- [ ] Steps: actions (verify/unlink graceful) → page → verify → commit pathspec.

### Task 4: Modules & Custom Fields page (`/admin/modules`)

**Files:** `platform-ui/src/app/(app)/admin/modules/page.tsx`, `.../actions.ts`, reuse CustomFields/Field + ConfigField-style toggles.

Two sections: (a) **Modules** — the active company's `enabled_modules` (read real from company/companies) as toggle rows; toggling calls `setModuleEnabled` (degrades until BE). (b) **Custom Fields** — list field defs (real `GET /api/:t/custom-fields`) grouped by entity type; create (real `POST`) + edit/delete (degrade) forms. 403 → limited state.

- [ ] Steps: actions (setModuleEnabled graceful; createFieldDef real; update/delete graceful) → page → verify → commit pathspec.

### Task 5: Compliance Gates page (`/admin/compliance`)

**Files:** `platform-ui/src/app/(app)/admin/compliance/page.tsx`, `.../actions.ts`.

Render the six G-gates (from `listComplianceGates` → real when present, else the static `GATE_TEMPLATE`) as a checklist: key, title, description, status badge (open/in_progress/passed/waived), evidence link. Patch status + evidence URL via a form (degrades until BE persists). This page shows real, useful content NOW (the gate list) even before persistence. 403 → limited state.

- [ ] Steps: actions (patchComplianceGate graceful) → page (static template fallback) → verify → commit pathspec.

### Task 6: Audit page (`/admin/audit`)

**Files:** `platform-ui/src/app/(app)/admin/audit/page.tsx`.

Filtered audit browser. Reads `getAudit` (real via `/api/:t/activity` fallback now; upgrades to `/api/:t/audit` filters when BE lands). Filter controls (verb/actor/entity/date via searchParams — Next 15 async searchParams) applied client-or-server side; HairlineTable of actor/verb/entity/time; limit/load-more. 403 → limited state; empty → EmptyNote.

- [ ] Steps: page with searchParams filters (basic filters work against activity now) → verify → commit pathspec.

### Task 7: Account/profile + sign-out

**Files:** `platform-ui/src/app/(app)/account/page.tsx` (actions.ts logout from Task 1); update the sidebar user-card to add a Sign out affordance (`platform-ui/src/components/shell/Sidebar.tsx` + maybe a small client `UserMenu.tsx`).

Account page shows the principal (name, title, email, companies, roles) from `getMe`, and a **Sign out** button (logout action — fully working now). Add Sign out to the sidebar user-card (the settings icon → a small menu or a direct sign-out). This closes the no-logout gap.

- [ ] Steps: account page → sidebar sign-out affordance (client UserMenu) → verify → commit pathspec `-- platform-ui/src/app/(app)/account platform-ui/src/components/shell/Sidebar.tsx platform-ui/src/components/shell/UserMenu.tsx`.

### Task 8: `/step-up` landing (D4)

**Files:** `platform-ui/src/app/step-up/page.tsx` (NOTE: outside the `(app)` group — it's a landing reachable pre-full-session; ensure middleware allows it like `/login`), possibly `platform-ui/src/middleware.ts` (add `/step-up` to the public matcher exclusions).

The identity step-up page WA/Telegram users are routed to for sensitive actions: editorial explanation of why escalation is needed, the sign-in path (IdP when AUTH_MODE=oidc, dev-login otherwise), and a return-to link (`?return=` param). Mostly static UI + a sign-in button reusing the login flow. Middleware: allow `/step-up` unauthenticated (like `/login`).

- [ ] Steps: middleware allow /step-up → page (reads `?return=`) → verify → commit pathspec `-- platform-ui/src/app/step-up platform-ui/src/middleware.ts`.

### Task 9: Upgrade graceful derivations + docs

**Files:** `platform-ui/src/lib/entities.ts` (getCompany/getCampaign: keep list-derivation but this is unchanged unless BE detail endpoints exist — re-audit at execution; if still missing, leave as-is and note); docs `docs/superpowers/plans/2026-07-05-CHECKLIST.md` + `CLAUDE.md` (clean-file pathspec commit).

- [ ] Steps: re-check if company-detail/campaign-detail endpoints now exist (backend session may have added them); if so switch entities.ts to real (keep fallback); else leave + note. Docs: add "Plan 4 — Admin + account/identity (UI)" subsection (☑ pages built, ☐ backend-pending writes). Commit clean docs pathspec.

---

## Notes
- Every admin write path degrades gracefully (BE owned by the concurrent session) and auto-activates when the endpoints land — the UI defines the contract in `adminData.ts` (single reconciliation point).
- Genuinely working NOW without any backend change: sign-out, account view, audit (via activity), users list (via members), custom-field create + defs list, compliance-gate checklist display, modules read.
- After Plan 4, the only remaining FE work is **Plan 5 — polish**: global search wiring, notifications, layout/density prefs, loading/error/not-found states, responsive, a11y, and the deferred minors. Doing Plan 5 completes "all UI/UX done for every system/app."
