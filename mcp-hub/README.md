# Gaiada MCP Hub — WS2

The one governed access layer exposing company tools/data to AI clients (bot, agents, N8N)
over the **Model Context Protocol** (official TypeScript SDK, Streamable HTTP, stateless).

Spec: `../docs/superpowers/specs/2026-07-04-ws2-mcp-hub.md`

**Status: skeleton built** — the authorization spine is real and tested; company tools arrive
when the platform (WS1) exists to front (tools must call platform services, never a DB).

## What it enforces (tested)

- **On-behalf-of (OBO, §5):** the calling service authenticates with a bearer token
  (fail-closed); the END USER arrives as an envelope (`x-obo-provider`, `x-obo-external-id`)
  and the **hub** mints the principal — a client has no field with which to assert a role or
  assurance. No envelope → anonymous minimal principal.
- **Deny-by-default policy:** tool visibility is filtered per principal (nothing is advertised
  that can't be called), and every call is authorized again. `rollup.metrics` is verified-only
  and demonstrates the ceiling — chat-surface principals are refused with a step-up message.
- **Audit:** every call (allow or deny) appended to `data/tool-audit.jsonl` — principal, tool,
  decision, outcome; arguments are not recorded.

## Tools today

- `ping` (anonymous) · `whoami` (anonymous — echoes your minted principal)
- `llm.summarize` (low — identified callers only) — summarize text **via the AI Gateway**
- `media.extract` (low) — audio→transcript / image→description / pdf→text **via the AI Gateway**
- `rollup.metrics` (verified-only — unreachable until platform-minted principals exist)

AI-backed tools require `../ai-gateway` running (`GATEWAY_URL`/`GATEWAY_TOKEN` in `.env`) —
the hub holds no provider keys; the Gateway applies DLP, failover, cost cap, and its own audit.

## Connect from Claude Code (example client)

```bash
claude mcp add --transport http gaiada-hub http://localhost:3003/mcp \
  --header "Authorization: Bearer <HUB_SERVICE_TOKEN>" \
  --header "x-obo-provider: telegram" \
  --header "x-obo-external-id: <your-id>"
```

## Run

```bash
npm install
cp .env.example .env    # set HUB_SERVICE_TOKEN
npm test
npm start               # MCP endpoint: POST /mcp on :3003
```

## Target-state upgrades (spec)

Cerbos policy engine (incl. `PlanResources` predicates for set-returning tools, D16),
`ModuleContract.mcpTools` aggregation, per-site + central deployment, mTLS/zero-trust floor,
Gateway-wrapped AI tools (`ocr.extract`, `llm.summarize`, …).
