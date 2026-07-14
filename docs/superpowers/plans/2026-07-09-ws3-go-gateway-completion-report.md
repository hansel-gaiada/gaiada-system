# WS3 Go Gateway Rewrite — Completion Report

**Status:** SHIPPED. Cutover completed 2026-07-14 — the Go gateway now runs as the `ai-gateway`
compose service on :3002 (config default port) and the Node `ai-gateway/` was retired and its
directory deleted. Callers reach it unchanged at `http://ai-gateway:3002`. (Originally
CODE-COMPLETE, Tasks 1–13, 2026-07-09.)
**Date:** 2026-07-09 (cutover 2026-07-14)
**Plan:** `docs/superpowers/plans/2026-07-06-ws3-go-gateway-rewrite-plan.md`

## Summary
Finished the Go gateway rewrite (`ai-gateway-go/`). Tasks 1–6 (config, providers, chain +
circuit breaker, DLP pattern scrubber, budget, audit) already existed and were verified green.
This session added Tasks 7–13:

- **Task 7 — egress allowlist transport** (`internal/egress/transport.go`): default-deny
  outbound enforced at `http.Transport.DialContext`.
- **Task 8 — HTTP server + entrypoint** (`internal/server/server.go`, `cmd/gateway/main.go`):
  byte-for-byte contract parity with `ai-gateway/src/server.ts` — `GET /health`,
  `POST /complete|/media|/embed`, bearer auth (constant-time), `{"error":...}` bodies at
  400/401/429/502/503. This is the piece that turns the prior "pile of packages" into a
  runnable binary.
- **Task 9 — self-signed internal CA + mTLS** (`internal/tls/ca.go`, `verify.go`): ECDSA CA,
  1-year client certs, CN peer allowlist; wired into `main.go` via `GATEWAY_TLS_MODE`.
- **Task 10 — site/central topology** (`internal/providers/central_forward.go`): a
  `CentralForwardProvider` that forwards to central in `site` mode, reusing the chain's
  failover/breaker machinery.
- **Task 11 — model-assisted DLP classifier** (`internal/dlp/classifier.go`): local Ollama,
  synchronous, fail-closed on unreachable/timeout/unparseable/UNSAFE. Opt-in.
- **Task 12 — token streaming** (`POST /complete/stream`, SSE): optional `StreamingProvider`
  interface with a single-event fallback so the wire contract is stable today.
- **Task 13 — Dockerfile + compose**: multi-stage `ai-gateway-go/Dockerfile`; an
  `ai-gateway-go` service added to `infra/compose/docker-compose.vps.yml` alongside `ai-gateway`.

## Verification
- `go build ./...`, `go vet ./...`, `go test ./...` — all green on go1.26.5 (installed this
  session via winget; the environment had no Go/git toolchain). New tests: TLS CA/peer-allowlist
  (3), DLP classifier fail-closed/timeout (4), server contract incl. stream (8).
- **End-to-end smoke run** of the built binary (echo providers, TLS off): `/health` ok;
  `/complete` returned the echo text with a PAN scrubbed to `[REDACTED-CARD]` (audit
  `redactions:1`); `/embed` returned 128 dims; wrong bearer → 401; `/complete/stream` returned
  `text/event-stream` with a `data:` event; JSONL audit rows written for each.
- `gofmt` canonical on all files authored/edited here. (Pre-existing Task 1–6 files are not
  gofmt-canonical from an earlier session; left untouched — out of scope.)

## Deliberate deviations from the plan snippets (deployment correctness)
1. **DLP classifier is opt-in** — added `DLP_CLASSIFIER_ENABLED` (default off) +
   `DLP_CLASSIFIER_MODEL` to `config.go`. The plan wired the classifier unconditionally in
   `main.go`; that would 503 every `/complete` wherever Ollama is unreachable, breaking the
   parity invariant. Gating matches the plan's stated "config-gated so today's single-VPS
   deployment runs unaffected."
2. **Permissive mTLS accepts cert-less clients** — in `permissive` mode Go still calls
   `VerifyPeerCertificate` with an empty chain when a client sends no cert; the raw `VerifyPeer`
   rejects empty chains. `main.go` wraps it to pass on empty (permissive) and enforce the CN
   allowlist only when a cert is presented. Enforced mode uses `VerifyPeer` directly.
3. **Compose sets `GATEWAY_TLS_MODE: off`** for the Go service (plan showed `permissive`).
   Today's callers speak plain HTTP; an HTTPS listener would break the documented cutover
   (`GATEWAY_URL → http://ai-gateway-go:3012`). Also added `host.docker.internal` to the egress
   allowlist (how this compose reaches Ollama).

## Not verified here (needs a Docker host)
- `docker build -t ai-gateway-go-test .` and `docker compose config` — no Docker in this
  environment. Deploy-only; run on a Docker host before cutover.

## Deferred per spec §9 (unchanged, not gaps in this task)
OpenBao-issued short-TTL provider creds; media DLP classification; native per-provider token
streaming; DNS control / SIEM rule; automated cert rotation.

## Cutover (manual, later)
Both gateways run side by side now. When ready: verify `go test ./...`, spot-check both against
the same keys, then point `GATEWAY_URL` in bot/hub/knowledge at `http://ai-gateway-go:3012`,
soak, then remove the Node `ai-gateway` service/source in a follow-up change.
