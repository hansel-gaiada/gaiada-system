# Gaiada AI Gateway — WS3

The **single controlled door** to external AI providers. All other components (wa-chat-bot,
mcp-hub, platform, automations) call this service; **only this service holds provider keys** (D8).

Spec: `../docs/superpowers/specs/2026-07-04-ws3-ai-gateway.md`

## What it enforces

- **Fail-closed auth** — bearer token required; no token configured → everything rejected.
- **Fail-closed DLP** — PAN/KTP/passport redaction runs before any egress; if scrubbing fails,
  the call is **blocked**, never passed raw. Media-derived text is scrubbed on the way back too.
- **Provider chain + failover** — `LLM_CHAIN=gemini,claude`: first healthy provider wins; errors
  open a circuit breaker (skip, then probe after cooldown). No keys → echo mode (plumbing works).
- **Cost cap** — hard daily call cap; over it → `429` and callers degrade to placeholders.
- **Egress audit** — every call appended to `data/egress-audit.jsonl` (capability, provider,
  redaction count, latency, block reason — **never payload content**).

## API (consumed by wa-chat-bot today)

- `POST /complete` `{prompt}` → `{text}` — Bearer auth
- `POST /media` `{base64, mime}` → `{text}` — audio→transcript, image→description, pdf→extraction
- `GET /health` → provider/breaker states + budget

## Run

```bash
npm install
cp .env.example .env   # set GATEWAY_TOKEN (+ GEMINI_API_KEY when you have one)
npm test
npm start              # listens on :3002
```

Point `wa-chat-bot/.env` `GATEWAY_URL=http://localhost:3002` (same `GATEWAY_TOKEN`) and stop
using the bot's embedded `npm run gateway` — this service supersedes it.

## Target-state upgrades (spec §2/§9)

Per-site local-model routing (Ollama), central egress with mTLS + FQDN allowlist, Vault-issued
short-TTL creds, per-tenant budgets, streaming, tamper-evident audit shipping.
