# Daily-Work UX Spec (UX-2) — Binding

**Date:** 2026-07-20
**Author:** senior-uiux
**Status:** BINDING per Backbone Program plan (GATE-2). Builds on UX-1 (audit + owner interview,
not re-included here). Consumed by: WSB-1 (unified task model ADR), UX-4/UX-5 (build), WSD-4 (HR
workspace reuses the serviced-block pattern), WSE-4 (SSE wiring reuses the same envelope/urgency
model), WSF-1 (exec landing reuses Command Center + envelope).

**Owner decisions this spec builds to (binding, do not relitigate):**
1. Home is role-differentiated: manager-tier → Command Center (A2); IC-tier → Queue+Agenda hybrid
   (A1×A3 fusion). Exact role boundary in §1.3.
2. Default scope = **ALL companies** everywhere (My Work, Tasks, Calendar, Approvals), narrowed by
   the scope pill.
3. Unified Approvals inbox, filterable by origin, urgency-sorted (3B confirmed).
4. Shared-service scope defaults to **ALL served companies** (labeled slices) + a one-company
   focus selector; permission-hidden companies show as a "N more you can't view" count, never
   silently dropped.

**Hard dependency:** every surface below assumes **A4** (`platform-ui/src/lib/rbac.ts`
`scopeCovers` fix — team-scope no longer blanket-covers; null-scoped company grant no longer
covers all companies — and `holding_head` removed as ORG-7/ORG-12 supersede it with
`serviceScopes`) lands **before** UX-4/UX-5 build against this spec. Until then, build against
current `rbac.ts` behind a flag and re-verify once A4 merges.

---

## 1. Role-differentiated Home

### 1.1 Component structure (both variants)

File: `platform-ui/src/app/(app)/page.tsx` (rewritten), new sub-components under
`platform-ui/src/components/dashboard/`:

```
page.tsx (MyWork — server component)
├─ resolves `isManagerTier(me)` (new helper, §1.3) → picks variant
├─ ScopePill (shared primitive, §4) — scope state in the URL: ?scope=all|<companyId>
├─ CommandCenterHome           (manager-tier)          — components/dashboard/CommandCenterHome.tsx
│   ├─ FilterChips             (was KpiTile row)        — components/dashboard/FilterChips.tsx
│   ├─ NeedsMeQueue            (shared, §1.4)           — components/dashboard/NeedsMeQueue.tsx
│   └─ ThroughputSparkline     (demoted chart)          — components/dashboard/ThroughputSparkline.tsx
└─ QueueAgendaHome             (IC-tier)                — components/dashboard/QueueAgendaHome.tsx
    ├─ NeedsMeQueue            (shared, §1.4)
    └─ TodayAgenda             (bucketed, from Calendar's bucketing fn) — components/dashboard/TodayAgenda.tsx
```

`lib/data.ts` changes: `getMyTasks`/`getActivity` become cross-company fan-outs (see contract
delta (b)); add `getMyWorkQueue(userId, scopeCompanyIds)` that merges approvals + tasks + pipeline
gates + mentions into one ranked `QueueItem[]` (client-side merge of existing typed rows — no new
merge endpoint required, this is UI composition over contract deltas (a)+(b)).

### 1.2 The two variants

**Command Center (manager-tier)** — hero is the queue; KPI tiles become **clickable filter
chips** that filter the queue below, not static vanity numbers; a demoted sparkline keeps glance
value without leading.

```
┌ Good morning, Hansel ─ Scope:[ All companies (5) ▾ ] ──────────────────┐
│ [Overdue 3][Due today 5][Approvals 4][Mentions 2]  ← click = filter    │
├─────────────────────────────────────────────────────────────────────────┤
│ NEEDS YOU (ranked)                                    ⌢‿⌣ 8-wk sparkline│
│ ● NOW   Approve hero asset — Summer      · Viceroy    [Approve][View]  │
│ ● NOW   Gate: prototype sign-off         · Gaia/PM    [Approve][Chg]   │
│ ○ TODAY Ship SEO audit                   · Gaia       [Open][Done]     │
│ ○ TODAY @mention — Dinda, "Landing copy" · Gaia       [Reply][Open]    │
│ ─ SOON  Leave request — Andi (3 days)    · Viceroy    [Approve][Deny]  │
└─────────────────────────────────────────────────────────────────────────┘
```

**Queue + Agenda hybrid (IC-tier)** — no chips/chart; queue on the left (same ranked list, same
`NeedsMeQueue` component), a compact day/week agenda on the right fused from A3.

```
┌ Good morning, Dinda ─ Scope:[ All companies (2) ▾ ] ───────────────────┐
├─ NEEDS YOU (6) ──────────────────┬─ TODAY · THU 17 JUL ─────────────────┐
│ ● NOW  Reply @Hansel comment      │ OVERDUE (1)  ▸ Landing copy review   │
│ ○ Ship SEO audit · due 5pm        │ TODAY        ▸ Ship SEO audit · 5pm  │
│ ─ Review invoice draft · Fri      │ TOMORROW     ▸ Client call notes     │
│                                   │ NO DATE (4)  ▸ …                     │
└───────────────────────────────────┴───────────────────────────────────────┘
```

### 1.3 Role boundary (exact, mapped onto `lib/rbac.ts`)

New helper in `lib/rbac.ts`:

```ts
// Command Center vs Queue+Agenda hybrid. Keyed on role, not capability, so it
// stays a simple lookup — independent of scope. holding_head resolved by A4/
// ORG-12 into serviceScopes; treat as manager-tier until then (view-all implies
// oversight framing).
const MANAGER_TIER: Set<Role> = new Set([
  "platform_admin", "group_executive", "holding_head",
  "company_admin", "manager", "it_admin", "it_manager",
]);
export function isManagerTier(me: Me): boolean {
  return me.roles.some((r) => MANAGER_TIER.has(r.role as Role));
}
// Everyone else (member, it) gets the Queue+Agenda hybrid.
```

If a user holds grants of both tiers (e.g. `manager` in company A, `member` in company B),
**manager-tier wins** — the boundary is "any grant qualifies," not "every grant qualifies."

### 1.4 `NeedsMeQueue` — shared ranked list (used by both variants)

- **Sort:** urgency score = `f(dueDate/age, priority, type-weight)` — pending owner tuning (Q13
  was left open, see §7); ship with a documented default: overdue approvals/gates first, then
  overdue tasks, then due-today items by due time, then everything else by age descending.
  Expose the weight table as a named const (`lib/queueUrgency.ts`) so it's a one-file tuning knob.
- **Row shape:** icon/dot (urgency), type badge (Task / Approval / Gate / Mention / HR), title
  (linked), company badge, due/age, inline actions (Approve/Deny, Open/Done, Reply/Open) matching
  the item's origin.
- **Grouping:** flat ranked list by default; a "Group by company" toggle for scope=all (owner may
  want this — flag as open, §7).

### 1.5 States

| State | Behavior |
|---|---|
| Loading | Skeleton rows (existing `Card` skeleton pattern) — no spinner-only screen. |
| Empty (queue) | "Nothing needs you right now." + a link to Calendar/Tasks (don't dead-end). |
| Empty (agenda, IC variant) | "Nothing scheduled." |
| Error (one source fails) | Partial render: sources that succeeded still show; a small inline notice "Some approvals couldn't load" — never blank the whole page for one failing fan-out leg (mirrors existing `getPendingApprovals` per-tenant try/catch). |
| Partial-view (scope narrowed by permission) | Envelope banner from §4 above the queue: "Showing 3 of 5 companies scope." |

### 1.6 RBAC/scope behavior

- Default scope = **all companies the user can reach** (`accessibleCompanies(me)` today;
  post-A4 `serviceScopes`-aware equivalent). Scope pill narrows to one company or a served subset.
  Persisted per-user as a query param + `lib/prefs.ts` remembered default (last-used scope).
- Capability gates on **actions**, not visibility of the row: an approval row renders for anyone
  whose company is in scope, but `Approve`/`Deny` only renders if `can(me, "approvals.decide",
  companyId)` is true for that item's company — otherwise the row shows a "View" link only.

### 1.7 Files touched (build tickets, not this ticket)

- Rewrite: `platform-ui/src/app/(app)/page.tsx`
- New: `components/dashboard/CommandCenterHome.tsx`, `QueueAgendaHome.tsx`, `NeedsMeQueue.tsx`,
  `FilterChips.tsx`, `TodayAgenda.tsx`, `ThroughputSparkline.tsx` (extract from existing
  `LineChart` usage), `lib/queueUrgency.ts`
- Edit: `lib/rbac.ts` (`isManagerTier`), `lib/data.ts` (cross-company fan-out + `getMyWorkQueue`)
- Reuse as-is: `components/LineChart.tsx`, `components/ui` (`Card`, `KpiTile` retired from Home,
  kept for other pages), `components/dashboard/ApprovalsPanel.tsx` (becomes one row-renderer
  inside `NeedsMeQueue`, not its own Card)

---

## 2. Unified Approvals inbox (3B, approved as-is)

### 2.1 Component structure

File: `platform-ui/src/app/(app)/approvals/page.tsx` (rewritten).

```
approvals/page.tsx
├─ ScopePill (§4)
├─ OriginFilterBar               — components/approvals/OriginFilterBar.tsx  (chips: All/Agency/Pipeline/Automation/Agent/HR)
├─ ApprovalsList (urgency-sorted)— components/approvals/ApprovalsList.tsx (replaces per-company Card loop)
│   └─ ApprovalRow               — components/approvals/ApprovalRow.tsx (origin badge, preview affordance, decide buttons)
└─ DecidedHistory (filterable)   — components/approvals/DecidedHistory.tsx
```

`lib/approvals.ts` (new, replaces the approvals half of `lib/data.ts`): wraps contract delta (a);
`lib/pipeline.ts`'s `listInternalPendingGates` becomes one origin source feeding the same list
(the `/pipeline` page keeps its **Runs** table but its gate-review card is removed — it's now a
scope+origin=pipeline view of `/approvals`, reachable via a "View in Approvals" link from
`/pipeline` for continuity).

### 2.2 Layout

```
┌ APPROVALS ─ Scope:[ All companies (5) ▾ ] ────────────────────────────┐
│ [All 12][Agency 4][Pipeline 3][HR 2][Automation 2][Agent 1]            │
├──────────────────────────────────────────────────────────────────────┤
│ ⏱ 2d  AGENCY    Hero asset "Summer"    Viceroy   [Preview][✓][✗]      │
│ ⏱ 6h  PIPELINE  Prototype sign-off     Gaia/PM   [Open][✓][Changes]   │
│ ⏱ 1h  HR        Leave — Andi (3 days)  Viceroy   [✓][✗]               │
│ ⏱ new AUTOMATION Reassign orphaned work Gaia      [Review][✓][✗]      │
├─ Recently decided ─ [origin ▾][company ▾] ────────────────────────────┤
│ ✓ Approved  Invoice #1042   Agency   2h ago  by you                   │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.3 States

| State | Behavior |
|---|---|
| Loading | Skeleton rows per origin as each fan-out leg resolves independently (don't block fast origins on slow ones). |
| Empty (all clear) | "Nothing awaiting your review." — kept from current copy. |
| Empty (one origin filtered) | "No {origin} items pending." with a "Show all origins" link. |
| Error (one origin's backend down) | That origin's rows omitted, banner: "Automation approvals unavailable right now" — never blank the page. |
| Partial-view (scope) | Envelope banner (§4): "Showing 4 of 5 companies — 1 excluded (no access)." |

### 2.4 RBAC/scope behavior

- Default scope = all companies (owner decision 2). `Approve`/`Deny` buttons gate per-row on
  `can(me, "approvals.decide", item.companyId)`; ungated rows render read-only with a "View" link
  — never hidden (matches curl-vs-UI parity rule from ORG-14).
- Origin visibility itself may be capability-gated later (e.g. HR approvals need `hr_manager`) —
  the origin chip for a type the user can never decide in any company is hidden entirely (no
  point offering a filter with zero possible rows); this is a UI nicety, not a security boundary
  (Cerbos/RLS still authoritative on the read).

### 2.5 Files touched (build tickets)

- Rewrite: `platform-ui/src/app/(app)/approvals/page.tsx`
- New: `lib/approvals.ts`, `components/approvals/{OriginFilterBar,ApprovalsList,ApprovalRow,DecidedHistory}.tsx`
- Edit: `platform-ui/src/app/(app)/pipeline/page.tsx` (remove inline gate-review card, add
  "Review in Approvals →" link), retire the gate-decide half of `lib/pipelineActions.ts`'s UI
  surface (endpoint stays; decide action now issues through the unified decide call, contract (a))
- Delete/fold: the approvals half of `lib/data.ts` (`getPendingApprovals`, `getDecidedApprovals`)
  moves into `lib/approvals.ts`

---

## 3. Department / division workspace — focus model + serviced block

### 3.1 Component structure

Files: `platform-ui/src/app/(app)/departments/[deptId]/page.tsx` (rewritten), new
`platform-ui/src/app/(app)/departments/[deptId]/page.tsx` reads `?focus=` query.

```
departments/[deptId]/page.tsx
├─ FocusControl                — components/departments/FocusControl.tsx  (Whole dept / Division:<name> / Just me)
├─ HealthStrip                 — components/departments/HealthStrip.tsx   (open · overdue · awaiting review · capacity)
├─ Board (swimlane toggle: Status / Division / Person) — components/pm/Board.tsx (extended)
├─ ServicedBlock (only if this dept serves other companies) — components/departments/ServicedBlock.tsx
│   └─ ScopePill (§4) scoped to "served companies" set
└─ DivisionsAndPeople (existing card, unchanged)
```

`lib/departments.ts` changes: `getDepartment` gains a `focus` param
(`{ mode: "dept" | "division" | "me"; divisionId?: string; userId?: string }`) that filters
`dept.tasks` before grouping into board columns — pure filter over the existing `belongs()`
result, no new backend call. A **new** reader `getServicedCompanies(u, t, deptId)` backs the
Serviced block; until ORG-13 ships it returns `{ items: [], companies: [] }` (empty envelope) —
**this block renders nothing until service_assignments exists**, by design (no fake data).

### 3.2 Layout

```
┌ DEPARTMENT · Web Dev ─ Gaia ─ [Board][People][Docs][Activity] ────────┐
│ Focus: [ Whole dept ▾ ]   (Whole dept · Division: SEO · Just me)       │
│ ● 6 open · 2 overdue · 3 awaiting review · capacity 82%                │
├── BOARD  Group by: [Status ▾ | Division | Person] ────────────────────┤
│  To do        In progress     Blocked        Done                     │
│  [card]       [card]          [card]         [card]                   │
│  + Add here                                                            │
└─────────────────────────────────────────────────────────────────────────┘

  SERVICED (renders only when service_assignments exist for this unit):
  ┌ Scope: [ All served (3) ▾ ]  Viceroy · Sanur-Villas +1 you can't view ┐
  │ Showing 2 of 3 served companies — 1 excluded (no access).  [why?]     │
  └──────────────────────────────────────────────────────────────────────┘
```

### 3.3 States

| State | Behavior |
|---|---|
| Loading | Existing Card skeleton. |
| Empty (no tasks in focus) | "No work routed to {focus label} yet." — copy varies by focus mode. |
| Empty (division has no people) | Kept from current: "No one placed yet." |
| Error (org structure unavailable) | `notFound()` if the department itself can't resolve (unchanged); if only the Serviced block's read fails, the block hides silently (it's additive, not core). |
| Partial-view (serviced companies, permission-narrowed) | Envelope banner per owner decision 4: **"N more you can't view"** count, never silent — this is the literal shared-service acceptance case (WSD-7). |
| Not-serviced (default today) | Serviced block does not render at all — no empty-state clutter for the 99% of departments that don't serve other companies yet. |

### 3.4 RBAC/scope behavior

- `Focus: Just me` is available to anyone viewing the department (it's a client-side filter over
  data they already loaded, not a new permission).
- The Serviced block's default scope = **ALL served companies** (owner decision 4), each rendered
  as a labeled slice; a selector narrows to one. Hidden-by-permission companies are counted, never
  omitted without a count (`companies[].included=false, reason:"no_access"` in the envelope, §4)
  — rendered as "N more you can't view", not silently dropped.
- Gated by `can(me, "org.edit", tenant)` for the "Edit structure" action only; the workspace itself
  is readable by anyone with `people.directory` or department membership (existing behavior kept).

### 3.5 Files touched (build tickets)

- Rewrite: `platform-ui/src/app/(app)/departments/[deptId]/page.tsx`
- New: `components/departments/{FocusControl,HealthStrip,ServicedBlock}.tsx`,
  `lib/serviceAssignments.ts` (thin reader, degrades to empty envelope pre-ORG-13)
- Edit: `lib/departments.ts` (`getDepartment` focus param; new `getServicedCompanies`),
  `components/pm/Board.tsx` (swimlane-by prop: status/division/person)
- No new route for divisions — confirmed by owner framing (division = filter, not a page); revisit
  only if usage data says otherwise (flag in §7 as a soft open item, not blocking).

---

## 4. Scope-pill + inclusion-envelope primitive (3D, confirmed reusable)

This is the one control + one response shape reused by §1, §2, §3, and later WSD-4/WSF-1.

### 4.1 Component

New: `platform-ui/src/components/scope/ScopePill.tsx` + `platform-ui/src/components/scope/EnvelopeBanner.tsx`.

```tsx
// ScopePill.tsx — controlled by a `?scope=all|<companyId>` URL param, shared across
// My Work / Tasks / Calendar / Approvals / Departments-serviced-block.
interface ScopePillProps {
  companies: { id: string; name: string }[]; // the user's reachable set for THIS surface
  value: "all" | string;                     // current scope
  onChangeHref: (v: "all" | string) => string; // pure href builder (server-component friendly)
  countLabel?: string;                        // e.g. "5" or "3 served"
}
```

Server-component friendly: renders as a `<Link>`-based dropdown (no client JS required for the
common case — a `<details>`/native select fallback), matching the repo's existing
mostly-server-component pattern (`PageHeader`, `Breadcrumbs`).

### 4.2 The envelope response shape (canonical, used by every ALL fan-out)

```ts
// lib/envelope.ts (new) — the ONE shape every cross-company/cross-served-company
// read returns when scope=all (or a served-company set). `included` companies with
// a `reason` are shown as a "N more" count, never dropped without one.
export interface EnvelopeCompany {
  id: string;
  name: string;
  included: boolean;
  reason?: "no_access" | "not_served" | "suspended" | "error";
}
export interface Envelope<T> {
  items: T[];
  companies: EnvelopeCompany[];
}
```

`EnvelopeBanner` renders nothing when every `companies[].included === true`; otherwise renders:
`"Showing {included.length} of {companies.length} companies — {excluded.length} excluded
({reasons}). [why?]"` — the `[why?]` expands the excluded list with each `reason`.

### 4.3 States

| State | Behavior |
|---|---|
| Single company reachable | Pill renders as a static label, not a dropdown (matches existing `canSwitchCompany` pattern in `rbac.ts`). |
| All included | No banner. |
| Some excluded | Banner renders per §4.2; excluded companies never appear in `items`, only in the count. |
| Scope=one company selected | No banner (envelope is an ALL-scope concern only); pill shows the one company. |

### 4.4 RBAC/scope behavior

- `companies` passed into `ScopePill` = the surface-appropriate reachable set: `accessibleCompanies(me)`
  for My Work/Tasks/Calendar/Approvals; the department's `serviceScopes`-derived served-company set
  for the Serviced block (post-ORG-13).
- The envelope's `reason` values are advisory copy only — Cerbos/RLS decide inclusion; the UI never
  invents a reason, it renders what the backend returns (default `"no_access"` if the backend omits
  it, per contract delta (d) below).

### 4.5 Files touched

- New: `components/scope/ScopePill.tsx`, `components/scope/EnvelopeBanner.tsx`, `lib/envelope.ts`
- Consumed by (edits noted per-surface above): Home, Approvals, Departments (serviced block); Tasks
  and Calendar per §5 follow-on deltas.

---

## 5. Follow-on deltas (brief — not full specs this ticket)

| Surface | Delta | Owner |
|---|---|---|
| **Tasks** (`app/(app)/tasks/page.tsx`) | Add `ScopePill` (default all companies, per decision 2); add a company column when scope=all; add urgency default sort; keep DataTable as the underlying list — no kanban added here (kanban lives in department workspaces per §3). | UX-4/medior build ticket |
| **Calendar** (`app/(app)/calendar/page.tsx`) | Add `ScopePill` (default all companies); its bucketing logic (`bucketLabel`) becomes the shared source for `TodayAgenda` in §1.2 — extract to `lib/agenda.ts` so Home and Calendar share one implementation instead of duplicating. Week/month grid view and drag-to-reschedule are **explicitly deferred** (owner didn't confirm Q9 — flagged open, §7). | follow-on ticket, not UX-4/5 |
| **Notifications** (`app/(app)/notifications/page.tsx`) | Consume contract delta (c) — typed payload replaces the `summarize()` best-effort field-guessing; mentions become a `NeedsMeQueue` row type per §1.4 (a mention is both a notification AND a queue item — the queue reads the same typed payload). Per-item read / mute prefs stay WSG-4 scope (unchanged). | follow-on ticket (WSG-4 + this contract delta) |

---

## 6. Binding contract deltas — paste into `docs/FRONTEND-BFF-CONTRACT.md`

Add as a new **§4a. Unified daily-work reads** section (or fold into existing §4/§1 rows — table
format matches the doc's existing convention: `Status | Method | Path | Body → Response | Notes`).

### (a) Unified cross-origin + cross-company approvals read

| Status | Method | Path | Body → Response | Notes |
|---|---|---|---|---|
| ⛔ PENDING | GET | `/api/approvals?scope=all\|<companyId>&origin=agency,pipeline,hr,automation,agent&status=pending\|decided&sort=urgency\|age&limit=` | → `Envelope<UnifiedApprovalItem>` | **New cross-company, cross-origin aggregate.** Replaces per-tenant `/api/:t/modules/agency/approvals/pending` as the UI's primary read (that endpoint stays as the agency-origin's own decide target). Server fans out to each origin's existing pending-approvals source (agency approvals, pipeline gates §WSE-8/pipeline-portal, hr leave once WSD-3 lands, automation/agent requests once WSE surfaces them) and merges + urgency-sorts server-side. `companyIds` optional narrowing param when scope≠all. |
| ⛔ PENDING | POST | `/api/:t/approvals/:id/decide` | `{origin: "agency"\|"pipeline"\|"hr"\|"automation"\|"agent", decision: "approved"\|"rejected"\|"changes_requested", note?: string}` → `{ok:true}` | **New generic decide envelope.** Server dispatches to the origin-specific decide handler (agency `/approvals/:id/decide`, pipeline gate decide, hr leave decide) so the UI has one action shape regardless of origin. Existing origin-specific decide endpoints remain the actual writers; this is a routing façade — no new authorization model, `approvals.decide` capability check happens per-origin as today. |

```ts
interface UnifiedApprovalItem {
  id: string;
  origin: "agency" | "pipeline" | "hr" | "automation" | "agent";
  tenantId: string;
  company: string;
  subject: string;          // human label, e.g. "Hero asset — Summer"
  subjectHref?: string;     // deep-link to the underlying record
  previewUrl?: string;      // asset/doc preview if applicable
  createdAt: string;        // ISO
  ageMs: number;            // server-computed, saves the client a clock skew problem
  urgencyScore: number;     // server-computed per the default weighting (see §1.4); UI just sorts by it
  decidable: boolean;       // true if the requesting principal can decide THIS item (approvals.decide for its company)
}
```

### (b) Cross-company My-Work task fan-out

| Status | Method | Path | Body → Response | Notes |
|---|---|---|---|---|
| ⛔ PENDING | GET | `/api/tasks/mine?scope=all\|<companyId>&companyIds=&status=&dueBefore=` | → `Envelope<TaskRow>` | **New cross-company aggregate**, mirrors the pattern `getPendingApprovals` already uses client-side (loop `me.companies`) but moved server-side for efficiency + to emit one envelope. `TaskRow` gains `company: string` and `tenantId: string` fields (today's `/api/:t/tasks?assignee=me` is single-tenant and lacks a company label — keep that endpoint for the single-company Tasks-page path; this new endpoint is additive, for scope=all only). |

```ts
interface TaskRow {
  id: string; title: string; status: string | null; priority: string | null;
  due_date: string | null; project_name: string;
  company: string; tenantId: string; // NEW — required when scope=all
}
```

### (c) Typed, href-bearing notification payloads

| Status | Method | Path | Body → Response | Notes |
|---|---|---|---|---|
| 🟡 PARTIAL → tighten | GET | `/api/:t/notifications[?unread]` | → `NotificationItem[]` (payload now REQUIRED shape below) | Endpoint exists; **the payload contract needs to stop being opaque.** Every writer that creates a notification (agency approvals, pipeline gates, comments/mentions, hr once WSD-3 lands, automation) MUST populate the fields below — the UI currently guesses `title`/`message`/`body`/`href` from unknown keys (`app/(app)/notifications/page.tsx` `summarize()`); that guessing logic is deleted once this lands. |

```ts
interface NotificationPayload {
  title: string;                 // REQUIRED, human-readable, already-capitalized
  body?: string;                 // optional one-line detail
  href: string;                  // REQUIRED, always starts with "/" — deep-link target
  entityType?: string;           // for grouping/analytics
  entityId?: string;
  severity?: "info" | "action_needed"; // action_needed rows are queue-eligible (§1.4)
}
// NotificationItem.payload: NotificationPayload (was Record<string, unknown>)
```

### (d) Inclusion-envelope response shape — standard wrapper for every ALL fan-out

| Status | Method | Path | Body → Response | Notes |
|---|---|---|---|---|
| ⛔ PENDING (shape, not an endpoint) | — | applies to (a), (b), future `/api/scoped/*` (A16/ORG-15), and the department Serviced-block read once ORG-13 ships | `Envelope<T>` wrapping any list | **Standard wrapper — document once, apply everywhere.** Backends implementing ANY cross-company or cross-served-company list MUST wrap it in this shape, not return a bare array. `reason` defaults server-side to `"no_access"` when omitted (contract, not UI guesswork per §4.4). |

```ts
interface EnvelopeCompany {
  id: string; name: string; included: boolean;
  reason?: "no_access" | "not_served" | "suspended" | "error";
}
interface Envelope<T> { items: T[]; companies: EnvelopeCompany[]; }
```

---

## 7. Owner decisions still genuinely open (not blocking UX-4/5, flagged for a follow-up ask)

- **Q13 (urgency weighting):** shipping with a documented default (§1.4); owner may want to retune
  the exact weights once they see it live — non-blocking, one file (`lib/queueUrgency.ts`).
- **Q9 (calendar week/month grid + drag-to-reschedule):** explicitly deferred, not answered in the
  4 decisions relayed — treated as a **follow-on ticket**, not part of UX-4/5's scope.
- **Q10/Q11 (notifications/activity/mentions merge philosophy):** partially resolved by decision
  making mentions a queue-item type (§5), but whether Notifications-the-page stays a separate
  audit-style list or folds entirely into the queue is still open — current spec keeps it
  separate (lowest-risk default) pending owner confirmation.
- **Queue "group by company" toggle (§1.4):** a nice-to-have I flagged, not owner-confirmed either
  way — ship without it, add if requested.
- **Division-as-a-page vs. division-as-filter (§3.5):** owner framing (Q7) implied filter; kept as
  filter-only per the confirmed decisions, flagged as revisit-if-usage-says-otherwise, not open.
