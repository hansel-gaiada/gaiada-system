# CLAUDE.md — ai-gateway-go

Scope: `ai-gateway-go/` — **THE AI gateway** (Go, `module gaiada/ai-gateway-go`, go 1.26.4). Runs
as the compose service named **`ai-gateway` on :3002**, so bot / hub / knowledge / media-worker
reach it unchanged at `http://ai-gateway:3002`. The former Node `ai-gateway/` was retired and its
directory deleted — references to it are history only.

Root `../CLAUDE.md` has program rules. Layout: `cmd/gateway` + `internal/{server,chain,providers,
config,adminconfig,budget,dlp,egress,audit,metrics,telemetry,tls}`.

## Commands

```
go build ./... && go vet ./... && go test ./...     # the CI `gateway-go` job
go run ./cmd/gateway
```

**Windows note:** Smart App Control blocks locally-compiled Go executables — a freshly built
`.exe` dies with no useful error. `wsl.ps1` exists for that reason; build/run under WSL or turn
SAC off. Docker build has historically not been verifiable in the dev env; validate on a Docker
host before deploy.

## Contract — do not drift

Byte-for-byte HTTP parity with the retired Node gateway: `GET /health`, `POST /complete`,
`POST /media`, `POST /embed`, plus `POST /complete/stream` (SSE). Every caller in the estate is
coded to these shapes; a "cleanup" of a field name is a breaking change across five services.

## This is the only place provider keys live

Program invariant: **no other service holds a provider credential**, and no caller asserts
identity to a provider. Everything about this service follows from that.

- **Provider chain with failover + circuit breaker.** `echo` is the keyless terminator — it is
  what makes the stack work with zero credentials, so don't remove it as "dead code".
- **Fail-closed auth + DLP**, daily cost cap, egress audit, and a **DialContext-enforced egress
  allowlist** (enforced at dial time, not by URL inspection — a redirect can't slip past it).
- Optional local-Ollama DLP classifier, fail-closed, opt-in via `DLP_CLASSIFIER_ENABLED`.
- `DR_MODE` / `POST /admin/dr-mode` is the DR-burst budget override.

## Topology — a workaround you can still trip over

`site` vs `central` topology exists for multi-site. **`site` mode strips the `gemini`/`claude`/
`openai` providers** and forwards to central instead, so a box in `site` mode has *no cloud
brain* even with keys configured. If a deployment mysteriously has no cloud provider, check the
topology before the credentials. The `central-forward` provider must send a bearer — a version of
it shipped without one and 401'd on every call from the day it landed.

## TLS

Self-signed internal CA + mTLS with a peer allowlist. Compose runs with `GATEWAY_TLS_MODE: off`
(callers speak plain HTTP); enroll client certs before moving to permissive/enforced. The CA is
persisted and **shared** — `sync-engine-go`'s `cmd/synccert` issues node certs from this same CA.

## Known deferrals (per spec §9)

OpenBao-issued provider creds, media DLP classification, native per-provider token streaming,
DNS control / SIEM rule, automated cert rotation. These are decisions, not oversights.
