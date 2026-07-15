# Gaiada Agent Platform — WS8 (build sequence §8 steps 1–6 code-complete)

Framework + orchestrator + RAG · evals & tracing · write-capable specialist · model registry · trainer
loop · knowledge graph. Remaining is infra (local serving/LoRA/GPU, WS10), a few live wires, and WS9.

Specialist-agent framework: models via the **AI Gateway**, tools via the **MCP hub** with the
requesting user's OBO envelope — an agent can never act with more authority than the human it
serves, and this process holds no provider keys and no database access, by construction.

**Spec:** `../docs/superpowers/specs/2026-07-04-ws8-ai-native-agent-platform.md`
**Status:** build-sequence **steps 1–3** done (specialists + orchestrator + knowledge/memory
platform). Local-model registry and the eval-gated trainer come next.

## Knowledge & memory platform (WS8 §3-4, D9 — this package is the SOLE owner)

`src/knowledge/` — store + HTTP service (`:3005`). D9 enforced and tested:
**retrieval-time authorization** (tenant + ACL as a hard SQL pre-filter BEFORE similarity
ranking — a cross-tenant chunk is never a candidate; the caller's tenant set comes from the
platform-resolved OBO envelope, so unverified identities get zero results);
**source-driven lifecycle** (re-ingest replaces, erase hard-deletes — crypto-shred reaches
this derived store); **memory integrity** (provenance + trust + confidence on every row;
untrusted content quarantined and never retrieved; agent-written facts down-weighted).
Embeddings via the Gateway's `/embed` (local-first ollama → gemini → offline hash).
The MCP hub's `knowledge.search` is a thin wrapper over this service.

**Knowledge graph / semantic layer (Step E, `src/knowledge/graph.ts`)** — typed entities + relations,
the cross-business "one brain". `neighbors` is a **bounded** BFS that inherits D9.1: it hard
pre-filters edges and destination nodes by the caller's authorized-tenant-set + acl scope at every
hop. Cross-company nodes are read-only and `group_executive`-gated — invisible unless the caller is
cross-company-elevated (fail-closed off by default). Exposed via `/graph/neighbors` and the hub
`knowledge.graph` tool. Populating the graph (entity/relation extraction over the event backbone) is
the deferred ingestion pipeline.

## Orchestrator (WS8 §2.2)

`supervisor` plans a goal, routes subtasks to specialists, and aggregates from a shared
**blackboard**. Brigade bounds enforced in code, not trusted to the model: per-goal budget
across the whole tree (two-tier with the Gateway's daily cap), fan-out cap, cycle guard
(identical subtasks never re-run), specialist failures become blackboard data the planner
must handle, and a `high_write` approval suspension bubbles up and suspends the entire goal.

```bash
npm run run-agent -- supervisor "Morning briefing for tenant <uuid>" telegram tg:555
```

## Eval harness + run tracing (WS8 next-plan Step A · spec §6 / D13)

`src/evals/` — the acceptance gate that unblocks everything write-capable and self-improving.
Build-light, self-hosted, dependency-free, and deterministic (scripted model + fixture tools, no
live Gateway/hub), so it runs in CI:

- **`trace.ts`** — wraps the proven runner non-invasively and emits a stable, versioned JSONL trace
  (`run_start → model/tool steps → run_end` with a typed status). This is the eval observation
  surface AND the episodic-memory / WS9 feed; a live run appends the same schema to a file.
- **`harness.ts`** — `runEvalCase`/`runSuite` score a trace against expectations; `diffBaseline`
  makes acceptance a **failure diff** (which cases newly regressed), not a scalar delta — that's what
  a human release gate reviews (D13).
- **`cases.ts`** — a regression floor for the two shipped specialists **plus the mandated adversarial
  / prompt-injection suite**: a model *fully subverted* by injected tool output still cannot escape
  the runner's allow-list / impact gate (containment is structural, not model goodwill).
- **`contract.ts`** — the tool-calling contract check (D13's other failover-gate half): a provider is
  an allowed failover target for a write-capable agent only if it clears the eval suite **and** emits
  well-formed single-JSON actions. `allowedAsFailoverTarget()` is the gate decision.

Run: `npm test` (or `npx vitest run src/evals`). 8 tests, tsc clean.

## Episodic memory + trainer — the eval-gated improvement loop (`src/memory/`, `src/trainer/`)

WS8 Step D — safe, continuous self-improvement:
- **`memory/episodic.ts`** — durable run history built from Step-A traces. D9-governed: `query` hard
  pre-filters by the authorized-tenant-set (D9.1), `eraseTenant` hard-deletes (D9.2), and **untrusted
  human feedback is quarantined** — never a trainer signal (D9.3).
- **`trainer/trainer.ts`** — `analyze` turns episode signals (protocol errors, repeated tool failures,
  trusted down-votes) into typed proposals. It **never applies anything autonomously**: Gate 1
  (`evalGate`) auto-rejects any proposal that regresses a case; Gate 2 (`approve`) requires an explicit
  human review of the failure diff, only on a proposal that already cleared Gate 1. No
  proposed→approved path without both (D13).

## Observability (WS9) — `src/obs/collector.ts`

Consumes the Step-A trace schema into per-agent metrics (success rate, status/provider breakdown,
tool-failure counts, averages), a recent-runs feed, and **quality alerts** (`low_success` /
`high_refusal`). `writesOnUnevaledProvider` is the D13 **detective** control — a write that ran on a
provider not eval-cleared for the agent — usable because the Gateway now reports the served provider
(`/complete` → `provider`, surfaced as `deps.lastProvider()`). Infra/serving lives in
`infra/runbooks/local-model-serving.md`.

Graph ingestion (`src/knowledge/graph-ingest.ts`) maps platform events → graph nodes/edges; a live
consumer subscribes the event backbone and calls `ingestEvent`.

## Durable stores (Postgres)

The episodic store and model registry ship as in-memory libraries (fast, test-default) **and**
Postgres-backed counterparts so run history/feedback and model approvals survive restarts:
- `memory/episodic-pg.ts` (`PgEpisodicStore`) — same D9 invariants in SQL (tenant pre-filter, feedback
  trust, erasure). The trainer/feedback loop's durable input.
- `models/registry-pg.ts` (`PgModelRegistry`) — reuses the **same pure D13 gates** (`validateIntake`,
  `assertApprovable`) as the in-memory registry, so provenance + eval-gating can't drift. A fresh
  instance on the same DB sees prior approvals (shareable with the Gateway's routing decision).

## Model registry — D13 weight-trust + eval-gated activation (`src/models/registry.ts`)

The governance layer for the model platform (WS8 Step C). A model is **not routable on trust alone**:
- **Weight provenance** — a local weight must be an allow-listed format (default **safetensors-only**),
  carry a **pinned SHA-256**, and come from a **trusted mirror**; `verifyWeightDigest` refuses a
  mismatch. LoRA/fine-tunes must name a registered base. Cloud models carry no blob.
- **Eval-gated activation** — `approveForServing` needs verified provenance **and** a passing eval
  attestation (from the harness above) at/above the score floor; `isRoutable` is the Gateway's gate.

Serving local models (Ollama-first), running fine-tunes, and GPU sizing are infra (WS10) and deferred;
the registry is the library that gates them. Run: `npx vitest run src/models` (7 tests).

## D14 action safety — enforced by the runner, tested

- **Allow-list**: an agent may only call the tools its definition names; anything else is a
  typed refusal and the run stops.
- **Impact taxonomy** on every allow-listed tool (`read` / `low_write` / `high_write`);
  `high_write` suspends for human approval — the tool is **never executed**.
- **Per-run budgets** (model steps + tool calls); exhaustion raises a **typed error carrying
  the transcript** — never a committed placeholder answer.
- Tool failures are fed back to the model as failures, not swallowed as facts.

## Specialists today

Read-only:
- **status-reporter** — projects + tasks → factual status report.
- **approvals-chaser** — pending agency approvals → nudge list.

Write-capable (run via `runWriteAgent`, not the plain runner/supervisor):
- **task-triager** — reviews open tasks and keeps them healthy with LOW-impact `tasks.update`.

## Write-capable specialists — D13 + D14 (`src/write-agent.ts`)

`runWriteAgent(def, goal, env, deps, tenantId, servingProvider)` runs a specialist that may hold
write capability and enforces both locked safety rules:

- **D13 provider gate** — a write-capable agent runs with its write tools only on a provider listed
  in `def.evaledProviders` (providers that passed *this agent's* eval + tool-calling contract). On any
  other provider it is **forced read-only** (write tools stripped from the allow-list), never executed
  by an unproven model. `task-triager` ships `evaledProviders: []` → read-only until an operator evals one.
- **D14 approval filing** — a `high_write` throws `ApprovalRequiredError` (nothing committed); the
  wrapper files a pending approval via the hub **`approvals.request`** tool with `origin: "agent"`,
  landing in the **same** platform `automation_approvals` inbox WS4 automation uses (generalized, not
  duplicated). A human approves/rejects in platform-ui. Auto-resuming an approved write is deferred to
  Temporal — the approved row is the durable artifact a resume step reads.

## Run one (needs ai-gateway + mcp-hub + platform up)

```bash
npm install
cp .env.example .env   # GATEWAY_TOKEN + HUB_SERVICE_TOKEN
npm run run-agent -- status-reporter "Status report for tenant <uuid>" telegram tg:555
```

The envelope (`telegram tg:555`) decides what the agent may see: an unlinked identity gets
denials from the platform and the agent reports that it couldn't access the data.
