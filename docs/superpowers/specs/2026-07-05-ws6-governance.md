# Workstream 6 — Governance (cross-cutting)

**Date:** 2026-07-05
**Status:** Design stub (brainstorming stage)
**Parent:** `2026-07-04-gaiada-ai-platform-roadmap.md` (Workstream 6)
**Nature:** Not a build target — the connective tissue that makes the other workstreams accountable. Establishes *who decides, who can access what, what is recorded, and how risk is owned.*

---

## 1. What Governance ties together

| Area | Home spec | Governance role |
|---|---|---|
| Identity & access | WS1 RBAC (IdP + Cerbos + RLS, assurance tiers) | Authoritative role/scope model; who may do what |
| Audit | WS7 (hash-chained WORM log) | Single authoritative, tamper-evident record; `activities` is a derived projection |
| Data governance | Compliance track + day-one foundations | Classification → drives DLP + RLS + retention + encryption; residency |
| Data-sync coordination | WS1 sync (deferred) | Consistency/ownership policy across sites |
| Risk register | Compliance §4b | Named, owned, accepted business risks (e.g. WA ToS) |

## 2. Governance controls (beyond the technical specs)
- **Segregation of duties + privileged-operator control (U3):** operators (DBA/platform/break-glass) sit above RBAC → their actions are audited in the WORM log; **break-glass = M-of-N + time-boxed + heavy audit**; four-eyes on production data access as the team grows.
- **Decision record:** significant architecture decisions captured (this spec set is the start); a lightweight ADR habit going forward.
- **Data classification taxonomy:** public / internal / confidential / regulated / special-category — the single label that drives encryption (day-one), egress DLP (D8), RLS scope, and retention.
- **Change management / adoption (U9):** a named adoption owner; onboarding, KPIs, consent-fatigue and post-incident trust management — the non-technical program risk.

## 3. v1 vs Target-State
- **v1 (solo):** governance is lightweight but *recorded* — logged break-glass, self-audit discipline, the risk register, and the data-classification taxonomy applied from day one (it's cheap and drives the unretrofittable encryption decisions).
- **Target-State:** formal segregation of duties, four-eyes, DPO/works-council processes, and a governance forum as headcount and regulated verticals arrive.

## 4. Open items
- ADR format + where decisions live.
- Data-classification taxonomy finalization (drives day-one encryption scope).
- Who owns adoption/change management.
- Governance forum cadence once a team exists.
