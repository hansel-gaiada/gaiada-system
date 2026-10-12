# CLAUDE.md — ai-agents

Scope: `ai-agents/` — the **WS8 agent platform**: specialist agents, the supervisor orchestrator,
memory/RAG, model registry, evals and the trainer. Root `../CLAUDE.md` has program rules.

```
npm ci && npm run typecheck && npm test
npm run run-agent      # tsx src/cli.ts
```

`src/` = `runner/` (agent, orchestrator, specialists, write-agent, tool-aliases) · `memory/`
(episodic + Postgres-backed) · `knowledge/` (graph + pgvector store, graph-ingest) · `models/`
(registry) · `evals/` (cases, harness, contract, trace) · `trainer/` · `obs/` (collector +
OTel bridge).

## How agents are allowed to act

- **Models come from the Gateway. Tools come from the MCP hub** with an OBO envelope. There is no
  direct DB access and no provider key here.
- **D14 is enforced in code** (`agent-write-guard.test.ts`, `write-agent.ts`): an agent write
  above low impact suspends into an approval instead of committing. Approval suspension **bubbles
  up through the supervisor tree** (`approval-resume.test.ts`) — a suspended child must not be
  silently retried as a success.
- The orchestrator's guards are the safety envelope: blackboard state, **cycle guard**, a
  **per-goal budget shared across the whole tree**, and a fan-out cap. Removing any one of them
  turns a bad plan into an unbounded spend.
- `tool-aliases.ts` resolution **order** is load-bearing and pinned by
  `tool-alias-resolution-order.test.ts` — a more specific alias must win.

## The seat economics are a global rule

**No agent seat defaults to Opus.** The tiered workforce standard (seniors on Sonnet·high,
juniors cheaper, Opus reserved for genuinely hard design work) is what makes the platform
affordable per seat. Model choice is a budget decision, not a quality dial to max out.

## The eval harness is the root gate

`evals/` is not optional tooling — it gates everything downstream in WS8 (local-model registry,
then the eval-gated trainer). An agent change without an eval case is unverifiable by
construction: agent behaviour is stochastic, so "I ran it once and it worked" is not evidence.
Add the case, then change the agent.

## Sensitive tools: what the run store may hold (M5-G5c)

`src/sensitive-tools.ts` is a static per-tool policy registry, the agent-side twin of platform-nest's
`core/approval-arg-minimisers.ts`. For `agency_privacy.{find,export,erase}` the PERSISTED / logged /
model-facing copy of a call is `{minimised:"agency-privacy.v1", hashes, hints}` (the ERP's `subjectHash`,
ported byte-for-byte; parity pinned by a vector computed from the ERP code) and of its RESULT counts, ids and
status only. The LIVE hub call is unchanged. A per-goal `SensitiveScope` (AsyncLocalStorage, opened in
`runner/service.ts`) also scrubs the learned literals from every other persisted string: goal text, outcome,
blackboard, delegate events, errors, the trace, episodic memory. A tool with no policy is stored exactly as
before. Another tool opts in with `registerSensitiveToolPolicy`; built-ins are imported statically so no boot
order can leave one without its policy. Proof: `sensitive-tools.test.ts`, `sensitive-run.test.ts`.
Known residuals are listed in `docs/PERMISSION-CONTRACT.md` §29.

Memory/RAG is the **D9 owner** and uses pgvector; the knowledge graph is fed by the platform's
event → graph bridge, so an empty graph usually means that bridge is off, not that ingest is
broken.
