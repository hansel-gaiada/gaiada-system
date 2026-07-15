# WS8 — AI-Native / Agent Platform: build plan (steps 4–6 + the gates that unblock them)

**Date:** 2026-07-15
**Status:** Plan (build-sequence steps 1–3 already BUILT; this plans the rest). **Step A — eval
harness + run tracing — BUILT 2026-07-15** (`ai-agents/src/evals/`, 8 tests). **Step B — first
write-capable specialist + agent approval surface + D13 provider gate — BUILT 2026-07-15**
(`ai-agents/src/write-agent.ts` + `task-triager`; approvals reused from WS4 via an `origin` column).
**Step C — model registry + D13 weight-provenance + eval-gated activation — registry BUILT 2026-07-15**
(`ai-agents/src/models/registry.ts`; serving/LoRA/GPU infra-deferred). **Step D — episodic memory +
eval-gated trainer — BUILT 2026-07-15** (`ai-agents/src/memory/episodic.ts` + `src/trainer/trainer.ts`;
human-feedback capture UX deferred). **Step E — knowledge graph / semantic layer — BUILT 2026-07-15**
(`ai-agents/src/knowledge/graph.ts` + `/graph/neighbors` + hub `knowledge.graph`; ingestion pipeline
deferred). See §3 Steps A–E. **✅ The WS8 build sequence (§8 steps 1–6) is now code-complete** — what
remains is infra (local serving / LoRA / GPU, WS10), a few live wires (Gateway provider-reporting,
graph ingestion, UI feedback capture), and WS9 observability.
**Parent spec:** `../specs/2026-07-04-ws8-ai-native-agent-platform.md` (§8 build sequence, D9/D13/D14 locked).
**Depends on:** WS3 Gateway (models, cost cap, egress DLP), WS2 mcp-hub (tools + OBO audit), WS1
platform (data + events + RBAC/Cerbos), WS9 Observability (traces/evals — **not yet built**, see §6).
**Backbone rule (inherited, non-negotiable):** every agent reaches **models via the Gateway** and
**tools/data via the MCP hub under the requesting user's OBO envelope** — an agent can never act with
more authority than the human it serves; `ai-agents/` holds no provider keys and no DB access, by
construction. Every new capability below keeps this invariant.

---

## 0. Where we are (verified 2026-07-15)

Build-sequence **steps 1–3 are built** in `ai-agents/` (13 tests, tsc clean):

- **Step 1 — specialist framework** (`src/agent.ts`): `runAgent()` with D14 enforced in the runner
  (not trusted to the model): per-agent tool **allow-list**; **impact taxonomy** (`read`/`low_write`/
  `high_write`); `high_write` + unclassified ⇒ `ApprovalRequiredError` (nothing committed); per-run
  step + tool-call **budgets** ⇒ typed `BudgetExhaustedError` carrying the transcript; tool failures
  fed back as failures, never swallowed as facts. Specialists today (`src/specialists.ts`):
  `status-reporter`, `approvals-chaser` — **both read-only**.
- **Step 2 — orchestrator** (`src/orchestrator.ts`): supervisor/worker over a shared **blackboard**;
  per-goal budget across the whole tree (two-tier with the Gateway daily cap), fan-out + depth caps,
  cycle guard (same (specialist,task) never re-run), a specialist `high_write` suspension bubbles up
  and suspends the whole goal; every abnormal end is a typed error carrying the blackboard.
- **Step 3 — knowledge/memory platform** (`src/knowledge/`, service on `:3005`, sole D9 owner):
  retrieval-time authorization (tenant+ACL **hard SQL pre-filter before ranking**), source-driven
  lifecycle (re-ingest replaces, erasure hard-deletes — crypto-shred reaches derived stores), memory
  integrity (provenance/trust/confidence per row; untrusted quarantined; agent-written facts
  down-weighted). **Vector backend is already dual-mode (P5e):** pgvector column + HNSW cosine pushed
  into SQL when the extension is present, float8[] + app-side cosine fallback otherwise, identical
  scoring. The hub's `knowledge.search` is a thin wrapper; embeddings via the Gateway `/embed`.

**So the framework, orchestration, and RAG/memory substrate exist.** What's missing is everything that
makes the brigade (a) trustworthy enough to WRITE, (b) self-improving, and (c) reasoning over a
semantic layer — i.e. spec §8 steps 4–6 plus the **eval + tracing substrate (D13/§6/WS9)** that all of
it is gated on.

---

## 1. The remaining scope (spec §8 steps 4–6 + cross-cutting locks)

| Spec item | What it is | State |
|---|---|---|
| §8.4 | Local models + **registry**; then fine-tuning/LoRA | not started |
| §8.5 | **Trainer agent** + eval-gated improvement loop | not started |
| §8.6 | **Knowledge graph / semantic layer** over multi-business data | not started |
| §6 / D13 | **Eval suites + run tracing + guardrails** (the acceptance gate) | not started — **the root dependency** |
| §3 (memory) | **Episodic** run-history store (feeds the trainer) | partial (blackboard is in-proc only) |
| §9 | Human-feedback capture UX (thumbs/corrections) | not started |

**Key insight driving the build order:** D13 makes **evals the acceptance criterion** for two things —
(1) a provider may only be a *failover target* for a **write-capable** agent after it passes that
agent's eval **+ a tool-calling contract test**, and (2) **every trainer change** must beat the eval
baseline (on failure *diffs*, human-reviewed) before going live. So **nothing write-capable and nothing
self-improving can ship before the eval harness exists.** The eval harness is step A, not an afterthought.

---

## 2. Decisions to lock with the user (before code)

1. **Eval harness: build-light vs. tool.** Recommendation: **build-light, self-hosted** (a small
   `ai-agents/src/evals/` runner over versioned YAML/JSON cases + the Gateway `echo` provider for
   deterministic CI) rather than adopting a framework — keeps it swappable (spec §9 open item) and
   dependency-free like the rest of `ai-agents/`. Traces emit as structured JSONL now, migrating to
   WS9 when it lands.
2. **Where write-capable agent approvals land.** WS4 just built a **`automation_approvals`** store +
   Cerbos policy + platform endpoints for suspended *automation* writes. Recommendation: **generalize
   it** — rename/extend to `agent_approvals` (or add `origin: automation|agent`) so a specialist's
   `ApprovalRequiredError` files the same kind of human-decidable record through an mcp-hub
   `approvals.request`-style tool, reusing the platform-ui Approvals inbox. Avoids two parallel
   approval surfaces. (Decision: unify vs. sibling store.)
3. **First write-capable specialist.** Recommendation: **scheduler/ops** or **agency-creative** doing
   `low_write` task/deliverable updates — reuses the existing low-impact hub write tools and the D14
   path already in the runner. Which vertical first?
4. **Local-model serving stack** (spec §9): vLLM vs Ollama vs TGI, and the GPU sizing trigger (this
   feeds WS10 infra). Recommendation: **Ollama first** (already the Gateway's local-first provider),
   vLLM when throughput demands it. Confirm we're not buying GPU until a real workload justifies it.
5. **Knowledge-graph substrate:** extend Postgres (edges table over the existing D9-governed store) vs.
   a dedicated graph DB. Recommendation: **Postgres edges first** (inherits D9 authorization for free);
   dedicated graph DB is a later, evidence-driven move.

---

## 3. Build order

### Step A — Eval harness + run tracing (the gate substrate; §6, D13) — ✅ **BUILT 2026-07-15**
Shipped in `ai-agents/src/evals/` (build-light, deterministic, CI-runnable; 8 tests, tsc clean):
`trace.ts` (non-invasive JSONL run tracing + typed status — also the episodic/WS9 feed), `harness.ts`
(`runSuite` + `diffBaseline` — acceptance is a **failure diff**, not a scalar), `cases.ts` (regression
floor for both specialists + the **adversarial/prompt-injection containment suite**), `contract.ts`
(the tool-calling contract check + `allowedAsFailoverTarget`). What the original plan called for,
for the record:
- `ai-agents/src/evals/`: a runner that executes an agent/orchestrator against a **case set**
  (`{goal, envelope, fixtures, asserts}`), scoring task-success + faithfulness + regression. Cases are
  **versioned** with **provenance separation** (held-out vs rotating) and a **significance bar** — a
  green scalar delta is NOT sufficient; the report surfaces **failure diffs** (D13).
- **Mandatory adversarial / prompt-injection regression suite** (D13, §6 guardrails): untrusted content
  must be treated as data, never instructions; cases assert the agent refuses injected tool calls.
- **Run tracing:** every step/tool-call/token/cost already flows through `runAgent`'s `steps[]` and the
  Gateway's cost accounting — emit them as structured **JSONL traces** now (schema stable), and wire to
  WS9 when it exists. This is also the episodic-memory feed (Step D).
- **Tool-calling contract test** harness: asserts a given provider, for a given agent, emits
  well-formed tool calls — the second half of the D13 failover gate.
- Verify: the two existing read-only specialists get baseline eval suites (locks a regression floor).

### Step B — Write-capable specialists — ✅ **BUILT 2026-07-15**
Shipped: `ai-agents/src/write-agent.ts` (`runWriteAgent` — enforces **D13** then **D14**), the first
write-capable specialist `task-triager` (`tasks.list` read + `tasks.update` low_write), and the
**agent approval surface** — reusing the WS4 `automation_approvals` store via a new `origin`
(`automation|agent`) + `agent_name` column (migration `0016`, controller + Cerbos unchanged), the
hub `approvals.request` tool extended to pass `origin/agentName`. `ApprovalRequiredError` now carries
the intended `args` so a filed approval is actionable. Verified: ai-agents 37 tests (4 new
`write-agent.test.ts`), hub 15 (1 new), platform `automation-approvals` 6 (2 new) live PG+Cerbos; all tsc clean.
- **§2 decision 2 RESOLVED:** generalized the WS4 surface (one inbox, `origin` column) rather than a
  parallel `agent_approvals` store — least churn, single human-decide flow.
- **D13 provider gate (built):** `AgentDef.evaledProviders` lists providers cleared for this agent by
  its eval + contract suite; `runWriteAgent(..., servingProvider)` forces **read-only** (write tools
  stripped) on any un-evaled provider. `task-triager` ships with `evaledProviders: []` — write
  capability is earned per provider, never assumed, so today it runs read-only until an operator evals one.
- **Remaining Step-B follow-ups (documented, not blocking):** (a) the orchestrator runs sub-agents via
  the plain runner, so a write specialist is deliberately NOT in the supervisor set until the
  orchestrator routes writes through `runWriteAgent`; (b) `servingProvider` is caller-supplied — the
  Gateway reporting the actual provider it served (so the gate auto-detects failover) is the one live
  wire left. Original plan text for the record:

- Promote the first specialist to `low_write` (§2 decision 3). The runner already refuses
  `high_write`/unclassified and files an approval; **wire that suspension to a real approval record**
  (§2 decision 2 — reuse/generalize the WS4 `automation_approvals` surface via an mcp-hub
  `approvals.request` tool carrying the OBO envelope, so the write lands in the platform-ui Approvals
  inbox and the hub audit trail).
- **D13 failover safety in the runner/Gateway wiring:** a write-capable agent may only fail over to a
  provider that passed its eval + tool-contract test; **on failover to an un-evaled provider the agent
  is forced read-only / human-in-loop.** Encode the allowed-provider set per agent.
- Gate merge on: the agent's eval suite (incl. the adversarial set) green.

### Step C — Local-model registry + weight provenance (D13) — **registry BUILT 2026-07-15; serving/LoRA infra-deferred**
Shipped: `ai-agents/src/models/registry.ts` (+ 7 tests) — the D13 governance layer:
- **Weight provenance at intake** — a local-weight entry must declare an allow-listed format
  (default **safetensors-only**), a **pinned SHA-256**, and a **trusted mirror**; a LoRA/fine-tune must
  name a registered base. Cloud models need no blob. `verifyWeightDigest` refuses a digest mismatch
  (code-signing doesn't cover weight blobs, so provenance is explicit + verified).
- **Eval-gated activation** — `approveForServing` requires verified provenance **AND** a passing eval
  attestation (from Step A) at/above the policy score floor; `isRoutable` is the Gateway's routing gate.
  LoRA/fine-tune candidates are just entries that must clear the same bar.
- **Deferred (infra/GPU, documented):** actually serving local frontier models behind the Gateway
  (Ollama first, §2 decision 4; cloud stays failover), running fine-tunes, and GPU sizing (feeds WS10).
  **The one runtime wire left:** the Gateway consulting `isRoutable` before routing to a local model
  (the registry is a library today, like Step A's harness before its WS9 hookup).

### Step D — Trainer + eval-gated improvement loop (§8.5, D13) — ✅ **BUILT 2026-07-15**
Shipped: `ai-agents/src/memory/episodic.ts` (+5 tests) and `src/trainer/trainer.ts` (+7 tests):
- **Episodic memory** — `Episode` built from a Step-A trace (`episodeFromTrace`); `EpisodicStore` is
  D9-governed: `query` hard pre-filters by the authorized-tenant-set (D9.1), `eraseTenant`
  hard-deletes (D9.2, crypto-shred reach), and feedback carries provenance/trust so **untrusted
  feedback is quarantined** and never a trainer signal (D9.3). Same schema as the JSONL trace, so a
  live run appends episodes directly.
- **Trainer** — `analyze` mines episodes for signals (protocol-error rate → prompt fix; a repeatedly
  failing tool → tool-use fix; **trusted** down-votes → few-shot) into typed `Proposal`s. Two locked
  gates, both in code: **Gate 1 `evalGate`** auto-rejects any proposal whose candidate suite regresses
  a case (a green scalar is not enough — the diff is the artifact); **Gate 2 `approve`** requires an
  explicit human attestation that they reviewed the failure diff, and only on an `eval_passed`
  proposal. There is **no proposed→approved path without both** — no autonomous production update.
  Proposal *generation* is a deterministic heuristic today; it can become LLM-assisted later, but the
  GATES stay deterministic + in code.
- **Deferred (documented):** the human-feedback capture *UX* (thumbs/corrections from bot/platform-ui
  into episodic memory) — the store + trust model are built; the surfaces that write to them are a UI wire.

### Step E — Knowledge graph / semantic layer (§8.6) — ✅ **BUILT 2026-07-15** — the cross-business "one brain"
Shipped: `ai-agents/src/knowledge/graph.ts` (`KnowledgeGraph`, +8 DB-backed tests), a `/graph/neighbors`
endpoint on the knowledge service, and the hub `knowledge.graph` read tool (thin wrapper like
`knowledge.search`). §2 decision 5 taken: **Postgres edges over the D9 store** (inherits D9 authz).
- Typed nodes (`graph_nodes`: tenant, entity_key, kind, acl, cross_company, provenance) + edges
  (`graph_edges`: rel). **D9.1 retrieval-time authorization** — `neighbors` is a **bounded** BFS
  (depth + node caps) that hard pre-filters both edges AND destination nodes by the caller's
  authorized-tenant-set + acl scope at every hop; the start node must itself be visible.
- **Cross-company one-brain nodes** are invisible unless the caller is cross-company-elevated
  (`ctx.crossCompany`, group_executive) — a lower-tenant / tool-authorizing agent never sees them;
  the service defaults it **false (fail-closed)**. `eraseSource`/`eraseTenant` hard-delete (D9.2).
- **Deferred (documented):** graph *ingestion* (entity/relation extraction riding the event backbone
  → nodes/edges) is the population pipeline; and surfacing cross-company nodes needs the platform
  resolver to attest a group_executive cross-company grant (today the service keeps it fail-closed off).

---

## 4. How it uses the rest of the system (unchanged invariants)
- **Models → Gateway** (local-first, failover w/ the D13 gate, cost cap, egress DLP).
- **Tools/data → MCP hub** (OBO; agents act as the requesting user; approvals via the shared surface).
- **Durable/resumable multi-step → Temporal** — still deferred (spec §2.2); the first real candidate is
  a long-running trainer or a multi-step write goal. v1 stays in-process with typed suspensions.
- **Events → backbone** ("on X, agent does Y") — the same bridge pattern WS4 uses.
- **Everything traced → WS9** (Step A emits the traces WS9 will consume).

## 5. Testing & verification
- Every agent (read AND write) ships with an **eval suite incl. the adversarial/prompt-injection set**;
  CI runs them against the Gateway `echo` provider for determinism.
- Write-capable agents: a **tool-contract test per allowed provider**; a failover-to-un-evaled-provider
  test asserting the agent drops to read-only.
- Trainer: a test that a proposal failing the baseline is **blocked**, and that the human gate sees the
  failure diff (not just a scalar).
- Knowledge graph: a D9.1 test that a lower-tenant user never retrieves a cross-company node.
- Registry: a provenance test (unpinned/unmatched SHA-256 weight is refused).

## 6. Open items / dependencies
- **Approval-surface unification** (§2 decision 2) — ✅ resolved in Step B (one `automation_approvals`
  inbox, `origin` column).
- **Vector-DB graduation point** (spec §9) — pgvector today; dedicated vector/graph DB is evidence-driven.
- **Temporal** — introduce when the first durable multi-step flow is real (likely the trainer or a
  multi-step write goal), not speculatively.

## 7. Post-sequence batch — WS9 + live wires + WS10 (BUILT 2026-07-15)

With §8 steps 1–6 code-complete, this batch closed the live wires and stood up WS9 + the WS10 runbook:

- **WS9 observability — BUILT.** `ai-agents/src/obs/collector.ts` (+4 tests) consumes the Step-A trace
  schema → per-agent metrics (success rate, status/provider breakdown, tool-failure counts, averages),
  `recent()` run feed, and **quality alerts** (`low_success`/`high_refusal` above a min-runs floor). Also
  `writesOnUnevaledProvider` — the D13 **detective** control (a write that ran on a non-eval-cleared
  provider), now possible because the Gateway reports the served provider.
- **Gateway provider reporting — BUILT (Go).** `/complete` now returns `provider` (the provider that
  served after failover); additive/back-compatible (`go build` clean, `Text`-only decoders unaffected).
  `ai-agents` `deps.lastProvider()` records it. This is the wire the D13 gate + WS9 attribution needed.
- **Orchestrator write-routing — BUILT.** `runOrchestrator` now routes write-capable sub-agents through
  `runWriteAgent` (D13 provider gate + D14 approval filing): a high_write suspends the WHOLE goal
  (`GoalSuspendedError`) **with a durable approval on file**; an un-evaled provider forces the sub-agent
  read-only and the goal still completes. `budgetedDeps` forwards `lastProvider`. Closes Step-B follow-up (a).
- **Graph ingestion — BUILT.** `ai-agents/src/knowledge/graph-ingest.ts` (+4 tests): `eventToGraph`
  (pure) maps a platform event → source-of-truth nodes + FK-derived edges (owns/has/includes/assigned_to);
  `ingestEvent` applies it. A live consumer subscribes the event backbone like the n8n bridge and calls it.
- **WS10 infra — RUNBOOK.** `infra/runbooks/local-model-serving.md`: Ollama-first serving + chain config,
  the registry approval flow (provenance → verify → eval → approve → route), D13 failover safety, GPU
  sizing table, and the LoRA/fine-tune flow. GPU + weight blobs are hardware, not code.

- **group_executive cross-company attestation — BUILT.** The knowledge service resolver now derives
  `crossCompany` from the resolved principal's roles (`group_executive`/`platform_admin`) and passes it
  to the graph, so the cross-company "one-brain" gate is reachable in production (not just fail-closed
  off). `EnvelopeResolver` returns `{ tenantSet, crossCompany }`; `/graph/neighbors` honors it. No
  platform change needed (roles already come back from `/principal/resolve`); +3 service tests.

- **Durable persistence — BUILT.** The episodic store + model registry now have Postgres-backed
  counterparts (`memory/episodic-pg.ts`, `models/registry-pg.ts`) so run history/feedback and model
  approvals survive restarts. The registry's pure D13 gates were extracted (`validateIntake`,
  `assertApprovable`) and are shared by both impls — no rule drift. +8 DB-backed tests (durability
  proven: a fresh instance on the same DB sees prior approvals). This turns the trainer/feedback loop
  and the routing gate from in-memory into durable state.

**Still open (genuinely infra / cross-repo, documented):** the Gateway consulting `isRoutable` before
routing to a local model (now that the registry is durable/shareable, this is a read-endpoint away);
**graph-ingestion live subscription** on the event backbone; a **UI feedback-capture** page writing
trusted feedback into the durable episodic store; Temporal; and real GPU/serving/fine-tune provisioning (WS10).
