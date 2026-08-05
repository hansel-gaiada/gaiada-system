# hermes-gateway — Hermes as the wa-chat-bot brain (trial)

A tiny, zero-dependency HTTP shim that makes the **local Hermes agent** the AI brain of
`wa-chat-bot`, in place of the cloud Gemini gateway.

## Why this works with no bot changes

`wa-chat-bot` holds **no model key**. Every AI call goes through a Gateway HTTP contract
(see `../wa-chat-bot/src/llm.ts`):

| Endpoint | Request | Response |
|----------|---------|----------|
| `POST /complete` | `{ "prompt": "…" }` | `{ "text": "…" }` |
| `POST /media` | `{ "base64": "…", "mime": "image/png" }` | `{ "text": "…" }` |
| `GET /health` | — | `{ ok, brain, model, provider }` |
| `POST /complete/stream` | `{ "prompt": "…", "providerSession"?: "…" }` | SSE, grammar v2 (below) |

`/complete` and `/media` are unchanged by `/complete/stream` (ASST-14) — different code path
entirely (`spawn` + an incremental parser in `stream-parser.mjs`, vs the existing buffered
`execFile` + whole-buffer `extractChatReply`).

### `/complete/stream` (ASST-14)

Streams a `hermes chat` turn as Server-Sent Events, speaking the platform's grammar v2
(ASST-10/11): every `data:` line is exactly one line of JSON.

- Default (unnamed) events: `data: "<token text>"` — box decoration (`│`/`┃`/`╭`/`╰`, ANSI escapes,
  the "Query:"/"Session:" preamble/footer) is stripped incrementally as it streams, never leaked.
- `event: meta` — `data: {"provider":"hermes","model":"…","providerSession"?:"…"}`. Emitted once,
  immediately before `event: done`. **Deliberately terminal, not pre-first-token** (unlike
  `ai-gateway-go`'s own `meta`): the session id is only known once Hermes' footer has been parsed,
  so there is nothing truthful to announce earlier. See the comment above `handleCompleteStream`
  in `server.mjs`.
- `event: error` — `data: {"error":"…"}`. Emitted on a spawn failure, a nonzero Hermes exit, a
  timeout (see below), or a clean exit whose reply box never closed (truncated output). Never
  followed by `done`.
- `event: done` — `data: {}`. The only clean-completion terminal.

**Session continuity:** pass back a turn's `meta.providerSession` as `providerSession` on the next
call to continue the same Hermes session (`--resume <id>` under the hood) instead of starting a
fresh one.

**Approvals stay ON here too** — no `--yolo`. An unapproved tool hang is caught by
`HERMES_STREAM_TIMEOUT_MS` (defaults to `HERMES_TIMEOUT_MS`) and surfaced as a typed
`event: error`, never an open-ended hang.

Tests: `npm test` (Node's built-in test runner, no new dependencies) — `test/parser.test.mjs`
unit-tests the incremental parser against constructed transcript fixtures;
`test/server.test.mjs` drives the real server as a subprocess against
`test/fixtures/fake-hermes.mjs`, a fake Hermes binary (no live Hermes install was available on the
dev machine that wrote this — **live-Hermes streaming behaviour is UNVERIFIED**; verify against a
real `hermes` before relying on this in production).

Both go out with an optional `Authorization: Bearer <GATEWAY_TOKEN>`.

This shim implements that contract by shelling out to Hermes:

- `/complete` → `hermes -z <prompt>` (one-shot agent run; clean stdout is the reply)
- `/media` (images) → `hermes chat -q <prompt> --image <tempfile>` (native vision); the reply is
  parsed out of Hermes' boxed transcript. Non-image media is referenced by path.

Point the bot's `GATEWAY_URL` at this shim and its whole AI surface — Q&A, `/summarize`,
digests, LLM intent routing, media enrichment — runs on Hermes (local ollama +
Hermes' tools/skills/memory). The bot's own `.env` already ships with
`GATEWAY_URL=http://localhost:3002`, so with the shim on `:3002` and a matching
`GATEWAY_TOKEN`, no bot edits are needed.

## Run

```bash
cd hermes-gateway
GATEWAY_TOKEN=<same token the bot uses> npm start
```

Requires: Node 18+, `hermes` on PATH, ollama serving the configured model.

### Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `3002` | Must match the bot's `GATEWAY_URL`. |
| `GATEWAY_TOKEN` | *(empty)* | Bearer token; must match the bot's. Empty = auth off (dev only). |
| `HERMES_MODEL` | `gemma-mm` | ollama model Hermes uses. `ornith` is faster/text-only. |
| `HERMES_PROVIDER` | `ollama` | |
| `HERMES_TIMEOUT_MS` | `240000` | Per text request. |
| `HERMES_STREAM_TIMEOUT_MS` | `HERMES_TIMEOUT_MS` | `/complete/stream` only; also what turns a hung tool-approval prompt into a typed `event: error`. |
| `HERMES_MEDIA_TIMEOUT_MS` | `600000` | Vision is slow on the Arc iGPU (~4–5 min/image). |
| `HERMES_CWD` | `./work` | Isolated agent working dir (keeps tool use off the repo). |
| `HERMES_EXTRA_ARGS` | *(empty)* | **Approvals stay ON by default** — a headless run can't auto-execute tools. Set `--yolo` only if you knowingly want autonomous tool use (your risk). |

## Verified (2026-07-14, headless)

- `GET /health` → ok.
- `POST /complete` without token → **401** (fail-closed).
- `POST /complete` with token → real Hermes answers (e.g. "The capital of Indonesia is Jakarta.";
  one-line summarization).
- `POST /media` with a text image → gemma-mm transcribed "INVOICE 42 / Total: $1,250" correctly.

Not yet done (out of this trial's scope): driving real chat traffic via WAHA (QR scan) or the
Telegram fallback — wire either per `../wa-chat-bot/README.md`, then the messages flow through
this brain automatically.

## Notes / caveats

- **Speed:** `gemma-mm` (15 GB) doesn't fully fit the Arc iGPU (loads ~2%/98% CPU/GPU), so text
  replies take seconds and vision takes minutes. Switch `HERMES_MODEL=ornith` for snappy text.
- **Media parsing** keys off Hermes' `╭─ ⚕ Hermes ─╮` transcript box; if a Hermes version changes
  that framing, `/media` falls back to returning the raw (cleaned) transcript.
- This is a **trial brain** for local behavior observation. Production target: bigger machine +
  stronger models behind the same contract (drop-in — just repoint `GATEWAY_URL`).
