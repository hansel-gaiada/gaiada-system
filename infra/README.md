# Infrastructure & Delivery — WS10 / WS9

**Status: v1 slice built** — sized for the Solo-Viable trial (one personal VPS). The
target-state estate (K8s/k3s, GitOps, Sigstore/SBOM/SLSA, SPIFFE, GPU serving, OTel + SLOs)
is deliberately hiring-gated; see the specs.

**Specs:** `../docs/superpowers/specs/2026-07-04-ws10-platform-engineering-delivery.md` +
`ws9-observability.md`, `ws7-security-and-resilience.md`.

## What exists now

| Piece | Where |
|---|---|
| Full-stack VPS deploy (Postgres + WAHA + bot + ai-gateway + mcp-hub) | `compose/docker-compose.vps.yml` + `runbooks/deploy-vps.md` |
| Dockerfiles | in each component (`wa-chat-bot/`, `ai-gateway/`, `mcp-hub/`) |
| Nightly DB backup + rotation (crypto-shred-safe: DB only, never key material) | `scripts/backup.sh` |
| Local CI (typecheck + all test suites) | `scripts/test-all.sh` |
| GitHub Actions CI (per-component matrix) | `../.github/workflows/ci.yml` — **inert until `gaiada-system` is pushed as its own repo** (GitHub only runs root-level workflows; the current working folder's remote is unrelated) |

## Next steps (when they earn their keep)

Own GitHub repo for `gaiada-system` (activates CI) → uptime alerting (healthcheck cron →
Telegram message) → OpenBao VPS (checklist 0.4) → the target-state items above.
