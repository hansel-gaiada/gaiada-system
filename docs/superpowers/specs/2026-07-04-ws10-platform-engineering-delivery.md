# Workstream 10 — Platform Engineering & Delivery

**Date:** 2026-07-04
**Status:** Design stub (brainstorming stage — not being built yet)
**Parent:** `2026-07-04-gaiada-ai-platform-roadmap.md` (Workstream 10)
**Scope:** How code ships consistently and safely to a heterogeneous estate (local on-prem + VPS + cloud, multi-site) — as hard as the sync engine, currently a void.

---

## 1. Core capabilities

- **IaC** — Terraform/Pulumi for all infra (repeatable, reviewed, versioned).
- **Container orchestration** — **K8s at central/cloud, k3s at edge sites** (lightweight for on-prem boxes). Uniform deploy target across heterogeneous hardware.
- **GitOps** — declarative desired-state (Argo CD/Flux); each site reconciles to its assigned manifests; safe rollback = git revert.
- **CI/CD** — build → test → sign → deploy pipelines; **supply-chain security baked in** (Sigstore signing, SBOM, SLSA provenance — from the frontier-infra decisions).
- **Secrets** — Vault/OpenBao integration (WS7); short-lived creds; no secrets in repos.
- **Feature flags** — decouple deploy from release; per-tenant/site rollout (aligns with module enable-flags).

## 2. Environments & release

- dev → staging → prod; ephemeral preview envs for PRs where feasible.
- **Progressive/edge rollout:** canary at one site → cohort → fleet. Multi-site means staged rollout is mandatory.
- Schema/migration coordination with the **hub-first** rule (from sync spec §3.8).

## 3. Internal Developer Platform (IDP)

- Backstage-style **service catalog + golden paths** so a new vertical **module** (WS1) or agent (WS8) is scaffolded, deployed, and observable via a paved road — how top-tier teams scale to many services.

## 4. Workload identity & zero-trust delivery

- **SPIFFE/SPIRE** issues workload identities (from frontier decisions) → every deployed service gets a verifiable identity for mTLS/allowlist (WS7).

## 5. GPU / model-serving infra

- Provision + schedule **GPU capacity** for local frontier models + fine-tuning (WS8); model-serving stack (vLLM/Ollama/TGI) as a managed platform capability.

## 6. Open items
- K8s distro/topology per site tier; central HA control plane.
- GitOps repo structure (per-site overlays).
- Edge connectivity assumptions for reconciliation of desired-state.
- Build/runner infrastructure (local vs cloud CI).
- GPU procurement + capacity plan.
