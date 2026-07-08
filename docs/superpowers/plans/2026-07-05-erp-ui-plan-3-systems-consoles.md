# Gaiada ERP UI — Plan 3: Systems & Intelligence Consoles (FE-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the frontend consoles for the Systems group (WhatsApp/Telegram Bot, AI Gateway, MCP Hub, Automation) and the Intelligence group (AI Agents, Knowledge) in the Gaiada ERP UI — read-oriented status/config surfaces plus safe-config forms — defining the admin-API contract the UI expects and degrading gracefully until the concurrent backend session implements it.

**Architecture:** UI-only. All work is in `platform-ui/` (Next.js 15 BFF). A new `lib/admin.ts` server-only data layer defines the admin/systems contract (`/api/admin/:system/*` and per-surface endpoints), every function wrapped to return null/[] on 404/403 so pages render a "not connected yet" state instead of crashing. Pages compose the existing primitives (PageHeader, Card, HairlineTable, StatusBadge, DescriptionList, Toast) plus two small new ones (StatusDot, ConnectionState). No `platform/` edits; no DB.

**Tech Stack:** Next.js 15 App Router, React 19, plain CSS design tokens, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-05-gaiada-erp-ui-design.md` §5 (Systems rows + Intelligence rows), §7 (admin API contract), §9 stage 4. Follows Plans 1 (foundation) and 2 (business modules), both complete. This plan is the FE half of the spec's Plan-3; the backend admin APIs are owned by the concurrent backend session.

## Global Constraints

- **UI-only. Never edit `platform/` or any backend/DB.** Commit only `platform-ui/` paths using the pathspec form: `git commit -m "msg" -- <explicit paths>` (the working tree is shared with a concurrent backend session that leaves files staged in the index; a bare commit would sweep their work). Before each commit run `git status --porcelain`; after, `git show --stat` to confirm only your files landed.
- Plain CSS only — no Tailwind/shadcn/CSS-in-JS. Reuse Plan-1/2 primitives from `@/components/ui` (`Card`, `Eyebrow`, `Button`, `StatusBadge`, `statusColor`, `humanizeStatus`, `KpiTile`, `HairlineTable`, `Toast`), `@/components/PageHeader`, `@/components/DescriptionList`, `@/components/forms/Field`, `@/components/shell/icons` (`Icon`).
- Design hard rules: border-radius **0** (only sanctioned dots round); no box-shadow; 0.5px hairlines; opacity/bg-tint hovers; `var(--erp-ease)`; no emoji. Quiet editorial empty/error copy.
- **BFF discipline:** `lib/admin.ts` carries `import "server-only"` and is never imported by a client component. UI never asserts identity/roles; it forwards the session user and handles 200/403/404. No secrets rendered — for keys/tokens the UI shows **presence only** (a "configured"/"absent" badge), never values.
- **Graceful-degrade contract:** every admin/systems fetch returns `null` (single) or `[]` (list) when the endpoint is absent/forbidden (reuse a `skipUnavailable` helper like `lib/entities.ts`'s — catches `PlatformError` 404/403). A page whose primary data is null renders a `ConnectionState` card: "This system's admin console isn't connected yet." Never 500.
- Auth on every page: `getSessionUserId()` from `@/lib/session-server` → redirect `/login`; resolve tenant via `getMe`/`getActiveTenant` where a page is tenant-scoped (Bot/Hub/Agents/Knowledge are; Gateway/Automation are global services — no tenant needed).
- Config **writes** (e.g. gateway cost cap, DLP toggles, bot digest opt-in) go through server actions that PUT the admin config endpoint and catch `PlatformError` 404/405 → friendly "saving isn't available yet — the backend admin API is pending" message. redirect (if any) OUTSIDE try/catch.
- Node 22, ESM. Run `npm test` + `npx tsc --noEmit` + `npx next build` before every commit.

## Admin-API contract (what the UI expects; the backend session implements to this)

The platform proxies each service's admin surface at `/api/admin/:system/*` (system ∈ `bot|gateway|hub|agents|knowledge|automation`). The UI expects:
- `GET /api/admin/:system/status` → `{ ok: boolean; version?: string; uptimeSec?: number; counters?: Record<string, number|string>; detail?: Record<string, unknown> }`
- `GET /api/admin/:system/config` → `{ fields: { key: string; label: string; value: unknown; kind: "text"|"number"|"boolean"|"select"|"secretPresence"; options?: string[]; editable: boolean }[] }` (secretPresence values are `true`/`false` only — presence, never material)
- `PUT /api/admin/:system/config` body `{ key: string; value: unknown }` → `{ ok: true }` (allowlisted safe fields only; backend rejects others)
- Some surfaces expose extra reads (e.g. `GET /api/admin/gateway/egress-audit`, `GET /api/admin/hub/tools`, `GET /api/:t/agents/goals`, `GET /api/:t/knowledge/sources`) — documented per task; all optional and graceful.

This contract is documented once in `lib/admin.ts`. The backend session may adjust it; keeping it in one file makes reconciliation a one-file change.

---

### Task 1: Admin data layer + shared console primitives

**Files:**
- Create: `platform-ui/src/lib/admin.ts` (server-only)
- Create: `platform-ui/src/components/systems/StatusDot.tsx`, `ConnectionState.tsx`, `StatusCard.tsx`, `systems.css`
- Test: `platform-ui/src/lib/admin.test.ts` (pure helpers), `platform-ui/src/components/systems/StatusDot.test.tsx`

**Interfaces:**
- Produces (consumed by Tasks 2–5):
  - `lib/admin.ts` (all `import "server-only"`): `type SystemKey = "bot"|"gateway"|"hub"|"agents"|"knowledge"|"automation"`; `interface SystemStatus { ok: boolean; version?: string; uptimeSec?: number; counters?: Record<string, number|string>; detail?: Record<string, unknown> }`; `interface ConfigField { key: string; label: string; value: unknown; kind: "text"|"number"|"boolean"|"select"|"secretPresence"; options?: string[]; editable: boolean }`; `getSystemStatus(userId, system): Promise<SystemStatus|null>`; `getSystemConfig(userId, system): Promise<ConfigField[]>` (→ [] when absent); plus optional extra readers `getEgressAudit(userId): Promise<AuditRow[]>`, `getHubTools(userId): Promise<HubTool[]>`, `getAgentGoals(userId, tenantId): Promise<AgentGoal[]>`, `getKnowledgeSources(userId, tenantId): Promise<KnowledgeSource[]>` — all `skipUnavailable → []`. Export the row/type shapes.
  - `formatUptime(sec: number): string` (pure — e.g. 90061 → "1d 1h 1m"); tested.
  - `StatusDot({ ok }: { ok: boolean|null })` — a small colored dot (green ok / rust down / champagne unknown) + label ("Online"/"Down"/"Unknown").
  - `ConnectionState({ system }: { system: string })` — the standard "not connected yet" Card.
  - `StatusCard({ status }: { status: SystemStatus|null })` — renders StatusDot + version + uptime + counters KPIs, or ConnectionState when null.

- [ ] **Step 1: Write failing tests** — `admin.test.ts` for `formatUptime` (0→"0m", 61→"1m", 3661→"1h 1m", 90061→"1d 1h 1m"); `StatusDot.test.tsx` (ok=true renders "Online" + green; ok=false "Down"; ok=null "Unknown").
- [ ] **Step 2: Run RED** — `cd platform-ui && npm test`.
- [ ] **Step 3: Implement** `lib/admin.ts` (mirror `lib/entities.ts`'s `platformFetch`+`skipUnavailable` style; `import "server-only"`), the three components + `systems.css`, and `formatUptime`.
- [ ] **Step 4: GREEN** — `npm test`; `npx tsc --noEmit` clean; `npx next build`.
- [ ] **Step 5: Commit** — `git commit -m "feat(platform-ui): admin/systems data layer + status console primitives (ERP UI plan 3, task 1)" -- platform-ui/src/lib/admin.ts platform-ui/src/lib/admin.test.ts platform-ui/src/components/systems`

---

### Task 2: Bot + Automation pages

**Files:**
- Create: `platform-ui/src/app/(app)/systems/bot/page.tsx`, `platform-ui/src/app/(app)/systems/bot/actions.ts`
- Create: `platform-ui/src/app/(app)/systems/automation/page.tsx`
- Test: none new (composition); build + tsc gate

**Interfaces:**
- Consumes: `getSystemStatus("bot")`, `getSystemConfig("bot")`, `getSystemStatus("automation")`, primitives, `StatusCard`, `ConnectionState`.
- Produces:
  - `/systems/bot` — PageHeader (eyebrow "Systems", title "WhatsApp / Telegram Bot"); `StatusCard` (uptime, counters like messages/digests); a "Configuration" Card listing `getSystemConfig("bot")` fields via `DescriptionList` (secretPresence → StatusBadge "Configured"/"Absent"); editable safe fields (e.g. digest opt-in, schedule) rendered as a small form calling `updateBotConfig` (server action, PUT `/api/admin/bot/config`, graceful 404/405 message). Group registry + media pipeline + Telegram fallback shown as read-only status rows from `status.detail`/counters when present, else a quiet "details appear once the bot admin API is connected." Never render message content.
  - `/systems/automation` — PageHeader ("Automation"); StatusCard; a workflows Card (from `status.detail.workflows` if present → HairlineTable name/status/lastRun, else ConnectionState) + an external "Open n8n" Button-link (href from `status.detail.n8nUrl` if present, else disabled with a note).
  - `actions.ts`: `updateBotConfig(key, formData)` — PUT config, catch 404/405 → friendly message, revalidate `/systems/bot`.

- [ ] Step 1: Implement `bot/actions.ts` (updateBotConfig; redirect-free so full try/catch OK, return {ok}/{error}). Step 2: Implement the two pages. Step 3: Verify `npm test`/`tsc`/`build`. Step 4: Commit `-- platform-ui/src/app/(app)/systems/bot platform-ui/src/app/(app)/systems/automation`.

---

### Task 3: AI Gateway + MCP Hub pages

**Files:**
- Create: `platform-ui/src/app/(app)/systems/gateway/page.tsx`, `.../systems/gateway/actions.ts`
- Create: `platform-ui/src/app/(app)/systems/hub/page.tsx`
- Test: none new; build + tsc gate

**Interfaces:**
- Consumes: `getSystemStatus/Config("gateway")`, `getEgressAudit`, `getSystemStatus/Config("hub")`, `getHubTools`, primitives.
- Produces:
  - `/systems/gateway` — PageHeader ("AI Gateway"); StatusCard (counters: daily spend, cap, breaker state); Configuration Card: provider chain order (from config field `providers` → shown as an ordered list; editing deferred to a note or a simple comma-list Field), daily cost cap (editable number Field → `updateGatewayConfig`), DLP toggles (boolean Fields), **key presence** badges (secretPresence fields → "Configured"/"Absent", never values); an Egress Audit Card (from `getEgressAudit` → HairlineTable time/provider/decision, else quiet empty). 
  - `/systems/hub` — PageHeader ("MCP Hub"); StatusCard; Tool Registry Card (from `getHubTools` → HairlineTable tool/description/minAssurance, else ConnectionState); per-principal tool-visibility policy shown read-only from config when present (editing deferred with a note).
  - `gateway/actions.ts`: `updateGatewayConfig(key, formData)` — PUT, graceful, revalidate.

- [ ] Step 1: gateway actions. Step 2: both pages. Step 3: verify. Step 4: commit `-- platform-ui/src/app/(app)/systems/gateway platform-ui/src/app/(app)/systems/hub`.

---

### Task 4: AI Agents + Knowledge pages (Intelligence group)

**Files:**
- Create: `platform-ui/src/app/(app)/agents/page.tsx`
- Create: `platform-ui/src/app/(app)/knowledge/page.tsx`
- Test: none new; build + tsc gate

**Interfaces:**
- Consumes: `getAgentGoals(userId, tenantId)`, `getKnowledgeSources(userId, tenantId)`, `getSystemStatus("agents"|"knowledge")`, primitives.
- Produces:
  - `/agents` — PageHeader (eyebrow "Intelligence", title "AI Agents"); StatusCard; Goals Card (from `getAgentGoals` → HairlineTable goal/status/budget-spent/fan-out, else ConnectionState); a read-only note that run history + blackboard inspection arrive with the agents admin API. Tenant-scoped.
  - `/knowledge` — PageHeader ("Knowledge"); StatusCard; Sources Card (from `getKnowledgeSources` → HairlineTable source/provenance/status, else ConnectionState); a Quarantine section (sources with status "quarantined" → listed with approve/reject buttons wired to a graceful server action that shows "not available yet" until backend); a disabled "Search test console" input with a note. Tenant-scoped. No document content rendered — metadata only.

- [ ] Step 1: (optional) a `knowledge/actions.ts` with a graceful `reviewSource(id, decision)` action. Step 2: both pages. Step 3: verify. Step 4: commit `-- platform-ui/src/app/(app)/agents platform-ui/src/app/(app)/knowledge`.

---

### Task 5: Docs sync

**Files:** Modify (only if currently clean — check `git status` first, skip any dirty from the backend session): `docs/superpowers/plans/2026-07-05-CHECKLIST.md`, `CLAUDE.md`.

- [ ] Step 1: Add a "Plan 3 — Systems & Intelligence consoles (UI)" subsection under Phase 5 marking the console pages done (☑) and the admin-API endpoints as ☐ backend dependencies. Extend the `platform-ui/` CLAUDE.md bullet.
- [ ] Step 2: Commit clean docs only, pathspec form: `git commit -m "docs: ERP UI plan 3 (systems/intelligence consoles, UI) complete" -- <clean files>`. If all dirty, make no commit and note it.

---

## Notes
- These consoles are intentionally read-oriented + graceful: they establish the UI and the admin-API contract while the backend session builds the endpoints. When `/api/admin/:system/*` lands, the pages populate automatically.
- The nav links for these routes already exist (Plan 1 shell); building these pages removes them from the `[...placeholder]` catch-all.
- Follow-up: Plan 4 (Admin section + step-up), Plan 5 (polish + deferred minors).
