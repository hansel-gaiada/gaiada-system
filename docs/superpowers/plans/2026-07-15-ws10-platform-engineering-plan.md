# WS10 — Platform Engineering & Delivery: build plan

**Date:** 2026-07-15
**Status:** v1 slice BUILT (managed-first: compose deploy + CI + **supply-chain-secure release
pipeline** + GPU/model-serving runbook). Target-state (K8s/GitOps/SPIFFE/IDP) sequenced below —
hiring/hardware-gated per the roadmap's Solo-Viable-v1 decision.
**Parent spec:** `../specs/2026-07-04-ws10-platform-engineering-delivery.md`
**Governing decision (roadmap §"Solo-Viable v1"):** **buy/managed-first · build only the
differentiator.** WS10's v1 target is a *managed container host / small K8s*; full **K8s-at-central +
k3s-at-edge + GitOps + SPIFFE/SPIRE** is the **target-state, hiring-gated** — not a corner cut, a
sequenced decision. So "complete WS10" = ship the v1 differentiator (secure delivery) + a runbook +
this plan; do NOT prematurely build commodity cluster infra with no estate to run it on.

---

## 0. Where we are (verified 2026-07-15)

- **Deploy target (v1):** `infra/compose/docker-compose.vps.yml` — the whole ~14-service estate on one
  managed host, with per-component `Dockerfile`s, crypto-shred-safe backups, healthcheck cron, keycloak
  realm. Runbooks: `infra/runbooks/deploy-vps.md`, `db-topology-cutover.md`, `local-model-serving.md`.
- **CI:** `.github/workflows/ci.yml` — Node matrix (bot/hub/ai-agents) + a platform-nest job (PG+Cerbos
  +Redis) + Go build/vet/test (gateway, sync-engine). Green gate on every push.
- **Secrets:** no secrets in the repo (rotated; `.env.example` documents the surface); OpenBao is WS7.
- **Feature flags (partial):** per-tenant **module enable-flags** already gate verticals at the
  controller (WS1) — the seed of §1's feature-flag capability.

## 1. v1 slice — BUILT 2026-07-15

### Supply-chain-secure release pipeline (roadmap §"CI/CD ... supply-chain security baked in")
`.github/workflows/release.yml` — on a `v*` tag or manual dispatch, for each of the 7 component images:
build → push to GHCR → **SBOM (SPDX)** → **cosign KEYLESS sign** (Sigstore OIDC; no keys in the repo)
→ **SBOM attestation** → **SLSA build-provenance attestation** (pushed to the registry). Deploy is
decoupled from build (tag-gated). The runbook header documents the `cosign verify` /
`gh attestation verify` commands an operator runs before a deploy. This is the WS10 **differentiator**
(safe, verifiable delivery), the one part the roadmap says is *baked in, not deferred*.

### GPU / model-serving (spec §5)
`infra/runbooks/local-model-serving.md` (from the WS8 batch): Ollama-first serving + chain config, the
model-registry approval flow (provenance → verify → eval → approve → route), D13 failover, a GPU-sizing
table, and the LoRA/fine-tune flow. The acts (procure GPU, deploy vLLM) are hardware; the runbook is the plan.

## 2. Target-state build order (hiring/hardware-gated — sequence, don't pre-build)

1. **IaC** (§1) — Terraform for the managed host(s) + GHCR + DNS + backups, so infra is
   reviewed/versioned. Introduce when there's more than one host to manage by hand.
2. **k3s at edge + K8s at central** (§1) — translate the compose estate to manifests (Kustomize base +
   per-site overlays). Gate: a real second site / on-prem box exists (today it's one VPS — compose is
   the right tool). Validate manifests in CI with `kubeconform` when they land.
3. **GitOps** (§1) — Argo CD/Flux reconciling each site to its overlay; rollback = git revert.
   Depends on (2).
4. **Progressive rollout** (§2) — canary at one site → cohort → fleet; ties to the module enable-flags
   + the sync spec's hub-first migration rule. Depends on (2)/(3) + a multi-site estate.
5. **SPIFFE/SPIRE workload identity** (§4) — verifiable per-workload identity for mTLS/allowlist (WS7).
   The Go gateway's self-signed internal CA + mTLS peer-allowlist is the **precursor**; SPIFFE
   generalizes it across all workloads. Gate: K8s (2) — SPIRE is cluster-native.
6. **IDP / golden paths** (§3) — a Backstage-style catalog + scaffolds so a new WS1 module or WS8 agent
   is generated + deployed + observable via a paved road. Highest leverage once there are many services;
   today the module framework + this repo's conventions are the informal golden path.
7. **Ephemeral PR preview envs** (§2) — once (2)/(3) exist.

## 3. Decisions to lock (before target-state code)

1. **K8s distro/topology per site tier** (spec §6) — k3s at edge; central HA control plane (managed
   K8s vs self-run). Recommendation: **managed K8s at central**, k3s only where an on-prem box demands it.
2. **GitOps repo structure** — one repo with per-site overlays vs repo-per-site. Recommendation: **one
   repo, Kustomize overlays** (matches "one repo, reviewed" ethos).
3. **CI runners** — GitHub-hosted vs self-hosted (needed for GPU builds / private-network deploys).
4. **GPU procurement + capacity plan** (spec §6) — gated on a real local-model workload (WS8 §8.4);
   don't provision ahead of evidence (the sizing table in the serving runbook is the input).

## 4. Testing & verification
- Release pipeline: `release.yml` is valid workflow YAML (7-component matrix). A tag build proves
  images are pushed + signed + attested; verify with `cosign verify` / `gh attestation verify` (commands
  in the workflow header). Full run needs a registry + tag (not exercised locally).
- (target) k8s manifests: `kubeconform` in CI; a `kubectl apply --dry-run=server` gate.
- (target) GitOps: a canary-site reconcile + `git revert` rollback drill.

## 5. Open items / dependencies
- Everything in §2 is gated on **estate growth** (a 2nd site / on-prem box) or **hardware** (GPU) — per
  the locked Solo-Viable-v1 decision, building it now would be commodity infra with nothing to run it on.
- **SPIFFE/SPIRE** depends on K8s (WS10 §2) and pairs with WS7 (mTLS/allowlist) — coordinate there.
- **OpenBao secrets integration** (§1) is owned by WS7; WS10 consumes short-lived creds from it.
