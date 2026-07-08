<!-- Resolutions for the 11 attack/risk angles the 10-lens adversarial review did NOT cover. 2026-07-05. -->

# Uncovered Angles — Resolutions

The adversarial review (`2026-07-05-adversarial-weakness-review.md`) named 11 angles its 10 lenses didn't probe. Recommended handling for each below, tagged **v1** (act now) / **target** (design later) and with an owner to assign.

---

### U1. Cross-entity "one brain" legal risk — antitrust, client-confidentiality, conflict-of-interest, **divestiture** · *v1 design constraint* · owner: legal + platform
The child companies are **separate legal entities**. Pooling their data + one exec view raises competition, client-confidentiality (agency client work visible to resort execs), and — the sharpest — **divestiture**: cleanly extracting a sold company's data from shared WORM/embeddings/LoRA.
**Resolution:** inter-entity data-sharing agreements; the cross-company view is **aggregate/rollup-only, `group_executive`-gated, never raw client lists across entities**; conflict-of-interest walls via tenant isolation + Cerbos. **Divestiture readiness = extend the crypto-shred KEK hierarchy (U11/D2) to per-ENTITY key domains** so a sold company's data can be cryptographically severed everywhere at once. This is a day-one key-design constraint, not a later add.

### U2. Test / correctness-verification strategy · *v1* · owner: platform
For the self-declared highest-risk sync engine, no test approach is specified.
**Resolution:** program-level test strategy — TDD + interface **contract tests** (MCP/Gateway/module) from day one; **property-based convergence + partition/chaos** tests for the sync engine (when built); **eval suites** (D13); **restore-drill automation** (D15); an **e2e walking-skeleton** test. A test plan is a deliverable for each subsystem, not an afterthought.

### U3. Insider / privileged-operator abuse · *v1 (self) → target (team)* · owner: security
DBAs/platform-engineers/break-glass holders sit above RBAC/RLS/Cerbos.
**Resolution:** operator actions logged in the tamper-evident audit; **break-glass = M-of-N + heavy audit + time-boxed**; segregation of duties + four-eyes on production data access as the team grows. Solo v1: logged break-glass + self-audit discipline; document it so it's ready to enforce at first hire.

### U4. Financial / accounting integrity & fraud · *target (gated with payments)* · owner: platform + finance
The platform will touch invoices/folio/payments/payouts.
**Resolution:** when financial modules are built — **double-entry integrity, reconciliation with the accounting system, segregation of duties, fraud detection**; **no AI agent makes financial writes without a deterministic reconciliation + human confirmation** (extends D14). Gated behind the regulated-vertical target-state.

### U5. Physical security of edge boxes · *target (v1 is managed cloud)* · owner: security
A stolen/tampered on-prem box holds that tenant's **entire DB + local keys + models**.
**Resolution (target-state):** full-disk encryption at rest, tamper detection, physical access control, TPM-sealed keys; the box must not hold the master KEK (fetch/lease from central). N/A in managed-cloud v1; a hard gate before any edge deployment.

### U6. Provider lock-in / deprecation / ToS continuity · *v1* · owner: platform
Model deprecations + rate/price/ToS changes (Claude/Gemini/Meta) are business-level SPOFs.
**Resolution:** the Gateway abstraction already enables provider swaps; add **version-pinning + deprecation monitoring**, a **business-continuity fallback** (second provider or local) per capability, and Meta-enforcement tracking (ties D6). Never depend on a single provider for a critical capability without a tested fallback.

### U7. DR of the AI state itself · *v1* · owner: platform + WS8
DR covers Postgres; embeddings/KG/LoRA/registry recovery is unaddressed.
**Resolution:** derived stores (embeddings/KG) **recover by rebuild-from-source** (re-embed via the D9 indexer) with a documented rebuild-time budget; **non-rebuildable state (LoRA adapters, model registry) is backed up to WORM.** State the recovery method + time per store.

### U8. Cost-amplification / DoS via ingestion · *v1* · owner: platform
An adversary floods a monitored group / uploads heavy adversarial media to drive transcription/vision/LLM spend.
**Resolution:** **per-group + per-sender rate limits**, media **size/type caps**, the existing cost-cap, and an **anomaly alert on spend spikes**. Cheap and v1-relevant given the bot ingests open group content.

### U9. Adoption / human factors / change management · *v1 program risk* · owner: you / management
The entire "ship tools → discovery flywheel → fund the platform" thesis depends on adoption.
**Resolution:** name an **adoption owner**; onboarding + training; track **adoption KPIs**; actively manage consent fatigue and trust erosion after any outage/ban. A non-technical risk with technical consequences — needs an owner, not just good tools.

### U10. AI accountability/explainability + localization (Indonesian NLP) · *v1* · owner: WS8
Agent decisions must be auditable; and English eval suites won't measure **Indonesian/multi-language** summary/Q&A quality (Bali operations → heavily Indonesian content).
**Resolution:** decision traceability (D14 + WS9 traces) + human-in-loop for high-impact; **eval suites MUST include Indonesian + the local language mix**, or quality is unmeasured; bias checks on agent outputs. v1-relevant from the first pilot.

### U11. Key-management lifecycle at scale · *v1 design* · owner: security
The crypto-shred promise (D2) hides real operational complexity.
**Resolution:** design the **KEK hierarchy day-one** — per-subject keys, **per-entity key domains (U1)**, rotation policy, **managed KMS/HSM custody**, and the operational path for **erasure-by-key-destruction across the fleet + WORM**. v1 uses a managed KMS; the hierarchy shape is a day-one decision because it's unretrofittable (same class as D2).

---

## Summary

| Angle | Tag | Cheapest-now action |
|---|---|---|
| U1 one-brain legal/divestiture | v1 design | per-entity key domains + aggregate-only cross-company view |
| U2 test strategy | v1 | TDD + contract tests from day one |
| U3 insider/operator | v1→target | logged M-of-N break-glass |
| U4 financial integrity | target | reconciliation + no unattended AI financial writes |
| U5 physical edge security | target | gate before any edge box |
| U6 provider continuity | v1 | tested fallback per capability |
| U7 AI-state DR | v1 | rebuild-from-source + back up LoRA/registry |
| U8 ingestion DoS/cost | v1 | rate limits + media caps + spend alert |
| U9 adoption | v1 | name an adoption owner |
| U10 accountability + Indonesian evals | v1 | localized eval suites |
| U11 key lifecycle | v1 design | day-one KEK hierarchy on managed KMS |

**Day-one-unretrofittable (decide before first ingestion):** U1 per-entity key domains + U11 KEK hierarchy (both extend D2). Everything else is adopt-as-you-build.
