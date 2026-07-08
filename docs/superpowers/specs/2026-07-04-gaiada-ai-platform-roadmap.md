# Gaiada AI Platform — Program Roadmap & Scope

**Date:** 2026-07-04
**Status:** Living draft (brainstorming stage — nothing being built yet)
**Purpose:** Scope the company-wide AI transformation into workstreams we can brainstorm and build one by one. This is the umbrella plan; each workstream gets its own design spec.

---

## 1. Vision

Migrate Gaiada to **AI-assisted operation**: enhance every employee's capability and output, and consolidate all projects and tasks into **one digital platform with a single interface** to track all work. AI augments people; a custom platform is the source of truth; an MCP hub exposes company data/tools to AI and surfaces.

**Guiding principles**

- **All-local processing in production** on Gaiada's own servers; paid cloud AI only as automatic failover (governed by cap + alert). _(Consistent with the WA bot's `CapabilityRouter`.)_
- **One source of truth per capability** — no logic duplicated across layers.
- **Ship small, usable tools first**; learn from real employee/management use; build the big platform in parallel.
- **Swappable everything** — LLM providers, WhatsApp gateway, data adapters all behind interfaces.

---

## 2. Reframe: this is a program, not a single project

The architecture diagram (2026-07-04) describes a multi-layer platform. The MCP is **one layer**, not the whole thing. We decompose into workstreams, each brainstormed → spec'd → built independently.

---

## 3. Workstream Decomposition

| #     | Workstream                                      | What it is                                                                                                                                                | Depends on |
| ----- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **0** | **Discovery / current-state audit** _(ongoing)_ | Inventory ALL current AI usage + data sources + existing workflows. Living doc; data arrives gradually. Small pilot tools (below) also feed discovery.    | —          |
| **1** | **Foundation: custom Gaiada platform**          | The "1 interface" — in-house project/task/work-tracking system + Gaiada Central Database. Everything references this. Built in parallel while pilots run. | 0          |
| **2** | **MCP Hub**                                     | Integration layer exposing company data + tools to AI/surfaces via MCP protocol. Fronts the platform DB + other tools.                                    | 1          |
| **3** | **AI Gateway / Provider Router**                | Load-balance + security + provider routing/failover for Claude/Magnific/Meta/Agency etc.**Unified with the WA bot's `CapabilityRouter`.**                 | 0          |
| **4** | **Automation Engine (N8N)**                     | Workflow orchestration, CRON, glue — by CALLING MCP tools.                                                                                                | 2, 3       |
| **5** | **Surfaces**                                    | WA/Telegram bots*(specced bot = Surface #1)*, user-facing app, ERP UI.                                                                                    | 2, 3       |
| **6** | **Governance** _(cross-cutting)_                | Identity/roles, access control, audit, data governance, Central DB ↔ VPS sync coordination. Skeleton established early, deepened per workstream.          | —          |
| **7** | **Security & Resilience** _(own workstream)_    | **AI-augmented zero-trust defense-in-depth:** deterministic floor (mTLS, peer allowlist, private mesh/WireGuard, no public listeners, RBAC, immutable audit) + HA/DR (per-company physical+VPS pairs, streaming replication, immutable/WORM backups + PITR) + an AI security layer (anomaly detection, adaptive response, rogue-employee isolation, learns from every breach/recovery). AI-layer is **v2** (floor+SIEM first). | 1, 3       |
| **8** | **AI-Native / Agent Platform**                  | **Multi-agent brigade**: specialized single-responsibility agents + orchestrator/master + ML "trainer" agent (eval-gated, human-approved self-improvement). Memory, RAG + knowledge graph, local frontier models + registry + fine-tuning/LoRA, AI evals + guardrails. The "one brain." | 2, 3, 9    |
| **9** | **Observability**                               | System-wide OpenTelemetry (metrics/traces/logs), SLOs/error budgets, dashboards, synthetic checks. Distinct from the WS7 security SIEM. | 1          |
| **10**| **Platform Engineering & Delivery**             | IaC + GitOps + K8s/k3s-at-edge + CI/CD (with Sigstore/SBOM/SLSA) + SPIFFE/SPIRE workload identity + IDP/golden-paths + GPU/model-serving infra. Consistent, safe, staged delivery to the multi-site estate. | — |
| **C** | **Compliance & Data Governance** _(cross-cutting)_ | PCI-DSS (resort payments), PII/residency, WhatsApp consent/labor law, classification, retention/erasure, AI-data governance. Woven into every workstream (privacy-by-design). | 1, 7       |

---

## 3b. Critique-pass decisions (LOCKED)

- **Vertical strategy:** differentiating-custom + integrate commodity best-of-breed via MCP connectors; unify at the data/AI layer. (Not fully-custom every vertical.)
- **Offline-write scope:** full offline-write + reconciliation ONLY for connectivity-poor sites; well-connected sites use central-primary + read-replica.
- **Frontier infra adopted:** event backbone (Redpanda/NATS), durable workflows (Temporal), workload identity (SPIFFE/SPIRE), supply-chain security (Sigstore/SBOM/SLSA).
- **AI moat:** local frontier models + registry, domain fine-tuning/LoRA, knowledge graph/semantic layer, AI evals + guardrails.
- **Self-improvement:** ML trainer agent is **eval-gated + human-approved** (no autonomous production updates).
- **Security AI layer:** **v2** — deterministic floor + SIEM first.
- **Build approach:** **walking skeleton** (one thin end-to-end slice through every layer) before going wide.
- **New workstreams added:** WS8 (AI-Native/Agent Platform), WS9 (Observability), WS10 (Platform Engineering & Delivery), Compliance & Data Governance (cross-cutting).

---

## 3c. D1 resolution — Solo-Viable v1 vs Target-State (adversarial review)

**Constraint:** the builder/operator is solo (1–3 + Claude Code). Claude Code accelerates *building*, not *operating* — infra, on-call, and incident response are standing human load. The target-state below stays **fully intact as the north star (kept sharp), reclassified from "LOCKED now" to "target-state, hiring-gated"**; the near-term operating scope is the Solo-Viable v1. Issues handled one by one; scope expands toward target as headcount grows.

**Principle:** buy/managed-first · build only the differentiator · cloud-AI-first · single-region · one surface. Extend "differentiate-custom / integrate-commodity" to **infrastructure** (managed for commodity ops planes; local reserved for the target-state).

| Concern | Solo-Viable v1 (ship & operate now) | Target-State (hiring-gated — preserved) |
|---|---|---|
| Infra | Managed Postgres + managed container host / small K8s | Per-company physical+VPS pairs, all-local |
| Multi-site / sync | Single managed primary + read replicas; **custom sync engine deferred** (removes D3 + most of D5 from critical path) | Custom offline-first sync engine, regional primaries |
| AI | **Cloud-AI-first** (Claude/Gemini via lean Gateway) | Local frontier models + fine-tuning moat |
| Identity/authz | Managed IdP + Cerbos (one container) | Self-hosted IdP |
| Security | Managed/cloud security + deterministic floor | Self-hosted SIEM + AI-SOC |
| Surfaces | WhatsApp + Gaiada Assistant | + Telegram, mobile, ERP UI, voice |
| Verticals | Agency module (single tenant to start) | Resort/marine/print, full multi-tenant |
| Orchestration | Simple queues | Temporal + event backbone |

**Effect on the review:** deferring the custom sync engine neutralizes **D3** and most of **D5**; managed infra absorbs much of **D15/D16/D17**; cloud-first Gateway simplifies **D8**. Live even at solo-pilot scale: **D2 (compliance), D4 (bot identity), D6 (WA ban), D9 (RAG isolation).**

**Trade accepted:** in v1, non-regulated company data runs on managed cloud; regulated verticals (resort payments etc.) are gated behind the target-state local build.

---

---

## 4. Architecture Backbone (layer responsibilities) — DECIDED

To prevent duplicated logic, each layer owns one thing:

- **MCP = access.** Exposes data/tools as nouns & verbs (query projects, create task, fetch schedule, run OCR…). One authoritative interface per capability.
- **N8N = orchestration.** Sequences and schedules workflows by **calling MCP tools**. No business logic lives only in N8N.
- **Custom services = rich logic.** The WhatsApp bot, summarizers, agents — too complex for low-code — run as dedicated services that also call MCP.
- **Gateway/Provider Router = AI access + safety.** All model calls route through it (local-first, paid failover, cost cap + alert, security).

**The WhatsApp bot is its OWN service** (Surface #1), not hosted inside N8N. N8N handles simpler glue automations.

---

## 5. Delivery Strategy — DECIDED

1. **Now:** brainstorm all workstreams (this program), one by one, to lock scope.
2. **Then:** build and release **small, self-contained tools** that management and employees can start using immediately (the WA bot P1–2 is the first; more small utilities as discovery reveals needs). These deliver value early AND act as live discovery — real usage informs the ERP requirements.
3. **In parallel:** build the **custom Gaiada platform (Workstream 1)** and **MCP (2)** in the background while the pilots are in use.
4. **Merge:** surface features that need company data (e.g. WA bot Phase 3) light up once the platform + MCP are ready.

Dependency-safe order for building: Discovery (continuous) → small pilots + Gateway (independent) ∥ platform → MCP → deeper surfaces + N8N automations.

---

## 6. Current-State Inventory (Workstream 0 — living, populated incrementally)

**Confirmed in-use tools (must be integrated — see `2026-07-04-pilot-tools-wave1.md`):**

- **Claude Team** — human-facing AI subscription for all employees. Programmatic access = Anthropic API (separate billing). Provider via Gateway.
- **Gemini Team** — human-facing AI subscription. Programmatic access = Gemini API. Provider via Gateway. (Supersedes the WA bot spec's "Gemini free tier" placeholder — config change only.)
- **Magnific AI** — image & video processing. Integrated as `image.enhance` via Gateway.
- **Google Drive** — company file storage. First-class connector (Document Q&A source, transcript/summary/capture destination, WhatsApp file archive). Google Drive MCP usable.
- **WhatsApp** — primary bot/assistant surface.

**Other endpoints / discovery:**

- **Meta / Agency / Claude.ai** — third-party endpoints reached via the Gateway (roles TBD).
- **Undocumented usage** — multiple tools/workflows not yet catalogued. _More data will arrive gradually; this section is expected to grow. Do not treat gaps here as blocking — Workstream 0 fills them over time._

Each newly-surfaced tool gets logged here with: what it does, who uses it, what data it touches, and whether it should be wrapped by MCP or replaced.

---

## 7. Cross-cutting concerns (apply to every workstream)

- **Provider routing/failover** (Gateway) — local-primary, paid-fallback hot-swap, circuit breakers, cost cap + alert.
- **Access control & audit** — role + scope based (as in the WA bot spec); every data-touching action authorized and logged.
- **Privacy** — company data stays local in prod; cloud only on failover.
- **Data sync** — Central DB ↔ VPS auto-sync on schedule (define consistency model in Workstream 1/6).

---

## 8. Relationship to existing specs

- **WhatsApp Automation Bot** (`2026-07-04-whatsapp-automation-bot-design.md`) = **Surface #1** in Workstream 5. Its Phase 1–2 are the first "small pilot tools." Its Phase 3 consumes the MCP (Workstream 2). Its `CapabilityRouter` is the seed of the Gateway (Workstream 3).

---

## 9. Open decisions (to resolve as we brainstorm each workstream)

- **Workstream 1 (platform):** entity model (projects, tasks, employees, clients, time, files…), MVP scope, tech stack (align with existing Next.js/other company stack?), Central DB ↔ VPS sync model, migration/import from current tools.
- **Workstream 2 (MCP):** which tools/verbs to expose, transport, auth model, how it fronts the platform + non-DB tools (OCR, Magnific, etc.), local deployment.
- **Workstream 3 (Gateway):** provider registry, routing/load-balancing policy, key management, security boundary vs the MCP.
- **Workstream 5 (surfaces):** Telegram parity, the user-facing app, the ERP UI.
- **Small pilot tools:** which utilities beyond the WA bot to ship first for employee testing.

---

## 10. Suggested brainstorming order (one by one)

Because MCP tools mirror platform capabilities, and the Gateway is already half-designed in the bot spec, a productive order is:

1. **Workstream 1 — custom platform core** (entities + MVP scope + stack). _Defines what MCP will expose._
2. **Workstream 2 — MCP Hub** (your original request; now grounded in the platform's capabilities).
3. **Workstream 3 — Gateway** (formalize + unify with `CapabilityRouter`).
4. **Small pilot tools shortlist** (what else to ship for early employee use).
5. **Workstreams 4 & 5** (N8N automations, other surfaces) as needed.

_(We can reorder — e.g. start directly with MCP — but sketching the platform's core entities first makes the MCP brainstorm concrete.)_
