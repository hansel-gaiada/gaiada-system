# Gaiada AI Platform — Program Overview & Index

**Date:** 2026-07-04
**Status:** Living index (brainstorming stage)
**Purpose:** Single entry point tying every spec together — vision, spec index, dependency graph, build order, open decisions.

---

## 1. Vision (one paragraph)

An **AI-native, zero-trust, multi-business** operating platform for Gaiada and its child companies (resort, marine, printing, digital agency, …): one interface to track all work, AI woven through it to augment every employee, all data processed **locally in production** with automatic paid-cloud failover, defended and continuously hardened by an AI-augmented security layer. Delivered by shipping **small daily-use tools first** (value + discovery) while the custom platform is built in parallel.

---

## 2. Spec index

| Spec | Layer | Summary |
|---|---|---|
| `2026-07-04-INDEX-overview.md` | — | This document. |
| `2026-07-04-gaiada-ai-platform-roadmap.md` | Program | Workstream decomposition (WS0–7), delivery strategy, current-state inventory. |
| `2026-07-04-pilot-tools-wave1.md` | Near-term | First shippable tools: WhatsApp Assistant + Gaiada Assistant (skills), confirmed-tool integration. |
| `2026-07-04-whatsapp-automation-bot-design.md` | Surface #1 | WA bot: summaries + media + Q&A/agent (3 phases). |
| `2026-07-04-ws1-gaiada-platform-architecture.md` | WS1 | Custom modular multi-tenant local-first platform; TS/NestJS core + Go edge. |
| `2026-07-04-ws1-core-schema-and-module-framework.md` | WS1 | Core entities + how vertical modules extend the core. |
| `2026-07-04-ws1-rbac-engine.md` | WS1 | IdP (authN) + Cerbos (authZ) + RLS; role+scope; identity_links. |
| `2026-07-04-ws1-sync-engine.md` | WS1 | Two-tier replication (HA streaming + outbox reconciliation), HA/DR, backups. |
| `2026-07-04-ws2-mcp-hub.md` | WS2 | Aggregating MCP hub, per-site+central, OBO auth. |
| `2026-07-04-ws3-ai-gateway.md` | WS3 | Provider routing + egress security chokepoint + DLP. |
| `2026-07-05-ws4-automation-orchestration.md` | WS4 | Temporal (durable) + N8N (glue); orchestrate by calling MCP tools. |
| `2026-07-05-ws5-surfaces.md` | WS5 | WhatsApp/Telegram/Assistant/web/ERP/mobile/voice; API-first, no surface asserts identity. |
| `2026-07-05-ws6-governance.md` | WS6 | Cross-cutting: identity, audit, data classification, risk register, change mgmt. |
| `2026-07-04-ws7-security-and-resilience.md` | WS7 | Zero-trust floor + SIEM + AI security layer + HA/DR. |
| `2026-07-04-ws8-ai-native-agent-platform.md` | WS8 | Multi-agent brigade + orchestrator + ML trainer; RAG/KG; local models. |
| `2026-07-04-ws9-observability.md` | WS9 | OpenTelemetry metrics/traces/logs, SLOs; distinct from security SIEM. |
| `2026-07-04-ws10-platform-engineering-delivery.md` | WS10 | IaC + GitOps + K8s/k3s + signed CI/CD + SPIFFE + IDP + GPU infra. |
| `2026-07-04-compliance-data-governance.md` | X-cut | GDPR-grade compliance gate, risk register, cross-border. |
| `2026-07-05-day-one-crypto-shred-and-ingestion-scrubber.md` | Day-one | Unretrofittable: KEK hierarchy + PAN/KTP ingestion scrubber. |
| `2026-07-05-adversarial-weakness-review.md` | Review | 63 verified weaknesses, 17 issues, 5 tiers (all resolved). |
| `2026-07-05-uncovered-angles-resolution.md` | Review | Resolutions for the 11 uncovered attack angles (U1–U11). |

---

## 3. Dependency graph

```
WS0 Discovery (continuous) ─────────────────────────────────┐
                                                             │ informs
Pilot Wave 1 (Gateway only) ── ships first, feeds discovery ─┘
        │ uses
        ▼
WS3 Gateway ──────────────┐
                          ▼
WS1 Platform ──► WS2 MCP ──► Surfaces (WA bot P3, user app, ERP UI) + WS4 N8N
   │  (schema, modules,
   │   RBAC, sync/HA-DR)
   ▼
WS7 Security & Resilience (cross-cutting; floor established early)
```

- **Independent / now:** Pilot Wave 1, WS3 Gateway, WS7 security floor.
- **Foundation:** WS1 platform → unblocks WS2 MCP → unblocks data-backed surfaces + WS4.
- **Cross-cutting:** WS7 (security), RBAC, observability, discovery.

---

## 4. Suggested build order

1. **Pilot Wave 1** (WhatsApp Assistant → Gaiada Assistant skills) on the **Gateway** + basic **security floor**. Value + discovery now.
2. **WS1 platform thin slice** (core: companies/users/RBAC/work model + agency module, single-site) in parallel.
3. **Sync engine** (T1 HA first, then T2 reconciliation) once single-site core is stable.
4. **WS2 MCP** over the platform → light up WA bot Phase 3 + data-backed assistant skills.
5. **Additional verticals** (resort, marine, printing) one module at a time.
6. **WS4 N8N** automations + **WS5** further surfaces as needs mature.
7. **WS7 AI security layer** on top of the deterministic floor as the estate grows.

---

## 5. Cross-cutting decisions (locked)

- Local-first prod, paid-cloud failover (Gateway); provider-swappable AI.
- MCP=access, N8N=orchestration, custom services=logic, Gateway=AI egress.
- Multi-tenant shared DB + RLS; heterogeneity via compile-time modules + custom fields.
- IdP + Cerbos + RLS for authN/authZ; OBO everywhere.
- Two-tier replication; HA ≠ backup → immutable WORM backups + PITR.
- AI-augmented zero-trust defense-in-depth.

---

## 6. Consolidated open decisions

- Anthropic/Gemini **API access + budget** (Team-plan nuance).
- Zitadel vs Keycloak; Wazuh vs Elastic; final blob store (MinIO).
- RPO/RTO targets per tier/site; which sites truly need offline-write.
- Google Drive auth model; thin web UI scope.
- Module framework packaging details; reporting recompute strategy.
- **Gaps addressed (critique pass — see roadmap §3b):** WS8 AI-Native/Agent Platform, WS9 Observability, WS10 Platform Engineering & Delivery, Compliance track — all added. Event backbone, Temporal, SPIFFE/SPIRE, supply-chain security, local models + fine-tuning + knowledge graph — all adopted. Vertical strategy = differentiating-custom + integrate; offline-write = connectivity-poor sites only; AI security = v2; build via walking skeleton.
- **Still open:** team/talent sizing to scope; per-vertical custom-vs-integrate calls; GPU capacity plan; PCI scope; legal input for compliance.

---

## 7. Status

Architecture spine (WS1/2/3/7) + first deliverable (Pilot Wave 1) designed and mutually consistent. Detailed design remaining: agency module, API surface, reporting/storage, WS4/WS5. A critique/upgrade pass follows to push toward frontier grade before implementation planning.
