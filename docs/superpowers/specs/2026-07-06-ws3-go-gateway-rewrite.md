# Workstream 3 · Sub-spec — Go Gateway Rewrite

**Date:** 2026-07-06
**Status:** Design approved (brainstorming stage — not yet built)
**Parent:** `2026-07-04-ws3-ai-gateway.md`; register item in `2026-07-05-phase-5-full-fidelity.md` (P5d: "Go gateway rewrite ... mTLS + peer allowlist, per-site/central egress split, OpenBao-issued short-TTL provider creds, token streaming")
**Scope for this pass:** Go rewrite of the existing Fastify `ai-gateway/` (same HTTP contract) + mTLS/peer allowlist (built now, permissive on today's single-VPS deployment) + per-site/central topology capability (config-driven, central-only actually deployed today) + model-assisted DLP classifier (local Ollama, synchronous, fail-closed) + token streaming (new `/complete/stream` endpoint).

**Explicitly deferred to follow-on sub-specs** (the register bundles several independent concerns; splitting per this repo's decomposition discipline):
- **OpenBao-issued short-TTL provider creds** — OpenBao itself isn't deployed anywhere yet (`grep` across `infra/compose/docker-compose.vps.yml` for openbao/vault returns nothing; CLAUDE.md already flags "OpenBao VPS (0.4)" as blocked on user/infra). Static env-var provider keys stay for this pass.
- **Media DLP classification** (image/video/doc-level, not just extracted text) — separate scope from the text classifier below.
- **DNS control + SIEM rule** for the egress floor — needs the multi-site network topology that doesn't exist yet.

---

## 0. Current state (what's being replaced)

`ai-gateway/` today is a Fastify/TS service, internal-only on the compose network (no published port, reachable only as `http://ai-gateway:3002` by other containers):
- `src/server.ts` — routes `GET /health`, `POST /complete`, `POST /media`, `POST /embed`; bearer-token auth, fail-closed if `GATEWAY_TOKEN` unset.
- `src/chain.ts` — provider chain with circuit breaker (opens after N consecutive failures, cooldown-gated recovery).
- `src/scrub.ts` — pattern/Luhn-based DLP scrubber (PAN, KTP/NIK, NPWP, bank acct, passport), verbatim mirror of the bot's scrubber. No model-assisted classification.
- `src/budget.ts` — in-memory global + per-tenant daily call caps, no persistence, no per-provider spend cap.
- `src/audit.ts` — append-only JSONL egress audit (metadata only).
- `src/egress.ts` — app-level default-deny outbound by monkey-patching `globalThis.fetch` with a host allowlist.
- No mTLS, no per-site/central split (single flat gateway), no streaming (`/complete` returns one JSON body), no OpenBao integration (static env-var keys).

The original spec (`2026-07-04-ws3-ai-gateway.md`) called for all of the above from the start; this sub-spec closes the gap for everything except OpenBao creds, media DLP, and DNS/SIEM (deferred above).

---

## 1. Why Go, concretely

- **Static binary** — trivial cross-compile and deploy to heterogeneous future sites, the same justification the sync-engine spec (`2026-07-04-ws1-sync-engine.md:89`) already gives for choosing Go.
- **Goroutines** for cheap concurrent provider-chain fan-out and circuit-breaker bookkeeping.
- **Native TLS/mTLS** in the stdlib (`crypto/tls`) — no OpenSSL/cgo dependency, fits the zero-trust floor requirement directly.

---

## 2. Module layout & framework

```
ai-gateway-go/
  cmd/gateway/main.go
  internal/
    server/       — routes, mTLS listener setup
    chain/        — provider chain + circuit breaker (port of chain.ts)
    providers/    — ollama, gemini, claude, whisper, echo clients
    dlp/          — pattern scrubber (port of scrub.ts) + Ollama classifier
    budget/       — daily cost cap (port of budget.ts)
    audit/        — JSONL egress audit (port of audit.ts)
    egress/       — outbound allowlist (port of egress.ts, enforced via http.Transport.DialContext rather than a monkey-patched fetch)
    topology/     — site/central mode config
  go.mod
```

**Framework**: Go stdlib `net/http` + `http.ServeMux` (1.22+ pattern-based routing; installed toolchain is 1.26.4). No third-party web framework — four routes plus one streaming variant don't justify Echo/Gin/Fiber, and stdlib keeps the "static binary, minimal deps" rationale intact. `crypto/tls` handles mTLS natively.

A standalone project (`ai-gateway-go/`), per the repo's non-monorepo convention — not a package inside the existing `ai-gateway/`.

---

## 3. mTLS + peer allowlist

- **Self-signed internal CA**: one-time-generated root CA (private key held only where the gateway runs; no external PKI/OpenBao dependency). A `gateway certs issue` subcommand mints client certs for each internal caller (`wa-chat-bot`, `ai-agents`, `automation`, `mcp-hub`) signed by that CA.
- **Peer allowlist**: server config maps each accepted client-cert CN/SAN to a known service identity. `tls.Config.ClientAuth = tls.RequireAndVerifyClientCert` plus an explicit CN check in `VerifyPeerCertificate` — a cert signed by the right CA but issued for the wrong service is still rejected.
- **Deployment mode toggle** — `GATEWAY_TLS_MODE=off|permissive|enforced`:
  - `off` — local dev.
  - `permissive` (today's actual deployment) — TLS available, client certs optional; existing bearer-token auth remains the real gate. Matches the current single-VPS internal-Docker-network reality where there's no network boundary to cross yet.
  - `enforced` — flips on once a second site or any public exposure exists; a config change, not a re-architecture.
- Bearer-token auth (`Authorization: Bearer <token>`) is kept as an **independent second factor at every mode** — mTLS proves "this is a known service," the token proves "this call is authorized." No single credential is sufficient, per the spec's zero-trust framing.

---

## 4. Per-site/central topology

- `GATEWAY_TOPOLOGY_MODE=central|site`:
  - **Central** (what's actually deployed today) — holds all provider keys, is the sole cloud-egress chokepoint, handles every request type.
  - **Site** (unused until a second physical site exists; built now so that day doesn't require a rewrite) — tries local-only providers first (Ollama, faster-whisper, already in the chain per the bot's local-first design); anything needing a cloud provider is **forwarded to the central Gateway over mTLS** rather than held locally, matching the original spec's "keys only at central" requirement (§4/§9b.1).
- Site-mode forwarding is implemented as one more entry in the provider chain (a `centralForward` provider, an HTTP+mTLS client to the central Gateway's URL) — reuses the existing failover/circuit-breaker machinery rather than a separate code path.

---

## 5. DLP classifier (local Ollama, synchronous, fail-closed)

- `internal/dlp/classifier.go` calls the same Ollama endpoint already configured for the `ollama` provider (`OLLAMA_URL`), running a small classification model, **after** the existing pattern/Luhn scrubber (unchanged, still the first gate) and **before** the request reaches any provider.
- **Fail-closed contract**: Ollama unreachable, timed out (default 2s, configurable), or returns a non-parseable/low-confidence result → request blocked with `503`, same status family as today's DLP block. No silent pass-through.
- This is a deliberate hard dependency: if Ollama is down, the Gateway stops serving classified requests. `/health` reports Ollama-classifier reachability as a distinct signal from provider-chain health, so this failure mode surfaces immediately rather than presenting as unexplained 503s.

---

## 6. Token streaming

- New `POST /complete/stream` (Server-Sent Events, `Content-Type: text/event-stream`) — additive, `POST /complete` unchanged. Streams provider tokens as they arrive via `http.Flusher` per chunk; providers without native streaming (e.g. `echo`) emit the full response as a single SSE event.
- DLP and budget checks run **before** streaming starts (on the request, not per-token) — no content reaches the client until it has cleared the same gates as `/complete`.

---

## 7. HTTP contract (preserved exactly)

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /health` | — | status + Ollama-classifier reachability | — |
| `POST /complete` | `{prompt}` | `{text}` | 400, 401, 429 (`"<scope> daily budget exceeded"`), 502, 503 |
| `POST /complete/stream` (new) | `{prompt}` | SSE token stream | same as above, pre-stream |
| `POST /media` | `{base64, mime}` | `{text}` | same |
| `POST /embed` | `{text}` | `{embedding}` | same |

Auth: `Authorization: Bearer <token>`, unchanged.

---

## 8. Migration & testing

- **Cutover**: stand up `ai-gateway-go/` alongside the existing Node gateway in compose on a different internal port, run both against the same `GATEWAY_TOKEN`/provider keys, verify contract parity with a shared test suite run against both, then flip `GATEWAY_URL` in dependent services (bot, ai-agents, automation) — same pattern as the platform Fastify→Nest cutover. Retire `ai-gateway/` (Node) once parity is confirmed.
- **Testing**: Go `testing` + `httptest` for route/contract parity (fixtures ported from the existing Node suite's request/response pairs); a chain/circuit-breaker unit suite mirroring `chain.ts`'s coverage; an mTLS integration test (self-signed test CA; valid/wrong-CN/no-cert client scenarios); a DLP fail-closed test (Ollama unreachable → 503, not a silent pass).

---

## 9. Open items (flagged, deferred)

- OpenBao-issued short-TTL provider creds — separate follow-on sub-spec once OpenBao is actually deployed.
- Media DLP classification (images/video, not just extracted text).
- DNS control + SIEM rule for the egress floor — needs the multi-site network topology this doesn't have yet.
- Cert rotation/expiry policy — a 1-year cert lifetime with manual rotation via the `certs issue` subcommand is enough for a single-operator v1; automated rotation deferred until there's an ops team to build it for.
