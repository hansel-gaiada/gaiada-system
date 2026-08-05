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
   `mcp-hub/src/policy.ts`. **CORRECTED 2026-08-05 (found by D14-04, orchestrator-verified): the
   impact gate is encoded in TWO places** — the in-code `tool.write && tool.impact !== "low"`
   branch (policy.ts:46-52) AND `platform-nest/cerbos/policies/resource_mcp_tool.yaml`, whose
   single `call` allow clause requires
   `!isAutomation || (name in automationScope && (!write || impact == "low"))`. Cerbos is
   authoritative whenever `CERBOS_URL` is set — and it IS set for mcp-hub and mcp-hub-central in
   `infra/compose/docker-compose.vps.yml`. Lifting the suspension therefore requires BOTH D14-04
   (in-code) and D14-13 (policy); assurance and `AUTOMATION_ALLOWLIST` remain separate, untouched
   checks. Same two-independent-encodings drift hazard as D14-12's AgentDef-vs-registry problem,
   in a second location.

## 1. Architect-fixed contract: the single-use execution grant

D14-03 (platform) and D14-04 (hub) implement to this contract; neither may unilaterally change it.

- **Transport:** HTTP header `x-approval-grant` on the hub tool call.
- **Value:** `base64url(payloadJson) + "." + base64url(hmacSha256(APPROVAL_GRANT_SECRET, base64url(payloadJson)))`
- **Payload:** `{ v: 1, approvalId, tenantId, toolName, argsSha256, iat, exp, nonce }` with
  `exp − iat ≤ 120s`. `argsSha256` = SHA-256 over canonical JSON (recursively sorted keys) of the
  approval row's stored `tool_args`; the hub recomputes it over the *actual* call args — any
  mismatch is a deny.
- **Hub semantics (corrected 2026-08-05):** a VALID grant matching `(tenantId, toolName,
  argsSha256)` lifts ONLY the impact suspension — in **both** places it is encoded: the in-code
  suspend branch (D14-04) and the `resource_mcp_tool.yaml` impact conjunct via the
  verified-`approvalId` resource attribute (D14-13; the policy disjunct sits INSIDE the
  workflow-scope conjunction and is narrowed to an explicit executable-tool list). Assurance rank,
  `workflowScope` (AUTOMATION_ALLOWLIST), and every OTHER Cerbos condition are evaluated
  **unchanged**. Invalid / expired / mismatched / replayed grant ⇒ the normal suspend/deny path.
  Every grant verdict (accepted / rejected + reason + approvalId) goes to the JSONL tool audit.
- **Single-use:** authoritative enforcement is platform-side — the grant is minted only inside the
  `pending → executing` claimed transition (D14-03), which can succeed once per row. The hub
  additionally keeps a best-effort in-memory nonce cache with TTL (v1 hub is single-instance).
- **Secret:** new env `APPROVAL_GRANT_SECRET`, shared by platform-nest and mcp-hub. It MUST be added
  to both services' `environment:` blocks in `infra/compose/docker-compose.vps.yml` (compose
  env-passthrough trap: a var in `.env` does nothing unless listed) and to
  `platform-nest/.env.example`.
- **Canonical encodings (pinned 2026-08-05):** `iat`/`exp` in **milliseconds**; `argsSha256` as
  **lowercase hex**; signature as **base64url**. The producer (D14-03) MUST emit these canonical
  forms; the verifier (D14-04, shipped) is deliberately liberal — values < 1e11 read as seconds and
  larger as ms, normalized per claim independently, with ≤120s enforced AFTER normalization; hex
  (either case), base64, and base64url all accepted for digest/signature. See §5.10.
- **Authority of the re-driven call:** the ORIGINAL filing principal —
  `origin='automation'` ⇒ OBO `{ provider: "n8n", externalId: <row.workflow_id> }`;
  `origin='agent'` ⇒ OBO for user `<row.requested_by>`. Executing as the approver is REJECTED
  (privilege amplification; superadmin is the standing approver per OQ-1). `executed_by` records
  the principal that ran it, `decided_by` the human who lifted the gate — never conflated.

---

# SET A — D14-a resume path (13 tickets)

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
     rule) — the hub re-evaluates assurance + AUTOMATION_ALLOWLIST + every OTHER Cerbos condition
     UNCHANGED; a since-de-scoped workflow or revoked role fails there, and that failure is
     recorded as `failed` with the hub's typed reason (the correct outcome per the plan §6 step 4).
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
- **KNOWN-EXPECTED WINDOW (do not misread as an executor bug):** with `CERBOS_URL` set, the
  `origin='automation'` path CANNOT pass end-to-end until **D14-13** lands — the
  `resource_mcp_tool.yaml` policy independently encodes the impact gate and will DENY a granted
  re-drive, landing the row `failed` with a Cerbos deny reason. Develop and verify the automation
  path against the in-code engine (Cerbos off) or after D14-13; the `origin='agent'` path is
  unaffected (the gate never applied to non-n8n principals).

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
- **Hard constraints (corrected 2026-08-05):** deny-by-default is preserved — no grant, bad grant,
  expired grant, replayed nonce, args mismatch, or tool mismatch all take today's exact path.
  Assurance and `workflowScope` are byte-for-byte unchanged; Cerbos evaluation is unchanged EXCEPT
  that this ticket hands the VERIFIED-grant object through to the Cerbos-payload layer for D14-13's
  attribute. This ticket lifts only the IN-CODE encoding of the gate — with Cerbos ON, automation
  re-drives remain denied until D14-13 (expected, see D14-03's known-expected window). A grant
  presented by a NON-automation principal changes nothing it wasn't already allowed (for
  `origin=agent` re-drives the gate never applied — the grant is audit-only there).
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
  `impact` is overridden — stricter wins in both directions; (j) grant-aware policy (D14-13), run
  with Cerbos ON: granted+scoped+listed ⇒ allow; granted but workflow-unscoped ⇒ deny; granted but
  tool not in the policy list (probe with a search/money tool name) ⇒ deny; forged-attribute
  injection via tool args/headers ⇒ deny.
- **Done when:** full platform-nest + mcp-hub suites green locally (Docker PG + Cerbos; drop
  orphaned test DBs first — shm trap); every red finding is fixed-or-ticketed before the set is
  called done. CI verification deferred while Actions billing is dead — mark CI-dependent items
  UNVERIFIED explicitly.
- **Deps:** D14-01..08, D14-10..13. **QA gate:** it IS the gate.

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

## Amendment 2026-08-05 (2) — the impact gate's second encoding (architect ruling)

D14-04 found, and the orchestrator verified, that constraint 1 as originally written was
self-contradictory: `resource_mcp_tool.yaml` INDEPENDENTLY encodes the impact gate (see §0.8), and
Cerbos is authoritative in prod, so a grant lifting only the in-code branch leaves every
`origin='automation'` re-drive Cerbos-DENIED and `failed`. The premise that the gate lived only in
`mcp-hub/src/policy.ts` was wrong — it lives in two places.

**Ruling — mechanism (b) + (c) combined,** over the alternatives considered:
(a) a bare `executionGranted: true` boolean — same trust model but audit-blind; rejected in favor of
(b) passing the **verified `approvalId`** as the resource attribute (identical trust, but the Cerbos
decision log carries WHICH approval lifted the gate); PLUS (c) narrowing the policy disjunct to an
**explicit executable-tool list** mirroring `core/approval-executables.ts`. The disjunct attaches to
the **impact term only, INSIDE the `automationScope` conjunction** — placement is load-bearing: one
level out and a grant would bypass the workflow allow-list too.

**Why trusting a hub-supplied attribute is acceptable here:** the policy's decision is ALREADY
computed entirely from hub-asserted attributes (`isAutomation`, `automationScope`, `write`,
`impact`) — a hub bug can already forge any of them, so the attribute adds no new trusted party;
the hub process was and remains the enforcement boundary, with Cerbos as policy-as-data, not an
independent verifier. Enforcement of the lift rests on D14-04's grant verification (HMAC +
canonical args digest + expiry + the platform-side single-use claim), every enumerable bug class of
which fails toward DENY. The one dangerous class — attribute set without verification — is (i) the
same class as forging `impact:"low"`, which exists today, and (ii) contained by (c) to the listed
deploy tools, keeping money tools structurally excluded at BOTH layers (SM-55/A13). The drift cost
of (c) is one policy line per registry addition, paid inside the same per-tool ticket the registry
doctrine already requires, and drift fails CLOSED (visible `failed` row, not a silent allow).

### D14-13 — `resource_mcp_tool.yaml`: grant-aware impact conjunct (the gate's second encoding)
- **Seat:** senior-integrator · **opus·medium** — edits THE authorization policy itself; a
  misplaced disjunct silently widens the bypass past the workflow allow-list. The ruling pins the
  exact shape and the negative matrix, hence medium not high.
- **Files:** `platform-nest/cerbos/policies/resource_mcp_tool.yaml` (the disjunct + the explicit
  executable-tool list, with a header comment binding the list to
  `platform-nest/src/core/approval-executables.ts` — every registry-addition ticket updates BOTH;
  drift fails closed), `mcp-hub/src/cerbos.ts` (add `approvalId` to the resource attrs, sourced
  EXCLUSIVELY from D14-04's verified-grant object — never from caller args/headers),
  `mcp-hub/src/hub.ts` (thread the verified grant into the Cerbos check), `mcp-hub/src/cerbos.test.ts`
  + the platform Cerbos policy/parity suite.
- **Ruled shape (implement exactly; illustrative CEL):**
  `!isAutomation || (name in automationScope && (!write || impact == "low" || (has(R.attr.approvalId) && R.attr.approvalId != "" && name in ["deploy.staging","deploy.production"])))`
  — the disjunct on the impact term ONLY. This is an EDIT to an existing policy file: hot-reload
  applies; the new-file silent-DENY trap does not.
- **Done when (negative cases mandatory):**
  - ALLOW: automation principal + workflow-scoped tool + verified grant + tool in the list ⇒
    Cerbos allows; an `origin='automation'` re-drive lands `executed` end-to-end **with
    `CERBOS_URL` set** — the test that un-fails D14-03's automation path.
  - DENY, each as its own test: verified grant but workflow NOT scoped for the tool (**the
    misplacement detector** — proves the disjunct did not escape the `automationScope`
    conjunction); verified grant + tool absent from the policy list (probe with a search/money
    tool name); no / invalid / expired / args-mismatched grant ⇒ attribute never set ⇒ today's
    exact behavior; attribute injection attempted via tool args or headers ⇒ not honored;
    non-automation principals ⇒ identical decisions with and without a grant.
  - Absent-attribute evaluation is error-free on every pre-existing request shape (CEL `has()`
    guard; full existing policy suite unchanged-green).
  - The Cerbos decision/audit output carries the `approvalId`.
  - Parity: with `CERBOS_URL` unset, D14-04's in-code engine yields the same allow/deny verdict
    for every case above.
  - Drift direction proven by test: a tool present in the platform registry but missing from the
    policy list ⇒ deny ⇒ row `failed` with a typed reason (fail-closed, visible).
- **Deps:** D14-04. **QA gate:** yes — and exercised by D14-09's matrix item (j).

---

# SET B — Assistant Phases 0–1 only (10 tickets)

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
  budget), call `ai-gateway-go POST /complete/stream` **consuming the ASST-10 wire grammar**
  (single-line JSON `data:` payloads; tokens are JSON strings on default message events;
  `event: error` carries `{"error":string}`; `event: done` is the clean terminal — treat stream end
  WITHOUT `done` as an abnormal drop), re-emit as typed SSE events `token`, `usage`, `done`,
  `error` (tool events are Phase 3 — not here). On `done`, persist the assistant message
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
- **Deps:** ASST-03, ASST-05, ASST-10 (wire grammar). **QA gate:** yes (multi-file core engine).

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
  idle-timeout path, stop-then-resend, and newline fidelity — a streamed fenced code block and
  multi-paragraph markdown arrive byte-identical through the full gateway→BFF→browser path
  (ASST-10); (d) DLP — a seeded PII completion arrives redacted through
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

### ASST-10 — Gateway SSE wire grammar v2: newline-safe JSON payloads (live framing bug)
- **Seat:** senior-integrator · Sonnet·high (seat default)
- **The bug (found by ASST-04, orchestrator-verified):** `ai-gateway-go/internal/server/server.go:670`
  emits `data: %s\n\n` raw. Per the SSE spec, a payload containing `\n` yields a second line with
  no `field:` prefix — which parsers DISCARD, silently losing the text — and `\n\n` terminates the
  event early. Real Ollama emits paragraph breaks as tokens containing `\n\n`, so this is broken in
  production TODAY; ASST-04's boundary-batched chunks made it more likely, not caused it. The four
  `event: error` emit sites (:722/:742/:753/:765) share the defect (Go error strings can be
  multi-line). The ERP assistant streams markdown — paragraphs, lists, fenced code — so ASST-06/07
  must NOT be built on this framing.
- **Ruling (architect):** wire grammar v2 = every `data:` payload is exactly ONE line of JSON.
  Tokens: default (message) events with data = the JSON **string** of the token text. Errors:
  `event: error`, data = `{"error": string}`. Clean completion: NEW `event: done`, data = `{}` —
  added in the same change so consumers can distinguish a clean end from a connection drop (the
  consumer-visible contract changes exactly once). Per-line `data:` prefixing (option a) was
  rejected: it round-trips text correctly under the spec's concatenation rule, but leaves no room
  for structured fields — forcing a second grammar break when `usage` arrives — and the assistant's
  downstream contract is ALREADY JSON-typed events through a pure reducer (blueprint §5), so JSON
  end-to-end is one grammar for the whole pipeline with nothing to re-litigate at ASST-06.
  **Consumers / compatibility:** `/complete/stream` has NO live consumer today — wa-chat-bot,
  knowledge, and ai-agents all use the non-streaming endpoints, and the route emitted a single
  chunk until ASST-03 — so the only consumer is ASST-06, not yet built. This is the last free
  moment to change the wire; after ASST-06 it becomes a breaking change.
- **Files:** `ai-gateway-go/internal/server/server.go` (the `emit` closure at :670, the four
  `event: error` sites, the new `event: done` terminal, and the single-chunk fallback path — same
  grammar everywhere), stream-route tests alongside the existing server tests (create
  `ai-gateway-go/internal/server/server_stream_test.go` if none exists), plus a header comment at
  the emit site documenting the v2 grammar.
- **Ordering constraint:** JSON-encode at the WIRE boundary, AFTER the ASST-04 scrubber releases
  bytes — never scrub JSON-escaped text (escapes would invisibly split PII patterns).
- **Done when:** round-trip tests through a real SSE parse: a token containing `\n` and a token
  containing `\n\n` both arrive byte-identical after JSON decode (mandated cases), plus a
  multi-token fenced code block; a multi-line provider error survives via `{"error":...}`; raw
  wire output is verified to contain NO unprefixed lines; `event: done` present on clean
  completion and absent on the error path; the ASST-04 boundary/redaction tests re-run green over
  the new framing (proves the encode-after-scrub order); the fallback single-chunk path uses the
  same grammar; existing gateway suite + `go vet` green.
- **Deps:** ASST-03, ASST-04 (wraps the scrubber's release point). Must land BEFORE ASST-06.
  **QA gate:** no (self-verifying tests; ASST-08 re-drives it end-to-end via the newline-fidelity
  check).

---

# SET C — Remainder program (owner-approved 2026-08-05): two rulings + 24 tickets

> Baseline: everything above landed at `e2d65f8`, CI green (platform-nest 3152 / platform-ui 1091 /
> mcp-hub 169 / ai-agents 116, tsc clean ×6). ASST-09 is IN FLIGHT with devops — excluded from the
> R-waves below.

## C.0 Ruling 1 — the agent re-run transport (D14-14)

D14-10's endpoint is proven but unreachable: `ai-agents/src/deps.ts` has no `resolveApproval` and
there is no hub tool; ai-agents holds no platform credential and reaches the platform ONLY through
the hub. **Ruled: accept the runner-infrastructure model, with two hardenings.** The call is made
by the RUNNER, never chosen by the model, so it appears in NO `AgentDef.tools` map and passes no
agent-side impact gate; it is added to NO workflow's `AUTOMATION_ALLOWLIST`, so n8n principals are
denied by the workflow-scope check — which runs BEFORE impact is ever consulted — making the
infinite-regress horn unreachable. That frees the label to be honest: register it
**`write: true, impact: "high"`** — truthful about its effect, and a fail-closed tripwire: if
anyone ever DOES add it to a workflow allowlist, the impact gate suspends instead of executing.
Hardening 2: "never model-selectable" is enforced structurally, not by convention — the write-guard
test asserts the tool name appears in no `AgentDef.tools` map. Real authorization stays where
D14-10 put it: hub `minAssurance: "verified"` + Cerbos + the endpoint's `requested_by == principal`
binding. Hard requirement carried over: the resolver **throws** on transport failure / 403 /
unknown tool and NEVER returns `{match:"none"}` — mapping a fault to `none` rebuilds the
duplicate-approval generator through the error path.

## C.1 Ruling 2 — the `meta` event (ASST-11)

**Ruled: additive grammar-v2 events, two of them.** (1) `event: meta`, data
`{"provider":string,"model":string,"providerSession":string?}`, emitted exactly once per stream at
the moment the ASST-04 scrubber FIRST releases bytes to the wire, immediately before the first
token frame — that timing is load-bearing: it ties `meta` to the provider that actually commits to
the wire under the ASST-04 `streamed` discipline, so a provider that dies inside the hold window
fails over WITHOUT having emitted a contradictory `meta`. (2) `event: usage`, data
`{"promptTokens":int,"completionTokens":int}`, terminal (before `done`), emitted ONLY when the
provider reports real counts — usage cannot ride on the pre-first-token `meta` because counts only
exist at end-of-stream. Consumers: ASST-06's relay treats an absent `meta` as "unknown provider"
(null columns, never an error — older gateways), and keeps its ~4-chars/token estimate as the
labelled fallback when `usage` never arrives. This is the LAST cheap moment: today's only consumer
is the ASST-06 relay; after the Phase-2 brain picker and more consumers exist, this becomes a
breaking change. `meta` answers OQ-6 (failover must LABEL the serving brain) and gives the Phase-2
picker its verification signal.

## C.2 Group A — ruling tickets

### D14-14 — Hub tool `approvals.resolveExecute` + `deps.resolveApproval` + guard evolution
- **Seat:** senior-integrator · Sonnet·high (seat default)
- **Files:** `mcp-hub/src/registry.ts` (tool def: `approvals.resolveExecute`, minAssurance
  `verified`, `write: true, impact: "high"`, POST
  `/api/:tenantId/automation-approvals/resolve-and-execute`), `ai-agents/src/deps.ts`
  (`resolveApproval` via the hub call under the run's OBO envelope), `ai-agents/src/agent-write-guard.test.ts`
  (evolution below), hub + ai-agents tests. Add to NO workflow allowlist; add to NO AgentDef.
- **Guard evolution (do NOT delete the assertion):** the blanket `high_write` ban becomes a
  per-tool allowlist `RERUN_CAPABLE_HIGH_WRITES` — a tool may carry `high_write` in an AgentDef
  ONLY if (a) the live resolver is wired (this ticket) AND (b) it has a
  `platform-nest/src/core/approval-executables.ts` entry with a server-side precondition; the test
  message names both requirements. Plus the new structural assertion: `approvals.resolveExecute`
  appears in NO `AgentDef.tools` map.
- **Done when:** an agent goal that suspended, was approved, and re-ran completes end-to-end
  through the hub transport (the D14-10 acceptance, now with no test-side shim); n8n principal
  calling the tool ⇒ denied by workflow scope (and a deliberately-mis-scoped test proves the
  impact gate would suspend it — the tripwire); hub down / 403 / unknown tool ⇒ the goal FAILS
  loudly with a typed error and NO new approval row is filed (the mandated negative); guard suite:
  today's AgentDefs pass, an unlisted `high_write` fails naming both requirements.
- **Deps:** none (D14-10/13 landed). **QA gate:** yes (authz + the error-path duplicate hazard).

### ASST-11 — Gateway `meta` + terminal `usage` events (grammar v2, additive)
- **Seat:** senior-integrator · Sonnet·high (seat default)
- **Files:** `ai-gateway-go/internal/server/server.go` (emit `meta` at first scrubber release,
  before the first token frame; `usage` before `done` when counts exist; same single-line-JSON
  grammar; fallback single-chunk path included), the minimal streaming-plumbing change needed for
  a provider to report end-of-stream counts (e.g. an optional usage-reporting extension of
  `StreamingProvider` — implementer's choice), `internal/providers/ollama.go` (Ollama NDJSON final
  line carries eval counts — wire them), stream tests.
- **Done when:** tests: `meta` arrives exactly once, before the first token, naming the provider
  that served the bytes; provider dies inside the hold window ⇒ failover with NO stale `meta` from
  the dead provider (order proof against the ASST-04 discipline); `usage` present with real Ollama
  counts and absent on providers that report none; error path emits no `usage`; all ASST-10
  round-trip tests still green; `go vet` + suite green.
- **Deps:** none. **QA gate:** no (self-verifying; ASST-24 re-drives e2e).

### ASST-12 — BFF/UI: consume `meta`/`usage` — provider labelling + truthful cost meter
- **Seat:** medior · Sonnet·medium (seat default)
- **Files:** `platform-nest/src/modules/assistant/stream.ts` (parse both events, absent-tolerant),
  message persistence (fill the existing null `provider`/`model`/token columns; record
  `usageSource: provider|estimate`), `platform-ui/src/components/assistant/*` ("served by" brain
  badge on the message; cost meter distinguishes real vs estimated), tests.
- **Done when:** streamed reply persists non-null provider/model when `meta` arrives and renders
  the badge; absent `meta` ⇒ "unknown provider", zero errors; real `usage` overrides the estimate
  and the meter labels which it is showing; suite + `next build` green.
- **Deps:** ASST-11. **QA gate:** no (ASST-24 covers).

## C.3 Group B — stream egress audit

### ASST-13 — Egress-audit rows on `/complete/stream`
- **Seat:** medior · Sonnet·medium — **inline candidate** (mirrors the `/complete` emit pattern in
  the same file)
- **Files:** `ai-gateway-go/internal/server/server.go` (emit `audit.EgressAudit` on the stream
  route: blocked-budget, blocked-DLP-prompt, provider-error, and a terminal OK row carrying
  provider, latency, and the scrubber's exported `Redactions()` / `ForcedBoundaries()` counts),
  tests.
- **Done when:** every stream outcome (budget-refused, DLP-refused, mid-stream error, clean
  completion) emits exactly one terminal audit row with the response-side redaction counts; counts
  match a seeded-PII fixture; existing audit consumers unaffected (`/complete`/`/media`/`/embed`
  rows byte-identical).
- **Deps:** none (ASST-11 touches the same file — do not share a wave). **QA gate:** no.

## C.4 Group C — executable-registry entries (one program per ticket; money tools stay barred)

### D14-15 — PM entries: `pm.createTask`, `pm.createDoc`, and the J2 ball-pass tool
- **Seat:** senior-be · Sonnet·high (seat default)
- **Files:** `platform-nest/src/core/approval-executables.ts` (+ tests). Ball-pass tool name per
  the PM Phase-4 contract — verify at build, do not guess.
- **Scope:** per-tool server-side preconditions with typed refusals: project exists and is not
  archived (`project_archived`), target status/board still valid, assignee still a member
  (`assignee_gone`); advisory lock keyed per PROJECT in the executor's namespace.
  **Co-locking:** NOT needed — PM tools never touch pipeline runs, so no
  `PIPELINE_RUN_LOCK_NS` co-lock (stated in the entry header so nobody adds one "for safety").
- **Done when:** unit tests per refusal branch; an approved `pm.createTask` row for an archived
  project lands `failed` with `precondition_failed:project_archived` and the hub is never called;
  happy path executes exactly once under redelivery.
- **Deps:** none. **QA gate:** yes (write-execution path).

### D14-16 — Mail approval-action tool entry — **RECOMMEND DEFER**
- **Seat:** senior-be · Sonnet·high (seat default)
- **Defer reason (owner call):** the mail subsystem is PLANNED — its approval-action tool does not
  exist yet; a registry entry for a nonexistent tool is dead configuration. Build this ticket WITH
  the mail tool when that program ships. If built now: precondition = thread/message still exists
  and the action not already taken (idempotent on the action key); per-thread advisory lock; no
  pipeline co-lock.
- **Files:** `platform-nest/src/core/approval-executables.ts` + tests. **Deps:** the mail
  subsystem's tool landing. **QA gate:** yes.

### D14-17 — Assistant write-tool entries (Phase-6 v1 proposal set)
- **Seat:** senior-be · Sonnet·high (seat default)
- **Scope:** the v1 proposal set REUSES D14-15's PM entries where possible; any net-new
  assistant-proposed write tool gets its own entry + precondition + typed refusals here. Money
  tools (SM-55/A13) permanently barred — restated in the file header. No pipeline co-lock unless a
  tool demonstrably touches pipeline runs; if one does, it must take BOTH the executor-namespace
  lock and `lockPipelineRun` (the namespaces do NOT serialize against each other — say so per
  entry).
- **Files:** `platform-nest/src/core/approval-executables.ts`,
  `platform-nest/cerbos/policies/resource_mcp_tool.yaml` (extend D14-13's policy-side executable
  list in the same change — the two-list discipline), tests.
- **Done when:** every listed tool has precondition tests both directions; the D14-13 drift test
  extended to the new names; a non-listed assistant tool proposal lands `not_applicable`, never
  auto-executes.
- **Deps:** ASST-17 (the broker defines which tools the assistant can propose), D14-15.
  **QA gate:** yes.

## C.5 Group D — verification debt (shipped code, unverified claims)

> Note for the orchestrator: these need a LIVE stack. The 2026-07-31 owner decision says local
> stack OFF / server is truth — run these against gda-aicenter or get an explicit local-compose
> exception before dispatching.

### VER-01 — D14-08 approvals-UI click-through (live)
- **Seat:** qa · Sonnet·medium. **Files:** test/evidence only.
- **Done when:** on a live stack, an approved executable row visibly walks `pending → executed`;
  a forced failure shows `execution_error` + Retry, and Retry re-drives to `executed`; a
  non-admin sees no Retry/settings controls; `not_applicable` rows render as before.
- **Deps:** none. **QA gate:** it is one.

### VER-02 — Assistant against a LIVE platform-nest (never driven outside `DEMO_MODE=1`)
- **Seat:** qa · Sonnet·medium. **Files:** test/evidence only.
- **Done when:** create/send/stream/stop/refresh round-trip on the live BFF with a real provider;
  owner-privacy probes (user B, admin) fail closed LIVE; **company-switcher re-scopes the thread
  rail live** (not merely filtered); stop cancels the upstream request observably; transcripts
  survive refresh byte-identical.
- **Deps:** ASST-09 (nginx SSE, in flight) for the server path. **QA gate:** it is one.

### VER-03 — Rendered a11y + dark-token pass on `/assistant`
- **Seat:** qa · Sonnet·medium. **Files:** test/evidence only (defects ticketed, not fixed here).
- **Scope honesty:** the platform has NO global dark theme — verify a11y (keyboard-only drive,
  aria-live on the stream, focus order, reduced-motion) and dark-TOKEN-readiness (no hardcoded
  light-only values), not "dark theme works".
- **Deps:** none. **QA gate:** it is one.

### VER-04 — Live Redis delivery + live mcp-hub for the D14 matrix
- **Seat:** qa · Sonnet·medium. **Files:** test/evidence only.
- **Done when:** D14-09 item (a) end-to-end over a REAL Redis consumer loop (file → decide →
  auto-execute → `executed` + notifications) and a REAL hub process with Cerbos ON (grant verify,
  D14-13 policy allow/deny spot-checks) — the two legs the merged suites stubbed.
- **Deps:** none. **QA gate:** it is one.

## C.6 Group E — chores

### CHORE-01 — `gofmt`/CRLF normalization in `ai-gateway-go` (~20 pre-existing files)
- **Seat:** junior · Haiku·medium — **solo wave, never bundled with feature work** (a
  whole-package reformat buries real diffs and is a merge-conflict generator in this shared
  checkout).
- **Files:** the `gofmt -l`-flagged files + `.gitattributes` (pin `*.go text eol=lf` so it cannot
  recur from a Windows checkout).
- **Done when:** `gofmt -l` empty; `go vet` + full suite green; the PR contains formatting-only
  changes (no semantic diff under `git diff -w` beyond line endings); `.gitattributes` in place.
- **Deps:** a quiet gateway boundary (after ASST-11/13 merge). **QA gate:** no.

### CHORE-02 — Drop the 804 orphaned test databases on `gaiada-postgres-1`
- **Seat:** devops · Sonnet·medium — **inline candidate**; not urgent (shm at 2%) — any quiet slot.
- **Scope:** KEEP-allowlist ONLY, never a pattern denylist (orphans span many prefixes — `qa1_`,
  `sm14b_`, `sm50_`, `qa081013_`, `wd29full_`, `arch1_`, …): keep exactly
  `gaiada, gaiada_platform, gaiada_knowledge, gaiada_keycloak, gaiada_n8n, postgres, template0, template1`;
  dry-run printout reviewed before any DROP; verify the backup job is fresh FIRST.
- **Done when:** dry-run list approved; post-run `\l` shows only the allowlist; backups verified
  before and after; runbook note added (mirror of the test-DB-orphans /dev/shm lesson).
- **Deps:** none. **QA gate:** no.

## C.7 Group F — assistant phases 2–6

### ASST-14 — hermes-gateway: streamed spawn + incremental box parser + session capture
- **Seat:** senior-integrator · Sonnet·high (seat default)
- **Files:** `hermes-gateway/server.mjs` (new `POST /complete/stream`: `spawn` not buffered
  `execFile`, stdout streamed through a NEW line-oriented incremental ANSI/box parser — today's
  `extractChatReply` needs the whole buffer and cannot be reused unchanged; parse and expose the
  `Session:` id; accept a `providerSession` input and pass `--resume`; speak grammar v2 incl.
  `meta` with `provider:"hermes"` + `providerSession`), parser unit tests against recorded Hermes
  transcripts. The one-shot `/complete` + `/media` endpoints stay byte-identical (wa-chat-bot
  depends on them).
- **Done when:** a streamed Hermes reply arrives as multiple v2 frames with the box decoration
  stripped incrementally; the session id round-trips (`meta.providerSession` on turn 1 ⇒ `--resume`
  on turn 2 continues the same Hermes session); tool-approval hang still times out to a typed
  error, never `--yolo`; wa-chat-bot contract untouched (existing endpoints' tests green).
- **Deps:** ASST-11 (grammar). **QA gate:** no (ASST-24 covers).

### ASST-15 — Gateway per-provider routing + `providerSession` passthrough
- **Seat:** senior-integrator · Sonnet·high (seat default)
- **Files:** `ai-gateway-go/internal/server/server.go` (+config): optional `provider` hint on
  `/complete/stream` — route to the named provider when available, else the normal failover chain
  (never a hard error: OQ-6 says fail over and LABEL, and `meta` now does the labelling); opaque
  `providerSession` passthrough to providers that accept it (hermes shim); tests.
- **Done when:** hint honored when the provider is up; hint + provider down ⇒ chain serves and
  `meta` names the actual server; `providerSession` reaches the hermes shim opaquely; no behavior
  change when the hint is absent.
- **Deps:** ASST-11, ASST-14. **QA gate:** no.

### ASST-16 — BFF/UI: per-thread brain picker + Hermes session mapping
- **Seat:** medior · Sonnet·medium (seat default)
- **Files:** `platform-nest/src/modules/assistant/stream.ts` + controller (send thread `brain` as
  the provider hint; persist `meta.providerSession` to `assistant_threads.hermes_session_id`;
  send it back on subsequent turns), `platform-ui` right-rail brain picker (thread PATCH already
  exists), tests.
- **Done when:** picking Hermes on a thread routes to Hermes and turn 2 resumes the SAME Hermes
  session (blueprint Phase-2 gate); Hermes down ⇒ reply served by the chain and the ASST-12 badge
  shows the truth; switching brains mid-thread starts a fresh provider session without losing ERP
  thread history.
- **Deps:** ASST-12, ASST-14, ASST-15. **QA gate:** no (ASST-24 covers).

### ASST-17 — Tool broker under the CHATTING USER's principal (Phase 3 core)
- **Seat:** senior-be · **opus·medium** — the transcript-safety invariant (every tool runs under
  the chatting user's Cerbos principal, never a service principal) is the surface's core authz
  property; a mistake makes every thread an elevation vector.
- **Design pin (architect):** v1 routes tool-using turns through the EXISTING ai-agents runtime
  under the user's OBO envelope (the proven tool loop + provider handling), relaying its
  tool_call/tool_result progress as SSE events and streaming the final answer; per-provider native
  function-calling in the gateway is explicitly NOT built now. **Do NOT close the agent/registry
  impact drift by widening `policy.ts`'s `isAutomation` branch to all principals — it would push
  every human/OBO medium+ write into D14 suspension and break this very broker.**
- **Files:** `platform-nest/src/modules/assistant/broker.ts` (new), `stream.ts` (emit
  `tool_call`/`tool_result`/`approval_required` events), `assistant_tool_calls` persistence
  (authority_user_id = the chatting user, redacted args), ai-agents invocation plumbing, tests.
- **Done when:** a tool-using turn produces `assistant_tool_calls` rows attributable to the
  chatting user (blueprint Phase-3 gate); a tool the user lacks Cerbos rights for is REFUSED
  in-thread (typed, visible), never executed by a service principal; a read tool returns live
  tenant data scoped to that user; transcript stays owner-private end-to-end.
- **Deps:** ASST-16 (engine stable). **QA gate:** yes (authz-central).

### ASST-18 — Capabilities panel + knowledge citations
- **Seat:** medior · Sonnet·medium (seat default)
- **Files:** assistant controller (`GET /api/:t/assistant/capabilities` = hub `visibleToolsFor`
  under the user's envelope ∩ module gates), right-rail capabilities panel + empty-state
  capability cards, context assembly RAG retrieval + citation chips (the live pgvector tiers),
  tests.
- **Done when:** the panel shows exactly what THIS user can call (an unauthorized tool is absent,
  not greyed); a knowledge-grounded answer renders its citations and they resolve; empty-state
  cards render from the same capabilities source.
- **Deps:** ASST-17. **QA gate:** no (ASST-24 covers).

### ASST-19 — Memory panel: propose → confirm, quarantine discipline
- **Seat:** senior-be · Sonnet·high (seat default)
- **Files:** assistant controller (`GET·POST·DELETE /api/:t/assistant/memory` — propose vs
  confirm), context assembly (ONLY `confirmed_at IS NOT NULL` rows are ever injected as fact —
  the quarantine; unconfirmed rows are stored but inert), right-rail memory panel
  (view/edit/delete/pin), tests incl. the negative (an unconfirmed row never appears in an
  assembled prompt — assert on the assembled context, not the UI).
- **Done when:** blueprint Phase-4 gate — the user deletes a memory and can SEE the effect (next
  assembled context excludes it, provable in a test); propose→confirm round-trip; owner-only
  enforced (Cerbos `assistant_memory` from ASST-02).
- **Deps:** ASST-17 (the assistant proposes memories through the same event surface).
  **QA gate:** yes (privacy).

### ASST-20 — Message feedback → episodic `HumanFeedback` — **deferrable polish**
- **Seat:** medior · Sonnet·medium — **inline candidate** (small; and low value until the
  roster/eval loops consume feedback — owner may defer to post-v1).
- **Files:** `POST /api/:t/assistant/messages/:id/feedback`, ai-agents episodic ingestion with the
  existing trust rules (untrusted-by-default quarantine), thumbs UI on messages, tests.
- **Done when:** ↑/↓ lands as an episodic `HumanFeedback` row with correct provenance/trust; the
  same untrusted-feedback quarantine as agent runs applies; double-vote idempotent.
- **Deps:** ASST-06 (done). **QA gate:** no.

### ASST-21 — Agent roster + handoff to a goal run
- **Seat:** senior-be · Sonnet·high (seat default)
- **Authz design pin:** handoff runs execute under the CHATTING USER's envelope (same argument as
  ASST-17), so the run transcript is safe for THAT user — a new ADDITIVE Cerbos rule lets the
  triggering owner read runs with `origin=assistant_handoff`; the elevated-only rule for all other
  runs is UNCHANGED (the constraint-#2 transcript rule stays intact).
- **Files:** `POST /api/:t/assistant/threads/:id/handoff` (create goal run, link it to the
  thread), roster right-rail panel (registry list + episodic history), run-watch view for
  owner-scoped runs, `platform-nest/cerbos/policies/` (the additive run-read rule — EDIT or new
  file; if NEW, the restart step + silent-DENY trap applies), tests.
- **Done when:** hand a long task to a specialist from a thread and WATCH the run as a
  non-elevated user; another user cannot read it; an elevated-only run (non-handoff) remains
  elevated-only (regression test); the run's suspension (if a `high_write` files an approval)
  surfaces back into the thread.
- **Deps:** ASST-17. **QA gate:** yes (authz change).

### ASST-22 — `@drawer` mount
- **Seat:** medior · Sonnet·medium (seat default)
- **Files:** platform-ui `@drawer` parallel-route mount + FAB, page-context pinning (current
  page's entity as a typed context ref on the pinned thread), "open in full page" promotion —
  same engine hook as the page (the aivory FAB precedent proves this is composition, not new
  engine).
- **Done when:** drawer opens on any app page with a thread pinned to that page's context; promote
  round-trips to `/assistant` with history intact; `next build` green; keyboard accessible.
- **Deps:** ASST-16. **QA gate:** no (ASST-24 covers).

### ASST-23 — Write proposals in-thread (Phase 6 — D14 is live now)
- **Seat:** senior-be · Sonnet·high (seat default)
- **Files:** broker → proposal flow (a write intent becomes a proposal card; filing goes through
  the EXISTING approvals surface with `origin='agent'`, `approval_id` linked on
  `assistant_tool_calls`), `approval_required` SSE event wiring, proposal card UI states
  (`proposed / sent for approval / approved+executed / failed+retry` — the D14 execution chips,
  NOT the old "approval does not execute" disclaimer, which this ticket REMOVES), tests.
- **Done when:** end-to-end in one thread: assistant proposes a write → approver decides → the
  write EXECUTES (D14 path) → the card shows `executed` and the thread gets the terminal notify;
  a rejected proposal shows rejected and files no duplicate; an unregistered tool proposal is
  refused at proposal time (registry-scoped, D14-17), not silently accepted.
- **Deps:** D14-14, D14-15, D14-17, ASST-17. **QA gate:** yes (writes).

### ASST-24 — QA gate: phases 2–6 end-to-end
- **Seat:** qa · Sonnet·medium
- **Scope:** independently verify every C.7 criterion, then adversarial: Hermes session resume
  across restarts; brain failover labelling truthfulness (kill Hermes mid-thread); tool authority
  (user B's rights never leak into user A's thread and vice versa; broker refusals typed); memory
  quarantine (unconfirmed rows provably absent from prompts); handoff-run isolation (owner reads,
  others don't, elevated-only runs unchanged); proposal→approve→execute→notify loop incl. failure
  + retry; drawer/page parity.
- **Deps:** ASST-14..23 (as landed). **QA gate:** it IS the gate.

## C.8 Remainder dispatch (R-waves, cap ≤2; ASST-09 in flight is excluded)

| Wave | Tickets | Note |
|---|---|---|
| R1 | **D14-14** + **ASST-11** | the two "last cheap moment" items: agent-write transport (unblocks PM J2 + every agent write) and the wire's final additive change |
| R2 | **D14-15** + **ASST-12** | PM registry entries vs BFF/UI meta consumption |
| R3 | **VER-01** + **ASST-13** | live click-through vs stream audit (gateway file free after R1) |
| R4 | **VER-02** + **VER-04** | both qa/live-stack — run sequentially by the same seat if the stack contends |
| R5 | **ASST-14** + **VER-03** | hermes shim vs rendered a11y pass |
| R6 | **ASST-15** + **CHORE-02** | gateway routing vs server DB cleanup |
| R7 | **ASST-16** + **CHORE-01** | BFF/UI brain picker vs the solo gofmt sweep (quiet gateway boundary — nothing else touches ai-gateway-go this wave) |
| R8 | **ASST-17** (opus·medium, the Phase-3 core) + **ASST-20** | broker vs the small feedback leg (disjoint files) |
| R9 | **ASST-18** + **D14-17** | capabilities panel vs assistant registry entries (both need 17: satisfied) |
| R10 | **ASST-19** (memory — owns the right rail this wave) | solo: rail collision with 18 avoided by sequencing |
| R11 | **ASST-21** + **ASST-22** | roster/handoff (BE+rail) vs drawer mount (separate mount surface) |
| R12 | **ASST-23** | Phase 6 integration — needs D14-14/15/17 + ASST-17 (all landed) |
| R13 | **ASST-24 (QA gate — phases 2–6 ship here)** | |

**Critical path:** ASST-11 → ASST-12 → ASST-14 → ASST-15 → ASST-16 → ASST-17 → ASST-19/21 →
ASST-23 → ASST-24; D14-14 → D14-15/17 joins at ASST-23. **D14-16 deferred** (mail tool doesn't
exist yet). CHORE-02 floats — any quiet slot.

---

## 2. Dispatch order (hard cap: ≤2 genuinely-independent tickets per wave)

D14 is front-loaded — it is the terminal blocker of five programs; assistant tickets fill the
second slot only where repos/files cannot collide.

| Wave | Tickets | Why safe together |
|---|---|---|
| 1 | **D14-01** + **D14-04** (+ **D14-11 run inline by the orchestrator** — no seat, no slot) | migration file vs mcp-hub repo — disjoint; D14-04 is the security long pole, start it first; D14-11 is the insurance that must exist before any AgentDef is touched |
| 2 | **D14-02** + **D14-06** | consumer/controller code vs a Cerbos yaml — disjoint files |
| 3 | **D14-03** + **ASST-03** | platform-nest core vs ai-gateway-go — different repos |
| 4 | **D14-13** + **D14-05** | Cerbos policy + hub attribute vs platform core registry — disjoint; D14-13 goes immediately after D14-04/03 because it is what makes the automation-origin path passable under Cerbos at all |
| 5 | **D14-07** + **ASST-04** | platform controller vs ai-gateway-go (D14-07 and D14-10 both edit the approvals controller — they must NEVER share a wave) |
| 6 | **D14-10** + **D14-08** | ai-agents + approvals controller vs platform-ui — disjoint |
| 7 | **D14-12** + **ASST-01** | D14-12 serialized after D14-10 (both edit `ai-agents/src/agent.ts`); ASST-01 is one new migration file (number-serialized AFTER D14-01 merged, so 0079 is safe) |
| 8 | **D14-09 (QA gate — SET A ships here)** + **ASST-02** | qa runs suites; ASST-02 is new Cerbos yamls — disjoint |
| 9 | **ASST-05** + **ASST-10** | platform-nest module vs ai-gateway-go wire framing — different repos; ASST-10 MUST precede ASST-06 (the relay consumes its grammar) |
| 10 | **ASST-06** (solo — core engine) | |
| 11 | **ASST-07** + **ASST-09** | FE workspace vs server/compose config (ASST-09's soft dep on ASST-06 satisfied) |
| 12 | **ASST-08 (QA gate — SET B phases 0–1 ship here)** | |

**Critical path (SET A):** D14-01 → D14-02 → D14-03 → D14-10 → D14-12 → D14-09 (D14-07 before
D14-10 is wave-serialization on the shared controller file, not logic), with **D14-04 → D14-13**
joining before any Cerbos-ON end-to-end — until D14-13 lands, an `origin='automation'` row landing
`failed` under Cerbos is EXPECTED, not an executor bug. **Critical path (SET B):** ASST-01/02 →
ASST-05 (∥ ASST-10) → ASST-06 → ASST-07 → ASST-08. Shared-checkout discipline applies (commit
early, never `git add -A`, re-check main before push).

## 3. Opus tags (6 of 47 — everything else is seat default)

- **D14-03 · opus·high** — authority/idempotency/TOCTOU core; a mistake is silent unattended writes
  or silent duplicates.
- **D14-04 · opus·high** — modifies THE automation write gate; a fail-open bug converts the
  approvals inbox into an unattended-write bypass.
- **D14-10 · opus·medium** — single-use consumption racing D14-03's auto-execute (OQ-4); a mistake
  is a double-executed high-impact write, and the primitives (claim, argsSha256 binding) already
  exist so the work is hard but bounded.
- **D14-13 · opus·medium** — edits THE authorization policy itself; a misplaced disjunct silently
  widens the bypass past the workflow allow-list. The ruling pins the exact shape and negative
  matrix, hence medium not high.
- **ASST-04 · opus·medium** — silent-PII-leak hazard: wrong boundary-buffer logic passes every
  happy-path test.
- **ASST-17 · opus·medium** — the transcript-safety invariant (every tool under the chatting
  user's Cerbos principal, never a service principal) is the assistant's core authz property; a
  mistake makes every thread an elevation vector.

## 4. Inline flags (below army scale — orchestrator may run these in-line)

- **D14-01** — one migration file, no DML. Inline-verify with a disposable-PG apply + the RLS lint.
- **D14-06** — one existing yaml + tests. Security-touching, so even if inlined it MUST still be
  exercised by D14-09's matrix.
- **D14-11** — one lint-test file in ai-agents. Inline-verify by running the ai-agents suite; do it
  in wave 1 — it is the insurance that must precede any AgentDef change.
- **ASST-09** — server config + compose env lines; no app code.
- **ASST-13** — mirrors the `/complete` audit-emit pattern inside the same file.
- **ASST-20** — one endpoint + episodic ingestion + thumbs UI; also a defer candidate (§5.14).
- **CHORE-02** — server ops with a KEEP-allowlist script; devops can run it inline in any quiet
  slot (shm at 2%, not urgent). CHORE-01 stays a real junior ticket but SOLO — a 20-file reformat
  must never share a wave/PR with feature work.

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
9. **RULED — the impact gate has TWO encodings (program-blocking conflict, found by D14-04,
   orchestrator-verified):** `resource_mcp_tool.yaml`'s `call` clause independently requires
   `!write || impact == "low"` for automation principals, and Cerbos is authoritative with
   `CERBOS_URL` set (it is, in the prod compose). Constraint 1's original "Cerbos re-evaluated
   unchanged" was therefore self-contradictory — derived from `mcp-hub/src/policy.ts` alone.
   Corrected in §1 and §0.8; ruling and ticket in Amendment (2) / D14-13 (verified-`approvalId`
   attribute + impact-conjunct-only disjunct, narrowed to an explicit policy-side executable list).
   Until D14-13 lands, an `origin='automation'` row landing `failed` under Cerbos-ON is EXPECTED —
   never diagnose it as a D14-03 executor bug. The resume-path plan's §6 Step 4 has been corrected
   in place to match.
10. **§1 under-specifications resolved by D14-04 (recorded so D14-03 cannot disagree with the
   shipped verifier):** `iat`/`exp` units were unpinned — the verifier accepts values < 1e11 as
   seconds and larger as milliseconds, normalizing each claim independently and enforcing the
   ≤120s window AFTER normalization; the `argsSha256`/signature encodings were unpinned — hex
   (either case), base64, and base64url are all accepted. §1 now pins the canonical producer
   spelling: **milliseconds + lowercase hex + base64url**. D14-03 MUST emit canonical; the
   verifier stays liberal.
11. **RULED — live SSE framing bug (found by ASST-04, orchestrator-verified):** `data: %s\n\n` at
   `server.go:670` (and the four `event: error` sites) silently DROPS text after a `\n` inside a
   token and terminates the event early on `\n\n`; real Ollama emits `\n\n` paragraph tokens, so
   this is broken in production today — ASST-04's larger boundary-batched chunks made it more
   likely, not caused it. Ruled fix: wire grammar v2 — single-line JSON `data:` payloads plus an
   `event: done` terminal (ticket ASST-10; full rationale there). ASST-06 amended to consume v2
   and now depends on ASST-10; ASST-08 gained the end-to-end newline-fidelity check.
12. **Discovered, UNOWNED (from ASST-04 — record only, no ticket yet):** (a) the stream route
   emits NO egress-audit row at all — unlike `/complete`/`/media`/`/embed` — so response-side
   redaction counts go nowhere even though the scrubber already exports `Redactions()` and
   `ForcedBoundaries()` for exactly that. Recommend ticketing BEFORE staging: the assistant makes
   streaming the primary egress path, and an unaudited primary path defeats the gateway's audit
   premise. (b) `gofmt -l` flags ~20 pre-existing `ai-gateway-go` files (CRLF endings from the
   Windows checkout); ASST-04 rightly did not reformat other sessions' files mid-program.
   Recommendation: YES — a junior chore ticket, but scheduled SOLO at a quiet wave boundary
   (after SET A ships): a whole-package reformat mid-flight is a merge-conflict generator in this
   shared checkout.
13. **Shipped behaviour — do NOT "fix" later (ASST-04, deliberate):** `streamed` now flips when
   the scrubber RELEASES bytes to the wire, not when a provider yields a token, and the trailing
   hold buffer is DISCARDED on the failover path. Flushing that buffer on failover would prefix a
   dead provider's partial answer onto the next provider's full answer — the exact duplication
   class ASST-03 fixed. Intended consequence: a response shorter than the 37-byte hold window that
   dies mid-generation fails over cleanly instead of emitting a stub plus an error.
14. **SET C decisions the owner should see (2026-08-05):** (a) **Phase-3 protocol pin** — the
   assistant's tool-using turns route through the EXISTING ai-agents runtime under the chatting
   user's OBO envelope (ASST-17); per-provider native function-calling in the gateway is
   deliberately NOT built in v1 — revisit only if the agent-loop latency proves unacceptable.
   (b) **Defer recommendations:** D14-16 (mail registry entry — the mail subsystem's tool does not
   exist yet; an entry for a nonexistent tool is dead config), ASST-20 (feedback→episodic — low
   value until eval loops consume it), CHORE-02 (floats; shm at 2%). (c) **VER-01..04 need a live
   stack** — the 2026-07-31 owner ruling says local stack OFF / server is truth, so they run
   against gda-aicenter or need an explicit local-compose exception. (d) VER-03 is scoped honestly:
   a11y + dark-TOKEN-readiness — a platform-wide dark theme still does not exist to verify against.
