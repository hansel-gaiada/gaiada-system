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

## The agent listener (AIP-00a-1, plan `docs/plans/2026-10-27-ai-plan.md` §6.1)

A **second listener** for registered agents (the Hermes agents on `helios`), in the OpenAI dialect:
`POST /v1/chat/completions` and `GET /v1/models`, nothing else. Neither route exists on the main
mux; the agent mux serves nothing of the main contract. Code: `internal/server/agent_*.go`,
`internal/providers/chat.go`, `openai_chat.go`.

| Env | Meaning |
|---|---|
| `GATEWAY_AGENT_LISTEN` | Address, e.g. `0.0.0.0:3012`. Empty = listener off. Plain HTTP by design (loopback publish + WireGuard). |
| `GATEWAY_AGENT_TOKENS` | `name:sha256hex[,...]`, hashes only (`printf %s "$T" \| sha256sum`). Empty or ANY malformed entry = every agent call 401. |
| `GATEWAY_AGENT_RESERVE_PCT` | Default 25. Agents get 429 once the global cap's remaining share is at or below it; `/complete` is never refused by it. |
| `GATEWAY_AGENT_DAILY_CALL_CAP` | Each agent's own daily cap. 0/unset = the per-tenant cap (and its console override). |
| `GATEWAY_AGENT_MAX_TOKENS` | Default 8192. Output ceiling per call: `max_tokens`/`max_completion_tokens` clamped to it, `max_tokens` set to it when the agent sends neither. |
| `GATEWAY_AGENT_MAX_CONCURRENCY` | Default 4. In-flight calls per agent (a stream until its last byte); the next is 429 `agent_concurrency_exceeded`. Released by a defer, so a disconnect or a panic frees the slot. |

Rules that must not drift:
- **Auth isolation.** The main mux's `authorized()` reads only `GATEWAY_TOKEN`; the agent mux reads
  only the hash set and refuses `GATEWAY_TOKEN` outright (an entry hashing to it is also dropped at
  boot). The agent's name is the identity in the audit row and the budget key `agent:<name>`.
- **Allow-list, not pass-through.** Top level: `model messages tools tool_choice temperature top_p
  max_tokens max_completion_tokens stop stream`; messages are rebuilt from `role content tool_calls
  tool_call_id`, parts from `{type:"text",text}`. Anything else is dropped (names logged, never
  values). A non-text part (image, audio, file) is 400. 2 MiB body (413), 400 messages.
- **The caller's `model` never routes.** `chain.RunFiltered` walks only `providers.ChatProvider`s
  (today only `openai`); `echo` can never serve (only-echo = 503). Skipped providers record nothing
  on their breakers. An upstream 400/413/422, an upstream 429, or a client disconnect is a
  `providers.CallerError`: no failover, no breaker charge, so one agent cannot open the breaker the
  ERP depends on. The 429 goes to the agent as 429 `upstream_rate_limited` with the upstream's
  `Retry-After` (well-formed values only), audit `blocked: upstream_rate_limit`. `/complete` and
  `/complete/stream` keep opening the breaker on their OWN 429s.
- **DLP.** `dlp.DLP` on every message text and every earlier tool call's `arguments` (JSON kept
  valid, see `scrubArguments`), then the classifier on the joined clean text. `tools` are not
  scrubbed. Output: `content`/`refusal` go through `dlp.StreamScrubber` on a stream and `dlp.DLP`
  otherwise (same answer both ways). Answer choices and messages/deltas are cut to an allow-list
  (`role content refusal tool_calls`), so reasoning and logprobs never pass; answer tool-call
  arguments are not scrubbed; unparseable choices are withheld (502), never relayed raw.
- **Streaming.** Upstream SSE re-emitted chunk by chunk with `model` restated, tool-call deltas
  untouched, then `data: [DONE]`. Failover only before the first byte; a later failure ends with a
  `data: {"error":...}` line and no `[DONE]`. The per-attempt timeout bounds the gap between chunks.
- **Audit.** One row per call, capability `chat`, with `agent`, `provider`, `model`, token counts
  when reported. Never text. New `blocked` values: `invalid_request`, `no_provider`, `client_closed`,
  `upstream_rate_limit`, `concurrency`.
- **Metrics (AIP-00a-4).** Same OTel meter as the egress series (`gateway_egress_requests_total`
  keeps its name and labels; a chat call still counts there under `capability="chat"`). New:
  `gateway_agent_requests_total{agent,outcome}` (outcome `ok` or the audit's `blocked` value; an
  unauthenticated call is `agent="unknown"`, `outcome="auth"`; a presented token is never a label),
  `gateway_agent_tokens_total{agent,kind}` (`kind` prompt|completion, provider-reported only), and the
  gauge `gateway_agent_budget_used_ratio{agent}` (calls today / the agent's effective daily cap, read
  at every scrape from `budget.AgentUsage`, so it is 0 after 00:00 UTC). The gauge covers every
  registered agent; label cardinality is the registered names plus `unknown`. Alert
  `GatewayAgentNearCap` (ratio >= 0.8 for 5m, ticket) in `infra/observability/prometheus/rules/alerts.yml`.

## This is the only place provider keys live

Program invariant: **no other service holds a provider credential**, and no caller asserts
identity to a provider. Everything about this service follows from that.

- **Provider chain with failover + circuit breaker.** `echo` is the keyless terminator — it is
  what makes the stack work with zero credentials, so don't remove it as "dead code".
- **Reasoning models on the `openai` provider (M6-P4n).** On OpenRouter a reasoning model's thinking
  tokens count against `OPENAI_MAX_TOKENS`, so it can spend the whole budget and return HTTP 200 with
  empty content. Empty content with `finish_reason=length` is therefore an **error** (the chain fails
  over; empty with `stop` stays a legitimate `""`). `OPENAI_REASONING_MAX_TOKENS` (default 0 = not
  sent) adds OpenRouter's `"reasoning": {"max_tokens": N}` body field to cap the thinking; never set
  it against OpenAI's own API, which does not take the field.
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
