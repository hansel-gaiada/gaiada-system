# Agentic-native ERP — readiness plan

Status: **OPEN**. Owner-approved 2026-08-03. **Close this document before staging.**

## How to use this

This is a **late-dev checklist**, not a build ticket set for today. The ERP build continues on its
own track; this document says what "agentic-native" means, measures where each department stands
today, and states the goal per department so the work can be picked up incrementally and closed out
in one pass before staging.

**Read it when:** adding a department capability, wiring a new module surface, or preparing the
staging cut. **Close it when:** every department reaches its "Exit bar" below, or the gap is
explicitly waived by the owner with a reason recorded here.

Agent/persona INTEGRATION is deliberately **deferred and optional** (see "Deferred" at the end).
Nothing in the main plan depends on a persona existing — the point is that the ERP be *ready* for
one, which is a property of the ERP alone.

## The target: one capability, three operating modes

Every department capability must work identically whether driven by a human, by automation, or by an
agent — and at any mix in between:

| Mode | Driver | Must hold |
|---|---|---|
| **Full human** | ERP UI | works today with no agent, no n8n |
| **Assisted** | human + n8n for the scheduled/deterministic parts | same authz, same audit |
| **Agentic** | persona acting for a human | same authz, same audit, bounded by BOTH identities |

The failure mode to avoid: a capability that only exists as a UI interaction. A button whose logic
lives in a React handler is invisible to automation and to agents, and will have to be rebuilt.
**The UI must be one client of the capability, never its definition.**

## The readiness bar

Applies per capability, not per page. A department is ready when every capability it owns passes all
seven.

| # | Criterion | Why | Signal it fails |
|---|---|---|---|
| **1** | **Tool parity.** Everything the UI can do is reachable as an MCP tool with the same authorization. | Agents and n8n only reach the platform through the hub. | Namespace exists with reads but no writes, or no namespace at all. |
| **2** | **Deterministic contract.** Structured request + structured response. Refusals are typed, not prose. | An agent cannot consume free text reliably, and a human UI cannot render it consistently. | Endpoint returns a rendered string; errors only as message text. |
| **3** | **Idempotent writes.** Natural dedupe key or `ON CONFLICT`. | Agents and n8n retry, at-least-once. A retry must not double-create. | No unique constraint; "create" that always inserts. |
| **4** | **Impact-classified writes.** Low → direct; medium/high → D14 approval, and the approval must actually execute on decision. | The gate is what makes agentic writes safe to enable at all. | Write not registered with the impact gate. |
| **5** | **Explicit refusal.** Denials carry a structured reason (Cerbos already returns one). Never an empty list that reads as "no data". | The single worst agentic failure: a denied read presented as "nothing found". | 403/404 collapsed into `[]` by the reader. |
| **6** | **Observable.** Every state change writes `work_activity`/audit with actor + tenant, and the actor may be non-human. | Attribution is the only way to review what an agent did. | Write with no activity row, or actor assumed human. |
| **7** | **One golden case.** A fixture exercising the capability end-to-end, usable as an eval case later. | Without it, agent behaviour on this capability is untestable. | No test drives the real endpoint. |

Criteria **2, 5, 6** are also plain product-quality wins for the human-only ERP — they are worth
doing regardless of whether an agent ever arrives. **1, 3, 4, 7** are the specifically agentic ones.

## Measured baseline — 2026-08-03

MCP hub: **90 tools across 34 namespaces** (live count). BFF contract: **52 BUILT / 19 PENDING**.
Tool counts below are read/write per namespace, taken from the running hub.

| Department / module | Tools (r/w) | Reads as | Biggest gap |
|---|---|---|---|
| **SEO / search-marketing** | 3 / **14** | **Most agentic-native in the estate** | Vendor-cost tools exist; 5 UI tabs still PLANNED (SM-10/16/18/20/22) |
| **Delivery pipeline (WS11)** | 2 / 5 | Good write coverage | D14 resume path broken ⇒ gated writes dead-end |
| **PM (projects/tasks)** | `pm` 1/3, `projects` 2/1, `tasks` 2/2 | Usable | No milestone/dependency/board tools; poly-assignee not tool-exposed |
| **Clients** | 3 / 2 | Usable | No portal-invite tool |
| **Deliverables** | 2 / 2 | Usable | — |
| **Time / timesheets** | 1 / 2 | Usable | No approval/lock tool |
| **HR** | 2 / **1** | **Thin for a department meant to be agentic** | Leave/attendance/cases/onboarding not tool-reachable |
| **Reports / appraisals** | `reports` 4 / **0** | Read-only | No seal/recompute/cycle tools; **no `appraisals` namespace at all** |
| **Knowledge** | 3 / **0** | Read-only | No ingest/quarantine-decision tools |
| **IT** | **1 / 0** | **Barely reachable** | Device register/edit/discovery all UI-only |
| **Agency** | 2 / **0** | Read-only | Campaign/approval writes UI-only |
| **Billing / invoices** | **none** | **Not reachable at all** | No namespace |
| **Org structure / people / companies** | **none** | **Not reachable at all** | Onboarding, placement, role grants all UI-only |
| **Compliance gates** | 1 / 0 | Read-only | Gate decisions UI-only |
| **Creatives** | — (uses `image`/`vision`/`design` 1/0 each) | Generation seams only | Asset lifecycle not tool-reachable |
| **Social media** | none | Module `0.0.0` PLANNED | Whole module |
| **Web Dev** | `github` 1/1, `deploy` 0/2, `code` 1/0 | Real dev-loop coverage | Webdesk `0.0.0` PLANNED |
| **GM** | borrows `clients` 3/2, `projects` 2/1, `reports` 4/0; **`billing` none** | Owns the commercial spine | **Invoicing is not tool-reachable at all**; no cross-department aggregate tool |
| **Operations** (Sanur) | — | Console renders, owns no capabilities | Scope still undefined — see open question |

## Goals per department

Each goal is "what must be true before staging". Ordered within each department by leverage.

### Cross-cutting — do these first, they unblock everything

1. **Fix the D14 resume path.** Approving a suspended write currently executes **nothing**. Criterion 4
   is unsatisfiable estate-wide until this lands. This is the single highest-leverage item in the
   document.
2. **`users.kind` migration** (`employee | client | automation | bot`) — see
   `2026-08-03-principal-kinds-design.md`. Every people-shaped surface depends on it, and the interim
   `company_memberships.kind='service'` reuse should not survive to staging.
3. **Audit the reader-degrade pattern for criterion 5.** Several readers fold 403/404 into `[]`
   (found live: the client portal told staff "your kickoff is being processed"). Sweep every
   `safe()`/`skipMissing()` call site and make the refusal explicit.
4. **Structured refusal surface in the UI** — one component rendering a typed deny reason, reused
   wherever authorization can fail.
5. **Impact-classify every existing write** and register it with the gate, so criterion 4 is a
   property of the registry rather than per-endpoint memory.

### HR
- Tool coverage for leave (file/decide), attendance (log), cases (open/transition), onboarding
  (instantiate/complete checklist item). Currently 1 write tool for the whole department.
- Employee onboarding as ONE capability: invite → Keycloak user (provisioner exists, verified) →
  membership → role → org placement → checklist. Today these are separate UI steps and the invite
  does not provision a login.
- Exclude service accounts from every people count (done as interim; revisit with `users.kind`).

### IT
- Device register / edit / delete / discovery-trigger as tools. Currently one read tool.
- Discovery run as an idempotent, re-drivable capability (it already exists in-app — expose it).
- Alert acknowledge / resolve as gated writes.

### SEO / search-marketing
- Closest to the bar already — hold the line: every new SM ticket ships its tool with its endpoint.
- Land the 5 PLANNED tabs (SM-10/16/18/20/22); they are labelled and contract-documented.
- Keep the paid-vendor rule intact: automation must never trigger a paid pull (SM-54/55 ruling).

### PM
- Milestones, dependencies, board moves, poly-assignee changes as tools.
- Recurring-task generation must be idempotent (it is scheduled — criterion 3 applies hardest here).

### Reports / appraisals
- Seal, recompute, and export as tools; `appraisals` namespace does not exist yet.
- Cycle open/generate/transition as tools.
- Fact history starts 2026-08-03 — reports cannot be meaningfully evaluated before ~2 weeks of facts
  accumulate. Plan the eval cases for late dev, not now.

### Clients / billing — **owned by GM**, see the GM section for why this is top priority
- `billing` namespace from scratch: invoice create/send/mark-paid, all impact-classified. Money moves
  here, so this is the clearest place the D14 gate has to work before any automation touches it.
- Client portal invite as a tool (pairs with W0-3's Keycloak provisioning, already built).

### Knowledge
- Ingest trigger and quarantine decision as tools (currently read-only).
- Sweep completeness must be verifiable — "0 errors" already proved insufficient once.

### Agency
- Campaign and approval writes as tools.

### Creatives
- Asset lifecycle (upload → variant → approve → publish) as tools. The generation seams
  (`image`/`vision`/`design`) exist; the lifecycle around them does not.

### Web Dev
- Best dev-loop coverage in the estate (`github`, `deploy`, `code`). Extend to the webdesk module
  when it leaves `0.0.0`.

### Social Media
- Module is `0.0.0` PLANNED, **being built in a separate session.** It is the last department that can
  be built TO this bar instead of retrofitted onto it — that option disappears the moment it ships,
  so hand this document to whoever builds it before they start.

### GM — the commercial spine (scope settled 2026-08-03)
Owns **clients, projects, invoices** and the general-manager duties around them; **oversees** the other
departments through aggregate views rather than owning their work. Two distinct halves, and they fail
differently:

- **Owned capabilities.** `clients` (3/2) and `projects` (2/1) have tools; **invoicing has no
  namespace at all.** GM is therefore the department most damaged by the missing `billing` tools —
  quote → invoice → send → chase → mark-paid is the one GM loop with zero automation surface, and
  it is the loop with money in it. Build `billing` to the bar first, not last.
- **Oversight views.** "Overview the departments" needs cross-department aggregation, and the only
  general cross-tenant/cross-unit reader in the estate is the HR envelope fan-out (`fanOutHr`) plus
  `reports` (4 read tools, 0 write). There is no generic aggregate tool. Decide deliberately whether
  GM oversight is: (a) `reports` grains pointed at the GM scope — cheapest, reuses the sealed-period
  machinery and gets honest partial-period warnings for free; or (b) a bespoke GM aggregate endpoint.
  **Prefer (a)** — a second aggregation path will drift from the first, and reports already solves
  time-awareness, which is the hard part.
- Approvals already fan in correctly across agency/pipeline/HR/automation/agent, so the GM
  decision queue needs no new mechanism — only scoping.
- Criterion 5 (explicit refusal) matters more here than anywhere: a GM overview that silently omits a
  department it cannot read looks identical to a department with no work. It must say which
  departments are excluded and why — the envelope pattern already does this; reuse it.

### Operations (Sanur Resort)
- **Open question, still unanswered:** the console renders but owns no capabilities. Until its scope is
  defined the bar cannot be applied. Sanur is a resort, not an agency, so it likely needs a different
  capability set than the Gaia departments rather than a copy of one.

## Exit bar — what "closed before staging" means

1. Every department row above is either at the bar or has a **recorded waiver** with a reason.
2. D14 resume path fixed; every write impact-classified.
3. `users.kind` shipped; no service account counted as a person anywhere.
4. Refusal is explicit everywhere; no reader folds a denial into an empty list.
5. Each department has ≥1 golden case usable as an eval.
6. A capability inventory exists showing, per capability, its endpoint + its tool + its impact class.
   **If that table cannot be generated, the estate is not agentic-native regardless of how it feels.**

## Deferred — agent/persona integration (late staging, OPTIONAL)

Recorded so the decisions are not re-litigated. Full design:
`2026-08-03-principal-kinds-design.md` (principal kinds) and the analysis below.

**Owner decisions taken 2026-08-03:**
- **One persona per department.** `persona:hr`, `persona:webdev`, `persona:seo`, …
- Personas are **optional** — the ERP must be fully usable with none present.
- Integration happens in **late staging**, after this plan is closed.
- Owner's Discord army stays the owner's. The ERP is a **second front door to the same brain**, not a
  second brain. ERP users are consumers: they may invoke, never see or edit persona configuration.

**The blocking architectural decision, unresolved:** `Principal` holds a single `userId`. OBO resolves
to *either* the human *or* the bot — there is **no delegation**. So "persona helps an employee within
scope, escalates beyond it" cannot be bounded by the employee's own permissions today.

Recommendation on the table (not yet accepted): **effective permission = persona scope ∩ acting
user's permissions** — add `x-act-for`, check Cerbos twice, deny if either denies, audit both.
Alternative is persona-authority plus a redaction layer, which trades an architectural guarantee for
a filter that has to be right every time.

**Also deferred with it:** `agent_personas` registry (personas are hardcoded in `specialists.ts`
today), the ERP ask/answer surface, `orchestrator.ask` as a hub tool rather than a side channel,
per-principal AI budgets, and Hermes-first model routing for cost control (the AI Gateway is already
the only key-holder, with daily + per-tenant caps and ~317 calls/day against a 2000 cap).

**n8n's lane, settled:** deterministic, scheduled, idempotent, approval-gated execution. n8n must not
call models directly. Personas propose; humans decide; n8n executes — which is exactly why the D14
resume path is a prerequisite and not a nicety.
