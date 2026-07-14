# Infrastructure & Delivery — WS10 / WS9

**Status: v1 slice built** — sized for the Solo-Viable trial (one personal VPS). The
target-state estate (K8s/k3s, GitOps, Sigstore/SBOM/SLSA, SPIFFE, GPU serving, OTel + SLOs)
is deliberately hiring-gated; see the specs.

**Specs:** `../docs/superpowers/specs/2026-07-04-ws10-platform-engineering-delivery.md` +
`ws9-observability.md`, `ws7-security-and-resilience.md`.

## What exists now

| Piece | Where |
|---|---|
| Full-stack VPS deploy — Postgres + Redis + WAHA + ai-gateway (Go) + Keycloak + Cerbos + platform-nest + platform-ui + whisper + knowledge + mcp-hub + bot + bot-media-worker + sync-central (idle) | `compose/docker-compose.vps.yml` + `runbooks/deploy-vps.md` |
| Env template (every var the compose reads, required + optional) | `compose/.env.example` |
| Keycloak starter realm (`gaiada`, client + roles) imported on first boot | `compose/keycloak/gaiada-realm.json` |
| Dockerfiles | in each component (`wa-chat-bot/`, `ai-gateway-go/`, `mcp-hub/`, `platform-nest/`, `platform-ui/`, `ai-agents/`, `sync-engine-go/`) |
| Nightly backup of ALL THREE DBs (gaiada + gaiada_platform + gaiada_knowledge) + rotation — crypto-shred-safe: DBs only, never key material | `scripts/backup.sh` |
| Uptime alerting (cron pings each `/health`, alerts to Telegram on failure) | `scripts/healthcheck.sh` |
| Local CI (typecheck + all test suites) | `scripts/test-all.sh` |
| GitHub Actions CI (Node matrix + dedicated platform-nest / gateway-go / sync-engine-go jobs) | `../.github/workflows/ci.yml` |

## Next steps (when they earn their keep)

OpenBao VPS (checklist 0.4) → flip Keycloak/platform to `oidc` once MFA is configured
(`../docs/runbooks/idp-keycloak.md`) → the target-state items above.
