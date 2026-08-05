# Tickets — D14-a resume path + ERP Assistant Phases 0–1

> **Status: PLAN (architect decomposition, 2026-08-05).** Sources:
> `docs/superpowers/plans/2026-08-05-d14-resume-path-plan.md` (all 5 decisions locked, §7) and
> `docs/blueprints/assistant-foundation.md` (4 decisions locked, §2; **phases 0–1 only** here —
> phases 2–6 are deliberately NOT decomposed yet).
>
> All file paths are repo-root-relative (`gaiada-system/`). Model·effort defaults per the agent-army
> standard: seniors Sonnet·high, medior/qa/devops Sonnet·medium, junior Haiku·medium. Opus is tagged
> per-ticket only where flagged.

## 0. Planning-time facts verified against the repo (do not re-derive)

1. **Migration ledger:** head is `0077_mail_core.sql`. Gaps 0058/0059/0070 are dead reservations —
   never reuse a gap. Planning assignment: **D14 = `0078`, assistant = `0079`**. Each migration
   ticket MUST re-verify next-unused by listing `platform-nest/migrations/` at build time (shared
   checkout; numbers race).
2. **The consumer has NO core-handler path.** `platform-nest/src/events/consumer.service.ts`
   dispatches only `ModuleContract.eventHandlers`, gated by `isModuleEnabled(tenantId, mod.key)`.
   The D14 plan's "no wiring change needed" is true for the *stream list* (`"automation_approval"`
   is already in `startConsumerLoop` at `src/main.ts:351`) but NOT for handler registration — a
   core (non-module, non-tenant-gated) handler registry is net-new work (D14-02).
3. **A second EXECUTION pattern exists and must not be broken — it is NOT a second consumer.**
   `platform-nest/src/modules/search/sem-apply.ts:66` explicitly declines to register an
   `automation_approval.decided` eventHandler ("the way HR's leave flow does"), and
   `modules/search/index.ts` carries no such entry — **HR's `applyLeaveDecision` remains the ONLY
   consumer of the decided event.** The search apply path is instead **caller-re-driven**:
   `sem-apply.ts:21` requires the approval id to resolve to a row with `status='approved'` at apply
   time. Consequence encoded below: the D14 executor is **registry-scoped, not origin-scoped** —
   only rows whose `tool_name` is in the executable registry ever get
   `execution_status='pending'`; search/HR/unregistered rows stay `not_applicable` and their
   existing flows are untouched. The reason is twofold: auto-executing a search row would BOTH
   **double-apply** against the caller-re-driven path AND **spend client ad money** (SM-55 /
   architect ruling A13). Money-spending tools NEVER enter the registry. (Do not "fix" the absent
   search handler later — its absence is deliberate.)
4. **The stream path has NO response-side DLP today.** Verified in
   `ai-gateway-go/internal/server/server.go:616-684`: `dlp.DLP` runs on the *prompt* only; streamed
   tokens (and the single-chunk fallback `emit(text)`) go to the wire unscrubbed. ASST-04 is a real
   gap-closure, not a refinement. Also verified: `streamed` is set only after `CompleteStream`
   returns, so a mid-stream provider error after tokens were flushed causes `chain.Run` failover and
   **duplicate output** — fixed in ASST-03.
5. **`companies.settings jsonb NOT NULL DEFAULT '{}'` exists** (`migrations/0001_core.sql:13`) and
   `platform-ui/src/app/(app)/systems/automation/page.tsx` exists — the OQ-5 retry setting has a
   home with zero new schema (constraint: read at execution time, never cached at boot).
6. **Pipeline is core, not a module** (`platform-nest/src/core/pipeline.controller.ts`), so the
   deploy.* executable-registry entries can live in core without violating the
   core-never-imports-modules rule.
7. Cerbos decide policy: `platform-nest/cerbos/policies/resource_automation_approval.yaml`
   (company_admin / group_executive / module_manager-for-hr). Superadmin is ADDED, never replaces
   (D14-06), or the HR leave path regresses.
8. Hub tool-call authorization call-site: `mcp-hub/src/hub.ts` → `authorizeCall` in
   `mcp-hub/src/policy.ts`. The suspension is *only* the `tool.write && tool.impact !== "low"`
   branch (policy.ts:46-52); Cerbos and `AUTOMATION_ALLOWLIST` are separate checks that stay
   untouched.

## 1. Architect-fixed contract: the single-use execution grant

D14-03 (platform) and D14-04 (hub) implement to this contract; neither may unilaterally change it.

- **Transport:** HTTP header `x-approval-grant` on the hub tool call.
- **Value:** `base64url(payloadJson) + "." + base64url(hmacSha256(APPROVAL_GRANT_SECRET, base64url(payloadJson)))`
- **Payload:** `{ v: 1, approvalId, tenantId, toolName, argsSha256, iat, exp, nonce }` with
  `exp − iat ≤ 120s`. `argsSha256` = SHA-256 over canonical JSON (recursively sorted keys) of the
  approval row's stored `tool_args`; the hub recomputes it over the *actual* call args — any
  mismatch is a deny.
- **Hub semantics:** a VALID grant matching `(tenantId, toolName, argsSha256)` skips ONLY the
  impact-suspend branch. Assurance rank, `workflowScope` (AUTOMATION_ALLOWLIST), and Cerbos are
  evaluated **unchanged**. Invalid / expired / mismatched / replayed grant ⇒ the normal
  suspend/deny path. Every grant verdict (accepted / rejected + reason + approvalId) goes to the
  JSONL tool audit.
- **Single-use:** authoritative enforcement is platform-side — the grant is minted only inside the
  `pending → executing` claimed transition (D14-03), which can succeed once per row. The hub
  additionally keeps a best-effort in-memory nonce cache with TTL (v1 hub is single-instance).
- **Secret:** new env `APPROVAL_GRANT_SECRET`, shared by platform-nest and mcp-hub. It MUST be added
  to both services' `environment:` blocks in `infra/compose/docker-compose.vps.yml` (compose
  env-passthrough trap: a var in `.env` does nothing unless listed) and to
  `platform-nest/.env.example`.
- **Authority of the re-driven call:** the ORIGINAL filing principal —
  `origin='automation'` ⇒ OBO `{ provider: "n8n", externalId: <row.workflow_id> }`;
  `origin='agent'` ⇒ OBO for user `<row.requested_by>`. Executing as the approver is REJECTED
  (privilege amplification; superadmin is the standing approver per OQ-1). `executed_by` records
  the principal that ran it, `decided_by` the human who lifted the gate — never conflated.

---

# SET A — D14-a resume path (12 tickets)

### D14-01 — Migration 0078: separate execution state from decision state
- **Seat:** senior-db · Sonnet·high (seat default) — **inline candidate, see §4**
- **Files:** `platform-nest/migrations/0078_automation_approval_execution.sql` (create; re-verify
  the number against `platform-nest/migrations/` first)
- **Content:** `ALTER TABLE automation_approvals ADD COLUMN`:
  `execution_status text NOT NULL DEFAULT 'not_applicable'` with
  `CHECK (execution_status IN ('not_applicable','pending','executing','executed','failed'))`;
  `executed_at timestamptz`; `executed_by` (match `requested_by`'s type); `execution_error text`;
  `execution_result jsonb`; `execution_attempts int NOT NULL DEFAULT 0`. Partial index
  `(tenant_id, execution_status) WHERE execution_status <> 'not_applicable'`.
- **Hard constraint (backfill-RLS trap):** use `NOT NULL DEFAULT` on ADD COLUMN so existing rows are
  filled by DDL — **zero backfill DML**, which is the only structurally un-no-op-able form. If any
  DML turns out to be needed, it must follow the 0052+ pattern and pass the lint.
- **Done when:** migration applies clean on a disposable Postgres against head; `npm run
  lint:migration-rls` green; existing `automation_approvals` tests still green; a pre-existing row
  reads `execution_status='not_applicable'`.
- **Deps:** none. **QA gate:** no (covered by D14-09).

### D14-02 — Decision→execution wiring: decide endpoints + core event-handler registry
- **Seat:** senior-be · Sonnet·high (seat default)
- **Files:** `platform-nest/src/core/automation-approvals.controller.ts`,
  `platform-nest/src/core/approvals-decide.controller.ts`,
  `platform-nest/src/events/consumer.service.ts`, `platform-nest/src/main.ts`,
  `platform-nest/src/core/approval-executables.ts` (new — registry *skeleton*: types,
  `registerExecutableApproval()`, `getExecutable(toolName)`, empty initial map),
  `platform-nest/src/events/consumer.service.test.ts`, `platform-nest/src/core/approvals-decide.test.ts`
- **Scope:**
  1. Both decide surfaces: when `decision='approved'` AND `origin ∈ {automation, agent}` AND
     `getExecutable(tool_name)` exists ⇒ set `execution_status='pending'` in the SAME UPDATE that
     flips `status`. All other rows (hr, search, unregistered tools, rejected) keep
     `not_applicable` — this is what keeps the sem-apply caller-re-drives pattern (§0.3) untouched.
  2. `consumer.service.ts`: add a **core handler registry** — `registerCoreEventHandler(eventType,
     handler)`; core handlers dispatch for every event on watched streams with NO module-enable
     gate, isolated try/catch, and identical ack/retry/dead-letter accounting (a failing core
     handler must leave the entry un-acked and count toward `DEAD_LETTER_MAX_RETRIES`).
  3. `list` endpoint returns the new execution fields.
  4. `main.ts`: register the executor handler (stub until D14-03) for
     `automation_approval.decided`. Stream list unchanged (already contains
     `"automation_approval"`).
- **Done when:** unit tests prove: approved+registered ⇒ `pending`; approved+unregistered / hr /
  search / rejected ⇒ `not_applicable`; a core handler runs for a tenant with NO modules enabled; a
  throwing core handler leaves the entry un-acked and dead-letters after 5 deliveries; list returns
  execution fields.
- **Deps:** D14-01. **QA gate:** yes (event backbone + approval semantics, multi-file).

### D14-03 — The executor: `core/approval-execute.ts` + re-drive as original principal
- **Seat:** senior-be · **opus·high** — the program's authority/idempotency/TOCTOU core: subtle
  authz (grant minting, principal reconstruction) + at-least-once + advisory-lock semantics, where a
  mistake is either silent unattended writes or silent duplicates.
- **Files:** `platform-nest/src/core/approval-execute.ts` (new),
  `platform-nest/src/core/approval-executables.ts` (extend types: `precondition(client, toolArgs)`,
  `lockKey(toolArgs)`), `platform-nest/src/core/hub-client.ts` (new — minimal fetch client to the
  hub tool-call endpoint with OBO headers + `x-approval-grant`), `platform-nest/src/config.ts`
  (`APPROVAL_GRANT_SECRET`, `HUB_URL`), `platform-nest/src/core/approval-execute.test.ts`,
  `platform-nest/.env.example`
- **Scope (mirrors `applyLeaveDecision`'s shape, hardened):**
  1. Handler filters: `eventType='automation_approval.decided'`, `payload.decision='approved'`,
     `origin ∈ {automation, agent}` — else return (harmless no-op, like the HR handler).
  2. **Idempotent single-use claim:** one transaction —
     `UPDATE ... SET execution_status='executing', execution_attempts=execution_attempts+1,
     updated_at=now() WHERE id=$1 AND execution_status='pending' RETURNING *`; zero rows ⇒ return
     (constraint 4: redelivery no-ops once the row left `pending`).
  3. Inside that same transaction: `pg_advisory_xact_lock(hashtext(entry.lockKey(tool_args)))`, then
     `entry.precondition(client, tool_args)` — the WD-29 pattern where the lock ALONE is
     insufficient and the server-side precondition re-evaluation is the actual fix. Stale ⇒ commit
     `execution_status='failed'`, typed `execution_error='precondition_failed: <reason>'`, notify,
     and NEVER call the hub.
  4. Mint the grant (§1) and re-drive **through the hub** as the ORIGINAL principal (§1 authority
     rule) — the hub re-evaluates assurance + AUTOMATION_ALLOWLIST + Cerbos UNCHANGED; a since-
     de-scoped workflow or revoked role fails there, and that failure is recorded as `failed` with
     the hub's typed reason (the correct outcome per the plan §6 step 4).
  5. Terminal transition: success ⇒ `executed`, `executed_at`, `executed_by` = original principal
     identifier, `execution_result` (size-capped, redacted). Failure ⇒ `failed` + typed
     `execution_error`.
  6. **Retry policy read at execution time** (constraint 10): read
     `companies.settings -> 'automation' -> 'approvalRetry' ->> 'autoRetryCount'` (default 0) fresh
     on every execution — never at boot. If `execution_attempts < autoRetryCount`, re-attempt
     (bounded, in-invocation); else terminal `failed`.
  7. **Terminal notify (loud, OQ-4 makes it load-bearing):** `notifyBestEffort` to `decided_by` and
     the requester on BOTH outcomes; `failed` ⇒ severity `warning`+ (bell + MAIL-05 email tap), not
     a log line.
  8. Crash-wedge rule: a row stuck at `executing` (process died mid-flight) must be recoverable —
     retryable via D14-07 once `updated_at` is older than a staleness threshold (10 min).
- **Done when (tests target the four hard questions, §6 step 8):** (a) redelivering the same decided
  event twice calls the hub exactly once; (b) stale precondition ⇒ `failed` + notification + hub
  never called; (c) workflow removed from `AUTOMATION_ALLOWLIST` between decide and execute ⇒ hub
  denies ⇒ `failed` + notification; (d) hub/tool failure ⇒ `failed` row + loud notification;
  (e) success ⇒ `executed`, `executed_by` = original principal ≠ `decided_by`; (f) changing
  `companies.settings` autoRetryCount mid-test changes behavior without restart; (g) the
  **falsifiability anchor**: a test asserting the hub is called on approval — one that FAILS against
  the pre-ticket code (reproducing today's silent no-op).
- **Deps:** D14-01, D14-02, D14-04 (contract is fixed in §1, so build can proceed in parallel;
  integration test needs D14-04 merged). **QA gate:** yes (security-critical).

### D14-04 — Hub-side execution grant: lift ONLY the impact suspension, single-use
- **Seat:** senior-integrator · **opus·high** — modifies THE automation write gate; a fail-open bug
  here silently converts the approvals inbox into an unattended-write bypass, the worst possible
  outcome of this program.
- **Files:** `mcp-hub/src/policy.ts` (thread an optional verified-grant through
  `authorize`/`authorizeCall`; skip ONLY the `tool.write && impact !== 'low'` suspend branch when
  the grant matches), `mcp-hub/src/hub.ts` (parse + verify `x-approval-grant` at the tool-call
  site; nonce cache; audit line), new `mcp-hub/src/approval-grant.ts` (verify: signature, `exp`,
  `v`, tenant/tool match, canonical-JSON `argsSha256` recompute), hub config module (add
  `APPROVAL_GRANT_SECRET`), `infra/compose/docker-compose.vps.yml` (add the env to BOTH mcp-hub and
  platform services' `environment:` blocks — passthrough trap), hub tests.
- **Hard constraints:** deny-by-default is preserved — no grant, bad grant, expired grant, replayed
  nonce, args mismatch, or tool mismatch all take today's exact path. Assurance, `workflowScope`,
  and Cerbos evaluation are byte-for-byte unchanged (constraint 1). A grant presented by a
  NON-automation principal changes nothing it wasn't already allowed (for `origin=agent` re-drives
  the gate never applied — the grant is audit-only there).
- **Done when:** hub tests prove: valid grant + in-scope workflow + Cerbos allow ⇒ tool executes;
  valid grant + workflow NOT in `AUTOMATION_ALLOWLIST` ⇒ deny (unchanged reason); valid grant +
  Cerbos deny ⇒ deny; tampered signature / expired / args-hash mismatch / second use of the same
  nonce ⇒ suspend as today; every verdict lands in the JSONL audit with `approvalId`; all existing
  hub tests green (no behavior change without a grant).
- **Deps:** none (contract §1). **QA gate:** yes (security-critical).

### D14-05 — Executable registry entries: `deploy.staging` / `deploy.production` (OQ-3)
- **Seat:** senior-be · Sonnet·high (seat default)
- **Files:** `platform-nest/src/core/approval-executables.ts` (the two entries),
  `platform-nest/src/core/approval-executables.test.ts`; read-only grounding:
  `mcp-hub/src/registry.ts` (what deploy.* actually executes), `platform-nest/src/core/pipeline.controller.ts`
  + `migrations/0052_pipeline_stage_idempotency.sql` (the WD-29 precedent to reuse)
- **Scope:** register the WD-08 dead-end pair. Per entry: `lockKey` = the pipeline run id extracted
  from `tool_args`; `precondition` = server-side re-evaluation that the run/stage is still in the
  state the deploy was filed against (run not blocked/superseded/completed; target stage still
  awaiting this deploy) — reusing the 0052 idempotency machinery, not reimplementing it. Typed
  refusal reasons (`run_blocked`, `stage_already_deployed`, `run_not_found`).
  **Registry doctrine stated in the file header:** additions are deliberate, one per ticket, each
  with its own precondition; a generic "call any MCP tool" bridge is forbidden (constraint 3);
  money-spending tools (search ads apply, anything SM-55 covers) are permanently barred.
- **Done when:** unit tests per precondition branch (fresh run ⇒ pass; blocked/superseded/already-
  deployed run ⇒ typed refusal); an approved `deploy.staging` row for a stale run ends `failed`
  with `precondition_failed:*` and the hub is never called; registry rejects duplicate
  registration.
- **Deps:** D14-02 (registry skeleton), D14-03 (executor consumes entries). **QA gate:** yes
  (deploy path).

### D14-06 — Cerbos: ADD superadmin to decide + new `retry` action (OQ-1)
- **Seat:** senior-be · Sonnet·high (seat default) — **inline candidate, see §4**
- **Files:** `platform-nest/cerbos/policies/resource_automation_approval.yaml`, its policy test
  file (colocated `*_test` yaml or the platform's Cerbos parity suite — match the existing pattern)
- **Scope:** ADD the superadmin role (the platform's `platform_admin`-equivalent Cerbos role —
  match the exact role name used by existing policies) to `decide` as an *addition* alongside the
  existing `company_admin` / `group_executive` / `module_manager`-for-`origin=hr` rules (constraint
  7 — replacing them regresses the HR leave path). Add action `retry` with the same decider set.
  This is an EDIT to an existing policy file (hot-reload works; the new-file silent-DENY trap does
  not apply here — it applies to ASST-02).
- **Done when:** policy tests prove: superadmin can decide any origin; company_admin/group_executive
  still can; hr_manager (module_manager) still decides `origin=hr` and ONLY `origin=hr`; a plain
  manager cannot; `retry` mirrors `decide`. Live parity suite green.
- **Deps:** none. **QA gate:** yes (RBAC — even if executed inline, D14-09 must cover it).

### D14-07 — Retry endpoint + retry-policy setting in `companies.settings` (OQ-5)
- **Seat:** senior-be · Sonnet·high (seat default)
- **Files:** `platform-nest/src/core/automation-approvals.controller.ts` (add
  `POST :tenantId/automation-approvals/:id/retry`), the existing company-settings write path (extend
  the company PATCH to merge the namespaced key, or a narrow settings endpoint if none exists —
  implementer verifies which; do NOT build a settings table/subsystem, constraint 10), tests.
- **Scope:** `retry` — Cerbos action `retry` (D14-06); allowed only for rows in `failed`, or
  `executing` with `updated_at` older than the staleness threshold (the crash-wedge rule, D14-03.8);
  transitions the row back to `pending` and invokes the executor directly (same code path, same
  claim, same grant minting — no second implementation). Settings: read/write
  `companies.settings.automation.approvalRetry = { autoRetryCount: number }` (default 0 = manual
  only), validated `0 ≤ n ≤ 3`.
- **Done when:** tests: retry on `failed` re-drives once and lands `executed` when the precondition
  now holds; retry on `executed`/`pending` ⇒ 409; retry by a non-decider ⇒ 403; stale-`executing`
  row is retryable, fresh one is not; the setting round-trips through the API and D14-03 reads the
  changed value without restart.
- **Deps:** D14-03, D14-06. **QA gate:** yes (authz + money-adjacent semantics).

### D14-08 — Approvals UI: execution state, retry, and the settings control
- **Seat:** medior · Sonnet·medium (seat default)
- **Files:** `platform-ui/src/app/(app)/approvals/page.tsx` (+ its components/lib — follow the
  existing BFF-helper pattern in `platform-ui/src/lib/`), `platform-ui/src/app/(app)/systems/automation/page.tsx`
- **Scope:** (1) each approval row shows `execution_status` as a distinct chip NEXT TO the decision
  status — an approved-but-unexecuted row must be visibly distinguishable from a done one (plan §6
  step 7; the UI must stop lying); `failed` shows `execution_error` and a Retry button (calls
  D14-07, RBAC-gated via the existing `can()` capability model); `not_applicable` rows render
  exactly as today. (2) systems/automation page: an "Approval retry" card exposing
  `autoRetryCount` (0–3), admin-gated, writing through D14-07's settings path. Staff surface only —
  the portal approvals page is out of scope.
- **Done when:** `next build` green; against a dev backend, an approved-executable row visibly walks
  `pending → executed` (or `failed` + Retry works); a non-admin sees no Retry/settings controls;
  degraded (backend-missing-fields) rendering falls back cleanly per house ConnectionState pattern.
- **Deps:** D14-02 (fields in list), D14-07 (retry + settings endpoints). **QA gate:** no
  (inline-verifiable; behavior covered end-to-end by D14-09).

### D14-09 — QA gate: adversarial suite + end-to-end drive of the whole resume path
- **Seat:** qa · Sonnet·medium (seat default)
- **Files:** test additions only (platform-nest + mcp-hub suites; no production code)
- **Scope:** independently verify every acceptance criterion above, then hunt what the tickets
  missed: (a) end-to-end: file (via hub `approvals.request` as `wf:delivery`) → decide as
  superadmin → auto-execute → row `executed` + both notifications, on a live PG+Cerbos+Redis test
  stack; (b) redelivery storm (5 duplicate deliveries) ⇒ exactly one execution; (c) grant replay
  across rows and across tenants ⇒ deny; (d) the HR leave regression suite untouched-green
  (constraint 7); (e) search sem-apply flow untouched-green (§0.3 — approved search rows stay
  `not_applicable`, caller-re-drive still consumes them); (f) an `origin=agent` row executes under
  the ORIGINAL user's Cerbos principal and fails when that user's role is revoked; (g) `executing`
  crash-wedge is retryable after staleness, not before; (h) re-run forward progress (D14-10): an
  approved agent `high_write` row is consumed exactly ONCE across both claim orders (executor
  auto-execute first vs goal re-run first), the losing path consuming the stored result without
  re-calling the tool; (i) impact drift (D14-12): an AgentDef label weaker than the registry's
  `impact` is overridden — stricter wins in both directions.
- **Done when:** full platform-nest + mcp-hub suites green locally (Docker PG + Cerbos; drop
  orphaned test DBs first — shm trap); every red finding is fixed-or-ticketed before the set is
  called done. CI verification deferred while Actions billing is dead — mark CI-dependent items
  UNVERIFIED explicitly.
- **Deps:** D14-01..08, D14-10..12. **QA gate:** it IS the gate.

## Amendment 2026-08-05 — agent re-run tickets (orchestrator-verified idempotency audit)

Verified context these three tickets rest on (do not re-derive): `ai-agents/src/agent.ts:152`
throws `ApprovalRequiredError` on `high_write` UNCONDITIONALLY, with no knowledge of a decided
approval row — so under OQ-2 (re-run suspended goals from the top) a re-run replays steps 1..N-1,
re-suspends at step N, and files a SECOND approval: it can never make forward progress. This is
LATENT today — `ai-agents/src/specialists.ts` has exactly three AgentDefs (statusReporter and
approvalsChaser read-only; task-triager = `tasks.list` read + `tasks.update` `low_write`, verified
idempotent), so NO `high_write` is reachable — but it arms itself silently the moment an AgentDef
gains a `high_write` or a non-idempotent `low_write`. Separately, `mcp-hub/src/policy.ts:40` wraps
both the workflow-scope check and the D14 impact gate in `isAutomation` (true only for
`provider==="n8n"`), so agent principals are gated by assurance + Cerbos but NOT by the registry's
impact tier — their only impact classification is the hand-maintained `AgentDef.tools` map, which
can drift weaker than the registry's.

**Correction to the D14 plan §7.1:** its broad prerequisite — "audit every low-impact write tool an
agent goal can call before enabling re-run" — is overstated. The reachable agent write set today is
exactly ONE verified-idempotent tool (`tasks.update`). The narrow, correct prerequisite for
re-run-from-the-top is **D14-10 + D14-11** below.

### D14-10 — Approval-aware agent runner: re-run makes forward progress (makes OQ-2 real)
- **Seat:** senior-be · **opus·medium** — bounded by the existing claim + grant primitives, but the
  single-use semantics and the interplay with D14-03's auto-execute (OQ-4) are a genuine
  double-execution hazard.
- **Files:** `ai-agents/src/agent.ts` (the unconditional `ApprovalRequiredError` throw at the
  `high_write` gate — consult before throwing), `ai-agents/src/write-agent.ts` (surface the
  consumed-result path in `WriteAgentResult`),
  `platform-nest/src/core/automation-approvals.controller.ts` (new
  `POST :tenantId/automation-approvals/resolve-and-execute`: match a decided `origin='agent'` row
  by `(workflow_id = agentName, tool_name, argsSha256)` and drive the SAME executor code path
  (D14-03) synchronously, returning the terminal outcome — no second execution implementation),
  tests on both sides.
- **Scope:** on hitting a `high_write`, the runner asks the platform for a decided row binding
  EXACTLY this call — canonical-JSON `argsSha256` per §1, so an approval can NEVER pre-authorize a
  DIFFERENT call than the one decided. Outcomes: `approved` + `execution_status='pending'` ⇒ the
  platform claims (D14-03's single-use `pending → executing` claim) and executes via the executor
  path; the runner continues the goal with the result. `approved` + `'executed'` ⇒ the runner
  consumes the stored `execution_result` WITHOUT re-calling the tool and continues (this is what
  makes executor-auto-execute vs re-run race-safe: whoever claims first wins, the other consumes).
  `'executing'` ⇒ typed, loud wait/fail. `rejected` ⇒ typed refusal into the transcript; no re-file
  of the identical call. No matching row ⇒ today's behavior exactly (throw + file, D14 unchanged).
  The endpoint is Cerbos-gated to the ORIGINAL requester principal (execution authority per §1 —
  never the approver's).
- **Done when:** tests: (1) re-run after approval executes the write exactly once and the goal
  completes; (2) a second re-run does not execute again (consumes the stored result); (3) both
  claim orders — executor first then re-run, and re-run first then decided-event redelivery —
  yield exactly ONE execution; (4) args differing by one field ⇒ no match ⇒ suspends anew;
  (5) rejected row ⇒ typed refusal and no duplicate approval filed for the identical call.
- **Deps:** D14-01, D14-02, D14-03. **QA gate:** yes (security/concurrency).

### D14-11 — CI guard: no `high_write` AgentDefs; `low_write`s must be on the verified-idempotent list
- **Seat:** junior · Haiku·medium (seat default) — **inline candidate, see §4**
- **Files:** `ai-agents/src/agent-write-guard.test.ts` (new — iterate every AgentDef exported by
  `ai-agents/src/specialists.ts`; fail on any `high_write`, and on any write not in the exported
  `VERIFIED_IDEMPOTENT_LOW_WRITES = ["tasks.update"]` allowlist), wired into the existing ai-agents
  test run (no new CI job needed)
- **Scope:** cheap insurance so the latent defect above cannot arm silently. Two halves with
  different lifetimes: the `high_write` ban is liftable when D14-10 lands — the failure message
  must say exactly that and name D14-10; the `low_write` idempotency allowlist is PERMANENT until a
  per-tool dedupe mechanism exists — extending it requires a per-tool idempotency proof in the PR
  (the §7.1-correction discipline, per tool instead of a broad audit).
- **Done when:** suite passes on today's three AgentDefs unchanged; adding a `high_write` tool to
  any AgentDef fails with a message naming D14-10; adding an unlisted `low_write` fails with a
  message naming the allowlist and the proof requirement.
- **Deps:** none. **QA gate:** no (inline-verifiable).

### D14-12 — Reconcile AgentDef impact labels against the hub registry (stricter wins)
- **Seat:** senior-integrator · Sonnet·high (seat default)
- **Files:** `ai-agents/src/agent.ts` (impact resolution at the write gate: effective impact =
  stricter of `AgentDef.tools[name]` and the hub registry's `impact` for the same tool), the
  tool-listing plumbing needed for ai-agents to obtain registry impacts (verify whether the hub's
  tools/list already exposes `write`/`impact`; if not, extend the LISTING — not the authorization
  path), tests.
- **Scope:** close the drift: an AgentDef label weaker than the registry's `impact` currently
  executes unattended, because the hub's impact gate applies only to `provider==="n8n"` principals
  (`mcp-hub/src/policy.ts:40`) and agents are otherwise gated only by assurance + Cerbos. Reconcile
  agent-side at load/run time, stricter-of-two in both directions; a tool absent from the registry
  falls back to the AgentDef label (fail-closed relative to today).
  **Stated risk / explicit non-goal:** do NOT "fix" this by extending `policy.ts`'s `isAutomation`
  branch to all principals — that would route every human/OBO medium+ write through D14 suspension
  and break the interactive path (including the assistant's Phase 3 caller-authority tool broker).
  A hub-side impact gate for agent principals, if ever wanted, is its own designed ticket.
- **Done when:** tests: AgentDef `low_write` + registry `impact:"high"` ⇒ treated as `high_write`
  (suspends/files); registry `low` + AgentDef `high_write` ⇒ stays high; unregistered tool ⇒
  AgentDef label; today's three specialists behave identically before/after; the hub policy suite
  is untouched-green (no authorization-path change).
- **Deps:** D14-11 (guard in place first, so reconciliation cannot newly arm an unguarded
  `high_write`); serialize after D14-10 (both edit `ai-agents/src/agent.ts`). **QA gate:** yes
  (gate-strength change).

---

# SET B — Assistant Phases 0–1 only (9 tickets)

Phases 2–6 (Hermes streaming/session-map, tool broker/capabilities, memory panel, roster/drawer,
write proposals) are NOT decomposed here by instruction. Nothing below may hard-depend on a
production credential (D-D: dev-stage providers — Ollama/echo).

### ASST-01 — Migration 0079: assistant tables (threads/messages/tool_calls/memory)
- **Seat:** senior-db · Sonnet·high (seat default)
- **Files:** `platform-nest/migrations/0079_module_assistant.sql` (create; re-verify next-unused
  number first — D14-01 takes 0078)
- **Scope:** per blueprint §4: `assistant_threads` (id, tenant_id, owner user_id, title, brain,
  `hermes_session_id`, status active|archived, pinned, last_message_at, token/cost counters,
  compaction summary ref), `assistant_messages` (thread_id, seq, role user|assistant|tool|system,
  content + structured parts jsonb, provider, model, tokens, latency_ms, error_kind),
  `assistant_tool_calls` (message_id, tool name + server, redacted args, result summary, status,
  authority_user_id, approval_id, duration), `assistant_memory` (user/company scope, provenance +
  trust, source_thread_id, pinned, confirmed_at). All FORCE RLS with the tenant wall AND the
  `app_module_allowed('assistant')` wall (two-sided handshake — requests must declare the scope,
  WD-23A-1 lesson). Composite tenant-scoped FKs (`(thread_id, tenant_id)` → threads, etc.), ON
  DELETE CASCADE thread→messages→tool_calls; `assistant_memory.source_thread_id` ON DELETE SET
  NULL. `UNIQUE (thread_id, seq)` (no nullable columns in unique keys — NULL defeats UNIQUE).
  Attachments REUSE the existing files reference-attach mechanism — no new attachment table.
  New tables only ⇒ zero backfill DML. Erasure: hard-delete reach per OQ-1 default — deleting a
  tenant's rows must leave nothing orphaned.
- **Done when:** applies clean on head; `npm run lint:migration-rls` green; RLS probe: cross-tenant
  SELECT returns 0 rows; SELECT without the `assistant` module scope in `app.scopes` returns 0 rows
  even for the right tenant; cascade verified by test.
- **Deps:** none (number-serialized after D14-01 — see §4). **QA gate:** yes (tenancy/RLS).

### ASST-02 — Cerbos policies: `assistant_thread`, `assistant_memory` (owner-only) + restart step
- **Seat:** senior-be · Sonnet·high (seat default)
- **Files:** `platform-nest/cerbos/policies/resource_assistant_thread.yaml` (NEW),
  `platform-nest/cerbos/policies/resource_assistant_memory.yaml` (NEW), policy tests, and the
  deploy/runbook note for the restart step
- **Scope:** owner-private per blueprint §6 (constraint 8): every thread action (`create`, `read`,
  `update`, `delete`, `message`, `stream`, `stop`) allowed ONLY when
  `principal.id == resource.attr.ownerId` within the tenant — **explicitly NO company_admin /
  group_executive / superadmin read rule** (admin access to someone's thread is a separate audited
  feature, deliberately absent in v1). Memory: `list`/`propose`/`confirm`/`delete`, owner-only.
  **These are NEW policy files:** a new file is NOT hot-reloaded over the Windows bind mount and an
  unlisted kind is a SILENT DENY that reads like a logic bug — local dev requires a Cerbos
  container restart, and the deploy's existing Cerbos-restart step covers prod; both facts go in
  the file headers and the runbook.
- **Done when:** policy test matrix: owner allow on all actions; other same-company user deny;
  company_admin deny; group_executive deny; cross-tenant deny; plus a live smoke test that the
  kinds resolve at all (catches the unlisted-kind silent DENY).
- **Deps:** none. **QA gate:** yes (authz).

### ASST-03 — Gateway: real `CompleteStream` on Ollama + echo, and the mid-stream-failover fix
- **Seat:** senior-integrator · Sonnet·high (seat default)
- **Files:** `ai-gateway-go/internal/providers/ollama.go` + `ollama_test.go` (implement
  `CompleteStream`: `"stream": true`, NDJSON line decode, `onToken` per chunk),
  `ai-gateway-go/internal/providers/echo.go` + `echo_test.go` (`CompleteStream` emitting the prompt
  word-by-word — the keyless dev/test streaming terminator per D-D),
  `ai-gateway-go/internal/server/server.go` (stream route: mark the attempt streamed on FIRST token
  so a provider error AFTER tokens were flushed emits the SSE `error` event instead of failing over
  to the next provider and duplicating output — bug verified at planning time, §0.4)
- **Done when:** `go vet` + tests green; unit test against a fake NDJSON upstream sees ≥3 discrete
  `onToken` calls; mid-stream-failure test: provider errors after 2 tokens ⇒ client gets 2 tokens +
  `event: error`, second provider NEVER invoked; pre-first-token failure still fails over as today;
  manual `curl -N` against local Ollama shows incremental `data:` events.
- **Deps:** none. **QA gate:** no (inline-verifiable by its own tests; ASST-08 re-drives it e2e).

### ASST-04 — DLP-on-stream: boundary-buffered response scrubbing (constraint 9)
- **Seat:** senior-integrator · **opus·medium** — bounded single-service work, but the failure mode
  is a silent PII leak (a PAN split across two chunks passes naive per-token scrubbing and every
  happy-path test); the window/boundary logic must be right, not plausible.
- **Files:** `ai-gateway-go/internal/dlp/stream.go` (NEW — a streaming scrubber wrapping an
  `onToken` sink: hold a trailing buffer ≥ the longest detectable PII span, scrub the buffered
  window, emit only up to the last safe boundary, flush the scrubbed tail at stream end) +
  `stream_test.go`; `ai-gateway-go/internal/server/server.go` (wrap the stream route's `emit` — and
  the single-chunk fallback `emit(text)`, which is equally unscrubbed today, §0.4)
- **Done when:** tests: a PAN/KTP split across two token boundaries arrives redacted; a PII string
  entirely inside one token arrives redacted; a clean stream passes byte-identical with bounded
  added latency (buffer never exceeds its cap); end-of-stream flushes the held tail exactly once;
  the non-streaming fallback path is scrubbed; existing DLP suite green.
- **Deps:** ASST-03 (real multi-chunk streams to scrub). **QA gate:** yes (DLP/security).

### ASST-05 — Assistant module: contract registration + threads/messages CRUD
- **Seat:** senior-be · Sonnet·high (seat default)
- **Files:** `platform-nest/src/modules/assistant/index.ts` (NEW — `ModuleContract` key
  `"assistant"`, `migrations: ["0079_module_assistant.sql"]`, permissions, uiManifest),
  `platform-nest/src/modules/assistant/assistant.controller.ts` (NEW),
  `platform-nest/src/main.ts` (`registerModule(assistantModule)`), `platform-nest/src/app.module.ts`
  (controller), `docs/FRONTEND-BFF-CONTRACT.md` (add the §5 endpoint table as PENDING→BUILT as they
  land), dev seed (enable the module for dev tenants — match how hr/pm seeds do it), tests.
- **Scope:** `GET/POST /api/:t/assistant/threads`, `GET/PATCH/DELETE /api/:t/assistant/threads/:id`
  (list: paginated, search, pinned-first; get: thread + paged messages; patch: rename/pin/archive/
  brain; delete: hard, cascades). Every DB access via `withTenants([tenantId], fn, { modules:
  ["assistant"] })` (the two-sided handshake). Every action authorized against the
  `assistant_thread` Cerbos kind with `ownerId` in the resource attrs — owner-only end to end.
  Company scope: the `:t` path param re-scopes naturally; no cross-company leakage.
- **Done when:** suite proves: owner CRUD round-trip; other user (same company) gets 404/403 on
  read/patch/delete; company_admin same; second company's list is disjoint for the same user;
  delete removes messages/tool_calls and nulls memory links; requests without the module scope fail
  closed; contract doc updated.
- **Deps:** ASST-01, ASST-02. **QA gate:** yes (tenancy/authz surface).

### ASST-06 — Send→stream engine: POST message → SSE relay → persisted reply, with stop
- **Seat:** senior-be · Sonnet·high (seat default)
- **Files:** `platform-nest/src/modules/assistant/stream.ts` (NEW — gateway SSE relay),
  `platform-nest/src/modules/assistant/context.ts` (NEW — context assembly + compaction),
  `platform-nest/src/modules/assistant/assistant.controller.ts` (add
  `POST /threads/:id/messages` → `{ messageId, streamUrl }`, `GET /threads/:id/stream` (SSE),
  `POST /threads/:id/stop`), `platform-nest/src/config.ts` (gateway URL/token for platform-nest if
  not already present — verify), tests.
- **Scope:** the POST-then-GET pair (EventSource can't POST). Persist the user message (next `seq`),
  assemble context (system preamble + compaction summary + most recent messages within a token
  budget), call `ai-gateway-go POST /complete/stream`, re-emit as typed SSE events `token`, `usage`,
  `done`, `error` (tool events are Phase 3 — not here). On `done`, persist the assistant message
  with tokens/latency and bump thread counters + `last_message_at`; on error persist `error_kind`.
  **Stop must cancel upstream** (abort the gateway fetch), not merely detach the client; a
  server-side idle timeout kills a stalled upstream into a visible `error` event. Compaction v1:
  when the window overflows, summarize the overflowed prefix via gateway `/complete` and store the
  summary ref on the thread — resuming an old thread replays exact messages + summary. Thread
  `brain` is stored but NOT routed in Phase 1 (the gateway chain picks the provider; per-brain
  routing is Phase 2) — say so in code comments and the contract doc.
- **Done when:** integration test on the echo provider: POST returns `{messageId, streamUrl}`; the
  SSE stream yields ≥3 `token` events then `done`; the assistant row exists with correct `seq`;
  re-GET of the thread replays the exact transcript; stop mid-stream cancels the upstream request
  (observable on a fake gateway) and the partial message persists flagged; a second concurrent send
  to the same thread is rejected or serialized (no interleaved seq corruption); owner-only holds on
  stream + stop.
- **Deps:** ASST-03, ASST-05. **QA gate:** yes (multi-file core engine).

### ASST-07 — `/assistant` workspace page (minimal full page, real streaming)
- **Seat:** senior-fe · Sonnet·high (seat default)
- **Files:** `platform-ui/src/app/(app)/assistant/page.tsx` (NEW),
  `platform-ui/src/components/assistant/*` (NEW — ThreadRail, ThreadView, Message, Composer,
  StreamIndicator), `platform-ui/src/lib/assistant.ts` (NEW — BFF client + SSE consumer), sidebar
  nav registration (match the existing RBAC-gated nav pattern)
- **Scope (Phase 1 slice of blueprint §8, lifting the aivory shapes):** left rail — sessions with
  search, pinned split, date grouping, rename/archive/delete; center — markdown + code blocks,
  streaming cursor, stop button; composer — multiline + send. SSE consumption as an async generator
  feeding a **pure reducer** (guards for malformed/duplicate/orphaned events, auto-complete when
  `done` never arrives), **client idle timeout (120s) with AbortController**, and a **typewriter
  smoother** over real deltas. No regenerate/edit-resend/feedback/citations/right-rail yet (later
  phases). Dark-theme-ready (design-token colors only, no hardcoded light-only values) + a11y
  (focus order, aria-live on the streaming region, reduced-motion honored) from the start.
- **Done when:** `tsc` + `next build` green; against a dev backend on echo/Ollama: create thread →
  send → tokens render incrementally → stop works → refresh restores the exact transcript → rail
  operations round-trip; a stalled stream shows a visible error after the idle timeout (not a
  forever-spinner); keyboard-only drive of the whole flow works.
- **Deps:** ASST-05, ASST-06. **QA gate:** no (ASST-08 is the gate for the whole surface).

### ASST-08 — QA gate: assistant phases 0–1 end-to-end + adversarial privacy
- **Seat:** qa · Sonnet·medium (seat default)
- **Files:** test additions only (platform-nest suite, gateway Go tests, platform-ui e2e)
- **Scope:** verify every criterion above independently, then adversarial passes: (a) privacy — user
  B enumerating/reading/streaming user A's thread fails closed (list, get, stream, stop, delete);
  elevated roles equally denied; cross-tenant RLS probe; module-gate probe (no `assistant` scope ⇒
  0 rows); (b) the silent-DENY check — restart Cerbos and prove the new kinds resolve; (c) stream
  robustness — kill the provider mid-answer (error event, no duplicate tokens — ASST-03's fix),
  idle-timeout path, stop-then-resend; (d) DLP — a seeded PII completion arrives redacted through
  the full BFF relay (ASST-04 in the real path); (e) company switcher re-scopes the rail; (f) FE
  a11y/dark-token spot-check.
- **Done when:** platform-nest + ai-gateway-go suites and the platform-ui e2e slice green locally;
  findings fixed-or-ticketed. CI-dependent verification marked UNVERIFIED while Actions billing is
  dead.
- **Deps:** ASST-01..07. **QA gate:** it IS the gate.

### ASST-09 — DevOps: nginx SSE vhost block + env passthrough for the new paths
- **Seat:** devops · Sonnet·medium (seat default) — **inline candidate, see §4**
- **Files:** the gda-aicenter nginx vhost (server-side; mirror the hand-applied portal SSE block —
  `proxy_buffering off`, `proxy_cache off`, `X-Accel-Buffering no`, long `proxy_read_timeout` — for
  `location ~ ^/api/.+/assistant/.+/stream`), `infra/compose/docker-compose.vps.yml` (any NEW env
  platform-nest needs — gateway URL/token if ASST-06 added them, `APPROVAL_GRANT_SECRET` from
  D14-04 — each listed in the service's `environment:` block: the passthrough trap has shipped 4
  silently-disabled features before), server `.env` (mind the stale-tag footgun: check tag parity
  before touching it; never bare `up -d`)
- **Done when:** compose config renders the new vars into both services (`docker compose config`
  shows them); on the server, an assistant stream through nginx delivers incremental events (not
  one buffered flush); documented in the deploy runbook next to the portal SSE precedent.
- **Deps:** ASST-06 (knows the final paths/envs), D14-04 (the secret). Deferrable until the first
  server deploy of either program — local dev is unaffected. **QA gate:** no.

---

## 2. Dispatch order (hard cap: ≤2 genuinely-independent tickets per wave)

D14 is front-loaded — it is the terminal blocker of five programs; assistant tickets fill the
second slot only where repos/files cannot collide.

| Wave | Tickets | Why safe together |
|---|---|---|
| 1 | **D14-01** + **D14-04** (+ **D14-11 run inline by the orchestrator** — no seat, no slot) | migration file vs mcp-hub repo — disjoint; D14-04 is the security long pole, start it first; D14-11 is the insurance that must exist before any AgentDef is touched |
| 2 | **D14-02** + **D14-06** | consumer/controller code vs a Cerbos yaml — disjoint files |
| 3 | **D14-03** + **ASST-03** | platform-nest core vs ai-gateway-go — different repos |
| 4 | **D14-05** + **D14-07** | registry entries vs retry endpoint/settings — disjoint platform files (07 needs 03 merged: satisfied) |
| 5 | **D14-10** + **ASST-04** | ai-agents + one platform controller vs ai-gateway-go (10 needs 01–03: satisfied) |
| 6 | **D14-12** + **D14-08** | D14-12 serialized after D14-10 (both edit `ai-agents/src/agent.ts`); D14-08 is platform-ui — disjoint |
| 7 | **D14-09 (QA gate — SET A ships here)** + **ASST-01** | qa runs suites; ASST-01 is one new migration file (number-serialized AFTER D14-01 merged, so 0079 is safe) |
| 8 | **ASST-02** + **ASST-09** | Cerbos yamls vs server/compose config |
| 9 | **ASST-05** (solo — everything else depends on it) | |
| 10 | **ASST-06** (solo — core engine) | |
| 11 | **ASST-07** (solo — FE workspace) | |
| 12 | **ASST-08 (QA gate — SET B phases 0–1 ship here)** | |

**Critical path (SET A):** D14-01 → D14-02 → D14-03 → {D14-05, D14-10} → D14-12 → D14-09, with
D14-04 joining before D14-03's integration tests. **Critical path (SET B):** ASST-01/02 → ASST-05 →
ASST-06 → ASST-07 → ASST-08. Shared-checkout discipline applies (commit early, never `git add -A`,
re-check main before push).

## 3. Opus tags (4 of 21 — everything else is seat default)

- **D14-03 · opus·high** — authority/idempotency/TOCTOU core; a mistake is silent unattended writes
  or silent duplicates.
- **D14-04 · opus·high** — modifies THE automation write gate; a fail-open bug converts the
  approvals inbox into an unattended-write bypass.
- **D14-10 · opus·medium** — single-use consumption racing D14-03's auto-execute (OQ-4); a mistake
  is a double-executed high-impact write, and the primitives (claim, argsSha256 binding) already
  exist so the work is hard but bounded.
- **ASST-04 · opus·medium** — silent-PII-leak hazard: wrong boundary-buffer logic passes every
  happy-path test.

## 4. Inline flags (below army scale — orchestrator may run these in-line)

- **D14-01** — one migration file, no DML. Inline-verify with a disposable-PG apply + the RLS lint.
- **D14-06** — one existing yaml + tests. Security-touching, so even if inlined it MUST still be
  exercised by D14-09's matrix.
- **D14-11** — one lint-test file in ai-agents. Inline-verify by running the ai-agents suite; do it
  in wave 1 — it is the insurance that must precede any AgentDef change.
- **ASST-09** — server config + compose env lines; no app code.

## 5. Discovered facts, risks, and owner items

1. **No owner decision is open for either set.** D14's five decisions are locked (§7 of its plan);
   the assistant's OQ-1..6 defaults are sufficient for phases 0–1 (OQ-1's hard-delete default is
   applied in ASST-01).
2. **Discovered — sem-apply interaction (see §0.3):** search's apply path is caller-re-driven off
   the approved row — it is NOT a second consumer of the decided event (HR's handler remains the
   only one; `sem-apply.ts:66` declines to register one on purpose, and its absence must not be
   "fixed"). Auto-executing a search row would both double-apply against that path and spend client
   ad money (SM-55/A13). Encoded as: executor registry-scoped; `execution_status='pending'` only
   for registered tools; money tools permanently barred. No behavior change for search or HR.
3. **Discovered — the consumer needs a core-handler registry** (module handlers are tenant-gated by
   module enablement; the executor must not be). D14-02 adds it; the D14 plan's "no wiring change"
   only covered the stream list.
4. **Discovered — two live gateway stream defects** fixed inside SET B: mid-stream failover
   duplicates output (ASST-03), and streamed/fallback responses bypass response-side DLP entirely
   (ASST-04). Both verified in `server.go` at planning time.
5. **Risk — CI is dead (Actions billing, 2026-08-04).** Both QA gates verify via local suite runs
   (Docker PG + Cerbos; drop orphaned test DBs first). Anything only CI can prove is marked
   UNVERIFIED until billing is fixed; the hand-built deploy runbook applies if either set must ship
   before then.
6. **Risk — new shared secret across two services + compose passthrough trap** (`APPROVAL_GRANT_SECRET`):
   explicitly owned by D14-04 (compose) and ASST-09 (server .env), because this exact trap has
   shipped silently-disabled features four times.
7. **Note — hub nonce cache is best-effort** (in-memory, single-instance v1). The authoritative
   single-use guarantee is the platform-side `pending → executing` claim; if the hub ever goes
   multi-instance, revisit (Redis-backed cache) — same deferral class as its rate limiter.
8. **Amendment (agent re-run, orchestrator-verified):** `agent.ts:152`'s unconditional
   `ApprovalRequiredError` means a re-run goal can never pass its suspension point (it re-files
   instead) — latent today because no AgentDef declares a `high_write` and the only reachable
   agent write (`tasks.update`) is verified idempotent, but it arms silently on the next AgentDef
   edit. Closed by D14-10 (approval-aware runner, single-use, race-safe against OQ-4
   auto-execute), D14-11 (CI guard so the defect cannot arm while 10 is outstanding), and D14-12
   (AgentDef-vs-registry impact drift, stricter wins — explicitly NOT by widening the hub's
   `isAutomation` gate, which would break the human/OBO write path). The D14 plan §7.1's broad
   "audit every low-impact write" prerequisite is corrected to exactly D14-10 + D14-11.
