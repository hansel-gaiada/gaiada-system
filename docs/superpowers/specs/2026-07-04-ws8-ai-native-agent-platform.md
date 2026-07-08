# Workstream 8 — AI-Native / Agent Platform

**Date:** 2026-07-04
**Status:** Design draft (brainstorming stage — not being built yet)
**Parent:** `2026-07-04-gaiada-ai-platform-roadmap.md` (Workstream 8)
**Depends on:** WS3 Gateway (model access), WS2 MCP (tools), WS1 platform (data), WS9 Observability (evals/traces).
**Scope:** The "brain" that makes the system AI-native — a multi-agent brigade, its orchestration, memory, knowledge, evaluation/guardrails, and a self-improving ML loop.

---

## 1. Vision

Not one chatbot — a **brigade of specialized AI agents** that work as a team to augment humans, coordinated by an orchestrator/master, continuously improved by a dedicated ML "trainer" agent. Every agent reaches models via the **Gateway** and tools/data via the **MCP hub** (OBO auth), so the whole brigade inherits local-first routing, security, and governance for free.

---

## 2. The brigade — DECIDED shape

### 2.1 Specialized agents (single responsibility each)
Each agent has a focused role, its own system prompt, tool allow-list (via MCP + Cerbos), and evals. Examples (grow over time):
- **Summarizer** (group/project digests — WA bot), **Researcher/Q&A**, **Document/Knowledge** agent, **Transcription/Action-item** agent, **Scheduler/Ops** agent, **Agency creative** agent, per-vertical agents (resort, marine, printing), **Security analyst** agent (WS7).

### 2.2 Orchestrator / master
- Receives a goal, **plans**, decomposes into subtasks, **routes to the right specialist agents**, manages hand-offs and shared context, aggregates results, and returns a coherent outcome.
- Enforces **loop guards**, budgets (via Gateway cost caps), and per-step authorization (Cerbos).
- Pattern: supervisor/worker (hierarchical) with a shared **blackboard**/context store; durable + resumable via **Temporal** (WS10/infra) for long-running, reliable multi-step work.

### 2.3 ML "trainer" agent — self-improvement (eval-gated) — DECIDED
- Continuously analyzes agent performance (from evals + traces + human feedback) and **proposes improvements**: prompt refinements, routing changes, fine-tune/LoRA candidates, new few-shot examples, tool-use fixes.
- **Every change must (a) beat the eval baseline AND (b) get human approval before going live.** No autonomous production updates. Safe, continuous improvement — mirrors the WS7 security learning loop.

---

## 3. Memory

- **Short-term:** per-conversation/task working context (blackboard).
- **Long-term:** durable memory store (facts, preferences, past outcomes) with retrieval; tenant- and user-scoped, RBAC-governed.
- **Episodic:** agent-run history (what was tried, what worked) — feeds the trainer.

---

## 4. Knowledge platform (moat) — DECIDED

- **RAG:** embeddings + vector store (pgvector to start; dedicated vector DB later) over company docs, chat history, and data.
- **Knowledge graph / semantic layer** over multi-business data (the `graphify` instinct) — the cross-company "one brain" for reasoning and intelligence.
- **Ingestion pipelines:** documents (via media pipeline), Google Drive, platform data, events (WS-event backbone) → chunk → embed → index → graph.

---

## 5. Model platform (moat) — DECIDED

- **Local frontier models** (Llama/Qwen/DeepSeek) run locally, served behind the Gateway; **model registry** (versions, metadata, eval scores).
- **Domain fine-tuning / LoRA** on Gaiada data for specialized tasks — private, owned, un-copyable AI.
- **GPU capacity planning** required (feeds WS10 infra).
- Cloud frontier models (Claude/Gemini) remain as **failover + hardest tasks** via the Gateway.

---

## 6. Evaluation, observability & guardrails — DECIDED

- **Eval suites per agent** (task success, faithfulness, regression) — gate all trainer changes and releases.
- **Run tracing** (every agent step, tool call, token, cost) → WS9 observability; quality/hallucination monitoring.
- **Guardrails:** input/output filters, PII/DLP (via Gateway), prompt-injection defense (untrusted content = data, never instructions), action allow-lists, human-in-loop for high-impact actions.

---

## 7. How it uses the rest of the system

- **Models → Gateway** (local-first, failover, cost cap, egress DLP).
- **Tools/data → MCP** (OBO auth; agents act as the requesting user, never over-privileged).
- **Reliable workflows → Temporal** (durable, resumable).
- **Events → event backbone** (triggers: "on X, agent does Y").
- **Everything traced → WS9.**

---

## 8. Build sequence
1. Single specialist agent framework (system prompt + MCP tools + evals) — powers the pilot Gaiada Assistant skills.
2. Orchestrator + 2–3 specialists (hand-off, shared context).
3. Memory + RAG/knowledge platform.
4. Local models + registry; then fine-tuning/LoRA.
5. Trainer agent + eval-gated improvement loop.
6. Knowledge graph / semantic layer.

---

## 8b. D9 resolution — knowledge/memory isolation, erasure & integrity (LOCKED, adversarial review)

The vector store, KG, and durable memory are **derived copies of an eventually-consistent, access-controlled source** and must inherit its authorization, lifecycle, and classification. **WS8 is the sole owner**; the MCP `search` tool is a thin wrapper; the bot/pilot RAG are interim shims that migrate here.

1. **Retrieval-time authorization (hard pre-filter).** Stamp every chunk/node with `tenant_id`, `source_row_id`, `acl`, `source_hlc`. Apply the requester's OBO Cerbos/RLS scope as a **hard candidate pre-filter BEFORE similarity ranking** — authorizing the tool call is insufficient. Cross-company "one brain" nodes are **read-only, `group_executive`-gated, and never fed to a tool-authorizing agent under a lower-tenant user.**
2. **Source-driven lifecycle.** The indexer **subscribes to source changes** (the outbox / change feed): re-embed on update, **hard-delete embeddings + KG nodes on tombstone/erasure**. This is how D2 crypto-shred/erasure actually reaches derived stores. Classify the vector store + KG as **regulated data** (inherit source retention/residency).
3. **Write-time memory integrity.** Every durable memory carries **provenance + source-trust + confidence**. Memory derived from untrusted senders/content is **quarantined and never auto-promoted to durable "fact"** without corroboration/curation. Agent-written facts are tagged so the RAG pipeline down-weights unverified ones — breaking the self-reinforcing hallucination loop.

## 8c. D13 — model trust & failover safety (LOCKED, adversarial review)

- **Evals as real acceptance criteria** (not a scalar gate): held-out + rotating sets, provenance separation, a significance bar, and a **mandatory adversarial/prompt-injection regression suite**. The human self-improvement gate reviews **failure diffs**, not a green delta.
- **Failover safety:** every provider in a **write-capable** agent's chain must pass that agent's eval **+ a tool-calling contract test** before it is a failover target; on failover to an un-evaled provider, the agent is forced **read-only / human-in-loop**. (Claude↔Gemini are not interchangeable for write actions without this.)
- **Weight provenance (when local models land):** safetensors-only, pinned SHA-256 from a trusted mirror, provenance fields in the model registry — code-signing (Sigstore/SBOM) does not cover weight blobs.

## 8d. D14 — agent action safety (LOCKED, adversarial review)

- **Impact taxonomy** on every write tool; **unclassified ⇒ confirmation required.**
- **Deterministic precondition re-check** for premise-asserting writes: re-read state at the service layer and reject false-premise transitions; offer **dry-run/preview**. Cerbos authorizes *whether* a user may write; this checks the write is *warranted*.
- **Two-tier budgets:** coarse per-tenant cap (Gateway) **plus a per-run/per-goal token+step+cost ceiling** in the orchestration context; orchestration-tree depth + global concurrency caps + blackboard cycle detection to bound brigade fan-out.
- **Degradation returns a typed error, never a committed placeholder;** budget exhaustion suspends the Temporal workflow for human resume rather than writing garbage. Agent-originated writes carry provenance (feeds D9 down-weighting).

## 9. Open items
- Agent framework choice (build-light on the model SDKs vs a framework) — keep swappable.
- Orchestration pattern specifics (supervisor vs planner-executor vs graph).
- Vector DB selection point (pgvector → dedicated).
- Eval harness tooling (self-hosted).
- GPU sizing + model-serving stack (vLLM/Ollama/TGI).
- Human-feedback capture UX (thumbs, corrections) feeding the trainer.
