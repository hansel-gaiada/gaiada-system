# CLAUDE.md — ai-gateway-go

Scope: `ai-gateway-go/` — **THE AI gateway** (Go, `module gaiada/ai-gateway-go`, go 1.26.4). Runs
as the compose service named **`ai-gateway` on :3002**, so bot / hub / knowledge / media-worker
reach it unchanged at `http://ai-gateway:3002`. The former Node `ai-gateway/` was retired and its
directory deleted — references to it are history only.

Root `../CLAUDE.md` has program rules. Layout: `cmd/gateway` + `internal/{server,chain,providers,
config,adminconfig,routing,budget,dlp,egress,audit,metrics,telemetry,tls}`.

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

## Usage and cost on the text routes (AIP-02, plan `docs/plans/2026-10-27-ai-plan.md` §1.4/§4.1, ruling AIP-D11)

The `openai` provider reports the upstream's OWN token counts, and its cost when the upstream returns
one, on `POST /complete` and `POST /complete/stream`. Source label is always `provider`; the price
table that fills the gap is AIP-04 (not here). Never estimated, never zero-filled: when the upstream
reports nothing usable, nothing new is emitted and the platform keeps its labelled estimate.

- **`/complete/stream`.** `event: usage` keeps its position (terminal, before `session`/`done`, success
  only) and its two original fields, and gains two: `{"promptTokens":12,"completionTokens":34,
  "costUsd":0.00042,"source":"provider"}`. `costUsd` is omitted when the upstream sent no cost (a
  reported 0 stays). `source` is on every usage event now, Ollama's included. platform-nest `stream.ts`
  reads only the two counts, so it is unchanged.
- **`/complete`.** The answer gains an optional `usage` object with the same four fields. `{provider,text}`
  stay byte for byte; without usage the body is exactly the old one.
- **`OPENAI_NATIVE_STREAM` (default OFF; 1/true/yes/on enables, blank/0/false means off).** With it OFF,
  `/complete/stream` with `openai` is the single-chunk fallback through `Complete`, exactly as before
  AIP-02 (one non-stream upstream call, `meta`, ONE text frame, `done`); because that call parses usage,
  the same `usage` event follows the text, before `session`/`done`, on success only. The frames are
  byte-identical to the old fallback apart from that event (pinned in `server_usage_off_test.go`).
  The gate is `providers.NativeStreamGate`: a StreamingProvider that reports false is treated as
  non-streaming by the route. ON enables the native stream below. It is off because the native stream
  adds mid-stream failure modes (truncation, idle timeout, an error after the first byte with no
  failover) to every assistant reply; turn it on deliberately.
- **Native stream (only with `OPENAI_NATIVE_STREAM` on).** The `openai` provider streams the upstream:
  `stream_options.include_usage`, text deltas relayed as they arrive (outer whitespace trimmed like the
  non-stream path), the usage read from whichever chunk carries it (OpenRouter puts it on the last
  `finish_reason` chunk, others on a separate empty-`choices` chunk; last well-formed one wins). An
  unparseable chunk is skipped, an `error` chunk or `finish_reason=error` fails the attempt, empty
  content with `finish_reason=length` fails it (M6-P4n, same as `Complete`), a stream with neither
  `[DONE]` nor a `finish_reason` is a truncation error. The gap between chunks is bounded by
  `PROVIDER_TIMEOUT_MS` (a timeout in the audit taxonomy); a streamed answer has no overall deadline.
- **OpenRouter-only request field.** `"usage": {"include": true}` is sent only when the base URL host is
  exactly `openrouter.ai`, or when `OPENAI_USAGE_ACCOUNTING` is 1/true/yes/on (0/false/no/off forces it
  off; blank = automatic). Any other OpenAI-compatible upstream never receives it. Verified 2026-10-27
  against live OpenRouter: it returns `usage` (incl. `cost`, USD) with or without the field, so the
  field is belt and braces today. The standard `stream_options.include_usage` goes to every upstream.
- **Audit.** `llm` rows gain `promptTokens`, `completionTokens` and `costUsd` (all omitempty) when the
  serving provider reported usage; rows without usage are byte-identical to before. Never text.
- The agent route (`/v1/chat/completions`) is untouched by all of this.

## Routing by task and tier (AIP-06, plan `docs/plans/2026-10-27-ai-plan.md` §2.2, rulings AIP-D1 and AIP-D5)

`POST /complete` and `POST /complete/stream` accept two optional fields. Code: `internal/routing` (the pure
`Resolve`, the live table `Holder`, the validation and env parsing), `routedProvider`/`appliedTier` in
`internal/server/server.go`, `providers.ModelOverrider`.

- **`task`**: `chat` | `summarise` | `classify` | `agent_step` | `draft`. **`tier`**: `fast` | `standard` | `strong`.
  Any other value (wrong case, unknown, empty, wrong JSON type) is treated as ABSENT, never an error.
- **Precedence: `provider` > `tier` > the task's tier > plain chain order.** With `provider` sent the tier is not
  consulted at all (the validated `task` is still carried to the audit).
- **A tier is a (provider, model) pair** from the routing table. The route hands the provider name to
  `chain.RunWithHint` as the hint; inside the attempt only that provider, and only if it implements
  `providers.ModelOverrider`, runs on a `WithModel` copy (a shallow copy with the text model replaced; the shared
  provider is never mutated and `Name()` never changes, so the breaker stays one per provider). Implemented by
  `openai`, `ollama`, `gemini`, `claude` (each reads its model per call). `hermes`, `echo`, `central-forward`,
  `whisper` do not implement it, so a tier entry with a model for them is refused.
- **The agent listener never routes.** `/v1/chat/completions` is untouched; the caller's `model` still never picks anything.

| Env | Meaning |
|---|---|
| `GATEWAY_TIERS` | `tier=provider[:model]`, comma-separated, e.g. `fast=openai,standard=openai,strong=openai:z-ai/glm-5.3-flash`. The provider is split from the model at the FIRST `:` (model ids contain `:` and `/`). `echo` is refused. Empty = no tiers. |
| `GATEWAY_TASK_TIERS` | `task=tier`, comma-separated, e.g. `chat=standard,summarise=standard`. Empty = no task mapping. |

A malformed entry (unknown tier/task/provider, bad model characters, `echo`, a model on a non-overridable provider,
a duplicate) is logged at boot by its KEY and the reason, dropped, and never fails the boot.

**Admin keys** (`PUT /admin/config`, same validation as the env, `DELETE` reverts to the env table, live):
`tiers` = `{"fast":{"provider":"openai","model":""},...}` (keys only `fast|standard|strong`; `provider` a known
provider, not `echo`; `model` empty or `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$` and only for a provider that can
override) and `taskTiers` = `{"summarise":"fast",...}` (keys only the five tasks, values only the three tiers). An
empty object is valid and means "none" (it shadows the env). `GET /admin/config` reports the effective table under
`routing` and the two keys in `overriddenKeys`. The live table is an `atomic.Pointer` to an immutable copy, rebuilt
from env + the store under a lock after every write or clear.

**Applied tier.** After the run, `tier` is reported only if the provider that actually served is the tier's provider
(and its model, if the tier names one, was really used). For the stream the check is made against the provider
current at the first emitted token, the one `meta` names. Otherwise (tier provider skipped, breaker-open, failed
over) nothing about the tier is reported anywhere.

- **`/complete`** answer: `provider, text, model, tier, usage` (`model` also set whenever a tier was applied).
  **`/complete/stream`** `meta`: `provider, model, tier` (`model` names the override). **Audit**: `task` (the
  validated requested task, even if unused), `tier` (applied), and a routed success sets `model`; never text.
- **`GET /health`** gains `tiers`: sorted tier NAMES only (never a provider or model), omitted when none are
  configured. `providers.llm` (what platform-nest's `brains.ts` parses) is unchanged.

Rules that must not drift:
- **Absent means byte-identical.** With `task`/`tier` absent, invalid, or `provider` sent, the answer, the stream
  frames and the audit row are exactly what they were before AIP-06, with an empty table and with a full one.
- **`provider` > `tier` > the task's tier.** Never reorder this.
- **A tier is a hint, never a requirement.** It is a pure reordering through `RunWithHint`: the breaker and the
  availability gate apply to it like to any provider, and a failover provider uses its own default model (the
  override never leaks past the tier provider's attempt).
- **The tier's model is for one attempt only**, through a copy; never write to a shared provider.

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

OpenBao-issued provider creds, media DLP classification, native token streaming for providers other than `openai` (AIP-02 gave `openai` an opt-in one),
DNS control / SIEM rule, automated cert rotation. These are decisions, not oversights.

## Budget counters survive a restart (AIP-17a, plan §6.3 item 5)

`internal/budget/persist.go`: one state file, `data/budget-state.json` (the `gateway-data` volume), holds the UTC day
and the COUNTS of each budget under its own key: `chat` (global, per-company and `agent:<name>` counts of the
chat/agent budget) and `embed` (the separate `/embed` budget, registered by `server.NewServers` via
`server.WithBudgetState`). Never caps, console overrides or DR state. `GATEWAY_BUDGET_STATE_FILE` overrides the path;
set but empty = persistence off (in-memory, as before). Written atomically (temp file in the same dir + rename, 0600)
at most every 5 s and only when a count changed, and once more on SIGTERM/SIGINT (`main.go` flushes first, then
drains the main listener). Boot loads it only when its day is today (UTC); a missing, corrupt or stale file starts from
zero with one log line. A crash can lose up to 5 s of counts.
