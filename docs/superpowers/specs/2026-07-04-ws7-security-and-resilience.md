# Workstream 7 — Security & Resilience

**Date:** 2026-07-04
**Status:** Design draft (brainstorming stage — not being built yet)
**Parent:** `2026-07-04-gaiada-ai-platform-roadmap.md` (Workstream 7)
**Scope:** Company-wide security and resilience: AI-augmented zero-trust defense-in-depth, HA/DR, and an AI security layer that responds (tiered) and learns (gated). Cross-cutting; consolidates the sync spec's HA/DR and channel-security items.

---

## 1. Philosophy — DECIDED

**AI-augmented zero-trust defense-in-depth.** Deterministic controls are the unbreakable floor; AI sits on top adding intelligence (detection, adaptive response, learning). AI makes defense *smart*; the floor makes it *sound*. AI never replaces the floor, and the AI is treated as a hardened, monitored attack surface itself.

---

## 2. Deterministic floor

### 2.1 Zero-trust network
- **WireGuard private mesh** interconnecting all sites; **mTLS on every service-to-service call**.
- **Peer allowlist** — services accept connections only from known, authenticated peers.
- **No public listeners** except the **Gateway** (WAF + strict auth) — the sole sanctioned ingress; "no access without our protocol."
- **Micro-segmentation** per tenant/service; DB and sync ports never exposed publicly.

### 2.2 Identity & secrets hardening
- Builds on the RBAC engine (IdP + Cerbos). Enforce **MFA**, **least privilege**.
- **Secrets vault** (Vault / OpenBao); **short-lived certificates** with lifecycle rotation.
- **Service accounts** for non-human principals (N8N, sync engine, schedulers) — scoped roles, no standing broad access.

### 2.3 Tamper-evident audit
- **Append-only, hash-chained** audit log (each entry chains the prior hash → tamper-evident).
- Shipped to **WORM storage**, held **separately from the app DB** so a DB compromise cannot erase the trail.
- Feeds the SIEM; is the forensic source of truth.

---

## 3. Sensor floor + AI layer — DECIDED foundation

- **Wazuh or Elastic Security** (self-hosted, all-local) provides the sensor/data floor: host-based intrusion detection, endpoint telemetry, log aggregation.
- **Log ingestion** from every service: platform, MCP hub, Gateway, sync engine, IdP, **Cerbos decisions**, WA bot → **central SIEM**.
- **AI analysis layer** consumes normalized SIEM events → anomaly detection, risk scoring, correlation, threat classification. Its LLM calls route through the **Gateway/CapabilityRouter** (local-first, paid failover).

---

## 4. Response — tiered autonomy (SOAR-style playbooks) — DECIDED

| Tier | Actions | Authority |
|---|---|---|
| **Low-risk, reversible** | rate-limit, step-up MFA challenge, quarantine a session, revoke a token | **AI auto-executes instantly** |
| **High-impact** | user lockout, server isolation, network-segment block | **Human approval required** (request → security admins + management) |

Response actions integrate with **Cerbos** (scope-down/revoke), **IdP** (force re-auth / disable / kill sessions), **network** (WireGuard/firewall isolate), and the **rate-limiter**. Every action is logged.

---

## 5. Rogue-employee / insider isolation

- **Per-user behavioral baseline:** normal access patterns, data volumes, times, locations.
- **Anomaly triggers:** mass export, off-hours bulk access, cross-tenant access attempts, privilege escalation, abnormal query volume.
- **Response (tiered):** low → step-up MFA / rate-limit / flag; high → human-approved **lockout + session kill + forensic snapshot**.
- **Forensics:** the immutable hash-chained audit provides the trail; snapshots preserve state at detection time.

---

## 6. Learning loop — safe growth

- Every incident + response + outcome recorded in a structured **incident knowledge base**.
- **Human review labels** each event (true / false positive, severity, correct response).
- Learning applied via:
  1. Updated **detection rules / thresholds**.
  2. **RAG over past incidents** as context for the AI analyst (retrieval, not weight updates).
  3. Periodic **model tuning — gated by human review**.
- **No autonomous online learning on raw data** — that is a data-poisoning vector. "The AI grows" = curated, human-validated accumulation of knowledge + rule refinement.

---

## 7. Securing the AI security layer itself (it is a target)

- **Prompt-injection hardening:** attacker-controlled logs may embed malicious instructions → **all log content is treated as data, never instructions**; the analyst runs sandboxed.
- **Split authority:** the analysis model only *proposes* actions; a separate **response orchestrator validates every proposed action** against the allowed playbook set + tier **before** execution. The AI cannot invent actions or bypass Cerbos/tier gates.
- **Constrained output:** actions emitted only as a fixed schema (no free-form command execution).
- **Auditing & oversight:** all AI actions audited; humans oversee; the security AI's own access is least-privilege and monitored like any principal.

---

## 8. HA / DR (consolidates sync spec §7 + additions)

- **T1 intra-company HA:** physical ↔ VPS **streaming replication** with **failover automation** and **split-brain prevention** (Patroni quorum + witness node).
- **Backups (against malice — HA is NOT backup):** **immutable / WORM** object storage, **PITR** via WAL archiving, **air-gapped backup credentials** (breach of live ≠ breach of backups).
- **RPO/RTO targets:** define concrete numbers per tier (e.g. T1 RTO seconds / RPO ~0; malicious-recovery RPO = clean PITR point).
- **Restore drills:** scheduled and verified — an untested backup is not a backup.
- **DR runbook:** written, rehearsed procedures per failure/breach scenario.

---

## 9. Open items
- Wazuh vs Elastic Security final selection.
- SIEM retention + storage sizing.
- Concrete RPO/RTO numbers per tier + per company.
- Playbook catalog (enumerate low-risk auto actions vs high-impact gated actions).
- Behavioral-baseline model choice + cold-start handling for new employees.
- Security AI model hosting (which local model; isolation from general-purpose AI).
- Break-glass emergency access procedure (with heavy audit).
